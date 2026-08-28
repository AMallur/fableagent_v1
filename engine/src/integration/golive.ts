// ============================================================================
// GO-LIVE PREFLIGHT
//
// The question this answers is narrow and operational: may this client be
// switched from shadow to live — that is, may the platform start transmitting
// to payers and charging money against their recovered cash?
//
// It is deliberately NOT a compliance scorecard. It composes three things that
// already exist and adds the commercial prerequisites nothing else checked:
//
//   * inspectRuntimeReadiness  — the deployment's own configuration (secrets,
//     durable storage, TLS, delivery transport). Environment only, no I/O.
//   * per-payer readiness      — the existing activation/validation gates.
//   * this module              — what only a database query can answer about
//     THIS client: signed terms, approved contracts, reference data currency,
//     and the attribution posture they agreed to.
//
// Every check names a remedy. A check that cannot say what to do about itself
// is a complaint, not a gate.
//
// Severity is load-bearing:
//   block  going live with this unresolved would transmit, misprice or bill
//          something the operator cannot defend. `cleared` is false.
//   warn   defensible but degraded — the operator should know, and the result
//          is recorded either way.
//   info   context an approver will be asked about later.
// ============================================================================

import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';
import { inspectRuntimeReadiness, type RuntimeReadinessReport } from './runtime_readiness.ts';

export type GoLiveSeverity = 'block' | 'warn' | 'info';
export type GoLiveStatus = 'pass' | 'fail' | 'not_applicable';

export interface GoLiveCheck {
  key: string;
  group: 'commercial' | 'clinical_data' | 'payer' | 'financial_controls' | 'platform';
  severity: GoLiveSeverity;
  status: GoLiveStatus;
  title: string;
  detail: string;
  /** What to do about it. Empty only when the check passed. */
  remedy: string;
}

export interface GoLiveReport {
  clientId: UUID;
  clientName: string;
  operatingMode: 'shadow' | 'live';
  /** True only when every blocking check passed. */
  cleared: boolean;
  blockingFailures: number;
  warnings: number;
  checks: GoLiveCheck[];
  runtime: RuntimeReadinessReport;
  checkedAt: string;
}

/** timestamptz/date from pg arrives as a Date; render it as a plain day. */
const day = (v: unknown): string =>
  (v == null ? '' : new Date(v as string).toISOString().slice(0, 10));

const pass = (
  key: string, group: GoLiveCheck['group'], severity: GoLiveSeverity,
  title: string, detail: string,
): GoLiveCheck => ({ key, group, severity, status: 'pass', title, detail, remedy: '' });

const fail = (
  key: string, group: GoLiveCheck['group'], severity: GoLiveSeverity,
  title: string, detail: string, remedy: string,
): GoLiveCheck => ({ key, group, severity, status: 'fail', title, detail, remedy });

/**
 * Evaluate a client's readiness to operate live.
 *
 * Read-only. It never flips the mode itself — clearing the checks and deciding
 * to go live are two different acts, and the second one belongs to a person.
 */
