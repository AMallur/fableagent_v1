import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  runCmsPublicPoc,
  type CmsPublicPocFixture,
  type CmsPocFinding,
} from '../src/pilot/cms_public_poc.ts';

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const fixturePath = resolve(arg('--fixture') ?? 'testdata/cms_2024_public_poc_fixture.json');
const outputDir = resolve(arg('--output-dir') ?? 'var/cms_public_poc');
const engineCommit = arg('--engine-commit') ?? process.env.GITHUB_SHA ?? 'local-unpinned';

const raw = await readFile(fixturePath, 'utf8');
const fixtureSha256 = createHash('sha256').update(raw).digest('hex');
const fixture = JSON.parse(raw) as CmsPublicPocFixture;
const result = runCmsPublicPoc(fixture);
await mkdir(outputDir, { recursive: true });

const summary = {
  schemaVersion: 1,
  evidenceType: 'public-data-anchored-controlled-perturbation-poc',
  engineCommit,
  fixtureSha256,
  sourceDataset: fixture.dataset,
  metrics: result.metrics,
  claimBoundary: {
    publicData: 'CMS 2024 provider-service aggregate values as displayed in the public lookup tool',
    syntheticData: 'claim/remittance identifiers and controlled reductions in payer payment for perturbed copies',
    notDemonstrated: [
      'real claim-level 837P/835 interoperability on these CMS rows',
      'actual historical payer underpayments',
      'independent RCM adjudication',
      'recovered cash',
      'customer validation',
    ],
  },
};

