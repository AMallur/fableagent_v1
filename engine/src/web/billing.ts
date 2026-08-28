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
import { clientLedger, invoiceLedger, syncUsageLedger } from './usage_ledger.ts';
import { canTransact, withTenantTransaction, type Connectable } from '../db/tx.ts';

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
const DATE_MONTH = /^\d{4}-\d{2}$/;

/**
 * Run a money-moving sequence atomically.
 *
 * Every production caller passes a real pool, so the transaction is real. A
 * few tests and internal callers hand in a bare Queryable; rather than fail
 * closed on them, this degrades to running the body directly — which is what
 * the code did before transactions existed. The distinction is explicit here
 * so nobody mistakes the fallback for the guarantee.
 */
async function inTenantTransaction<T>(
  db: Queryable, tenantId: UUID, fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (canTransact(db)) return withTenantTransaction(db as Connectable, tenantId, fn);
  return fn(db);
}

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
 * Recoveries in the period that have never been billed, read from the
 * append-only ledger rather than from payment_event.
 *
 * The amount comes from the ledger, frozen as it stood when the fact was
 * recorded, so a later correction to the operational row cannot silently
 * change what a customer was charged. Verification is the one thing still read
 * live: whether a person has confirmed a payment is a condition on billing it,
 * not a billable fact, and it can legitimately become true after the ledger
 * row was written.
 *
 * Negative events (a payer clawing money back) are included so a takeback
 * reduces the next bill rather than being quietly kept.
 */
async function billableRecoveries(
  db: Queryable, tenantId: UUID, clientId: UUID,
  periodStart: string, periodEnd: string, basis: 'attributed' | 'verified',
  /** Rows already claimed by THIS invoice count as available: they are what
   * it is being rebuilt from. Without it, previewing or regenerating a month
   * that already has a draft would report nothing billable. */
  forInvoiceId?: UUID | null,
) {
  const verifiedOnly = basis === 'verified';
  const rows = await db.query(
    `SELECT ue.usage_event_id, ue.payment_event_id, ue.case_id, ue.claim_id,
            ue.amount AS amount_recovered, ue.occurred_at AS payment_date,
            ue.attribution_basis, ue.detail
     FROM usage_event ue
     LEFT JOIN payment_event pe ON pe.payment_event_id = ue.payment_event_id
     WHERE ue.tenant_id = $1 AND ue.client_id = $2
       AND ue.occurred_at >= $3::date AND ue.occurred_at <= $4::date
       AND (ue.invoice_id IS NULL OR ue.invoice_id = $6::uuid)
       AND ($5::boolean IS NOT TRUE OR pe.verified_by_user_id IS NOT NULL)
     ORDER BY ue.occurred_at, ue.recorded_at`,
    [tenantId, clientId, periodStart, periodEnd, verifiedOnly, forInvoiceId ?? null]);
  return rows.rows;
}

export async function previewInvoice(
  db: Queryable, sess: Session, s: Scope, clientId: UUID, month: string,
) {
  requireAnyAdmin(sess);
  assertClientAccess(sess, s, clientId);
  // A preview has to say what generating would produce. If a draft for this
  // month already holds ledger rows, they are still this month's recoveries,
  // so the preview counts them rather than reporting an empty bill.
  if (!/^\d{4}-\d{2}$/.test(month)) throw err('month must be YYYY-MM', 400);
  const draft = await db.query(
    `SELECT invoice_id FROM invoice
     WHERE client_id = $1 AND period_start = $2::date AND status = 'draft'`,
    [clientId, `${month}-01`]);
  return computeInvoice(
    db, s.tenantId, clientId, month, draft.rows[0]?.invoice_id ?? null);
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
    usageEventId: UUID; paymentEventId: UUID | null; caseId: UUID; claimId: UUID;
    claimNumber: string | null; payerName: string | null;
    paymentDate: string | null; amountRecovered: number;
    fee: number; attributionBasis: string | null;
  }>;
}