export async function assessGoLive(
  db: Queryable, tenantId: UUID, clientId: UUID,
  env: Record<string, string | undefined> = process.env,
): Promise<GoLiveReport> {
  const c = await db.query(
    `SELECT client_name, operating_mode, subscription_status, status,
            baa_acknowledged_at, era_balance_policy, attribution_basis,
            attribution_window_days, clawback_policy, ncci_bundling_policy,
            go_live_at,
            (SELECT cmc.medicare_locality FROM client_medicare_config cmc
              WHERE cmc.tenant_id = client.tenant_id
                AND cmc.client_id = client.client_id) AS medicare_locality
     FROM client
     WHERE tenant_id = $1 AND client_id = $2 AND deleted_at IS NULL`,
    [tenantId, clientId]);
  if (!c.rows[0]) throw Object.assign(new Error('client not found'), { status: 404 });
  const row = c.rows[0];

  const checks: GoLiveCheck[] = [];

  // ---- commercial ---------------------------------------------------------
  checks.push(row.baa_acknowledged_at
    ? pass('baa', 'commercial', 'block', 'Business associate agreement',
      `acknowledged ${day(row.baa_acknowledged_at)}`)
    : fail('baa', 'commercial', 'block', 'Business associate agreement',
      'no BAA acknowledgement is recorded for this client',
      'Execute a BAA with the covered entity and record the acknowledgement before any PHI is processed.'));

  checks.push(['trial', 'active'].includes(row.subscription_status)
    ? pass('subscription', 'commercial', 'block', 'Subscription status',
      `subscription is ${row.subscription_status}`)
    : fail('subscription', 'commercial', 'block', 'Subscription status',
      `subscription is ${row.subscription_status}`,
      'Reactivate the subscription; a suspended or cancelled client is not processed.'));

  const plan = await db.query(
    `SELECT plan_name, contingency_percent, base_fee, per_case_fee,
            agreement_reference, agreement_executed_on, agreed_attribution_basis
     FROM pricing_plan
     WHERE tenant_id = $1 AND deleted_at IS NULL
       AND (client_id = $2 OR client_id IS NULL)
       AND effective_date <= CURRENT_DATE
       AND (expiration_date IS NULL OR expiration_date >= CURRENT_DATE)
     ORDER BY (client_id IS NOT NULL) DESC, effective_date DESC
     LIMIT 1`, [tenantId, clientId]);
  const p = plan.rows[0];

  if (!p) {
    checks.push(fail('pricing_plan', 'commercial', 'block', 'Pricing terms in force',
      'no pricing plan is effective for this client today',
      'Record the agreed terms as a pricing plan. A client with no plan on file invoices nothing.'));
  } else {
    checks.push(pass('pricing_plan', 'commercial', 'block', 'Pricing terms in force',
      `${p.plan_name}: ${Number(p.contingency_percent)}% contingency`
      + `${Number(p.base_fee) > 0 ? `, $${Number(p.base_fee)} base` : ''}`));

    const charging = Number(p.contingency_percent) > 0 || Number(p.base_fee) > 0
      || Number(p.per_case_fee) > 0;
    checks.push(p.agreement_reference
      ? pass('signed_terms', 'commercial', 'block', 'Countersigned commercial terms',
        `plan implements ${p.agreement_reference}`
        + `${p.agreement_executed_on ? ` executed ${day(p.agreement_executed_on)}` : ''}`)
      : charging
        ? fail('signed_terms', 'commercial', 'block', 'Countersigned commercial terms',
          'the plan in force names no executed agreement',
          'Record the order form or amendment reference on the pricing plan. An invoice cannot be issued without one.')
        : pass('signed_terms', 'commercial', 'block', 'Countersigned commercial terms',
          'plan charges nothing, so no agreement reference is required'));

    // The basis actually agreed to must match the basis being applied.
    if (p.agreed_attribution_basis && p.agreed_attribution_basis !== row.attribution_basis) {
      checks.push(fail('attribution_matches_agreement', 'commercial', 'block',
        'Attribution basis matches the agreement',
        `the client is set to ${row.attribution_basis} but the agreement says `
        + `${p.agreed_attribution_basis}`,
        'Align client.attribution_basis with the executed agreement, or amend the agreement.'));
    } else if (p.agreed_attribution_basis) {
      checks.push(pass('attribution_matches_agreement', 'commercial', 'block',
        'Attribution basis matches the agreement',
        `both the client and the agreement say ${row.attribution_basis}`));
    } else {
      checks.push(fail('attribution_matches_agreement', 'commercial', 'warn',
        'Attribution basis matches the agreement',
        'the plan does not record which attribution basis the customer agreed to',
        'Set agreed_attribution_basis on the plan so the fee and the measurement are documented together.'));
    }
  }

  // ---- clinical and reference data ---------------------------------------
  const contracts = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'active' AND approved_at IS NOT NULL
              AND (expiration_date IS NULL OR expiration_date >= CURRENT_DATE))::int AS usable
     FROM contract
     WHERE tenant_id = $1 AND client_id = $2 AND deleted_at IS NULL`, [tenantId, clientId]);
  const ct = contracts.rows[0];
  checks.push(ct.usable > 0
    ? pass('contracts', 'clinical_data', 'block', 'Approved contracts on file',
      `${ct.usable} active, approved, unexpired contract(s)`)
    : fail('contracts', 'clinical_data', 'block', 'Approved contracts on file',
      ct.total > 0
        ? `${ct.total} contract(s) exist but none are active, approved and unexpired`
        : 'no contracts are on file',
      'Load and approve at least one contract. Without one, pricing falls back to a Medicare '
      + 'proxy and every variance is an estimate rather than a contractual shortfall.'));

  checks.push(row.medicare_locality
    ? pass('medicare_locality', 'clinical_data', 'warn', 'Medicare locality',
      `locality ${row.medicare_locality}`)
    : fail('medicare_locality', 'clinical_data', 'warn', 'Medicare locality',
      'no CMS locality is configured for this client',
      'Set the client medicare locality. Proxy pricing is otherwise matched on an ambiguous key '
      + 'and can silently use another region’s rate.'));

  const ncci = await db.query(
    `SELECT scope, max(effective_date) AS newest
     FROM reference_dataset WHERE dataset_kind = 'ncci_ptp' GROUP BY scope`);
  if (ncci.rows.length === 0) {
    checks.push(fail('ncci_loaded', 'clinical_data', 'warn', 'CMS NCCI edit tables',
      'no NCCI procedure-to-procedure table has been imported',
      'Import the current quarterly CMS PTP files. Until then every bundling denial falls back '
      + 'to manual verification — the platform says so rather than guessing, but it cannot help.'));
  } else {
    // A table older than the dates of service being worked cannot rule an edit out.
    const stale = ncci.rows.filter((r) => {
      if (!r.newest) return true;
      const ageDays = (Date.now() - new Date(r.newest).getTime()) / 86_400_000;
      return ageDays > 200; // roughly two missed quarterly releases
    });
    checks.push(stale.length === 0
      ? pass('ncci_loaded', 'clinical_data', 'warn', 'CMS NCCI edit tables',
        ncci.rows.map((r) => `${r.scope} @ ${day(r.newest)}`).join(', '))
      : fail('ncci_loaded', 'clinical_data', 'warn', 'CMS NCCI edit tables',
        `stale table(s): ${stale.map((r) => r.scope).join(', ')}`,
        'Re-import the current quarterly CMS PTP files. The files are cumulative replacements, '
        + 'so an old import both misses new edits and revives withdrawn ones.'));
  }

  const codes = await db.query(
    `SELECT count(*)::int AS n FROM reference_dataset WHERE dataset_kind IN ('carc','rarc')`);
  checks.push(codes.rows[0].n > 0
    ? pass('carc_rarc', 'clinical_data', 'info', 'CARC/RARC descriptions',
      `${codes.rows[0].n} code dataset(s) imported`)
    : fail('carc_rarc', 'clinical_data', 'info', 'CARC/RARC descriptions',
      'no CARC/RARC reference data imported',
      'Import the X12 code lists so denial reasons render with their official descriptions.'));

  // ---- payer activation ---------------------------------------------------
  const payers = await db.query(
    `SELECT count(*)::int AS configured,
            count(*) FILTER (WHERE app.client_payer_capability_enabled(
              cpc.client_id, cpc.payer_id, 'detection'))::int AS detection_ready
     FROM client_payer_config cpc
     WHERE cpc.tenant_id = $1 AND cpc.client_id = $2`, [tenantId, clientId]);
  const pr = payers.rows[0];
  checks.push(pr.detection_ready > 0
    ? pass('payer_activation', 'payer', 'block', 'Payer activation',
      `${pr.detection_ready} of ${pr.configured} configured payer(s) cleared for detection`)
    : fail('payer_activation', 'payer', 'block', 'Payer activation',
      pr.configured > 0
        ? `${pr.configured} payer(s) configured but none cleared for detection`
        : 'no payers are configured for this client',
      'Complete payer profile and validation so at least one payer is cleared for detection. '
      + 'The platform fails closed here on purpose.'));

  // ---- financial controls -------------------------------------------------
  checks.push(row.era_balance_policy === 'strict'
    ? pass('era_balance', 'financial_controls', 'warn', '835 balance enforcement',
      'out-of-balance remittances are rejected')
    : fail('era_balance', 'financial_controls', 'warn', '835 balance enforcement',
      `policy is ${row.era_balance_policy}: files that do not balance are loaded and flagged`,
      'Relax this only for a trading partner whose rounding quirk is documented; every '
      + 'downstream dollar depends on the file adding up.'));

  checks.push(row.attribution_basis === 'incremental_net'
    ? pass('attribution_basis', 'financial_controls', 'warn', 'Recovery attribution basis',
      'incremental, net of reversals and takebacks')
    : fail('attribution_basis', 'financial_controls', 'warn', 'Recovery attribution basis',
      'set to gross post-appeal, which over-credits a reverse-and-reissue by construction',
      'Use this only where the executed agreement says so; it charges the customer for money '
      + 'they already had when a claim is reissued.'));

  checks.push(row.clawback_policy === 'auto'
    ? pass('clawback', 'financial_controls', 'info', 'Payer takeback handling',
      'credited recovery is reversed automatically when the payer takes it back')
    : fail('clawback', 'financial_controls', 'info', 'Payer takeback handling',
      'flag-only: a takeback is escalated but the credited figure stands until a person acts',
      'Somebody must own the queue of flagged takebacks, or invoices will overstate recovery.'));

  // ---- platform -----------------------------------------------------------
  const runtime = inspectRuntimeReadiness(env);
  for (const item of runtime.items) {
    if (item.ready) continue;
    checks.push(fail(`runtime_${item.key}`, 'platform',
      item.severity === 'blocker' ? 'block' : item.severity === 'warning' ? 'warn' : 'info',
      `Deployment: ${item.key.replace(/_/g, ' ')}`, item.detail,
      'Resolve in the deployment environment before this client transmits or stores PHI.'));
  }

  const blockingFailures = checks.filter((x) => x.severity === 'block' && x.status === 'fail').length;
  const warnings = checks.filter((x) => x.severity === 'warn' && x.status === 'fail').length;

  return {
    clientId,
    clientName: row.client_name,
    operatingMode: row.operating_mode,
    cleared: blockingFailures === 0,
    blockingFailures,
    warnings,
    checks,
    runtime,
    checkedAt: new Date().toISOString(),
  };
}

/** Persist a preflight result as evidence of what was true when somebody looked. */
export async function recordGoLiveCheck(
  db: Queryable, tenantId: UUID, report: GoLiveReport, checkedBy: UUID | null,
): Promise<UUID> {
  const inserted = await db.query(
    `INSERT INTO go_live_check
       (tenant_id, client_id, cleared, blocking_failures, warnings, detail, checked_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING go_live_check_id`,
    [tenantId, report.clientId, report.cleared, report.blockingFailures, report.warnings,
     JSON.stringify({ checks: report.checks, operatingMode: report.operatingMode }),
     checkedBy]);
  return inserted.rows[0].go_live_check_id;
}