await writeFile(resolve(outputDir, 'poc_summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(resolve(outputDir, 'poc_findings.csv'), findingsCsv(result.findings));
await writeFile(resolve(outputDir, 'poc_report.md'), reportMarkdown(summary, result.findings));

console.log(JSON.stringify(summary, null, 2));

if (result.metrics.falsePositives !== 0
  || result.metrics.falseNegatives !== 0
  || result.metrics.dollarDetectionAbsoluteError !== 0
  || result.metrics.casesCreated !== result.metrics.expectedCasesAtThreshold) {
  console.error('CMS public-data POC acceptance checks failed.');
  process.exitCode = 1;
}

function findingsCsv(findings: CmsPocFinding[]): string {
  const headers = [
    'scenario', 'npi', 'providerName', 'sourceUrl', 'hcpcs', 'setting',
    'services', 'beneficiaries', 'avgSubmitted', 'avgAllowed', 'avgMedicarePayment',
    'mappedNonMedicareResponsibility', 'perturbationRate', 'injectedUnderpayment',
    'engineExpectedAmount', 'enginePaidAmount', 'engineLineStatus', 'detected',
    'caseDisposition', 'engineRecoveryOpportunity',
  ];
  const lines = [headers.join(',')];
  for (const finding of findings) {
    const values = headers.map((header) => (finding as unknown as Record<string, unknown>)[header]);
    lines.push(values.map(csv).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function csv(value: unknown): string {
  if (value == null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function reportMarkdown(
  summary: typeof summary,
  findings: CmsPocFinding[],
): string {
  const m = summary.metrics;
  const top = findings
    .filter((item) => item.scenario === 'perturbed')
    .sort((a, b) => b.injectedUnderpayment - a.injectedUnderpayment)
    .slice(0, 10);
  const topRows = top.map((item) =>
    `| ${item.npi} | ${item.hcpcs} | ${item.setting} | $${item.avgAllowed.toFixed(2)} | `
    + `$${item.avgMedicarePayment.toFixed(2)} | $${item.injectedUnderpayment.toFixed(2)} | `
    + `${item.detected ? 'yes' : 'no'} | ${item.caseDisposition} |`,
  ).join('\n');

  return `# FableAgent public-data proof of concept\n\n`
    + `**Evidence class:** public-data-anchored controlled perturbation test  \n`
    + `**Engine commit:** \`${summary.engineCommit}\`  \n`
    + `**Fixture SHA-256:** \`${summary.fixtureSha256}\`\n\n`
    + `## Executive result\n\n`
    + `FableAgent processed ${m.engineScenarioLines} claim/remittance scenarios derived from `
    + `${m.sourceServiceRows} real CMS provider-service observations. Half were unchanged controls and `
    + `half were controlled payment perturbations with known ground truth. The experiment produced `
    + `${pct(m.precision)} precision, ${pct(m.recall)} recall, and ${pct(m.specificity)} specificity `
    + `for detecting the injected payer-payment variances, with $${m.dollarDetectionAbsoluteError.toFixed(2)} `
    + `absolute error in quantified opportunity dollars.\n\n`
    + `This is a technical proof of the deterministic matching, fee-schedule pricing, patient-responsibility `
    + `normalization, variance detection, thresholding, and case-creation path. It is not customer validation `
    + `and does not show that CMS actually underpaid any claim.\n\n`
    + `## Public source corpus\n\n`
    + `- Dataset: ${summary.sourceDataset.name}\n`
    + `- Data year: ${summary.sourceDataset.year}\n`
    + `- CMS dataset: ${summary.sourceDataset.sourceDatasetUrl}\n`
    + `- CMS lookup tool: ${summary.sourceDataset.sourceToolUrl}\n`
    + `- Source providers sampled: ${m.sourceProviderCount}\n`
    + `- Provider-service observations: ${m.sourceServiceRows}\n`
    + `- Published service count represented by those rows: ${m.representedServiceCount.toLocaleString()}\n`
    + `- Published beneficiary counts summed across rows: ${m.representedBeneficiaryCount.toLocaleString()} `
    + `(not unique beneficiaries across rows)\n\n`
    + `${summary.sourceDataset.note}\n\n`
    + `## Test design\n\n`
    + `1. Each CMS provider-service row supplies HCPCS, setting, average submitted charge, average Medicare `
    + `allowed amount, and average Medicare payment.\n`
    + `2. The displayed average allowed amount is loaded as a provider-specific fee-schedule reference.\n`
    + `3. Allowed minus Medicare payment is mapped to the engine's patient-responsibility field solely for `
    + `aggregate economic normalization. CMS states allowed amount includes Medicare payment plus deductible, `
    + `coinsurance, and amounts for which a third party may be responsible.\n`
    + `4. A control claim/remit pair preserves the displayed Medicare payment.\n`
    + `5. A second copy receives a deterministic 25%, 35%, 50%, or 65% reduction in Medicare payment. `
    + `Those reductions are synthetic known underpayments, not observations from CMS.\n`
    + `6. FableAgent runs its normal payer-claim-number matching, contract pricing, expected-payer calculation, `
    + `variance detection, scoring, and $${m.productionThresholdDollars.toFixed(0)} case threshold.\n\n`
    + `## Results\n\n`
    + `| Measure | Result |\n|---|---:|\n`
    + `| Control scenarios | ${m.controls} |\n`
    + `| Perturbed scenarios | ${m.perturbed} |\n`
    + `| True positives | ${m.truePositives} |\n`
    + `| False positives | ${m.falsePositives} |\n`
    + `| False negatives | ${m.falseNegatives} |\n`
    + `| True negatives | ${m.trueNegatives} |\n`
    + `| Precision | ${pct(m.precision)} |\n`
    + `| Recall | ${pct(m.recall)} |\n`
    + `| Specificity | ${pct(m.specificity)} |\n`
    + `| Injected variance dollars | $${m.injectedUnderpaymentDollars.toFixed(2)} |\n`
    + `| Engine quantified opportunity | $${m.detectedOpportunityDollars.toFixed(2)} |\n`
    + `| Absolute dollar error | $${m.dollarDetectionAbsoluteError.toFixed(2)} |\n`
    + `| Cases created at $${m.productionThresholdDollars.toFixed(0)} threshold | ${m.casesCreated} |\n`
    + `| Expected cases at threshold | ${m.expectedCasesAtThreshold} |\n`
    + `| Detected but below threshold | ${m.belowThresholdDetections} |\n`
    + `| Opportunity dollars in created cases | $${m.caseOpportunityDollars.toFixed(2)} |\n`
    + `| Opportunity dollars below threshold | $${m.belowThresholdOpportunityDollars.toFixed(2)} |\n\n`
    + `## Highest-value controlled examples\n\n`
    + `| NPI | HCPCS | Setting | CMS avg allowed | CMS avg payment | Injected variance | Detected | Case result |\n`
    + `|---|---|---|---:|---:|---:|---|---|\n${topRows}\n\n`
    + `## What this proves\n\n`
    + `- The production engine can consume a fee-schedule representation grounded in real CMS public economics.\n`
    + `- Matching and reimbursement calculations remain stable on unchanged control scenarios.\n`
    + `- Known payment shortfalls are detected and quantified through the same deterministic engine path used by FableAgent.\n`
    + `- The production $${m.productionThresholdDollars.toFixed(0)} case threshold separates detected leakage from actionable cases as designed.\n`
    + `- Results are reproducible from a versioned fixture, engine commit, JSON output, finding-level CSV, and evidence hash.\n\n`
    + `## What this does not prove\n\n`
    + `- These CMS rows are aggregates, not claim-level 837P/835 transactions.\n`
    + `- The perturbations are synthetic. They do not establish that CMS or any commercial payer underpaid these providers.\n`
    + `- The CMS allowed amount is used as the reference fee schedule in this experiment; this is not an independent `
    + `reconstruction of the 2024 Medicare Physician Fee Schedule.\n`
    + `- No provider, payer, coder, reimbursement specialist, or independent RCM reviewer adjudicated the findings.\n`
    + `- No appeals were submitted and no recovered cash is claimed.\n`
    + `- This is not HIPAA, SOC 2, payer, clearinghouse, or clinical certification.\n\n`
    + `## Next evidence gate\n\n`
    + `Run the same engine release on a frozen retrospective provider dataset containing raw 837P claims, corresponding `
    + `835 remittances, executed reimbursement terms, and independent RCM adjudication. That study can establish `
    + `real-world precision and dollar accuracy; only post-action payment reconciliation can establish recovered revenue.\n`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
