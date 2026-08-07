// ============================================================================
// SCHEDULER — runs the platform without manual triggers.
//
// schedulerTick(pool, deps, now) computes, per active client in the client's
// own timezone:
//   * nightly processing   at client.nightly_run_time
//   * deadline monitor     at 07:00
//   * digest emails        at 07:15 (daily users; weekly users on Monday)
//   * delivery reconciliation at 09:00 (change_healthcare 'sent' deliveries
//     not yet reconciled — see optum_reconciliation.ts)
//   * weekly summary       Monday at 08:00
// and drains the email outbox every tick. Each job is guarded against
// double-running by an atomic PostgreSQL scheduler lease shared by replicas.
//
// startScheduler(pool) loops the tick once a minute. The tick is directly
// callable with an injected clock, which is how the tests drive it.
// ============================================================================

import type { UUID } from '../types.ts';
import type { PoolLike } from '../service.ts';
import type { DocumentStore } from '../appeals/storage.ts';
import { FileSystemDocumentStore } from '../appeals/storage.ts';
import {
  runDeadlineMonitor, runDeliveryReconciliation, runNightlyProcessing, runWeeklySummary,
} from './jobs.ts';
import { deliverOutbox, sendDigests, LogTransport, type EmailTransport } from './notify.ts';
import { sweepAllFolders } from '../integration/sweep.ts';
import { TenantContextPool } from '../db/tenant_pool.ts';

interface LocalClock {
  date: string;      // YYYY-MM-DD in the client's timezone
  time: string;      // HH:MM
  weekday: string;   // Mon, Tue, …
}

export function localClock(now: Date, timeZone: string): LocalClock {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone, hour12: false, weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', hour12: false, weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  }
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
    weekday: parts.weekday,
  };
}

/** Atomically claim a scheduled task across every scheduler replica. */
async function runClaimed(
  pool: PoolLike, tenantId: UUID, clientId: UUID | null, jobType: string, withinHours: number,
  work: () => Promise<void>,
): Promise<boolean> {
  const key = `${tenantId}:${clientId ?? 'tenant'}:${jobType}`;
  const rows = await pool.query(
    `INSERT INTO scheduler_lease (lease_key, tenant_id, client_id, job_type, claimed_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (lease_key) DO UPDATE SET claimed_at = now()
       WHERE scheduler_lease.claimed_at <= now() - make_interval(hours => $5)
     RETURNING lease_key`,
    [key, tenantId, clientId, jobType, withinHours]);
  if (rows.rows.length === 0) return false;
  try {
    await work();
    return true;
  } catch (err) {
    // Failed tasks may retry on the next tick; completed leases retain the
    // intended daily/weekly suppression window.
    await pool.query(`DELETE FROM scheduler_lease WHERE lease_key = $1`, [key]).catch(() => {});
    throw err;
  }
}

export interface SchedulerDeps {
  store?: DocumentStore;
  transport?: EmailTransport;
  log?: (msg: string) => void;
}

export interface TickReport {
  nightly: UUID[];       // client ids run
  monitors: UUID[];
  weeklies: UUID[];
  deliveryReconciliations: UUID[];
  digestsSent: number;
  emailsDelivered: number;
  filesIngested: number;
}

