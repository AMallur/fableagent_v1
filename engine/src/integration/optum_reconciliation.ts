// ============================================================================
// Acknowledgement reconciliation for the change_healthcare connector —
// the "reconcile acknowledgements before autonomous delivery is enabled"
// half of the certification gate in docs/PRODUCTION_READINESS.md gate 4.
//
// Deliberately does NOT auto-classify the returned status as accepted vs.
// rejected: X12 277 status category/status codes (STC01-1 / STC10) have a
// real, specific code table, and this codebase hasn't confirmed it against
// Optum's documentation the way the request/response shapes were confirmed
// against developer.optum.com. Guessing at code semantics here would be
// exactly the kind of unverified behavior this connector's other gates
// (idempotency, retry, safe-by-default) were built to avoid. The raw
// response is recorded for a human (or a follow-up change once the code
// table is confirmed) to read.
//
// Not wired into the scheduler yet — see runNightlyProcessing /
// runPaymentReconciliation in automation/jobs.ts for where a periodic call
// to reconcileChangeHealthcareDelivery would plug in once this has been
// exercised against the real sandbox claim-status endpoint (only
// submission/validation have been live-tested so far).
// ============================================================================

import type { UUID } from '../types.ts';
import type { PoolLike } from '../service.ts';
import { checkClaimStatus } from './optum_client.ts';
import { buildClaimStatusCheck } from './optum_mapping.ts';

export interface ReconciliationResult {
  deliveryId: UUID;
  outcome: 'checked' | 'skipped';
  detail: unknown;
}

/**
 * Re-checks one 'sent' outbound_delivery against Optum's claim-status API
 * and appends the raw result to outbound_delivery.detail.reconciliation.
 * Never changes outbound_delivery.status — 'sent' means the clearinghouse
 * accepted the transmission, which stays true regardless of adjudication
 * outcome; deciding accept/reject from the status codes is future work
 * (see module header).
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

  await pool.query(
    `UPDATE outbound_delivery
     SET detail = jsonb_set(detail, '{reconciliation}', $3::jsonb, true), updated_at = now()
     WHERE delivery_id = $1 AND tenant_id = $2`,
    [args.deliveryId, args.tenantId,
     JSON.stringify({ checkedAt: new Date().toISOString(), httpStatus: result.status, body: result.body })]);

  return { deliveryId: row.delivery_id, outcome: 'checked', detail: result.body };
}
