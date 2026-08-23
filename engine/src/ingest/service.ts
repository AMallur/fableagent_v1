// ============================================================================
// Ingest jobs: 835 (remittance) and 837P (claims) file loaders.
//
//   ingest835Job(pool, { tenantId, clientId, content, fileName })
//   ingest837Job(pool, { tenantId, clientId, content, fileName })
//
// Both wrap the pure parsers with the system_job lifecycle and write in one
// transaction. Idempotent: an 835 with an already-loaded trace number is
// skipped; 837 claims whose control number already exists are skipped.
// The 835 loader only creates remittance rows with matching hints —
// linking to claims is the detection engine's job (run_detection).
// ============================================================================

import type { UUID } from '../types.ts';
import type { PoolLike } from '../service.ts';
import type { Queryable } from '../db/snapshot.ts';
import { parse835File, reducesProviderCash, type Remittance835 } from './parse835.ts';
import { balance835, balance835File, type BalanceResult } from './balance835.ts';
import { parse837, type ClaimFile837 } from './parse837.ts';
import { parseRemittanceCsv, type CsvRemitRow } from './csv.ts';
import { assertValidX12File, validateX12File } from './validation.ts';

export interface IngestParams {
  tenantId: UUID;
  clientId: UUID;
  content: string;
  fileName: string;
}

export interface IngestResult {
  jobId: UUID;
  recordsProcessed: number;
  skipped: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// shared plumbing
// ---------------------------------------------------------------------------

async function withJob(
  pool: PoolLike, params: IngestParams, jobType: 'ingest_835' | 'ingest_837',
  work: (client: Queryable, warnings: string[]) => Promise<{ processed: number; skipped: number }>,
): Promise<IngestResult> {
  const job = await pool.query(
    `INSERT INTO system_job (tenant_id, client_id, job_type, status, started_at)
     VALUES ($1, $2, $3, 'running', now()) RETURNING job_id`,
    [params.tenantId, params.clientId, jobType],
  );
  const jobId: UUID = job.rows[0].job_id;
  const warnings: string[] = [];

  try {
    const client = await pool.connect();
    let outcome: { processed: number; skipped: number };
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_tenant_id', $1, true)`, [params.tenantId],
      );
      outcome = await work(client, warnings);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await pool.query(
      `UPDATE system_job
       SET status = 'completed', completed_at = now(),
           records_processed = $1, errors_count = $2, log_output = $3
       WHERE job_id = $4`,
      [outcome.processed, warnings.length,
       JSON.stringify({ file: params.fileName, ...outcome, warnings }), jobId],
    );
    return { jobId, recordsProcessed: outcome.processed, skipped: outcome.skipped, warnings };
  } catch (err) {
    await pool.query(
      `UPDATE system_job
       SET status = 'failed', completed_at = now(), errors_count = 1, log_output = $1
       WHERE job_id = $2`,
      [String(err instanceof Error ? err.stack ?? err.message : err), jobId],
    ).catch(() => { /* keep the original error */ });
    throw err;
  }
}

/** Find a payer by electronic ID code or name; create a tenant-scoped stub if unknown. */
async function resolvePayer(
  db: Queryable, tenantId: UUID,
  idCode: string | null, name: string | null, warnings: string[],
): Promise<UUID> {
  if (idCode) {
    const byCode = await db.query(
      `SELECT payer_id FROM payer
       WHERE payer_id_code = $1 AND (tenant_id IS NULL OR tenant_id = $2)
         AND deleted_at IS NULL
       ORDER BY tenant_id NULLS LAST LIMIT 1`,
      [idCode, tenantId],
    );
    if (byCode.rows[0]) return byCode.rows[0].payer_id;
  }
  if (name) {
    const byName = await db.query(
      `SELECT payer_id FROM payer
       WHERE lower(payer_name) = lower($1) AND (tenant_id IS NULL OR tenant_id = $2)
         AND deleted_at IS NULL
       ORDER BY tenant_id NULLS LAST LIMIT 1`,
      [name, tenantId],
    );
    if (byName.rows[0]) return byName.rows[0].payer_id;
  }
  const created = await db.query(
    `INSERT INTO payer (tenant_id, payer_name, payer_type, payer_id_code)
     VALUES ($1, $2, 'commercial', $3) RETURNING payer_id`,
    [tenantId, name || idCode || 'Unknown Payer', idCode],
  );
  warnings.push(
    `payer "${name ?? idCode ?? '?'}" not found — created tenant-scoped stub (verify payer_type, appeal address, deadlines)`,
  );
  return created.rows[0].payer_id;
}

