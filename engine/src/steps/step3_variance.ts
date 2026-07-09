// ============================================================================
// STEP 3 — VARIANCE DETECTION
//
// For each claim line with a matched remit:
//   variance = expected_amount - paid_amount
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
  variancePercent: number | null;
  /** crossed the case-creation trigger */
  caseWorthy: boolean;
}

export interface DenialRoute {
  matched: MatchedLine;
  pricing: LinePricing;
  normalizedCode: string;
  variance: number | null;
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

    const paid = remitLine.paidAmount ?? claimLine.paidAmount ?? 0;
    const expected = priced.expectedAmount;
    const variance = expected != null ? round2(expected - paid) : null;

    const code = normalizeDenialCode(
      remitLine.adjustmentReasonCode ?? claimLine.denialReasonCode,
      remitLine.adjustmentGroupCode,
    );
    const taxonomyEntry = code ? DENIAL_TAXONOMY[code] : undefined;
    // a contractual-group code (CO-45 etc.) only counts as a denial when the
    // line actually paid below expected; hard denial codes always route
    const isDenial = code != null && (
      (taxonomyEntry && !taxonomyEntry.requiresVariance)
      || (taxonomyEntry?.requiresVariance && variance != null && moneyGt(variance, 0))
      || (!taxonomyEntry && paid <= 0)  // unmapped code with nothing paid
    );

    if (seenLine.has(claimLine.claimLineId)) continue;
    seenLine.add(claimLine.claimLineId);

    if (isDenial && code) {
      denialRoutes.push({ matched, pricing: priced, normalizedCode: code, variance });
      continue;
    }

    if (variance == null || !moneyGt(variance, 0)) continue;

    const variancePercent = expected && expected > 0 ? variance / expected : null;
    const caseWorthy =
      moneyGt(variance, input.config.varianceDollarTrigger)
      || (variancePercent != null && variancePercent > input.config.variancePercentTrigger);

    underpayments.push({
      matched, pricing: priced, variance,
      variancePercent, caseWorthy,
    });
  }

  return { underpayments, denialRoutes };
}
