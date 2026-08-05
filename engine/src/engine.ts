// ============================================================================
// Recovery detection engine — pure orchestration of Steps 1-7.
//
// runEngine(input) -> EngineResult. No I/O, fully deterministic (the "clock"
// is input.config.asOf). Callers:
//   * tests            — build EngineInput in memory, assert on the result
//   * src/service.ts   — snapshots Postgres, runs this, persists the result
// ============================================================================

import type {
  ClaimLineUpdate, ClaimStatusUpdate, EngineInput, EngineResult,
} from './types.ts';
import { moneyGt } from './config.ts';
import { runMatching } from './steps/step1_matching.ts';
import { runExpectedCalculation } from './steps/step2_expected.ts';
import { runVarianceDetection } from './steps/step3_variance.ts';
import { candidatesFromDenials, candidatesFromUnderpayments } from './steps/step4_denials.ts';
import { scoreCandidates } from './steps/step5_scoring.ts';
import { applyCaseRules } from './steps/step6_case_rules.ts';
import { summarize } from './steps/step7_summary.ts';
import { DENIAL_TAXONOMY } from './taxonomy.ts';

export function runEngine(input: EngineInput): EngineResult {
  // STEP 1 — claim-remit matching
  const matching = runMatching(input);
  const aggregatedMatchedLines = aggregateMatchedLines(matching.matchedLines);

  // STEP 2 — expected reimbursement per matched claim line
  const pricing = runExpectedCalculation(input, aggregatedMatchedLines);

  // STEP 3 — variance detection / denial routing
  const variance = runVarianceDetection(input, aggregatedMatchedLines, pricing);

  // STEP 4 — denial classification -> case candidates (both paths)
  const candidates = [
    ...candidatesFromDenials(input, variance.denialRoutes),
    ...candidatesFromUnderpayments(input, variance.underpayments),
  ];

  // STEP 5 — appealability scoring + priority
  const scored = scoreCandidates(input, candidates);

  // STEP 6 — case creation rules
  const rules = applyCaseRules(input, scored);

  // claim line updates: propagate remit amounts, pricing, and denial detail
  const claimLineUpdates = buildClaimLineUpdates(
    input, { ...matching, matchedLines: aggregatedMatchedLines }, pricing, variance,
  );

  // 'paid' refined to 'underpaid' where a case-worthy variance exists
  const claimStatusUpdates = refineStatuses(matching.claimStatusUpdates, variance, rules);

  // STEP 7 — aggregate and summarize
  const pricedLinesByPayer = new Map<string, number>();
  for (const ml of aggregatedMatchedLines) {
    const p = pricing.get(ml.claimLine.claimLineId);
    if (p && p.expectedSource === 'contract') {
      const payerId = ml.claim.payerId;
      pricedLinesByPayer.set(payerId, (pricedLinesByPayer.get(payerId) ?? 0) + 1);
    }
  }
  const summary = summarize(input, {
    matches: matching.matches,
    unmatched: matching.unmatched,
    created: rules.created,
    updated: rules.updated,
    skipped: rules.skipped,
    varianceFlags: variance.underpayments,
    pricedLinesByPayer,
  });

  return {
    matches: matching.matches,
    unmatchedRemitLines: matching.unmatched,
    claimLineUpdates,
    claimStatusUpdates,
    pricing: [...pricing.values()],
    casesCreated: rules.created,
    casesUpdated: rules.updated,
    skipped: rules.skipped,
    summary,
  };
}

/**
 * A claim line may receive several new ERA entries (split payments or a later
 * supplemental payment). Price it once and compare against cumulative cash,
 * rather than evaluating only the first remittance line or overwriting a
 * previously posted payment.
 */
