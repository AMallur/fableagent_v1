import { runEngine } from '../engine.ts';
import { makeConfig, round2 } from '../config.ts';
import type { ClaimInput, EngineInput, RemitLineInput } from '../types.ts';

export type BenchmarkScenario =
  | 'full_payment' | 'patient_responsibility' | 'underpayment_10'
  | 'underpayment_30' | 'hard_denial' | 'split_full' | 'split_underpayment'
  | 'supplemental_underpayment' | 'unknown_patient_responsibility' | 'replayed_remit';

interface TruthRow {
  claimId: string;
  scenario: BenchmarkScenario;
  shouldFlag: boolean;
  expectedRecovery: number;
}

export interface BenchmarkMetrics {
  generatedAt: string;
  synthetic: true;
  lines: number;
  expectedPositives: number;
  detectedPositives: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number;
  recall: number;
  falsePositiveRate: number;
  dollarAccuracy: number;
  expectedRecovery: number;
  detectedRecovery: number;
  scenarioResults: Record<BenchmarkScenario, {
    lines: number; expectedPositives: number; detectedPositives: number;
    falsePositives: number; falseNegatives: number;
  }>;
}

const TENANT = 'benchmark-tenant';
const CLIENT = 'benchmark-client';
const PAYER = 'benchmark-payer';
const PATIENT = 'benchmark-patient';
const DOS = '2026-06-01';

export function buildBenchmark(lineCount = 1_000): { input: EngineInput; truth: TruthRow[] } {
  if (!Number.isInteger(lineCount) || lineCount < 10) {
    throw new Error('benchmark line count must be an integer of at least 10');
  }
  const scenarios: BenchmarkScenario[] = [
    'full_payment', 'patient_responsibility', 'underpayment_10', 'underpayment_30',
    'hard_denial', 'split_full', 'split_underpayment', 'supplemental_underpayment',
    'unknown_patient_responsibility', 'replayed_remit',
  ];
  const claims: ClaimInput[] = [];
  const remitLines: RemitLineInput[] = [];
  const truth: TruthRow[] = [];

  for (let i = 0; i < lineCount; i++) {
    const scenario = scenarios[i % scenarios.length];
    const claimId = `benchmark-claim-${i + 1}`;
    const claimLineId = `benchmark-line-${i + 1}`;
    const payerClaimNumber = `BENCH-ICN-${i + 1}`;
    const claim: ClaimInput = {
      claimId, clientId: CLIENT, payerId: PAYER, patientId: PATIENT,
      claimNumberInternal: `BENCH-CLM-${i + 1}`, claimNumberPayer: payerClaimNumber,
      dateOfServiceStart: DOS, submissionDate: '2026-06-02', claimStatus: 'submitted',
      authorizationNumber: null, availableDocumentTypes: ['contract'],
      lines: [{
        claimLineId, lineNumber: 1, procedureCode: '99213', modifiers: [], units: 1,
        billedAmount: 150, paidAmount: null, patientResponsibility: null,
      }],
    };
    const base: RemitLineInput = {
      remittanceLineId: `benchmark-remit-line-${i + 1}-1`,
      remittanceId: `benchmark-remit-${i + 1}-1`, payerId: PAYER,
      checkDate: '2026-06-20', payerClaimNumber, procedureCode: '99213',
      billedAmount: 150, allowedAmount: 100, paidAmount: 100,
      patientResponsibility: 0, adjustments: [],
    };
    let shouldFlag = false;
    let expectedRecovery = 0;

    switch (scenario) {
      case 'full_payment':
        remitLines.push(base);
        break;
      case 'patient_responsibility':
        remitLines.push({ ...base, paidAmount: 80, patientResponsibility: 20,
          adjustments: [{ groupCode: 'PR', reasonCode: '2', amount: 20 }] });
        break;
      case 'underpayment_10':
        remitLines.push({ ...base, paidAmount: 90 });
        // Detected at the line level but intentionally below the default $25
        // recovery-case threshold.
        break;
      case 'underpayment_30':
        remitLines.push({ ...base, paidAmount: 70 });
        shouldFlag = true; expectedRecovery = 30;
        break;
      case 'hard_denial':
        remitLines.push({ ...base, paidAmount: 0,
          adjustments: [{ groupCode: 'CO', reasonCode: '50', amount: 100 }] });
        shouldFlag = true; expectedRecovery = 100;
        break;
      case 'split_full':
        remitLines.push({ ...base, paidAmount: 60 });
        remitLines.push({ ...base, remittanceLineId: `${base.remittanceLineId}-split`,
          remittanceId: `${base.remittanceId}-split`, checkDate: '2026-06-21', paidAmount: 40 });
        break;
      case 'split_underpayment':
        remitLines.push({ ...base, paidAmount: 40 });
        remitLines.push({ ...base, remittanceLineId: `${base.remittanceLineId}-split`,
          remittanceId: `${base.remittanceId}-split`, checkDate: '2026-06-21', paidAmount: 30 });
        shouldFlag = true; expectedRecovery = 30;
        break;
      case 'supplemental_underpayment':
        claim.lines[0].paidAmount = 50;
        claim.lines[0].patientResponsibility = 0;
        remitLines.push({ ...base, paidAmount: 20 });
        shouldFlag = true; expectedRecovery = 30;
        break;
      case 'unknown_patient_responsibility':
        remitLines.push({ ...base, paidAmount: 60, patientResponsibility: null,
          adjustments: [{ groupCode: 'CO', reasonCode: '45', amount: 40 }] });
        break;
      case 'replayed_remit':
        claim.lines[0].paidAmount = 70;
        claim.lines[0].patientResponsibility = 0;
        remitLines.push({ ...base, paidAmount: 80, previouslyProcessed: true });
        shouldFlag = true; expectedRecovery = 30;
        break;
    }
    claims.push(claim);
    truth.push({ claimId, scenario, shouldFlag, expectedRecovery });
  }

  return {
    input: {
      tenantId: TENANT,
      config: makeConfig('2026-07-01'),
      payers: [{ payerId: PAYER, payerName: 'Synthetic Benchmark Payer', appealDeadlineDays: 180 }],
      patients: [{ patientId: PATIENT, insuranceIdPrimary: 'SYNTHETIC-MEMBER' }],
      claims,
      remitLines,
      contracts: [{
        contractId: 'benchmark-contract', clientId: CLIENT, payerId: PAYER,
        effectiveDate: '2026-01-01', feeScheduleType: 'fee_schedule',
        lines: [{ procedureCode: '99213', allowedAmount: 100 }],
      }],
      medicareRates: {}, medicareLocalityByClient: {},
      existingCases: [], winRates: [], clientPayerConfigs: [],
      clientAlertThresholds: {},
    },
    truth,
  };
}

