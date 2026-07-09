// ============================================================================
// STEP 5 — APPEALABILITY SCORING (0-100) + PRIORITY
//
// Score components:
//   * category base — with the spec's context rules:
//       auth denial when an auth number exists      -> high
//       duplicate that is not actually a duplicate  -> high
//       timely filing with proof of submission      -> medium
//       medical necessity                           -> variable (base 50)
//   * days until deadline (tight deadline erodes the score)
//   * prior win rate for this denial category + payer
//   * whether the supporting documents are on file
//   * whether a similar case (category + payer) was previously won
//
// priority_level:
//   critical: deadline within 14 days or recovery > $5000
//   high:     deadline within 30 days or recovery > $1000
//   medium:   deadline within 60 days
//   low:      all others (and expired deadlines, which are never prioritized)
// ============================================================================

import type {
  EngineInput, PriorityLevel, RecoveryLikelihood,
} from '../types.ts';
import { daysBetween } from '../config.ts';
import type { CaseCandidate } from './step4_denials.ts';

export interface ScoredCandidate extends CaseCandidate {
  appealabilityScore: number;      // 0..100
  confidenceScore: number;         // 0..1 (score / 100)
  recoveryLikelihood: RecoveryLikelihood;
  priorityLevel: PriorityLevel;
  daysUntilDeadline: number | null;
  expired: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function categoryBase(input: EngineInput, c: CaseCandidate): number {
  const claim = c.matched.claim;
  switch (c.denialCategory) {
    case 'authorization':
      // "auth when auth exists = high"
      return claim.authorizationNumber ? 85 : 45;
    case 'duplicate': {
      // "duplicate when not duplicate = high": is there really another claim
      // for the same patient + DOS + procedure?
      const proc = c.matched.claimLine.procedureCode;
      const trueDuplicate = input.claims.some(
        (other) => other.claimId !== claim.claimId
          && other.patientId === claim.patientId
          && other.dateOfServiceStart === claim.dateOfServiceStart
          && other.lines.some((l) => l.procedureCode === proc),
      );
      return trueDuplicate ? 25 : 85;
    }
    case 'timely_filing': {
      // "timely filing with proof = medium": submission date inside the
      // payer's filing window is the proof
      const payer = input.payers.find((p) => p.payerId === claim.payerId);
      const limit = payer?.timelyFilingLimitDays;
      if (claim.submissionDate && limit != null) {
        const filedIn = daysBetween(claim.dateOfServiceStart, claim.submissionDate);
        if (filedIn >= 0 && filedIn <= limit) return 65;
      }
      return 20;
    }
    case 'clinical_medical_necessity': return 50; // variable
    case 'coding': return 60;
    case 'bundling': return 55;
    case 'coordination_of_benefits': return 40;
    case 'patient_eligibility': return 35;
    case 'contractual': return c.noContract ? 40 : 70;
    case null:
      // plain underpayment (no denial code): contract-documented -> strong
      return c.noContract ? 40 : 75;
    default: return 40;
  }
}

function deadlineAdjustment(days: number | null): number {
  if (days == null) return 0;
  if (days < 0) return -40;   // expired
  if (days <= 7) return -20;
  if (days <= 14) return -10;
  if (days > 60) return 5;
  return 0;
}

function winRateAdjustment(input: EngineInput, c: CaseCandidate): number {
  if (!c.denialCategory) return 0;
  const wr = input.winRates.find(
    (w) => w.payerId === c.matched.claim.payerId && w.denialCategory === c.denialCategory,
  );
  if (!wr || wr.won + wr.lost === 0) return 0;
  const total = wr.won + wr.lost;
  const rate = wr.won / total;
  let adj = 0;
  if (rate >= 0.7) adj += 15;
  else if (rate >= 0.5) adj += 8;
  else if (rate < 0.3 && total >= 5) adj -= 15;
  if (wr.won > 0) adj += 5;   // "similar case was previously won"
  return adj;
}

function documentsAdjustment(c: CaseCandidate): number {
  if (c.supportingDocuments.length === 0) return 0;
  const onFile = c.matched.claim.availableDocumentTypes;
  const available = c.supportingDocuments.some((d) => onFile.includes(d));
  return available ? 10 : -10;
}

export function priorityFor(
  input: EngineInput, recovery: number, daysUntilDeadline: number | null, expired: boolean,
): PriorityLevel {
  const cfg = input.config;
  if (expired) return 'low';   // Step 6: expired cases are not prioritized
  const d = daysUntilDeadline;
  if ((d != null && d <= cfg.criticalDeadlineDays) || recovery > cfg.criticalAmount) return 'critical';
  if ((d != null && d <= cfg.highDeadlineDays) || recovery > cfg.highAmount) return 'high';
  if (d != null && d <= cfg.mediumDeadlineDays) return 'medium';
  return 'low';
}

function likelihoodFromScore(score: number): RecoveryLikelihood {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

export function scoreCandidates(
  input: EngineInput, candidates: CaseCandidate[],
): ScoredCandidate[] {
  return candidates.map((c) => {
    const days = c.deadlineDate ? daysBetween(input.config.asOf, c.deadlineDate) : null;
    const expired = days != null && days < 0;

    const score = clamp(
      Math.round(
        categoryBase(input, c)
        + deadlineAdjustment(days)
        + winRateAdjustment(input, c)
        + documentsAdjustment(c)
        + (c.knownCode ? 0 : -15),
      ),
      0, 100,
    );

    return {
      ...c,
      appealabilityScore: score,
      confidenceScore: score / 100,
      recoveryLikelihood: likelihoodFromScore(score),
      priorityLevel: priorityFor(input, c.recoveryOpportunity, days, expired),
      daysUntilDeadline: days,
      expired,
    };
  });
}
