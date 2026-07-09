// ============================================================================
// Scheduled jobs: nightly processing, deadline monitor, payment
// reconciliation, weekly summary. Each writes its own SYSTEM_JOB record and
// each is directly callable (the scheduler triggers them; the CLI can too).
// ============================================================================

import { readdir, rename, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { UUID } from '../types.ts';
import type { PoolLike } from '../service.ts';
import type { Queryable } from '../db/snapshot.ts';
import { runDetectionJob } from '../service.ts';
import { generateAppealPackets } from '../appeals/service.ts';
import { ingest835Job, ingest837Job } from '../ingest/service.ts';
import type { DocumentStore } from '../appeals/storage.ts';
import { FileSystemDocumentStore } from '../appeals/storage.ts';
import { createNotification, notifyRoles } from './notify.ts';
import { processTrigger } from './rules.ts';

const OPEN_STATUSES = ['open', 'in_progress', 'submitted', 'pending_payer'];
const r2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${r2(n).toFixed(2)}`;

async function jobShell<T extends object>(
  pool: PoolLike, tenantId: UUID, clientId: UUID | null, jobType: string,
  work: () => Promise<T & { recordsProcessed?: number }>,
): Promise<T & { jobId: UUID }> {
  const job = await pool.query(
    `INSERT INTO system_job (tenant_id, client_id, job_type, status, started_at)
     VALUES ($1, $2, $3::job_type, 'running', now()) RETURNING job_id`,
    [tenantId, clientId, jobType],
  );
  const jobId: UUID = job.rows[0].job_id;
  try {
    const out = await work();
    await pool.query(
      `UPDATE system_job SET status = 'completed', completed_at = now(),
              records_processed = $1, log_output = $2 WHERE job_id = $3`,
      [out.recordsProcessed ?? 0, JSON.stringify(out), jobId]);
    return { ...out, jobId };
  } catch (err) {
    await pool.query(
      `UPDATE system_job SET status = 'failed', completed_at = now(), errors_count = 1,
              log_output = $1 WHERE job_id = $2`,
      [String(err instanceof Error ? err.stack ?? err.message : err), jobId],
    ).catch(() => {});
    throw err;
  }
}

async function adminsAndAssignee(
  db: Queryable, tenantId: UUID, assignedTo: UUID | null,
): Promise<UUID[]> {
  const admins = await db.query(
    `SELECT user_id FROM app_user
     WHERE tenant_id = $1 AND role IN ('client_admin', 'tenant_admin')
       AND status = 'active' AND deleted_at IS NULL`, [tenantId]);
  const ids = new Set<UUID>(admins.rows.map((r) => r.user_id));
  if (assignedTo) ids.add(assignedTo);
  return [...ids];
}

// ============================================================================
// NIGHTLY PROCESSING — the 12-step sequence
// ============================================================================

export interface NightlyResult {
  filesIngested: string[];
  ingestWarnings: string[];
  detection: { matched: number; unmatched: number; casesCreated: number;
               casesUpdated: number; recoveryIdentified: number };
  appeals: { packetsCreated: number; packetsRefreshed: number; ready: number; draft: number };
  reconciliation: { matched: number; won: number; partial: number; recovered: number };
  deadlineAlerts: number;
  ruleFirings: number;
  snapshotWritten: boolean;
  recordsProcessed: number;
}

export async function runNightlyProcessing(
  pool: PoolLike,
  params: { tenantId: UUID; clientId: UUID; store?: DocumentStore; asOf?: string },
): Promise<NightlyResult & { jobId: UUID }> {
  const { tenantId, clientId } = params;
  const store = params.store ?? new FileSystemDocumentStore();
  const asOf = params.asOf ?? new Date().toISOString().slice(0, 10);

  return jobShell(pool, tenantId, clientId, 'nightly_processing', async () => {
    // -- steps 1-2: pick up new EDI files from the client ingest folder ------
    const clientRow = await pool.query(
      `SELECT ingest_folder FROM client WHERE client_id = $1 AND tenant_id = $2`,
      [clientId, tenantId]);
    const folder = clientRow.rows[0]?.ingest_folder
      ?? path.join(process.cwd(), 'var', 'ingest', clientId);
    await mkdir(path.join(folder, 'processed'), { recursive: true });

    const filesIngested: string[] = [];
    const ingestWarnings: string[] = [];
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const is835 = /\.(835|era)$/i.test(entry.name);
      const is837 = /\.837$/i.test(entry.name);
      if (!is835 && !is837) continue;
      const full = path.join(folder, entry.name);
      const content = await readFile(full, 'utf8');
      const run = is835 ? ingest835Job : ingest837Job;
      const out = await run(pool, { tenantId, clientId, content, fileName: entry.name });
      ingestWarnings.push(...out.warnings);
      filesIngested.push(entry.name);
      await rename(full, path.join(folder, 'processed', `${asOf}-${entry.name}`));
    }

    // -- steps 3-7: match, price, detect, create/update cases ----------------
    const det = await runDetectionJob(pool, { tenantId, clientId, asOf });

    // rule engine: new cases fire case_created
    let ruleFirings = 0;
    for (const caseId of det.persisted?.createdCaseIds ?? []) {
      ruleFirings += (await processTrigger(pool, {
        trigger: 'case_created', tenantId, caseId,
      })).length;
    }

    // -- step 8: appeal letters for new cases with sufficient data -----------
    const gen = await generateAppealPackets(pool, { tenantId, clientId, asOf, store });

    // -- reconciliation (spec: runs after each nightly ingest) ---------------
    const recon = await reconcilePaymentsInner(pool, tenantId, clientId);
    for (const caseId of recon.caseIds) {
      ruleFirings += (await processTrigger(pool, {
        trigger: 'payment_received', tenantId, caseId,
      })).length;
    }

    // -- steps 9-10: deadline check + critical alerts (2-day tier only here;
    //    the 7am deadline monitor owns the full tiered sweep) ----------------
    const critical = await pool.query(
      `SELECT rc.case_id, rc.deadline_date, rc.recovery_opportunity,
              rc.assigned_to_user_id, cl.claim_number_internal
       FROM recovery_case rc JOIN claim cl ON cl.claim_id = rc.claim_id
       WHERE rc.tenant_id = $1 AND rc.client_id = $2 AND rc.deleted_at IS NULL
         AND rc.status = ANY($3)
         AND rc.deadline_date BETWEEN $4::date AND $4::date + 2`,
      [tenantId, clientId, OPEN_STATUSES, asOf]);
    let deadlineAlerts = 0;
    for (const c of critical.rows) {
      for (const userId of await adminsAndAssignee(pool, tenantId, c.assigned_to_user_id)) {
        const r = await createNotification(pool, {
          tenantId, userId, type: 'deadline_approaching', severity: 'urgent',
          title: `Appeal deadline ${String(c.deadline_date).slice(0, 10)} — case ${c.claim_number_internal}`,
          body: `${usd(Number(c.recovery_opportunity))} at risk. Deadline within 2 days.`,
          caseId: c.case_id,
          dedupeKey: `nightly-deadline:${c.case_id}:${asOf}:u:${userId}`,
        });
        if (r.notificationId) deadlineAlerts += 1;
      }
    }

    // -- step 11: dashboard snapshot ------------------------------------------
    await pool.query(
      `INSERT INTO dashboard_snapshot
         (tenant_id, client_id, snapshot_date, open_cases, open_amount, due_within_7,
          recovered_total, recovered_30d, cases_won_total)
       SELECT $1, $2, $3::date,
         count(*) FILTER (WHERE rc.status = ANY($4)),
         COALESCE(sum(rc.recovery_opportunity) FILTER (WHERE rc.status = ANY($4)), 0),
         count(*) FILTER (WHERE rc.status = ANY($4)
                          AND rc.deadline_date BETWEEN $3::date AND $3::date + 7),
         COALESCE((SELECT sum(pe.amount_recovered) FROM payment_event pe
                   WHERE pe.tenant_id = $1 AND pe.case_id IN
                     (SELECT case_id FROM recovery_case WHERE client_id = $2)), 0),
         COALESCE((SELECT sum(pe.amount_recovered) FROM payment_event pe
                   WHERE pe.tenant_id = $1 AND pe.payment_date >= $3::date - 30
                     AND pe.case_id IN
                     (SELECT case_id FROM recovery_case WHERE client_id = $2)), 0),
         count(*) FILTER (WHERE rc.status = 'won')
       FROM recovery_case rc
       WHERE rc.tenant_id = $1 AND rc.client_id = $2 AND rc.deleted_at IS NULL
       ON CONFLICT (client_id, snapshot_date) DO UPDATE SET
         open_cases = EXCLUDED.open_cases, open_amount = EXCLUDED.open_amount,
         due_within_7 = EXCLUDED.due_within_7, recovered_total = EXCLUDED.recovered_total,
         recovered_30d = EXCLUDED.recovered_30d, cases_won_total = EXCLUDED.cases_won_total`,
      [tenantId, clientId, asOf, OPEN_STATUSES]);

    // job-summary notification to admins
    const s = det.result.summary;
    await notifyRoles(pool, tenantId, ['client_admin', 'tenant_admin'], {
      type: 'job_summary',
      title: `Nightly processing complete: ${filesIngested.length} file(s), `
        + `${s.casesCreated} new case(s), ${usd(s.totalRecoveryOpportunity)} identified`,
      body: `Matched ${s.matched} remit lines (${s.unmatched} unmatched) · `
        + `${gen.summary.ready} packets ready · ${recon.won} case(s) won via reconciliation`,
      dedupeKey: `nightly-summary:${clientId}:${asOf}`,
    });

    return {
      filesIngested, ingestWarnings,
      detection: {
        matched: s.matched, unmatched: s.unmatched, casesCreated: s.casesCreated,
        casesUpdated: s.casesUpdated, recoveryIdentified: s.totalRecoveryOpportunity,
      },
      appeals: {
        packetsCreated: gen.summary.packetsCreated, packetsRefreshed: gen.summary.packetsRefreshed,
        ready: gen.summary.ready, draft: gen.summary.draft,
      },
      reconciliation: {
        matched: recon.matched, won: recon.won, partial: recon.partial, recovered: recon.recovered,
      },
      deadlineAlerts, ruleFirings, snapshotWritten: true,
      recordsProcessed: s.remitLinesProcessed,
    };
  });
}

// ============================================================================
// DEADLINE MONITOR — tiered morning sweep
// ============================================================================

export interface MonitorResult {
  tier14: number; tier7: number; tier2: number; expired: number;
  escalated: number; alertsSent: number; ruleFirings: number;
  recordsProcessed: number;
}

export async function runDeadlineMonitor(
  pool: PoolLike, params: { tenantId: UUID; clientId?: UUID; asOf?: string },
): Promise<MonitorResult & { jobId: UUID }> {
  const { tenantId } = params;
  const asOf = params.asOf ?? new Date().toISOString().slice(0, 10);

  return jobShell(pool, tenantId, params.clientId ?? null, 'deadline_monitor', async () => {
    const rows = await pool.query(
      `SELECT rc.case_id, rc.deadline_date, rc.recovery_opportunity, rc.priority_level,
              rc.assigned_to_user_id, rc.expired, cl.claim_number_internal,
              (rc.deadline_date - $3::date) AS days_left
       FROM recovery_case rc JOIN claim cl ON cl.claim_id = rc.claim_id
       WHERE rc.tenant_id = $1 AND ($2::uuid IS NULL OR rc.client_id = $2)
         AND rc.deleted_at IS NULL AND rc.status = ANY($4)
         AND rc.deadline_date IS NOT NULL AND rc.deadline_date <= $3::date + 14`,
      [tenantId, params.clientId ?? null, asOf, OPEN_STATUSES]);

    const out: MonitorResult = {
      tier14: 0, tier7: 0, tier2: 0, expired: 0, escalated: 0, alertsSent: 0,
      ruleFirings: 0, recordsProcessed: rows.rows.length,
    };

    for (const c of rows.rows) {
      const days = Number(c.days_left);
      const amount = usd(Number(c.recovery_opportunity));
      const recipients = await adminsAndAssignee(pool, tenantId, c.assigned_to_user_id);

      const alert = async (severity: 'warning' | 'urgent', tier: string, extra: string) => {
        for (const userId of recipients) {
          const r = await createNotification(pool, {
            tenantId, userId, type: 'deadline_approaching', severity,
            title: `${extra} — case ${c.claim_number_internal} (${amount})`,
            body: `Appeal deadline ${String(c.deadline_date).slice(0, 10)}, ${days >= 0 ? days + ' day(s) left' : Math.abs(days) + ' day(s) past'}.`,
            caseId: c.case_id,
            dedupeKey: `deadline:${c.case_id}:${tier}:${asOf}:u:${userId}`,
          });
          if (r.notificationId) out.alertsSent += 1;
        }
      };

      if (days < 0) {
        // deadline passed: mark expired, notify admins
        if (!c.expired) {
          await pool.query(
            `UPDATE recovery_case SET expired = true WHERE case_id = $1`, [c.case_id]);
          await pool.query(
            `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_system, notes)
             VALUES ($1, $2, 'status_changed', true, 'Deadline passed — case marked expired by deadline monitor')`,
            [tenantId, c.case_id]);
        }
        await alert('urgent', 'expired', 'DEADLINE PASSED');
        out.expired += 1;
      } else if (days <= 2) {
        // immediate alert + same-day flag
        await pool.query(
          `UPDATE recovery_case SET same_day_action = true WHERE case_id = $1`, [c.case_id]);
        await alert('urgent', 't2', 'SAME-DAY ACTION REQUIRED');
        out.tier2 += 1;
      } else if (days <= 7) {
        // urgent alert + escalate priority to critical
        if (c.priority_level !== 'critical') {
          await pool.query(
            `UPDATE recovery_case SET priority_level = 'critical' WHERE case_id = $1`, [c.case_id]);
          await pool.query(
            `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_system, notes)
             VALUES ($1, $2, 'status_changed', true, 'Priority escalated to critical — deadline within 7 days')`,
            [tenantId, c.case_id]);
          out.escalated += 1;
        }
        await alert('urgent', 't7', 'URGENT: deadline within 7 days');
        out.tier7 += 1;
      } else {
        await alert('warning', 't14', 'Deadline within 14 days');
        out.tier14 += 1;
      }

      out.ruleFirings += (await processTrigger(pool, {
        trigger: 'deadline_approaching', tenantId, caseId: c.case_id, daysToDeadline: days,
      })).length;
    }
    return out;
  });
}

// ============================================================================
// PAYMENT RECONCILIATION
// ============================================================================

interface ReconInner {
  matched: number; won: number; partial: number; recovered: number; caseIds: UUID[];
}

async function reconcilePaymentsInner(
  pool: PoolLike, tenantId: UUID, clientId: UUID | null,
): Promise<ReconInner> {
  // submitted appeals whose claim received remit rows AFTER the appeal went
  // out, with payment not yet recorded on the case
  const rows = await pool.query(
    `SELECT rc.case_id, rc.claim_id, rc.recovery_opportunity, rc.assigned_to_user_id,
            cl.claim_number_internal,
            COALESCE((SELECT sum(pe.amount_recovered) FROM payment_event pe
                      WHERE pe.case_id = rc.case_id), 0) AS already_recovered,
            (SELECT COALESCE(sum(rl.paid_amount), 0)
             FROM remittance_line rl JOIN remittance r ON r.remittance_id = rl.remittance_id
             WHERE rl.claim_id = rc.claim_id AND r.created_at > ap.submitted_at) AS post_appeal_paid,
            (SELECT max(rl.remittance_id::text)
             FROM remittance_line rl JOIN remittance r ON r.remittance_id = rl.remittance_id
             WHERE rl.claim_id = rc.claim_id AND r.created_at > ap.submitted_at) AS remittance_id
     FROM recovery_case rc
     JOIN claim cl ON cl.claim_id = rc.claim_id
     JOIN LATERAL (
       SELECT max(submitted_at) AS submitted_at FROM appeal_packet
       WHERE case_id = rc.case_id AND submitted_at IS NOT NULL AND deleted_at IS NULL
     ) ap ON ap.submitted_at IS NOT NULL
     WHERE rc.tenant_id = $1 AND ($2::uuid IS NULL OR rc.client_id = $2)
       AND rc.status IN ('submitted', 'pending_payer') AND rc.deleted_at IS NULL`,
    [tenantId, clientId]);

  const out: ReconInner = { matched: 0, won: 0, partial: 0, recovered: 0, caseIds: [] };
  for (const c of rows.rows) {
    const newPaid = r2(Number(c.post_appeal_paid) - Number(c.already_recovered));
    if (newPaid <= 0.005) continue;

    const gap = r2(Number(c.recovery_opportunity) - Number(c.already_recovered));
    const gapClosed = newPaid >= gap - 0.005;

    await pool.query(
      `INSERT INTO payment_event
         (tenant_id, case_id, remittance_id, claim_id, amount_recovered, payment_date,
          matched_automatically, notes)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, true, $6)`,
      [tenantId, c.case_id, c.remittance_id, c.claim_id, newPaid,
       gapClosed ? 'Post-appeal payment closed the recovery gap'
                 : `Partial recovery: ${usd(newPaid)} of ${usd(gap)} gap`]);

    if (gapClosed) {
      await pool.query(
        `UPDATE recovery_case SET status = 'won' WHERE case_id = $1`, [c.case_id]);
      out.won += 1;
    } else {
      out.partial += 1;
    }
    await pool.query(
      `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_system, notes)
       VALUES ($1, $2, 'payment_received', true, $3)`,
      [tenantId, c.case_id,
       `${gapClosed ? 'Recovery gap closed' : 'Partial recovery logged'}: ${usd(newPaid)} `
       + `received after appeal${gapClosed ? ' — case marked won' : `; ${usd(r2(gap - newPaid))} still open`}`]);

    if (c.assigned_to_user_id) {
      await createNotification(pool, {
        tenantId, userId: c.assigned_to_user_id, type: 'payment_received',
        title: `${usd(newPaid)} recovered on case ${c.claim_number_internal}`
          + (gapClosed ? ' — case won' : ' (partial)'),
        caseId: c.case_id,
      });
    }

    out.matched += 1;
    out.recovered = r2(out.recovered + newPaid);
    out.caseIds.push(c.case_id);
  }
  return out;
}

export async function runPaymentReconciliation(
  pool: PoolLike, params: { tenantId: UUID; clientId?: UUID },
): Promise<ReconInner & { jobId: UUID; recordsProcessed: number }> {
  return jobShell(pool, params.tenantId, params.clientId ?? null, 'reconcile_payments',
    async () => {
      const out = await reconcilePaymentsInner(pool, params.tenantId, params.clientId ?? null);
      for (const caseId of out.caseIds) {
        await processTrigger(pool, { trigger: 'payment_received', tenantId: params.tenantId, caseId });
      }
      return { ...out, recordsProcessed: out.matched };
    });
}

// ============================================================================
// WEEKLY SUMMARY — Monday morning per-client email to admins
// ============================================================================

export interface WeeklySummaryResult {
  newCases: number; newCasesAmount: number;
  submitted: number; recovered: number; recoveredAmount: number;
  expiringThisWeek: number; emailsQueued: number;
  recordsProcessed: number;
}

export async function runWeeklySummary(
  pool: PoolLike, params: { tenantId: UUID; clientId: UUID; asOf?: string },
): Promise<WeeklySummaryResult & { jobId: UUID }> {
  const { tenantId, clientId } = params;
  const asOf = params.asOf ?? new Date().toISOString().slice(0, 10);

  return jobShell(pool, tenantId, clientId, 'weekly_summary', async () => {
    const stats = await pool.query(
      `SELECT
         (SELECT count(*) FROM recovery_case rc
          WHERE rc.client_id = $1 AND rc.created_at >= $2::date - 7 AND rc.deleted_at IS NULL) AS new_cases,
         (SELECT COALESCE(sum(recovery_opportunity), 0) FROM recovery_case rc
          WHERE rc.client_id = $1 AND rc.created_at >= $2::date - 7 AND rc.deleted_at IS NULL) AS new_amount,
         (SELECT count(*) FROM appeal_packet ap JOIN recovery_case rc ON rc.case_id = ap.case_id
          WHERE rc.client_id = $1 AND ap.submitted_at >= $2::date - 7) AS submitted,
         (SELECT count(*) FROM payment_event pe JOIN recovery_case rc ON rc.case_id = pe.case_id
          WHERE rc.client_id = $1 AND pe.payment_date >= $2::date - 7) AS payments,
         (SELECT COALESCE(sum(pe.amount_recovered), 0) FROM payment_event pe
          JOIN recovery_case rc ON rc.case_id = pe.case_id
          WHERE rc.client_id = $1 AND pe.payment_date >= $2::date - 7) AS recovered_amount,
         (SELECT count(*) FROM recovery_case rc
          WHERE rc.client_id = $1 AND rc.status = ANY($3) AND rc.deleted_at IS NULL
            AND rc.deadline_date BETWEEN $2::date AND $2::date + 7) AS expiring`,
      [clientId, asOf, OPEN_STATUSES]);
    const s = stats.rows[0];

    const topItems = await pool.query(
      `SELECT cl.claim_number_internal, py.payer_name, rc.priority_level,
              rc.recovery_opportunity, rc.deadline_date,
              COALESCE(rc.denial_category, rc.case_type::text) AS category
       FROM recovery_case rc
       JOIN claim cl ON cl.claim_id = rc.claim_id
       JOIN payer py ON py.payer_id = cl.payer_id
       WHERE rc.client_id = $1 AND rc.status = ANY($2) AND rc.deleted_at IS NULL
       ORDER BY rc.priority_level, rc.deadline_date ASC NULLS LAST,
                rc.recovery_opportunity DESC
       LIMIT 5`,
      [clientId, OPEN_STATUSES]);

    const clientName = (await pool.query(
      `SELECT client_name FROM client WHERE client_id = $1`, [clientId])).rows[0]?.client_name;

    const body = [
      `Weekly recovery summary — ${clientName} (week ending ${asOf})`,
      '',
      `New recovery cases opened:   ${s.new_cases} (${usd(Number(s.new_amount))})`,
      `Appeals submitted:           ${s.submitted}`,
      `Payments recovered:          ${s.payments} (${usd(Number(s.recovered_amount))})`,
      `Cases expiring this week:    ${s.expiring}`,
      '',
      'Top action items:',
      ...topItems.rows.map((t, idx) =>
        `  ${idx + 1}. [${t.priority_level}] ${t.claim_number_internal} — ${t.payer_name} · `
        + `${String(t.category).replaceAll('_', ' ')} · ${usd(Number(t.recovery_opportunity))}`
        + (t.deadline_date ? ` · deadline ${String(t.deadline_date).slice(0, 10)}` : '')),
    ].join('\n');

    // email to client admins + tenant admins, plus in-app summary
    const admins = await pool.query(
      `SELECT user_id, email FROM app_user
       WHERE tenant_id = $1 AND role IN ('client_admin', 'tenant_admin')
         AND status = 'active' AND deleted_at IS NULL`, [tenantId]);
    let emailsQueued = 0;
    for (const a of admins.rows) {
      await pool.query(
        `INSERT INTO email_outbox (tenant_id, user_id, to_email, subject, body_text, kind)
         VALUES ($1, $2, $3, $4, $5, 'weekly_report')`,
        [tenantId, a.user_id, a.email,
         `[RCM] Weekly summary — ${clientName}: ${s.new_cases} new cases, ${usd(Number(s.recovered_amount))} recovered`,
         body]);
      emailsQueued += 1;
      await createNotification(pool, {
        tenantId, userId: a.user_id, type: 'job_summary',
        title: `Weekly summary ready — ${clientName}`,
        body: `${s.new_cases} new cases · ${s.submitted} appeals out · ${usd(Number(s.recovered_amount))} recovered`,
        dedupeKey: `weekly:${clientId}:${asOf}:u:${a.user_id}`,
      });
    }

    return {
      newCases: Number(s.new_cases), newCasesAmount: r2(Number(s.new_amount)),
      submitted: Number(s.submitted), recovered: Number(s.payments),
      recoveredAmount: r2(Number(s.recovered_amount)),
      expiringThisWeek: Number(s.expiring), emailsQueued,
      recordsProcessed: Number(s.new_cases),
    };
  });
}
