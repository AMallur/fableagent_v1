// ============================================================================
// STEP 6 — CASE CREATION RULES
//
// Before creating a case:
//   * open case already exists for this claim_line  -> update it, no duplicate
//   * recovery below minimum threshold ($25 or the client+payer override)
//                                                   -> skip, logged
//   * deadline already passed                       -> create marked expired,
//                                                      never prioritized
//   * client+payer on autopilot                     -> auto_action=true,
//                                                      else manual queue
// ============================================================================

import type { CaseOutput, EngineInput, SkippedCase } from '../types.ts';
import { moneyGt } from '../config.ts';
import type { ScoredCandidate } from './step5_scoring.ts';

export interface CaseRulesOutcome {
  created: CaseOutput[];
  updated: CaseOutput[];
  skipped: SkippedCase[];
}

const OPEN_STATUSES = new Set(['open', 'in_progress', 'submitted', 'pending_payer']);

export function applyCaseRules(
  input: EngineInput, scored: ScoredCandidate[],
): CaseRulesOutcome {
  const created: CaseOutput[] = [];
  const updated: CaseOutput[] = [];
  const skipped: SkippedCase[] = [];

  // open cases already in the database, keyed by claim line (or claim for
  // header-level cases)
  const openCaseByLine = new Map<string, string>();
  for (const ec of input.existingCases) {
    if (!OPEN_STATUSES.has(ec.status)) continue;
    openCaseByLine.set(ec.claimLineId ?? `claim:${ec.claimId}`, ec.caseId);
  }
  // dedupe within this run too (two remit lines hitting the same claim line)
  const seenThisRun = new Set<string>();

  for (const c of scored) {
    const claim = c.matched.claim;
    const lineKey = c.matched.claimLine.claimLineId;

    const cpc = input.clientPayerConfigs.find(
      (x) => x.clientId === claim.clientId && x.payerId === claim.payerId,
    );
    const threshold = cpc?.minCaseThreshold ?? input.config.minCaseThreshold;

    // rule 2: below threshold -> no case, log it
    if (!moneyGt(c.recoveryOpportunity, 0)) {
      skipped.push({
        claimId: claim.claimId, claimLineId: lineKey, caseType: c.caseType,
        reason: 'no_recovery_amount', recoveryOpportunity: c.recoveryOpportunity,
      });
      continue;
    }
    if (c.recoveryOpportunity < threshold) {
      skipped.push({
        claimId: claim.claimId, claimLineId: lineKey, caseType: c.caseType,
        reason: 'below_threshold', recoveryOpportunity: c.recoveryOpportunity,
      });
      continue;
    }

    const output: CaseOutput = {
      clientId: claim.clientId,
      claimId: claim.claimId,
      claimLineId: lineKey,
      payerId: claim.payerId,
      caseType: c.caseType,
      denialReasonCode: c.denialReasonCode,
      denialCategory: c.denialCategory,
      expectedAmount: c.expectedAmount,
      paidAmount: c.paidAmount,
      recoveryOpportunity: c.recoveryOpportunity,
      confidenceScore: c.confidenceScore,
      appealabilityScore: c.appealabilityScore,
      recoveryLikelihood: c.recoveryLikelihood,
      recommendedAction: c.recommendedAction,
      priorityLevel: c.priorityLevel,      // rule 3: expired -> 'low' via Step 5
      deadlineDate: c.deadlineDate,
      expired: c.expired,
      autoAction: !c.expired && (cpc?.autopilotEnabled ?? false),  // rule 4
    };

    // rule 1: existing open case -> update, don't duplicate
    const existingId = openCaseByLine.get(lineKey);
    if (existingId) {
      updated.push({ ...output, existingCaseId: existingId });
      continue;
    }
    if (seenThisRun.has(lineKey)) {
      // second candidate for the same line in one run: fold into the created
      // case rather than emitting a duplicate
      const prior = created.find((x) => x.claimLineId === lineKey);
      if (prior && c.recoveryOpportunity > prior.recoveryOpportunity) {
        Object.assign(prior, output);
      }
      continue;
    }

    seenThisRun.add(lineKey);
    created.push(output);
  }

  return { created, updated, skipped };
}
