// Structural validation at the ingestion boundary. The low-level parsers stay
// tolerant so they can parse individual transaction fragments in tests and
// troubleshooting tools; files accepted into the database must be complete,
// supported X12 envelopes.

import { el, parseX12, type Segment } from './x12.ts';

export type SupportedX12Kind = '835' | '837P';

export interface X12ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  transaction?: number;
}

export interface X12ValidationResult {
  kind: SupportedX12Kind;
  implementationVersion: string | null;
  transactions: number;
  errors: X12ValidationIssue[];
  warnings: X12ValidationIssue[];
}

const SUPPORTED = {
  '835': '005010X221A1',
  '837P': '005010X222A1',
} as const;

function issue(
  severity: X12ValidationIssue['severity'], code: string, message: string,
  transaction?: number,
): X12ValidationIssue {
  return { severity, code, message, ...(transaction == null ? {} : { transaction }) };
}

function transactionSets(segments: Segment[]): Segment[][] {
  const sets: Segment[][] = [];
  let current: Segment[] | null = null;
  for (const segment of segments) {
    if (segment.id === 'ST') {
      if (current) sets.push(current);
      current = [segment];
    } else if (current) {
      current.push(segment);
      if (segment.id === 'SE') {
        sets.push(current);
        current = null;
      }
    }
  }
  if (current) sets.push(current);
  return sets;
}

function requireSegment(
  set: Segment[], id: string, label: string, tx: number, errors: X12ValidationIssue[],
): void {
  if (!set.some((s) => s.id === id)) {
    errors.push(issue('error', `missing_${id.toLowerCase()}`, `${label} segment ${id} is required`, tx));
  }
}

function validateEnvelope(segments: Segment[], errors: X12ValidationIssue[]): void {
  for (const [open, close, code] of [
    ['ISA', 'IEA', 'interchange'], ['GS', 'GE', 'functional_group'],
  ] as const) {
    if (!segments.some((s) => s.id === open) || !segments.some((s) => s.id === close)) {
      errors.push(issue('error', `incomplete_${code}`,
        `complete ${open}/${close} ${code.replace('_', ' ')} envelope is required`));
    }
  }
}

/** Validate a complete 835 or 837P file before it can enter the database. */
export function validateX12File(raw: string, kind: SupportedX12Kind): X12ValidationResult {
  const { segments } = parseX12(raw);
  const errors: X12ValidationIssue[] = [];
  const warnings: X12ValidationIssue[] = [];
  validateEnvelope(segments, errors);

  const sets = transactionSets(segments);
  if (!sets.length) errors.push(issue('error', 'missing_transaction_set', 'no ST/SE transaction set found'));

  const gs = segments.find((s) => s.id === 'GS');
  const expectedType = kind === '835' ? '835' : '837';
  const expectedVersion = SUPPORTED[kind];
  let implementationVersion: string | null = null;

  sets.forEach((set, index) => {
    const tx = index + 1;
    const st = set[0];
    const se = set.find((s) => s.id === 'SE');
    const actualType = el(st, 1);
    if (actualType !== expectedType) {
      errors.push(issue('error', 'unsupported_transaction_type',
        `expected ST01 ${expectedType}, received ${actualType || '(blank)'}`, tx));
    }

    const version = el(st, 3) || el(gs, 8) || null;
    implementationVersion ??= version;
    if (version !== expectedVersion) {
      errors.push(issue('error', 'unsupported_implementation_version',
        `${kind} requires implementation ${expectedVersion}; received ${version || '(missing)'}`, tx));
    }

    if (!se) {
      errors.push(issue('error', 'missing_se', 'transaction set is missing its SE trailer', tx));
    } else if (el(st, 2) && el(se, 2) && el(st, 2) !== el(se, 2)) {
      errors.push(issue('error', 'transaction_control_mismatch',
        `ST02 ${el(st, 2)} does not match SE02 ${el(se, 2)}`, tx));
    }

    if (kind === '835') {
      requireSegment(set, 'BPR', 'financial information', tx, errors);
      requireSegment(set, 'TRN', 'payment trace', tx, errors);
      requireSegment(set, 'CLP', 'claim payment', tx, errors);
      const payer = set.some((s) => s.id === 'N1' && el(s, 1) === 'PR');
      if (!payer) errors.push(issue('error', 'missing_payer', '835 requires payer N1*PR identification', tx));
      if (!set.some((s) => s.id === 'SVC')) {
        warnings.push(issue('warning', 'no_service_lines',
          '835 contains no SVC service lines; line-level underpayment detection will be limited', tx));
      }
    } else {
      requireSegment(set, 'BHT', 'transaction purpose', tx, errors);
      requireSegment(set, 'CLM', 'claim', tx, errors);
      requireSegment(set, 'SV1', 'professional service line', tx, errors);
      if (!set.some((s) => s.id === 'NM1' && el(s, 1) === 'IL')) {
        errors.push(issue('error', 'missing_subscriber', '837P requires subscriber NM1*IL identification', tx));
      }
      if (!set.some((s) => s.id === 'NM1' && el(s, 1) === 'PR')) {
        errors.push(issue('error', 'missing_payer', '837P requires payer NM1*PR identification', tx));
      }
    }
  });

  return { kind, implementationVersion, transactions: sets.length, errors, warnings };
}

export function assertValidX12File(raw: string, kind: SupportedX12Kind): X12ValidationResult {
  const result = validateX12File(raw, kind);
  if (result.errors.length) {
    const error = new Error(`X12 ${kind} rejected: ${result.errors.map((i) => i.message).join('; ')}`);
    Object.assign(error, { status: 400, validation: result });
    throw error;
  }
  return result;
}