export async function schedulerTick(
  pool: PoolLike, deps: SchedulerDeps = {}, now = new Date(),
): Promise<TickReport> {
  const scoped = pool instanceof TenantContextPool ? pool : new TenantContextPool(pool);
  pool = scoped;
  const store = deps.store ?? new FileSystemDocumentStore();
  const transport = deps.transport ?? new LogTransport();
  const log = deps.log ?? (() => {});
  const report: TickReport = {
    nightly: [], monitors: [], weeklies: [], deliveryReconciliations: [],
    digestsSent: 0, emailsDelivered: 0, filesIngested: 0,
  };

  // SFTP-drop sweep: every tick, so files land within a minute of arriving
  const sweeps = await sweepAllFolders(pool, log);
  report.filesIngested = sweeps.reduce(
    (n, s) => n + s.files.filter((f) => f.status === 'ingested').length, 0);

  const clients = await pool.query(
    `SELECT client_id, tenant_id, client_name, timezone, nightly_run_time
     FROM app.list_active_clients()`);

  for (const c of clients.rows) {
    const clock = localClock(now, c.timezone);
    const nightlyAt = String(c.nightly_run_time).slice(0, 5);

    try {
      await scoped.runAsTenant(c.tenant_id, async () => {
        // nightly processing (payment reconciliation runs inside it, per spec)
        if (clock.time >= nightlyAt) {
        const ran = await runClaimed(pool, c.tenant_id, c.client_id, 'nightly_processing', 20, async () => {
          log(`nightly: ${c.client_name}`);
          await runNightlyProcessing(pool, {
            tenantId: c.tenant_id, clientId: c.client_id, store, asOf: clock.date,
          });
        });
        if (ran) report.nightly.push(c.client_id);
        }

      // 7am deadline monitor
        if (clock.time >= '07:00') {
        const ran = await runClaimed(pool, c.tenant_id, c.client_id, 'deadline_monitor', 20, async () => {
          log(`deadline monitor: ${c.client_name}`);
          await runDeadlineMonitor(pool, {
            tenantId: c.tenant_id, clientId: c.client_id, asOf: clock.date,
          });
        });
        if (ran) report.monitors.push(c.client_id);
        }

      // 9am clearinghouse delivery reconciliation — after nightly/deadline
      // so anything submitted overnight has had time to reach the payer
        if (clock.time >= '09:00') {
        const ran = await runClaimed(pool, c.tenant_id, c.client_id, 'reconcile_deliveries', 20, async () => {
          log(`delivery reconciliation: ${c.client_name}`);
          await runDeliveryReconciliation(pool, { tenantId: c.tenant_id, clientId: c.client_id });
        });
        if (ran) report.deliveryReconciliations.push(c.client_id);
        }

      // Monday weekly summary
        if (clock.weekday === 'Mon' && clock.time >= '08:00') {
        const ran = await runClaimed(pool, c.tenant_id, c.client_id, 'weekly_summary', 24 * 6, async () => {
          log(`weekly summary: ${c.client_name}`);
          await runWeeklySummary(pool, {
            tenantId: c.tenant_id, clientId: c.client_id, asOf: clock.date,
          });
        });
        if (ran) report.weeklies.push(c.client_id);
        }

      // digest emails at 07:15 local — once per tenant per day
        if (clock.time >= '07:15') {
        await runClaimed(pool, c.tenant_id, null, 'send_alerts', 20, async () => {
          const job = await pool.query(
            `INSERT INTO system_job (tenant_id, job_type, status, started_at)
             VALUES ($1, 'send_alerts', 'running', now()) RETURNING job_id`,
            [c.tenant_id]);
          const digests = await sendDigests(pool, c.tenant_id, { isMonday: clock.weekday === 'Mon' });
          await pool.query(
            `UPDATE system_job SET status = 'completed', completed_at = now(),
                    records_processed = $1, log_output = $2 WHERE job_id = $3`,
            [digests, JSON.stringify({ digestsSent: digests }), job.rows[0].job_id]);
          report.digestsSent += digests;
        });
        }
      });
    } catch (err) {
      // one client's failure never blocks the others; the failed system_job
      // row carries the error detail
      log(`ERROR ${c.client_name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  for (const tenantId of new Set<UUID>(clients.rows.map((c) => c.tenant_id))) {
    const delivered = await scoped.runAsTenant(tenantId, () => deliverOutbox(pool, transport));
    report.emailsDelivered += delivered.sent;
  }
  return report;
}

export function startScheduler(
  pool: PoolLike, deps: SchedulerDeps = {}, intervalMs = 60_000,
): { stop: () => void } {
  const log = deps.log ?? ((m: string) => console.log(`[scheduler] ${m}`));
  let running = false;
  log(`started (interval ${intervalMs / 1000}s)`);
  const timer = setInterval(async () => {
    if (running) return;   // never overlap ticks
    running = true;
    try {
      await schedulerTick(pool, { ...deps, log }, new Date());
    } catch (err) {
      log(`tick failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