// ---------------------------------------------------------------------------
// 835 — remittance ingest. A file may carry several ST/SE transaction sets
// (one per check); each becomes its own remittance row. ingestParsed835 is
// the shared loader — the file path parses first, the JSON API path builds
// Remittance835 objects directly.
// ---------------------------------------------------------------------------

/**
 * How this client wants an out-of-balance 835 handled. Defaults are strict
 * with zero tolerance; a trading partner with a documented rounding quirk is
 * relaxed per client rather than by weakening the check for everyone.
 */
export interface BalancePolicy {
  policy: 'strict' | 'warn';
  tolerance: number;
}

export async function loadBalancePolicy(
  db: Queryable, tenantId: UUID, clientId: UUID,
): Promise<BalancePolicy> {
  const row = await db.query(
    `SELECT era_balance_policy, era_balance_tolerance FROM client
     WHERE tenant_id = $1 AND client_id = $2`,
    [tenantId, clientId],
  );
  return {
    policy: row.rows[0]?.era_balance_policy === 'warn' ? 'warn' : 'strict',
    tolerance: Number(row.rows[0]?.era_balance_tolerance ?? 0),
  };
}

function balanceRejection(era: Remittance835, balance: BalanceResult): Error {
  const detail = balance.findings
    .filter((f) => f.severity === 'error')
    .slice(0, 10)
    .map((f) => f.message)
    .join('; ');
  const error = new Error(
    `835 rejected: check ${era.traceNumber ?? '(no trace number)'} does not balance. ${detail}`,
  );
  return Object.assign(error, { status: 400, balance });
}

async function load835Transaction(
  db: Queryable, params: IngestParams, era: Remittance835, warnings: string[],
  balance: BalanceResult,
): Promise<{ processed: number; skipped: number }> {
  // idempotency: same trace number for this client -> already loaded
  if (era.traceNumber) {
    const dupe = await db.query(
      `SELECT remittance_id FROM remittance
       WHERE tenant_id = $1 AND client_id = $2
         AND (eft_trace_number = $3 OR check_number = $3)`,
      [params.tenantId, params.clientId, era.traceNumber],
    );
    if (dupe.rows[0]) {
      warnings.push(`remittance with trace ${era.traceNumber} already loaded — skipped`);
      return { processed: 0, skipped: era.claims.reduce((n, c) => n + c.lines.length, 0) || 1 };
    }
  }

  const payerId = await resolvePayer(db, params.tenantId, era.payerIdCode, era.payerName, warnings);

  const remittance = await db.query(
    `INSERT INTO remittance
       (tenant_id, client_id, payer_id, check_date, check_number,
        eft_trace_number, total_paid, raw_835_reference, processed_at,
        balance_status, balance_variance, provider_adjustment_total,
        claim_payment_total, balance_detail)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, now(), $8, $9, $10, $11, $12)
     RETURNING remittance_id`,
    [params.tenantId, params.clientId, payerId, era.checkDate,
     era.traceNumber, era.totalPaid, params.fileName,
     balance.balanced ? 'balanced' : 'out_of_balance',
     balance.transactionVariance,
     balance.providerAdjustmentTotal,
     balance.claimPaymentTotal,
     // Only the failures, capped: enough for an operator to take the check
     // back to the trading partner without storing the whole file again.
     JSON.stringify(balance.findings.filter((f) => f.severity === 'error').slice(0, 25))],
  );
  const remittanceId = remittance.rows[0].remittance_id;

  await load835ProviderAdjustments(db, params, remittanceId, era, warnings);

  let processed = 0;
  for (const claim of era.claims) {
    // service lines when present; otherwise one header-level line
    const lines = claim.lines.length > 0 ? claim.lines : [null];
    for (const line of lines) {
      const adjustments = line?.adjustments.length ? line.adjustments : claim.adjustments;
      const adj = adjustments[0] ?? null;
      // CLP05 is claim-level. On service lines use the line's PR CAS total so
      // a multi-line claim does not subtract the full patient amount per line.
      const prAdjustments = adjustments.filter((a) => a.groupCode === 'PR');
      const patientResponsibility = !line
        ? claim.patientResponsibility
        : prAdjustments.length
          ? prAdjustments.reduce((sum, a) => sum + a.amount, 0)
          : lines.length === 1 || claim.patientResponsibility === 0
            ? claim.patientResponsibility
            : null;
      if (line && patientResponsibility == null && claim.patientResponsibility != null) {
        warnings.push(
          `claim ${claim.patientControlNumber}: claim-level patient responsibility could not be `
          + 'allocated across service lines; underpayment detection will fail closed for this line',
        );
      }
      await db.query(
        `INSERT INTO remittance_line
           (tenant_id, remittance_id, procedure_code, billed_amount,
            allowed_amount, paid_amount, patient_responsibility,
            adjustment_group_code, adjustment_reason_code, adjustments,
            remark_code, quantity,
            payer_claim_number, patient_member_id, date_of_service,
            claim_status_code, is_reversal, adjudicated_procedure_code,
            paid_units, original_units, payer_recoded)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 $16,$17,$18,$19,$20,$21)`,
        [params.tenantId, remittanceId,
         line?.procedureCode ?? null,
         line?.billedAmount ?? claim.billedAmount,
         line?.allowedAmount ?? null,
         line?.paidAmount ?? claim.paidAmount,
         patientResponsibility,
         adj?.groupCode ?? null, adj?.reasonCode ?? null,
         JSON.stringify(adjustments),
         line?.remarkCodes[0] ?? null,
         line?.units ?? null,
         claim.payerClaimNumber || claim.patientControlNumber || null,
         claim.patient.memberId || null,
         line?.dateOfService ?? claim.claimDate,
         claim.statusCode || null,
         claim.isReversal,
         line?.adjudicatedProcedureCode ?? null,
         line?.paidUnits ?? null,
         line?.originalUnits ?? null,
         line?.payerRecoded ?? false],
      );
      processed += 1;
    }
  }
  return { processed, skipped: 0 };
}

