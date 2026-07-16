// ============================================================================
// Enterprise administration APIs: tenant overview, client management,
// onboarding, user management, payer configuration, integration settings,
// billing, compliance reports (audit / PHI / jobs), and export approvals.
//
// Authorization: requireTenantAdmin for tenant-wide operations;
// client_admins may manage their own client only (assertClientAccess).
// ============================================================================

import { randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import type { UUID } from '../types.ts';
import type { PoolLike } from '../service.ts';
import type { Queryable } from '../db/snapshot.ts';
import type { Session } from './auth.ts';
import { hashPassword } from './auth.ts';
import type { Scope } from './queries.ts';
import { encryptSecret, isEncrypted, validatePassword } from '../security/crypto.ts';

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const when = (v: unknown): string | null =>
  v == null ? null : (v instanceof Date ? v.toISOString() : String(v));

const err = (message: string, status: number) => Object.assign(new Error(message), { status });

export function requireTenantAdmin(sess: Session): void {
  if (!['super_admin', 'tenant_admin'].includes(sess.role)) {
    throw err('tenant admin role required', 403);
  }
}
export function requireAnyAdmin(sess: Session): void {
  if (!['super_admin', 'tenant_admin', 'client_admin'].includes(sess.role)) {
    throw err('admin role required', 403);
  }
}
/** client admins may only manage their own client */
export function assertClientAccess(sess: Session, s: Scope, clientId: UUID): void {
  requireAnyAdmin(sess);
  if (['super_admin', 'tenant_admin'].includes(sess.role)) {
    if (!s.clientIds.includes(clientId)) throw err('client not found', 404);
    return;
  }
  if (sess.clientId !== clientId) throw err('client not accessible', 403);
}

async function adminAudit(
  db: Queryable, sess: Session, action: string, entityType: string,
  entityId: UUID | null, detail: object,
): Promise<void> {
  await db.query(
    `SELECT app.log_security_event($1, $2, $3, $4, NULL)`,
    [sess.tenantId, sess.userId, action, JSON.stringify({ entityType, entityId, ...detail })]);
}

// ============================================================================
// TENANT OVERVIEW
// ============================================================================

export async function tenantOverview(db: Queryable, sess: Session, s: Scope) {
  requireTenantAdmin(sess);
  const clients = await db.query(
    `SELECT c.client_id, c.client_name, c.specialty, c.state, c.status,
            c.subscription_status, c.created_at, c.baa_acknowledged_at,
            (SELECT count(*)::int FROM recovery_case rc
             WHERE rc.client_id = c.client_id AND rc.deleted_at IS NULL
               AND rc.status IN ('open','in_progress','submitted','pending_payer')) AS open_cases,
            (SELECT COALESCE(sum(rc.recovery_opportunity), 0) FROM recovery_case rc
             WHERE rc.client_id = c.client_id AND rc.deleted_at IS NULL
               AND rc.status IN ('open','in_progress','submitted','pending_payer')) AS aum,
            (SELECT COALESCE(sum(pe.amount_recovered), 0) FROM payment_event pe
             JOIN recovery_case rc ON rc.case_id = pe.case_id
             WHERE rc.client_id = c.client_id) AS recovered,
            (SELECT count(*)::int FROM app_user u
             WHERE u.tenant_id = c.tenant_id AND (u.client_id = c.client_id OR u.client_id IS NULL)
               AND u.deleted_at IS NULL) AS users,
            (SELECT count(*)::int FROM onboarding_step os
             WHERE os.client_id = c.client_id AND os.completed_at IS NOT NULL) AS steps_done,
            (SELECT count(*)::int FROM onboarding_step os WHERE os.client_id = c.client_id) AS steps_total
     FROM client c
     WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
     ORDER BY c.created_at`, [s.tenantId]);

  const totals = await db.query(
    `SELECT
       (SELECT count(*)::int FROM app_user WHERE tenant_id = $1 AND deleted_at IS NULL) AS users,
       (SELECT count(*)::int FROM system_job
        WHERE tenant_id = $1 AND status = 'failed'
          AND started_at > now() - interval '24 hours') AS failed_jobs_24h,
       (SELECT count(*)::int FROM email_outbox
        WHERE tenant_id = $1 AND status = 'queued') AS queued_emails,
       (SELECT max(completed_at) FROM system_job
        WHERE tenant_id = $1 AND job_type = 'nightly_processing' AND status = 'completed') AS last_nightly`,
    [s.tenantId]);
  const t = totals.rows[0];

  const rows = clients.rows.map((c) => ({
    clientId: c.client_id, name: c.client_name, specialty: c.specialty, state: c.state,
    status: c.status, subscription: c.subscription_status,
    baaAcknowledged: c.baa_acknowledged_at != null,
    openCases: c.open_cases, aum: r2(num(c.aum)), recovered: r2(num(c.recovered)),
    users: c.users,
    onboarding: { done: c.steps_done, total: c.steps_total },
  }));

  return {
    clients: rows,
    totals: {
      clients: rows.length,
      aum: r2(rows.reduce((x, c) => x + c.aum, 0)),
      recovered: r2(rows.reduce((x, c) => x + c.recovered, 0)),
      activeCases: rows.reduce((x, c) => x + c.openCases, 0),
      users: t.users,
    },
    health: {
      failedJobs24h: t.failed_jobs_24h,
      queuedEmails: t.queued_emails,
      lastNightly: when(t.last_nightly),
      status: t.failed_jobs_24h === 0 ? 'healthy' : 'degraded',
    },
  };
}

// ============================================================================
// CLIENT MANAGEMENT + ONBOARDING
// ============================================================================

export const ONBOARDING_STEPS: Array<{ key: string; label: string }> = [
  { key: 'profile', label: 'Organization profile complete' },
  { key: 'payers', label: 'Payers configured' },
  { key: 'contracts', label: 'Contracts uploaded' },
  { key: 'first_835', label: 'First 835 file uploaded or connection tested' },
  { key: 'first_detection', label: 'First detection run complete' },
  { key: 'first_cases', label: 'First cases created' },
  { key: 'team_invited', label: 'Team users invited' },
  { key: 'admin_review', label: 'Admin reviewed first cases' },
];

export async function createClient(
  pool: PoolLike, sess: Session, s: Scope,
  input: { clientName: string; taxId?: string; npiGroup?: string; specialty?: string;
           state?: string; timezone?: string; baaAcknowledged: boolean },
) {
  requireTenantAdmin(sess);
  if (!input.clientName?.trim()) throw err('client name required', 400);
  if (!input.baaAcknowledged) {
    throw err('BAA acknowledgment is required before a client can be created', 428);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [s.tenantId]);
    const inserted = await client.query(
      `INSERT INTO client (tenant_id, client_name, tax_id, npi_group, specialty, state,
                           timezone, baa_acknowledged_at, baa_acknowledged_by)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'America/New_York'), now(), $8)
       RETURNING client_id`,
      [s.tenantId, input.clientName.trim(), input.taxId ?? null, input.npiGroup ?? null,
       input.specialty ?? null, input.state ?? null, input.timezone ?? null, sess.userId]);
    const clientId: UUID = inserted.rows[0].client_id;
    for (let i = 0; i < ONBOARDING_STEPS.length; i++) {
      await client.query(
        `INSERT INTO onboarding_step (tenant_id, client_id, step_number, step_key, label)
         VALUES ($1, $2, $3, $4, $5)`,
        [s.tenantId, clientId, i + 1, ONBOARDING_STEPS[i].key, ONBOARDING_STEPS[i].label]);
    }
    await client.query('COMMIT');
    await adminAudit(pool, sess, 'client_created', 'client', clientId,
      { name: input.clientName });
    return { ok: true, clientId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** auto-evaluate onboarding from real data; manual steps stay manual */
export async function refreshOnboarding(db: Queryable, sess: Session, clientId: UUID) {
  const checks: Record<string, string> = {
    profile: `SELECT 1 FROM client WHERE client_id = $1
              AND tax_id IS NOT NULL AND npi_group IS NOT NULL AND address IS NOT NULL`,
    payers: `SELECT 1 FROM client_payer_config WHERE client_id = $1 LIMIT 1`,
    contracts: `SELECT 1 FROM contract WHERE client_id = $1 AND deleted_at IS NULL LIMIT 1`,
    first_835: `SELECT 1 WHERE EXISTS (SELECT 1 FROM remittance WHERE client_id = $1)
                OR EXISTS (SELECT 1 FROM client_integration WHERE client_id = $1
                           AND last_tested_at IS NOT NULL)`,
    first_detection: `SELECT 1 FROM system_job WHERE client_id = $1
                      AND job_type IN ('run_detection', 'nightly_processing')
                      AND status = 'completed' LIMIT 1`,
    first_cases: `SELECT 1 FROM recovery_case WHERE client_id = $1 AND deleted_at IS NULL LIMIT 1`,
    team_invited: `SELECT 1 FROM app_user WHERE client_id = $1 AND deleted_at IS NULL LIMIT 1`,
    // admin_review is manual — checked off by an admin
  };
  for (const [key, sql] of Object.entries(checks)) {
    const hit = await db.query(sql, [clientId]);
    if (hit.rows[0]) {
      await db.query(
        `UPDATE onboarding_step SET completed_at = COALESCE(completed_at, now())
         WHERE client_id = $1 AND step_key = $2`, [clientId, key]);
    }
  }
  const steps = await db.query(
    `SELECT step_number, step_key, label, completed_at,
            TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS completed_by
     FROM onboarding_step os LEFT JOIN app_user u ON u.user_id = os.completed_by
     WHERE os.client_id = $1 ORDER BY step_number`, [clientId]);
  return steps.rows.map((r) => ({
    stepNumber: r.step_number, key: r.step_key, label: r.label,
    completed: r.completed_at != null, completedAt: when(r.completed_at),
    completedBy: r.completed_by || null,
  }));
}

export async function completeOnboardingStep(
  db: Queryable, sess: Session, s: Scope, clientId: UUID, stepKey: string,
) {
  assertClientAccess(sess, s, clientId);
  const updated = await db.query(
    `UPDATE onboarding_step SET completed_at = now(), completed_by = $3
     WHERE client_id = $1 AND step_key = $2 AND completed_at IS NULL
     RETURNING step_id`, [clientId, stepKey, sess.userId]);
  if (updated.rows[0]) {
    await adminAudit(db, sess, 'onboarding_step_completed', 'client', clientId, { stepKey });
  }
  return { ok: true };
}

export async function clientDetail(db: Queryable, sess: Session, s: Scope, clientId: UUID) {
  assertClientAccess(sess, s, clientId);
  const c = await db.query(
    `SELECT client_id, client_name, tax_id, npi_group, specialty, state, address,
            timezone, nightly_run_time::text AS nightly_run_time, ingest_folder,
            status, subscription_status, features, baa_acknowledged_at,
            recovery_alert_threshold, appeal_review_threshold, contract_effective_date
     FROM client WHERE client_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [clientId, s.tenantId]);
  if (!c.rows[0]) throw err('client not found', 404);
  const r = c.rows[0];

  const payers = await db.query(
    `SELECT py.payer_id, py.payer_name, py.payer_type, py.payer_id_code,
            py.timely_filing_limit_days, py.appeal_deadline_days, py.portal_url,
            py.tenant_id AS payer_tenant_id,
            cpc.autopilot_enabled, cpc.review_threshold, cpc.min_case_threshold
     FROM payer py
     LEFT JOIN client_payer_config cpc ON cpc.payer_id = py.payer_id AND cpc.client_id = $1
     WHERE py.deleted_at IS NULL AND (py.tenant_id IS NULL OR py.tenant_id = $2)
       AND (cpc.config_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM claim cl WHERE cl.payer_id = py.payer_id AND cl.client_id = $1))
     ORDER BY py.payer_name`, [clientId, s.tenantId]);

  const contracts = await db.query(
    `SELECT ct.contract_id, ct.effective_date, ct.expiration_date, ct.fee_schedule_type,
            py.payer_name,
            (SELECT count(*)::int FROM contract_line l
             WHERE l.contract_id = ct.contract_id AND l.deleted_at IS NULL) AS lines
     FROM contract ct JOIN payer py ON py.payer_id = ct.payer_id
     WHERE ct.client_id = $1 AND ct.deleted_at IS NULL ORDER BY ct.effective_date DESC`,
    [clientId]);

  const docs = await db.query(
    `SELECT document_id, document_type, file_name, uploaded_at FROM document
     WHERE client_id = $1 AND case_id IS NULL AND deleted_at IS NULL
       AND document_type IN ('contract', 'fee_schedule', 'payer_policy')
     ORDER BY uploaded_at DESC`, [clientId]);

  const users = await db.query(
    `SELECT user_id, email, TRIM(first_name || ' ' || last_name) AS name, role, status,
            last_login, mfa_enabled, client_id
     FROM app_user WHERE tenant_id = $1 AND (client_id = $2 OR client_id IS NULL)
       AND deleted_at IS NULL ORDER BY role, name`, [s.tenantId, clientId]);

  const integration = await db.query(
    `SELECT sftp_host, sftp_port, sftp_username,
            (sftp_password_encrypted IS NOT NULL) AS sftp_password_set,
            sftp_path, clearinghouse_name, clearinghouse_status,
            pm_system, pm_status, last_tested_at,
            sftp_inbound_enabled, sftp_inbound_username, sftp_inbound_created_at
     FROM client_integration WHERE client_id = $1`, [clientId]);

  return {
    client: {
      clientId: r.client_id, name: r.client_name, taxId: r.tax_id, npiGroup: r.npi_group,
      specialty: r.specialty, state: r.state, address: r.address, timezone: r.timezone,
      nightlyRunTime: String(r.nightly_run_time).slice(0, 5), ingestFolder: r.ingest_folder,
      status: r.status, subscription: r.subscription_status, features: r.features,
      baaAcknowledgedAt: when(r.baa_acknowledged_at),
      alertThreshold: r.recovery_alert_threshold == null ? null : num(r.recovery_alert_threshold),
      reviewThreshold: r.appeal_review_threshold == null ? null : num(r.appeal_review_threshold),
    },
    payers: payers.rows.map((p) => ({
      payerId: p.payer_id, name: p.payer_name, type: p.payer_type, code: p.payer_id_code,
      timelyFilingDays: p.timely_filing_limit_days, appealDeadlineDays: p.appeal_deadline_days,
      portalUrl: p.portal_url,
      editable: p.payer_tenant_id != null,   // shared master payers are read-only
      autopilot: p.autopilot_enabled ?? false,
      reviewThreshold: p.review_threshold == null ? null : num(p.review_threshold),
      minCaseThreshold: p.min_case_threshold == null ? null : num(p.min_case_threshold),
    })),
    contracts: contracts.rows.map((x) => ({
      contractId: x.contract_id, payerName: x.payer_name,
      effectiveDate: iso(x.effective_date), expirationDate: iso(x.expiration_date),
      feeScheduleType: x.fee_schedule_type, lines: x.lines,
    })),
    documents: docs.rows.map((d) => ({
      documentId: d.document_id, type: d.document_type, fileName: d.file_name,
      uploadedAt: when(d.uploaded_at),
    })),
    users: users.rows.map((u) => ({
      userId: u.user_id, email: u.email, name: u.name, role: u.role, status: u.status,
      lastLogin: when(u.last_login), mfaEnabled: u.mfa_enabled,
      scope: u.client_id ? 'client' : 'tenant-wide',
    })),
    integration: integration.rows[0] ? {
      sftpHost: integration.rows[0].sftp_host, sftpPort: integration.rows[0].sftp_port,
      sftpUsername: integration.rows[0].sftp_username,
      sftpPasswordSet: integration.rows[0].sftp_password_set,
      sftpPath: integration.rows[0].sftp_path,
      clearinghouseName: integration.rows[0].clearinghouse_name,
      clearinghouseStatus: integration.rows[0].clearinghouse_status,
      pmSystem: integration.rows[0].pm_system, pmStatus: integration.rows[0].pm_status,
      lastTestedAt: when(integration.rows[0].last_tested_at),
      sftpInboundEnabled: integration.rows[0].sftp_inbound_enabled,
      sftpInboundUsername: integration.rows[0].sftp_inbound_username,
      sftpInboundCreatedAt: when(integration.rows[0].sftp_inbound_created_at),
    } : null,
  };
}

export async function updateClientSettings(
  db: Queryable, sess: Session, s: Scope, clientId: UUID, input: Record<string, unknown>,
) {
  assertClientAccess(sess, s, clientId);
  const fields: Record<string, string> = {
    name: 'client_name', taxId: 'tax_id', npiGroup: 'npi_group', specialty: 'specialty',
    state: 'state', timezone: 'timezone', nightlyRunTime: 'nightly_run_time',
    alertThreshold: 'recovery_alert_threshold', reviewThreshold: 'appeal_review_threshold',
    ingestFolder: 'ingest_folder',
  };
  const sets: string[] = [];
  const params: unknown[] = [clientId, s.tenantId];
  for (const [key, col] of Object.entries(fields)) {
    if (key in input) {
      params.push(input[key] === '' ? null : input[key]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if ('address' in input) {
    params.push(JSON.stringify(input.address));
    sets.push(`address = $${params.length}::jsonb`);
  }
  if (sets.length === 0) return { ok: true, updated: 0 };
  await db.query(
    `UPDATE client SET ${sets.join(', ')} WHERE client_id = $1 AND tenant_id = $2`, params);
  await adminAudit(db, sess, 'client_settings_updated', 'client', clientId,
    { fields: Object.keys(input) });
  return { ok: true, updated: sets.length };
}

export async function setClientFeature(
  db: Queryable, sess: Session, s: Scope, clientId: UUID, feature: string, enabled: boolean,
) {
  requireTenantAdmin(sess);
  assertClientAccess(sess, s, clientId);
  if (!['detection', 'appeals', 'automation', 'analytics'].includes(feature)) {
    throw err(`unknown feature: ${feature}`, 400);
  }
  await db.query(
    `UPDATE client SET features = jsonb_set(features, ARRAY[$3], to_jsonb($4::boolean))
     WHERE client_id = $1 AND tenant_id = $2`, [clientId, s.tenantId, feature, enabled]);
  await adminAudit(db, sess, 'client_feature_changed', 'client', clientId, { feature, enabled });
  return { ok: true };
}

export async function setSubscriptionStatus(
  db: Queryable, sess: Session, s: Scope, clientId: UUID, status: string,
) {
  requireTenantAdmin(sess);
  assertClientAccess(sess, s, clientId);
  if (!['trial', 'active', 'suspended', 'cancelled'].includes(status)) {
    throw err(`invalid subscription status: ${status}`, 400);
  }
  await db.query(
    `UPDATE client SET subscription_status = $3 WHERE client_id = $1 AND tenant_id = $2`,
    [clientId, s.tenantId, status]);
  await adminAudit(db, sess, 'subscription_changed', 'client', clientId, { status });
  return { ok: true };
}

// ============================================================================
// PAYER CONFIGURATION
// ============================================================================

export async function upsertPayerConfig(
  db: Queryable, sess: Session, s: Scope, clientId: UUID,
  input: { payerId: UUID; autopilot?: boolean; reviewThreshold?: number | null;
           minCaseThreshold?: number | null;
           timelyFilingDays?: number | null; appealDeadlineDays?: number | null;
           portalUrl?: string | null },
) {
  assertClientAccess(sess, s, clientId);
  await db.query(
    `INSERT INTO client_payer_config (tenant_id, client_id, payer_id, autopilot_enabled,
                                      review_threshold, min_case_threshold)
     VALUES ($1, $2, $3, COALESCE($4, false), $5, $6)
     ON CONFLICT (client_id, payer_id) DO UPDATE SET
       autopilot_enabled = COALESCE($4, client_payer_config.autopilot_enabled),
       review_threshold = $5,
       min_case_threshold = COALESCE($6, client_payer_config.min_case_threshold)`,
    [s.tenantId, clientId, input.payerId, input.autopilot ?? null,
     input.reviewThreshold ?? null, input.minCaseThreshold ?? null]);

  // payer-level fields are editable only on tenant-owned payers
  if (input.timelyFilingDays !== undefined || input.appealDeadlineDays !== undefined
      || input.portalUrl !== undefined) {
    const updated = await db.query(
      `UPDATE payer SET
         timely_filing_limit_days = COALESCE($2, timely_filing_limit_days),
         appeal_deadline_days = COALESCE($3, appeal_deadline_days),
         portal_url = COALESCE($4, portal_url)
       WHERE payer_id = $1 AND tenant_id = $5 RETURNING payer_id`,
      [input.payerId, input.timelyFilingDays ?? null, input.appealDeadlineDays ?? null,
       input.portalUrl ?? null, s.tenantId]);
    if (!updated.rows[0]) {
      const shared = await db.query(
        `SELECT 1 FROM payer WHERE payer_id = $1 AND tenant_id IS NULL`, [input.payerId]);
      if (shared.rows[0]) {
        throw err('this payer is a shared master record — filing/deadline/portal fields are read-only', 409);
      }
    }
  }
  await adminAudit(db, sess, 'payer_config_updated', 'payer', input.payerId, { clientId });
  return { ok: true };
}

export async function createTenantPayer(
  db: Queryable, sess: Session, s: Scope,
  input: { payerName: string; payerType: string; payerIdCode?: string;
           timelyFilingDays?: number; appealDeadlineDays?: number;
           portalUrl?: string; appealAddress?: string },
) {
  requireAnyAdmin(sess);
  if (!input.payerName?.trim()) throw err('payer name required', 400);
  const inserted = await db.query(
    `INSERT INTO payer (tenant_id, payer_name, payer_type, payer_id_code,
                        timely_filing_limit_days, appeal_deadline_days, portal_url, appeal_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING payer_id`,
    [s.tenantId, input.payerName.trim(), input.payerType ?? 'commercial',
     input.payerIdCode ?? null, input.timelyFilingDays ?? 90,
     input.appealDeadlineDays ?? 90, input.portalUrl ?? null, input.appealAddress ?? null]);
  await adminAudit(db, sess, 'payer_created', 'payer', inserted.rows[0].payer_id,
    { name: input.payerName });
  return { ok: true, payerId: inserted.rows[0].payer_id };
}

export async function createContract(
  db: Queryable, sess: Session, s: Scope, clientId: UUID,
  input: { payerId: UUID; effectiveDate: string; expirationDate?: string | null;
           feeScheduleType: string;
           lines?: Array<{ procedureCode: string; modifier?: string | null;
                           allowedAmount?: number | null; percentOfMedicare?: number | null }> },
) {
  assertClientAccess(sess, s, clientId);
  if (!input.payerId || !input.effectiveDate) throw err('payer and effective date required', 400);
  const inserted = await db.query(
    `INSERT INTO contract (tenant_id, client_id, payer_id, effective_date, expiration_date,
                           fee_schedule_type)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING contract_id`,
    [s.tenantId, clientId, input.payerId, input.effectiveDate,
     input.expirationDate ?? null, input.feeScheduleType ?? 'fee_schedule']);
  const contractId: UUID = inserted.rows[0].contract_id;
  for (const l of input.lines ?? []) {
    if (!l.procedureCode) continue;
    await db.query(
      `INSERT INTO contract_line (tenant_id, contract_id, procedure_code, modifier,
                                  allowed_amount, percent_of_medicare)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [s.tenantId, contractId, l.procedureCode, l.modifier ?? null,
       l.allowedAmount ?? null, l.percentOfMedicare ?? null]);
  }
  await adminAudit(db, sess, 'contract_created', 'contract', contractId,
    { clientId, lines: (input.lines ?? []).length });
  return { ok: true, contractId };
}

// ============================================================================
// USER MANAGEMENT
// ============================================================================

const INVITABLE_ROLES = new Set(['tenant_admin', 'client_admin', 'biller', 'collector', 'viewer']);

export async function listUsers(db: Queryable, sess: Session, s: Scope) {
  requireTenantAdmin(sess);
  const rows = await db.query(
    `SELECT u.user_id, u.email, TRIM(u.first_name || ' ' || u.last_name) AS name,
            u.role, u.status, u.last_login, u.mfa_enabled, u.client_id,
            u.locked_until, u.invite_token IS NOT NULL AS invite_pending,
            c.client_name,
            (SELECT count(*)::int FROM case_action ca
             WHERE ca.performed_by_user_id = u.user_id
               AND ca.action_date > now() - interval '30 days') AS actions_30d
     FROM app_user u LEFT JOIN client c ON c.client_id = u.client_id
     WHERE u.tenant_id = $1 AND u.deleted_at IS NULL
     ORDER BY u.created_at`, [s.tenantId]);
  return rows.rows.map((u) => ({
    userId: u.user_id, email: u.email, name: u.name || null, role: u.role,
    status: u.status, lastLogin: when(u.last_login), mfaEnabled: u.mfa_enabled,
    clientId: u.client_id, clientName: u.client_name ?? null,
    locked: u.locked_until != null && new Date(u.locked_until).getTime() > Date.now(),
    invitePending: u.invite_pending, actions30d: u.actions_30d,
  }));
}

export async function inviteUser(
  db: Queryable, sess: Session, s: Scope,
  input: { email: string; firstName?: string; lastName?: string; role: string; clientId?: UUID | null },
) {
  requireAnyAdmin(sess);
  if (!input.email?.includes('@')) throw err('valid email required', 400);
  if (!INVITABLE_ROLES.has(input.role)) throw err(`invalid role: ${input.role}`, 400);
  // client admins invite into their own client only, with non-admin roles
  if (sess.role === 'client_admin') {
    if (input.role === 'tenant_admin') throw err('client admins cannot grant tenant admin', 403);
    input.clientId = sess.clientId;
  }
  if (input.clientId && !s.clientIds.includes(input.clientId)) throw err('client not found', 404);

  const exists = await db.query(
    `SELECT 1 FROM app_user WHERE tenant_id = $1 AND email = $2 AND deleted_at IS NULL`,
    [s.tenantId, input.email]);
  if (exists.rows[0]) throw err('a user with this email already exists', 409);

  const token = randomBytes(24).toString('base64url');
  const inserted = await db.query(
    `INSERT INTO app_user (tenant_id, client_id, email, first_name, last_name, role,
                           status, invite_token, invite_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, now() + interval '7 days')
     RETURNING user_id`,
    [s.tenantId, input.clientId ?? null, input.email, input.firstName ?? null,
     input.lastName ?? null, input.role, token]);
  await db.query(
    `INSERT INTO email_outbox (tenant_id, user_id, to_email, subject, body_text, kind)
     VALUES ($1, $2, $3, $4, $5, 'immediate')`,
    [s.tenantId, inserted.rows[0].user_id, input.email,
     '[RCM] You have been invited to RCM Recovery',
     `You've been invited as ${input.role.replaceAll('_', ' ')}. `
     + `Accept your invitation and set a password:\n\n`
     + `/accept-invite?token=${token}\n\nThis link expires in 7 days.`]);
  await adminAudit(db, sess, 'user_invited', 'app_user', inserted.rows[0].user_id,
    { email: input.email, role: input.role });
  return { ok: true, userId: inserted.rows[0].user_id, inviteToken: token };
}

export async function acceptInvite(db: Queryable, token: string, password: string) {
  const policy = validatePassword(password);
  if (!policy.ok) throw err(`password policy: ${policy.errors.join('; ')}`, 400);
  const updated = await db.query(
    `UPDATE app_user
     SET password_hash = $2, password_changed_at = now(), status = 'active',
         invite_token = NULL, invite_expires_at = NULL
     WHERE invite_token = $1 AND invite_expires_at > now()
       AND status = 'pending' AND deleted_at IS NULL
     RETURNING user_id, tenant_id, email`,
    [token, hashPassword(password)]);
  if (!updated.rows[0]) throw err('invitation is invalid or expired', 410);
  const u = updated.rows[0];
  await db.query(
    `SELECT app.log_security_event($1, $2, 'invite_accepted', $3, NULL)`,
    [u.tenant_id, u.user_id, JSON.stringify({ email: u.email })]);
  return { ok: true };
}

export async function deactivateUser(db: Queryable, sess: Session, s: Scope, userId: UUID) {
  requireTenantAdmin(sess);
  if (userId === sess.userId) throw err('you cannot deactivate yourself', 400);
  const updated = await db.query(
    `UPDATE app_user SET status = 'inactive', invite_token = NULL
     WHERE user_id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING email`,
    [userId, s.tenantId]);
  if (!updated.rows[0]) throw err('user not found', 404);
  await adminAudit(db, sess, 'user_deactivated', 'app_user', userId,
    { email: updated.rows[0].email });
  return { ok: true };
}

/** reset access: clear lockout + password + MFA, issue a fresh invite token */
export async function resetUserAccess(db: Queryable, sess: Session, s: Scope, userId: UUID) {
  requireTenantAdmin(sess);
  const token = randomBytes(24).toString('base64url');
  const updated = await db.query(
    `UPDATE app_user
     SET password_hash = NULL, failed_login_attempts = 0, locked_until = NULL,
         mfa_enabled = false, mfa_secret = NULL, status = 'pending',
         invite_token = $3, invite_expires_at = now() + interval '7 days'
     WHERE user_id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING email`,
    [userId, s.tenantId, token]);
  if (!updated.rows[0]) throw err('user not found', 404);
  await db.query(
    `INSERT INTO email_outbox (tenant_id, user_id, to_email, subject, body_text, kind)
     VALUES ($1, $2, $3, '[RCM] Your access has been reset', $4, 'immediate')`,
    [s.tenantId, userId, updated.rows[0].email,
     `Your access was reset by an administrator. Set a new password:\n\n/accept-invite?token=${token}`]);
  await adminAudit(db, sess, 'user_access_reset', 'app_user', userId, {});
  return { ok: true, inviteToken: token };
}

export async function assignUserToClient(
  db: Queryable, sess: Session, s: Scope, userId: UUID, clientId: UUID | null,
) {
  requireTenantAdmin(sess);
  if (clientId && !s.clientIds.includes(clientId)) throw err('client not found', 404);
  const updated = await db.query(
    `UPDATE app_user SET client_id = $3
     WHERE user_id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING email`,
    [userId, s.tenantId, clientId]);
  if (!updated.rows[0]) throw err('user not found', 404);
  await adminAudit(db, sess, 'user_client_assigned', 'app_user', userId, { clientId });
  return { ok: true };
}

export async function userActivity(db: Queryable, sess: Session, s: Scope, userId: UUID) {
  requireTenantAdmin(sess);
  const rows = await db.query(
    `SELECT action, entity_type, entity_id, created_at, ip_address
     FROM audit_log WHERE tenant_id = $1 AND user_id = $2
     ORDER BY created_at DESC LIMIT 200`, [s.tenantId, userId]);
  return rows.rows.map((r) => ({
    action: r.action, entityType: r.entity_type, entityId: r.entity_id,
    at: when(r.created_at), ip: r.ip_address,
  }));
}

// ============================================================================
// INTEGRATION SETTINGS
// ============================================================================

export async function saveIntegration(
  db: Queryable, sess: Session, s: Scope, clientId: UUID,
  input: { sftpHost?: string; sftpPort?: number; sftpUsername?: string;
           sftpPassword?: string; sftpPath?: string;
           clearinghouseName?: string; pmSystem?: string },
) {
  assertClientAccess(sess, s, clientId);
  const encrypted = input.sftpPassword ? encryptSecret(input.sftpPassword) : null;
  await db.query(
    `INSERT INTO client_integration
       (tenant_id, client_id, sftp_host, sftp_port, sftp_username,
        sftp_password_encrypted, sftp_path, clearinghouse_name, clearinghouse_status,
        pm_system, pm_status)
     VALUES ($1, $2, $3::text, COALESCE($4::int, 22), $5::text, $6::text, $7::text, $8::text,
             CASE WHEN $8::text IS NULL THEN 'not_configured' ELSE 'configured' END,
             $9::text, CASE WHEN $9::text IS NULL THEN 'not_connected' ELSE 'configured' END)
     ON CONFLICT (client_id) DO UPDATE SET
       sftp_host = COALESCE($3::text, client_integration.sftp_host),
       sftp_port = COALESCE($4::int, client_integration.sftp_port),
       sftp_username = COALESCE($5::text, client_integration.sftp_username),
       sftp_password_encrypted = COALESCE($6::text, client_integration.sftp_password_encrypted),
       sftp_path = COALESCE($7::text, client_integration.sftp_path),
       clearinghouse_name = COALESCE($8::text, client_integration.clearinghouse_name),
       clearinghouse_status = CASE WHEN $8::text IS NOT NULL THEN 'configured'
                                   ELSE client_integration.clearinghouse_status END,
       pm_system = COALESCE($9::text, client_integration.pm_system),
       pm_status = CASE WHEN $9::text IS NOT NULL THEN 'configured'
                        ELSE client_integration.pm_status END`,
    [s.tenantId, clientId, input.sftpHost ?? null, input.sftpPort ?? null,
     input.sftpUsername ?? null, encrypted, input.sftpPath ?? null,
     input.clearinghouseName ?? null, input.pmSystem ?? null]);
  await adminAudit(db, sess, 'integration_updated', 'client', clientId,
    { fields: Object.keys(input).filter((k) => k !== 'sftpPassword') });
  return { ok: true, sftpPasswordStored: encrypted != null && isEncrypted(encrypted) };
}

/** connection test: fields present + host resolves in DNS */
export async function testIntegration(db: Queryable, sess: Session, s: Scope, clientId: UUID) {
  assertClientAccess(sess, s, clientId);
  const row = await db.query(
    `SELECT sftp_host, sftp_username, sftp_password_encrypted FROM client_integration
     WHERE client_id = $1`, [clientId]);
  const i = row.rows[0];
  if (!i?.sftp_host || !i.sftp_username || !i.sftp_password_encrypted) {
    throw err('SFTP host, username, and password must be configured before testing', 409);
  }
  try {
    await dns.lookup(i.sftp_host);
  } catch {
    throw err(`host ${i.sftp_host} does not resolve`, 502);
  }
  await db.query(
    `UPDATE client_integration SET last_tested_at = now(),
            clearinghouse_status = CASE WHEN clearinghouse_name IS NOT NULL
                                        THEN 'tested' ELSE clearinghouse_status END
     WHERE client_id = $1`, [clientId]);
  await adminAudit(db, sess, 'integration_tested', 'client', clientId, { host: i.sftp_host });
  return { ok: true, tested: true };
}

// ---------------------------------------------------------------------------
// inbound SFTP credentials — WE run the server (integration/sftp_server.ts);
// this issues the client a username/password to push 835/837/CSV files to
// their own chrooted folder. Same shown-once pattern as API keys: the
// plaintext password is returned exactly once and never stored reversibly.
// ---------------------------------------------------------------------------

function randomSftpUsername(clientId: UUID): string {
  return `c-${clientId.slice(0, 8)}-${randomBytes(3).toString('hex')}`;
}

export async function generateSftpCredentials(
  db: Queryable, sess: Session, s: Scope, clientId: UUID,
): Promise<{ ok: true; username: string; password: string }> {
  assertClientAccess(sess, s, clientId);
  const username = randomSftpUsername(clientId);
  const password = randomBytes(18).toString('base64url');
  await db.query(
    `INSERT INTO client_integration
       (tenant_id, client_id, sftp_inbound_enabled, sftp_inbound_username,
        sftp_inbound_password_hash, sftp_inbound_created_at)
     VALUES ($1, $2, true, $3, $4, now())
     ON CONFLICT (client_id) DO UPDATE SET
       sftp_inbound_enabled = true,
       sftp_inbound_username = $3,
       sftp_inbound_password_hash = $4,
       sftp_inbound_created_at = now()`,
    [s.tenantId, clientId, username, hashPassword(password)]);
  await adminAudit(db, sess, 'sftp_credentials_generated', 'client', clientId, { username });
  return { ok: true, username, password };
}

export async function revokeSftpCredentials(
  db: Queryable, sess: Session, s: Scope, clientId: UUID,
): Promise<{ ok: true }> {
  assertClientAccess(sess, s, clientId);
  await db.query(
    `UPDATE client_integration SET sftp_inbound_enabled = false WHERE client_id = $1`,
    [clientId]);
  await adminAudit(db, sess, 'sftp_credentials_revoked', 'client', clientId, {});
  return { ok: true };
}

// ============================================================================
// BILLING & SUBSCRIPTION
// ============================================================================

export const PLAN_PRICING: Record<string, { base: number; perCase: number }> = {
  standard: { base: 499, perCase: 4 },
  professional: { base: 1499, perCase: 3 },
  enterprise: { base: 3499, perCase: 2 },
};

export async function billingSummary(db: Queryable, sess: Session, s: Scope, clientId: UUID) {
  assertClientAccess(sess, s, clientId);
  const plan = await db.query(
    `SELECT t.subscription_tier, c.subscription_status FROM client c
     JOIN tenant t ON t.tenant_id = c.tenant_id WHERE c.client_id = $1`, [clientId]);
  const usage = await db.query(
    `SELECT
       (SELECT count(*)::int FROM claim WHERE client_id = $1
        AND created_at >= date_trunc('month', now())) AS claims,
       (SELECT count(*)::int FROM recovery_case WHERE client_id = $1
        AND created_at >= date_trunc('month', now())) AS cases,
       (SELECT COALESCE(sum(pe.amount_recovered), 0) FROM payment_event pe
        JOIN recovery_case rc ON rc.case_id = pe.case_id
        WHERE rc.client_id = $1 AND pe.payment_date >= date_trunc('month', now())) AS recovered`,
    [clientId]);
  const invoices = await db.query(
    `SELECT invoice_id, period_start, period_end, plan, claims_processed, cases_created,
            amount_recovered, amount_due, status
     FROM invoice WHERE client_id = $1 ORDER BY period_start DESC LIMIT 24`, [clientId]);
  const tier = plan.rows[0]?.subscription_tier ?? 'standard';
  return {
    plan: tier,
    pricing: PLAN_PRICING[tier] ?? PLAN_PRICING.standard,
    availablePlans: Object.entries(PLAN_PRICING).map(([name, p]) => ({ name, ...p })),
    subscriptionStatus: plan.rows[0]?.subscription_status,
    usageThisPeriod: {
      claimsProcessed: usage.rows[0].claims,
      casesCreated: usage.rows[0].cases,
      amountRecovered: r2(num(usage.rows[0].recovered)),
    },
    invoices: invoices.rows.map((i) => ({
      invoiceId: i.invoice_id, periodStart: iso(i.period_start), periodEnd: iso(i.period_end),
      plan: i.plan, claimsProcessed: i.claims_processed, casesCreated: i.cases_created,
      amountRecovered: r2(num(i.amount_recovered)), amountDue: r2(num(i.amount_due)),
      status: i.status,
    })),
  };
}

export async function generateInvoice(
  db: Queryable, sess: Session, s: Scope, clientId: UUID, month: string, // 'YYYY-MM'
) {
  requireAnyAdmin(sess);
  assertClientAccess(sess, s, clientId);
  if (!/^\d{4}-\d{2}$/.test(month)) throw err('month must be YYYY-MM', 400);
  const start = `${month}-01`;
  const plan = await db.query(
    `SELECT t.subscription_tier FROM client c JOIN tenant t ON t.tenant_id = c.tenant_id
     WHERE c.client_id = $1`, [clientId]);
  const tier = plan.rows[0]?.subscription_tier ?? 'standard';
  const pricing = PLAN_PRICING[tier] ?? PLAN_PRICING.standard;

  const usage = await db.query(
    `SELECT
       (SELECT count(*)::int FROM claim WHERE client_id = $1
        AND created_at >= $2::date AND created_at < $2::date + interval '1 month') AS claims,
       (SELECT count(*)::int FROM recovery_case WHERE client_id = $1
        AND created_at >= $2::date AND created_at < $2::date + interval '1 month') AS cases,
       (SELECT COALESCE(sum(pe.amount_recovered), 0) FROM payment_event pe
        JOIN recovery_case rc ON rc.case_id = pe.case_id
        WHERE rc.client_id = $1 AND pe.payment_date >= $2::date
          AND pe.payment_date < $2::date + interval '1 month') AS recovered`,
    [clientId, start]);
  const u = usage.rows[0];
  const amountDue = r2(pricing.base + u.cases * pricing.perCase);

  const inserted = await db.query(
    `INSERT INTO invoice (tenant_id, client_id, period_start, period_end, plan,
                          claims_processed, cases_created, amount_recovered, amount_due)
     VALUES ($1, $2, $3::date, ($3::date + interval '1 month' - interval '1 day')::date,
             $4, $5, $6, $7, $8)
     ON CONFLICT (client_id, period_start) DO UPDATE SET
       claims_processed = $5, cases_created = $6, amount_recovered = $7, amount_due = $8
     RETURNING invoice_id`,
    [s.tenantId, clientId, start, tier, u.claims, u.cases, num(u.recovered), amountDue]);
  await adminAudit(db, sess, 'invoice_generated', 'invoice', inserted.rows[0].invoice_id,
    { clientId, month, amountDue });
  return { ok: true, invoiceId: inserted.rows[0].invoice_id, amountDue };
}

export async function changePlan(db: Queryable, sess: Session, s: Scope, tier: string) {
  requireTenantAdmin(sess);
  if (!(tier in PLAN_PRICING)) throw err(`unknown plan: ${tier}`, 400);
  await db.query(
    `UPDATE tenant SET subscription_tier = $2 WHERE tenant_id = $1`, [s.tenantId, tier]);
  await adminAudit(db, sess, 'plan_changed', 'tenant', s.tenantId, { tier });
  return { ok: true, plan: tier };
}
