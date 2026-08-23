// ============================================================================
// Tier 2 pricing and coordination-of-benefits correctness — all pure.
//
// Each case here is a shortfall the engine used to invent: a modified line
// priced at 100%, a line billed under the contracted rate, a Medicare payment
// short by sequestration, and a secondary claim compared against the full
// allowed amount as though the primary had paid nothing.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runEngine } from '../src/engine.ts';
import { priceClaimLine } from '../src/steps/step2_expected.ts';
import { classifyDenial, normalizeDenialCode } from '../src/taxonomy.ts';
import { AS_OF, CLIENT, PAYER, baseInput, claim, claimLine, remitLine } from './fixtures.ts';
import type { EngineInput, ModifierPaymentRule } from '../src/types.ts';

const CMS_DEFAULTS: ModifierPaymentRule[] = [
  { modifier: '50', percentOfAllowed: 150, applyOrder: 10, payerId: null, tenantId: null },
  { modifier: '51', percentOfAllowed: 50, applyOrder: 20, payerId: null, tenantId: null },
  { modifier: '80', percentOfAllowed: 16, applyOrder: 40, payerId: null, tenantId: null },
];

function contract(opts: {
  rate: number; lesserOfBilled?: boolean; modifier?: string | null;
}) {
  return [{
    contractId: 'contract-t2',
    clientId: CLIENT,
    payerId: PAYER,
    effectiveDate: '2026-01-01',
    expirationDate: null,
    feeScheduleType: 'fee_schedule' as const,
    applyLesserOfBilled: opts.lesserOfBilled ?? true,
    lines: [{
      procedureCode: '99213',
      modifier: opts.modifier ?? null,
      allowedAmount: opts.rate,
    }],
  }];
}

/** One matched claim/remit pair, priced by a fee-schedule contract. */
function scenario(opts: {
  rate: number; billed?: number; paid: number; modifiers?: string[];
  lesserOfBilled?: boolean; units?: number;
  paymentReductionPercent?: number;
  payerSequence?: 'primary' | 'secondary' | 'tertiary';
  priorPayerPaid?: number | null;
  linePriorPayerPaid?: number | null;
  adjustments?: Array<{ groupCode: string; reasonCode: string; amount: number }>;
  modifierRules?: ModifierPaymentRule[];
}): EngineInput {
  const line = claimLine({
    billedAmount: opts.billed ?? 250,
    modifiers: opts.modifiers ?? [],
    units: opts.units ?? 1,
    priorPayerPaid: opts.linePriorPayerPaid ?? null,
  });
  const c = claim({
    claimNumberPayer: 'ICN-T2',
    lines: [line],
    payerSequence: opts.payerSequence ?? 'primary',
    priorPayerPaid: opts.priorPayerPaid ?? null,
  });
  const base = baseInput({
    claims: [c],
    contracts: contract({ rate: opts.rate, lesserOfBilled: opts.lesserOfBilled }),
    modifierRules: opts.modifierRules ?? CMS_DEFAULTS,
    remitLines: [remitLine({
      payerClaimNumber: 'ICN-T2',
      paidAmount: opts.paid,
      billedAmount: opts.billed ?? 250,
      adjustments: (opts.adjustments ?? []).map((a) => ({ ...a, quantity: null })),
    })],
  });
  if (opts.paymentReductionPercent != null) {
    base.payers = base.payers.map((p) => ({
      ...p, paymentReductionPercent: opts.paymentReductionPercent,
    }));
  }
  return base;
}

// ---------------------------------------------------------------------------
describe('lesser of billed charges or the contracted rate', () => {
  it('never expects more than what was billed', () => {
    // billed $80, contracted rate $125 — the payer owes $80, not $125
    const input = scenario({ rate: 125, billed: 80, paid: 80 });
    const priced = priceClaimLine(input, input.claims[0], input.claims[0].lines[0]);
    assert.equal(priced.expectedAmount, 80);
    assert.equal(runEngine(input).casesCreated.length, 0, 'no fabricated $45 shortfall');
  });

  it('still finds a real shortfall when the rate is below the charge', () => {
    const input = scenario({ rate: 125, billed: 250, paid: 80 });
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 1);
    assert.equal(out.casesCreated[0].recoveryOpportunity, 45);
  });

  it('honours a contract that genuinely pays the schedule regardless of charge', () => {
    const input = scenario({ rate: 125, billed: 80, paid: 80, lesserOfBilled: false });
    const priced = priceClaimLine(input, input.claims[0], input.claims[0].lines[0]);
    assert.equal(priced.expectedAmount, 125);
    assert.equal(runEngine(input).casesCreated.length, 1);
  });
});

// ---------------------------------------------------------------------------
describe('modifier payment percentages', () => {
  it('prices a second procedure (modifier 51) at half', () => {
    const input = scenario({ rate: 200, billed: 400, paid: 100, modifiers: ['51'] });
    const priced = priceClaimLine(input, input.claims[0], input.claims[0].lines[0]);
    assert.equal(priced.expectedAmount, 100);
    assert.equal(runEngine(input).casesCreated.length, 0, 'paid correctly at 50%');
  });

  it('prices a bilateral procedure (modifier 50) at 150%', () => {
    const input = scenario({ rate: 200, billed: 400, paid: 300, modifiers: ['50'] });
    assert.equal(
      priceClaimLine(input, input.claims[0], input.claims[0].lines[0]).expectedAmount, 300);
  });

  it('composes modifiers in order rather than adding them', () => {
    // bilateral assistant surgery: 150% then 16% of that, not 166%
    const input = scenario({ rate: 200, billed: 900, paid: 48, modifiers: ['50', '80'] });
    assert.equal(
      priceClaimLine(input, input.claims[0], input.claims[0].lines[0]).expectedAmount, 48);
  });

  it('lets a tenant+payer rule override the shared default', () => {
    const rules: ModifierPaymentRule[] = [
      ...CMS_DEFAULTS,
      { modifier: '51', percentOfAllowed: 75, applyOrder: 20, payerId: PAYER, tenantId: 'tenant-1' },
    ];
    const input = scenario({
      rate: 200, billed: 400, paid: 150, modifiers: ['51'], modifierRules: rules,
    });
    assert.equal(
      priceClaimLine(input, input.claims[0], input.claims[0].lines[0]).expectedAmount, 150);
  });

  it('leaves an unmodified line alone', () => {
    const input = scenario({ rate: 200, billed: 400, paid: 200 });
    assert.equal(
      priceClaimLine(input, input.claims[0], input.claims[0].lines[0]).expectedAmount, 200);
  });
});

