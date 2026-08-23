import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateValidationMetrics } from '../src/pilot/validation_metrics.ts';

describe('external validation metrics', () => {
  it('calculates conservative count and amount metrics', () => {
    const metrics = calculateValidationMetrics({
      eligibleLines: 100,
      matchedAndPricedLines: 90,
      groundTruthComplete: true,
      findings: [
        { id: 'a', payer: 'P1', category: 'type-a', predictedAmount: 100, validatedAmount: 90, label: 'valid' },
        { id: 'b', payer: 'P1', category: 'type-b', predictedAmount: 50, validatedAmount: 50, label: 'valid' },
        { id: 'c', payer: 'P2', category: 'type-b', predictedAmount: 80, validatedAmount: 0, label: 'invalid' },
        { id: 'd', payer: 'P2', category: 'other', predictedAmount: 40, validatedAmount: 0, label: 'excluded' },
        { id: 'e', payer: 'P2', category: 'other', predictedAmount: 25, validatedAmount: 0, label: 'unresolved' },
      ],
      missedFindings: [
        { id: 'm1', payer: 'P1', category: 'type-a', validatedAmount: 30 },
      ],
    });

    assert.equal(metrics.adjudicated, 3);
    assert.equal(metrics.valid, 2);
    assert.equal(metrics.invalid, 1);
    assert.equal(metrics.precision, 0.6667);
    assert.equal(metrics.recall, 0.6667);
    assert.equal(metrics.coverage, 0.9);
    assert.equal(metrics.unresolvedRate, 0.2);
    assert.equal(metrics.predictedAdjudicatedDollars, 230);
    assert.equal(metrics.validatedDollars, 140);
    assert.equal(metrics.missedDollars, 30);
    assert.equal(metrics.dollarPrecision, 0.6087);
    assert.equal(metrics.dollarRecall, 0.8235);
    assert.ok(metrics.precision95 && metrics.precision95.lower < metrics.precision);
    assert.ok(metrics.recall95 && metrics.recall95.upper > metrics.recall);
  });

  it('does not report recall without complete ground truth', () => {
    const metrics = calculateValidationMetrics({
      eligibleLines: 20,
      matchedAndPricedLines: 20,
      groundTruthComplete: false,
      findings: [
        { id: 'a', payer: 'P1', category: 'type-a', predictedAmount: 100, validatedAmount: 100, label: 'valid' },
      ],
      missedFindings: [],
    });
    assert.equal(metrics.precision, 1);
    assert.equal(metrics.recall, null);
    assert.equal(metrics.recall95, null);
    assert.equal(metrics.dollarRecall, null);
  });

  it('rejects contradictory labels and amounts', () => {
    assert.throws(() => calculateValidationMetrics({
      eligibleLines: 10,
      matchedAndPricedLines: 10,
      groundTruthComplete: true,
      findings: [
        { id: 'a', payer: 'P1', category: 'type-b', predictedAmount: 50, validatedAmount: 10, label: 'invalid' },
      ],
      missedFindings: [],
    }), /invalid findings require validatedAmount = 0/);
  });
});
