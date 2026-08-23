// ============================================================================
// USAGE LEDGER
//
// Invoices used to be computed from payment_event at the moment they were
// generated. payment_event is a live operational table — reconciliation
// revises it, a clawback lands on it, an operator corrects a bad match — so
// the evidence behind a bill that had already gone out could move underneath
// it. Freezing the invoice totals stopped the bill changing; it did not make
// the bill reproducible, and "here is the number we charged" is a much weaker
// answer to a disputing customer than "here are the forty payments, as they
// stood on the day we billed them".
//
// usage_event is that record: written once per billable fact with the figures
// as they were, never amended (the database enforces it), and carrying enough
// detail in `detail` to re-derive the amount without the operational tables at
// all. The only thing that ever changes on a row is which invoice claimed it.
//
// The sync is deliberately a scan-and-append rather than a write on every path
// that touches payment_event. Reconciliation, a manual match in the ops UI, a
// backfill and a correction all end up as payment_event rows; making each of
// them remember to write the ledger too is how ledgers end up incomplete. One
// idempotent pass, guarded by a unique index, cannot miss and cannot double.
// ============================================================================

import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';

export interface LedgerSyncResult {
  appended: number;
}

/**
 * Append a ledger row for every payment_event that does not have one yet.
 *
 * Safe to call as often as you like: the unique index on
 * usage_event.payment_event_id means a concurrent second run can only fail to
 * insert, never write a duplicate.
 */
export async function syncUsageLedger(
  db: Queryable, tenantId: UUID, clientId?: UUID | null,
): Promise<LedgerSyncResult> {
  const res = await db.query(
    `INSERT INTO usage_event
       (tenant_id, client_id, event_type, occurred_at, amount, case_id, claim_id,
        claim_line_id, payment_event_id, attribution_basis, attribution_scope, detail)
     SELECT
       pe.tenant_id,
       rc.client_id,
       CASE WHEN pe.amount_recovered < 0
            THEN 'recovery_clawed_back' ELSE 'recovery_attributed' END,
       COALESCE(pe.payment_date, pe.created_at::date),
       pe.amount_recovered,
       pe.case_id, pe.claim_id, pe.claim_line_id, pe.payment_event_id,
       pe.attribution_basis, pe.attribution_scope,
       jsonb_strip_nulls(jsonb_build_object(
         'claimNumber',          cl.claim_number_internal,
         'payerName',            py.payer_name,
         'caseType',             rc.case_type::text,
         'matchedAutomatically', pe.matched_automatically,
         'preAppealPaid',        pe.pre_appeal_paid,
         'grossPostAppealPaid',  pe.gross_post_appeal_paid,
         'unallocatedPaid',      pe.unallocated_paid,
         'reversalsNetted',      pe.reversals_netted,
         'recoupmentsNetted',    pe.recoupments_netted,
         'remittanceId',         pe.remittance_id,
         'notes',                pe.notes
       ))
     FROM payment_event pe
     JOIN recovery_case rc ON rc.case_id = pe.case_id
     JOIN claim cl         ON cl.claim_id = pe.claim_id
     JOIN payer py         ON py.payer_id = cl.payer_id
     WHERE pe.tenant_id = $1
       AND ($2::uuid IS NULL OR rc.client_id = $2)
       AND NOT EXISTS (
         SELECT 1 FROM usage_event ue WHERE ue.payment_event_id = pe.payment_event_id)
     ON CONFLICT (payment_event_id) WHERE payment_event_id IS NOT NULL DO NOTHING`,
    [tenantId, clientId ?? null]);
  return { appended: (res as { rowCount?: number }).rowCount ?? 0 };
}

export interface LedgerRow {
  usageEventId: UUID;
  eventType: 'recovery_attributed' | 'recovery_clawed_back';
  occurredAt: string;
  recordedAt: string;
  amount: number;
  caseId: UUID | null;
  claimId: UUID | null;
  claimNumber: string | null;
  payerName: string | null;
  paymentEventId: UUID | null;
  attributionBasis: string | null;
  attributionScope: string | null;
  invoiceId: UUID | null;
  invoiceNumber: string | null;
  detail: Record<string, unknown>;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const iso = (d: unknown): string | null =>
  (d == null ? null : new Date(d as string).toISOString().slice(0, 10));

function toLedgerRow(r: any): LedgerRow {
  const detail = r.detail ?? {};
  return {
    usageEventId: r.usage_event_id,
    eventType: r.event_type,
    occurredAt: iso(r.occurred_at)!,
    recordedAt: r.recorded_at,
    amount: r2(num(r.amount)),
    caseId: r.case_id,
    claimId: r.claim_id,
    claimNumber: detail.claimNumber ?? null,
    payerName: detail.payerName ?? null,
    paymentEventId: r.payment_event_id,
    attributionBasis: r.attribution_basis,
    attributionScope: r.attribution_scope,
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoice_number ?? null,
    detail,
  };
}

/**
 * The ledger rows an invoice was built from, read back from the ledger rather
 * than recomputed. This is the answer to "show me what I am paying for" a year
 * after the operational tables have moved on.
 */
export async function invoiceLedger(
  db: Queryable, tenantId: UUID, invoiceId: UUID,
): Promise<LedgerRow[]> {
  const rows = await db.query(
    `SELECT ue.*, i.invoice_number
     FROM usage_event ue
     LEFT JOIN invoice i ON i.invoice_id = ue.invoice_id
     WHERE ue.tenant_id = $1 AND ue.invoice_id = $2
     ORDER BY ue.occurred_at, ue.recorded_at`,
    [tenantId, invoiceId]);
  return rows.rows.map(toLedgerRow);
}

/** A client's ledger, most recent first. Unbilled rows carry no invoice. */
export async function clientLedger(
  db: Queryable, tenantId: UUID, clientId: UUID,
  opts: { from?: string; to?: string; unbilledOnly?: boolean; limit?: number } = {},
): Promise<LedgerRow[]> {
  const rows = await db.query(
    `SELECT ue.*, i.invoice_number
     FROM usage_event ue
     LEFT JOIN invoice i ON i.invoice_id = ue.invoice_id
     WHERE ue.tenant_id = $1 AND ue.client_id = $2
       AND ($3::date IS NULL OR ue.occurred_at >= $3::date)
       AND ($4::date IS NULL OR ue.occurred_at <= $4::date)
       AND ($5::boolean IS NOT TRUE OR ue.invoice_id IS NULL)
     ORDER BY ue.occurred_at DESC, ue.recorded_at DESC
     LIMIT $6`,
    [tenantId, clientId, opts.from ?? null, opts.to ?? null,
     opts.unbilledOnly ?? false, Math.min(opts.limit ?? 200, 1000)]);
  return rows.rows.map(toLedgerRow);
}
