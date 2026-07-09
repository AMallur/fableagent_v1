// ============================================================================
// Audit & compliance reporting: full audit trail, PHI access log, system job
// log with rerun, and the data-export approval workflow.
// ============================================================================

import type { UUID } from '../types.ts';
import type { PoolLike } from '../service.ts';
import type { Queryable } from '../db/snapshot.ts';
import type { Session } from './auth.ts';
import type { Scope } from './queries.ts';
import { requireAnyAdmin, requireTenantAdmin } from './admin_api.ts';
import { runDetectionJob } from '../service.ts';
import { generateAppealPackets } from '../appeals/service.ts';
import {
  runDeadlineMonitor, runNightlyProcessing, runPaymentReconciliation, runWeeklySummary,
} from '../automation/jobs.ts';

const when = (v: unknown): string | null =>
  v == null ? null : (v instanceof Date ? v.toISOString() : String(v));
const err = (message: string, status: number) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------------------
// full audit trail
// ---------------------------------------------------------------------------

export interface AuditFilter {
  userId?: string; entityType?: string; action?: string;
  from?: string; to?: string; limit?: number;
}

export async function auditTrail(db: Queryable, sess: Session, s: Scope, f: AuditFilter) {
  requireAnyAdmin(sess);
  const params: unknown[] = [s.tenantId];
  const where = ['a.tenant_id = $1'];
  if (f.userId) { params.push(f.userId); where.push(`a.user_id = $${params.length}`); }
  if (f.entityType) { params.push(f.entityType); where.push(`a.entity_type = $${params.length}`); }
  if (f.action) { params.push(f.action); where.push(`a.action = $${params.length}`); }
  if (f.from) { params.push(f.from); where.push(`a.created_at >= $${params.length}::date`); }
  if (f.to) { params.push(f.to); where.push(`a.created_at < ($${params.length}::date + 1)`); }
  params.push(Math.min(f.limit ?? 200, 1000));

  const rows = await db.query(
    `SELECT a.log_id, a.action, a.entity_type, a.entity_id, a.created_at, a.ip_address,
            a.before_state, a.after_state,
            TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS user_name,
            u.email
     FROM audit_log a LEFT JOIN app_user u ON u.user_id = a.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY a.created_at DESC LIMIT $${params.length}`, params);
  return rows.rows.map((r) => ({
    logId: String(r.log_id), action: r.action, entityType: r.entity_type,
    entityId: r.entity_id, at: when(r.created_at), ip: r.ip_address,
    user: r.user_name || r.email || 'system',
    before: r.before_state, after: r.after_state,
  }));
}

export async function auditFilters(db: Queryable, sess: Session, s: Scope) {
  requireAnyAdmin(sess);
  const actions = await db.query(
    `SELECT DISTINCT action FROM audit_log WHERE tenant_id = $1 ORDER BY action`, [s.tenantId]);
  const entities = await db.query(
    `SELECT DISTINCT entity_type FROM audit_log WHERE tenant_id = $1 ORDER BY entity_type`,
    [s.tenantId]);
  return {
    actions: actions.rows.map((r) => r.action),
    entityTypes: entities.rows.map((r) => r.entity_type),
  };
}

// ---------------------------------------------------------------------------
// PHI access log
// ---------------------------------------------------------------------------

export async function phiAccessLog(
  db: Queryable, sess: Session, s: Scope,
  f: { userId?: string; patientId?: string; from?: string; to?: string },
) {
  requireAnyAdmin(sess);
  const params: unknown[] = [s.tenantId];
  const where = [`a.tenant_id = $1`, `a.action = 'phi_accessed'`];
  if (f.userId) { params.push(f.userId); where.push(`a.user_id = $${params.length}`); }
  if (f.patientId) { params.push(f.patientId); where.push(`a.entity_id = $${params.length}::uuid`); }
  if (f.from) { params.push(f.from); where.push(`a.created_at >= $${params.length}::date`); }
  if (f.to) { params.push(f.to); where.push(`a.created_at < ($${params.length}::date + 1)`); }

  const rows = await db.query(
    `SELECT a.created_at, a.ip_address, a.after_state,
            TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS user_name,
            u.email,
            pat.first_name || ' ' || pat.last_name AS patient_name, pat.mrn, pat.patient_id
     FROM audit_log a
     LEFT JOIN app_user u ON u.user_id = a.user_id
     LEFT JOIN patient pat ON pat.patient_id = a.entity_id
     WHERE ${where.join(' AND ')}
     ORDER BY a.created_at DESC LIMIT 500`, params);
  return rows.rows.map((r) => ({
    at: when(r.created_at), ip: r.ip_address,
    user: r.user_name || r.email || 'system',
    patientId: r.patient_id, patientName: r.patient_name ?? '(deleted)',
    mrn: r.mrn, context: r.after_state?.context ?? null,
  }));
}

