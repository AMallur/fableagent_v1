import { splitCsvLine } from '../ingest/csv.ts';

export type ReferenceKind = 'medicare_pfs' | 'carc' | 'rarc' | 'ncci_ptp';

export interface MedicarePfsRow {
  procedureCode: string;
  modifier: string | null;
  locality: string;
  effectiveYear: number;
  nonfacilityRate: number;
  facilityRate: number;
}

export interface RemittanceCodeRow {
  code: string;
  description: string;
  startDate: string | null;
  lastModified: string | null;
  stopDate: string | null;
  status: 'active' | 'inactive';
}

export interface NcciPtpRow {
  columnOneCode: string;
  columnTwoCode: string;
  effectiveDate: string;
  deletionDate: string | null;
  modifierIndicator: 0 | 1 | 9;
}

export interface CanonicalParseResult<T> {
  rows: T[];
  errors: string[];
}

const SCHEMAS: Record<ReferenceKind, string[]> = {
  medicare_pfs: ['procedure_code', 'modifier', 'locality', 'effective_year', 'nonfacility_rate', 'facility_rate'],
  carc: ['code', 'description', 'start_date', 'last_modified', 'stop_date', 'status'],
  rarc: ['code', 'description', 'start_date', 'last_modified', 'stop_date', 'status'],
  ncci_ptp: ['column_one_code', 'column_two_code', 'effective_date', 'deletion_date', 'modifier_indicator'],
};

const CODE = /^[A-Z0-9]{5}$/;
const MODIFIER = /^[A-Z0-9]{2}$/;

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dateOrNull(value: string, label: string, line: number, errors: string[]): string | null {
  const v = value.trim();
  if (!v) return null;
  if (!validDate(v)) errors.push(`line ${line}: ${label} must be YYYY-MM-DD`);
  return v;
}

function money(value: string, label: string, line: number, errors: string[]): number {
  const n = Number(value.replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) errors.push(`line ${line}: ${label} must be non-negative money`);
  return Math.round(n * 100) / 100;
}

/**
 * Parse the documented canonical import format, not a vendor's raw download.
 * Raw CMS/X12 layouts change over time and must be transformed explicitly so
 * field mapping is reviewable instead of inferred.
 */
export function parseCanonicalReferenceCsv(
  kind: 'medicare_pfs', text: string,
): CanonicalParseResult<MedicarePfsRow>;
export function parseCanonicalReferenceCsv(
  kind: 'carc' | 'rarc', text: string,
): CanonicalParseResult<RemittanceCodeRow>;
export function parseCanonicalReferenceCsv(
  kind: 'ncci_ptp', text: string,
): CanonicalParseResult<NcciPtpRow>;
export function parseCanonicalReferenceCsv(
  kind: ReferenceKind, text: string,
): CanonicalParseResult<MedicarePfsRow | RemittanceCodeRow | NcciPtpRow> {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { rows: [], errors: ['CSV requires a header and at least one row'] };
  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const expected = SCHEMAS[kind];
  const missing = expected.filter((name) => !headers.includes(name));
  const extra = headers.filter((name) => !expected.includes(name));
  if (missing.length || extra.length) {
    return { rows: [], errors: [
      `canonical ${kind} header mismatch`,
      ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
      ...(extra.length ? [`unexpected: ${extra.join(', ')}`] : []),
    ] };
  }

  const rows: Array<MedicarePfsRow | RemittanceCodeRow | NcciPtpRow> = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const line = i + 1;
    const cells = splitCsvLine(lines[i]);
    const get = (name: string) => (cells[headers.indexOf(name)] ?? '').trim();
    if (cells.length !== headers.length) {
      errors.push(`line ${line}: expected ${headers.length} columns, received ${cells.length}`);
      continue;
    }

    if (kind === 'medicare_pfs') {
      const procedureCode = get('procedure_code').toUpperCase();
      const modifier = get('modifier').toUpperCase() || null;
      const locality = get('locality');
      const effectiveYear = Number(get('effective_year'));
      if (!CODE.test(procedureCode)) errors.push(`line ${line}: invalid procedure_code`);
      if (modifier && !MODIFIER.test(modifier)) errors.push(`line ${line}: invalid modifier`);
      if (!locality) errors.push(`line ${line}: locality is required`);
      if (!Number.isInteger(effectiveYear) || effectiveYear < 2000 || effectiveYear > 2200) {
        errors.push(`line ${line}: invalid effective_year`);
      }
      const row: MedicarePfsRow = {
        procedureCode, modifier, locality, effectiveYear,
        nonfacilityRate: money(get('nonfacility_rate'), 'nonfacility_rate', line, errors),
        facilityRate: money(get('facility_rate'), 'facility_rate', line, errors),
      };
      const key = `${procedureCode}|${modifier ?? ''}|${locality}|${effectiveYear}`;
      if (seen.has(key)) errors.push(`line ${line}: duplicate procedure/modifier/locality/year`);
      seen.add(key);
      rows.push(row);
    } else if (kind === 'carc' || kind === 'rarc') {
      const code = get('code').toUpperCase();
      const description = get('description');
      const status = get('status').toLowerCase();
      if (!code || !/^[A-Z0-9]+$/.test(code)) errors.push(`line ${line}: invalid code`);
      if (!description) errors.push(`line ${line}: description is required`);
      if (status !== 'active' && status !== 'inactive') errors.push(`line ${line}: status must be active or inactive`);
      if (seen.has(code)) errors.push(`line ${line}: duplicate code ${code}`);
      seen.add(code);
      rows.push({
        code, description,
        startDate: dateOrNull(get('start_date'), 'start_date', line, errors),
        lastModified: dateOrNull(get('last_modified'), 'last_modified', line, errors),
        stopDate: dateOrNull(get('stop_date'), 'stop_date', line, errors),
        status: status as 'active' | 'inactive',
      });
    } else {
      const columnOneCode = get('column_one_code').toUpperCase();
      const columnTwoCode = get('column_two_code').toUpperCase();
      const effectiveDate = get('effective_date');
      const deletionDate = dateOrNull(get('deletion_date'), 'deletion_date', line, errors);
      const modifierIndicator = Number(get('modifier_indicator'));
      if (!CODE.test(columnOneCode)) errors.push(`line ${line}: invalid column_one_code`);
      if (!CODE.test(columnTwoCode)) errors.push(`line ${line}: invalid column_two_code`);
      if (!validDate(effectiveDate)) errors.push(`line ${line}: effective_date must be YYYY-MM-DD`);
      if (![0, 1, 9].includes(modifierIndicator)) errors.push(`line ${line}: modifier_indicator must be 0, 1, or 9`);
      if (deletionDate && validDate(effectiveDate) && deletionDate < effectiveDate) {
        errors.push(`line ${line}: deletion_date precedes effective_date`);
      }
      const key = `${columnOneCode}|${columnTwoCode}|${effectiveDate}`;
      if (seen.has(key)) errors.push(`line ${line}: duplicate edit ${key}`);
      seen.add(key);
      rows.push({ columnOneCode, columnTwoCode, effectiveDate, deletionDate,
        modifierIndicator: modifierIndicator as 0 | 1 | 9 });
    }
  }
  return { rows, errors };
}
