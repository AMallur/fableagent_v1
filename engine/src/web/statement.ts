// ============================================================================
// STATEMENTS AND AUDIT EVIDENCE
//
// Two documents that leave the building, both built from frozen records rather
// than recomputed at the moment they are asked for.
//
//   STATEMENT — what the clinic's practice manager receives. A contingency
//   invoice is a claim on money the provider already has, so it has to be
//   auditable against their own remittances without a phone call: every line
//   names the claim, the payer, the check date, what moved, and how the fee on
//   it was derived. Rendered as self-contained HTML because that is what
//   survives being forwarded, printed and attached to an email; no external
//   assets, so nothing breaks behind a hospital firewall.
//
//   EVIDENCE PACK — what an auditor, a payer, or the customer's finance team
//   is given when they ask the platform to prove itself. It is deliberately
//   machine-readable and content-addressed: the ledger as it stood, the audit
//   trail for the period, the configuration in force, and a SHA-256 over the
//   whole thing so a later copy can be shown to be the same document.
//
// Neither invents a number. Both read the invoice, the ledger and the audit
// log, and where something cannot be evidenced they say so rather than
// leaving a confident blank.
// ============================================================================

import { createHash } from 'node:crypto';
import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';
import type { Session } from './auth.ts';
import type { Scope } from './queries.ts';
import { adminAudit, assertClientAccess, err, requireAnyAdmin } from './admin_api.ts';
import { invoiceLedger } from './usage_ledger.ts';

