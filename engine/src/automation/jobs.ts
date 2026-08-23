// ============================================================================
// Scheduled jobs: nightly processing, deadline monitor, payment
// reconciliation, weekly summary. Each writes its own SYSTEM_JOB record and
// each is directly callable (the scheduler triggers them; the CLI can too).
// ============================================================================

import { readdir, rename, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
import { reconcileChangeHealthcareDelivery } from '../integration/optum_reconciliation.ts';

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
      const claimed = path.join(folder, `.processing-${randomUUID()}-${entry.name}`);
      try { await rename(full, claimed); } catch { continue; }
      const content = await readFile(claimed, 'utf8');
      const run = is835 ? ingest835Job : ingest837Job;
      const out = await run(pool, { tenantId, clientId, content, fileName: entry.name });
      ingestWarnings.push(...out.warnings);
      filesIngested.push(entry.name);
      await rename(claimed, path.join(folder, 'processed', `${asOf}-${randomUUID()}-${entry.name}`));
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
    // Skipped entirely when the client's plan does not include appeals, rather
    // than generating packets nobody is entitled to.
    const appealsEnabled = (await pool.query(
      `SELECT app.client_feature_enabled($1, $2, 'appeals') AS enabled`, [tenantId, clientId],
    )).rows[0]?.enabled === true;
    const gen = appealsEnabled
      ? await generateAppealPackets(pool, { tenantId, clientId, asOf, store })
      : { summary: { packetsCreated: 0, packetsRefreshed: 0, ready: 0, draft: 0 } };

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
        recouped: recon.recouped, clawedBack: recon.clawedBack,
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
  matched: number; won: number; partial: number; recovered: number;
  recouped: number; clawedBack: number; caseIds: UUID[];
}

/**
 * Recovery attribution.
 *
 * A recovered dollar is one the appeal actually produced. Three things make
 * that different from "cash arrived after we submitted":
 *
 *   1. Scope. A case is opened on a claim LINE. Payment landing on a sibling
 *      line of the same claim is not this case's recovery, so attribution is
 *      line-scoped whenever the case names a line.
 *   2. Reversals. A reverse-and-reissue pair re-pays the original amount plus
 *      the correction. Only the net movement is recovery; the gross reissue
 *      would bill the customer for money they already had.
 *   3. Recoupments. A PLB takeback referencing the claim after the appeal is
 *      cash going the other way and is netted out too.
 *
 * Every component is written to payment_event so an invoice line can be
 * defended line-by-line against the customer's own remittances.
 */
/**
 * Attribution scope.
 *
 * A case is opened on a claim LINE, so line-scoped cash is the accurate
 * measure and payment on a sibling line is not this case's recovery.
 *
 * The one deliberate widening: remittance detail the payer never resolved to
 * a service line (a header-only ERA row, or a line the matcher could not
 * place) carries a claim_id and nothing more. Dropping it would silently lose
 * real recoveries, which is worse than attributing it, so it is included and
 * reported separately as unallocated_paid — the part of an invoice line a
 * customer is most likely to question, and the part an operator can go and
 * resolve properly.
 */
const LINE_SCOPED = 'rl.claim_line_id = rc.claim_line_id';
const UNALLOCATED = 'rl.claim_line_id IS NULL AND rl.claim_id = rc.claim_id';
const ATTRIBUTION_SCOPE = `
  (rc.claim_line_id IS NOT NULL AND ((${LINE_SCOPED}) OR (${UNALLOCATED})))
  OR (rc.claim_line_id IS NULL AND rl.claim_id = rc.claim_id)`;

