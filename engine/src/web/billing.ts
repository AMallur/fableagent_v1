// ============================================================================
// Commercial terms: pricing plans and invoices.
//
// Recovery work is sold on contingency — a share of the money the client
// actually got back — not per case. That makes an invoice an assertion about
// someone else's cash, so three things have to hold:
//
//   * The BASIS is verifiable. The contingency is charged on recovery this
//     platform attributed and can defend line by line (see the attribution
//     columns on payment_event), never on an estimate.
//   * Each recovery is billed ONCE. invoice_line carries a unique index on
//     payment_event_id, so a re-run or an overlapping period cannot bill the
//     same dollar twice.
//   * An ISSUED invoice does not change. The database refuses to mutate one;
//     corrections are credit notes. Before this, regenerating a month silently
//     rewrote a bill that had already gone out.
// ============================================================================

import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';
import type { Session } from './auth.ts';
import type { Scope } from './queries.ts';
import {
  adminAudit, assertClientAccess, err, requireAnyAdmin, requireTenantAdmin,
} from './admin_api.ts';

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const iso = (d: unknown): string | null =>
  (d == null ? null : new Date(d as string).toISOString().slice(0, 10));

export interface PricingPlan {
  pricingPlanId: UUID;
  clientId: UUID | null;
  planName: string;
  effectiveDate: string;
  expirationDate: string | null;
  baseFee: number;
  perCaseFee: number;
  contingencyPercent: number;
  minimumFee: number;
  maximumFee: number | null;
  contingencyBasis: 'attributed' | 'verified';
  notes: string | null;
}

/**
 * The plan in force for a client on a date. A client-specific plan overrides
 * the tenant default; among equally specific plans the latest effective date
 * wins, which is how a mid-term renegotiation is recorded.
 */
export async function resolvePricingPlan(
  db: Queryable, tenantId: UUID, clientId: UUID, onDate: string,
): Promise<PricingPlan | null> {
  const rows = await db.query(
    `SELECT pricing_plan_id, client_id, plan_name, effective_date, expiration_date,
            base_fee, per_case_fee, contingency_percent, minimum_fee, maximum_fee,
            contingency_basis, notes
     FROM pricing_plan
     WHERE tenant_id = $1 AND deleted_at IS NULL
       AND (client_id = $2 OR client_id IS NULL)
       AND effective_date <= $3::date
       AND (expiration_date IS NULL OR expiration_date >= $3::date)
     ORDER BY (client_id IS NOT NULL) DESC, effective_date DESC
     LIMIT 1`,
    [tenantId, clientId, onDate]);
  const p = rows.rows[0];
  if (!p) return null;
  return {
    pricingPlanId: p.pricing_plan_id,
    clientId: p.client_id,
    planName: p.plan_name,
    effectiveDate: iso(p.effective_date)!,
    expirationDate: iso(p.expiration_date),
    baseFee: num(p.base_fee),
    perCaseFee: num(p.per_case_fee),
    contingencyPercent: num(p.contingency_percent),
    minimumFee: num(p.minimum_fee),
    maximumFee: p.maximum_fee == null ? null : num(p.maximum_fee),
    contingencyBasis: p.contingency_basis,
    notes: p.notes,
  };
}

export async function listPricingPlans(
  db: Queryable, sess: Session, s: Scope,
): Promise<{ plans: PricingPlan[] }> {
  requireAnyAdmin(sess);
  const rows = await db.query(
    `SELECT pricing_plan_id, client_id, plan_name, effective_date, expiration_date,
            base_fee, per_case_fee, contingency_percent, minimum_fee, maximum_fee,
            contingency_basis, notes
     FROM pricing_plan WHERE tenant_id = $1 AND deleted_at IS NULL
     ORDER BY (client_id IS NULL), effective_date DESC`,
    [s.tenantId]);
  return {
    plans: rows.rows.map((p) => ({
      pricingPlanId: p.pricing_plan_id,
      clientId: p.client_id,
      planName: p.plan_name,
      effectiveDate: iso(p.effective_date)!,
      expirationDate: iso(p.expiration_date),
      baseFee: num(p.base_fee),
      perCaseFee: num(p.per_case_fee),
      contingencyPercent: num(p.contingency_percent),
      minimumFee: num(p.minimum_fee),
      maximumFee: p.maximum_fee == null ? null : num(p.maximum_fee),
      contingencyBasis: p.contingency_basis,
      notes: p.notes,
    })),
  };
}

