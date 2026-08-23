export type ValidationDisposition =
  | 'true_positive'
  | 'false_positive'
  | 'duplicate'
  | 'already_recovered'
  | 'excluded'
  | 'unresolved';

export interface ReviewedFinding {
  id: string;
  payer: string;
  category: string;
  predictedAmount: number;
  validatedAmount: number;
  disposition: ValidationDisposition;
  reviewerId: string;
  reviewedAt: string;
  secondReviewerId?: string | null;
  adjudicatorId?: string | null;
  rationaleRef?: string | null;
  exclusionReason?: string | null;
}

export interface MissedFinding {
  id: string;
  payer: string;
  category: string;
  validatedAmount: number;
  reviewerId: string;
  reviewedAt: string;
  secondReviewerId?: string | null;
  adjudicatorId?: string | null;
  rationaleRef?: string | null;
}

export interface ValidationGates {
  minPrecision?: number;
  minRecall?: number;
  minDollarPrecision?: number;
  minDollarRecall?: number;
  minCoverage?: number;
  maxUnresolvedRate?: number;
}

export interface ValidationInput {
  schemaVersion: 1;
  studyId: string;
  datasetId: string;
  datasetManifestSha256: string;
  engineCommit: string;
  protocolVersion: string;
  findings: ReviewedFinding[];
  missedFindings: MissedFinding[];
  groundTruthComplete: boolean;
  eligibleLines: number;
  matchedAndPricedLines: number;
  gates?: ValidationGates;
}

export interface Interval {
  lower: number;
  upper: number;
}

export interface GateResult {
  gate: keyof ValidationGates;
  threshold: number;
  actual: number | null;
  passed: boolean;
}

export interface ValidationMetrics {
  schemaVersion: 1;
  studyId: string;
  datasetId: string;
  datasetManifestSha256: string;
  engineCommit: string;
  protocolVersion: string;
  groundTruthComplete: boolean;
  findings: number;
  adjudicated: number;
  truePositives: number;
  invalidFindings: number;
  excluded: number;
  unresolved: number;
  missed: number;
  precision: number | null;
  precision95: Interval | null;
  recall: number | null;
  recall95: Interval | null;
  coverage: number | null;
  unresolvedRate: number;
  predictedAdjudicatedDollars: number;
  validatedDollars: number;
  matchedValidatedDollars: number;
  missedDollars: number;
  dollarPrecision: number | null;
  dollarRecall: number | null;
  gateResults: GateResult[];
  gatesPassed: boolean | null;
}

const INVALID = new Set<ValidationDisposition>([
  'false_positive', 'duplicate', 'already_recovered',
]);

const INPUT_KEYS = new Set([
  'schemaVersion', 'studyId', 'datasetId', 'datasetManifestSha256', 'engineCommit',
  'protocolVersion', 'findings', 'missedFindings', 'groundTruthComplete',
  'eligibleLines', 'matchedAndPricedLines', 'gates',
]);
const FINDING_KEYS = new Set([
  'id', 'payer', 'category', 'predictedAmount', 'validatedAmount', 'disposition',
  'reviewerId', 'reviewedAt', 'secondReviewerId', 'adjudicatorId', 'rationaleRef',
  'exclusionReason',
]);
const MISSED_KEYS = new Set([
  'id', 'payer', 'category', 'validatedAmount', 'reviewerId', 'reviewedAt',
  'secondReviewerId', 'adjudicatorId', 'rationaleRef',
]);
const GATE_KEYS = new Set([
  'minPrecision', 'minRecall', 'minDollarPrecision', 'minDollarRecall',
  'minCoverage', 'maxUnresolvedRate',
]);

