// ============================================================================
// STEP 3 — VARIANCE DETECTION
//
// For each claim line with a matched remit:
//   expected_payer_amount = contract_allowed - patient_responsibility
//   variance = expected_payer_amount - cumulative_paid_amount
//   * denial code present -> route to denial classification (Step 4), never
//     double-flagged as a plain underpayment
//   * variance > $0                    -> flag line as underpayment
//   * variance > $25 OR > 5% expected  -> candidate recovery case (underpayment)
// ============================================================================

import type { EngineInput, LinePricing } from '../types.ts';
import { moneyGt, round2 } from '../config.ts';
import { normalizeDenialCode, DENIAL_TAXONOMY } from '../taxonomy.ts';
import type { MatchedLine } from './step1_matching.ts';

export interface VarianceFlag {
  matched: MatchedLine;
  pricing: LinePricing;
  variance: number;
  /** Contract allowed amount less valid patient responsibility. */
  expectedPayerAmount: number;
  variancePercent: number | null;
  /** crossed the case-creation trigger */
  caseWorthy: boolean;
}

export interface DenialRoute {
  matched: MatchedLine;
  pricing: LinePricing;
  normalizedCode: string;
  variance: number | null;
  expectedPayerAmount: number | null;
}

export interface VarianceOutcome {
  underpayments: VarianceFlag[];
  denialRoutes: DenialRoute[];
}

export function runVarianceDetection(
  input: EngineInput,
  matchedLines: MatchedLine[],
  pricing: Map<string, LinePricing>,
): VarianceOutcome {
  const underpayments: VarianceFlag[] = [];
  const denialRoutes: DenialRoute[] = [];
  const seenLine = new Set<string>();

  for (const matched of matchedLines) {
    const { remitLine, claimLine } = matched;
    const priced = pricing.get(claimLine.claimLineId);
    if (!priced) continue;

    // A reversal is the payer undoing an earlier adjudication, not a new one.
    // Its amounts are negative and have already been netted into cumulative
    // cash upstream; treating it as an adjudication here would manufacture a
    // full-billed-amount "underpayment" out of an accounting entry.
    if (remitLine.isReversal) {
      seenLine.add(claimLine.claimLineId);
      continue;
    }

    const paid = remitLine.paidAmount ?? claimLine.paidAmount ?? 0;
    const expected = priced.expectedAmount;
    const patientResponsibility = patientResponsibilityFor(remitLine);
    const expectedPayerAmount = expected != null && patientResponsibility != null
      ? round2(Math.max(0, expected - patientResponsibility))
      : null;
    const variance = expectedPayerAmount != null
      ? round2(expectedPayerAmount - paid)
      : null;
    const denial = denialCodeFor(remitLine, claimLine.denialReasonCode, paid, variance);

    if (seenLine.has(claimLine.claimLineId)) continue;
    seenLine.add(claimLine.claimLineId);

    if (denial) {
      denialRoutes.push({
        matched, pricing: priced, normalizedCode: denial, variance,
        expectedPayerAmount,
      });
      continue;
    }

    if (variance == null || !moneyGt(variance, 0)) continue;

    const variancePercent = expectedPayerAmount && expectedPayerAmount > 0
      ? variance / expectedPayerAmount
      : null;
    const caseWorthy =
      moneyGt(variance, input.config.varianceDollarTrigger)
      || (variancePercent != null && variancePercent > input.config.variancePercentTrigger);

    underpayments.push({
      matched, pricing: priced, variance, expectedPayerAmount,
      variancePercent, caseWorthy,
    });
  }

  return { underpayments, denialRoutes };
}

function patientResponsibilityFor(remitLine: MatchedLine['remitLine']): number | null {
  const prAdjustments = (remitLine.adjustments ?? [])
    .filter((a) => a.groupCode.toUpperCase() === 'PR');
  if (prAdjustments.length) {
    return Math.max(0, prAdjustments.reduce((sum, a) => sum + a.amount, 0));
  }
  if (remitLine.patientResponsibility != null) {
    return Math.max(0, remitLine.patientResponsibility);
  }
  // Null means the ERA did not provide enough line-level information. Do not
  // infer zero merely because a CO/OA/PI adjustment is present: on a
  // multi-line claim, CLP05 can carry patient responsibility that could not
  // be allocated to this SVC line.
  return null;
}

function denialCodeFor(
  remitLine: MatchedLine['remitLine'], claimCode: string | null | undefined,
  paid: number, variance: number | null,
): string | null {
  const adjustments = remitLine.adjustments?.length
    ? remitLine.adjustments
    : remitLine.adjustmentReasonCode
      ? [{
        groupCode: remitLine.adjustmentGroupCode ?? '',
        reasonCode: remitLine.adjustmentReasonCode,
        amount: 0,
      }]
      : claimCode
        ? [{ groupCode: '', reasonCode: claimCode, amount: 0 }]
        : [];

  for (const adjustment of adjustments) {
    // PR adjustments represent patient liability, not a payer denial.
    if (adjustment.groupCode.toUpperCase() === 'PR') continue;
    const code = normalizeDenialCode(adjustment.reasonCode, adjustment.groupCode);
    if (!code) continue;
    const taxonomyEntry = DENIAL_TAXONOMY[code];
    if ((taxonomyEntry && !taxonomyEntry.requiresVariance)
      || (taxonomyEntry?.requiresVariance && variance != null && moneyGt(variance, 0))
      || (!taxonomyEntry && paid <= 0)) return code;
  }
  return null;
}