async function reconcilePaymentsInner(
  pool: PoolLike, tenantId: UUID, clientId: UUID | null,
): Promise<ReconInner> {
  // Cases with a submitted appeal, and the cash movement on the attributed
  // scope since it went out. 'won' cases are included so a later clawback is
  // caught rather than left standing as recovered revenue.
  const rows = await pool.query(
    `SELECT rc.case_id, rc.claim_id, rc.claim_line_id, rc.recovery_opportunity,
            rc.assigned_to_user_id, rc.status,
            cl.claim_number_internal,
            COALESCE((SELECT sum(pe.amount_recovered) FROM payment_event pe
                      WHERE pe.case_id = rc.case_id), 0) AS already_recovered,
            -- What THIS reconciler attributed, as opposed to what a person
            -- matched by hand. Only its own arithmetic may be reversed out;
            -- a verified manual match is not something a robot undoes.
            COALESCE((SELECT sum(pe.amount_recovered) FROM payment_event pe
                      WHERE pe.case_id = rc.case_id
                        AND pe.matched_automatically
                        AND pe.attribution_basis = 'incremental_net'), 0) AS auto_recovered,
            att.pre_appeal_paid,
            att.gross_post_appeal_paid,
            att.unallocated_paid,
            att.reversals,
            att.remittance_id,
            COALESCE(plb.recoupments, 0) AS recoupments
     FROM recovery_case rc
     JOIN claim cl ON cl.claim_id = rc.claim_id
     JOIN LATERAL (
       SELECT max(submitted_at) AS submitted_at FROM appeal_packet
       WHERE case_id = rc.case_id AND submitted_at IS NOT NULL AND deleted_at IS NULL
     ) ap ON ap.submitted_at IS NOT NULL
     JOIN LATERAL (
       SELECT
         COALESCE(sum(rl.paid_amount)
           FILTER (WHERE r.created_at <= ap.submitted_at), 0) AS pre_appeal_paid,
         COALESCE(sum(rl.paid_amount)
           FILTER (WHERE r.created_at > ap.submitted_at AND NOT rl.is_reversal), 0)
           AS gross_post_appeal_paid,
         COALESCE(sum(rl.paid_amount)
           FILTER (WHERE r.created_at > ap.submitted_at AND NOT rl.is_reversal
                     AND rc.claim_line_id IS NOT NULL AND (${UNALLOCATED})), 0)
           AS unallocated_paid,
         COALESCE(-sum(rl.paid_amount)
           FILTER (WHERE r.created_at > ap.submitted_at AND rl.is_reversal), 0) AS reversals,
         (SELECT rl2.remittance_id
          FROM remittance_line rl2
          JOIN remittance r2 ON r2.remittance_id = rl2.remittance_id
          WHERE rl2.tenant_id = rc.tenant_id AND r2.created_at > ap.submitted_at
            AND ((rc.claim_line_id IS NOT NULL
                  AND (rl2.claim_line_id = rc.claim_line_id
                       OR (rl2.claim_line_id IS NULL AND rl2.claim_id = rc.claim_id)))
                 OR (rc.claim_line_id IS NULL AND rl2.claim_id = rc.claim_id))
          ORDER BY r2.check_date DESC NULLS LAST, r2.created_at DESC
          LIMIT 1) AS remittance_id
       FROM remittance_line rl
       JOIN remittance r ON r.remittance_id = rl.remittance_id
       WHERE rl.tenant_id = rc.tenant_id AND (${ATTRIBUTION_SCOPE})
     ) att ON true
     LEFT JOIN LATERAL (
       -- PLB takebacks referencing this claim after the appeal went out.
       SELECT COALESCE(sum(pa.amount), 0) AS recoupments
       FROM remittance_provider_adjustment pa
       JOIN remittance r3 ON r3.remittance_id = pa.remittance_id
       WHERE pa.tenant_id = rc.tenant_id AND pa.claim_id = rc.claim_id
         AND r3.created_at > ap.submitted_at
         AND pa.category IN ('recoupment', 'forwarding_balance', 'refund', 'penalty')
     ) plb ON true
     WHERE rc.tenant_id = $1 AND ($2::uuid IS NULL OR rc.client_id = $2)
       AND rc.status IN ('submitted', 'pending_payer', 'won') AND rc.deleted_at IS NULL`,
    [tenantId, clientId]);

  const out: ReconInner = {
    matched: 0, won: 0, partial: 0, recovered: 0, recouped: 0, clawedBack: 0, caseIds: [],
  };

  for (const c of rows.rows) {
    const alreadyRecovered = Number(c.already_recovered);
    const gross = Number(c.gross_post_appeal_paid);
    const unallocated = Number(c.unallocated_paid);
    const reversals = Number(c.reversals);
    const recoupments = Number(c.recoupments);
    const netAttributable = r2(gross - reversals - recoupments);
    const delta = r2(netAttributable - alreadyRecovered);
    const scope = c.claim_line_id ? 'claim_line' : 'claim';

    if (Math.abs(delta) <= 0.005) continue;

    if (delta < 0) {
      // A negative delta is only a takeback when the payer actually took
      // something back. Without a reversal or a recoupment on the attributed
      // scope it is a bookkeeping difference — most often a manual match
      // recorded on a basis this arithmetic cannot see — and inventing a
      // clawback from it would erase a person's verified work.
      if (reversals <= 0.005 && recoupments <= 0.005) continue;
      await recordClawback(pool, tenantId, c, scope, Number(c.auto_recovered), delta, out);
      continue;
    }

    const gap = r2(Number(c.recovery_opportunity) - alreadyRecovered);
    const gapClosed = delta >= gap - 0.005;

    await pool.query(
      `INSERT INTO payment_event
         (tenant_id, case_id, claim_line_id, remittance_id, claim_id, amount_recovered,
          payment_date, matched_automatically, attribution_basis, attribution_scope,
          pre_appeal_paid, gross_post_appeal_paid, unallocated_paid, reversals_netted,
          recoupments_netted, notes)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, true, 'incremental_net', $7,
               $8, $9, $10, $11, $12, $13)`,
      [tenantId, c.case_id, c.claim_line_id, c.remittance_id, c.claim_id, delta, scope,
       Number(c.pre_appeal_paid), gross, unallocated, reversals, recoupments,
       attributionNote(gross, unallocated, reversals, recoupments, alreadyRecovered,
         gapClosed, gap, delta)]);

    if (gapClosed && c.status !== 'won') {
      await pool.query(
        `UPDATE recovery_case SET status = 'won' WHERE case_id = $1`, [c.case_id]);
      out.won += 1;
    } else if (!gapClosed) {
      out.partial += 1;
    }
    await pool.query(
      `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_system, notes)
       VALUES ($1, $2, 'payment_received', true, $3)`,
      [tenantId, c.case_id,
       `${gapClosed ? 'Recovery gap closed' : 'Partial recovery logged'}: ${usd(delta)} `
       + `attributed after appeal${gapClosed ? ' — case marked won' : `; ${usd(r2(gap - delta))} still open`}`
       + attributionSuffix(reversals, recoupments, unallocated)]);

    if (c.assigned_to_user_id) {
      await createNotification(pool, {
        tenantId, userId: c.assigned_to_user_id, type: 'payment_received',
        title: `${usd(delta)} recovered on case ${c.claim_number_internal}`
          + (gapClosed ? ' — case won' : ' (partial)'),
        caseId: c.case_id,
      });
    }

    out.matched += 1;
    out.recovered = r2(out.recovered + delta);
    out.caseIds.push(c.case_id);
  }
  return out;
}