export function calculateValidationMetrics(input: ValidationInput): ValidationMetrics {
  validateInput(input);

  const truePositives = input.findings.filter((f) => f.disposition === 'true_positive');
  const invalid = input.findings.filter((f) => INVALID.has(f.disposition));
  const excluded = input.findings.filter((f) => f.disposition === 'excluded');
  const unresolved = input.findings.filter((f) => f.disposition === 'unresolved');
  const adjudicated = [...truePositives, ...invalid];

  const predicted = money(adjudicated.reduce((n, f) => n + f.predictedAmount, 0));
  const validated = money(truePositives.reduce((n, f) => n + f.validatedAmount, 0));
  // Dollar performance must be bounded. A true positive contributes only the
  // overlap between predicted and independently validated opportunity. This
  // penalizes overstatement through the precision denominator and
  // underestimation through the recall denominator instead of allowing a
  // misleading >100% "dollar precision" result.
  const matchedValidated = money(truePositives.reduce(
    (n, f) => n + Math.min(f.predictedAmount, f.validatedAmount), 0,
  ));
  const missedDollars = money(input.missedFindings.reduce((n, f) => n + f.validatedAmount, 0));

  const precision = ratio(truePositives.length, adjudicated.length);
  const recall = input.groundTruthComplete
    ? ratio(truePositives.length, truePositives.length + input.missedFindings.length)
    : null;
  const dollarPrecision = ratio(matchedValidated, predicted);
  const dollarRecall = input.groundTruthComplete
    ? ratio(matchedValidated, validated + missedDollars)
    : null;
  const coverage = ratio(input.matchedAndPricedLines, input.eligibleLines);
  const unresolvedRate = input.findings.length === 0
    ? 0
    : round4(unresolved.length / input.findings.length);

  const result: ValidationMetrics = {
    schemaVersion: 1,
    studyId: input.studyId,
    datasetId: input.datasetId,
    datasetManifestSha256: input.datasetManifestSha256,
    engineCommit: input.engineCommit,
    protocolVersion: input.protocolVersion,
    groundTruthComplete: input.groundTruthComplete,
    findings: input.findings.length,
    adjudicated: adjudicated.length,
    truePositives: truePositives.length,
    invalidFindings: invalid.length,
    excluded: excluded.length,
    unresolved: unresolved.length,
    missed: input.missedFindings.length,
    precision,
    precision95: precision == null ? null : wilson95(truePositives.length, adjudicated.length),
    recall,
    recall95: recall == null
      ? null
      : wilson95(truePositives.length, truePositives.length + input.missedFindings.length),
    coverage,
    unresolvedRate,
    predictedAdjudicatedDollars: predicted,
    validatedDollars: validated,
    matchedValidatedDollars: matchedValidated,
    missedDollars,
    dollarPrecision,
    dollarRecall,
    gateResults: [],
    gatesPassed: null,
  };

  result.gateResults = evaluateGates(input.gates, result);
  result.gatesPassed = input.gates == null
    ? null
    : result.gateResults.every((g) => g.passed);
  return result;
}

