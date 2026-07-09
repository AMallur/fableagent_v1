import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runEngine } from '../src/engine.ts';
import { normalizeDenialCode, classifyDenial } from '../src/taxonomy.ts';
import {
  AS_OF, CLIENT, PAYER, baseInput, claim, claimLine, matchedScenario, remitLine,
} from './fixtures.ts';

// ---------------------------------------------------------------------------
// STEP 1 — matching
// ---------------------------------------------------------------------------
describe('step 1: claim-remit matching', () => {
  it('matches by payer claim number', () => {
    const input = matchedScenario({ contractRate: 125, paid: 125 });
    const out = runEngine(input);
    assert.equal(out.matches.length, 1);
    assert.equal(out.matches[0].method, 'payer_claim_number');
    assert.equal(out.matches[0].claimId, input.claims[0].claimId);
    assert.equal(out.matches[0].claimLineId, input.claims[0].lines[0].claimLineId);
    assert.equal(out.unmatchedRemitLines.length, 0);
  });

  it('falls back to patient + DOS + procedure + billed amount', () => {
    const c = claim({ claimNumberPayer: null });
    const input = baseInput({
      claims: [c],
      remitLines: [remitLine({
        payerClaimNumber: 'UNKNOWN-ICN',
        patientMemberId: 'MEM123',
        dateOfService: '2026-06-01',
        procedureCode: '99213',
        billedAmount: 250,
        paidAmount: 250,
      })],
    });
    const out = runEngine(input);
    assert.equal(out.matches.length, 1);
    assert.equal(out.matches[0].method, 'patient_dos_proc_amount');
  });

  it('flags unmatched remit lines for manual review', () => {
    const input = baseInput({
      claims: [claim()],
      remitLines: [remitLine({
        payerClaimNumber: 'NO-SUCH-ICN',
        patientMemberId: 'WRONG-MEMBER',
        dateOfService: '2026-06-01',
      })],
    });
    const out = runEngine(input);
    assert.equal(out.matches.length, 0);
    assert.equal(out.unmatchedRemitLines.length, 1);
    assert.equal(out.unmatchedRemitLines[0].method, 'unmatched');
  });

  it('updates claim status: denied when nothing paid with a denial CARC', () => {
    const input = matchedScenario({ contractRate: 125, paid: 0, carc: '50', group: 'CO' });
    const out = runEngine(input);
    assert.deepEqual(
      out.claimStatusUpdates.map((u) => u.toStatus), ['denied'],
    );
  });

  it('updates claim status: underpaid when paid below contract', () => {
    const input = matchedScenario({ contractRate: 125, paid: 80 });
    const out = runEngine(input);
    assert.deepEqual(out.claimStatusUpdates.map((u) => u.toStatus), ['underpaid']);
  });

  it('updates claim status: paid when paid at contract', () => {
    const input = matchedScenario({ contractRate: 125, paid: 125 });
    const out = runEngine(input);
    assert.deepEqual(out.claimStatusUpdates.map((u) => u.toStatus), ['paid']);
  });
});