export interface PricingPlanInput {
  clientId?: UUID | null;
  planName: string;
  effectiveDate: string;
  expirationDate?: string | null;
  baseFee?: number;
  perCaseFee?: number;
  contingencyPercent?: number;
  minimumFee?: number;
  maximumFee?: number | null;
  contingencyBasis?: 'attributed' | 'verified';
  notes?: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function createPricingPlan(
  db: Queryable, sess: Session, s: Scope, input: PricingPlanInput,
) {
  requireTenantAdmin(sess);
  if (!input.planName?.trim()) throw err('planName is required', 400);
  if (!DATE.test(String(input.effectiveDate))) {
    throw err('effectiveDate must be YYYY-MM-DD', 400);
  }
  if (input.expirationDate && !DATE.test(String(input.expirationDate))) {
    throw err('expirationDate must be YYYY-MM-DD', 400);
  }
  if (input.clientId) assertClientAccess(sess, s, input.clientId);

  const percent = Number(input.contingencyPercent ?? 0);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw err('contingencyPercent must be between 0 and 100', 400);
  }
  for (const [name, value] of [
    ['baseFee', input.baseFee], ['perCaseFee', input.perCaseFee],
    ['minimumFee', input.minimumFee],
  ] as const) {
    if (value != null && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
      throw err(`${name} must be a non-negative amount`, 400);
    }
  }
  if (input.maximumFee != null
      && Number(input.maximumFee) < Number(input.minimumFee ?? 0)) {
    throw err('maximumFee cannot be below minimumFee', 400);
  }

  const inserted = await db.query(
    `INSERT INTO pricing_plan
       (tenant_id, client_id, plan_name, effective_date, expiration_date,
        base_fee, per_case_fee, contingency_percent, minimum_fee, maximum_fee,
        contingency_basis, notes, created_by)
     VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING pricing_plan_id`,
    [s.tenantId, input.clientId ?? null, input.planName.trim(),
     input.effectiveDate, input.expirationDate ?? null,
     input.baseFee ?? 0, input.perCaseFee ?? 0, percent,
     input.minimumFee ?? 0, input.maximumFee ?? null,
     input.contingencyBasis ?? 'attributed', input.notes ?? null, sess.userId]);
  const pricingPlanId = inserted.rows[0].pricing_plan_id;
  await adminAudit(db, sess, 'pricing_plan_created', 'pricing_plan', pricingPlanId, {
    clientId: input.clientId ?? null, contingencyPercent: percent,
    effectiveDate: input.effectiveDate,
  });
  return { ok: true as const, pricingPlanId };
}

// ---------------------------------------------------------------------------
// Invoicing
// ---------------------------------------------------------------------------

/**
 * Recoveries in the period that have never been billed. 'verified' bills only
 * what a person confirmed; 'attributed' also bills the reconciler's own
 * incremental_net attribution. Negative events (a payer clawing money back)
 * are included so a takeback reduces the next bill rather than being kept.
 */
async function billableRecoveries(
  db: Queryable, tenantId: UUID, clientId: UUID,
  periodStart: string, periodEnd: string, basis: 'attributed' | 'verified',
) {
  const verifiedOnly = basis === 'verified';
  const rows = await db.query(
    `SELECT pe.payment_event_id, pe.case_id, pe.claim_id, pe.amount_recovered,
            pe.payment_date, pe.attribution_basis,
            cl.claim_number_internal, py.payer_name
     FROM payment_event pe
     JOIN recovery_case rc ON rc.case_id = pe.case_id
     JOIN claim cl ON cl.claim_id = pe.claim_id
     JOIN payer py ON py.payer_id = cl.payer_id
     WHERE pe.tenant_id = $1 AND rc.client_id = $2
       AND pe.payment_date >= $3::date AND pe.payment_date <= $4::date
       AND ($5::boolean IS NOT TRUE OR pe.verified_by_user_id IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM invoice_line il WHERE il.payment_event_id = pe.payment_event_id)
     ORDER BY pe.payment_date, pe.created_at`,
    [tenantId, clientId, periodStart, periodEnd, verifiedOnly]);
  return rows.rows;
}

export async function previewInvoice(
  db: Queryable, sess: Session, s: Scope, clientId: UUID, month: string,
) {
  requireAnyAdmin(sess);
  assertClientAccess(sess, s, clientId);
  return computeInvoice(db, s.tenantId, clientId, month);
}

