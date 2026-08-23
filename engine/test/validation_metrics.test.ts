import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateValidationMetrics, type ValidationInput } from '../src/pilot/validation_metrics.ts';

const metadata = {
  schemaVersion: 1 as const,
  studyId: 'study-001',
  datasetId: 'dataset-001',
  datasetManifestSha256: 'a'.repeat(64),
  engineCommit: 'abc123',
  protocolVersion: 'external-validation-v1',
};

const reviewed = (overrides: Partial<ValidationInput['findings'][number]> = {}): ValidationInput['findings'][number] => ({
  id: 'a', payer: 'P1', category: 'type-a', predictedAmount: 100,
  validatedAmount: 90, disposition: 'true_positive', reviewerId: 'reviewer-1',
  reviewedAt: '2026-08-22T12:00:00Z', ...overrides,
});

describe('external validation metrics', () => {
  it('calculates conservative count and amount metrics', () => {
    const metrics = calculateValidationMetrics({
      ...metadata,
      eligibleLines: 100,
      matchedAndPricedLines: 90,
      groundTruthComplete: true,
      findings: [
        reviewed(),
        reviewed({ id: 'b', category: 'type-b', predictedAmount: 50, validatedAmount: 50 }),
        reviewed({ id: 'c', payer: 'P2', category: 'type-b', predictedAmount: 80, validatedAmount: 0, disposition: 'false_positive' }),
        reviewed({ id: 'd', payer: 'P2', category: 'type-b', predictedAmount: 20, validatedAmount: 0, disposition: 'duplicate' }),
        reviewed({ id: 'e', payer: 'P2', category: 'other', predictedAmount: 40, validatedAmount: 0, disposition: 'excluded', exclusionReason: 'pre-registered out of scope' }),
        reviewed({ id: 'f', payer: 'P2', category: 'other', predictedAmount: 25, validatedAmount: 0, disposition: 'unresolved' }),
      ],
      missedFindings: [
        { id: 'm1', payer: 'P1', category: 'type-a', validatedAmount: 30, reviewerId: 'reviewer-2', reviewedAt: '2026-08-22T13:00:00Z' },
      ],
    });

    assert.equal(metrics.adjudicated, 4);
    assert.equal(metrics.truePositives, 2);
    assert.equal(metrics.invalidFindings, 2);
    assert.equal(metrics.precision, 0.5);
    assert.equal(metrics.recall, 0.6667);
    assert.equal(metrics.coverage, 0.9);
    assert.equal(metrics.unresolvedRate, 0.1667);
    assert.equal(metrics.predictedAdjudicatedDollars, 250);
    assert.equal(metrics.validatedDollars, 140);
    assert.equal(metrics.missedDollars, 30);
    assert.equal(metrics.dollarPrecision, 0.56);
    assert.equal(metrics.dollarRecall, 0.8235);
    assert.equal(metrics.datasetManifestSha256, 'a'.repeat(64));
    assert.ok(metrics.precision95 && metrics.precision95.lower < metrics.precision);
    assert.ok(metrics.recall95 && metrics.recall95.upper > metrics.recall);
  });

  it('does not report recall without complete ground truth', () => {
    const metrics = calculateValidationMetrics({
      ...metadata,
      eligibleLines: 20,
      matchedAndPricedLines: 20,
      groundTruthComplete: false,
      findings: [reviewed({ validatedAmount: 100 })],
      missedFindings: [],
    });
    assert.equal(metrics.precision, 1);
    assert.equal(metrics.recall, null);
    assert.equal(metrics.recall95, null);
    assert.equal(metrics.dollarRecall, null);
  });

  it('counts duplicate outcomes against precision', () => {
    const metrics = calculateValidationMetrics({
      ...metadata,
      eligibleLines: 10,
      matchedAndPricedLines: 10,
      groundTruthComplete: true,
      findings: [
        reviewed({ validatedAmount: 100 }),
        reviewed({ id: 'dup', predictedAmount: 100, validatedAmount: 0, disposition: 'duplicate' }),
      ],
      missedFindings: [],
    });
    assert.equal(metrics.precision, 0.5);
    assert.equal(metrics.dollarPrecision, 0.5);
  });

  it('rejects unsupported evidence states', () => {
    assert.throws(() => calculateValidationMetrics({
      ...metadata,
      eligibleLines: 10,
      matchedAndPricedLines: 10,
      groundTruthComplete: true,
      findings: [reviewed({ disposition: 'false_positive', validatedAmount: 10 })],
      missedFindings: [],
    }), /non-true-positive findings require validatedAmount = 0/);

    assert.throws(() => calculateValidationMetrics({
      ...metadata,
      eligibleLines: 10,
      matchedAndPricedLines: 10,
      groundTruthComplete: true,
      findings: [reviewed({ disposition: 'excluded', validatedAmount: 0, exclusionReason: null })],
      missedFindings: [],
    }), /excluded finding requires exclusionReason/);
  });
});