// ---------------------------------------------------------------------------
// STEP 2 — expected reimbursement
// ---------------------------------------------------------------------------
describe('step 2: expected reimbursement', () => {
  it('fee_schedule: expected = contract line allowed_amount * units', () => {
    const line = claimLine({ units: 2 });
    const c = claim({ claimNumberPayer: 'ICN-9', lines: [line] });
    const input = baseInput({
      claims: [c],
      remitLines: [remitLine({ payerClaimNumber: 'ICN-9', paidAmount: 250 })],
      contracts: [{
        contractId: 'ct-1', clientId: CLIENT, payerId: PAYER,
        effectiveDate: '2026-01-01', expirationDate: null,
        feeScheduleType: 'fee_schedule',
        lines: [{ procedureCode: '99213', modifier: null, allowedAmount: 125 }],
      }],
    });
    const out = runEngine(input);
    const priced = out.pricing.find((p) => p.claimLineId === line.claimLineId)!;
    assert.equal(priced.expectedAmount, 250);
    assert.equal(priced.expectedSource, 'contract');
    assert.equal(priced.noContract, false);
  });

  it('percent_of_medicare: expected = medicare rate * percent', () => {
    const input = baseInput({
      claims: [claim({ claimNumberPayer: 'ICN-9' })],
      remitLines: [remitLine({ payerClaimNumber: 'ICN-9', paidAmount: 100 })],
      contracts: [{
        contractId: 'ct-1', clientId: CLIENT, payerId: PAYER,
        effectiveDate: '2026-01-01', expirationDate: null,
        feeScheduleType: 'percent_of_medicare',
        lines: [{ procedureCode: '99213', modifier: null, percentOfMedicare: 145 }],
      }],
      medicareRates: { '99213|': 100 },
    });
    const out = runEngine(input);
    assert.equal(out.pricing[0].expectedAmount, 145);
    assert.equal(out.pricing[0].expectedSource, 'contract');
  });

  it('no contract: Medicare proxy, flagged no_contract', () => {
    const input = baseInput({
      claims: [claim({ claimNumberPayer: 'ICN-9' })],
      remitLines: [remitLine({ payerClaimNumber: 'ICN-9', paidAmount: 10 })],
      medicareRates: { '99213|': 90 },
    });
    const out = runEngine(input);
    assert.equal(out.pricing[0].expectedAmount, 90);
    assert.equal(out.pricing[0].expectedSource, 'medicare_proxy');
    assert.equal(out.pricing[0].noContract, true);
  });

  it('modifier-specific contract rate wins over the generic rate', () => {
    const line = claimLine({ modifiers: ['26'] });
    const input = baseInput({
      claims: [claim({ claimNumberPayer: 'ICN-9', lines: [line] })],
      remitLines: [remitLine({ payerClaimNumber: 'ICN-9', paidAmount: 60 })],
      contracts: [{
        contractId: 'ct-1', clientId: CLIENT, payerId: PAYER,
        effectiveDate: '2026-01-01', expirationDate: null,
        feeScheduleType: 'fee_schedule',
        lines: [
          { procedureCode: '99213', modifier: null, allowedAmount: 125 },
          { procedureCode: '99213', modifier: '26', allowedAmount: 60 },
        ],
      }],
    });
    const out = runEngine(input);
    assert.equal(out.pricing[0].expectedAmount, 60);
  });

  it('stores expected on the claim line update', () => {
    const input = matchedScenario({ contractRate: 125, paid: 125 });
    const out = runEngine(input);
    assert.equal(out.claimLineUpdates[0].expectedAmount, 125);
    assert.equal(out.claimLineUpdates[0].expectedSource, 'contract');
  });
});

