import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateContractDraft } from '../src/contracts/validation.ts';

describe('contract onboarding validation', () => {
  it('normalizes and accepts an explicit professional fee schedule', () => {
    const result = validateContractDraft({
      payerId: 'payer', effectiveDate: '2026-01-01', feeScheduleType: 'FEE_SCHEDULE',
      lines: [{ procedureCode: ' 99213 ', modifier: '25', allowedAmount: 125 }],
    });
    assert.equal(result.valid, true);
    assert.equal(result.normalized.lines[0].procedureCode, '99213');
    assert.equal(result.normalized.feeScheduleType, 'fee_schedule');
  });

  it('rejects ambiguous mixed pricing and duplicate rates', () => {
    const result = validateContractDraft({
      payerId: 'payer', effectiveDate: '2026-01-01', feeScheduleType: 'fee_schedule',
      lines: [
        { procedureCode: '99213', allowedAmount: 100, percentOfMedicare: 140 },
        { procedureCode: '99213', allowedAmount: 105 },
      ],
    });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((x) => x.code === 'mixed_pricing_method'));
    assert.ok(result.issues.some((x) => x.code === 'duplicate_rate'));
  });

  it('fails closed on unsupported case-rate and per-diem models', () => {
    for (const feeScheduleType of ['case_rate', 'per_diem']) {
      const result = validateContractDraft({
        payerId: 'payer', effectiveDate: '2026-01-01', feeScheduleType,
        lines: [{ procedureCode: '99213', allowedAmount: 100 }],
      });
      assert.equal(result.supported, false);
      assert.equal(result.valid, false);
    }
  });

  it('requires a valid date range and five-character procedure codes', () => {
    const result = validateContractDraft({
      payerId: 'payer', effectiveDate: '2026-02-30', expirationDate: '2025-01-01',
      feeScheduleType: 'fee_schedule', lines: [{ procedureCode: '99', allowedAmount: -1 }],
    });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((x) => x.code === 'effective_date_invalid'));
    assert.ok(result.issues.some((x) => x.code === 'procedure_code_invalid'));
    assert.ok(result.issues.some((x) => x.code === 'allowed_amount_required'));
  });
});
