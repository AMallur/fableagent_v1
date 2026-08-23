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
}

export interface Interval {
  lower: number;
  upper: number;
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
  missedDollars: number;
  dollarPrecision: number | null;
  dollarRecall: number | null;
}

const INVALID = new Set<ValidationDisposition>([
  'false_positive', 'duplicate', 'already_recovered',
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
  const missedDollars = money(input.missedFindings.reduce((n, f) => n + f.validatedAmount, 0));

  const precision = ratio(truePositives.length, adjudicated.length);
  const recall = input.groundTruthComplete
    ? ratio(truePositives.length, truePositives.length + input.missedFindings.length)
    : null;

  return {
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
    recall95: recall == null ? null : wilson95(truePositives.length, truePositives.length + input.missedFindings.length),
    coverage: ratio(input.matchedAndPricedLines, input.eligibleLines),
    unresolvedRate: input.findings.length === 0 ? 0 : round4(unresolved.length / input.findings.length),
    predictedAdjudicatedDollars: predicted,
    validatedDollars: validated,
    missedDollars,
    dollarPrecision: ratio(validated, predicted),
    dollarRecall: input.groundTruthComplete ? ratio(validated, validated + missedDollars) : null,
  };
}

function validateInput(input: ValidationInput): void {
  if (typeof input !== 'object' || input == null || Array.isArray(input)) {
    throw new Error('validation input must be an object');
  }
  if (input.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  text(input.studyId, 'studyId');
  text(input.datasetId, 'datasetId');
  text(input.engineCommit, 'engineCommit');
  text(input.protocolVersion, 'protocolVersion');
  if (typeof input.datasetManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.datasetManifestSha256)) {
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
    rowId(finding.id, ids);
    text(finding.payer, `findings[${index}].payer`);
    text(finding.category, `findings[${index}].category`);
    text(finding.reviewerId, `findings[${index}].reviewerId`);
    date(finding.reviewedAt, `findings[${index}].reviewedAt`);
    amount(finding.predictedAmount, `findings[${index}].predictedAmount`);
    amount(finding.validatedAmount, `findings[${index}].validatedAmount`);
    if (!['true_positive', 'false_positive', 'duplicate', 'already_recovered', 'excluded', 'unresolved'].includes(finding.disposition)) {
      throw new Error(`findings[${index}].disposition is invalid`);
    }
    if (finding.disposition === 'true_positive' && finding.validatedAmount <= 0) {
      throw new Error(`findings[${index}] true_positive requires validatedAmount > 0`);
    }
    if (finding.disposition !== 'true_positive' && finding.validatedAmount !== 0) {
      throw new Error(`findings[${index}] non-true-positive findings require validatedAmount = 0`);
    }
    if (finding.disposition === 'excluded' && !finding.exclusionReason?.trim()) {
      throw new Error(`findings[${index}] excluded finding requires exclusionReason`);
    }
  }

  for (const [index, missed] of input.missedFindings.entries()) {
    if (typeof missed !== 'object' || missed == null || Array.isArray(missed)) {
      throw new Error(`missedFindings[${index}] must be an object`);
    }
    rowId(missed.id, ids);
    text(missed.payer, `missedFindings[${index}].payer`);
    text(missed.category, `missedFindings[${index}].category`);
    text(missed.reviewerId, `missedFindings[${index}].reviewerId`);
    date(missed.reviewedAt, `missedFindings[${index}].reviewedAt`);
    amount(missed.validatedAmount, `missedFindings[${index}].validatedAmount`);
    if (missed.validatedAmount <= 0) throw new Error(`missedFindings[${index}].validatedAmount must be > 0`);
  }
}

function wilson95(successes: number, total: number): Interval {
  const z = 1.959963984540054;
  const p = successes / total;
  const d = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / d;
  const margin = (z / d) * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total));
  return { lower: round4(Math.max(0, center - margin)), upper: round4(Math.min(1, center + margin)) };
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
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be non-empty`);
}

function date(value: unknown, field: string): asserts value is string {
  text(value, field);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO-compatible date/time`);
}

function rowId(value: unknown, ids: Set<string>): asserts value is string {
  text(value, 'id');
  if (ids.has(value)) throw new Error(`duplicate validation id: ${value}`);
  ids.add(value);
}
