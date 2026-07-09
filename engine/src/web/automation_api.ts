// ============================================================================
// Web-facing queries/mutations for the notification center, notification
// preferences, and the automation rule builder.
// ============================================================================

import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';
import type { Session } from './auth.ts';
import type { Scope } from './queries.ts';

const NOTIFICATION_TYPES = [
  'case_assigned', 'deadline_approaching', 'payment_received', 'new_cases',
  'job_summary', 'system_alert', 'rule_notification',
];

// ---------------------------------------------------------------------------
// notification center
// ---------------------------------------------------------------------------

export async function listNotifications(db: Queryable, sess: Session, unreadOnly: boolean) {
  const rows = await db.query(
    `SELECT notification_id, notification_type, severity, title, body, case_id,
            read_at, created_at
     FROM notification
     WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''}
     ORDER BY created_at DESC LIMIT 100`,
    [sess.userId]);
  return rows.rows.map((r) => ({
    notificationId: r.notification_id,
    type: r.notification_type,
    severity: r.severity,
    title: r.title,
    body: r.body,
    caseId: r.case_id,
    read: r.read_at != null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

export async function unreadCount(db: Queryable, sess: Session): Promise<number> {
  const rows = await db.query(
    `SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND read_at IS NULL`,
    [sess.userId]);
  return rows.rows[0].n;
}

export async function markRead(db: Queryable, sess: Session, notificationId: UUID | 'all') {
  if (notificationId === 'all') {
    await db.query(
      `UPDATE notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
      [sess.userId]);
  } else {
    await db.query(
      `UPDATE notification SET read_at = now()
       WHERE notification_id = $1 AND user_id = $2`,
      [notificationId, sess.userId]);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// notification preferences
// ---------------------------------------------------------------------------

export async function getPreferences(db: Queryable, sess: Session) {
  const prefs = await db.query(
    `SELECT notification_type, in_app, email FROM notification_preference WHERE user_id = $1`,
    [sess.userId]);
  const user = await db.query(
    `SELECT digest_frequency FROM app_user WHERE user_id = $1`, [sess.userId]);
  const byType = new Map(prefs.rows.map((r) => [r.notification_type, r]));
  return {
    digestFrequency: user.rows[0]?.digest_frequency ?? 'daily',
    types: NOTIFICATION_TYPES.map((t) => ({
      type: t,
      inApp: byType.get(t)?.in_app ?? true,
      email: byType.get(t)?.email ?? 'digest',
    })),
  };
}

export async function savePreferences(
  db: Queryable, sess: Session,
  input: { digestFrequency?: string; types?: Array<{ type: string; inApp: boolean; email: string }> },
) {
  if (input.digestFrequency && ['daily', 'weekly', 'off'].includes(input.digestFrequency)) {
    await db.query(
      `UPDATE app_user SET digest_frequency = $1 WHERE user_id = $2`,
      [input.digestFrequency, sess.userId]);
  }
  for (const t of input.types ?? []) {
    if (!NOTIFICATION_TYPES.includes(t.type)) continue;
    if (!['immediate', 'digest', 'off'].includes(t.email)) continue;
    await db.query(
      `INSERT INTO notification_preference (tenant_id, user_id, notification_type, in_app, email)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, notification_type)
       DO UPDATE SET in_app = EXCLUDED.in_app, email = EXCLUDED.email`,
      [sess.tenantId, sess.userId, t.type, !!t.inApp, t.email]);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// automation rules
// ---------------------------------------------------------------------------

const TRIGGERS = ['case_created', 'deadline_approaching', 'payment_received',
  'status_changed', 'document_uploaded'];
const CONDITION_FIELDS = ['payer_id', 'denial_category', 'recovery_opportunity',
  'confidence_score', 'case_type'];
const CONDITION_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];
const ACTION_TYPES = ['assign_to', 'notify', 'set_priority',
  'add_to_submission_queue', 'flag_for_review'];

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin', 'client_admin']);

export function requireAdmin(sess: Session): void {
  if (!ADMIN_ROLES.has(sess.role)) {
    throw Object.assign(new Error('admin role required'), { status: 403 });
  }
}

export async function listRules(db: Queryable, s: Scope) {
  const rows = await db.query(
    `SELECT r.rule_id, r.name, r.client_id, r.trigger, r.trigger_param, r.conditions,
            r.actions, r.enabled, r.created_at,
            TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS created_by,
            (SELECT count(*)::int FROM rule_execution re WHERE re.rule_id = r.rule_id) AS executions
     FROM automation_rule r
     LEFT JOIN app_user u ON u.user_id = r.created_by
     WHERE r.tenant_id = $1 AND r.deleted_at IS NULL
       AND (r.client_id IS NULL OR r.client_id = ANY($2))
     ORDER BY r.created_at DESC`,
    [s.tenantId, s.clientIds]);
  return rows.rows.map((r) => ({
    ruleId: r.rule_id, name: r.name, clientId: r.client_id,
    trigger: r.trigger, triggerParam: r.trigger_param,
    conditions: r.conditions, actions: r.actions,
    enabled: r.enabled, createdBy: r.created_by || null,
    executions: r.executions,
  }));
}

export async function createRule(
  db: Queryable, sess: Session, s: Scope,
  input: {
    name: string; clientId?: UUID | null; trigger: string;
    triggerParam?: Record<string, unknown>;
    conditions?: Array<{ field: string; op: string; value: unknown }>;
    actions: Array<Record<string, unknown> & { type: string }>;
  },
) {
  requireAdmin(sess);
  if (!input.name?.trim()) throw Object.assign(new Error('rule name required'), { status: 400 });
  if (!TRIGGERS.includes(input.trigger)) {
    throw Object.assign(new Error(`invalid trigger: ${input.trigger}`), { status: 400 });
  }
  const conditions = (input.conditions ?? []).filter((c) => c.field && c.op);
  for (const c of conditions) {
    if (!CONDITION_FIELDS.includes(c.field) || !CONDITION_OPS.includes(c.op)) {
      throw Object.assign(new Error(`invalid condition: ${c.field} ${c.op}`), { status: 400 });
    }
  }
  const actions = (input.actions ?? []).filter((a) => a.type);
  if (actions.length === 0) throw Object.assign(new Error('at least one action required'), { status: 400 });
  for (const a of actions) {
    if (!ACTION_TYPES.includes(a.type)) {
      throw Object.assign(new Error(`invalid action: ${a.type}`), { status: 400 });
    }
    if (a.type === 'assign_to' && !a.userId) {
      throw Object.assign(new Error('assign_to requires a user'), { status: 400 });
    }
    if (a.type === 'notify' && !a.userId && !a.role) {
      throw Object.assign(new Error('notify requires a user or role'), { status: 400 });
    }
    if (a.type === 'set_priority'
        && !['critical', 'high', 'medium', 'low'].includes(String(a.level))) {
      throw Object.assign(new Error('set_priority requires a valid level'), { status: 400 });
    }
  }
  const clientId = input.clientId ?? (s.clientIds.length === 1 ? s.clientIds[0] : null);

  const inserted = await db.query(
    `INSERT INTO automation_rule
       (tenant_id, client_id, name, trigger, trigger_param, conditions, actions, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING rule_id`,
    [s.tenantId, clientId, input.name.trim(), input.trigger,
     JSON.stringify(input.triggerParam ?? {}), JSON.stringify(conditions),
     JSON.stringify(actions), sess.userId]);
  return { ok: true, ruleId: inserted.rows[0].rule_id };
}

export async function toggleRule(db: Queryable, sess: Session, s: Scope, ruleId: UUID) {
  requireAdmin(sess);
  const r = await db.query(
    `UPDATE automation_rule SET enabled = NOT enabled
     WHERE rule_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
     RETURNING enabled`,
    [ruleId, s.tenantId]);
  if (!r.rows[0]) throw Object.assign(new Error('rule not found'), { status: 404 });
  return { ok: true, enabled: r.rows[0].enabled };
}

export async function deleteRule(db: Queryable, sess: Session, s: Scope, ruleId: UUID) {
  requireAdmin(sess);
  await db.query(
    `UPDATE automation_rule SET deleted_at = now(), enabled = false
     WHERE rule_id = $1 AND tenant_id = $2`,
    [ruleId, s.tenantId]);
  return { ok: true };
}

export async function listRuleExecutions(db: Queryable, s: Scope) {
  const rows = await db.query(
    `SELECT re.executed_at, re.trigger, re.actions_applied, r.name AS rule_name,
            re.case_id, cl.claim_number_internal
     FROM rule_execution re
     JOIN automation_rule r ON r.rule_id = re.rule_id
     JOIN recovery_case rc ON rc.case_id = re.case_id
     JOIN claim cl ON cl.claim_id = rc.claim_id
     WHERE re.tenant_id = $1
     ORDER BY re.executed_at DESC LIMIT 50`,
    [s.tenantId]);
  return rows.rows.map((r) => ({
    executedAt: r.executed_at instanceof Date ? r.executed_at.toISOString() : String(r.executed_at),
    ruleName: r.rule_name,
    trigger: r.trigger,
    caseId: r.case_id,
    claimNumber: r.claim_number_internal,
    actionsApplied: r.actions_applied,
  }));
}
