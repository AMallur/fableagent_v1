import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { benchmarkMarkdown, runBenchmark } from '../src/pilot/benchmark.ts';

describe('commercial pilot benchmark', () => {
  it('detects the synthetic ground truth without false positives or dollar drift', () => {
    const metrics = runBenchmark(1_000);
    assert.equal(metrics.lines, 1_000);
    assert.equal(metrics.falsePositives, 0);
    assert.equal(metrics.falseNegatives, 0);
    assert.equal(metrics.precision, 1);
    assert.equal(metrics.recall, 1);
    assert.equal(metrics.dollarAccuracy, 1);
    assert.equal(metrics.expectedRecovery, metrics.detectedRecovery);
  });

  it('labels the report as synthetic rather than recovered revenue', () => {
    const report = benchmarkMarkdown(runBenchmark(20));
    assert.match(report, /wholly synthetic/i);
    assert.match(report, /not .*recovered revenue/i);
  });
});
