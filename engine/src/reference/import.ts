import { createHash } from 'node:crypto';
import type { PoolLike } from '../service.ts';
import type { Queryable } from '../db/snapshot.ts';
import {
  parseCanonicalReferenceCsv, type MedicarePfsRow, type NcciPtpRow,
  type ReferenceKind, type RemittanceCodeRow,
} from './canonical.ts';

export interface ReferenceImportParams {
  kind: ReferenceKind;
  version: string;
  scope?: string;
  sourceUrl: string;
  effectiveDate?: string | null;
  content: string;
  serviceSetting?: 'practitioner' | 'outpatient_hospital';
}

export interface ReferenceImportResult {
  datasetId: string;
  rowCount: number;
  sha256: string;
  skipped: boolean;
}

export async function importReferenceDataset(
  pool: PoolLike, params: ReferenceImportParams,
): Promise<ReferenceImportResult> {
  if (!params.version.trim()) throw Object.assign(new Error('reference version is required'), { status: 400 });
  if (!/^https:\/\//.test(params.sourceUrl)) {
    throw Object.assign(new Error('sourceUrl must be an authoritative HTTPS URL'), { status: 400 });
  }
  if (params.kind === 'ncci_ptp' && !params.serviceSetting) {
    throw Object.assign(new Error('NCCI import requires practitioner or outpatient_hospital serviceSetting'), { status: 400 });
  }
  const parsed = parseByKind(params.kind, params.content);
  if (parsed.errors.length) {
    throw Object.assign(new Error(`reference import rejected: ${parsed.errors.join('; ')}`),
      { status: 400, validationErrors: parsed.errors });
  }
  const sha256 = createHash('sha256').update(params.content).digest('hex');
  const scope = params.scope?.trim() || params.serviceSetting || 'global';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prior = await client.query(
      `SELECT dataset_id, source_sha256, row_count FROM reference_dataset
       WHERE dataset_kind = $1 AND version = $2 AND scope = $3 FOR UPDATE`,
      [params.kind, params.version.trim(), scope],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].source_sha256 !== sha256) {
        throw new Error(`reference ${params.kind} version ${params.version} scope ${scope} already exists with a different SHA-256`);
      }
      await client.query('COMMIT');
      return { datasetId: prior.rows[0].dataset_id, rowCount: Number(prior.rows[0].row_count), sha256, skipped: true };
    }
    const dataset = await client.query(
      `INSERT INTO reference_dataset
         (dataset_kind, version, scope, source_url, effective_date, source_sha256, row_count, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING dataset_id`,
      [params.kind, params.version.trim(), scope, params.sourceUrl, params.effectiveDate ?? null,
       sha256, parsed.rows.length, JSON.stringify({ canonicalSchema: 1,
         ...(params.serviceSetting ? { serviceSetting: params.serviceSetting } : {}) })],
    );
    const datasetId = dataset.rows[0].dataset_id;
    await insertRows(client, datasetId, params, parsed.rows);
    await client.query('COMMIT');
    return { datasetId, rowCount: parsed.rows.length, sha256, skipped: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function parseByKind(kind: ReferenceKind, content: string) {
  if (kind === 'medicare_pfs') return parseCanonicalReferenceCsv('medicare_pfs', content);
  if (kind === 'ncci_ptp') return parseCanonicalReferenceCsv('ncci_ptp', content);
  return parseCanonicalReferenceCsv(kind, content);
}

async function insertRows(
  db: Queryable, datasetId: string, params: ReferenceImportParams,
  rows: Array<MedicarePfsRow | RemittanceCodeRow | NcciPtpRow>,
): Promise<void> {
  if (params.kind === 'medicare_pfs') {
    for (const row of rows as MedicarePfsRow[]) {
      for (const [setting, rate] of [
        ['nonfacility', row.nonfacilityRate], ['facility', row.facilityRate],
      ] as const) {
        await db.query(
          `INSERT INTO medicare_fee_schedule
             (procedure_code, modifier, rate, effective_year, locality, service_setting, dataset_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [row.procedureCode, row.modifier, rate, row.effectiveYear, row.locality, setting, datasetId],
        );
      }
    }
    return;
  }
  if (params.kind === 'carc' || params.kind === 'rarc') {
    for (const row of rows as RemittanceCodeRow[]) {
      await db.query(
        `INSERT INTO remittance_code_reference
           (dataset_id, code_kind, code, description, start_date, last_modified, stop_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [datasetId, params.kind, row.code, row.description, row.startDate,
         row.lastModified, row.stopDate, row.status],
      );
    }
    return;
  }
  for (const row of rows as NcciPtpRow[]) {
    await db.query(
      `INSERT INTO ncci_ptp_edit
         (dataset_id, service_setting, column_one_code, column_two_code,
          effective_date, deletion_date, modifier_indicator)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [datasetId, params.serviceSetting, row.columnOneCode, row.columnTwoCode,
       row.effectiveDate, row.deletionDate, row.modifierIndicator],
    );
  }
}