// ---------------------------------------------------------------------------
// STEP 3 — variance detection
// ---------------------------------------------------------------------------
describe('step 3: variance detection', () => {
  it('variance > $25 creates an underpayment case', () => {
    const input = matchedScenario({ contractRate: 125, paid: 80 }); // variance 45
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 1);
    const c = out.casesCreated[0];
    assert.equal(c.caseType, 'underpayment');
    assert.equal(c.recoveryOpportunity, 45);
    assert.equal(c.expectedAmount, 125);
    assert.equal(c.paidAmount, 80);
  });

  it('variance <= $25 and <= 5% does not create a case', () => {
    // expected 1000, paid 980: variance $20 (2%) — flagged, not case-worthy
    const line = claimLine({ billedAmount: 1500 });
    const input = baseInput({
      claims: [claim({ claimNumberPayer: 'ICN-9', lines: [line] })],
      remitLines: [remitLine({ payerClaimNumber: 'ICN-9', billedAmount: 1500, paidAmount: 980 })],
      contracts: [{
        contractId: 'ct-1', clientId: CLIENT, payerId: PAYER,
        effectiveDate: '2026-01-01', expirationDate: null,
        feeScheduleType: 'fee_schedule',
        lines: [{ procedureCode: '99213', modifier: null, allowedAmount: 1000 }],
      }],
    });
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 0);
    // still marked underpaid at the line level
    assert.equal(out.claimLineUpdates[0].lineStatus, 'underpaid');
  });

  it('small dollar variance above 5% triggers on percent', () => {
    // expected 100, paid 90: $10 but 10% -> case-worthy, above $25?? no —
    // recovery is $10 which is below the $25 case minimum, so it is skipped
    // and logged (step 6 threshold), proving both rules act independently
    const input = matchedScenario({ contractRate: 100, paid: 90 });
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 0);
    assert.equal(out.skipped.length, 1);
    assert.equal(out.skipped[0].reason, 'below_threshold');
  });

  it('zero variance: no case, no flag', () => {
    const input = matchedScenario({ contractRate: 125, paid: 125 });
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 0);
    assert.equal(out.skipped.length, 0);
  });

  it('a denial code routes to classification instead of plain underpayment', () => {
    const input = matchedScenario({ contractRate: 125, paid: 0, carc: '197', group: 'CO' });
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 1);
    assert.equal(out.casesCreated[0].caseType, 'authorization');
    assert.equal(out.casesCreated[0].denialReasonCode, 'CO-197');
  });

  it('CO-45 (contractual) with full payment does not create a case', () => {
    const input = matchedScenario({ contractRate: 125, paid: 125, carc: '45', group: 'CO' });
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 0);
  });

  it('CO-45 with payment below contract becomes an underpayment case', () => {
    const input = matchedScenario({ contractRate: 125, paid: 60, carc: '45', group: 'CO' });
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 1);
    assert.equal(out.casesCreated[0].caseType, 'underpayment');
    assert.equal(out.casesCreated[0].denialCategory, 'contractual');
    assert.equal(out.casesCreated[0].recoveryOpportunity, 65);
  });
});

// ---------------------------------------------------------------------------
// STEP 4 — denial classification
// ---------------------------------------------------------------------------
describe('step 4: denial classification', () => {
  it('normalizes code formats', () => {
    assert.equal(normalizeDenialCode('45', 'CO'), 'CO-45');
    assert.equal(normalizeDenialCode('CO45'), 'CO-45');
    assert.equal(normalizeDenialCode('co-45'), 'CO-45');
    assert.equal(normalizeDenialCode('B7', 'CO'), 'CO-B7');
    assert.equal(normalizeDenialCode(null), null);
  });

  it('maps the taxonomy: category, case type, action', () => {
    for (const [code, category, caseType] of [
      ['CO-50', 'clinical_medical_necessity', 'denial'],
      ['CO-197', 'authorization', 'authorization'],
      ['CO-4', 'coding', 'denial'],
      ['CO-29', 'timely_filing', 'timely_filing'],
      ['CO-18', 'duplicate', 'duplicate'],
      ['CO-22', 'coordination_of_benefits', 'denial'],
      ['CO-27', 'patient_eligibility', 'denial'],
    ] as const) {
      const cls = classifyDenial(code);
      assert.equal(cls.category, category, code);
      assert.equal(cls.caseType, caseType, code);
      assert.ok(cls.recommendedAction.length > 10, code);
    }
  });

  it('CO-97 reclassifies to bundling when a sibling line was paid', () => {
    assert.equal(classifyDenial('CO-97').category, 'coding');
    assert.equal(classifyDenial('CO-97', { siblingLinePaid: true }).category, 'bundling');
    assert.equal(classifyDenial('CO-97', { siblingLinePaid: true }).caseType, 'bundling');
  });

  it('unmapped codes get a manual-review classification, not a crash', () => {
    const cls = classifyDenial('CO-999');
    assert.equal(cls.known, false);
    assert.match(cls.recommendedAction, /manually/);
  });

  it('deadline = check date + payer appeal_deadline_days', () => {
    const input = matchedScenario({ contractRate: 125, paid: 0, carc: '50', group: 'CO' });
    // checkDate 2026-06-25 + 180 days
    const out = runEngine(input);
    assert.equal(out.casesCreated[0].deadlineDate, '2026-12-22');
  });
});