/**
 * PLB rows. reference_id is normally the payer ICN of the claim the money was
 * taken from, so it is matched back to our claim where we can — that link is
 * what turns "the payer kept $1,240" into "the payer recouped claim X".
 */
async function load835ProviderAdjustments(
  db: Queryable, params: IngestParams, remittanceId: UUID,
  era: Remittance835, warnings: string[],
): Promise<void> {
  for (const plb of era.providerAdjustments) {
    let claimId: UUID | null = null;
    if (plb.referenceId) {
      const hit = await db.query(
        `SELECT claim_id FROM claim
         WHERE tenant_id = $1 AND client_id = $2 AND deleted_at IS NULL
           AND (claim_number_payer = $3 OR claim_number_internal = $3)
         ORDER BY created_at DESC LIMIT 1`,
        [params.tenantId, params.clientId, plb.referenceId],
      );
      claimId = hit.rows[0]?.claim_id ?? null;
    }
    await db.query(
      `INSERT INTO remittance_provider_adjustment
         (tenant_id, remittance_id, provider_npi, fiscal_period_end, sequence_number,
          reason_code, reference_id, amount, category, claim_id, matched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               CASE WHEN $10::uuid IS NULL THEN NULL ELSE now() END)`,
      [params.tenantId, remittanceId, plb.providerNpi, plb.fiscalPeriodEnd,
       plb.sequenceNumber, plb.reasonCode, plb.referenceId, plb.amount,
       plb.category, claimId],
    );

    if (reducesProviderCash(plb.category) && plb.amount > 0) {
      warnings.push(
        `provider-level ${plb.category.replace('_', ' ')} of `
        + `$${plb.amount.toFixed(2)} (PLB ${plb.reasonCode}`
        + `${plb.referenceId ? ` ref ${plb.referenceId}` : ''})`
        + `${claimId ? ' matched to a claim' : ' could not be matched to a claim'}`,
      );
    }
  }
}