export function runBenchmark(lineCount = 1_000): BenchmarkMetrics {
  const { input, truth } = buildBenchmark(lineCount);
  const result = runEngine(input);
  const detected = new Map(
    [...result.casesCreated, ...result.casesUpdated].map((c) => [c.claimId, c.recoveryOpportunity]),
  );
  let tp = 0; let fp = 0; let fn = 0; let tn = 0;
  let expectedDollars = 0; let absoluteDollarError = 0;
  const scenarioResults = Object.fromEntries(
    [...new Set(truth.map((t) => t.scenario))].map((scenario) => [scenario, {
      lines: 0, expectedPositives: 0, detectedPositives: 0, falsePositives: 0, falseNegatives: 0,
    }]),
  ) as BenchmarkMetrics['scenarioResults'];

  for (const row of truth) {
    const actual = detected.get(row.claimId);
    const flagged = actual != null;
    const scenario = scenarioResults[row.scenario];
    scenario.lines += 1;
    if (row.shouldFlag) scenario.expectedPositives += 1;
    if (flagged) scenario.detectedPositives += 1;
    if (row.shouldFlag && flagged) tp += 1;
    else if (!row.shouldFlag && flagged) { fp += 1; scenario.falsePositives += 1; }
    else if (row.shouldFlag) { fn += 1; scenario.falseNegatives += 1; }
    else tn += 1;
    expectedDollars += row.expectedRecovery;
    absoluteDollarError += Math.abs((actual ?? 0) - row.expectedRecovery);
  }
  const detectedDollars = [...detected.values()].reduce((sum, n) => sum + n, 0);
  return {
    generatedAt: new Date().toISOString(), synthetic: true, lines: truth.length,
    expectedPositives: tp + fn, detectedPositives: tp + fp,
    truePositives: tp, falsePositives: fp, falseNegatives: fn, trueNegatives: tn,
    precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn),
    falsePositiveRate: ratio(fp, fp + tn),
    dollarAccuracy: expectedDollars === 0 ? 1
      : round2(Math.max(0, 1 - absoluteDollarError / expectedDollars)),
    expectedRecovery: round2(expectedDollars), detectedRecovery: round2(detectedDollars),
    scenarioResults,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Math.round((numerator / denominator) * 10_000) / 10_000;
}

export function benchmarkMarkdown(metrics: BenchmarkMetrics): string {
  const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
  const rows = Object.entries(metrics.scenarioResults).map(([name, r]) =>
    `| ${name} | ${r.lines} | ${r.expectedPositives} | ${r.detectedPositives} | ${r.falsePositives} | ${r.falseNegatives} |`).join('\n');
  return `# FableAgent synthetic pilot benchmark\n\n`
    + `> This is a deterministic technical benchmark using wholly synthetic claims and remittances. `
    + `It is not clinical validation, customer evidence, or recovered revenue.\n\n`
    + `Generated: ${metrics.generatedAt}\n\n`
    + `| Metric | Result |\n|---|---:|\n`
    + `| Claim lines | ${metrics.lines} |\n`
    + `| Precision | ${pct(metrics.precision)} |\n`
    + `| Recall | ${pct(metrics.recall)} |\n`
    + `| False-positive rate | ${pct(metrics.falsePositiveRate)} |\n`
    + `| Dollar accuracy | ${pct(metrics.dollarAccuracy)} |\n`
    + `| Expected opportunity | $${metrics.expectedRecovery.toFixed(2)} |\n`
    + `| Detected opportunity | $${metrics.detectedRecovery.toFixed(2)} |\n\n`
    + `## Scenario coverage\n\n`
    + `| Scenario | Lines | Expected flags | Detected flags | False positives | False negatives |\n`
    + `|---|---:|---:|---:|---:|---:|\n${rows}\n`;
}