// ---------------------------------------------------------------------------
// STEP 5 — appealability scoring + priority
// ---------------------------------------------------------------------------
describe('step 5: appealability scoring', () => {
  it('auth denial scores high when the auth number exists', () => {
    const withAuth = runEngine(matchedScenario({
      contractRate: 125, paid: 0, carc: '197', group: 'CO', authNumber: 'AUTH-77',
    }));
    const withoutAuth = runEngine(matchedScenario({
      contractRate: 125, paid: 0, carc: '197', group: 'CO',
    }));
    assert.ok(withAuth.casesCreated[0].appealabilityScore >= 70);
    assert.equal(withAuth.casesCreated[0].recoveryLikelihood, 'high');
    assert.ok(
      withAuth.casesCreated[0].appealabilityScore
      > withoutAuth.casesCreated[0].appealabilityScore + 20,
    );
  });

  it('duplicate denial scores high when no true duplicate exists', () => {
    const out = runEngine(matchedScenario({ contractRate: 125, paid: 0, carc: '18', group: 'CO' }));
    assert.ok(out.casesCreated[0].appealabilityScore >= 70);
  });

  it('duplicate denial scores low when a true duplicate exists', () => {
    const input = matchedScenario({ contractRate: 125, paid: 0, carc: '18', group: 'CO' });
    // an identical second claim: same patient, DOS, procedure
    input.claims.push(claim({ claimNumberPayer: 'ICN-OTHER' }));
    const out = runEngine(input);
    assert.ok(out.casesCreated[0].appealabilityScore < 40);
  });

  it('prior win rate lifts the score', () => {
    const base = matchedScenario({ contractRate: 125, paid: 0, carc: '50', group: 'CO' });
    const withHistory = matchedScenario({ contractRate: 125, paid: 0, carc: '50', group: 'CO' });
    withHistory.winRates = [{
      payerId: PAYER, denialCategory: 'clinical_medical_necessity', won: 8, lost: 2,
    }];
    const a = runEngine(base).casesCreated[0].appealabilityScore;
    const b = runEngine(withHistory).casesCreated[0].appealabilityScore;
    assert.equal(b - a, 20); // +15 (>=70% win rate) +5 (a prior win exists)
  });

  it('available supporting documents lift the score', () => {
    const withDocs = runEngine(matchedScenario({
      contractRate: 125, paid: 0, carc: '50', group: 'CO', docs: ['medical_record'],
    }));
    const withoutDocs = runEngine(matchedScenario({
      contractRate: 125, paid: 0, carc: '50', group: 'CO',
    }));
    assert.equal(
      withDocs.casesCreated[0].appealabilityScore
      - withoutDocs.casesCreated[0].appealabilityScore,
      20, // +10 vs -10
    );
  });

  it('priority: critical within 14 days of deadline', () => {
    const input = matchedScenario({ contractRate: 125, paid: 80 });
    input.payers[0].appealDeadlineDays = 16; // check 06-25 + 16d = 07-11, asOf 07-01 -> 10 days
    const out = runEngine(input);
    assert.equal(out.casesCreated[0].priorityLevel, 'critical');
  });

  it('priority: critical when recovery > $5000 regardless of deadline', () => {
    const line = claimLine({ billedAmount: 9000 });
    const input = baseInput({
      claims: [claim({ claimNumberPayer: 'ICN-9', lines: [line] })],
      remitLines: [remitLine({ payerClaimNumber: 'ICN-9', billedAmount: 9000, paidAmount: 100 })],
      contracts: [{
        contractId: 'ct-1', clientId: CLIENT, payerId: PAYER,
        effectiveDate: '2026-01-01', expirationDate: null,
        feeScheduleType: 'fee_schedule',
        lines: [{ procedureCode: '99213', modifier: null, allowedAmount: 6000 }],
      }],
    });
    const out = runEngine(input);
    assert.equal(out.casesCreated[0].priorityLevel, 'critical');
    assert.equal(out.casesCreated[0].recoveryOpportunity, 5900);
  });

  it('priority: high within 30 days or > $1000', () => {
    const input = matchedScenario({ contractRate: 125, paid: 80 });
    input.payers[0].appealDeadlineDays = 33; // ~27 days out from asOf
    const out = runEngine(input);
    assert.equal(out.casesCreated[0].priorityLevel, 'high');
  });

  it('priority: medium within 60 days, low beyond', () => {
    const medium = matchedScenario({ contractRate: 125, paid: 80 });
    medium.payers[0].appealDeadlineDays = 60; // ~54 days out
    assert.equal(runEngine(medium).casesCreated[0].priorityLevel, 'medium');

    const low = matchedScenario({ contractRate: 125, paid: 80 });
    low.payers[0].appealDeadlineDays = 300;
    assert.equal(runEngine(low).casesCreated[0].priorityLevel, 'low');
  });
});