export function ingestParsed835(
  pool: PoolLike, params: IngestParams, remits: Remittance835[],
): Promise<IngestResult> {
  return withJob(pool, params, 'ingest_835', async (db, warnings) => {
    const { policy, tolerance } = await loadBalancePolicy(db, params.tenantId, params.clientId);
    let processed = 0, skipped = 0;
    for (const era of remits) {
      // Balance before writing anything. Under the strict policy the throw
      // rolls back the whole file: half of a check that does not add up is
      // worse than none of it, and the job row records exactly why.
      const balance = balance835(era, { tolerance });
      if (!balance.balanced) {
        if (policy === 'strict') throw balanceRejection(era, balance);
        for (const f of balance.findings) {
          if (f.severity === 'error') warnings.push(`out of balance: ${f.message}`);
        }
      }
      for (const f of balance.findings) {
        if (f.severity === 'warning') warnings.push(f.message);
      }
      const out = await load835Transaction(db, params, era, warnings, balance);
      processed += out.processed;
      skipped += out.skipped;
    }
    return { processed, skipped };
  });
}

export function ingest835Job(pool: PoolLike, params: IngestParams): Promise<IngestResult> {
  assertValidX12File(params.content, '835');
  return ingestParsed835(pool, params, parse835File(params.content));
}

// ---------------------------------------------------------------------------
// CSV remittance ingest — rows grouped into one remittance per check number
// ---------------------------------------------------------------------------