// ---------------------------------------------------------------------------
// system job log + rerun
// ---------------------------------------------------------------------------

export async function systemJobLog(
  db: Queryable, sess: Session, s: Scope,
  f: { status?: string; jobType?: string; limit?: number },
) {
  requireAnyAdmin(sess);
  const params: unknown[] = [s.tenantId];
  const where = ['j.tenant_id = $1'];
  if (f.status) { params.push(f.status); where.push(`j.status = $${params.length}::job_status`); }
  if (f.jobType) { params.push(f.jobType); where.push(`j.job_type = $${params.length}::job_type`); }
  params.push(Math.min(f.limit ?? 100, 500));

  const rows = await db.query(
    `SELECT j.job_id, j.job_type, j.status, j.started_at, j.completed_at,
            j.records_processed, j.errors_count, j.log_output, j.client_id, c.client_name
     FROM system_job j LEFT JOIN client c ON c.client_id = j.client_id
     WHERE ${where.join(' AND ')}
     ORDER BY j.started_at DESC NULLS LAST LIMIT $${params.length}`, params);
  return rows.rows.map((r) => ({
    jobId: r.job_id, jobType: r.job_type, status: r.status,
    startedAt: when(r.started_at), completedAt: when(r.completed_at),
    recordsProcessed: r.records_processed, errorsCount: r.errors_count,
    clientId: r.client_id, clientName: r.client_name ?? null,
    // failed jobs carry the raw error; completed jobs a JSON summary
    detail: r.log_output ? String(r.log_output).slice(0, 2000) : null,
    rerunnable: RERUNNABLE.has(r.job_type),
  }));
}

const RERUNNABLE = new Set([
  'run_detection', 'generate_appeals', 'reconcile_payments',
  'nightly_processing', 'deadline_monitor', 'weekly_summary',
]);

export async function rerunJob(pool: PoolLike, sess: Session, s: Scope, jobId: UUID) {
  requireAnyAdmin(sess);
  const rows = await pool.query(
    `SELECT job_type, client_id, status FROM system_job
     WHERE job_id = $1 AND tenant_id = $2`, [jobId, s.tenantId]);
  const job = rows.rows[0];
  if (!job) throw err('job not found', 404);
  if (job.status === 'running') throw err('job is currently running', 409);
  if (!RERUNNABLE.has(job.job_type)) {
    throw err(`${job.job_type} jobs cannot be re-run (the source file must be re-submitted)`, 409);
  }
  const args = { tenantId: s.tenantId, clientId: job.client_id ?? undefined };
  let out: { jobId: UUID };
  switch (job.job_type) {
    case 'run_detection': out = { jobId: (await runDetectionJob(pool, args)).jobId! }; break;
    case 'generate_appeals': out = await generateAppealPackets(pool, args); break;
    case 'reconcile_payments': out = await runPaymentReconciliation(pool, args); break;
    case 'deadline_monitor': out = await runDeadlineMonitor(pool, args); break;
    case 'weekly_summary':
      out = await runWeeklySummary(pool, { tenantId: s.tenantId, clientId: job.client_id });
      break;
    case 'nightly_processing':
      out = await runNightlyProcessing(pool, { tenantId: s.tenantId, clientId: job.client_id });
      break;
    default: throw err('unsupported', 409);
  }
  await pool.query(
    `SELECT app.log_security_event($1, $2, 'job_rerun', $3, NULL)`,
    [s.tenantId, sess.userId, JSON.stringify({ originalJobId: jobId, newJobId: out.jobId, jobType: job.job_type })]);
  return { ok: true, newJobId: out.jobId };
}

// ---------------------------------------------------------------------------
// data export approval workflow
// Admins' requests auto-approve (and are logged); everyone else needs an
// admin decision before the download link works.
// ---------------------------------------------------------------------------

const EXPORT_TYPES = new Set(['cases', 'audit_trail', 'phi_access']);

export async function requestExport(
  db: Queryable, sess: Session, s: Scope, exportType: string, params: object,
) {
  if (!EXPORT_TYPES.has(exportType)) throw err(`invalid export type: ${exportType}`, 400);
  const isAdmin = ['super_admin', 'tenant_admin', 'client_admin'].includes(sess.role);
  const inserted = await db.query(
    `INSERT INTO data_export_request (tenant_id, requested_by, export_type, params,
                                      status, approved_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'approved' THEN now() END)
     RETURNING export_id, status`,
    [s.tenantId, sess.userId, exportType, JSON.stringify(params ?? {}),
     isAdmin ? 'approved' : 'pending', isAdmin ? sess.userId : null]);
  await db.query(
    `SELECT app.log_security_event($1, $2, 'data_export_requested', $3, NULL)`,
    [s.tenantId, sess.userId,
     JSON.stringify({ exportId: inserted.rows[0].export_id, exportType, autoApproved: isAdmin })]);
  return { ok: true, exportId: inserted.rows[0].export_id, status: inserted.rows[0].status };
}

