// ============================================================================
// 835 financial integrity — provider-level adjustments (PLB), reversals,
// payer re-coding, unit reduction, CAS quantity, and the X12 balancing rules.
//
// Everything here is pure: parser text in, structures out; EngineInput in,
// EngineResult out. No database.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parse835, parse835File, providerAdjustmentCategory, reducesProviderCash,
} from '../src/ingest/parse835.ts';
import { balance835, balance835File } from '../src/ingest/balance835.ts';
import { runEngine } from '../src/engine.ts';
import { baseInput, claim, claimLine, remitLine } from './fixtures.ts';

const ISA = 'ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *260625*1200*^*00501*000000001*0*P*:~';

/** A conforming 835: one $170 contractual write-off, check balances exactly. */
function era(lines: string[]): string {
  return [
    ISA,
    'GS*HP*SENDER*RECEIVER*20260625*1200*1*X*005010X221A1~',
    'ST*835*0001~',
    ...lines,
    'SE*10*0001~',
    'GE*1*1~',
    'IEA*1*000000001~',
  ].join('\n');
}

const CLEAN = era([
  'BPR*I*80.00*C*ACH*CCP*01*999999999*DA*123456*1512345678**01*999988880*DA*98765*20260625~',
  'TRN*1*CHK-1*1~',
  'N1*PR*UNITY HEALTH PLAN*PI*UNI~',
  'CLP*CLM-1*1*250.00*80.00*0*12*ICN-1~',
  'NM1*QC*1*DOE*JANE****MI*MEM-1~',
  'SVC*HC:99213*250.00*80.00**1~',
  'DTM*472*20260601~',
  'CAS*CO*45*170~',
]);