/**
 * The payer took cash back after we credited a recovery. Only what was
 * actually credited can be reversed out; a takeback on a case that never had
 * recovery attributed to it is recorded and escalated but never becomes a
 * negative recovery line.
 */
async function recordClawback(
  pool: PoolLike, tenantId: UUID, c: any, scope: string,
  autoRecovered: number, delta: number, out: ReconInner,
): Promise<void> {
  const reversible = r2(Math.max(0, Math.min(autoRecovered, Math.abs(delta))));
  const detail =
    `${usd(Math.abs(delta))} taken back after appeal on case ${c.claim_number_internal}`
    + attributionSuffix(Number(c.reversals), Number(c.recoupments), Number(c.unallocated_paid));

  if (reversible > 0.005) {
    await pool.query(
      `INSERT INTO payment_event
         (tenant_id, case_id, claim_line_id, remittance_id, claim_id, amount_recovered,
          payment_date, matched_automatically, attribution_basis, attribution_scope,
          pre_appeal_paid, gross_post_appeal_paid, unallocated_paid, reversals_netted,
          recoupments_netted, notes)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, true, 'incremental_net', $7,
               $8, $9, $10, $11, $12, $13)`,
      [tenantId, c.case_id, c.claim_line_id, c.remittance_id, c.claim_id, -reversible, scope,
       Number(c.pre_appeal_paid), Number(c.gross_post_appeal_paid),
       Number(c.unallocated_paid), Number(c.reversals), Number(c.recoupments),
       `Recovery reversed: ${detail}. Previously attributed ${usd(autoRecovered)}.`]);
    out.clawedBack = r2(out.clawedBack + reversible);
    out.recovered = r2(out.recovered - reversible);

    // Recovery that was taken back is not a win. Reopening is the honest
    // state: the money is gone and somebody has to work it again.
    if (c.status === 'won'
        && r2(Number(c.already_recovered) - reversible) < Number(c.recovery_opportunity)) {
      await pool.query(
        `UPDATE recovery_case SET status = 'pending_payer' WHERE case_id = $1`, [c.case_id]);
    }
  }

  await pool.query(
    `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_system, notes)
     VALUES ($1, $2, 'payment_recouped', true, $3)`,
    [tenantId, c.case_id,
     reversible > 0.005
       ? `${detail}. ${usd(reversible)} of previously attributed recovery reversed out.`
       : `${detail}. No automatically attributed recovery to reverse — `
         + 'verify the cash against the payer remittance.']);

  if (c.assigned_to_user_id) {
    await createNotification(pool, {
      tenantId, userId: c.assigned_to_user_id, type: 'system_alert', severity: 'urgent',
      title: `Payer took back ${usd(Math.abs(delta))} on case ${c.claim_number_internal}`,
      caseId: c.case_id,
    });
  }

  out.recouped += 1;
  out.caseIds.push(c.case_id);
}

