// ============================================================================
// NCCI procedure-to-procedure edit checking — all pure.
//
// A CO-97 bundling denial used to produce one recommendation regardless of
// what CMS actually publishes: "verify NCCI edits; appeal with modifier 59".
// These cases are the four situations that advice conflates, plus the two
// where the honest answer is that we cannot tell yet.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runEngine } from '../src/engine.ts';
import { evaluateNcci, NCCI_BYPASS_MODIFIERS } from '../src/steps/ncci.ts';
import { AS_OF, CLIENT, PAYER, baseInput, claim, claimLine, remitLine } from './fixtures.ts';
import type {
  EngineInput, NcciDatasetInput, NcciEditInput, NcciBundlingPolicy,
} from '../src/types.ts';

const PRACTITIONER: NcciDatasetInput = {
  serviceSetting: 'practitioner', version: '2026-Q2', effectiveDate: '2026-04-01',
};

function edit(overrides: Partial<NcciEditInput> = {}): NcciEditInput {
  return {
    serviceSetting: 'practitioner',
    columnOneCode: '11042',
    columnTwoCode: '97597',
    effectiveDate: '2020-01-01',
    deletionDate: null,
    modifierIndicator: 1,
    ...overrides,
  };
}

/**
 * A claim whose line 2 (97597) was denied CO-97 while line 1 (11042) was paid
 * — the shape every bundling denial takes.
 */
function bundlingScenario(opts: {
  edits?: NcciEditInput[];
  datasets?: NcciDatasetInput[];
  modifiers?: string[];
  dateOfService?: string;
  claimType?: 'professional' | 'facility';
  bundlingEditSource?: 'ncci' | 'proprietary';
  policy?: NcciBundlingPolicy;
  siblingPaid?: number;
} = {}): EngineInput {
  const primary = claimLine({
    lineNumber: 1, procedureCode: '11042', billedAmount: 300,
    paidAmount: opts.siblingPaid ?? 220,
  });
  const denied = claimLine({
    lineNumber: 2, procedureCode: '97597', billedAmount: 250,
    modifiers: opts.modifiers ?? [], paidAmount: 0,
  });
  const c = claim({
    claimNumberPayer: 'ICN-NCCI',
    claimType: opts.claimType ?? 'professional',
    dateOfServiceStart: opts.dateOfService ?? '2026-06-01',
    lines: [primary, denied],
  });
  const r = remitLine({
    payerClaimNumber: 'ICN-NCCI', procedureCode: '97597',
    billedAmount: 250, allowedAmount: 0, paidAmount: 0,
    adjustmentGroupCode: 'CO', adjustmentReasonCode: '97',
    adjustments: [{ groupCode: 'CO', reasonCode: '97', amount: 250 }],
  });
  return baseInput({
    payers: [{
      payerId: PAYER, payerName: 'Test Payer',
      appealDeadlineDays: 180, timelyFilingLimitDays: 90,
      bundlingEditSource: opts.bundlingEditSource ?? 'ncci',
    }],
    claims: [c],
    remitLines: [r],
    contracts: [{
      contractId: 'contract-ncci', clientId: CLIENT, payerId: PAYER,
      effectiveDate: '2026-01-01', expirationDate: null,
      feeScheduleType: 'fee_schedule',
      lines: [
        { procedureCode: '11042', modifier: null, allowedAmount: 220 },
        { procedureCode: '97597', modifier: null, allowedAmount: 200 },
      ],
    }],
    ncciEdits: opts.edits ?? [],
    ncciDatasets: opts.datasets ?? [PRACTITIONER],
    ncciBundlingPolicyByClient: { [CLIENT]: opts.policy ?? 'advisory' },
  });
}

const assess = (input: EngineInput) =>
  evaluateNcci(input, input.claims[0], input.claims[0].lines[1]);

