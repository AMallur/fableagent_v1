import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  calculateValidationMetrics,
  type ValidationInput,
} from '../src/pilot/validation_metrics.ts';

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const inputPath = arg('--input');
const outputDir = resolve(arg('--output-dir') ?? 'var/external_validation');
if (!inputPath) {
  console.error('Usage: node scripts/run_external_validation.ts --input <validation.json> [--output-dir <dir>]');
  process.exit(2);
}

const raw = await readFile(resolve(inputPath), 'utf8');
const reviewInputSha256 = createHash('sha256').update(raw).digest('hex');
const input = JSON.parse(raw) as ValidationInput;
const metrics = calculateValidationMetrics(input);
await mkdir(outputDir, { recursive: true });

const metricsPath = resolve(outputDir, 'metrics.json');
const reportPath = resolve(outputDir, 'report.md');
await writeFile(metricsPath, `${JSON.stringify({ reviewInputSha256, metrics }, null, 2)}\n`);
await writeFile(reportPath, markdown(metrics, reviewInputSha256));
console.log(`External validation metrics: ${metricsPath}`);
console.log(`External validation report: ${reportPath}`);
console.log(`Review input SHA-256: ${reviewInputSha256}`);
if (metrics.gatesPassed != null) console.log(`Pre-registered gates passed: ${metrics.gatesPassed ? 'yes' : 'no'}`);

function markdown(
  metrics: ReturnType<typeof calculateValidationMetrics>,
  reviewInputSha256: string,
): string {
  const pct = (n: number | null) => n == null ? 'not estimable' : `${(n * 100).toFixed(2)}%`;
  const ci = (value: typeof metrics.precision95) => value == null
    ? 'not estimable'
    : `${(value.lower * 100).toFixed(2)}%–${(value.upper * 100).toFixed(2)}%`;
  const gateRows = metrics.gateResults.map((g) =>
    `| ${g.gate} | ${pct(g.threshold)} | ${pct(g.actual)} | ${g.passed ? 'PASS' : 'FAIL'} |`,
  ).join('\n');
  const gateSection = metrics.gateResults.length === 0
    ? `## Pre-registered acceptance gates\n\nNo machine-readable gates were supplied. This report is descriptive only.\n\n`
    : `## Pre-registered acceptance gates\n\nOverall: **${metrics.gatesPassed ? 'PASS' : 'FAIL'}**\n\n`
      + `| Gate | Threshold | Actual | Result |\n|---|---:|---:|---:|\n${gateRows}\n\n`;

  return `# External validation metrics\n\n`
    + `> This report is only as independent as the underlying customer/reviewer evidence. `
    + `Generating this file does not create third-party validation.\n\n`
    + `## Evidence identity\n\n`
    + `- Study: ${metrics.studyId}\n`
    + `- Dataset: ${metrics.datasetId}\n`
    + `- Dataset manifest SHA-256: ${metrics.datasetManifestSha256}\n`
    + `- Review input SHA-256: ${reviewInputSha256}\n`
    + `- Engine commit: ${metrics.engineCommit}\n`
    + `- Protocol version: ${metrics.protocolVersion}\n`
    + `- Complete ground truth declared: ${metrics.groundTruthComplete ? 'yes' : 'no'}\n\n`
    + `## Primary metrics\n\n`
    + `| Metric | Result |\n|---|---:|\n`
    + `| Findings | ${metrics.findings} |\n`
    + `| Adjudicated findings | ${metrics.adjudicated} |\n`
    + `| True positives | ${metrics.truePositives} |\n`
    + `| Invalid findings | ${metrics.invalidFindings} |\n`
    + `| Excluded findings | ${metrics.excluded} |\n`
    + `| Unresolved findings | ${metrics.unresolved} |\n`
    + `| Independently found misses | ${metrics.missed} |\n`
    + `| Precision | ${pct(metrics.precision)} |\n`
    + `| Precision 95% CI | ${ci(metrics.precision95)} |\n`
    + `| Recall | ${pct(metrics.recall)} |\n`
    + `| Recall 95% CI | ${ci(metrics.recall95)} |\n`
    + `| Coverage | ${pct(metrics.coverage)} |\n`
    + `| Unresolved rate | ${pct(metrics.unresolvedRate)} |\n`
    + `| Predicted adjudicated dollars | $${metrics.predictedAdjudicatedDollars.toFixed(2)} |\n`
    + `| Validated true-positive dollars | $${metrics.validatedDollars.toFixed(2)} |\n`
    + `| Matched validated dollars | $${metrics.matchedValidatedDollars.toFixed(2)} |\n`
    + `| Missed validated dollars | $${metrics.missedDollars.toFixed(2)} |\n`
    + `| Dollar precision | ${pct(metrics.dollarPrecision)} |\n`
    + `| Dollar recall | ${pct(metrics.dollarRecall)} |\n\n`
    + `Matched validated dollars use min(predicted, validated) per true positive so dollar metrics remain bounded and penalize both overstatement and underestimation.\n\n`
    + gateSection
    + (metrics.recall == null
      ? `Recall and dollar recall are intentionally not reported because complete ground truth was not declared.\n`
      : `Recall is based on a declared complete ground-truth review and must be supported by the evidence bundle.\n`);
}
