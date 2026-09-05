import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimate, wilsonInterval, shrinkToPrior, rankOptions,
} from '../src/intelligence/statistics.ts';
import { IntelligenceIndex, REVIEW_WIN_RATE_FLOOR } from '../src/intelligence/payer_intelligence.ts';

// ---------------------------------------------------------------------------
// statistics: the whole point is that small samples don't lie
// ---------------------------------------------------------------------------

describe('payer-outcome statistics', () => {
  it('wilson lower bound sits well below the point estimate on tiny samples', () => {
    const w = wilsonInterval(3, 3);
    assert.equal(w.upper, 1);
    assert.ok(w.lower < 0.5, `3/3 lower bound should be < 0.5, got ${w.lower}`);
  });

  it('wilson lower bound approaches the point estimate as the sample grows', () => {
    const small = wilsonInterval(3, 3).lower;
    const large = wilsonInterval(300, 300).lower;
    assert.ok(large > small);
    assert.ok(large > 0.97, `300/300 lower bound should be high, got ${large}`);
  });

  it('a perfect tiny sample does not read as a confident win', () => {
    const e = estimate({ overturned: 3, partial: 0, upheld: 0 }, { minSample: 8 });
    assert.equal(e.pointWinRate, 1);          // naive rate is 100%
    assert.ok(e.adjustedWinRate < 0.5);       // confidence-adjusted is not
    assert.equal(e.coldStart, true);
    assert.equal(e.label, 'insufficient');
  });

  it('a large consistent sample reads as trustworthy', () => {
    const e = estimate({ overturned: 28, partial: 2, upheld: 3 }, { minSample: 8 });
    assert.equal(e.coldStart, false);
    assert.ok(e.adjustedWinRate > 0.7);
    assert.notEqual(e.label, 'insufficient');
  });

  it('partials count as recovery for the win rate but overturn rate stays strict', () => {
    const e = estimate({ overturned: 5, partial: 5, upheld: 0 });
    assert.equal(e.pointWinRate, 1);      // all 10 recovered something
    assert.equal(e.overturnRate, 0.5);    // only 5 fully overturned
  });

  it('shrinks toward the base rate with no data, toward the sample with lots', () => {
    assert.equal(shrinkToPrior(0, 0, 0.4, 5), 0.4);
    const heavy = shrinkToPrior(90, 100, 0.4, 5);
    assert.ok(heavy > 0.85, `90/100 should pull near 0.9, got ${heavy}`);
  });

  it('an empty cell degrades to the base rate, not a spurious 0%', () => {
    const e = estimate({ overturned: 0, partial: 0, upheld: 0 }, { baseRate: 0.4 });
    assert.equal(e.adjustedWinRate, 0.4);
    assert.equal(e.coldStart, true);
  });

  it('ranking puts proven cells first and cold-start cells last', () => {
    const ranked = rankOptions([
      { key: 'thin-perfect', estimate: estimate({ overturned: 1, partial: 0, upheld: 0 }, { minSample: 8 }) },
      { key: 'proven-good', estimate: estimate({ overturned: 18, partial: 0, upheld: 7 }, { minSample: 8 }) },
      { key: 'proven-bad', estimate: estimate({ overturned: 2, partial: 0, upheld: 20 }, { minSample: 8 }) },
    ]);
    assert.equal(ranked[0].key, 'proven-good');
    assert.equal(ranked[2].key, 'thin-perfect');   // cold-start always last
  });
});

// ---------------------------------------------------------------------------
// index: aggregation, base rates, assessment, review flagging
// ---------------------------------------------------------------------------

const P = '11111111-1111-1111-1111-111111111111';

function rows(specs: Array<{
  outcome: 'overturned' | 'upheld' | 'partial'; n: number;
  category?: string; appealType?: string; method?: string | null; recovered?: number;
}>) {
  return specs.map((s) => ({
    payer_id: P, payer_name: 'Test Payer',
    category: s.category ?? 'bundling',
    appeal_type: s.appealType ?? 'first_level',
    submission_method: (s.method ?? 'portal') as any,
    outcome: s.outcome, n: s.n,
    recovered: s.recovered ?? 0, disputed: 0,
  }));
}

describe('IntelligenceIndex', () => {
  it('aggregates outcomes per (payer, category, level) and flags a reliably-rejected argument', () => {
    // 3 overturned, 22 upheld on bundling first_level → 12% win, real sample
    const idx = new IntelligenceIndex(
      rows([{ outcome: 'overturned', n: 3 }, { outcome: 'upheld', n: 22 }]),
      { minSample: 8 },
    );
    const a = idx.assess(P as any, 'bundling', 'first_level');
    assert.equal(a.estimate.resolved, 25);
    assert.equal(a.estimate.coldStart, false);
    assert.ok(a.estimate.adjustedWinRate <= REVIEW_WIN_RATE_FLOOR);
    assert.equal(a.flagForReview, true);
    assert.match(a.note, /rejects|reject/i);
    assert.equal(a.snapshot.flaggedForReview, true);
  });

  it('does not flag a strong argument for review', () => {
    const idx = new IntelligenceIndex(
      rows([{ outcome: 'overturned', n: 20 }, { outcome: 'upheld', n: 3 }]),
      { minSample: 8 },
    );
    const a = idx.assess(P as any, 'bundling', 'first_level');
    assert.equal(a.flagForReview, false);
    assert.ok(a.estimate.adjustedWinRate > REVIEW_WIN_RATE_FLOOR);
  });

  it('never flags on a cold-start (thin) sample, however bad it looks', () => {
    const idx = new IntelligenceIndex(
      rows([{ outcome: 'upheld', n: 2 }]),      // 0/2 — terrible but tiny
      { minSample: 8 },
    );
    const a = idx.assess(P as any, 'bundling', 'first_level');
    assert.equal(a.estimate.coldStart, true);
    assert.equal(a.flagForReview, false);
    assert.match(a.note, /not enough history|standard playbook/i);
  });

  it('an unseen cell reads as cold-start anchored to the base rate', () => {
    const idx = new IntelligenceIndex(rows([{ outcome: 'overturned', n: 30 }]), { minSample: 8 });
    const a = idx.assess(P as any, 'timely_filing', 'second_level');   // never seen
    assert.equal(a.estimate.resolved, 0);
    assert.equal(a.flagForReview, false);
    assert.equal(a.estimate.coldStart, true);
  });

  it('report surfaces per-payer rollups and best channel', () => {
    const idx = new IntelligenceIndex(
      rows([
        { outcome: 'overturned', n: 10, method: 'portal' },
        { outcome: 'upheld', n: 2, method: 'portal' },
        { outcome: 'overturned', n: 1, method: 'mail' },
        { outcome: 'upheld', n: 9, method: 'mail' },
      ]),
      { minSample: 8 },
    );
    const rep = idx.report();
    assert.equal(rep.payers.length, 1);
    assert.equal(rep.payers[0].resolvedAppeals, 22);
    assert.equal(rep.payers[0].bestChannel?.method, 'portal');   // portal clearly wins
  });
});