// ---------------------------------------------------------------------------
// STEP 6 — case creation rules
// ---------------------------------------------------------------------------
describe('step 6: case creation rules', () => {
  it('existing open case is updated, not duplicated', () => {
    const input = matchedScenario({ contractRate: 125, paid: 80 });
    input.existingCases = [{
      caseId: 'case-existing',
      claimId: input.claims[0].claimId,
      claimLineId: input.claims[0].lines[0].claimLineId,
      caseType: 'underpayment',
      status: 'open',
    }];
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 0);
    assert.equal(out.casesUpdated.length, 1);
    assert.equal(out.casesUpdated[0].existingCaseId, 'case-existing');
  });

  it('a closed prior case does not block a new one', () => {
    const input = matchedScenario({ contractRate: 125, paid: 80 });
    input.existingCases = [{
      caseId: 'case-lost',
      claimId: input.claims[0].claimId,
      claimLineId: input.claims[0].lines[0].claimLineId,
      caseType: 'underpayment',
      status: 'lost',
    }];
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 1);
  });

  it('below-threshold recovery is skipped and logged', () => {
    const input = matchedScenario({ contractRate: 100, paid: 90 }); // $10
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 0);
    assert.deepEqual(out.skipped.map((s) => s.reason), ['below_threshold']);
    assert.equal(out.skipped[0].recoveryOpportunity, 10);
  });

  it('client+payer threshold override applies', () => {
    const input = matchedScenario({ contractRate: 100, paid: 90 }); // $10
    input.clientPayerConfigs = [{
      clientId: CLIENT, payerId: PAYER, autopilotEnabled: false, minCaseThreshold: 5,
    }];
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 1);
  });

  it('expired deadline: case created, marked expired, never prioritized', () => {
    const input = matchedScenario({ contractRate: 125, paid: 0, carc: '29', group: 'CO' });
    input.payers[0].appealDeadlineDays = 3; // check 06-25 + 3d = 06-28 < asOf 07-01
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 1);
    assert.equal(out.casesCreated[0].expired, true);
    assert.equal(out.casesCreated[0].priorityLevel, 'low');
    assert.equal(out.casesCreated[0].autoAction, false);
  });

  it('autopilot payer marks the case for auto-action', () => {
    const input = matchedScenario({ contractRate: 125, paid: 80 });
    input.clientPayerConfigs = [{
      clientId: CLIENT, payerId: PAYER, autopilotEnabled: true,
    }];
    const out = runEngine(input);
    assert.equal(out.casesCreated[0].autoAction, true);
  });

  it('no autopilot config -> manual queue', () => {
    const out = runEngine(matchedScenario({ contractRate: 125, paid: 80 }));
    assert.equal(out.casesCreated[0].autoAction, false);
  });
});