function validateInput(input: ValidationInput): void {
  if (typeof input !== 'object' || input == null || Array.isArray(input)) {
    throw new Error('validation input must be an object');
  }
  rejectUnknown(input as unknown as Record<string, unknown>, INPUT_KEYS, 'input');
  if (input.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  text(input.studyId, 'studyId');
  text(input.datasetId, 'datasetId');
  text(input.engineCommit, 'engineCommit');
  text(input.protocolVersion, 'protocolVersion');
  if (typeof input.datasetManifestSha256 !== 'string'
      || !/^[a-f0-9]{64}$/i.test(input.datasetManifestSha256)) {
    throw new Error('datasetManifestSha256 must be a 64-character SHA-256 digest');
  }
  if (typeof input.groundTruthComplete !== 'boolean') {
    throw new Error('groundTruthComplete must be boolean');
  }
  if (!Array.isArray(input.findings)) throw new Error('findings must be an array');
  if (!Array.isArray(input.missedFindings)) throw new Error('missedFindings must be an array');
  whole(input.eligibleLines, 'eligibleLines');
  whole(input.matchedAndPricedLines, 'matchedAndPricedLines');
  if (input.matchedAndPricedLines > input.eligibleLines) {
    throw new Error('matchedAndPricedLines cannot exceed eligibleLines');
  }

  const ids = new Set<string>();
  for (const [index, finding] of input.findings.entries()) {
    if (typeof finding !== 'object' || finding == null || Array.isArray(finding)) {
      throw new Error(`findings[${index}] must be an object`);
    }
    rejectUnknown(finding as unknown as Record<string, unknown>, FINDING_KEYS, `findings[${index}]`);
    rowId(finding.id, ids);
    text(finding.payer, `findings[${index}].payer`);
    text(finding.category, `findings[${index}].category`);
    text(finding.reviewerId, `findings[${index}].reviewerId`);
    date(finding.reviewedAt, `findings[${index}].reviewedAt`);
    optionalText(finding.secondReviewerId, `findings[${index}].secondReviewerId`);
    optionalText(finding.adjudicatorId, `findings[${index}].adjudicatorId`);
    optionalText(finding.rationaleRef, `findings[${index}].rationaleRef`);
    amount(finding.predictedAmount, `findings[${index}].predictedAmount`);
    amount(finding.validatedAmount, `findings[${index}].validatedAmount`);
    if (![
      'true_positive', 'false_positive', 'duplicate', 'already_recovered',
      'excluded', 'unresolved',
    ].includes(finding.disposition)) {
      throw new Error(`findings[${index}].disposition is invalid`);
    }
    if (finding.disposition === 'true_positive' && finding.validatedAmount <= 0) {
      throw new Error(`findings[${index}] true_positive requires validatedAmount > 0`);
    }
    if (finding.disposition !== 'true_positive' && finding.validatedAmount !== 0) {
      throw new Error(`findings[${index}] non-true-positive findings require validatedAmount = 0`);
    }
    if (finding.disposition === 'excluded') {
      text(finding.exclusionReason, `findings[${index}].exclusionReason`);
    } else if (finding.exclusionReason != null) {
      throw new Error(`findings[${index}].exclusionReason is only allowed for excluded findings`);
    }
  }

  for (const [index, missed] of input.missedFindings.entries()) {
    if (typeof missed !== 'object' || missed == null || Array.isArray(missed)) {
      throw new Error(`missedFindings[${index}] must be an object`);
    }
    rejectUnknown(missed as unknown as Record<string, unknown>, MISSED_KEYS, `missedFindings[${index}]`);
    rowId(missed.id, ids);
    text(missed.payer, `missedFindings[${index}].payer`);
    text(missed.category, `missedFindings[${index}].category`);
    text(missed.reviewerId, `missedFindings[${index}].reviewerId`);
    date(missed.reviewedAt, `missedFindings[${index}].reviewedAt`);
    optionalText(missed.secondReviewerId, `missedFindings[${index}].secondReviewerId`);
    optionalText(missed.adjudicatorId, `missedFindings[${index}].adjudicatorId`);
    optionalText(missed.rationaleRef, `missedFindings[${index}].rationaleRef`);
    amount(missed.validatedAmount, `missedFindings[${index}].validatedAmount`);
    if (missed.validatedAmount <= 0) {
      throw new Error(`missedFindings[${index}].validatedAmount must be > 0`);
    }
  }

  if (input.gates != null) validateGates(input.gates);
}

function evaluateGates(
  gates: ValidationGates | undefined,
  metrics: ValidationMetrics,
): GateResult[] {
  if (gates == null) return [];
  const results: GateResult[] = [];
  const minimum = (
    gate: keyof ValidationGates,
    threshold: number | undefined,
    actual: number | null,
  ) => {
    if (threshold == null) return;
    results.push({ gate, threshold, actual, passed: actual != null && actual >= threshold });
  };
  minimum('minPrecision', gates.minPrecision, metrics.precision);
  minimum('minRecall', gates.minRecall, metrics.recall);
  minimum('minDollarPrecision', gates.minDollarPrecision, metrics.dollarPrecision);
  minimum('minDollarRecall', gates.minDollarRecall, metrics.dollarRecall);
  minimum('minCoverage', gates.minCoverage, metrics.coverage);
  if (gates.maxUnresolvedRate != null) {
    results.push({
      gate: 'maxUnresolvedRate',
      threshold: gates.maxUnresolvedRate,
      actual: metrics.unresolvedRate,
      passed: metrics.unresolvedRate <= gates.maxUnresolvedRate,
    });
  }
  return results;
}

function validateGates(gates: ValidationGates): void {
  if (typeof gates !== 'object' || gates == null || Array.isArray(gates)) {
    throw new Error('gates must be an object');
  }
  rejectUnknown(gates as unknown as Record<string, unknown>, GATE_KEYS, 'gates');
  for (const [key, value] of Object.entries(gates)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`gates.${key} must be between 0 and 1`);
    }
  }
}

function wilson95(successes: number, total: number): Interval {
  const z = 1.959963984540054;
  const p = successes / total;
  const d = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / d;
  const margin = (z / d)
    * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total));
  return {
    lower: round4(Math.max(0, center - margin)),
    upper: round4(Math.min(1, center + margin)),
  };
}

function ratio(n: number, d: number): number | null {
  return d === 0 ? null : round4(n / d);
}

function money(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}

function whole(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative integer`);
  }
}

function amount(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite nonnegative number`);
  }
}

function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be non-empty`);
  }
}

function optionalText(value: unknown, field: string): void {
  if (value == null) return;
  text(value, field);
}

function date(value: unknown, field: string): asserts value is string {
  text(value, field);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an ISO-compatible date/time`);
  }
}

function rowId(value: unknown, ids: Set<string>): asserts value is string {
  text(value, 'id');
  if (ids.has(value)) throw new Error(`duplicate validation id: ${value}`);
  ids.add(value);
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: Set<string>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${field}.${key} is not allowed in the validation metric file`);
    }
  }
}