export async function listExports(db: Queryable, sess: Session, s: Scope) {
  const isAdmin = ['super_admin', 'tenant_admin', 'client_admin'].includes(sess.role);
  const rows = await db.query(
    `SELECT e.export_id, e.export_type, e.status, e.created_at, e.decided_at,
            TRIM(COALESCE(ru.first_name, '') || ' ' || COALESCE(ru.last_name, '')) AS requested_by,
            TRIM(COALESCE(au.first_name, '') || ' ' || COALESCE(au.last_name, '')) AS approved_by
     FROM data_export_request e
     JOIN app_user ru ON ru.user_id = e.requested_by
     LEFT JOIN app_user au ON au.user_id = e.approved_by
     WHERE e.tenant_id = $1 ${isAdmin ? '' : 'AND e.requested_by = $2'}
     ORDER BY e.created_at DESC LIMIT 100`,
    isAdmin ? [s.tenantId] : [s.tenantId, sess.userId]);
  return rows.rows.map((r) => ({
    exportId: r.export_id, exportType: r.export_type, status: r.status,
    requestedBy: r.requested_by, approvedBy: r.approved_by || null,
    createdAt: when(r.created_at), decidedAt: when(r.decided_at),
  }));
}

export async function decideExport(
  db: Queryable, sess: Session, s: Scope, exportId: UUID, approve: boolean,
) {
  requireAnyAdmin(sess);
  const updated = await db.query(
    `UPDATE data_export_request SET status = $3, approved_by = $4, decided_at = now()
     WHERE export_id = $1 AND tenant_id = $2 AND status = 'pending'
     RETURNING export_type`, [exportId, s.tenantId, approve ? 'approved' : 'denied', sess.userId]);
  if (!updated.rows[0]) throw err('export request not found or already decided', 404);
  await db.query(
    `SELECT app.log_security_event($1, $2, $3, $4, NULL)`,
    [s.tenantId, sess.userId, approve ? 'data_export_approved' : 'data_export_denied',
     JSON.stringify({ exportId })]);
  return { ok: true };
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return 'no rows\n';
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    if (v == null) return '';
    const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

export async function downloadExport(
  db: Queryable, sess: Session, s: Scope, exportId: UUID,
): Promise<{ fileName: string; csv: string }> {
  const rows = await db.query(
    `SELECT export_type, params, status, requested_by FROM data_export_request
     WHERE export_id = $1 AND tenant_id = $2`, [exportId, s.tenantId]);
  const e = rows.rows[0];
  if (!e) throw err('export not found', 404);
  if (e.requested_by !== sess.userId
      && !['super_admin', 'tenant_admin', 'client_admin'].includes(sess.role)) {
    throw err('not your export', 403);
  }
  if (!['approved', 'downloaded'].includes(e.status)) {
    throw err(`export is ${e.status} — admin approval required before download`, 403);
  }

  let data: Array<Record<string, unknown>>;
  if (e.export_type === 'audit_trail') {
    data = await auditTrail(db, { ...sess, role: 'tenant_admin' }, s, e.params ?? {});
  } else if (e.export_type === 'phi_access') {
    data = await phiAccessLog(db, { ...sess, role: 'tenant_admin' }, s, e.params ?? {});
  } else {
    const cases = await db.query(
      `SELECT rc.case_id, rc.case_type, rc.denial_category, rc.denial_reason_code,
              rc.status, rc.priority_level, rc.recovery_opportunity, rc.deadline_date,
              cl.claim_number_internal, py.payer_name, rc.created_at
       FROM recovery_case rc
       JOIN claim cl ON cl.claim_id = rc.claim_id
       JOIN payer py ON py.payer_id = cl.payer_id
       WHERE rc.tenant_id = $1 AND rc.client_id = ANY($2) AND rc.deleted_at IS NULL
       ORDER BY rc.created_at DESC LIMIT 5000`, [s.tenantId, s.clientIds]);
    data = cases.rows;
  }

  await db.query(
    `UPDATE data_export_request SET status = 'downloaded' WHERE export_id = $1`, [exportId]);
  await db.query(
    `SELECT app.log_security_event($1, $2, 'data_export_downloaded', $3, NULL)`,
    [s.tenantId, sess.userId, JSON.stringify({ exportId, exportType: e.export_type, rows: data.length })]);
  return { fileName: `${e.export_type}-export.csv`, csv: toCsv(data) };
}
