// ============================================================================
// AUTOMATION RULE ENGINE
//
// WHEN [trigger] AND [conditions…] THEN [actions…]
//
// processTrigger(pool, event) loads the enabled rules for the event's
// trigger, evaluates conditions against the case, and executes actions in a
// transaction. Every firing is recorded in rule_execution AND the audit
// trail (action='rule_executed'). deadline_approaching rules fire at most
// once per rule+case (partial unique index).
// ============================================================================

import type { UUID } from '../types.ts';
import type { PoolLike } from '../service.ts';
import type { Queryable } from '../db/snapshot.ts';
import { createNotification, notifyRoles } from './notify.ts';

export type RuleTrigger =
  | 'case_created' | 'deadline_approaching' | 'payment_received'
  | 'status_changed' | 'document_uploaded';

export interface RuleCondition {
  field: 'payer_id' | 'denial_category' | 'recovery_opportunity'
       | 'confidence_score' | 'case_type';
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
  value: string | number;
}

export type RuleAction =
  | { type: 'assign_to'; userId: UUID }
  | { type: 'notify'; userId?: UUID; role?: string }
  | { type: 'set_priority'; level: 'critical' | 'high' | 'medium' | 'low' }
  | { type: 'add_to_submission_queue' }
  | { type: 'flag_for_review' };

export interface RuleEvent {
  trigger: RuleTrigger;
  tenantId: UUID;
  caseId: UUID;
  /** for deadline_approaching: how many days remain */
  daysToDeadline?: number;
  detail?: string;   // e.g. new status, document type
}

export interface CaseFacts {
  payer_id: string;
  denial_category: string | null;
  recovery_opportunity: number;
  confidence_score: number | null;
  case_type: string;
}

// ---------------------------------------------------------------------------
// condition evaluation (pure)
// ---------------------------------------------------------------------------