// ---------------------------------------------------------------------------
describe('payer payment reduction (sequestration)', () => {
  it('does not treat the statutory 2% withholding as an underpayment', () => {
    // $200 allowed, Medicare pays 98% = $196
    const input = scenario({ rate: 200, billed: 400, paid: 196, paymentReductionPercent: 2 });
    assert.equal(runEngine(input).casesCreated.length, 0);
  });

  it('still catches a shortfall beyond the reduction', () => {
    const input = scenario({ rate: 200, billed: 400, paid: 150, paymentReductionPercent: 2 });
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 1);
    assert.equal(out.casesCreated[0].recoveryOpportunity, 46); // 196 - 150
  });

  it('reduces the payment, not the allowed amount, so it comes after patient liability', () => {
    // allowed 200, patient owes 50, payer owes (200-50) x 0.98 = 147
    const input = scenario({
      rate: 200, billed: 400, paid: 147, paymentReductionPercent: 2,
      adjustments: [{ groupCode: 'PR', reasonCode: '2', amount: 50 }],
    });
    assert.equal(runEngine(input).casesCreated.length, 0);
  });

  it('is inert for a payer with no reduction configured', () => {
    // Same $150 payment, with and without the reduction: the payer owes the
    // full $200 rather than $196, so the shortfall is $50 rather than $46.
    const plain = runEngine(scenario({ rate: 200, billed: 400, paid: 150 }));
    assert.equal(plain.casesCreated.length, 1);
    assert.equal(plain.casesCreated[0].recoveryOpportunity, 50);
  });
});

// ---------------------------------------------------------------------------
describe('coordination of benefits', () => {
  it('subtracts what the primary paid on a secondary claim', () => {
    // allowed 200, primary paid 150, so this payer owes 50 and paid it
    const input = scenario({
      rate: 200, billed: 400, paid: 50,
      payerSequence: 'secondary', priorPayerPaid: 150,
    });
    assert.equal(runEngine(input).casesCreated.length, 0);
  });

  it('reads the whole allowed amount as owed without the COB figure', () => {
    // the bug this replaces: same claim, no prior-payer amount recorded
    const input = scenario({ rate: 200, billed: 400, paid: 50, payerSequence: 'secondary' });
    const out = runEngine(input);
    assert.equal(out.casesCreated.length, 1);
    assert.equal(out.casesCreated[0].recoveryOpportunity, 150, 'the primary payment, misread');
  });

  it('falls back to the remit OA-23 amount when the 837 carried no COB detail', () => {
    const input = scenario({
      rate: 200, billed: 400, paid: 50, payerSequence: 'secondary',
      adjustments: [{ groupCode: 'OA', reasonCode: '23', amount: 150 }],
    });
    assert.equal(runEngine(input).casesCreated.length, 0);
  });

  it('prefers line-level COB detail over the claim-level total', () => {
    const input = scenario({
      rate: 200, billed: 400, paid: 50,
      payerSequence: 'secondary', priorPayerPaid: 10, linePriorPayerPaid: 150,
    });
    assert.equal(runEngine(input).casesCreated.length, 0);
  });

  it('never subtracts a prior payment on a primary claim', () => {
    // an OA-23 on a primary claim must not quietly erase a real shortfall
    const input = scenario({
      rate: 200, billed: 400, paid: 50, payerSequence: 'primary',
      adjustments: [{ groupCode: 'OA', reasonCode: '23', amount: 150 }],
    });
    assert.equal(runEngine(input).casesCreated.length, 1);
    assert.equal(runEngine(input).casesCreated[0].recoveryOpportunity, 150);
  });
});

// ---------------------------------------------------------------------------
describe('taxonomy gating', () => {
  it('classifies OA-23 but only as a case when money is still owed', () => {
    const code = normalizeDenialCode('23', 'OA')!;
    assert.equal(code, 'OA-23');
    const entry = classifyDenial(code);
    assert.equal(entry.known, true);
    assert.equal(entry.category, 'coordination_of_benefits');
    assert.equal(entry.requiresVariance, true,
      'otherwise every secondary claim opens a case');
  });

  it('recognizes sequestration (CO-253) instead of leaving it unmapped', () => {
    const entry = classifyDenial(normalizeDenialCode('253', 'CO')!);
    assert.equal(entry.known, true);
    assert.equal(entry.category, 'contractual');
    assert.equal(entry.requiresVariance, true);
  });

  it('opens no case for a fully coordinated secondary claim carrying OA-23', () => {
    const input = scenario({
      rate: 200, billed: 400, paid: 50, payerSequence: 'secondary', priorPayerPaid: 150,
      adjustments: [{ groupCode: 'OA', reasonCode: '23', amount: 150 }],
    });
    assert.equal(runEngine(input).casesCreated.length, 0);
    assert.equal(AS_OF, '2026-07-01');
  });
});
