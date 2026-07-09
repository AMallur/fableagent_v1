// ============================================================================
// DOCUMENT ASSEMBLY (pure)
//
// buildDocumentPlan(ctx, correction) decides, for one case:
//   * which documents the packet needs (generated + already-on-file)
//   * what's missing -> packet_status: 'ready' when complete, 'draft' when not
//   * appeal type (corrected_claim / first_level / second_level)
//   * submission method (portal when the payer has one, else mail;
//     corrected claims go back through the clearinghouse)
//   * auto_submit / needs_review routing per spec
//
// Required documents per category (letter + EOB + claim lines always):
//   authorization      + authorization doc (attestation generated from the
//                        auth number on the encounter when no doc uploaded)
//   medical_necessity  + medical_record (never fabricated — uploaded only)
//   underpayment       + contract excerpt (generated from contract lines)
//   timely_filing      + proof of filing (submission record generated from
//                        claim data when a submission date exists)
// ============================================================================

import type {
  AppealCaseContext, AppealType, CorrectionResult, DocumentPlan, PlannedDocument,
  SubmissionMethod,
} from './types.ts';
import { letterCategory } from './letter.ts';

export const AUTO_SUBMIT_CONFIDENCE = 0.85;
const ELECTRONIC_METHODS: SubmissionMethod[] = ['portal', 'clearinghouse'];

const usd = (n: number | null | undefined): string =>
  n == null ? 'N/A' : `$${n.toFixed(2)}`;

// ---------------------------------------------------------------------------
// generated supporting documents
// ---------------------------------------------------------------------------

function eobSummary(ctx: AppealCaseContext): string {
  const rows = ctx.remitLines.map((r) =>
    `  ${r.procedureCode ?? '(claim level)'}  billed ${usd(r.billedAmount)}  `
    + `allowed ${usd(r.allowedAmount)}  paid ${usd(r.paidAmount)}`
    + (r.adjustmentReasonCode ? `  adj ${r.adjustmentGroupCode ?? ''}-${r.adjustmentReasonCode}` : ''));
  const check = ctx.remitLines.find((r) => r.checkNumber || r.checkDate);
  return [
    `EXPLANATION OF BENEFITS (from electronic remittance) — claim ${ctx.claimNumberInternal}`,
    `Payer: ${ctx.payerName}` + (check?.checkNumber ? `   Check/EFT: ${check.checkNumber}` : '')
      + (check?.checkDate ? `   Date: ${check.checkDate}` : ''),
    `Patient: ${ctx.patientFirstName} ${ctx.patientLastName}   DOS: ${ctx.dateOfService}`,
    '',
    'SERVICE LINES:',
    ...(rows.length ? rows : ['  (no remittance detail on file)']),
  ].join('\n') + '\n';
}

function claimLinesSummary(ctx: AppealCaseContext): string {
  const rows = ctx.claimLines.map((l) =>
    `  ${String(l.lineNumber).padStart(2)}  ${l.procedureCode}`
    + `${l.modifiers.length ? '-' + l.modifiers.join('-') : ''}`
    + `  units ${l.units}  billed ${usd(l.billedAmount)}  expected ${usd(l.expectedAmount)}`
    + `  paid ${usd(l.paidAmount)}`
    + (l.denialReasonCode ? `  denial ${l.denialReasonCode}` : ''));
  return [
    `CLAIM DETAIL — ${ctx.claimNumberInternal}`
      + (ctx.claimNumberPayer ? ` (payer claim ${ctx.claimNumberPayer})` : ''),
    `Patient: ${ctx.patientFirstName} ${ctx.patientLastName}   DOS: ${ctx.dateOfService}`,
    '',
    'LINES:',
    ...rows,
  ].join('\n') + '\n';
}

function contractExcerpt(ctx: AppealCaseContext): string | null {
  if (!ctx.contract) return null;
  const codes = new Set(ctx.claimLines.map((l) => l.procedureCode));
  const relevant = ctx.contract.lines.filter((l) => codes.has(l.procedureCode));
  const rows = (relevant.length ? relevant : ctx.contract.lines).map((l) =>
    `  ${l.procedureCode}${l.modifier ? '-' + l.modifier : ''}: `
    + (l.allowedAmount != null ? `contracted rate ${usd(l.allowedAmount)}`
      : `${l.percentOfMedicare}% of Medicare`));
  return [
    `CONTRACT FEE SCHEDULE EXCERPT — ${ctx.clientName} / ${ctx.payerName}`,
    `Methodology: ${ctx.contract.feeScheduleType.replaceAll('_', ' ')}   Effective: ${ctx.contract.effectiveDate}`,
    '',
    'APPLICABLE RATES:',
    ...rows,
  ].join('\n') + '\n';
}

function authAttestation(ctx: AppealCaseContext): string | null {
  if (!ctx.authorizationNumber) return null;
  return [
    `AUTHORIZATION RECORD — claim ${ctx.claimNumberInternal}`,
    `Patient: ${ctx.patientFirstName} ${ctx.patientLastName}   DOS: ${ctx.dateOfService}`,
    `Payer: ${ctx.payerName}`,
    '',
    `Authorization number on file: ${ctx.authorizationNumber}`,
    `Recorded on the encounter prior to claim submission.`,
  ].join('\n') + '\n';
}

