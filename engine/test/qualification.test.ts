// Unit coverage for the pre-pilot qualification harnesses.
//
// The harnesses are what tell us whether the platform is fit to run at a
// clinic, so a harness that lies is worse than none: it would report green
// while measuring nothing. These tests hold the harnesses to the same standard
// as the code they examine.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateBatch, generateBatches, type SyntheticScenario,
} from '../src/qualification/synthetic_x12.ts';
import { StageTimer, percentile, formatStageTable } from '../src/qualification/metrics.ts';
import { INVARIANTS, checkInvariants, formatInvariantReport } from '../src/qualification/invariants.ts';
import { compareFingerprints, type RecoveryFingerprint } from '../src/qualification/recovery.ts';
import { startMockOptum } from '../src/qualification/mock_optum.ts';
import { parse835 } from '../src/ingest/parse835.ts';
import { parse837 } from '../src/ingest/parse837.ts';
import { balance835 } from '../src/ingest/balance835.ts';

const ALL_SCENARIOS: SyntheticScenario[] = [
  'clean', 'underpaid', 'denied_auth', 'denied_bundled',
  'denied_coding', 'denied_noncovered', 'reversal',
];

function only(scenario: SyntheticScenario) {
  const mix = Object.fromEntries(ALL_SCENARIOS.map((s) => [s, 0])) as Record<SyntheticScenario, number>;
  return { ...mix, [scenario]: 1 };
}

describe('synthetic X12 generator', () => {
  it('emits an 837 the real parser reads back completely', () => {
    const batch = generateBatch({ seed: 11, claimsPerBatch: 40 });
    const parsed = parse837(batch.claimFile);
    assert.equal(parsed.claims.length, batch.claims.length);
    assert.equal(
      parsed.claims.reduce((n, c) => n + c.lines.length, 0),
      batch.claims.reduce((n, c) => n + c.lines.length, 0),
    );
  });

  it('emits an 835 the real parser reads back completely', () => {
    const batch = generateBatch({ seed: 12, claimsPerBatch: 40 });
    const era = parse835(batch.remittanceFile);
    assert.equal(era.claims.length, batch.claims.length);
    assert.equal(era.totalPaid, batch.paymentTotal);
  });

  it('balances every scenario per TR3', () => {
    // A generator that emits unbalanced remittances would exercise the
    // rejection path on every file and measure nothing about the pipeline.
    for (const scenario of ALL_SCENARIOS) {
      const batch = generateBatch({ seed: 3, claimsPerBatch: 12, mix: only(scenario) });
      const result = balance835(parse835(batch.remittanceFile));
      assert.equal(result.balanced, true,
        `${scenario} did not balance: ${JSON.stringify(result.findings[0])}`);
    }
  });

  it('balances across many seeds and a provider-level adjustment', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const batch = generateBatch({
        seed, claimsPerBatch: 60,
        providerAdjustment: seed % 3 === 0 ? 77.25 : 0,
      });
      assert.equal(balance835(parse835(batch.remittanceFile)).balanced, true,
        `seed ${seed} did not balance`);
    }
  });

  it('negates the charge on a reversal, not only the payment', () => {
    // A reversal mirrors the original adjudication with every amount negated.
    // Negating the payment alone leaves charge - adjustments != payment, and
    // the file fails balancing exactly as a real payer's would.
    const batch = generateBatch({ seed: 5, claimsPerBatch: 4, mix: only('reversal') });
    const era = parse835(batch.remittanceFile);
    assert.ok(era.claims.every((c) => c.isReversal), 'CLP02 should be 22');
    assert.ok(era.claims.every((c) => (c.paidAmount ?? 0) < 0), 'CLP04 should be negative');
    assert.ok(era.claims.every((c) => (c.billedAmount ?? 0) < 0), 'CLP03 should be negative too');
  });

  it('is deterministic for a seed and different across seeds', () => {
    const a = generateBatch({ seed: 42, claimsPerBatch: 25 });
    const b = generateBatch({ seed: 42, claimsPerBatch: 25 });
    const c = generateBatch({ seed: 43, claimsPerBatch: 25 });
    assert.equal(a.remittanceFile, b.remittanceFile);
    assert.equal(a.claimFile, b.claimFile);
    assert.notEqual(a.remittanceFile, c.remittanceFile);
  });

  it('puts the seed in the claim number so runs accumulate instead of overwriting', () => {
    // Without this a scaling sweep silently becomes a no-op: the second run
    // updates the first run's claims rather than adding to the table, and the
    // measurement reports flat performance because nothing grew.
    const first = generateBatches(2, { seed: 1, claimsPerBatch: 5 });
    const second = generateBatches(2, { seed: 500, claimsPerBatch: 5 });
    const firstNumbers = new Set(first.flatMap((b) => b.claims.map((c) => c.claimNumber)));
    const overlap = second.flatMap((b) => b.claims.map((c) => c.claimNumber))
      .filter((n) => firstNumbers.has(n));
    assert.deepEqual(overlap, []);
  });

  it('gives a bundling claim a sibling line that pays', () => {
    // CO-97 only reclassifies as bundling when another line on the claim was
    // paid, so a one-line bundled claim would exercise nothing.
    const batch = generateBatch({ seed: 9, claimsPerBatch: 10, mix: only('denied_bundled') });
    for (const claim of batch.claims) {
      assert.ok(claim.lines.length >= 2);
      assert.ok(claim.lines.some((l) => l.paidAmount > 0));
      assert.ok(claim.lines.some((l) => l.adjustments.some((a) => a.reason === '97')));
    }
  });

  it('honours a requested scenario mix', () => {
    const batch = generateBatch({ seed: 7, claimsPerBatch: 50, mix: only('denied_auth') });
    assert.ok(batch.claims.every((c) => c.scenario === 'denied_auth'));
    assert.equal(batch.paymentTotal, 0);
  });
});

