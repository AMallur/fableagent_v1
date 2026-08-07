// ============================================================================
// Acknowledgement reconciliation for the change_healthcare connector —
// the "reconcile acknowledgements before autonomous delivery is enabled"
// half of the certification gate in docs/PRODUCTION_READINESS.md gate 4.
//
// Classifies the response using X12's own published Claim Status Category
// Codes (STC01-1, ECL 507 — see x12_claim_status_codes.ts for the table and
// its source). Only a transmission-level rejection (see isRejection there)
// flips outbound_delivery.status to 'failed'; a claim that was accepted and
// is pending, finalized-paid, or finalized-denied stays 'sent', since
// 'sent' means the clearinghouse accepted the transmission — the business
// adjudication outcome (paid/denied) belongs on `claim`, not here.
//
// Wired into the scheduler via runDeliveryReconciliation
// (automation/jobs.ts), which schedulerTick runs once per client per day
// at 09:00 local time (automation/scheduler.ts). That wiring has NOT yet
// been exercised against the real sandbox claim-status endpoint — only
// submission/validation have been live-tested so far — so treat the
// classification logic as code-reviewed and unit-tested, not field-proven,
// until a real sandbox run confirms the response shape matches what
// buildClaimStatusCheck/lookupClaimStatusCategory expect.
// ============================================================================

import type { UUID } from '../types.ts';
import type { PoolLike } from '../service.ts';
import { checkClaimStatus } from './optum_client.ts';
import { buildClaimStatusCheck } from './optum_mapping.ts';
import { lookupClaimStatusCategory } from './x12_claim_status_codes.ts';

export interface ReconciliationResult {
  deliveryId: UUID;
  outcome: 'accepted' | 'rejected' | 'unclassified' | 'skipped';
  detail: unknown;
}

interface ClaimStatusResponse {
  claims?: Array<{ claimStatus?: { statusCategoryCode?: string; statusCode?: string } }>;
}

/**
 * Re-checks one 'sent' outbound_delivery against Optum's claim-status API,
 * classifies the result via the confirmed X12 category-code table, and
 * records both the raw response and the classification in
 * outbound_delivery.detail.reconciliation.
 */
export async function reconcileChangeHealthcareDelivery(
  pool: PoolLike, args: { tenantId: UUID; deliveryId: UUID },
): Promise<ReconciliationResult | null> {
  const rows = await pool.query(
    `SELECT delivery_id, connector, status, detail
     FROM outbound_delivery WHERE delivery_id = $1 AND tenant_id = $2`,
    [args.deliveryId, args.tenantId]);
  const row = rows.rows[0];
  if (!row || row.connector !== 'change_healthcare' || row.status !== 'sent') {
    return null; // not ours, or never actually reached 'sent'
  }

  const detail = row.detail as {
    payload?: { claimRequest?: Record<string, unknown> };
    reference?: string;
  };
  const claimRequest = detail?.payload?.claimRequest;
  if (!claimRequest) {
    return {
      deliveryId: row.delivery_id, outcome: 'skipped',
      detail: { message: 'no stored claimRequest to reconcile against' },
    };
  }

  const statusPayload = buildClaimStatusCheck(
    claimRequest, { controlNumber: String(claimRequest.controlNumber ?? '') },
  );
  const result = await checkClaimStatus(statusPayload, { traceId: detail.reference });

  const body = result.ok ? (result.body as ClaimStatusResponse) : undefined;
  const statusCategoryCode = body?.claims?.[0]?.claimStatus?.statusCategoryCode;
  const category = lookupClaimStatusCategory(statusCategoryCode);
  const outcome: ReconciliationResult['outcome'] = !result.ok || !category
    ? 'unclassified'
    : category.isRejection ? 'rejected' : 'accepted';

  await pool.query(
    `UPDATE outbound_delivery
     SET detail = jsonb_set(detail, '{reconciliation}', $3::jsonb, true),
         status = CASE WHEN $4 THEN 'failed' ELSE status END,
         updated_at = now()
     WHERE delivery_id = $1 AND tenant_id = $2`,
    [args.deliveryId, args.tenantId,
     JSON.stringify({
       checkedAt: new Date().toISOString(), httpStatus: result.status, outcome,
       statusCategoryCode: statusCategoryCode ?? null,
       statusCategoryDescription: category?.description ?? null,
       body: result.body,
     }),
     outcome === 'rejected']);

  return { deliveryId: row.delivery_id, outcome, detail: result.body };
}
