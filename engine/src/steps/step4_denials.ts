// ============================================================================
// STEP 4 — DENIAL CLASSIFICATION ENGINE
//
// Maps each routed denial to the taxonomy: category, base recovery
// likelihood, recommended action, and a deadline computed from the payer's
// appeal_deadline_days (from the remit check date, falling back to asOf).
// Emits case candidates; underpayment flags from Step 3 are converted to
// candidates here too so Steps 5-6 treat both uniformly.
// ============================================================================

import type {
  CaseType, DenialCategory, EngineInput, PayerInput, RecoveryLikelihood,
} from '../types.ts';
import { addDays, round2 } from '../config.ts';
import { classifyDenial } from '../taxonomy.ts';
import { evaluateNcci, type NcciAssessment } from './ncci.ts';
import type { MatchedLine } from './step1_matching.ts';
import type { DenialRoute, VarianceFlag } from './step3_variance.ts';

export interface CaseCandidate {
  matched: MatchedLine;
  caseType: CaseType;
  denialReasonCode: string | null;
  denialCategory: DenialCategory | null;
  baseLikelihood: RecoveryLikelihood;
  recommendedAction: string;
  supportingDocuments: string[];
  knownCode: boolean;
  expectedAmount: number | null;
  paidAmount: number;
  recoveryOpportunity: number;
  deadlineDate: string | null;
  noContract: boolean;
  /** Present on bundling denials: what the CMS edit tables actually say about
   * this pair, and therefore whether an unbundling appeal has anywhere to go. */
  ncci?: NcciAssessment;
  /** Set when the client asked for unappealable bundling denials to be
   * suppressed and this is one. Step 6 drops it instead of opening a case. */
  suppressed?: boolean;
}

function payerById(input: EngineInput, payerId: string): PayerInput | undefined {
  return input.payers.find((p) => p.payerId === payerId);
}

function appealDeadline(input: EngineInput, matched: MatchedLine): string {
  const payer = payerById(input, matched.claim.payerId);
  const days = payer?.appealDeadlineDays ?? input.config.defaultAppealDeadlineDays;
  const from = matched.remitLine.checkDate ?? input.config.asOf;
  return addDays(from, days);
}

/**
 * Recovery opportunity:
 *   denial with variance known -> the variance (what's still owed)
 *   denial, nothing priced     -> expected ?? allowed ?? billed minus paid
 */
function recoveryAmount(
  expected: number | null, allowed: number | null | undefined,
  billed: number, paid: number,
): number {
  const basis = expected ?? allowed ?? billed;
  return round2(Math.max(0, basis - paid));
}

export function candidatesFromDenials(
  input: EngineInput, routes: DenialRoute[],
): CaseCandidate[] {
  return routes.map((route) => {
    const { matched, pricing, normalizedCode } = route;
    const { claim, claimLine, remitLine } = matched;
    const siblingLinePaid = claim.lines.some(
      (l) => l.claimLineId !== claimLine.claimLineId && (l.paidAmount ?? 0) > 0,
    ) || false;
    const cls = classifyDenial(normalizedCode, { siblingLinePaid });
    const paid = remitLine.paidAmount ?? claimLine.paidAmount ?? 0;

    // A bundling denial is the one denial where the payer's own rulebook is
    // public. Consult it before telling a biller to go and appeal.
    const ncci = cls.category === 'bundling'
      ? evaluateNcci(input, claim, claimLine) : undefined;
    const policy = input.ncciBundlingPolicyByClient?.[claim.clientId] ?? 'advisory';
    const suppressed = ncci?.finding === 'never_separately_payable'
      && policy === 'suppress_unappealable';
    // If line-level patient responsibility is unavailable, the precise payer
    // liability is unknown. Still surface the denial, but cap its opportunity
    // at the documented contract/reference expectation instead of inflating
    // it to the billed charge.
    const expectedBasis = route.expectedPayerAmount ?? pricing.expectedAmount;

    return {
      matched,
      caseType: cls.caseType,
      denialReasonCode: normalizedCode,
      denialCategory: cls.category,
      baseLikelihood: ncci?.likelihood ?? cls.baseLikelihood,
      recommendedAction: ncci?.recommendedAction ?? cls.recommendedAction,
      supportingDocuments: cls.supportingDocuments,
      knownCode: cls.known,
      expectedAmount: expectedBasis,
      paidAmount: paid,
      recoveryOpportunity: recoveryAmount(
        expectedBasis, remitLine.allowedAmount ?? claimLine.allowedAmount,
        claimLine.billedAmount, paid,
      ),
      deadlineDate: appealDeadline(input, matched),
      noContract: pricing.noContract,
      ncci,
      suppressed,
    };
  });
}

export function candidatesFromUnderpayments(
  input: EngineInput, flags: VarianceFlag[],
): CaseCandidate[] {
  return flags
    .filter((f) => f.caseWorthy)
    .map((f) => {
      const paid = f.matched.remitLine.paidAmount ?? f.matched.claimLine.paidAmount ?? 0;
      return {
        matched: f.matched,
        caseType: 'underpayment' as CaseType,
        denialReasonCode: null,
        denialCategory: null,
        // an underpayment against a documented contract rate is strong;
        // proxy-priced (no contract) recoveries are speculative
        baseLikelihood: (f.pricing.noContract ? 'low' : 'high') as RecoveryLikelihood,
        recommendedAction: f.pricing.noContract
          ? 'Paid below Medicare benchmark with no contract on file: obtain contract terms, then dispute'
          : 'Submit underpayment dispute citing contracted rate and remittance detail',
        supportingDocuments: ['contract', 'fee_schedule'],
        knownCode: true,
        expectedAmount: f.expectedPayerAmount,
        paidAmount: paid,
        recoveryOpportunity: round2(Math.max(0, f.variance)),
        deadlineDate: appealDeadline(input, f.matched),
        noContract: f.pricing.noContract,
      };
    });
}