interface ComputedInvoice {
  month: string;
  periodStart: string;
  periodEnd: string;
  plan: PricingPlan | null;
  claimsProcessed: number;
  casesCreated: number;
  amountRecovered: number;
  attributedRecovery: number;
  baseFee: number;
  caseFeeTotal: number;
  contingencyPercent: number;
  contingencyFee: number;
  minimumApplied: boolean;
  maximumApplied: boolean;
  amountDue: number;
  /** Anything an operator needs to know before sending this out. */
  warnings: string[];
  lines: Array<{
    paymentEventId: UUID; caseId: UUID; claimId: UUID; claimNumber: string;
    payerName: string; paymentDate: string | null; amountRecovered: number;
    fee: number; attributionBasis: string | null;
  }>;
}

async function computeInvoice(
  db: Queryable, tenantId: UUID, clientId: UUID, month: string,
): Promise<ComputedInvoice> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw err('month must be YYYY-MM', 400);
  const periodStart = `${month}-01`;
  const periodEndRow = await db.query(
    `SELECT ($1::date + interval '1 month' - interval '1 day')::date AS period_end`,
    [periodStart]);
  const periodEnd = iso(periodEndRow.rows[0].period_end)!;

  const plan = await resolvePricingPlan(db, tenantId, clientId, periodStart);

  const usage = await db.query(
    `SELECT
       (SELECT count(*)::int FROM claim
        WHERE client_id = $1 AND created_at >= $2::date
          AND created_at < $3::date + 1) AS claims,
       (SELECT count(*)::int FROM recovery_case
        WHERE client_id = $1 AND created_at >= $2::date
          AND created_at < $3::date + 1) AS cases,
       (SELECT COALESCE(sum(pe.amount_recovered), 0) FROM payment_event pe
        JOIN recovery_case rc ON rc.case_id = pe.case_id
        WHERE rc.client_id = $1 AND pe.payment_date >= $2::date
          AND pe.payment_date <= $3::date) AS recovered`,
    [clientId, periodStart, periodEnd]);

  const basis = plan?.contingencyBasis ?? 'attributed';
  const events = await billableRecoveries(
    db, tenantId, clientId, periodStart, periodEnd, basis);
  const attributedRecovery = r2(events.reduce((sum, e) => sum + num(e.amount_recovered), 0));

  const contingencyPercent = plan?.contingencyPercent ?? 0;
  const baseFee = plan?.baseFee ?? 0;
  const casesCreated = usage.rows[0].cases;
  const caseFeeTotal = r2((plan?.perCaseFee ?? 0) * casesCreated);
  // Contingency is never negative: a period whose net recovery is negative
  // (more clawed back than recovered) owes no fee, and the unbilled negative
  // events stay unbilled so they offset the next period instead.
  const contingencyFee = r2(Math.max(0, attributedRecovery) * (contingencyPercent / 100));

  let amountDue = r2(baseFee + caseFeeTotal + contingencyFee);
  let minimumApplied = false;
  let maximumApplied = false;
  if (plan && plan.minimumFee > amountDue) {
    amountDue = plan.minimumFee;
    minimumApplied = true;
  }
  if (plan?.maximumFee != null && amountDue > plan.maximumFee) {
    amountDue = plan.maximumFee;
    maximumApplied = true;
  }

  const warnings: string[] = [];
  if (!plan) {
    warnings.push(
      'no pricing plan is in force for this client on ' + periodStart
      + ' — nothing can be billed until the agreed terms are recorded');
  } else if (contingencyPercent > 0 && attributedRecovery === 0 && events.length === 0) {
    warnings.push('no unbilled recovery in this period, so the contingency fee is zero');
  }
  if (plan && basis === 'attributed' && events.some((e) => e.attribution_basis === 'manual')) {
    warnings.push(
      'some recovery in this period was matched by hand; it is billed under the '
      + '"attributed" basis — switch the plan to "verified" if only human-confirmed '
      + 'recovery should be charged');
  }

  return {
    month, periodStart, periodEnd, plan,
    claimsProcessed: usage.rows[0].claims,
    casesCreated,
    amountRecovered: r2(num(usage.rows[0].recovered)),
    attributedRecovery,
    baseFee, caseFeeTotal, contingencyPercent, contingencyFee,
    minimumApplied, maximumApplied, amountDue, warnings,
    lines: events.map((e) => ({
      paymentEventId: e.payment_event_id,
      caseId: e.case_id,
      claimId: e.claim_id,
      claimNumber: e.claim_number_internal,
      payerName: e.payer_name,
      paymentDate: iso(e.payment_date),
      amountRecovered: r2(num(e.amount_recovered)),
      fee: r2(Math.max(0, num(e.amount_recovered)) * (contingencyPercent / 100)),
      attributionBasis: e.attribution_basis,
    })),
  };
}