describe('stage metrics', () => {
  it('reports a percentile that was actually observed', () => {
    // An interpolating percentile invents a latency no run produced.
    assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
    assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5);
    assert.equal(percentile([], 0.5), 0);
    assert.equal(percentile([7], 0.99), 7);
  });

  it('counts a failing stage and still records its duration', async () => {
    const timer = new StageTimer();
    await timer.time('ok', 2, async () => {});
    await assert.rejects(timer.time('bad', 1, async () => { throw new Error('boom'); }));
    const bad = timer.stats('bad');
    assert.equal(bad.errors, 1);
    assert.equal(bad.samples, 1);
    assert.equal(timer.stats('ok').errors, 0);
    assert.equal(timer.stats('ok').units, 2);
  });

  it('renders a table with a row per stage', () => {
    const timer = new StageTimer();
    timer.record('ingest', 10, 5);
    timer.record('detect', 20, 5);
    const table = formatStageTable(timer.report());
    assert.match(table, /\| ingest \|/);
    assert.match(table, /\| detect \|/);
  });
});

describe('financial invariants', () => {
  it('every invariant explains why a violation matters', () => {
    // A check that cannot say what is wrong is a complaint, not a gate.
    for (const invariant of INVARIANTS) {
      assert.ok(invariant.because.length > 30, `${invariant.name} has no rationale`);
      assert.match(invariant.sql, /\$1/, `${invariant.name} is not tenant-scoped`);
    }
  });

  it('reports a violation with its rationale and examples', async () => {
    const db = {
      query: async (sql: string) => (sql.includes('invoice_line')
        ? { rows: [{ usage_event_id: 'u1', invoice_lines: 2 }] }
        : { rows: [] }),
    };
    const report = await checkInvariants(db as any, 't1');
    assert.ok(report.violations.length > 0);
    assert.equal(report.clean, false);
    const text = formatInvariantReport(report);
    assert.match(text, /ledger_row_billed_at_most_once/);
    assert.match(text, /bills the customer twice/);
  });

  it('is clean when nothing comes back', async () => {
    const db = { query: async () => ({ rows: [] }) };
    const report = await checkInvariants(db as any, 't1');
    assert.equal(report.clean, true);
    assert.equal(report.violations.length, 0);
    assert.equal(report.checked, INVARIANTS.length);
    assert.equal(formatInvariantReport(report), `all ${INVARIANTS.length} invariants hold`);
  });
});

