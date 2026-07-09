// ============================================================================
// STEP 1 — CLAIM-REMIT MATCHING
//
// For each remittance line:
//   1. match to a claim by payer claim number (835 CLP07 vs claim_number_payer)
//   2. else by patient member ID + date of service + procedure code + billed amount
//   3. else flag unmatched for manual review
// Within a matched claim, the line is resolved by procedure code, preferring
// an exact billed-amount match when several lines share a code.
// Claim status is updated from the remit result (denied / paid); Step 3 may
// later refine 'paid' to 'underpaid'.
// ============================================================================

import type {
  ClaimInput, ClaimLineInput, ClaimStatusUpdate, ClaimStatus, EngineInput,
  MatchResult, RemitLineInput,
} from '../types.ts';
import { MONEY_EPSILON } from '../config.ts';
import { normalizeDenialCode, DENIAL_TAXONOMY } from '../taxonomy.ts';

export interface MatchedLine {
  remitLine: RemitLineInput;
  claim: ClaimInput;
  claimLine: ClaimLineInput;
}

export interface MatchingOutcome {
  matches: MatchResult[];
  matchedLines: MatchedLine[];
  unmatched: MatchResult[];
  claimStatusUpdates: ClaimStatusUpdate[];
}

function findClaimLine(claim: ClaimInput, remit: RemitLineInput): ClaimLineInput | undefined {
  const byCode = remit.procedureCode
    ? claim.lines.filter((l) => l.procedureCode === remit.procedureCode)
    : [];
  if (byCode.length === 1) return byCode[0];
  if (byCode.length > 1) {
    const exact = byCode.find(
      (l) => remit.billedAmount != null
        && Math.abs(l.billedAmount - remit.billedAmount) <= MONEY_EPSILON,
    );
    return exact ?? byCode[0];
  }
  // no procedure code on the remit line (e.g. header-level): single-line claims only
  return claim.lines.length === 1 ? claim.lines[0] : undefined;
}

export function runMatching(input: EngineInput): MatchingOutcome {
  const claimsByPayerNumber = new Map<string, ClaimInput>();
  for (const c of input.claims) {
    if (c.claimNumberPayer) claimsByPayerNumber.set(c.claimNumberPayer, c);
  }

  const patientsByMemberId = new Map<string, Set<string>>(); // memberId -> patientIds
  for (const p of input.patients) {
    for (const id of [p.insuranceIdPrimary, p.insuranceIdSecondary]) {
      if (!id) continue;
      if (!patientsByMemberId.has(id)) patientsByMemberId.set(id, new Set());
      patientsByMemberId.get(id)!.add(p.patientId);
    }
  }

  const claimById = new Map(input.claims.map((c) => [c.claimId, c]));
  const lineById = new Map<string, { claim: ClaimInput; line: ClaimLineInput }>();
  for (const c of input.claims) {
    for (const l of c.lines) lineById.set(l.claimLineId, { claim: c, line: l });
  }

  const matches: MatchResult[] = [];
  const matchedLines: MatchedLine[] = [];
  const unmatched: MatchResult[] = [];
  // remit lines per claim, for status determination
  const remitsByClaim = new Map<string, RemitLineInput[]>();

  for (const remit of input.remitLines) {
    // pre-linked lines flow straight through to pricing/variance
    if (remit.claimId && remit.claimLineId) {
      const hit = lineById.get(remit.claimLineId);
      if (hit) {
        matchedLines.push({ remitLine: remit, claim: hit.claim, claimLine: hit.line });
        addRemit(remitsByClaim, hit.claim.claimId, remit);
      }
      continue;
    }

    let claim: ClaimInput | undefined;
    let method: MatchResult['method'] = 'unmatched';

    // attempt 1: payer claim number
    if (remit.payerClaimNumber) {
      claim = claimsByPayerNumber.get(remit.payerClaimNumber);
      if (claim) method = 'payer_claim_number';
    }

    // attempt 2: patient + DOS + procedure + billed amount
    if (!claim && remit.patientMemberId && remit.dateOfService && remit.procedureCode
        && remit.billedAmount != null) {
      const patientIds = patientsByMemberId.get(remit.patientMemberId);
      if (patientIds) {
        claim = input.claims.find(
          (c) => patientIds.has(c.patientId)
            && c.payerId === remit.payerId
            && c.dateOfServiceStart === remit.dateOfService
            && c.lines.some(
              (l) => l.procedureCode === remit.procedureCode
                && Math.abs(l.billedAmount - remit.billedAmount!) <= MONEY_EPSILON,
            ),
        );
        if (claim) method = 'patient_dos_proc_amount';
      }
    }

    const claimLine = claim ? findClaimLine(claim, remit) : undefined;

    if (claim && claimLine) {
      matches.push({
        remittanceLineId: remit.remittanceLineId,
        method,
        claimId: claim.claimId,
        claimLineId: claimLine.claimLineId,
      });
      matchedLines.push({ remitLine: remit, claim, claimLine });
      addRemit(remitsByClaim, claim.claimId, remit);
    } else {
      unmatched.push({ remittanceLineId: remit.remittanceLineId, method: 'unmatched' });
    }
  }

  // claim status from remit results
  const claimStatusUpdates: ClaimStatusUpdate[] = [];
  for (const [claimId, remits] of remitsByClaim) {
    const claim = claimById.get(claimId)!;
    const toStatus = statusFromRemits(remits);
    if (toStatus && toStatus !== claim.claimStatus) {
      claimStatusUpdates.push({ claimId, fromStatus: claim.claimStatus, toStatus });
    }
  }

  return { matches, matchedLines, unmatched, claimStatusUpdates };
}

function addRemit(map: Map<string, RemitLineInput[]>, claimId: string, r: RemitLineInput): void {
  if (!map.has(claimId)) map.set(claimId, []);
  map.get(claimId)!.push(r);
}

/**
 * denied  — nothing paid and at least one recognized denial CARC
 * paid    — any payment posted (Step 3 refines to 'underpaid' on variance)
 * accepted— remit received, zero paid, no denial code (e.g. applied to deductible)
 */
function statusFromRemits(remits: RemitLineInput[]): ClaimStatus | null {
  const totalPaid = remits.reduce((s, r) => s + (r.paidAmount ?? 0), 0);
  const hasDenial = remits.some((r) => {
    const code = normalizeDenialCode(r.adjustmentReasonCode, r.adjustmentGroupCode);
    return code !== null && code in DENIAL_TAXONOMY && !DENIAL_TAXONOMY[code].requiresVariance;
  });
  if (totalPaid <= MONEY_EPSILON && hasDenial) return 'denied';
  if (totalPaid > MONEY_EPSILON) return 'paid';
  return 'accepted';
}
