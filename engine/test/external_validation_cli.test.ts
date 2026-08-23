import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

function baseInput() {
  return {
    schemaVersion: 1,
    studyId: 'cli-gate-test',
    datasetId: 'dataset-1',
    datasetManifestSha256: 'a'.repeat(64),
    engineCommit: 'test-commit',
    protocolVersion: 'external-validation-v1',
    groundTruthComplete: false,
    eligibleLines: 10,
    matchedAndPricedLines: 10,
    findings: [
      {
        id: 'finding-1', payer: 'P1', category: 'underpayment',
        predictedAmount: 100, validatedAmount: 0, disposition: 'false_positive',
        reviewerId: 'reviewer-1', reviewedAt: '2026-08-22T12:00:00Z',
      },
    ],
    missedFindings: [],
  };
}

function run(input: object) {
  const root = mkdtempSync(join(tmpdir(), 'fable-validation-cli-'));
  const inputPath = join(root, 'input.json');
  const outputDir = join(root, 'output');
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  const result = spawnSync(
    process.execPath,
    ['scripts/run_external_validation.ts', '--input', inputPath, '--output-dir', outputDir],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  return { result, outputDir };
}

describe('external validation CLI gates', () => {
  it('returns nonzero when preregistered acceptance gates fail, while preserving evidence', () => {
    const { result, outputDir } = run({ ...baseInput(), gates: { minPrecision: 0.9 } });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /Pre-registered gates passed: no/);

    const metrics = JSON.parse(readFileSync(join(outputDir, 'metrics.json'), 'utf8'));
    assert.equal(metrics.metrics.gatesPassed, false);
    assert.equal(metrics.metrics.gateResults[0].gate, 'minPrecision');
    assert.match(readFileSync(join(outputDir, 'report.md'), 'utf8'), /Overall: \*\*FAIL\*\*/);
  });

  it('returns zero for a descriptive study with no preregistered gates', () => {
    const { result, outputDir } = run(baseInput());
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const metrics = JSON.parse(readFileSync(join(outputDir, 'metrics.json'), 'utf8'));
    assert.equal(metrics.metrics.gatesPassed, null);
  });
});