describe('NCCI reference coverage', () => {
  it('will not conclude anything when no CMS table is loaded', () => {
    const a = assess(bundlingScenario({ datasets: [] }));
    assert.equal(a.finding, 'no_reference_data');
    assert.equal(a.appealSupported, false);
    assert.equal(a.scoreAdjustment, 0);
    assert.match(a.explanation, /no CMS NCCI practitioner table is loaded/);
    // The advice falls back to the previous behavior rather than a guess.
    assert.match(a.recommendedAction, /manually/);
  });

  it('will not read a later quarter back onto an earlier service', () => {
    // "CMS publishes no edit for this pair" and "the file we loaded starts
    // after this date of service" are different statements. Reporting the
    // second as the first would recommend a confident appeal on no evidence.
    const a = assess(bundlingScenario({
      datasets: [{ ...PRACTITIONER, effectiveDate: '2026-07-01' }],
      dateOfService: '2026-06-01',
    }));
    assert.equal(a.finding, 'reference_predates_service');
    assert.equal(a.appealSupported, false);
  });

  it('uses the outpatient-hospital table for a facility claim', () => {
    const a = assess(bundlingScenario({
      claimType: 'facility',
      datasets: [PRACTITIONER],
      edits: [edit({ modifierIndicator: 0 })],
    }));
    // Only the practitioner table is loaded, so a facility claim is unanswered
    // rather than answered from the wrong table.
    assert.equal(a.serviceSetting, 'outpatient_hospital');
    assert.equal(a.finding, 'no_reference_data');
  });

  it('answers a facility claim from the outpatient-hospital table', () => {
    const a = assess(bundlingScenario({
      claimType: 'facility',
      datasets: [{
        serviceSetting: 'outpatient_hospital', version: '2026-Q2',
        effectiveDate: '2026-04-01',
      }],
      edits: [edit({ serviceSetting: 'outpatient_hospital', modifierIndicator: 0 })],
    }));
    assert.equal(a.finding, 'never_separately_payable');
  });
});

describe('NCCI edit findings', () => {
  it('indicator 0 means the appeal cannot be won, and says so', () => {
    const a = assess(bundlingScenario({ edits: [edit({ modifierIndicator: 0 })] }));
    assert.equal(a.finding, 'never_separately_payable');
    assert.equal(a.appealSupported, false);
    assert.equal(a.likelihood, 'low');
    assert.ok(a.scoreAdjustment < 0);
    assert.equal(a.primaryCode, '11042');
    assert.match(a.recommendedAction, /Do not appeal/);
  });

  it('indicator 0 is not overridden by a bypass modifier being on the line', () => {
    // The whole point of indicator 0 is that no modifier helps. Billing 59
    // against one is itself a coding problem, not an appeal.
    const a = assess(bundlingScenario({
      edits: [edit({ modifierIndicator: 0 })], modifiers: ['59'],
    }));
    assert.equal(a.finding, 'never_separately_payable');
    assert.equal(a.appealSupported, false);
  });

  it('indicator 1 with the override already billed is a strong appeal', () => {
    const a = assess(bundlingScenario({
      edits: [edit({ modifierIndicator: 1 })], modifiers: ['XU'],
    }));
    assert.equal(a.finding, 'override_billed_and_ignored');
    assert.equal(a.likelihood, 'high');
    assert.ok(a.scoreAdjustment > 0);
    assert.deepEqual(a.bypassModifiersBilled, ['XU']);
    assert.match(a.recommendedAction, /XU was billed/);
  });

  it('indicator 1 with no override billed points at a corrected claim', () => {
    const a = assess(bundlingScenario({ edits: [edit({ modifierIndicator: 1 })] }));
    assert.equal(a.finding, 'override_available');
    assert.equal(a.likelihood, 'medium');
    assert.equal(a.scoreAdjustment, 0);
    assert.match(a.recommendedAction, /corrected\s+claim/);
  });

  it('does not treat a modifier CMS has no PTP association with as an override', () => {
    // 50 (bilateral) changes the payment percentage; it does not bypass a
    // bundling edit. Treating it as one would produce a confident appeal
    // recommendation that loses.
    assert.equal(NCCI_BYPASS_MODIFIERS.has('50'), false);
    const a = assess(bundlingScenario({
      edits: [edit({ modifierIndicator: 1 })], modifiers: ['50'],
    }));
    assert.equal(a.finding, 'override_available');
    assert.deepEqual(a.bypassModifiersBilled, []);
  });

  it('indicator 9 means the edit does not apply', () => {
    const a = assess(bundlingScenario({ edits: [edit({ modifierIndicator: 9 })] }));
    assert.equal(a.finding, 'edit_not_in_force');
    assert.equal(a.likelihood, 'high');
  });

  it('an edit deleted before the service was never in force for it', () => {
    const a = assess(bundlingScenario({
      edits: [edit({ effectiveDate: '2018-01-01', deletionDate: '2024-12-31' })],
      dateOfService: '2026-06-01',
    }));
    assert.equal(a.finding, 'edit_not_in_force');
    assert.match(a.explanation, /did not apply to a service on 2026-06-01/);
  });

  it('an edit effective after the service was not in force either', () => {
    const a = assess(bundlingScenario({
      edits: [edit({ effectiveDate: '2026-10-01' })],
      dateOfService: '2026-06-01',
    }));
    assert.equal(a.finding, 'edit_not_in_force');
  });

  it('no published edit contradicts a payer that adjudicates on NCCI', () => {
    const a = assess(bundlingScenario({ edits: [] }));
    assert.equal(a.finding, 'no_edit_published');
    assert.equal(a.likelihood, 'high');
    assert.equal(a.appealSupported, true);
    assert.match(a.explanation, /contradicts the edit tables/);
  });

  it('no published edit is weaker against a payer running proprietary edits', () => {
    const a = assess(bundlingScenario({ edits: [], bundlingEditSource: 'proprietary' }));
    assert.equal(a.finding, 'no_edit_published');
    assert.equal(a.likelihood, 'medium');
    assert.match(a.recommendedAction, /rationale/);
  });

  it('ignores an edit whose column-one code was not paid on this claim', () => {
    // A bundling denial asserts payment for ANOTHER service covers this one.
    // An edit against a procedure the payer did not pay cannot be the reason.
    const a = assess(bundlingScenario({
      edits: [edit({ columnOneCode: '29580' })],
    }));
    assert.equal(a.finding, 'no_edit_published');
  });

  it('the most restrictive live edit governs when several apply', () => {
    const a = assess(bundlingScenario({
      edits: [edit({ modifierIndicator: 1 }), edit({ modifierIndicator: 0 })],
    }));
    assert.equal(a.finding, 'never_separately_payable');
  });
});