const money = (n: unknown): string =>
  `$${Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (v: unknown): string =>
  (v == null ? '—' : new Date(v as string).toISOString().slice(0, 10));
const esc = (v: unknown): string => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export interface StatementResult {
  invoiceId: UUID;
  invoiceNumber: string | null;
  status: string;
  html: string;
}

/**
 * Render the statement a customer receives for one invoice.
 *
 * A draft renders too — an operator should be able to see exactly what would
 * go out before it does — but it is watermarked as a draft so a forwarded copy
 * cannot be mistaken for a bill.
 */
export async function renderStatement(
  db: Queryable, sess: Session, s: Scope, invoiceId: UUID,
): Promise<StatementResult> {
  requireAnyAdmin(sess);

  const inv = await db.query(
    `SELECT i.*, c.client_name, c.address AS client_address, c.npi_group,
            t.tenant_name,
            pp.plan_name, pp.agreement_reference, pp.agreement_executed_on,
            pp.contingency_basis, pp.agreed_attribution_basis
     FROM invoice i
     JOIN client c ON c.tenant_id = i.tenant_id AND c.client_id = i.client_id
     JOIN tenant t ON t.tenant_id = i.tenant_id
     LEFT JOIN pricing_plan pp ON pp.pricing_plan_id = i.pricing_plan_id
     WHERE i.invoice_id = $1 AND i.tenant_id = $2`, [invoiceId, s.tenantId]);
  if (!inv.rows[0]) throw err('invoice not found', 404);
  const i = inv.rows[0];
  assertClientAccess(sess, s, i.client_id);

  const lines = await db.query(
    `SELECT claim_number, payer_name, payment_date, amount_recovered,
            contingency_percent, fee, attribution_basis
     FROM invoice_line WHERE invoice_id = $1
     ORDER BY payment_date NULLS LAST, claim_number`, [invoiceId]);

  const draft = i.status === 'draft';
  const voided = i.status === 'void';

  const rows = lines.rows.length === 0
    ? `<tr><td colspan="5" class="empty">No recovery was attributed in this period.</td></tr>`
    : lines.rows.map((l) => `<tr>
        <td>${esc(l.claim_number ?? '—')}</td>
        <td>${esc(l.payer_name ?? '—')}</td>
        <td>${day(l.payment_date)}</td>
        <td class="num${Number(l.amount_recovered) < 0 ? ' neg' : ''}">${money(l.amount_recovered)}</td>
        <td class="num">${money(l.fee)}</td>
      </tr>`).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(i.invoice_number ?? 'Draft statement')} — ${esc(i.client_name)}</title>
<style>
  :root{--ink:#16191b;--ink2:#555c61;--rule:#d8dde0;--accent:#1c4f5b;--neg:#98332a;--paper:#fff}
  *{box-sizing:border-box}
  body{margin:0;background:#f2f4f5;color:var(--ink);
       font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  .sheet{max-width:760px;margin:24px auto;background:var(--paper);padding:40px 44px;
         border:1px solid var(--rule)}
  .banner{padding:9px 14px;margin-bottom:26px;font-weight:600;font-size:.86rem;
          letter-spacing:.03em;text-transform:uppercase}
  .banner.draft{background:#fdf3d8;color:#6d5310;border:1px solid #e3cd8c}
  .banner.void{background:#fbe8e5;color:#8d2f26;border:1px solid #e0b3ac}
  header{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;
         padding-bottom:20px;border-bottom:2px solid var(--ink)}
  h1{margin:0 0 4px;font-size:1.5rem;letter-spacing:-.01em}
  .from{font-size:.9rem;color:var(--ink2)}
  .idblock{text-align:right;font-size:.88rem;color:var(--ink2)}
  .idblock b{display:block;color:var(--ink);font-size:1.02rem;
             font-variant-numeric:tabular-nums}
  .to{margin:22px 0 6px;font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;
      color:var(--ink2)}
  .party{font-size:1.05rem;font-weight:600}
  .party span{display:block;font-weight:400;font-size:.9rem;color:var(--ink2)}
  table{width:100%;border-collapse:collapse;margin-top:26px;font-size:.92rem}
  th{text-align:left;font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;
     color:var(--ink2);font-weight:600;padding:8px 10px;border-bottom:1.5px solid var(--ink)}
  td{padding:9px 10px;border-bottom:1px solid var(--rule);vertical-align:top}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .neg{color:var(--neg)}
  .empty{color:var(--ink2);font-style:italic;text-align:center;padding:22px}
  .totals{margin-top:22px;margin-left:auto;width:min(360px,100%)}
  .totals div{display:flex;justify-content:space-between;gap:16px;padding:6px 10px}
  .totals .due{border-top:2px solid var(--ink);margin-top:6px;padding-top:11px;
               font-size:1.16rem;font-weight:700}
  .totals .num{font-variant-numeric:tabular-nums}
  .basis{margin-top:34px;padding:16px 18px;background:#f7f9f9;border:1px solid var(--rule);
         font-size:.86rem;color:var(--ink2)}
  .basis h2{margin:0 0 8px;font-size:.76rem;letter-spacing:.09em;text-transform:uppercase;
            color:var(--ink)}
  .basis dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 14px}
  .basis dt{color:var(--ink);font-weight:600}
  .basis dd{margin:0}
  footer{margin-top:30px;padding-top:14px;border-top:1px solid var(--rule);
         font-size:.8rem;color:var(--ink2)}
  @media print{body{background:#fff}.sheet{border:none;margin:0;padding:0}}
</style></head><body>
<div class="sheet">
${draft ? '<div class="banner draft">Draft — not a bill</div>' : ''}
${voided ? `<div class="banner void">Voided${i.voided_reason ? `: ${esc(i.voided_reason)}` : ''}</div>` : ''}
  <header>
    <div>
      <h1>${esc(i.tenant_name)}</h1>
      <div class="from">Recovery services statement</div>
    </div>
    <div class="idblock">
      <b>${esc(i.invoice_number ?? 'DRAFT')}</b>
      Period ${day(i.period_start)} – ${day(i.period_end)}<br>
      ${i.issued_at ? `Issued ${day(i.issued_at)}` : 'Not yet issued'}
    </div>
  </header>

  <div class="to">Billed to</div>
  <div class="party">${esc(i.client_name)}
    <span>${i.npi_group ? `Group NPI ${esc(i.npi_group)}` : ''}</span>
  </div>

  <table>
    <thead><tr>
      <th>Claim</th><th>Payer</th><th>Payment date</th>
      <th class="num">Recovered</th><th class="num">Fee</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals">
    <div><span>Recovery attributed</span><span class="num">${money(i.attributed_recovery)}</span></div>
    <div><span>Contingency @ ${Number(i.contingency_percent)}%</span><span class="num">${money(i.contingency_fee)}</span></div>
    ${Number(i.base_fee) > 0 ? `<div><span>Platform fee</span><span class="num">${money(i.base_fee)}</span></div>` : ''}
    ${Number(i.case_fee_total) > 0 ? `<div><span>Case fees</span><span class="num">${money(i.case_fee_total)}</span></div>` : ''}
    ${i.minimum_applied ? '<div><span>Adjusted to contract minimum</span><span class="num">—</span></div>' : ''}
    ${i.maximum_applied ? '<div><span>Capped at contract maximum</span><span class="num">—</span></div>' : ''}
    <div class="due"><span>Amount due</span><span class="num">${money(i.amount_due)}</span></div>
  </div>

  <div class="basis">
    <h2>How this was calculated</h2>
    <dl>
      <dt>Agreement</dt><dd>${i.agreement_reference
        ? `${esc(i.agreement_reference)}${i.agreement_executed_on ? `, executed ${day(i.agreement_executed_on)}` : ''}`
        : 'not recorded'}</dd>
      <dt>Plan</dt><dd>${esc(i.plan_name ?? i.plan ?? 'unpriced')}</dd>
      <dt>Charged on</dt><dd>${i.contingency_basis === 'verified'
        ? 'recovery confirmed by a person'
        : 'recovery the platform attributed and can evidence line by line'}</dd>
      <dt>Attribution</dt><dd>${(i.agreed_attribution_basis ?? 'incremental_net') === 'gross_post_appeal'
        ? 'every dollar paid after the appeal was submitted'
        : 'the incremental movement after the appeal, net of anything the payer reversed or recouped'}</dd>
    </dl>
    <p style="margin:12px 0 0">Every line above corresponds to a payment on a remittance you
    received. A negative amount is money the payer took back after we had credited it, and it
    reduces this bill rather than being carried quietly.</p>
  </div>

  <footer>
    Queries about any line on this statement should quote the claim number shown against it.
  </footer>
</div>
</body></html>`;

  return {
    invoiceId,
    invoiceNumber: i.invoice_number,
    status: i.status,
    html,
  };
}