/**
 * Create or refresh the DRAFT invoice for a month. An invoice that has already
 * been issued is never touched — the database enforces that too; this is the
 * readable error rather than a trigger exception.
 */
export async function generateInvoice(
  db: Queryable, sess: Session, s: Scope, clientId: UUID, month: string,
) {
  requireAnyAdmin(sess);
  assertClientAccess(sess, s, clientId);
  const computed = await computeInvoice(db, s.tenantId, clientId, month);

  // A voided invoice is history, not an obstacle: the period is re-invoiceable
  // and its released recoveries are billable again.
  const existing = await db.query(
    `SELECT invoice_id, status FROM invoice
     WHERE client_id = $1 AND period_start = $2::date AND status <> 'void'`,
    [clientId, computed.periodStart]);
  if (existing.rows[0] && existing.rows[0].status !== 'draft') {
    throw err(
      `invoice for ${month} has already been ${existing.rows[0].status}; `
      + 'issue a credit note instead of regenerating it', 409);
  }

  const invoiceId: UUID = existing.rows[0]?.invoice_id ?? (await db.query(
    `INSERT INTO invoice (tenant_id, client_id, period_start, period_end, plan, status)
     VALUES ($1, $2, $3::date, $4::date, $5, 'draft') RETURNING invoice_id`,
    [s.tenantId, clientId, computed.periodStart, computed.periodEnd,
     computed.plan?.planName ?? 'unpriced'])).rows[0].invoice_id;

  await db.query(
    `UPDATE invoice SET
       period_end = $2::date, plan = $3, pricing_plan_id = $4,
       claims_processed = $5, cases_created = $6, amount_recovered = $7,
       attributed_recovery = $8, base_fee = $9, case_fee_total = $10,
       contingency_percent = $11, contingency_fee = $12,
       minimum_applied = $13, maximum_applied = $14, amount_due = $15
     WHERE invoice_id = $1`,
    [invoiceId, computed.periodEnd, computed.plan?.planName ?? 'unpriced',
     computed.plan?.pricingPlanId ?? null,
     computed.claimsProcessed, computed.casesCreated, computed.amountRecovered,
     computed.attributedRecovery, computed.baseFee, computed.caseFeeTotal,
     computed.contingencyPercent, computed.contingencyFee,
     computed.minimumApplied, computed.maximumApplied, computed.amountDue]);

  // Rebuild the draft's lines from scratch; the unique index on
  // payment_event_id guarantees nothing already billed can be pulled in.
  await db.query(`DELETE FROM invoice_line WHERE invoice_id = $1`, [invoiceId]);
  for (const line of computed.lines) {
    await db.query(
      `INSERT INTO invoice_line
         (tenant_id, invoice_id, payment_event_id, case_id, claim_id, claim_number,
          payer_name, payment_date, amount_recovered, contingency_percent, fee,
          attribution_basis)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12)`,
      [s.tenantId, invoiceId, line.paymentEventId, line.caseId, line.claimId,
       line.claimNumber, line.payerName, line.paymentDate, line.amountRecovered,
       computed.contingencyPercent, line.fee, line.attributionBasis]);
  }

  await adminAudit(db, sess, 'invoice_generated', 'invoice', invoiceId, {
    clientId, month, amountDue: computed.amountDue,
    attributedRecovery: computed.attributedRecovery,
    contingencyPercent: computed.contingencyPercent,
    lines: computed.lines.length,
  });
  return { ok: true as const, invoiceId, ...computed };
}