export function ingestRemittanceCsvJob(
  pool: PoolLike, params: IngestParams,
): Promise<IngestResult> {
  return withJob(pool, params, 'ingest_835', async (db, warnings) => {
    const parsed = parseRemittanceCsv(params.content);
    warnings.push(...parsed.errors);
    if (parsed.rows.length === 0) {
      if (parsed.errors.length) throw new Error(`CSV rejected: ${parsed.errors.join('; ')}`);
      return { processed: 0, skipped: 0 };
    }

    const byCheck = new Map<string, CsvRemitRow[]>();
    for (const row of parsed.rows) {
      const key = row.checkNumber ?? '(no check number)';
      if (!byCheck.has(key)) byCheck.set(key, []);
      byCheck.get(key)!.push(row);
    }

    let processed = 0, skipped = 0;
    for (const [checkNumber, rows] of byCheck) {
      if (checkNumber !== '(no check number)') {
        const dupe = await db.query(
          `SELECT 1 FROM remittance WHERE tenant_id = $1 AND client_id = $2
             AND (check_number = $3 OR eft_trace_number = $3)`,
          [params.tenantId, params.clientId, checkNumber]);
        if (dupe.rows[0]) {
          warnings.push(`check ${checkNumber} already loaded — skipped`);
          skipped += rows.length;
          continue;
        }
      }
      const payerId = await resolvePayer(
        db, params.tenantId, null, rows[0].payerName ?? 'CSV Import Payer', warnings);
      const total = Math.round(rows.reduce((s, r) => s + r.paidAmount, 0) * 100) / 100;
      const rem = await db.query(
        `INSERT INTO remittance (tenant_id, client_id, payer_id, check_date, check_number,
                                 eft_trace_number, total_paid, raw_835_reference, processed_at)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, now()) RETURNING remittance_id`,
        [params.tenantId, params.clientId, payerId, rows[0].checkDate,
         checkNumber === '(no check number)' ? null : checkNumber, total, params.fileName]);
      for (const r of rows) {
        await db.query(
          `INSERT INTO remittance_line
             (tenant_id, remittance_id, procedure_code, billed_amount, allowed_amount,
              paid_amount, patient_responsibility, adjustment_group_code,
              adjustment_reason_code, adjustments, remark_code, quantity,
              payer_claim_number, patient_member_id, date_of_service)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [params.tenantId, rem.rows[0].remittance_id, r.procedureCode, r.billedAmount,
           r.allowedAmount, r.paidAmount, r.patientResponsibility, r.groupCode,
           r.reasonCode, JSON.stringify(r.groupCode && r.reasonCode ? [{
             groupCode: r.groupCode, reasonCode: r.reasonCode, amount: 0, quantity: null,
           }] : []), r.remarkCode, r.units,
           r.payerClaimNumber ?? r.claimNumber, r.memberId, r.dos]);
        processed += 1;
      }
    }
    return { processed, skipped };
  });
}

// ---------------------------------------------------------------------------
// 837P — claims ingest
// ---------------------------------------------------------------------------

export function ingest837Job(pool: PoolLike, params: IngestParams): Promise<IngestResult> {
  assertValidX12File(params.content, '837P');
  return ingestParsed837(pool, params, parse837(params.content));
}

export function ingestParsed837(
  pool: PoolLike, params: IngestParams, file: ClaimFile837,
): Promise<IngestResult> {
  return withJob(pool, params, 'ingest_837', async (db, warnings) => {
    let processed = 0;
    let skipped = 0;

    for (const claim of file.claims) {
      if (!claim.patientControlNumber) {
        warnings.push('claim without a patient control number (CLM01) — skipped');
        skipped += 1;
        continue;
      }
      const dupe = await db.query(
        `SELECT claim_id FROM claim
         WHERE client_id = $1 AND claim_number_internal = $2 AND deleted_at IS NULL`,
        [params.clientId, claim.patientControlNumber],
      );
      if (dupe.rows[0]) {
        skipped += 1;
        continue;
      }

      const payerId = await resolvePayer(db, params.tenantId, null, claim.payerName, warnings);

      // patient upsert by (client, MRN) — member ID serves as MRN for EDI-born
      // patients until the PMS feed supplies a real one
      const mrn = claim.subscriber.memberId || claim.patientControlNumber;
      const patient = await db.query(
        `INSERT INTO patient
           (tenant_id, client_id, mrn, first_name, last_name, dob, gender,
            insurance_id_primary, payer_id_primary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (client_id, mrn) WHERE deleted_at IS NULL
         DO UPDATE SET insurance_id_primary = EXCLUDED.insurance_id_primary,
                       payer_id_primary = EXCLUDED.payer_id_primary
         RETURNING patient_id`,
        [params.tenantId, params.clientId, mrn,
         claim.subscriber.firstName || 'Unknown', claim.subscriber.lastName || 'Unknown',
         claim.subscriber.dob, claim.subscriber.gender,
         claim.subscriber.memberId || null, payerId],
      );
      const patientId = patient.rows[0].patient_id;

      // provider upsert by (client, NPI)
      const npi = claim.renderingProviderNpi ?? file.billingProviderNpi;
      let providerId: UUID;
      const existingProv = npi ? await db.query(
        `SELECT provider_id FROM provider
         WHERE client_id = $1 AND npi_individual = $2 AND deleted_at IS NULL`,
        [params.clientId, npi],
      ) : { rows: [] };
      if (existingProv.rows[0]) {
        providerId = existingProv.rows[0].provider_id;
      } else {
        const prov = await db.query(
          `INSERT INTO provider (tenant_id, client_id, npi_individual, name)
           VALUES ($1, $2, $3, $4) RETURNING provider_id`,
          [params.tenantId, params.clientId, npi,
           claim.renderingProviderName ?? file.billingProviderName ?? 'Unknown Provider'],
        );
        providerId = prov.rows[0].provider_id;
        warnings.push(`provider NPI ${npi ?? '(none)'} not found — created stub record`);
      }

      const dosStart = claim.lines.map((l) => l.dateOfService).filter(Boolean).sort()[0]
        ?? file.transactionDate;
      const encounter = await db.query(
        `INSERT INTO encounter
           (tenant_id, client_id, patient_id, provider_id, date_of_service_start,
            place_of_service, authorization_number, diagnosis_codes, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'billed') RETURNING encounter_id`,
        [params.tenantId, params.clientId, patientId, providerId, dosStart,
         claim.placeOfService, claim.authorizationNumber, claim.diagnosisCodes],
      );

      if ((claim.payerSequence === 'secondary' || claim.payerSequence === 'tertiary')
          && claim.priorPayerPaid == null
          && !claim.lines.some((l) => l.priorPayerPaid != null)) {
        warnings.push(
          `claim ${claim.patientControlNumber} is ${claim.payerSequence} but carries no COB `
          + 'payer-paid amount (AMT*D / SVD02); expected payer liability will fall back to the '
          + "remit's OA-23 amount, and to the full allowed amount if there is none",
        );
      }

      const inserted = await db.query(
        `INSERT INTO claim
           (tenant_id, client_id, encounter_id, payer_id, claim_type,
            claim_number_internal, submission_date, billed_amount, claim_status,
            raw_837_reference, payer_sequence, prior_payer_paid)
         VALUES ($1,$2,$3,$4,'professional',$5,$6,$7,'submitted',$8,$9,$10)
         RETURNING claim_id`,
        [params.tenantId, params.clientId, encounter.rows[0].encounter_id, payerId,
         claim.patientControlNumber, file.transactionDate,
         claim.chargeAmount ?? 0, params.fileName,
         claim.payerSequence ?? 'primary', claim.priorPayerPaid],
      );
      const claimId = inserted.rows[0].claim_id;

      let lineNo = 0;
      for (const line of claim.lines) {
        lineNo += 1;
        await db.query(
          `INSERT INTO claim_line
             (tenant_id, claim_id, line_number, procedure_code,
              modifier_1, modifier_2, modifier_3, modifier_4,
              units, billed_amount, prior_payer_paid)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [params.tenantId, claimId, lineNo, line.procedureCode,
           line.modifiers[0] ?? null, line.modifiers[1] ?? null,
           line.modifiers[2] ?? null, line.modifiers[3] ?? null,
           line.units, line.chargeAmount ?? 0, line.priorPayerPaid ?? null],
        );
      }
      processed += 1;
    }

    return { processed, skipped };
  });
}

// ---------------------------------------------------------------------------
// File routing + preview (manual-upload flow: preview before commit)
// ---------------------------------------------------------------------------

export type IngestFileKind = '835' | '837' | 'csv' | 'unknown';

export function detectFileKind(fileName: string, content: string): IngestFileKind {
  if (/\.(835|era)$/i.test(fileName)) return '835';
  if (/\.837$/i.test(fileName)) return '837';
  if (/\.csv$/i.test(fileName)) return 'csv';
  const head = content.slice(0, 600);
  if (/ST\*835\*/.test(head) || /\*835\*/.test(head)) return '835';
  if (/ST\*837\*/.test(head) || /\*837\*/.test(head)) return '837';
  if (head.includes(',') && !head.startsWith('ISA')) return 'csv';
  return 'unknown';
}

export interface IngestPreview {
  kind: IngestFileKind;
  ok: boolean;
  errors: string[];
  /** Non-blocking findings: structural warnings and soft balancing findings. */
  warnings?: string[];
  summary: {
    transactions?: number;
    payers?: string[];
    checks?: Array<{
      checkNumber: string | null; checkDate: string | null; totalPaid: number | null;
      balanced?: boolean; balanceVariance?: number;
    }>;
    claims: number;
    lines: number;
    /** CLP02 = 22 claims in the file — reversals of earlier payments. */
    reversals?: number;
    /** Service lines the payer adjudicated under a different procedure code. */
    recodedLines?: number;
    providerAdjustments?: Array<{
      reasonCode: string; category: string; referenceId: string | null; amount: number;
    }>;
    providerAdjustmentTotal?: number;
    totalBilled: number;
    totalPaid: number;
    sample: Array<Record<string, unknown>>;   // first rows for the preview table
  };
}

const r2p = (n: number) => Math.round(n * 100) / 100;

/** parse-only: nothing is written; the UI shows this before commit */
export function previewIngestFile(
  fileName: string, content: string, balanceTolerance?: number,
): IngestPreview {
  const kind = detectFileKind(fileName, content);
  const empty = { claims: 0, lines: 0, totalBilled: 0, totalPaid: 0, sample: [] as any[] };
  try {
    if (kind === '835') {
      const validation = validateX12File(content, '835');
      const remits = parse835File(content);
      // Preview balances at zero tolerance so the operator sees the raw truth
      // about the file; the client's own tolerance is applied at commit.
      const balance = balance835File(remits, { tolerance: balanceTolerance ?? 0 });
      const claims = remits.flatMap((r) => r.claims);
      const lines = claims.flatMap((c) => c.lines);
      const providerAdjustments = remits.flatMap((r) => r.providerAdjustments);
      return {
        kind,
        ok: claims.length > 0 && validation.errors.length === 0 && balance.balanced,
        errors: [
          ...validation.errors.map((i) => i.message),
          ...(claims.length ? [] : ['no claims found in 835']),
          ...balance.errors.map((f) => f.message),
        ],
        warnings: [
          ...validation.warnings.map((i) => i.message),
          ...balance.warnings.map((f) => f.message),
        ],
        summary: {
          transactions: remits.length,
          payers: [...new Set(remits.map((r) => r.payerName).filter(Boolean))],
          checks: remits.map((r, i) => ({
            checkNumber: r.traceNumber, checkDate: r.checkDate, totalPaid: r.totalPaid,
            balanced: balance.transactions[i]?.balanced ?? true,
            balanceVariance: balance.transactions[i]?.transactionVariance ?? 0,
          })),
          claims: claims.length,
          lines: lines.length,
          reversals: claims.filter((c) => c.isReversal).length,
          recodedLines: lines.filter((l) => l.payerRecoded).length,
          providerAdjustments: providerAdjustments.map((p) => ({
            reasonCode: p.reasonCode, category: p.category,
            referenceId: p.referenceId, amount: p.amount,
          })),
          providerAdjustmentTotal: r2p(providerAdjustments.reduce((s, p) => s + p.amount, 0)),
          totalBilled: r2p(claims.reduce((s, c) => s + (c.billedAmount ?? 0), 0)),
          totalPaid: r2p(claims.reduce((s, c) => s + (c.paidAmount ?? 0), 0)),
          sample: claims.slice(0, 10).map((c) => ({
            claim: c.patientControlNumber, payerClaim: c.payerClaimNumber,
            patient: `${c.patient.firstName} ${c.patient.lastName}`.trim(),
            billed: c.billedAmount, paid: c.paidAmount,
            reversal: c.isReversal,
            adjustments: [...c.adjustments, ...c.lines.flatMap((l) => l.adjustments)]
              .map((a) => `${a.groupCode}-${a.reasonCode}`).join(' '),
          })),
        },
      };
    }
    if (kind === '837') {
      const validation = validateX12File(content, '837P');
      const file = parse837(content);
      return {
        kind, ok: file.claims.length > 0 && validation.errors.length === 0,
        errors: [
          ...validation.errors.map((i) => i.message),
          ...(file.claims.length ? [] : ['no claims found in 837']),
        ],
        summary: {
          transactions: 1,
          payers: [...new Set(file.claims.map((c) => c.payerName).filter(Boolean))] as string[],
          claims: file.claims.length,
          lines: file.claims.reduce((s, c) => s + c.lines.length, 0),
          totalBilled: r2p(file.claims.reduce((s, c) => s + (c.chargeAmount ?? 0), 0)),
          totalPaid: 0,
          sample: file.claims.slice(0, 10).map((c) => ({
            claim: c.patientControlNumber,
            patient: `${c.subscriber.firstName} ${c.subscriber.lastName}`.trim(),
            dos: c.lines[0]?.dateOfService, billed: c.chargeAmount,
            codes: c.lines.map((l) => l.procedureCode).join(' '),
          })),
        },
      };
    }
    if (kind === 'csv') {
      const parsed = parseRemittanceCsv(content);
      const claims = new Set(parsed.rows.map((r) => r.claimNumber ?? r.payerClaimNumber));
      return {
        kind, ok: parsed.rows.length > 0, errors: parsed.errors,
        summary: {
          ...empty,
          claims: claims.size,
          lines: parsed.rows.length,
          totalBilled: r2p(parsed.rows.reduce((s, r) => s + (r.billedAmount ?? 0), 0)),
          totalPaid: r2p(parsed.rows.reduce((s, r) => s + r.paidAmount, 0)),
          sample: parsed.rows.slice(0, 10).map((r) => ({
            claim: r.claimNumber ?? r.payerClaimNumber, code: r.procedureCode,
            paid: r.paidAmount, reason: r.reasonCode ? `${r.groupCode ?? ''}-${r.reasonCode}` : '',
          })),
        },
      };
    }
    return { kind, ok: false, errors: ['unrecognized file type — expected 835, 837, or CSV'], summary: empty };
  } catch (err) {
    return {
      kind, ok: false,
      errors: [`parse failed: ${err instanceof Error ? err.message : err}`],
      summary: empty,
    };
  }
}

/** route a file to the right ingest job by detected kind */
export function ingestFileByKind(
  pool: PoolLike, params: IngestParams,
): Promise<IngestResult> {
  const kind = detectFileKind(params.fileName, params.content);
  if (kind === '835') return ingest835Job(pool, params);
  if (kind === '837') return ingest837Job(pool, params);
  if (kind === 'csv') return ingestRemittanceCsvJob(pool, params);
  return Promise.reject(Object.assign(
    new Error(`unrecognized file type: ${params.fileName}`), { status: 400 }));
}