// ---------------------------------------------------------------------------
// PLB — provider-level adjustments
// ---------------------------------------------------------------------------
describe('835 provider-level adjustments (PLB)', () => {
  const WITH_PLB = era([
    // BPR02 = claim payments (80.00) - PLB (125.00 - 3.10) = -41.90
    'BPR*I*-41.90*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260625~',
    'TRN*1*CHK-2*1~',
    'N1*PR*UNITY HEALTH PLAN*PI*UNI~',
    'CLP*CLM-1*1*250.00*80.00*0*12*ICN-1~',
    'SVC*HC:99213*250.00*80.00**1~',
    'CAS*CO*45*170~',
    'PLB*1234567890*20261231*WO:ICN-9001*125.00*L6:REF-2*-3.10~',
  ]);

  it('parses every reason/amount pair with its reference and category', () => {
    const parsed = parse835(WITH_PLB);
    assert.equal(parsed.providerAdjustments.length, 2);

    const [recoupment, interest] = parsed.providerAdjustments;
    assert.deepEqual(recoupment, {
      providerNpi: '1234567890',
      fiscalPeriodEnd: '2026-12-31',
      sequenceNumber: 1,
      reasonCode: 'WO',
      referenceId: 'ICN-9001',
      amount: 125,
      category: 'recoupment',
    });
    assert.equal(interest.reasonCode, 'L6');
    assert.equal(interest.category, 'interest');
    assert.equal(interest.amount, -3.1);
    assert.equal(interest.sequenceNumber, 2);
  });

  it('classifies the reason codes that take provider cash away', () => {
    assert.equal(providerAdjustmentCategory('WO'), 'recoupment');
    assert.equal(providerAdjustmentCategory('FB'), 'forwarding_balance');
    assert.equal(providerAdjustmentCategory('l6'), 'interest');   // case-insensitive
    assert.equal(providerAdjustmentCategory('ZZ'), 'other');      // unmapped is still stored

    assert.equal(reducesProviderCash('recoupment'), true);
    assert.equal(reducesProviderCash('forwarding_balance'), true);
    assert.equal(reducesProviderCash('interest'), false);
    assert.equal(reducesProviderCash('capitation'), false);
  });

  it('balances the check only when PLB is subtracted from the claim payments', () => {
    const parsed = parse835(WITH_PLB);
    const result = balance835(parsed);
    assert.equal(result.balanced, true);
    assert.equal(result.claimPaymentTotal, 80);
    assert.equal(result.providerAdjustmentTotal, 121.9);
    assert.equal(result.transactionVariance, 0);

    // the same file read without its PLB detail is $121.90 out of balance —
    // exactly the takeback that would otherwise be invisible
    const blind = balance835({ ...parsed, providerAdjustments: [] });
    assert.equal(blind.balanced, false);
    assert.equal(blind.transactionVariance, 121.9);
    assert.equal(blind.findings[0].rule, 'transaction');
  });

  it('ends the claim loop so a PLB is never read as claim detail', () => {
    const parsed = parse835(WITH_PLB);
    assert.equal(parsed.claims.length, 1);
    assert.equal(parsed.claims[0].lines.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Reversals
// ---------------------------------------------------------------------------
describe('835 reversals (CLP02 = 22)', () => {
  const REVERSE_AND_REISSUE = era([
    // reversal (-80) + reissue (150) = 70 net
    'BPR*I*70.00*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260710~',
    'TRN*1*CHK-3*1~',
    'N1*PR*UNITY HEALTH PLAN*PI*UNI~',
    'CLP*CLM-1*22*-250.00*-80.00*0*12*ICN-1~',
    'SVC*HC:99213*-250.00*-80.00**1~',
    'CAS*CO*45*-170~',
    'CLP*CLM-1*1*250.00*150.00*0*12*ICN-1A~',
    'SVC*HC:99213*250.00*150.00**1~',
    'CAS*CO*45*100~',
  ]);

  it('flags the reversal and leaves the replacement alone', () => {
    const parsed = parse835(REVERSE_AND_REISSUE);
    assert.equal(parsed.claims.length, 2);
    assert.equal(parsed.claims[0].statusCode, '22');
    assert.equal(parsed.claims[0].isReversal, true);
    assert.equal(parsed.claims[0].paidAmount, -80);
    assert.equal(parsed.claims[1].isReversal, false);
    assert.equal(parsed.claims[1].paidAmount, 150);
  });

  it('balances a reverse-and-reissue pair by the ordinary rules', () => {
    assert.equal(balance835(parse835(REVERSE_AND_REISSUE)).balanced, true);
  });
});

// ---------------------------------------------------------------------------
// Payer re-coding and unit reduction
// ---------------------------------------------------------------------------
describe('835 service-line adjudication detail', () => {
  it('matches on the submitted code (SVC06) and reports the adjudicated one', () => {
    const parsed = parse835(era([
      'BPR*I*70.00*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260625~',
      'TRN*1*CHK-4*1~',
      'N1*PR*UNITY HEALTH PLAN*PI*UNI~',
      'CLP*CLM-1*1*250.00*70.00*0*12*ICN-1~',
      // billed 99214, paid as 99213 — the classic downcode
      'SVC*HC:99213*250.00*70.00**1*HC:99214*1~',
      'CAS*CO*45*180~',
    ]));
    const line = parsed.claims[0].lines[0];
    assert.equal(line.procedureCode, '99214', 'our claim line is the submitted code');
    assert.equal(line.adjudicatedProcedureCode, '99213');
    assert.equal(line.payerRecoded, true);
  });

  it('leaves payerRecoded false when SVC06 repeats SVC01', () => {
    const parsed = parse835(era([
      'BPR*I*80.00*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260625~',
      'TRN*1*CHK-5*1~',
      'N1*PR*UNITY HEALTH PLAN*PI*UNI~',
      'CLP*CLM-1*1*250.00*80.00*0*12*ICN-1~',
      'SVC*HC:99213*250.00*80.00**1*HC:99213*1~',
      'CAS*CO*45*170~',
    ]));
    const line = parsed.claims[0].lines[0];
    assert.equal(line.procedureCode, '99213');
    assert.equal(line.payerRecoded, false);
  });

  it('prices against submitted units (SVC07), not the units the payer paid', () => {
    const parsed = parse835(era([
      'BPR*I*80.00*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260625~',
      'TRN*1*CHK-6*1~',
      'N1*PR*UNITY HEALTH PLAN*PI*UNI~',
      'CLP*CLM-1*1*250.00*80.00*0*12*ICN-1~',
      // 3 units submitted, 1 paid
      'SVC*HC:99213*250.00*80.00**1**3~',
      'CAS*CO*45*170~',
    ]));
    const line = parsed.claims[0].lines[0];
    assert.equal(line.units, 3, 'the unit reduction stays visible');
    assert.equal(line.paidUnits, 1);
    assert.equal(line.originalUnits, 3);
  });

  it('falls back to paid units when the payer reports no SVC07', () => {
    const line = parse835(CLEAN).claims[0].lines[0];
    assert.equal(line.units, 1);
    assert.equal(line.paidUnits, 1);
    assert.equal(line.originalUnits, null);
  });

  it('keeps the CAS quantity element instead of discarding it', () => {
    const parsed = parse835([
      'ST*835*0001~',
      'CLP*C1*1*250*80*0*12*ICN-1~',
      'SVC*HC:99213*250*80**1~',
      'CAS*CO*45*100*2*97*70*1~',
      'SE*5*0001~',
    ].join('\n'));
    assert.deepEqual(parsed.claims[0].lines[0].adjustments, [
      { groupCode: 'CO', reasonCode: '45', amount: 100, quantity: 2 },
      { groupCode: 'CO', reasonCode: '97', amount: 70, quantity: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Balancing rules
// ---------------------------------------------------------------------------
describe('835 balancing', () => {
  it('accepts a conforming remittance', () => {
    const result = balance835(parse835(CLEAN));
    assert.equal(result.balanced, true);
    assert.deepEqual(result.findings, []);
  });

  it('catches a service line whose adjustments do not explain the payment', () => {
    const result = balance835(parse835(era([
      'BPR*I*80.00*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260625~',
      'TRN*1*CHK-7*1~',
      'N1*PR*UNITY HEALTH PLAN*PI*UNI~',
      'CLP*CLM-1*1*250.00*80.00*0*12*ICN-1~',
      'SVC*HC:99213*250.00*80.00**1~',
      'CAS*CO*45*150~',          // $20 unexplained
    ])));
    assert.equal(result.balanced, false);
    const rules = result.findings.filter((f) => f.severity === 'error').map((f) => f.rule);
    assert.ok(rules.includes('service_line'));
    assert.ok(rules.includes('claim'));
    const line = result.findings.find((f) => f.rule === 'service_line')!;
    assert.equal(line.variance, 20);
    assert.equal(line.claim, 'CLM-1');
    assert.equal(line.procedureCode, '99213');
  });

  it('catches a check whose claim payments do not add up to BPR02', () => {
    const result = balance835(parse835(era([
      'BPR*I*500.00*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260625~',
      'TRN*1*CHK-8*1~',
      'N1*PR*UNITY HEALTH PLAN*PI*UNI~',
      'CLP*CLM-1*1*250.00*80.00*0*12*ICN-1~',
      'SVC*HC:99213*250.00*80.00**1~',
      'CAS*CO*45*170~',
    ])));
    assert.equal(result.balanced, false);
    assert.equal(result.transactionVariance, -420);
    assert.match(result.findings[0].message, /BPR02 reports \$500\.00/);
  });

  it('warns without failing when CLP05 disagrees with the PR adjustments', () => {
    const result = balance835(parse835(era([
      'BPR*I*80.00*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260625~',
      'TRN*1*CHK-9*1~',
      'N1*PR*UNITY HEALTH PLAN*PI*UNI~',
      'CLP*CLM-1*1*250.00*80.00*45*12*ICN-1~',   // CLP05 says $45
      'SVC*HC:99213*250.00*80.00**1~',
      'CAS*CO*45*170~',                           // but no PR adjustment exists
    ])));
    assert.equal(result.balanced, true, 'patient liability never moves provider cash');
    const warning = result.findings.find((f) => f.rule === 'patient_responsibility')!;
    assert.equal(warning.severity, 'warning');
    assert.equal(warning.actual, 45);
  });

  it('honours a per-client tolerance for a documented rounding quirk', () => {
    const off = parse835(era([
      'BPR*I*79.99*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260625~',
      'TRN*1*CHK-10*1~',
      'N1*PR*UNITY HEALTH PLAN*PI*UNI~',
      'CLP*CLM-1*1*250.00*80.00*0*12*ICN-1~',
      'SVC*HC:99213*250.00*80.00**1~',
      'CAS*CO*45*170~',
    ]));
    assert.equal(balance835(off).balanced, false);
    assert.equal(balance835(off, { tolerance: 0.01 }).balanced, true);
  });

  it('rejects a transaction with no BPR02 to balance against', () => {
    const result = balance835({
      payerName: 'P', payerIdCode: null, payeeName: '', payeeNpi: null,
      totalPaid: null, checkDate: null, traceNumber: 'X', claims: [],
      providerAdjustments: [],
    });
    assert.equal(result.balanced, false);
    assert.equal(result.findings[0].rule, 'transaction');
  });

  it('reports each transaction set in a multi-check file separately', () => {
    const file = balance835File(parse835File(CLEAN));
    assert.equal(file.balanced, true);
    assert.equal(file.transactions.length, 1);
    assert.deepEqual(file.errors, []);
  });
});

// ---------------------------------------------------------------------------
// The published API example has to be a payload the API actually accepts
// ---------------------------------------------------------------------------
describe('documented remittance API example', () => {
  it('balances, so copying it out of the docs does not get a 400', async () => {
    const { API_ENDPOINTS } = await import('../src/web/api_docs.ts');
    const { json835ToRemittance } = await import('../src/web/public_api.ts');
    const endpoint = API_ENDPOINTS.find(
      (e: any) => e.path === '/api/v1/remittances/ingest')!;
    const parsed = json835ToRemittance(JSON.parse(endpoint.requestExample!.body));
    const result = balance835(parsed);
    assert.deepEqual(result.findings, []);
    assert.equal(result.balanced, true);
    assert.equal(result.providerAdjustmentTotal, 25);
  });
});

// ---------------------------------------------------------------------------
// Engine behavior on reversals
// ---------------------------------------------------------------------------
describe('engine: reversals never become recovery cases', () => {
  const contract = (rate: number) => ([{
    contractId: 'contract-r1', clientId: 'client-1', payerId: 'payer-1',
    effectiveDate: '2026-01-01', expirationDate: null,
    feeScheduleType: 'fee_schedule' as const,
    lines: [{ procedureCode: '99213', modifier: null, allowedAmount: rate }],
  }]);

  it('does not manufacture an underpayment out of a reversal entry', () => {
    const line = claimLine({ billedAmount: 250 });
    const c = claim({ claimNumberPayer: 'ICN-1', lines: [line], claimStatus: 'paid' });
    const input = baseInput({
      claims: [c],
      contracts: contract(200),
      remitLines: [remitLine({
        payerClaimNumber: 'ICN-1', paidAmount: -200, isReversal: true,
        claimStatusCode: '22', checkDate: '2026-06-25',
      })],
    });
    const out = runEngine(input);
    assert.equal(out.matches.length, 1, 'the reversal is still matched and consumed');
    assert.equal(out.casesCreated.length, 0, 'but it creates no case');
    assert.equal(out.summary.reversals.lines, 1);
    assert.equal(out.summary.reversals.amount, 200);
    const anomaly = out.summary.anomalies.find((a) => a.type === 'payment_reversed')!;
    assert.equal(anomaly.reversedLines, 1);
    assert.equal(anomaly.reversedAmount, 200);
  });

  it('does not flip a paid claim to accepted because of a reversal', () => {
    const line = claimLine({ billedAmount: 250 });
    const c = claim({ claimNumberPayer: 'ICN-1', lines: [line], claimStatus: 'paid' });
    const input = baseInput({
      claims: [c],
      contracts: contract(200),
      remitLines: [remitLine({
        payerClaimNumber: 'ICN-1', paidAmount: -200, isReversal: true, claimStatusCode: '22',
      })],
    });
    assert.deepEqual(runEngine(input).claimStatusUpdates, []);
  });

  it('nets a reverse-and-reissue pair and judges the replacement, not the reversal', () => {
    const line = claimLine({ billedAmount: 250 });
    const c = claim({ claimNumberPayer: 'ICN-1', lines: [line] });
    const input = baseInput({
      claims: [c],
      contracts: contract(200),
      remitLines: [
        // originally paid 200 (correct), reversed, reissued at 150 (now short $50)
        remitLine({
          payerClaimNumber: 'ICN-1', paidAmount: 200, checkDate: '2026-06-25',
          remittanceId: 'r-1',
        }),
        remitLine({
          payerClaimNumber: 'ICN-1', paidAmount: -200, isReversal: true,
          claimStatusCode: '22', checkDate: '2026-07-01', remittanceId: 'r-2',
        }),
        remitLine({
          payerClaimNumber: 'ICN-1', paidAmount: 150, checkDate: '2026-07-01',
          remittanceId: 'r-2',
        }),
      ],
    });
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 1, 'the shortfall on the replacement is a case');
    assert.equal(out.casesCreated[0].recoveryOpportunity, 50);
    assert.equal(out.summary.reversals.lines, 1);
  });
});