describe('NCCI findings reaching the case', () => {
  const bundlingCase = (r: ReturnType<typeof runEngine>) =>
    r.casesCreated.find((c) => c.caseType === 'bundling');

  it('carries the recommendation and the evidence onto the case', () => {
    const r = runEngine(bundlingScenario({
      edits: [edit({ modifierIndicator: 1 })], modifiers: ['59'],
    }));
    const c = bundlingCase(r);
    assert.ok(c, 'expected a bundling case');
    assert.match(c!.recommendedAction, /modifier 59 was billed/);
    assert.match(c!.evidenceNote ?? '', /modifier indicator 1/);
    assert.equal(c!.recoveryLikelihood, 'high');
  });

  it('scores an unappealable bundle below one the payer got wrong', () => {
    const hopeless = runEngine(bundlingScenario({
      edits: [edit({ modifierIndicator: 0 })],
    }));
    const winnable = runEngine(bundlingScenario({
      edits: [edit({ modifierIndicator: 1 })], modifiers: ['59'],
    }));
    const a = bundlingCase(hopeless)!;
    const b = bundlingCase(winnable)!;
    assert.ok(a.appealabilityScore < b.appealabilityScore,
      `expected ${a.appealabilityScore} < ${b.appealabilityScore}`);
    assert.equal(a.recoveryLikelihood, 'low');
  });

  it('still opens the unappealable case under the default advisory policy', () => {
    const r = runEngine(bundlingScenario({ edits: [edit({ modifierIndicator: 0 })] }));
    assert.ok(bundlingCase(r), 'advisory policy keeps the case, with the warning on it');
    assert.equal(
      r.skipped.filter((s) => s.reason === 'ncci_not_separately_payable').length, 0);
  });

  it('suppresses it when the client asked for that', () => {
    const r = runEngine(bundlingScenario({
      edits: [edit({ modifierIndicator: 0 })], policy: 'suppress_unappealable',
    }));
    assert.equal(bundlingCase(r), undefined);
    const s = r.skipped.filter((x) => x.reason === 'ncci_not_separately_payable');
    assert.equal(s.length, 1);
    assert.ok(s[0].recoveryOpportunity > 0, 'the amount is still reported, just not worked');
  });

  it('never suppresses a bundle the payer got wrong', () => {
    const r = runEngine(bundlingScenario({
      edits: [edit({ modifierIndicator: 1 })], modifiers: ['59'],
      policy: 'suppress_unappealable',
    }));
    assert.ok(bundlingCase(r));
  });

  it('leaves non-bundling denials untouched', () => {
    const input = bundlingScenario({ edits: [edit({ modifierIndicator: 0 })] });
    // A CO-97 with no paid sibling line is coding, not bundling, and never
    // reaches the NCCI tables.
    input.claims[0].lines[0].paidAmount = 0;
    input.claims[0].lines[1].paidAmount = 0;
    const r = runEngine(input);
    assert.equal(r.casesCreated.some((c) => c.caseType === 'bundling'), false);
    assert.ok(r.casesCreated.length > 0, 'the denial is still worked, just not as bundling');
  });
});

describe('AS_OF sanity', () => {
  it('fixtures sit inside the engine as-of window', () => {
    assert.equal(AS_OF, '2026-07-01');
  });
});