function timelyFilingProof(ctx: AppealCaseContext): string | null {
  if (!ctx.submissionDate) return null;
  return [
    `PROOF OF TIMELY FILING — claim ${ctx.claimNumberInternal}`,
    `Patient: ${ctx.patientFirstName} ${ctx.patientLastName}   DOS: ${ctx.dateOfService}`,
    '',
    `Original submission date: ${ctx.submissionDate}`,
    `Submitted electronically; submission record retained in the billing system`
    + ` (reference ${ctx.claimNumberInternal}).`,
  ].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------

export function buildDocumentPlan(
  ctx: AppealCaseContext,
  correction: CorrectionResult | null,
): DocumentPlan {
  const category = letterCategory(ctx);
  const documents: PlannedDocument[] = [];
  const missing: string[] = [];
  const stamp = ctx.asOf;

  const existing = (type: string) =>
    ctx.existingDocuments.find((d) => d.documentType === type);

  // always: EOB from remit data + relevant claim lines
  documents.push({
    kind: 'generate', documentType: 'eob',
    fileName: `eob-${ctx.claimNumberInternal}-${stamp}.txt`,
    content: eobSummary(ctx),
  });
  documents.push({
    kind: 'generate', documentType: 'other',
    fileName: `claim-lines-${ctx.claimNumberInternal}-${stamp}.txt`,
    content: claimLinesSummary(ctx),
  });

  // category-specific requirements
  if (category === 'authorization') {
    const doc = existing('authorization');
    if (doc) documents.push({ kind: 'existing', ...doc });
    else {
      const attestation = authAttestation(ctx);
      if (attestation) {
        documents.push({
          kind: 'generate', documentType: 'authorization',
          fileName: `authorization-${ctx.claimNumberInternal}-${stamp}.txt`,
          content: attestation,
        });
      } else missing.push('authorization');
    }
  }

  if (category === 'medical_necessity') {
    const doc = existing('medical_record');
    if (doc) documents.push({ kind: 'existing', ...doc });
    else missing.push('medical_record'); // clinical notes are never fabricated
  }

  if (category === 'underpayment') {
    const doc = existing('contract') ?? existing('fee_schedule');
    if (doc) documents.push({ kind: 'existing', ...doc });
    else {
      const excerpt = contractExcerpt(ctx);
      if (excerpt) {
        documents.push({
          kind: 'generate', documentType: 'contract',
          fileName: `contract-excerpt-${ctx.claimNumberInternal}-${stamp}.txt`,
          content: excerpt,
        });
      } else missing.push('contract');
    }
  }

  if (category === 'timely_filing') {
    const proof = timelyFilingProof(ctx);
    if (proof) {
      documents.push({
        kind: 'generate', documentType: 'other',
        fileName: `timely-filing-proof-${ctx.claimNumberInternal}-${stamp}.txt`,
        content: proof,
      });
    } else missing.push('timely_filing_proof');
  }

  // (a corrected-claim summary document is added by the service when a
  // correction exists — no additional requirement here)

  // appeal type
  const appealType: AppealType = correction
    ? 'corrected_claim'
    : ctx.priorPacketCount > 0 ? 'second_level' : 'first_level';

  // submission method
  const submissionMethod: SubmissionMethod =
    appealType === 'corrected_claim' ? 'clearinghouse'
    : ctx.portalUrl ? 'portal'
    : 'mail';

  // needs_review per spec
  const reasons: string[] = [];
  if (category === 'medical_necessity') {
    reasons.push('medical necessity appeal requires clinical review');
  }
  if (ctx.clientReviewThreshold != null && ctx.recoveryOpportunity > ctx.clientReviewThreshold) {
    reasons.push(`recovery ${usd(ctx.recoveryOpportunity)} exceeds client review threshold ${usd(ctx.clientReviewThreshold)}`);
  }
  if (ctx.priorCategoryCaseCount === 0) {
    reasons.push('new denial pattern for this payer — no prior history');
  }
  if (ctx.confidenceScore == null || ctx.confidenceScore < AUTO_SUBMIT_CONFIDENCE) {
    reasons.push(`confidence ${ctx.confidenceScore != null ? Math.round(ctx.confidenceScore * 100) : '?'} below 85`);
  }
  if (correction?.needsManualReview) {
    reasons.push(`correction confidence ${correction.confidenceScore} below 85 — coder review required`);
  }
  const needsReview = reasons.length > 0;

  // auto_submit per spec (never auto-submit something flagged for review)
  const autoSubmit =
    ctx.autopilotEnabled
    && ELECTRONIC_METHODS.includes(submissionMethod)
    && (ctx.confidenceScore ?? 0) >= AUTO_SUBMIT_CONFIDENCE
    && !needsReview;

  return {
    documents,
    missingDocumentTypes: missing,
    packetStatus: missing.length === 0 ? 'ready' : 'draft',
    appealType,
    submissionMethod,
    autoSubmit,
    needsReview,
    needsReviewReasons: reasons,
  };
}
