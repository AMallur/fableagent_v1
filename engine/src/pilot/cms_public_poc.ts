import { runEngine } from '../engine.ts';
import type { ContractInput, EngineInput } from '../types.ts';

export interface CmsPublicPocDataset {
  name: string;
  year: number;
  sourceDatasetUrl: string;
  sourceToolUrl: string;
  accessedDate: string;
  note: string;
}

export type CmsPublicServiceRow = [
  hcpcs: string,
  setting: 'Office' | 'Facility',
  services: number,
  beneficiaries: number,
  avgSubmitted: number,
  avgAllowed: number,
  avgMedicarePayment: number,
];

export interface CmsPublicProvider {
  npi: string;
  name: string;
  source: string;
  rows: CmsPublicServiceRow[];
}

export interface CmsPublicPocFixture {
  schemaVersion: 1;
  dataset: CmsPublicPocDataset;
  columns: string[];
  providers: CmsPublicProvider[];
}

export interface CmsPocFinding {
  scenario: 'control' | 'perturbed';
  npi: string;
  providerName: string;
  sourceUrl: string;
  hcpcs: string;
  setting: 'Office' | 'Facility';
  services: number;
  beneficiaries: number;
  avgSubmitted: number;
  avgAllowed: number;
  avgMedicarePayment: number;
  mappedNonMedicareResponsibility: number;
  perturbationRate: number;
  injectedUnderpayment: number;
  engineExpectedAmount: number | null;
  enginePaidAmount: number | null;
  engineLineStatus: string | null;
  detected: boolean;
  caseDisposition: 'created' | 'below_threshold' | 'none';
  engineRecoveryOpportunity: number;
}

export interface CmsPocMetrics {
  sourceProviderCount: number;
  sourceServiceRows: number;
  representedServiceCount: number;
  representedBeneficiaryCount: number;
  engineScenarioLines: number;
  controls: number;
  perturbed: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number;
  recall: number;
  specificity: number;
  injectedUnderpaymentDollars: number;
  detectedOpportunityDollars: number;
  dollarDetectionAbsoluteError: number;
  productionThresholdDollars: number;
  casesCreated: number;
  expectedCasesAtThreshold: number;
  belowThresholdDetections: number;
  caseOpportunityDollars: number;
  belowThresholdOpportunityDollars: number;
}

export interface CmsPublicPocResult {
  fixture: CmsPublicPocFixture;
  metrics: CmsPocMetrics;
  findings: CmsPocFinding[];
}

const PAYER_ID = 'cms-medicare-ffs';
const PERTURBATION_RATES = [0.25, 0.35, 0.50, 0.65] as const;
const CASE_THRESHOLD = 25;