export function evaluateConditions(conditions: RuleCondition[], facts: CaseFacts): boolean {
  return conditions.every((c) => {
    const actual = (facts as any)[c.field];
    if (actual == null) return false;
    const numeric = ['recovery_opportunity', 'confidence_score'].includes(c.field);
    const a = numeric ? Number(actual) : String(actual);
    const b = numeric ? Number(c.value) : String(c.value);
    switch (c.op) {
      case 'eq': return a === b;
      case 'neq': return a !== b;
      case 'gt': return a > b;
      case 'gte': return a >= b;
      case 'lt': return a < b;
      case 'lte': return a <= b;
      default: return false;
    }
  });
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

interface LoadedRule {
  rule_id: UUID;
  name: string;
  client_id: UUID | null;
  trigger_param: { days?: number };
  conditions: RuleCondition[];
  actions: RuleAction[];
}

export interface RuleFiring {
  ruleId: UUID;
  ruleName: string;
  caseId: UUID;
  actionsApplied: string[];
}

export async function processTrigger(
  pool: PoolLike, event: RuleEvent,
): Promise<RuleFiring[]> {
  const caseRow = await pool.query(
    `SELECT rc.case_id, rc.tenant_id, rc.client_id, rc.case_type, rc.denial_category,
            rc.recovery_opportunity, rc.confidence_score, rc.status, rc.priority_level,
            rc.assigned_to_user_id, cl.payer_id,
            cl.claim_number_internal, py.payer_name
     FROM recovery_case rc
     JOIN claim cl ON cl.claim_id = rc.claim_id
     JOIN payer py ON py.payer_id = cl.payer_id
     WHERE rc.case_id = $1 AND rc.tenant_id = $2 AND rc.deleted_at IS NULL`,
    [event.caseId, event.tenantId],
  );
  const c = caseRow.rows[0];
  if (!c) return [];

  const rules = await pool.query(
    `SELECT rule_id, name, client_id, trigger_param, conditions, actions
     FROM automation_rule
     WHERE tenant_id = $1 AND trigger = $2 AND enabled AND deleted_at IS NULL
       AND (client_id IS NULL OR client_id = $3)
     ORDER BY created_at`,
    [event.tenantId, event.trigger, c.client_id],
  );

  const facts: CaseFacts = {
    payer_id: c.payer_id,
    denial_category: c.denial_category ?? c.case_type,
    recovery_opportunity: Number(c.recovery_opportunity) || 0,
    confidence_score: c.confidence_score == null ? null : Number(c.confidence_score),
    case_type: c.case_type,
  };

  const firings: RuleFiring[] = [];
  for (const rule of rules.rows as LoadedRule[]) {
    // deadline rules carry a days threshold: fire when the case is inside it
    if (event.trigger === 'deadline_approaching') {
      const threshold = rule.trigger_param?.days ?? 14;
      if (event.daysToDeadline == null || event.daysToDeadline > threshold) continue;
    }
    if (!evaluateConditions(rule.conditions ?? [], facts)) continue;

    // one rule's failure (e.g. an action referencing a deleted user) must not
    // block other rules — its transaction rolls back and the failure is logged
    try {
      const applied = await executeRule(pool, event, rule, c);
      if (applied) firings.push(applied);
    } catch (err) {
      console.error(`automation rule "${rule.name}" failed on case ${event.caseId}:`,
        err instanceof Error ? err.message : err);
    }
  }
  return firings;
}

async function executeRule(
  pool: PoolLike, event: RuleEvent, rule: LoadedRule, c: any,
): Promise<RuleFiring | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [event.tenantId]);

    // dedupe: deadline rules fire once per rule+case
    const exec = await client.query(
      `INSERT INTO rule_execution (tenant_id, rule_id, case_id, trigger, actions_applied)
       VALUES ($1, $2, $3, $4, '[]')
       ON CONFLICT (rule_id, case_id) WHERE trigger = 'deadline_approaching' DO NOTHING
       RETURNING execution_id`,
      [event.tenantId, rule.rule_id, event.caseId, event.trigger],
    );
    if (!exec.rows[0]) { await client.query('ROLLBACK'); return null; }

    const applied: string[] = [];
    for (const action of rule.actions ?? []) {
      applied.push(await applyAction(client, event, rule, c, action));
    }

    await client.query(
      `UPDATE rule_execution SET actions_applied = $1 WHERE execution_id = $2`,
      [JSON.stringify(applied), exec.rows[0].execution_id],
    );
    // audit trail entry for the firing
    await client.query(
      `INSERT INTO audit_log (tenant_id, action, entity_type, entity_id, after_state)
       VALUES ($1, 'rule_executed', 'automation_rule', $2, $3)`,
      [event.tenantId, rule.rule_id, JSON.stringify({
        rule: rule.name, trigger: event.trigger, caseId: event.caseId, actions: applied,
      })],
    );
    await client.query(
      `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_system, notes)
       VALUES ($1, $2, 'note', true, $3)`,
      [event.tenantId, event.caseId,
       `Automation rule "${rule.name}" fired (${event.trigger}): ${applied.join('; ')}`],
    );

    await client.query('COMMIT');
    return { ruleId: rule.rule_id, ruleName: rule.name, caseId: event.caseId, actionsApplied: applied };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function applyAction(
  db: Queryable, event: RuleEvent, rule: LoadedRule, c: any, action: RuleAction,
): Promise<string> {
  switch (action.type) {
    case 'assign_to': {
      await db.query(
        `UPDATE recovery_case SET assigned_to_user_id = $1 WHERE case_id = $2`,
        [action.userId, event.caseId]);
      await createNotification(db, {
        tenantId: event.tenantId, userId: action.userId, type: 'case_assigned',
        title: `Case ${c.claim_number_internal} assigned to you by rule "${rule.name}"`,
        body: `${c.payer_name} · ${c.case_type} · $${Number(c.recovery_opportunity).toFixed(2)}`,
        caseId: event.caseId,
      });
      return `assigned to ${action.userId}`;
    }
    case 'notify': {
      const title = `Rule "${rule.name}": ${event.trigger.replaceAll('_', ' ')} on case ${c.claim_number_internal}`;
      const body = `${c.payer_name} · ${c.case_type} · $${Number(c.recovery_opportunity).toFixed(2)}`
        + (event.detail ? ` · ${event.detail}` : '');
      if (action.userId) {
        await createNotification(db, {
          tenantId: event.tenantId, userId: action.userId, type: 'rule_notification',
          title, body, caseId: event.caseId,
        });
        return `notified user ${action.userId}`;
      }
      const n = await notifyRoles(db, event.tenantId, [action.role ?? 'client_admin'], {
        type: 'rule_notification', title, body, caseId: event.caseId,
      });
      return `notified ${n} user(s) with role ${action.role ?? 'client_admin'}`;
    }
    case 'set_priority':
      await db.query(
        `UPDATE recovery_case SET priority_level = $1 WHERE case_id = $2`,
        [action.level, event.caseId]);
      return `priority set to ${action.level}`;
    case 'add_to_submission_queue': {
      // the queue = ready packets; clear the review hold on the case's packet
      const updated = await db.query(
        `UPDATE appeal_packet SET needs_review = false
         WHERE case_id = $1 AND packet_status = 'ready' AND deleted_at IS NULL
         RETURNING packet_id`,
        [event.caseId]);
      return updated.rows[0]
        ? 'packet released to submission queue (review hold cleared)'
        : 'no ready packet to queue (draft or none)';
    }
    case 'flag_for_review':
      await db.query(
        `UPDATE recovery_case SET flagged_for_review = true WHERE case_id = $1`,
        [event.caseId]);
      return 'flagged for review';
    default:
      return `unknown action ${(action as any).type} skipped`;
  }
}