// ---------------------------------------------------------------------------
// STEP 7 — summary
// ---------------------------------------------------------------------------
describe('step 7: aggregate and summarize', () => {
  it('totals and breakdowns', () => {
    // two claims: one underpayment ($45), one auth denial ($125)
    const lineA = claimLine();
    const lineB = claimLine();
    const claimA = claim({ claimNumberPayer: 'ICN-A', lines: [lineA] });
    const claimB = claim({ claimNumberPayer: 'ICN-B', lines: [lineB] });
    const input = baseInput({
      claims: [claimA, claimB],
      remitLines: [
        remitLine({ payerClaimNumber: 'ICN-A', paidAmount: 80 }),
        remitLine({
          payerClaimNumber: 'ICN-B', paidAmount: 0,
          adjustmentReasonCode: '197', adjustmentGroupCode: 'CO',
        }),
      ],
      contracts: [{
        contractId: 'ct-1', clientId: CLIENT, payerId: PAYER,
        effectiveDate: '2026-01-01', expirationDate: null,
        feeScheduleType: 'fee_schedule',
        lines: [{ procedureCode: '99213', modifier: null, allowedAmount: 125 }],
      }],
    });
    const out = runEngine(input);
    const s = out.summary;
    assert.equal(s.casesCreated, 2);
    assert.equal(s.totalRecoveryOpportunity, 170);
    assert.equal(s.byCategory['underpayment'].count, 1);
    assert.equal(s.byCategory['underpayment'].amount, 45);
    assert.equal(s.byCategory['authorization'].count, 1);
    assert.equal(s.byCategory['authorization'].amount, 125);
    assert.equal(s.byPayer[PAYER].count, 2);
    assert.equal(s.byPayer[PAYER].payerName, 'Test Payer');
    assert.equal(s.remitLinesProcessed, 2);
    assert.equal(s.matched, 2);
  });

  it('flags systemic underpayment: payer below contract across all claims', () => {
    const claims = [];
    const remits = [];
    for (let i = 0; i < 6; i++) {
      const line = claimLine();
      claims.push(claim({ claimNumberPayer: `ICN-${i}`, lines: [line] }));
      remits.push(remitLine({ payerClaimNumber: `ICN-${i}`, paidAmount: 80 }));
    }
    const input = baseInput({
      claims,
      remitLines: remits,
      contracts: [{
        contractId: 'ct-1', clientId: CLIENT, payerId: PAYER,
        effectiveDate: '2026-01-01', expirationDate: null,
        feeScheduleType: 'fee_schedule',
        lines: [{ procedureCode: '99213', modifier: null, allowedAmount: 125 }],
      }],
    });
    const out = runEngine(input);
    assert.equal(out.summary.anomalies.length, 1);
    assert.equal(out.summary.anomalies[0].type, 'systemic_underpayment');
    assert.equal(out.summary.anomalies[0].linesUnderpaid, 6);
    assert.equal(out.summary.anomalies[0].linesChecked, 6);
  });

  it('fires a client alert above the threshold, not below', () => {
    const input = matchedScenario({ contractRate: 125, paid: 80 }); // $45 recovery
    input.clientAlertThresholds = { [CLIENT]: 40 };
    const out = runEngine(input);
    assert.equal(out.summary.alerts.length, 1);
    assert.equal(out.summary.alerts[0].totalRecoveryOpportunity, 45);

    input.clientAlertThresholds = { [CLIENT]: 100 };
    assert.equal(runEngine(input).summary.alerts.length, 0);
  });
});

// ---------------------------------------------------------------------------
// end-to-end determinism
// ---------------------------------------------------------------------------
describe('engine contract', () => {
  it('is deterministic for identical input', () => {
    const a = runEngine(matchedScenario({ contractRate: 125, paid: 80 }));
    const b = runEngine(matchedScenario({ contractRate: 125, paid: 80 }));
    // fixture ids differ; compare shapes that matter
    assert.equal(a.casesCreated.length, b.casesCreated.length);
    assert.equal(a.casesCreated[0].recoveryOpportunity, b.casesCreated[0].recoveryOpportunity);
    assert.equal(a.casesCreated[0].appealabilityScore, b.casesCreated[0].appealabilityScore);
    assert.equal(a.summary.totalRecoveryOpportunity, b.summary.totalRecoveryOpportunity);
  });

  it(`asOf (${AS_OF}) is the only clock — no wall time in results`, () => {
    const out = runEngine(matchedScenario({ contractRate: 125, paid: 80 }));
    // deadline derives from checkDate + payer days, not from Date.now()
    assert.equal(out.casesCreated[0].deadlineDate, '2026-12-22');
  });
});