// ---------------------------------------------------------------------------
// Evidence pack
// ---------------------------------------------------------------------------

export interface EvidencePack {
  packId: string;
  generatedAt: string;
  tenant: string;
  client: string;
  period: { from: string; to: string };
  /** SHA-256 over the canonical JSON of everything below it. */
  contentHash: string;
  operatingMode: string;
  commercialTerms: Record<string, unknown> | null;
  attributionPolicy: Record<string, unknown>;
  ledger: unknown[];
  invoices: unknown[];
  goLiveChecks: unknown[];
  auditTrail: unknown[];
  /** Stated limits of what this pack does and does not evidence. */
  scopeNotes: string[];
}

/**
 * Assemble the pack an auditor is given for a period.
 *
 * Content-addressed on purpose: the hash covers the substantive contents, so a
 * copy produced months later can be compared against what was handed over. It
 * is a tamper-evidence aid, not a signature — there is no key here, and the
 * pack says so rather than implying more assurance than it has.
 */
export async function buildEvidencePack(
  db: Queryable, sess: Session, s: Scope, clientId: UUID, from: string, to: string,
): Promise<EvidencePack> {
  requireAnyAdmin(sess);
  assertClientAccess(sess, s, clientId);
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE.test(from) || !DATE.test(to)) throw err('from and to must be YYYY-MM-DD', 400);
  if (from > to) throw err('from must not be after to', 400);

  const c = await db.query(
    `SELECT c.client_name, t.tenant_name, c.operating_mode, c.attribution_basis,
            c.attribution_window_days, c.attribution_min_amount,
            c.attribution_include_unallocated, c.clawback_policy,
            c.era_balance_policy, c.ncci_bundling_policy
     FROM client c JOIN tenant t ON t.tenant_id = c.tenant_id
     WHERE c.tenant_id = $1 AND c.client_id = $2`, [s.tenantId, clientId]);
  if (!c.rows[0]) throw err('client not found', 404);
  const cl = c.rows[0];

  const plan = await db.query(
    `SELECT plan_name, effective_date, expiration_date, base_fee, per_case_fee,
            contingency_percent, minimum_fee, maximum_fee, contingency_basis,
            agreement_reference, agreement_executed_on, agreed_attribution_basis
     FROM pricing_plan
     WHERE tenant_id = $1 AND deleted_at IS NULL AND (client_id = $2 OR client_id IS NULL)
       AND effective_date <= $4::date
       AND (expiration_date IS NULL OR expiration_date >= $3::date)
     ORDER BY (client_id IS NOT NULL) DESC, effective_date DESC LIMIT 1`,
    [s.tenantId, clientId, from, to]);

  const ledger = await db.query(
    `SELECT ue.usage_event_id, ue.event_type, ue.occurred_at, ue.recorded_at, ue.amount,
            ue.attribution_basis, ue.attribution_scope, ue.detail,
            i.invoice_number
     FROM usage_event ue
     LEFT JOIN invoice i ON i.invoice_id = ue.invoice_id
     WHERE ue.tenant_id = $1 AND ue.client_id = $2
       AND ue.occurred_at BETWEEN $3::date AND $4::date
     ORDER BY ue.occurred_at, ue.recorded_at`, [s.tenantId, clientId, from, to]);

  const invoices = await db.query(
    `SELECT invoice_number, period_start, period_end, status, attributed_recovery,
            contingency_percent, contingency_fee, base_fee, case_fee_total,
            amount_due, issued_at, voided_at, voided_reason
     FROM invoice
     WHERE tenant_id = $1 AND client_id = $2
       AND period_start <= $4::date AND period_end >= $3::date
     ORDER BY period_start`, [s.tenantId, clientId, from, to]);

  const goLive = await db.query(
    `SELECT cleared, blocking_failures, warnings, checked_at
     FROM go_live_check WHERE tenant_id = $1 AND client_id = $2
     ORDER BY checked_at DESC LIMIT 20`, [s.tenantId, clientId]);

  // The audit log is append-only at the database level, which is what makes it
  // worth handing to somebody else.
  const audit = await db.query(
    `SELECT created_at, action, entity_type, entity_id, user_id
     FROM audit_log
     WHERE tenant_id = $1 AND created_at >= $2::date AND created_at < $3::date + 1
     ORDER BY created_at DESC LIMIT 2000`, [s.tenantId, from, to]);

  // generatedAt is deliberately OUTSIDE the hashed body. A content hash that
  // moves every time you ask for the same evidence is not content-addressed,
  // and the recipient's question is "is this copy the pack I was given",
  // not "when was it printed".
  const body = {
    tenant: cl.tenant_name,
    client: cl.client_name,
    period: { from, to },
    operatingMode: cl.operating_mode,
    commercialTerms: plan.rows[0] ?? null,
    attributionPolicy: {
      basis: cl.attribution_basis,
      windowDays: cl.attribution_window_days,
      minimumAmount: Number(cl.attribution_min_amount),
      includeUnallocated: cl.attribution_include_unallocated,
      clawbackPolicy: cl.clawback_policy,
      eraBalancePolicy: cl.era_balance_policy,
      ncciBundlingPolicy: cl.ncci_bundling_policy,
    },
    ledger: ledger.rows,
    invoices: invoices.rows,
    goLiveChecks: goLive.rows,
    auditTrail: audit.rows,
  };

  const contentHash = evidencePackHash(body);

  await adminAudit(db, sess, 'evidence_pack_exported', 'client', clientId,
    { from, to, contentHash, ledgerRows: ledger.rows.length });

  return {
    packId: `EV-${contentHash.slice(0, 12)}`,
    generatedAt: new Date().toISOString(),
    ...body,
    contentHash,
    scopeNotes: [
      'The ledger is append-only in the database: rows are written once with the figures as '
      + 'they stood and only the invoice that claimed them may change.',
      'The audit trail is append-only and rejects UPDATE and DELETE at the database level, '
      + 'including for the application role.',
      'The content hash covers the substantive contents of this pack — terms, policy, '
      + 'ledger, invoices, go-live decisions and audit trail — but not the moment it was '
      + 'printed. Recompute it with evidencePackHash() to confirm a copy is unaltered.',
      'That hash is a tamper-evidence aid, not a cryptographic signature: there is no '
      + 'signing key involved, so it shows a copy matches — it does not prove who produced it.',
      'Two packs covering the same period may differ legitimately, because the audit trail '
      + 'continues to accumulate. Compare a copy against its own hash, not against a later export.',
      'This pack evidences what the platform recorded and charged. It does not evidence the '
      + 'accuracy of payer adjudication, nor that any recovery was independently validated.',
      audit.rows.length >= 2000
        ? 'The audit trail was truncated at 2000 entries; request a narrower period for a '
          + 'complete extract.'
        : 'The audit trail for this period is complete.',
    ],
  };
}


/**
 * Deterministic serialization for hashing.
 *
 * Not `JSON.stringify(value, Object.keys(value).sort())` — passing an array as
 * the second argument makes it a property ALLOWLIST applied at every depth, so
 * nested content silently drops out and the hash covers almost nothing. Keys
 * are sorted recursively here instead, so two structurally equal packs
 * serialize identically and every field genuinely contributes.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * Recompute the content hash of a pack.
 *
 * This is the half a recipient needs: given a pack they were sent, they can
 * confirm nobody altered it in transit or afterwards. It deliberately ignores
 * the envelope fields — packId, generatedAt, contentHash and scopeNotes are
 * about the document rather than its contents.
 */
export function evidencePackHash(
  pack: Record<string, unknown>,
): string {
  const { packId, generatedAt, contentHash, scopeNotes, ...body } =
    pack as Record<string, unknown>;
  return createHash('sha256').update(canonical(body)).digest('hex');
}