async function computeInvoice(
  db: Queryable, tenantId: UUID, clientId: UUID, month: string,
  forInvoiceId?: UUID | null,
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

  // Bring the ledger up to date before reading it, so a payment reconciled or
  // matched by hand since the last run is billable now rather than next month.
  await syncUsageLedger(db, tenantId, clientId);

  const basis = plan?.contingencyBasis ?? 'attributed';
  const events = await billableRecoveries(
    db, tenantId, clientId, periodStart, periodEnd, basis, forInvoiceId);
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
      usageEventId: e.usage_event_id,
      paymentEventId: e.payment_event_id,
      caseId: e.case_id,
      claimId: e.claim_id,
      claimNumber: e.detail?.claimNumber ?? null,
      payerName: e.detail?.payerName ?? null,
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
 *
 * Every write runs in ONE transaction. Releasing this draft's ledger rows and
 * re-claiming them are two halves of a single act: a failure in between would
 * leave the invoice asserting totals for recoveries the ledger shows as
 * unbilled, and the next period would bill the customer for them a second
 * time. That is the one outcome a bill-once ledger may never produce.
 */
export async function generateInvoice(
  db: Queryable, sess: Session, s: Scope, clientId: UUID, month: string,
) {
  requireAnyAdmin(sess);
  assertClientAccess(sess, s, clientId);
  if (!DATE_MONTH.test(month)) throw err('month must be YYYY-MM', 400);
  const periodStart = `${month}-01`;

  // A voided invoice is history, not an obstacle: the period is re-invoiceable
  // and its released recoveries are billable again.
  const existing = await db.query(
    `SELECT invoice_id, status FROM invoice
     WHERE client_id = $1 AND period_start = $2::date AND status <> 'void'`,
    [clientId, periodStart]);
  if (existing.rows[0] && existing.rows[0].status !== 'draft') {
    throw err(
      `invoice for ${month} has already been ${existing.rows[0].status}; `
      + 'issue a credit note instead of regenerating it', 409);
  }

  // Rows this draft already holds are still billable BY THIS DRAFT — they are
  // what it is being rebuilt from. Treating them as billed would exclude
  // exactly the recoveries the invoice is for and rebuild it as an empty bill.
  // Rows held by any other invoice stay held and cannot be pulled in.
  const draftId: UUID | null = existing.rows[0]?.invoice_id ?? null;
  const computed = await computeInvoice(db, s.tenantId, clientId, month, draftId);

  const invoiceId: UUID = await inTenantTransaction(db, s.tenantId, async (tx) => {
    const id: UUID = draftId ?? (await tx.query(
      `INSERT INTO invoice (tenant_id, client_id, period_start, period_end, plan, status)
       VALUES ($1, $2, $3::date, $4::date, $5, 'draft') RETURNING invoice_id`,
      [s.tenantId, clientId, computed.periodStart, computed.periodEnd,
       computed.plan?.planName ?? 'unpriced'])).rows[0].invoice_id;

    await tx.query(
      `UPDATE invoice SET
         period_end = $2::date, plan = $3, pricing_plan_id = $4,
         claims_processed = $5, cases_created = $6, amount_recovered = $7,
         attributed_recovery = $8, base_fee = $9, case_fee_total = $10,
         contingency_percent = $11, contingency_fee = $12,
         minimum_applied = $13, maximum_applied = $14, amount_due = $15
       WHERE invoice_id = $1`,
      [id, computed.periodEnd, computed.plan?.planName ?? 'unpriced',
       computed.plan?.pricingPlanId ?? null,
       computed.claimsProcessed, computed.casesCreated, computed.amountRecovered,
       computed.attributedRecovery, computed.baseFee, computed.caseFeeTotal,
       computed.contingencyPercent, computed.contingencyFee,
       computed.minimumApplied, computed.maximumApplied, computed.amountDue]);

    // Rebuild the draft's lines from scratch. Releasing everything it held
    // first means a recovery that is no longer billable — its event
    // superseded, its period moved — is let go rather than left claimed by an
    // invoice that no longer charges for it.
    await tx.query(`DELETE FROM invoice_line WHERE invoice_id = $1`, [id]);
    await tx.query(
      `UPDATE usage_event SET invoice_id = NULL WHERE invoice_id = $1 AND tenant_id = $2`,
      [id, s.tenantId]);

    for (const line of computed.lines) {
      // Claim the ledger row for this invoice. The database refuses to move a
      // row another invoice already holds, so two overlapping generations
      // cannot bill the same recovery twice.
      const claimed = await tx.query(
        `UPDATE usage_event SET invoice_id = $1
         WHERE usage_event_id = $2 AND tenant_id = $3 AND invoice_id IS NULL
         RETURNING usage_event_id`,
        [id, line.usageEventId, s.tenantId]);
      if (claimed.rows.length === 0) {
        // Another invoice took it between the read and the write. Abort the
        // whole bill rather than issue one that silently omits a line.
        throw err(
          `recovery ${line.usageEventId} was claimed by another invoice while this `
          + 'one was being generated; regenerate to pick up the current position', 409);
      }
      await tx.query(
        `INSERT INTO invoice_line
           (tenant_id, invoice_id, usage_event_id, payment_event_id, case_id, claim_id,
            claim_number, payer_name, payment_date, amount_recovered,
            contingency_percent, fee, attribution_basis)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13)`,
        [s.tenantId, id, line.usageEventId, line.paymentEventId, line.caseId,
         line.claimId, line.claimNumber, line.payerName, line.paymentDate,
         line.amountRecovered, computed.contingencyPercent, line.fee,
         line.attributionBasis]);
    }
    return id;
  });

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
    `SELECT i.client_id, i.status, i.period_start, i.pricing_plan_id, i.amount_due,
            c.operating_mode, c.client_name,
            pp.agreement_reference
     FROM invoice i
     JOIN client c ON c.tenant_id = i.tenant_id AND c.client_id = i.client_id
     LEFT JOIN pricing_plan pp ON pp.pricing_plan_id = i.pricing_plan_id
     WHERE i.invoice_id = $1 AND i.tenant_id = $2`, [invoiceId, s.tenantId]);
  if (!row.rows[0]) throw err('invoice not found', 404);
  assertClientAccess(sess, s, row.rows[0].client_id);

  // Two commercial gates, both deliberately at ISSUE rather than at generate:
  // computing what a bill would be is useful during a pilot, but sending one
  // is the irreversible act.
  if (row.rows[0].operating_mode !== 'live') {
    throw err(
      `${row.rows[0].client_name} is in shadow mode; an invoice cannot be issued until the `
      + 'client is cleared for live operation', 409);
  }
  if (Number(row.rows[0].amount_due) > 0 && !row.rows[0].agreement_reference) {
    throw err(
      'the pricing plan behind this invoice names no executed agreement; record the order '
      + 'form or amendment reference before charging against recovered cash', 409);
  }

  if (row.rows[0].status !== 'draft') {
    throw err(`invoice is already ${row.rows[0].status}`, 409);
  }

  // Reading the sequence and consuming it must not be separable: two issues
  // racing would otherwise compute the same number, and the unique index would
  // reject one of them after its status had already moved to issued.
  const invoiceNumber: string = await inTenantTransaction(db, s.tenantId, async (tx) => {
    const seq = await tx.query(
      `SELECT count(*)::int + 1 AS n FROM invoice
       WHERE tenant_id = $1 AND invoice_number IS NOT NULL`, [s.tenantId]);
    const number = `INV-${String(iso(row.rows[0].period_start)).slice(0, 7).replace('-', '')}`
      + `-${String(seq.rows[0].n).padStart(5, '0')}`;
    await tx.query(
      `UPDATE invoice SET status = 'issued', issued_at = now(), invoice_number = $2
       WHERE invoice_id = $1`, [invoiceId, number]);
    return number;
  });
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

  // One transaction: voiding the bill and releasing what it held are the same
  // act. Half of it would leave recoveries claimed by a dead invoice and so
  // permanently unbillable — the mirror image of double-billing, and just as
  // wrong.
  await inTenantTransaction(db, s.tenantId, async (tx) => {
    await tx.query(
      `UPDATE invoice SET status = 'void', voided_at = now(), voided_reason = $2
       WHERE invoice_id = $1`, [invoiceId, reason.trim()]);
    // The invoice row keeps its frozen totals as the record of what was
    // charged; its LINES go, and the ledger rows they held are released so a
    // corrected invoice can bill the same recoveries. The ledger itself is
    // untouched — nothing that happened stops having happened because a bill
    // was wrong.
    await tx.query(`DELETE FROM invoice_line WHERE invoice_id = $1`, [invoiceId]);
    await tx.query(
      `UPDATE usage_event SET invoice_id = NULL WHERE invoice_id = $1 AND tenant_id = $2`,
      [invoiceId, s.tenantId]);
  });
  await adminAudit(db, sess, 'invoice_voided', 'invoice', invoiceId, { reason: reason.trim() });
  return { ok: true as const, invoiceId };
}