/** Issue a draft. After this the figures are frozen and a number is assigned. */
export async function issueInvoice(
  db: Queryable, sess: Session, s: Scope, invoiceId: UUID,
) {
  requireTenantAdmin(sess);
  const row = await db.query(
    `SELECT client_id, status, period_start FROM invoice
     WHERE invoice_id = $1 AND tenant_id = $2`, [invoiceId, s.tenantId]);
  if (!row.rows[0]) throw err('invoice not found', 404);
  assertClientAccess(sess, s, row.rows[0].client_id);
  if (row.rows[0].status !== 'draft') {
    throw err(`invoice is already ${row.rows[0].status}`, 409);
  }

  const seq = await db.query(
    `SELECT count(*)::int + 1 AS n FROM invoice
     WHERE tenant_id = $1 AND invoice_number IS NOT NULL`, [s.tenantId]);
  const invoiceNumber = `INV-${String(iso(row.rows[0].period_start)).slice(0, 7).replace('-', '')}`
    + `-${String(seq.rows[0].n).padStart(5, '0')}`;

  await db.query(
    `UPDATE invoice SET status = 'issued', issued_at = now(), invoice_number = $2
     WHERE invoice_id = $1`, [invoiceId, invoiceNumber]);
  await adminAudit(db, sess, 'invoice_issued', 'invoice', invoiceId, { invoiceNumber });
  return { ok: true as const, invoiceId, invoiceNumber };
}

/** Void an issued invoice. Its lines are released so the recoveries can be
 * billed again on a corrected invoice. */
export async function voidInvoice(
  db: Queryable, sess: Session, s: Scope, invoiceId: UUID, reason: string,
) {
  requireTenantAdmin(sess);
  if (!reason?.trim()) throw err('a reason is required to void an invoice', 400);
  const row = await db.query(
    `SELECT client_id, status FROM invoice WHERE invoice_id = $1 AND tenant_id = $2`,
    [invoiceId, s.tenantId]);
  if (!row.rows[0]) throw err('invoice not found', 404);
  assertClientAccess(sess, s, row.rows[0].client_id);
  if (row.rows[0].status === 'void') throw err('invoice is already void', 409);

  await db.query(
    `UPDATE invoice SET status = 'void', voided_at = now(), voided_reason = $2
     WHERE invoice_id = $1`, [invoiceId, reason.trim()]);
  await db.query(`DELETE FROM invoice_line WHERE invoice_id = $1`, [invoiceId]);
  await adminAudit(db, sess, 'invoice_voided', 'invoice', invoiceId, { reason: reason.trim() });
  return { ok: true as const, invoiceId };
}

export async function invoiceDetail(
  db: Queryable, sess: Session, s: Scope, invoiceId: UUID,
) {
  requireAnyAdmin(sess);
  const inv = await db.query(
    `SELECT invoice_id, client_id, invoice_number, period_start, period_end, plan,
            claims_processed, cases_created, amount_recovered, attributed_recovery,
            base_fee, case_fee_total, contingency_percent, contingency_fee,
            minimum_applied, maximum_applied, amount_due, status,
            issued_at, voided_at, voided_reason
     FROM invoice WHERE invoice_id = $1 AND tenant_id = $2`, [invoiceId, s.tenantId]);
  if (!inv.rows[0]) throw err('invoice not found', 404);
  assertClientAccess(sess, s, inv.rows[0].client_id);
  const lines = await db.query(
    `SELECT payment_event_id, case_id, claim_number, payer_name, payment_date,
            amount_recovered, contingency_percent, fee, attribution_basis
     FROM invoice_line WHERE invoice_id = $1 ORDER BY payment_date, claim_number`,
    [invoiceId]);
  const i = inv.rows[0];
  return {
    invoiceId: i.invoice_id,
    invoiceNumber: i.invoice_number,
    clientId: i.client_id,
    periodStart: iso(i.period_start), periodEnd: iso(i.period_end),
    plan: i.plan, status: i.status,
    claimsProcessed: i.claims_processed, casesCreated: i.cases_created,
    amountRecovered: r2(num(i.amount_recovered)),
    attributedRecovery: r2(num(i.attributed_recovery)),
    baseFee: r2(num(i.base_fee)),
    caseFeeTotal: r2(num(i.case_fee_total)),
    contingencyPercent: num(i.contingency_percent),
    contingencyFee: r2(num(i.contingency_fee)),
    minimumApplied: i.minimum_applied, maximumApplied: i.maximum_applied,
    amountDue: r2(num(i.amount_due)),
    issuedAt: i.issued_at, voidedAt: i.voided_at, voidedReason: i.voided_reason,
    lines: lines.rows.map((l) => ({
      paymentEventId: l.payment_event_id, caseId: l.case_id,
      claimNumber: l.claim_number, payerName: l.payer_name,
      paymentDate: iso(l.payment_date),
      amountRecovered: r2(num(l.amount_recovered)),
      contingencyPercent: num(l.contingency_percent),
      fee: r2(num(l.fee)),
      attributionBasis: l.attribution_basis,
    })),
  };
}