export function runCmsPublicPoc(fixture: CmsPublicPocFixture): CmsPublicPocResult {
  validateFixture(fixture);
  const claims: EngineInput['claims'] = [];
  const remitLines: EngineInput['remitLines'] = [];
  const patients: EngineInput['patients'] = [];
  const contracts: ContractInput[] = [];
  const clientPayerConfigs: EngineInput['clientPayerConfigs'] = [];
  const scenarioMeta = new Map<string, Omit<CmsPocFinding,
    'engineExpectedAmount' | 'enginePaidAmount' | 'engineLineStatus' | 'detected'
    | 'caseDisposition' | 'engineRecoveryOpportunity'>>();

  let globalRowIndex = 0;
  for (const provider of fixture.providers) {
    const clientId = `cms-npi-${provider.npi}`;
    contracts.push({
      contractId: `cms-public-reference-${provider.npi}`,
      clientId,
      payerId: PAYER_ID,
      effectiveDate: '2024-01-01',
      expirationDate: '2024-12-31',
      feeScheduleType: 'fee_schedule',
      lines: provider.rows.map(([hcpcs, _setting, _services, _beneficiaries, _submitted, allowed]) => ({
        procedureCode: hcpcs,
        allowedAmount: allowed,
        effectiveDate: '2024-01-01',
      })),
    });
    clientPayerConfigs.push({
      clientId,
      payerId: PAYER_ID,
      autopilotEnabled: false,
      minCaseThreshold: CASE_THRESHOLD,
    });

    for (const row of provider.rows) {
      const [hcpcs, setting, services, beneficiaries, avgSubmitted, avgAllowed, avgPayment] = row;
      const nonMedicareResponsibility = round2(Math.max(0, avgAllowed - avgPayment));
      const perturbationRate = PERTURBATION_RATES[globalRowIndex % PERTURBATION_RATES.length];
      const injected = avgPayment <= 0
        ? 0
        : round2(Math.min(avgPayment, Math.max(1, avgPayment * perturbationRate)));

      for (const scenario of ['control', 'perturbed'] as const) {
        const suffix = `${provider.npi}-${globalRowIndex}-${scenario}`;
        const claimId = `claim-${suffix}`;
        const claimLineId = `line-${suffix}`;
        const patientId = `patient-${suffix}`;
        const payerClaimNumber = `CMSPOC-${suffix}`;
        const paidAmount = scenario === 'control' ? avgPayment : round2(avgPayment - injected);
        const placeOfService = setting === 'Office' ? '11' : '21';

        patients.push({ patientId, insuranceIdPrimary: `MEMBER-${suffix}` });
        claims.push({
          claimId,
          clientId,
          payerId: PAYER_ID,
          patientId,
          claimNumberInternal: `INT-${suffix}`,
          claimNumberPayer: payerClaimNumber,
          dateOfServiceStart: '2024-06-15',
          placeOfService,
          submissionDate: '2024-06-20',
          claimStatus: 'submitted',
          authorizationNumber: null,
          availableDocumentTypes: [],
          lines: [{
            claimLineId,
            lineNumber: 1,
            procedureCode: hcpcs,
            modifiers: [],
            units: 1,
            billedAmount: avgSubmitted,
          }],
        });
        remitLines.push({
          remittanceLineId: `remit-line-${suffix}`,
          remittanceId: `remit-${suffix}`,
          payerId: PAYER_ID,
          checkDate: '2024-07-15',
          payerClaimNumber,
          patientMemberId: `MEMBER-${suffix}`,
          dateOfService: '2024-06-15',
          procedureCode: hcpcs,
          billedAmount: avgSubmitted,
          allowedAmount: avgAllowed,
          paidAmount,
          patientResponsibility: nonMedicareResponsibility,
        });
        scenarioMeta.set(claimLineId, {
          scenario,
          npi: provider.npi,
          providerName: provider.name,
          sourceUrl: provider.source,
          hcpcs,
          setting,
          services,
          beneficiaries,
          avgSubmitted,
          avgAllowed,
          avgMedicarePayment: avgPayment,
          mappedNonMedicareResponsibility: nonMedicareResponsibility,
          perturbationRate: scenario === 'perturbed' ? perturbationRate : 0,
          injectedUnderpayment: scenario === 'perturbed' ? injected : 0,
        });
      }
      globalRowIndex += 1;
    }
  }

  const input: EngineInput = {
    tenantId: 'cms-public-poc',
    config: {
      asOf: '2024-09-01',
      minCaseThreshold: CASE_THRESHOLD,
      varianceDollarTrigger: 25,
      variancePercentTrigger: 0.05,
      defaultAppealDeadlineDays: 90,
      criticalDeadlineDays: 14,
      criticalAmount: 5000,
      highDeadlineDays: 30,
      highAmount: 1000,
      mediumDeadlineDays: 60,
    },
    payers: [{
      payerId: PAYER_ID,
      payerName: 'Original Medicare FFS - public POC',
      appealDeadlineDays: 90,
      timelyFilingLimitDays: 365,
    }],
    patients,
    claims,
    remitLines,
    contracts,
    medicareRates: {},
    medicareLocalityByClient: {},
    existingCases: [],
    winRates: [],
    clientPayerConfigs,
    clientAlertThresholds: Object.fromEntries(
      fixture.providers.map((provider) => [`cms-npi-${provider.npi}`, 500]),
    ),
  };

  const output = runEngine(input);
  const updates = new Map(output.claimLineUpdates.map((update) => [update.claimLineId, update]));
  const createdByLine = new Map(output.casesCreated.map((item) => [item.claimLineId, item]));
  const skippedByLine = new Map(output.skipped.map((item) => [item.claimLineId, item]));

  const findings: CmsPocFinding[] = [...scenarioMeta.entries()].map(([claimLineId, meta]) => {
    const update = updates.get(claimLineId);
    const created = createdByLine.get(claimLineId);
    const skipped = skippedByLine.get(claimLineId);
    const detected = update?.lineStatus === 'underpaid';
    const caseDisposition = created
      ? 'created'
      : skipped?.reason === 'below_threshold'
        ? 'below_threshold'
        : 'none';
    return {
      ...meta,
      engineExpectedAmount: update?.expectedAmount ?? null,
      enginePaidAmount: update?.paidAmount ?? null,
      engineLineStatus: update?.lineStatus ?? null,
      detected,
      caseDisposition,
      engineRecoveryOpportunity: round2(created?.recoveryOpportunity ?? skipped?.recoveryOpportunity ?? 0),
    };
  });

  const controls = findings.filter((finding) => finding.scenario === 'control');
  const perturbed = findings.filter((finding) => finding.scenario === 'perturbed');
  const truePositives = perturbed.filter((finding) => finding.detected).length;
  const falseNegatives = perturbed.length - truePositives;
  const falsePositives = controls.filter((finding) => finding.detected).length;
  const trueNegatives = controls.length - falsePositives;
  const injectedDollars = money(perturbed.reduce((sum, item) => sum + item.injectedUnderpayment, 0));
  const detectedDollars = money(perturbed.reduce(
    (sum, item) => sum + item.engineRecoveryOpportunity, 0,
  ));
  const created = perturbed.filter((item) => item.caseDisposition === 'created');
  const belowThreshold = perturbed.filter((item) => item.caseDisposition === 'below_threshold');
  const expectedCasesAtThreshold = perturbed.filter(
    (item) => item.injectedUnderpayment >= CASE_THRESHOLD,
  ).length;

  const metrics: CmsPocMetrics = {
    sourceProviderCount: fixture.providers.length,
    sourceServiceRows: globalRowIndex,
    representedServiceCount: fixture.providers.flatMap((p) => p.rows)
      .reduce((sum, row) => sum + row[2], 0),
    representedBeneficiaryCount: fixture.providers.flatMap((p) => p.rows)
      .reduce((sum, row) => sum + row[3], 0),
    engineScenarioLines: findings.length,
    controls: controls.length,
    perturbed: perturbed.length,
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, truePositives + falseNegatives),
    specificity: ratio(trueNegatives, trueNegatives + falsePositives),
    injectedUnderpaymentDollars: injectedDollars,
    detectedOpportunityDollars: detectedDollars,
    dollarDetectionAbsoluteError: money(Math.abs(injectedDollars - detectedDollars)),
    productionThresholdDollars: CASE_THRESHOLD,
    casesCreated: created.length,
    expectedCasesAtThreshold,
    belowThresholdDetections: belowThreshold.length,
    caseOpportunityDollars: money(created.reduce((sum, item) => sum + item.engineRecoveryOpportunity, 0)),
    belowThresholdOpportunityDollars: money(belowThreshold.reduce(
      (sum, item) => sum + item.engineRecoveryOpportunity, 0,
    )),
  };

  return { fixture, metrics, findings };
}

function validateFixture(fixture: CmsPublicPocFixture): void {
  if (fixture.schemaVersion !== 1) throw new Error('CMS POC fixture schemaVersion must be 1');
  if (!fixture.providers.length) throw new Error('CMS POC fixture requires providers');
  for (const provider of fixture.providers) {
    if (!provider.npi || !provider.rows.length) throw new Error('CMS POC provider requires NPI and rows');
    const codes = new Set<string>();
    for (const row of provider.rows) {
      const [hcpcs, setting, services, beneficiaries, submitted, allowed, payment] = row;
      if (!hcpcs || codes.has(hcpcs)) throw new Error(`duplicate/empty HCPCS for ${provider.npi}: ${hcpcs}`);
      codes.add(hcpcs);
      if (setting !== 'Office' && setting !== 'Facility') throw new Error(`invalid setting: ${setting}`);
      for (const [name, value] of Object.entries({ services, beneficiaries, submitted, allowed, payment })) {
        if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${name} for ${provider.npi}/${hcpcs}`);
      }
      if (payment > allowed) throw new Error(`payment exceeds allowed for ${provider.npi}/${hcpcs}`);
    }
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function money(value: number): number {
  return round2(value);
}
