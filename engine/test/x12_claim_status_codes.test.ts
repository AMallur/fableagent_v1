import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lookupClaimStatusCategory } from '../src/integration/x12_claim_status_codes.ts';

describe('lookupClaimStatusCategory', () => {
  it('returns undefined for an unknown or missing code', () => {
    assert.equal(lookupClaimStatusCategory('ZZ'), undefined);
    assert.equal(lookupClaimStatusCategory(undefined), undefined);
    assert.equal(lookupClaimStatusCategory(null), undefined);
  });

  it('is case-insensitive', () => {
    assert.equal(lookupClaimStatusCategory('a7')?.code, 'A7');
  });

  it('marks intake-rejection categories as isRejection', () => {
    for (const code of ['A3', 'A6', 'A7', 'A8', 'E0', 'E3', 'E4', 'F5']) {
      assert.equal(lookupClaimStatusCategory(code)?.isRejection, true, `${code} should be a rejection`);
    }
  });

  it('does not mark acceptance/pending/finalized-paid categories as rejections', () => {
    for (const code of ['A1', 'A2', 'P1', 'P2', 'F0', 'F1', 'F2', 'R0']) {
      assert.equal(lookupClaimStatusCategory(code)?.isRejection, false, `${code} should not be a rejection`);
    }
  });
});