/**
 * A client's billable history straight from the ledger — including what has
 * not been invoiced yet. This is what an operator opens when a customer asks
 * why a bill is what it is, and it answers from the frozen record rather than
 * by recomputing today's view of the same events.
 */
export async function clientUsageLedger(
  db: Queryable, sess: Session, s: Scope, clientId: UUID,
  opts: { from?: string; to?: string; unbilledOnly?: boolean; limit?: number } = {},
) {
  requireAnyAdmin(sess);
  assertClientAccess(sess, s, clientId);
  for (const [name, value] of [['from', opts.from], ['to', opts.to]] as const) {
    if (value && !DATE.test(value)) throw err(`${name} must be YYYY-MM-DD`, 400);
  }
  await syncUsageLedger(db, s.tenantId, clientId);
  const rows = await clientLedger(db, s.tenantId, clientId, opts);
  const billed = rows.filter((r) => r.invoiceId != null);
  const unbilled = rows.filter((r) => r.invoiceId == null);
  return {
    clientId,
    events: rows,
    totals: {
      billed: r2(billed.reduce((t, r) => t + r.amount, 0)),
      unbilled: r2(unbilled.reduce((t, r) => t + r.amount, 0)),
    },
  };
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
    `SELECT usage_event_id, payment_event_id, case_id, claim_number, payer_name,
            payment_date, amount_recovered, contingency_percent, fee, attribution_basis
     FROM invoice_line WHERE invoice_id = $1 ORDER BY payment_date, claim_number`,
    [invoiceId]);
  // The append-only evidence behind the bill, as it stood when it was billed.
  const ledger = await invoiceLedger(db, s.tenantId, invoiceId);
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
    ledger,
    lines: lines.rows.map((l) => ({
      usageEventId: l.usage_event_id,
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