function aggregateMatchedLines(
  matchedLines: ReturnType<typeof runMatching>['matchedLines'],
): ReturnType<typeof runMatching>['matchedLines'] {
  const groups = new Map<string, typeof matchedLines>();
  for (const matched of matchedLines) {
    const id = matched.claimLine.claimLineId;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(matched);
  }

  return [...groups.values()].map((group) => {
    const latest = [...group].sort((a, b) =>
      (a.remitLine.checkDate ?? '').localeCompare(b.remitLine.checkDate ?? ''))
      .at(-1)!;
    const priorPaid = latest.claimLine.paidAmount ?? 0;
    const newPaid = group.reduce((sum, m) => sum + (m.remitLine.paidAmount ?? 0), 0);
    // Payment is cumulative, but adjustment and patient-liability context
    // comes from the latest adjudication so an older denial does not remain
    // active after a supplemental payment resolves it.
    const latestEntries = group.filter(
      (m) => m.remitLine.remittanceId === latest.remitLine.remittanceId,
    );
    const adjustments = latestEntries.flatMap((m) => m.remitLine.adjustments?.length
      ? m.remitLine.adjustments
      : m.remitLine.adjustmentReasonCode
        ? [{
          groupCode: m.remitLine.adjustmentGroupCode ?? '',
          reasonCode: m.remitLine.adjustmentReasonCode,
          amount: 0,
        }]
        : []);
    const latestPatientAmounts = latestEntries
      .map((m) => m.remitLine.patientResponsibility)
      .filter((v): v is number => v != null);
    const patientResponsibility = latestPatientAmounts.length
      ? roundMoney(latestPatientAmounts.reduce((sum, value) => sum + value, 0))
      : latest.claimLine.patientResponsibility ?? null;
    return {
      ...latest,
      remitLine: {
        ...latest.remitLine,
        paidAmount: roundMoney(priorPaid + newPaid),
        patientResponsibility,
        adjustments,
      },
    };
  });
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function buildClaimLineUpdates(
  input: EngineInput,
  matching: ReturnType<typeof runMatching>,
  pricing: ReturnType<typeof runExpectedCalculation>,
  variance: ReturnType<typeof runVarianceDetection>,
): ClaimLineUpdate[] {
  const underpaidLines = new Set(
    variance.underpayments.filter((f) => moneyGt(f.variance, 0))
      .map((f) => f.matched.claimLine.claimLineId),
  );
  const deniedLines = new Map(
    variance.denialRoutes.map((r) => [r.matched.claimLine.claimLineId, r.normalizedCode]),
  );

  const updates = new Map<string, ClaimLineUpdate>();
  for (const ml of matching.matchedLines) {
    const id = ml.claimLine.claimLineId;
    const priced = pricing.get(id);
    const routedCode = deniedLines.get(id);
    // contractual codes (CO-45 etc.) route to classification only when the
    // line paid below contract — that line is underpaid, not denied
    const contractualRoute = routedCode != null && DENIAL_TAXONOMY[routedCode]?.requiresVariance;
    const lineStatus = routedCode ? (contractualRoute ? 'underpaid' : 'denied')
      : underpaidLines.has(id) ? 'underpaid'
      : (ml.remitLine.paidAmount ?? 0) > 0 ? 'paid'
      : ml.claimLine.lineStatus ?? null;

    updates.set(id, {
      claimLineId: id,
      claimId: ml.claim.claimId,
      paidAmount: ml.remitLine.paidAmount ?? ml.claimLine.paidAmount ?? null,
      allowedAmount: ml.remitLine.allowedAmount ?? ml.claimLine.allowedAmount ?? null,
      patientResponsibility: ml.remitLine.patientResponsibility
        ?? ml.claimLine.patientResponsibility ?? null,
      expectedAmount: priced?.expectedAmount ?? ml.claimLine.expectedAmount ?? null,
      expectedSource: priced?.expectedSource,
      denialReasonCode: routedCode ?? null,
      denialReasonDescription: describeDenial(routedCode),
      lineStatus,
    });
  }
  return [...updates.values()];
}

function describeDenial(code: string | undefined): string | null {
  if (!code) return null;
  const entry = DENIAL_TAXONOMY[code];
  return entry ? `${code}: ${entry.category.replaceAll('_', ' ')}` : `${code}: unmapped denial code`;
}

function refineStatuses(
  statusUpdates: ClaimStatusUpdate[],
  variance: ReturnType<typeof runVarianceDetection>,
  rules: ReturnType<typeof applyCaseRules>,
): ClaimStatusUpdate[] {
  const underpaidClaims = new Set(
    [...rules.created, ...rules.updated]
      .filter((c) => c.caseType === 'underpayment')
      .map((c) => c.claimId),
  );
  for (const f of variance.underpayments) {
    if (f.caseWorthy) underpaidClaims.add(f.matched.claim.claimId);
  }
  return statusUpdates.map((u) =>
    u.toStatus === 'paid' && underpaidClaims.has(u.claimId)
      ? { ...u, toStatus: 'underpaid' as const }
      : u,
  );
}
