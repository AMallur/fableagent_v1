import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  it('calculates conservative metrics and preregistered gates', () => {
    const metrics = calculateValidationMetrics({
      ...metadata,
      eligibleLines: 100,
      matchedAndPricedLines: 90,
      groundTruthComplete: true,
      gates: {
        minPrecision: 0.5,
        minRecall: 0.6,
        minDollarPrecision: 0.5,
        minDollarRecall: 0.8,
        minCoverage: 0.85,
        maxUnresolvedRate: 0.2,
      },
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
    assert.equal(metrics.gateResults.length, 6);
    assert.equal(metrics.gatesPassed, true);
    assert.ok(metrics.precision95 && metrics.precision95.lower < metrics.precision);
    assert.ok(metrics.recall95 && metrics.recall95.upper > metrics.recall);
  });

  it('fails recall gates when complete ground truth is absent', () => {
    const metrics = calculateValidationMetrics({
      ...metadata,
      eligibleLines: 20,
      matchedAndPricedLines: 20,
      groundTruthComplete: false,
      gates: { minPrecision: 0.9, minRecall: 0.8 },
      findings: [reviewed({ validatedAmount: 100 })],
      missedFindings: [],
    });
    assert.equal(metrics.precision, 1);
    assert.equal(metrics.recall, null);
    assert.equal(metrics.recall95, null);
    assert.equal(metrics.dollarRecall, null);
    assert.equal(metrics.gatesPassed, false);
    assert.deepEqual(metrics.gateResults.find((g) => g.gate === 'minRecall'), {
      gate: 'minRecall', threshold: 0.8, actual: null, passed: false,
    });
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

  it('rejects unsupported evidence states and undeclared fields', () => {
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

    const extraField = {
      ...metadata,
      eligibleLines: 1,
      matchedAndPricedLines: 1,
      groundTruthComplete: false,
      findings: [],
      missedFindings: [],
      patientName: 'not allowed',
    } as unknown as ValidationInput;
    assert.throws(() => calculateValidationMetrics(extraField), /patientName is not allowed/);
  });

  it('keeps the published de-identified example executable', async () => {
    const url = new URL('../../docs/examples/external_validation.example.json', import.meta.url);
    const example = JSON.parse(await readFile(url, 'utf8')) as ValidationInput;
    const metrics = calculateValidationMetrics(example);
    assert.equal(metrics.studyId, 'pilot-001');
    assert.equal(metrics.precision, 0.5);
    assert.equal(metrics.excluded, 1);
    assert.equal(metrics.recall, null);
  });
});
