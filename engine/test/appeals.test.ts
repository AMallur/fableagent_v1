import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AppealCaseContext } from '../src/appeals/types.ts';
import { generateAppealLetter, letterCategory } from '../src/appeals/letter.ts';
import { generateCorrection } from '../src/appeals/corrected_claim.ts';
import { buildDocumentPlan } from '../src/appeals/assembly.ts';
import { requiredAction } from '../src/appeals/queue.ts';

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

let n = 0;
function ctx(overrides: Partial<AppealCaseContext> = {}): AppealCaseContext {
  n += 1;
  return {
    caseId: `case-${n}`,
    caseType: 'denial',
    denialCategory: 'authorization',
    denialReasonCode: 'CO-197',
    priorityLevel: 'high',
    recoveryOpportunity: 125,
    expectedAmount: 125,
    paidAmount: 0,
    confidenceScore: 0.9,
    deadlineDate: '2026-12-22',
    claimLineId: `line-${n}`,
    clientId: 'client-1',
    clientName: 'Alpha Ortho Group',
    clientAddress: { line1: '100 Main St', city: 'Austin', state: 'TX', zip: '78701' },
    clientNpiGroup: '1234567890',
    providerName: 'Dr. Smith',
    providerNpi: '1111111111',
    payerId: 'payer-1',
    payerName: 'United Commercial',
    appealAddress: 'PO Box 100, Hartford, CT 06101',
    portalUrl: 'https://portal.example.com',
    patientFirstName: 'Jane',
    patientLastName: 'Doe',
    patientDob: '1980-05-01',
    patientMrn: 'MRN001',
    claimId: `claim-${n}`,
    claimNumberInternal: `CLM-${n}`,
    claimNumberPayer: `ICN-${n}`,
    dateOfService: '2026-06-01',
    submissionDate: '2026-06-05',
    authorizationNumber: 'AUTH-42',
    claimLines: [{
      claimLineId: `line-${n}`, lineNumber: 1, procedureCode: '99213',
      modifiers: [], units: 1, billedAmount: 250,
      expectedAmount: 125, paidAmount: 0, denialReasonCode: 'CO-197',
    }],
    remitLines: [{
      procedureCode: '99213', billedAmount: 250, allowedAmount: 125, paidAmount: 0,
      adjustmentGroupCode: 'CO', adjustmentReasonCode: '197',
      checkDate: '2026-06-25', checkNumber: 'CHK-1',
    }],
    contract: {
      feeScheduleType: 'fee_schedule', effectiveDate: '2026-01-01',
      lines: [{ procedureCode: '99213', modifier: null, allowedAmount: 125, percentOfMedicare: null }],
    },
    existingDocuments: [],
    autopilotEnabled: false,
    priorCategoryCaseCount: 3,
    priorPacketCount: 0,
    clientReviewThreshold: null,
    existingDraftPacketId: null,
    asOf: '2026-07-05',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// letter generator
// ---------------------------------------------------------------------------

describe('appeal letter generator', () => {
  it('has the full letter structure', () => {
    const letter = generateAppealLetter(ctx(), ['eob.txt', 'claim-lines.txt']);
    const c = letter.content;
    // 1. header
    assert.match(c, /Alpha Ortho Group/);
    assert.match(c, /NPI: 1111111111/);
    assert.match(c, /100 Main St/);
    assert.match(c, /2026-07-05/);
    // 2. payer + appeal address
    assert.match(c, /United Commercial/);
    assert.match(c, /Attn: Appeals Department/);
    assert.match(c, /PO Box 100/);
    // 3. RE line
    assert.match(c, /Patient:\s+Jane Doe/);
    assert.match(c, /Date of birth:\s+1980-05-01/);
    assert.match(c, /Date of service:\s+2026-06-01/);
    assert.match(c, /Amount in dispute: \$125\.00/);
    // 6. closing with deadline
    assert.match(c, /appeal deadline of 2026-12-22/);
    // 7. signature
    assert.match(c, /Sincerely,/);
    // 8. attachments
    assert.match(c, /Enclosures:/);
    assert.match(c, /1\. eob\.txt/);
    assert.match(c, /2\. claim-lines\.txt/);
  });

  it('authorization body references the auth number', () => {
    const c = generateAppealLetter(ctx(), []).content;
    assert.match(c, /Authorization number AUTH-42 was issued/);
    assert.match(c, /request payment of this claim in accordance with the authorization/);
  });

  it('medical necessity body cites clinical guidelines and requests reconsideration', () => {
    const c = generateAppealLetter(ctx({
      denialCategory: 'clinical_medical_necessity', denialReasonCode: 'CO-50',
    }), []).content;
    assert.match(c, /medically necessary/);
    assert.match(c, /clinical guidelines/);
    assert.match(c, /reconsideration of this claim with the enclosed clinical documentation/);
  });

  it('bundling body cites the modifier and CMS NCCI guidance', () => {
    const c = generateAppealLetter(ctx({
      denialCategory: 'bundling', denialReasonCode: 'CO-97',
      claimLines: [{
        claimLineId: 'l1', lineNumber: 1, procedureCode: '29881', modifiers: ['59'],
        units: 1, billedAmount: 900, expectedAmount: 600, paidAmount: 0,
        denialReasonCode: 'CO-97',
      }],
    }), []).content;
    assert.match(c, /Modifier\(s\) 59/);
    assert.match(c, /distinct/);
    assert.match(c, /National Correct Coding Initiative \(NCCI\)/);
  });

  it('underpayment body shows the contract rate vs paid calculation', () => {
    const c = generateAppealLetter(ctx({
      caseType: 'underpayment', denialCategory: null, denialReasonCode: null,
      recoveryOpportunity: 45, expectedAmount: 125, paidAmount: 80,
      claimLines: [{
        claimLineId: 'l1', lineNumber: 1, procedureCode: '99213', modifiers: [],
        units: 1, billedAmount: 250, expectedAmount: 125, paidAmount: 80,
        denialReasonCode: null,
      }],
    }), []).content;
    assert.match(c, /below the rate set by the participation agreement/);
    assert.match(c, /contracted rate \$125\.00, paid \$80\.00, underpayment \$45\.00/);
    assert.match(c, /Amount owed: \$45\.00/);
    assert.match(c, /corrected payment of \$45\.00/);
  });

  it('timely filing body references the original submission date', () => {
    const c = generateAppealLetter(ctx({
      denialCategory: 'timely_filing', denialReasonCode: 'CO-29',
    }), []).content;
    assert.match(c, /originally submitted on 2026-06-05/);
    assert.match(c, /proof of timely filing/);
    assert.match(c, /timely filing policy/);
  });

  it('duplicate body references the original claim number and DOS', () => {
    const c = generateAppealLetter(ctx({
      denialCategory: 'duplicate', denialReasonCode: 'CO-18', claimNumberInternal: 'CLM-DUP',
    }), []).content;
    assert.match(c, /not duplicative/);
    assert.match(c, /claim number CLM-DUP/);
    assert.match(c, /processed as a separate service/);
  });

  it('coding body cites CPT guidelines and modifier rationale', () => {
    const c = generateAppealLetter(ctx({
      denialCategory: 'coding', denialReasonCode: 'CO-4',
      claimLines: [{
        claimLineId: 'l1', lineNumber: 1, procedureCode: '99213', modifiers: ['25'],
        units: 1, billedAmount: 250, expectedAmount: 125, paidAmount: 0,
        denialReasonCode: 'CO-4',
      }],
    }), []).content;
    assert.match(c, /CPT guidelines/);
    assert.match(c, /modifier guidance/);
  });

  it('maps categories to templates, with underpayment fallback by case type', () => {
    assert.equal(letterCategory(ctx({ denialCategory: 'contractual' })), 'underpayment');
    assert.equal(letterCategory(ctx({ denialCategory: null, caseType: 'underpayment' })), 'underpayment');
    assert.equal(letterCategory(ctx({ denialCategory: 'coordination_of_benefits' })), 'general');
  });
});

// ---------------------------------------------------------------------------
// corrected claim generator
// ---------------------------------------------------------------------------

describe('corrected claim generator', () => {
  const coding = (code: string, over: Partial<AppealCaseContext> = {}) =>
    ctx({ denialCategory: 'coding', denialReasonCode: code, ...over });

  it('non-correction codes return null', () => {
    assert.equal(generateCorrection(ctx({ denialReasonCode: 'CO-50' })), null);
    assert.equal(generateCorrection(ctx({ denialReasonCode: null })), null);
  });

  it('CO-4 on an E/M with a same-day procedure adds modifier 25 at confidence 90', () => {
    const c = generateCorrection(coding('CO-4', {
      claimLineId: 'em-line',
      claimLines: [
        { claimLineId: 'em-line', lineNumber: 1, procedureCode: '99213', modifiers: [],
          units: 1, billedAmount: 250, expectedAmount: 125, paidAmount: 0, denialReasonCode: 'CO-4' },
        { claimLineId: 'proc-line', lineNumber: 2, procedureCode: '20610', modifiers: [],
          units: 1, billedAmount: 300, expectedAmount: 180, paidAmount: 180, denialReasonCode: null },
      ],
    }))!;
    assert.deepEqual(c.correctedFields.modifiers, ['25']);
    assert.equal(c.confidenceScore, 90);
    assert.equal(c.needsManualReview, false);
    assert.match(c.reason, /modifier 25/);
    assert.deepEqual(c.originalFields.modifiers, []);
  });

  it('CO-4 with a paid sibling suggests 59 at confidence 75 -> manual review', () => {
    const c = generateCorrection(coding('CO-4', {
      claimLineId: 'denied-line',
      claimLines: [
        { claimLineId: 'denied-line', lineNumber: 1, procedureCode: '29881', modifiers: [],
          units: 1, billedAmount: 900, expectedAmount: 600, paidAmount: 0, denialReasonCode: 'CO-4' },
        { claimLineId: 'paid-line', lineNumber: 2, procedureCode: '29880', modifiers: [],
          units: 1, billedAmount: 1200, expectedAmount: 800, paidAmount: 800, denialReasonCode: null },
      ],
    }))!;
    assert.deepEqual(c.correctedFields.modifiers, ['59']);
    assert.equal(c.confidenceScore, 75);
    assert.equal(c.needsManualReview, true);
  });

  it('CO-4 with no context suggests 59 at confidence 60 -> manual review', () => {
    const c = generateCorrection(coding('CO-4'))!;
    assert.equal(c.confidenceScore, 60);
    assert.equal(c.needsManualReview, true);
  });

  it('CO-5 strips inconsistent modifiers at confidence 70 -> manual review', () => {
    const c = generateCorrection(coding('CO-5', {
      claimLines: [{
        claimLineId: ctx().claimLineId!, lineNumber: 1, procedureCode: '99213',
        modifiers: ['50'], units: 1, billedAmount: 250, expectedAmount: 125,
        paidAmount: 0, denialReasonCode: 'CO-5',
      }],
    }))!;
    assert.deepEqual(c.correctedFields.modifiers, []);
    assert.equal(c.needsManualReview, true);
    assert.match(c.reason, /inconsistent/);
  });
});

// ---------------------------------------------------------------------------
// document assembly + routing
// ---------------------------------------------------------------------------

describe('document assembly', () => {
  it('always includes EOB and claim-lines documents', () => {
    const plan = buildDocumentPlan(ctx(), null);
    const types = plan.documents.map((d) => d.documentType);
    assert.ok(types.includes('eob'));
    assert.ok(types.includes('other')); // claim lines summary
  });

  it('authorization: generates an attestation from the auth number when no doc uploaded', () => {
    const plan = buildDocumentPlan(ctx(), null);
    const auth = plan.documents.find((d) => d.documentType === 'authorization')!;
    assert.equal(auth.kind, 'generate');
    assert.match((auth as any).content, /AUTH-42/);
    assert.equal(plan.packetStatus, 'ready');
  });

  it('authorization without auth number or doc -> draft with missing type', () => {
    const plan = buildDocumentPlan(ctx({ authorizationNumber: null }), null);
    assert.equal(plan.packetStatus, 'draft');
    assert.deepEqual(plan.missingDocumentTypes, ['authorization']);
  });

  it('medical necessity requires an uploaded medical record — never fabricated', () => {
    const missing = buildDocumentPlan(ctx({
      denialCategory: 'clinical_medical_necessity', denialReasonCode: 'CO-50',
    }), null);
    assert.equal(missing.packetStatus, 'draft');
    assert.deepEqual(missing.missingDocumentTypes, ['medical_record']);

    const withDoc = buildDocumentPlan(ctx({
      denialCategory: 'clinical_medical_necessity', denialReasonCode: 'CO-50',
      existingDocuments: [{ documentId: 'doc-1', documentType: 'medical_record', fileName: 'op-note.pdf' }],
    }), null);
    assert.equal(withDoc.packetStatus, 'ready');
    assert.ok(withDoc.documents.some((d) => d.kind === 'existing' && d.documentId === 'doc-1'));
  });

  it('underpayment: contract excerpt generated from contract lines', () => {
    const plan = buildDocumentPlan(ctx({
      caseType: 'underpayment', denialCategory: null, denialReasonCode: null,
    }), null);
    const excerpt = plan.documents.find((d) => d.documentType === 'contract')!;
    assert.equal(excerpt.kind, 'generate');
    assert.match((excerpt as any).content, /99213: contracted rate \$125\.00/);
    assert.equal(plan.packetStatus, 'ready');
  });

  it('underpayment with no contract -> draft', () => {
    const plan = buildDocumentPlan(ctx({
      caseType: 'underpayment', denialCategory: null, denialReasonCode: null, contract: null,
    }), null);
    assert.equal(plan.packetStatus, 'draft');
    assert.deepEqual(plan.missingDocumentTypes, ['contract']);
  });

  it('timely filing: proof generated from submission date', () => {
    const plan = buildDocumentPlan(ctx({
      denialCategory: 'timely_filing', denialReasonCode: 'CO-29',
    }), null);
    const proof = plan.documents.find(
      (d) => d.kind === 'generate' && d.fileName.startsWith('timely-filing-proof'),
    )!;
    assert.match((proof as any).content, /Original submission date: 2026-06-05/);
    assert.equal(plan.packetStatus, 'ready');
  });

  it('appeal type: corrected_claim > second_level > first_level', () => {
    assert.equal(buildDocumentPlan(ctx(), null).appealType, 'first_level');
    assert.equal(buildDocumentPlan(ctx({ priorPacketCount: 1 }), null).appealType, 'second_level');
    const correction = generateCorrection(ctx({
      denialCategory: 'coding', denialReasonCode: 'CO-4',
    }))!;
    assert.equal(
      buildDocumentPlan(ctx({ denialReasonCode: 'CO-4' }), correction).appealType,
      'corrected_claim',
    );
  });

  it('submission method: clearinghouse for corrections, portal when available, else mail', () => {
    const correction = generateCorrection(ctx({ denialCategory: 'coding', denialReasonCode: 'CO-4' }))!;
    assert.equal(buildDocumentPlan(ctx(), correction).submissionMethod, 'clearinghouse');
    assert.equal(buildDocumentPlan(ctx(), null).submissionMethod, 'portal');
    assert.equal(buildDocumentPlan(ctx({ portalUrl: null }), null).submissionMethod, 'mail');
  });

  it('auto_submit: autopilot + electronic + confidence >= 0.85 + no review flags', () => {
    const auto = buildDocumentPlan(ctx({ autopilotEnabled: true }), null);
    assert.equal(auto.autoSubmit, true);
    assert.equal(auto.needsReview, false);

    // not electronic
    assert.equal(buildDocumentPlan(ctx({ autopilotEnabled: true, portalUrl: null }), null).autoSubmit, false);
    // low confidence
    assert.equal(buildDocumentPlan(ctx({ autopilotEnabled: true, confidenceScore: 0.7 }), null).autoSubmit, false);
    // autopilot off
    assert.equal(buildDocumentPlan(ctx(), null).autoSubmit, false);
  });

  it('needs_review: medical necessity always', () => {
    const plan = buildDocumentPlan(ctx({
      denialCategory: 'clinical_medical_necessity', denialReasonCode: 'CO-50',
      existingDocuments: [{ documentId: 'd', documentType: 'medical_record', fileName: 'n.pdf' }],
      autopilotEnabled: true,
    }), null);
    assert.equal(plan.needsReview, true);
    assert.equal(plan.autoSubmit, false); // review always wins over autopilot
    assert.match(plan.needsReviewReasons[0], /medical necessity/);
  });

  it('needs_review: recovery above client threshold', () => {
    const plan = buildDocumentPlan(ctx({ recoveryOpportunity: 8000, clientReviewThreshold: 5000 }), null);
    assert.equal(plan.needsReview, true);
    assert.match(plan.needsReviewReasons.join(' '), /exceeds client review threshold/);
  });

  it('needs_review: new denial pattern (no prior history for payer+category)', () => {
    const plan = buildDocumentPlan(ctx({ priorCategoryCaseCount: 0 }), null);
    assert.equal(plan.needsReview, true);
    assert.match(plan.needsReviewReasons.join(' '), /new denial pattern/);
  });

  it('needs_review: confidence below 0.85', () => {
    const plan = buildDocumentPlan(ctx({ confidenceScore: 0.6 }), null);
    assert.equal(plan.needsReview, true);
    assert.match(plan.needsReviewReasons.join(' '), /below 85/);
  });

  it('needs_review: correction below confidence 85', () => {
    const correction = generateCorrection(ctx({ denialCategory: 'coding', denialReasonCode: 'CO-4' }))!;
    const plan = buildDocumentPlan(ctx({ denialReasonCode: 'CO-4' }), correction);
    assert.equal(plan.needsReview, true);
    assert.match(plan.needsReviewReasons.join(' '), /coder review/);
  });
});

// ---------------------------------------------------------------------------
// queue action strings
// ---------------------------------------------------------------------------

describe('submission queue actions', () => {
  it('review beats auto-submit beats manual', () => {
    assert.match(requiredAction({
      autoSubmit: true, needsReview: true,
      needsReviewReasons: ['medical necessity appeal requires clinical review'],
      submissionMethod: 'portal',
    }), /^review required: medical necessity/);
    assert.equal(requiredAction({
      autoSubmit: true, needsReview: false, needsReviewReasons: [], submissionMethod: 'portal',
    }), 'auto-submit via portal');
    assert.equal(requiredAction({
      autoSubmit: false, needsReview: false, needsReviewReasons: [], submissionMethod: 'mail',
    }), 'submit manually via mail');
  });
});