describe('recovery fingerprint comparison', () => {
  const base: RecoveryFingerprint = {
    tenantId: 't1',
    counts: { invoice: 3, usage_event: 9 },
    totals: { invoice_amount_due: '100.00' },
    invoiceDigest: 'a', ledgerDigest: 'b', auditDigest: 'c',
  };

  it('finds nothing when the restore reproduced the state', () => {
    assert.deepEqual(compareFingerprints(base, { ...base }), []);
  });

  it('names a money total that moved', () => {
    const after = { ...base, totals: { invoice_amount_due: '90.00' } };
    const differences = compareFingerprints(base, after);
    assert.equal(differences.length, 1);
    assert.equal(differences[0].field, 'total.invoice_amount_due');
    assert.equal(differences[0].before, '100.00');
    assert.equal(differences[0].after, '90.00');
  });

  it('names a digest that changed even when the counts agree', () => {
    // Same number of rows with different content is the case a row count
    // alone would miss, and it is the one that matters most.
    const differences = compareFingerprints(base, { ...base, ledgerDigest: 'different' });
    assert.deepEqual(differences.map((d) => d.field), ['digest.ledger']);
  });
});

describe('mock payer', () => {
  it('issues a token and accepts a claim over real HTTP', async () => {
    const mock = await startMockOptum();
    try {
      const token = await fetch(mock.tokenUrl, { method: 'POST', body: 'grant_type=client_credentials' });
      const json = await token.json() as { access_token: string };
      assert.match(json.access_token, /^mock-token-1-/);

      const claim = await fetch(`${mock.url}/medicalnetwork/professionalclaims/v3/submission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${json.access_token}` },
        body: JSON.stringify({ controlNumber: 'X1' }),
      });
      assert.equal(claim.status, 200);
      assert.equal(mock.claimRequests().length, 1);
      assert.equal((mock.claimRequests()[0].body as any).controlNumber, 'X1');
    } finally { await mock.close(); }
  });

  it('fails a fixed number of times and then recovers', async () => {
    const mock = await startMockOptum({ behaviour: { kind: 'flaky', times: 2, status: 503 } });
    try {
      const path = `${mock.url}/medicalnetwork/professionalclaims/v3/submission`;
      const post = () => fetch(path, { method: 'POST', body: '{}' , headers: { 'content-type': 'application/json' } });
      assert.equal((await post()).status, 503);
      assert.equal((await post()).status, 503);
      assert.equal((await post()).status, 200);
    } finally { await mock.close(); }
  });

  it('counts flakiness per endpoint, not per server', async () => {
    // Otherwise a token retry consumes the claim endpoint's failure budget and
    // the scenario silently tests something else.
    const mock = await startMockOptum({ behaviour: { kind: 'flaky', times: 1, status: 503 } });
    try {
      const submission = `${mock.url}/medicalnetwork/professionalclaims/v3/submission`;
      const validation = `${mock.url}/medicalnetwork/professionalclaims/v3/validation`;
      assert.equal((await fetch(submission, { method: 'POST', body: '{}' })).status, 503);
      assert.equal((await fetch(validation, { method: 'POST', body: '{}' })).status, 503);
      assert.equal((await fetch(submission, { method: 'POST', body: '{}' })).status, 200);
    } finally { await mock.close(); }
  });
});
