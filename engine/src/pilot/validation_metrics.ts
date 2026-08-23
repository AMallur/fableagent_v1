export type ValidationLabel = 'valid' | 'invalid' | 'excluded' | 'unresolved';

export interface ReviewedFinding {
  id: string;
  payer: string;
  category: string;
  predictedAmount: number;
  validatedAmount: number;
  label: ValidationLabel;
}

export interface MissedFinding {
  id: string;
  payer: string;
  category: string;
  validatedAmount: number;
}

export interface ValidationInput {
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
  findings: number;
  adjudicated: number;
  valid: number;
  invalid: number;
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

export function calculateValidationMetrics(input: ValidationInput): ValidationMetrics {
  validateInput(input);
  const valid = input.findings.filter((f) => f.label === 'valid');
  const invalid = input.findings.filter((f) => f.label === 'invalid');
  const excluded = input.findings.filter((f) => f.label === 'excluded');
  const unresolved = input.findings.filter((f) => f.label === 'unresolved');
  const adjudicated = [...valid, ...invalid];
  const predicted = money(adjudicated.reduce((n, f) => n + f.predictedAmount, 0));
  const validated = money(valid.reduce((n, f) => n + f.validatedAmount, 0));
  const missedDollars = money(input.missedFindings.reduce((n, f) => n + f.validatedAmount, 0));

  const precision = ratio(valid.length, adjudicated.length);
  const recall = input.groundTruthComplete
    ? ratio(valid.length, valid.length + input.missedFindings.length)
    : null;

  return {
    findings: input.findings.length,
    adjudicated: adjudicated.length,
    valid: valid.length,
    invalid: invalid.length,
    excluded: excluded.length,
    unresolved: unresolved.length,
    missed: input.missedFindings.length,
    precision,
    precision95: precision == null ? null : wilson95(valid.length, adjudicated.length),
    recall,
    recall95: recall == null ? null : wilson95(valid.length, valid.length + input.missedFindings.length),
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
  whole(input.eligibleLines, 'eligibleLines');
  whole(input.matchedAndPricedLines, 'matchedAndPricedLines');
  if (input.matchedAndPricedLines > input.eligibleLines) {
    throw new Error('matchedAndPricedLines cannot exceed eligibleLines');
  }
  const ids = new Set<string>();
  for (const finding of input.findings) {
    rowId(finding.id, ids);
    text(finding.payer, 'payer');
    text(finding.category, 'category');
    amount(finding.predictedAmount, 'predictedAmount');
    amount(finding.validatedAmount, 'validatedAmount');
    if (!['valid', 'invalid', 'excluded', 'unresolved'].includes(finding.label)) {
      throw new Error(`invalid validation label: ${finding.label}`);
    }
    if (finding.label === 'valid' && finding.validatedAmount <= 0) {
      throw new Error('valid findings require validatedAmount > 0');
    }
    if (finding.label === 'invalid' && finding.validatedAmount !== 0) {
      throw new Error('invalid findings require validatedAmount = 0');
    }
  }
  for (const missed of input.missedFindings) {
    rowId(missed.id, ids);
    text(missed.payer, 'payer');
    text(missed.category, 'category');
    amount(missed.validatedAmount, 'validatedAmount');
    if (missed.validatedAmount <= 0) throw new Error('missed findings require validatedAmount > 0');
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

function whole(n: number, field: string): void {
  if (!Number.isInteger(n) || n < 0) throw new Error(`${field} must be a nonnegative integer`);
}

function amount(n: number, field: string): void {
  if (!Number.isFinite(n) || n < 0) throw new Error(`${field} must be a finite nonnegative number`);
}

function text(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must be non-empty`);
}

function rowId(id: string, ids: Set<string>): void {
  text(id, 'id');
  if (ids.has(id)) throw new Error(`duplicate validation id: ${id}`);
  ids.add(id);
}
