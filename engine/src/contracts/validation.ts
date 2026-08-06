export type SupportedContractType = 'fee_schedule' | 'percent_of_medicare';

export interface ContractDraftLine {
  procedureCode: string;
  modifier?: string | null;
  allowedAmount?: number | null;
  percentOfMedicare?: number | null;
  effectiveDate?: string | null;
}

export interface ContractDraft {
  payerId: string;
  effectiveDate: string;
  expirationDate?: string | null;
  feeScheduleType: string;
  lines: ContractDraftLine[];
}

export interface ContractValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  line?: number;
}

export interface ContractValidationResult {
  valid: boolean;
  supported: boolean;
  issues: ContractValidationIssue[];
  normalized: ContractDraft;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PROCEDURE = /^[A-Z0-9]{5}$/;
const MODIFIER = /^[A-Z0-9]{2}$/;

export function validateContractDraft(draft: ContractDraft): ContractValidationResult {
  const issues: ContractValidationIssue[] = [];
  const normalized: ContractDraft = {
    payerId: String(draft.payerId ?? '').trim(),
    effectiveDate: String(draft.effectiveDate ?? '').trim(),
    expirationDate: draft.expirationDate ? String(draft.expirationDate).trim() : null,
    feeScheduleType: String(draft.feeScheduleType ?? '').trim().toLowerCase(),
    lines: (draft.lines ?? []).map((line) => ({
      procedureCode: String(line.procedureCode ?? '').trim().toUpperCase(),
      modifier: line.modifier ? String(line.modifier).trim().toUpperCase() : null,
      allowedAmount: nullableNumber(line.allowedAmount),
      percentOfMedicare: nullableNumber(line.percentOfMedicare),
      effectiveDate: line.effectiveDate ? String(line.effectiveDate).trim() : null,
    })),
  };

  if (!normalized.payerId) error(issues, 'payer_required', 'payerId is required');
  if (!validDate(normalized.effectiveDate)) {
    error(issues, 'effective_date_invalid', 'effectiveDate must be a real YYYY-MM-DD date');
  }
  if (normalized.expirationDate && !validDate(normalized.expirationDate)) {
    error(issues, 'expiration_date_invalid', 'expirationDate must be a real YYYY-MM-DD date');
  } else if (normalized.expirationDate && normalized.expirationDate < normalized.effectiveDate) {
    error(issues, 'date_range_invalid', 'expirationDate cannot precede effectiveDate');
  }

  const supported = ['fee_schedule', 'percent_of_medicare'].includes(normalized.feeScheduleType);
  if (!supported) {
    error(issues, 'contract_model_unsupported',
      `contract type ${normalized.feeScheduleType || '(missing)'} is not supported for automated pricing; `
      + 'pilot scope supports fee_schedule and percent_of_medicare only');
  }
  if (normalized.lines.length === 0) {
    error(issues, 'fee_schedule_empty', 'at least one structured contract line is required');
  }

  const seen = new Set<string>();
  normalized.lines.forEach((line, index) => {
    const n = index + 1;
    if (!PROCEDURE.test(line.procedureCode)) {
      error(issues, 'procedure_code_invalid',
        'procedureCode must be a five-character CPT/HCPCS code', n);
    }
    if (line.modifier && !MODIFIER.test(line.modifier)) {
      error(issues, 'modifier_invalid', 'modifier must contain two letters or digits', n);
    }
    if (line.effectiveDate && !validDate(line.effectiveDate)) {
      error(issues, 'line_effective_date_invalid',
        'line effectiveDate must be a real YYYY-MM-DD date', n);
    } else if (line.effectiveDate && validDate(normalized.effectiveDate)
      && line.effectiveDate < normalized.effectiveDate) {
      error(issues, 'line_precedes_contract',
        'line effectiveDate cannot precede the contract effectiveDate', n);
    }
    const key = `${line.procedureCode}|${line.modifier ?? ''}|${line.effectiveDate ?? ''}`;
    if (seen.has(key)) error(issues, 'duplicate_rate', 'duplicate code/modifier/effective-date rate', n);
    seen.add(key);

    if (normalized.feeScheduleType === 'fee_schedule') {
      if (!nonnegative(line.allowedAmount)) {
        error(issues, 'allowed_amount_required',
          'fee_schedule lines require a finite non-negative allowedAmount', n);
      }
      if (line.percentOfMedicare != null) {
        error(issues, 'mixed_pricing_method',
          'fee_schedule lines cannot also define percentOfMedicare', n);
      }
    } else if (normalized.feeScheduleType === 'percent_of_medicare') {
      if (!positive(line.percentOfMedicare)) {
        error(issues, 'medicare_percent_required',
          'percent_of_medicare lines require a finite positive percentOfMedicare', n);
      }
      if (line.allowedAmount != null) {
        error(issues, 'mixed_pricing_method',
          'percent_of_medicare lines cannot also define allowedAmount', n);
      }
    }
  });

  if (normalized.feeScheduleType === 'percent_of_medicare') {
    issues.push({
      severity: 'warning', code: 'medicare_reference_required',
      message: 'activation requires current CMS payment amounts for every code, modifier, locality, and service setting used by the pilot',
    });
  }
  return {
    valid: !issues.some((issue) => issue.severity === 'error'), supported, issues, normalized,
  };
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  return Number(value);
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function nonnegative(value: number | null | undefined): boolean {
  return value != null && Number.isFinite(value) && value >= 0;
}

function positive(value: number | null | undefined): boolean {
  return value != null && Number.isFinite(value) && value > 0;
}

function error(
  issues: ContractValidationIssue[], code: string, message: string, line?: number,
): void {
  issues.push({ severity: 'error', code, message, ...(line == null ? {} : { line }) });
}