function attributionSuffix(
  reversals: number, recoupments: number, unallocated: number,
): string {
  const parts: string[] = [];
  if (Math.abs(reversals) > 0.005) parts.push(`${usd(reversals)} reversed`);
  if (Math.abs(recoupments) > 0.005) parts.push(`${usd(recoupments)} recouped`);
  const netted = parts.length ? ` (net of ${parts.join(' and ')})` : '';
  return netted + (Math.abs(unallocated) > 0.005
    ? ` — includes ${usd(unallocated)} of payment the payer did not resolve to a service line`
    : '');
}

function attributionNote(
  gross: number, unallocated: number, reversals: number, recoupments: number,
  alreadyRecovered: number, gapClosed: boolean, gap: number, delta: number,
): string {
  return `${gapClosed ? 'Post-appeal payment closed the recovery gap' : `Partial recovery: ${usd(delta)} of ${usd(gap)} gap`}. `
    + `Attribution: ${usd(gross)} paid after submission`
    + `${Math.abs(unallocated) > 0.005 ? ` (${usd(unallocated)} not resolved to a service line)` : ''}`
    + `${Math.abs(reversals) > 0.005 ? `, less ${usd(reversals)} reversed` : ''}`
    + `${Math.abs(recoupments) > 0.005 ? `, less ${usd(recoupments)} recouped` : ''}`
    + `${alreadyRecovered > 0.005 ? `, less ${usd(alreadyRecovered)} already attributed` : ''}.`;
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
      return { ...out, recordsProcessed: out.matched + out.recouped };
    });
}

// ============================================================================
// OUTBOUND-DELIVERY RECONCILIATION — the acknowledgement-reconciliation
// half of the change_healthcare certification gate in
// docs/PRODUCTION_READINESS.md gate 4. Re-checks every 'sent'
// change_healthcare delivery that hasn't been reconciled yet against
// Optum's claim-status API (see optum_reconciliation.ts for the
// classification logic and its X12-code-table source).
//
// Bounded to a fixed batch per run (rather than "all of them") so one
// job invocation can't run unboundedly long against however many
// deliveries have accumulated — a delivery not yet picked up this run
// gets picked up on the next scheduled tick.
// ============================================================================

export interface DeliveryReconciliationResult {
  checked: number; accepted: number; rejected: number;
  unclassified: number; skipped: number; recordsProcessed: number;
}

export async function runDeliveryReconciliation(
  pool: PoolLike, params: { tenantId: UUID; clientId?: UUID; batchSize?: number },
): Promise<DeliveryReconciliationResult & { jobId: UUID }> {
  const batchSize = params.batchSize ?? 50;
  return jobShell(pool, params.tenantId, params.clientId ?? null, 'reconcile_deliveries', async () => {
    const rows = await pool.query(
      `SELECT delivery_id FROM outbound_delivery
       WHERE tenant_id = $1 AND connector = 'change_healthcare' AND status = 'sent'
         AND ($2::uuid IS NULL OR client_id = $2)
         AND NOT (detail ? 'reconciliation')
       ORDER BY created_at
       LIMIT $3`,
      [params.tenantId, params.clientId ?? null, batchSize]);

    const out: DeliveryReconciliationResult = {
      checked: 0, accepted: 0, rejected: 0, unclassified: 0, skipped: 0, recordsProcessed: 0,
    };
    for (const r of rows.rows) {
      const result = await reconcileChangeHealthcareDelivery(
        pool, { tenantId: params.tenantId, deliveryId: r.delivery_id },
      );
      if (!result) continue;
      out.checked += 1;
      out[result.outcome] += 1;
    }
    out.recordsProcessed = out.checked;
    return out;
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
