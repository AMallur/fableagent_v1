// ============================================================================
// MODULE: CORRECTED CLAIM GENERATOR (pure)
//
// For denial codes that call for a corrected claim rather than (or alongside)
// a written appeal:
//   CO-4  modifier required but missing      -> add the correct modifier
//   CO-6  procedure not covered w/o modifier -> rebuild line with modifier
//   CO-5  procedure inconsistent w/ modifier -> strip the inconsistent modifier
//
// Modifier selection is rule-based and honest about its certainty:
//   * E/M line billed alongside a procedure on the same claim -> modifier 25
//     (significant, separately identifiable E/M), confidence 90
//   * non-E/M line where a sibling line was paid (bundled context) ->
//     modifier 59 (distinct procedural service), confidence 75
//   * no contextual signal -> modifier 59 suggested, confidence 60
// Anything under 85 is flagged needs_manual_review per spec — a coder
// confirms before submission.
// ============================================================================

import type { AppealCaseContext, AppealClaimLine, CorrectionResult } from './types.ts';

const CORRECTION_CODES = new Set(['CO-4', 'CO-5', 'CO-6']);
export const REVIEW_CONFIDENCE_THRESHOLD = 85;

const isEm = (code: string): boolean => /^99[0-4]\d{2}$/.test(code) || /^992\d{2}$/.test(code);

function targetLine(ctx: AppealCaseContext): AppealClaimLine | null {
  if (ctx.claimLineId) {
    const byId = ctx.claimLines.find((l) => l.claimLineId === ctx.claimLineId);
    if (byId) return byId;
  }
  return ctx.claimLines.find((l) => l.denialReasonCode === ctx.denialReasonCode)
    ?? ctx.claimLines[0]
    ?? null;
}

function lineFields(l: AppealClaimLine): Record<string, unknown> {
  return {
    line_number: l.lineNumber,
    procedure_code: l.procedureCode,
    modifiers: l.modifiers,
    units: l.units,
    billed_amount: l.billedAmount,
  };
}

/** Returns null when the case's denial code doesn't call for a corrected claim. */
export function generateCorrection(ctx: AppealCaseContext): CorrectionResult | null {
  const code = ctx.denialReasonCode;
  if (!code || !CORRECTION_CODES.has(code)) return null;

  const line = targetLine(ctx);
  if (!line) return null;

  const original = lineFields(line);

  if (code === 'CO-5') {
    // procedure inconsistent with the modifier used -> remove modifiers
    const confidence = 70;
    return {
      claimLineId: line.claimLineId,
      originalFields: original,
      correctedFields: { ...original, modifiers: [] },
      reason: `CO-5: procedure code ${line.procedureCode} inconsistent with modifier(s) `
        + `${line.modifiers.join(', ') || '(none)'} — removed inconsistent modifier(s) for resubmission. `
        + `Coder should confirm whether a different modifier applies instead.`,
      confidenceScore: confidence,
      needsManualReview: confidence < REVIEW_CONFIDENCE_THRESHOLD,
    };
  }

  // CO-4 / CO-6: a required modifier is missing — pick one from context
  const siblings = ctx.claimLines.filter((l) => l.claimLineId !== line.claimLineId);
  let modifier: string;
  let confidence: number;
  let rationale: string;

  if (isEm(line.procedureCode) && siblings.some((s) => !isEm(s.procedureCode))) {
    modifier = '25';
    confidence = 90;
    rationale = `E/M service ${line.procedureCode} billed with a same-day procedure `
      + `(${siblings.find((s) => !isEm(s.procedureCode))!.procedureCode}) — modifier 25 `
      + `identifies a significant, separately identifiable E/M service`;
  } else if (siblings.some((s) => (s.paidAmount ?? 0) > 0)) {
    modifier = '59';
    confidence = 75;
    rationale = `sibling line was paid while this line denied for missing modifier — modifier 59 `
      + `identifies a distinct procedural service; coder should verify an X{EPSU} subset modifier `
      + `is not more specific`;
  } else {
    modifier = '59';
    confidence = 60;
    rationale = `no contextual signal for modifier selection — modifier 59 suggested as the most `
      + `common missing-modifier correction; coder must verify against the medical record`;
  }

  return {
    claimLineId: line.claimLineId,
    originalFields: original,
    correctedFields: { ...original, modifiers: [...line.modifiers, modifier] },
    reason: `${code}: required modifier missing on ${line.procedureCode} — added modifier ${modifier}. `
      + `Rationale: ${rationale}.`,
    confidenceScore: confidence,
    needsManualReview: confidence < REVIEW_CONFIDENCE_THRESHOLD,
  };
}

/** Human/portal-readable summary document for the packet. */
export function correctionDocument(
  ctx: AppealCaseContext, correction: CorrectionResult,
): { fileName: string; content: string } {
  const fmt = (f: Record<string, unknown>) =>
    Object.entries(f).map(([k, v]) => `  ${k}: ${Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : v}`).join('\n');

  return {
    fileName: `corrected-claim-${ctx.claimNumberInternal}-${ctx.asOf}.txt`,
    content: [
      `CORRECTED CLAIM — ${ctx.claimNumberInternal}`,
      `Patient: ${ctx.patientFirstName} ${ctx.patientLastName}   DOS: ${ctx.dateOfService}`,
      `Payer: ${ctx.payerName}`,
      '',
      'ORIGINAL CLAIM FIELDS:',
      fmt(correction.originalFields),
      '',
      'CORRECTED CLAIM FIELDS:',
      fmt(correction.correctedFields),
      '',
      `REASON FOR CORRECTION:`,
      `  ${correction.reason}`,
      '',
      `Correction confidence: ${correction.confidenceScore}/100`
      + (correction.needsManualReview ? '  ** REQUIRES CODER REVIEW BEFORE SUBMISSION **' : ''),
    ].join('\n') + '\n',
  };
}
