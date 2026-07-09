// ============================================================================
// Builds an EngineInput snapshot from the Postgres schema (db/migrations).
// Scope: one tenant, optionally narrowed to one client. Only remittance
// lines never processed before (match_method IS NULL) enter the run.
// ============================================================================

import type {
  ClaimInput, ContractInput, EngineConfig, EngineInput, UUID,
} from '../types.ts';
import { makeConfig } from '../config.ts';

/** Minimal query surface — pg.Pool and pg.PoolClient both satisfy it. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface SnapshotScope {
  tenantId: UUID;
  clientId?: UUID;
  asOf?: string;                     // default: today (UTC)
  configOverrides?: Partial<EngineConfig>;
  /** claims older than this many days are not match candidates */
  claimLookbackDays?: number;        // default 400
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

export async function loadSnapshot(db: Queryable, scope: SnapshotScope): Promise<EngineInput> {
  const { tenantId } = scope;
  const clientFilter = scope.clientId ? 'AND c.client_id = $2' : '';
  const params: unknown[] = scope.clientId ? [tenantId, scope.clientId] : [tenantId];
  const asOf = scope.asOf ?? new Date().toISOString().slice(0, 10);
  const lookback = scope.claimLookbackDays ?? 400;

  // ---- unprocessed remittance lines (with parent remittance context) -------
  const remit = await db.query(
    `SELECT rl.remittance_line_id, rl.remittance_id, r.payer_id, r.check_date,
            rl.payer_claim_number, rl.patient_member_id, rl.date_of_service,
            rl.procedure_code, rl.billed_amount, rl.allowed_amount, rl.paid_amount,
            rl.patient_responsibility, rl.adjustment_group_code,
            rl.adjustment_reason_code, rl.remark_code, rl.claim_id, rl.claim_line_id
     FROM remittance_line rl
     JOIN remittance r ON r.remittance_id = rl.remittance_id
     WHERE rl.tenant_id = $1 ${scope.clientId ? 'AND r.client_id = $2' : ''}
       AND rl.match_method IS NULL`,
    params,
  );

  // ---- claims + lines + encounter context + available documents ------------
  const claims = await db.query(
    `SELECT cl.claim_id, cl.client_id, cl.payer_id, cl.claim_type, cl.claim_status,
            cl.claim_number_internal, cl.claim_number_payer, cl.submission_date,
            e.patient_id, e.date_of_service_start, e.authorization_number,
            COALESCE(docs.doc_types, '{}') AS doc_types
     FROM claim cl
     JOIN encounter e ON e.encounter_id = cl.encounter_id
     JOIN client c ON c.client_id = cl.client_id
     LEFT JOIN LATERAL (
       SELECT array_agg(DISTINCT d.document_type::text) AS doc_types
       FROM document d
       WHERE d.client_id = cl.client_id AND d.deleted_at IS NULL
         AND (d.case_id IS NULL OR d.case_id IN
              (SELECT rc.case_id FROM recovery_case rc WHERE rc.claim_id = cl.claim_id))
     ) docs ON true
     WHERE cl.tenant_id = $1 ${clientFilter}
       AND cl.deleted_at IS NULL
       AND cl.claim_status <> 'closed'
       AND cl.created_at > now() - make_interval(days => ${lookback})`,
    params,
  );
  const claimIds = claims.rows.map((r) => r.claim_id);

  const lines = claimIds.length === 0 ? { rows: [] } : await db.query(
    `SELECT claim_line_id, claim_id, line_number, procedure_code,
            modifier_1, modifier_2, modifier_3, modifier_4, units,
            billed_amount, expected_amount, allowed_amount, paid_amount,
            denial_reason_code, line_status
     FROM claim_line
     WHERE claim_id = ANY($1) AND deleted_at IS NULL
     ORDER BY claim_id, line_number`,
    [claimIds],
  );
  const linesByClaim = new Map<string, any[]>();
  for (const l of lines.rows) {
    if (!linesByClaim.has(l.claim_id)) linesByClaim.set(l.claim_id, []);
    linesByClaim.get(l.claim_id)!.push(l);
  }

  const claimInputs: ClaimInput[] = claims.rows.map((r) => ({
    claimId: r.claim_id,
    clientId: r.client_id,
    payerId: r.payer_id,
    patientId: r.patient_id,
    claimNumberInternal: r.claim_number_internal,
    claimNumberPayer: r.claim_number_payer,
    dateOfServiceStart: iso(r.date_of_service_start),
    submissionDate: iso(r.submission_date),
    claimStatus: r.claim_status,
    authorizationNumber: r.authorization_number,
    availableDocumentTypes: r.doc_types ?? [],
    lines: (linesByClaim.get(r.claim_id) ?? []).map((l) => ({
      claimLineId: l.claim_line_id,
      lineNumber: l.line_number,
      procedureCode: l.procedure_code,
      modifiers: [l.modifier_1, l.modifier_2, l.modifier_3, l.modifier_4].filter(Boolean),
      units: Number(l.units) || 1,
      billedAmount: Number(l.billed_amount),
      expectedAmount: num(l.expected_amount),
      allowedAmount: num(l.allowed_amount),
      paidAmount: num(l.paid_amount),
      denialReasonCode: l.denial_reason_code,
      lineStatus: l.line_status,
    })),
  }));

  // ---- patients (those on the loaded claims) --------------------------------
  const patientIds = [...new Set(claims.rows.map((r) => r.patient_id))];
  const patients = patientIds.length === 0 ? { rows: [] } : await db.query(
    `SELECT patient_id, insurance_id_primary, insurance_id_secondary
     FROM patient WHERE patient_id = ANY($1)`,
    [patientIds],
  );

  // ---- payers (shared masters + tenant-scoped) ------------------------------
  const payers = await db.query(
    `SELECT payer_id, payer_name, appeal_deadline_days, timely_filing_limit_days
     FROM payer WHERE (tenant_id IS NULL OR tenant_id = $1) AND deleted_at IS NULL`,
    [tenantId],
  );

  // ---- contracts + lines ------------------------------------------------------
  const contracts = await db.query(
    `SELECT ct.contract_id, ct.client_id, ct.payer_id, ct.effective_date,
            ct.expiration_date, ct.fee_schedule_type
     FROM contract ct JOIN client c ON c.client_id = ct.client_id
     WHERE ct.tenant_id = $1 ${clientFilter} AND ct.deleted_at IS NULL`,
    params,
  );
  const contractIds = contracts.rows.map((r) => r.contract_id);
  const contractLines = contractIds.length === 0 ? { rows: [] } : await db.query(
    `SELECT contract_id, procedure_code, modifier, allowed_amount,
            percent_of_medicare, effective_date
     FROM contract_line WHERE contract_id = ANY($1) AND deleted_at IS NULL`,
    [contractIds],
  );
  const clByContract = new Map<string, any[]>();
  for (const l of contractLines.rows) {
    if (!clByContract.has(l.contract_id)) clByContract.set(l.contract_id, []);
    clByContract.get(l.contract_id)!.push(l);
  }
  const contractInputs: ContractInput[] = contracts.rows.map((r) => ({
    contractId: r.contract_id,
    clientId: r.client_id,
    payerId: r.payer_id,
    effectiveDate: iso(r.effective_date)!,
    expirationDate: iso(r.expiration_date),
    feeScheduleType: r.fee_schedule_type,
    lines: (clByContract.get(r.contract_id) ?? []).map((l) => ({
      procedureCode: l.procedure_code,
      modifier: l.modifier,
      allowedAmount: num(l.allowed_amount),
      percentOfMedicare: num(l.percent_of_medicare),
      effectiveDate: iso(l.effective_date),
    })),
  }));

  // ---- medicare reference rates ----------------------------------------------
  const medicare = await db.query(
    `SELECT DISTINCT ON (procedure_code, COALESCE(modifier, ''))
            procedure_code, modifier, rate
     FROM medicare_fee_schedule
     ORDER BY procedure_code, COALESCE(modifier, ''), effective_year DESC`,
  );
  const medicareRates: Record<string, number> = {};
  for (const r of medicare.rows) {
    medicareRates[`${r.procedure_code}|${r.modifier ?? ''}`] = Number(r.rate);
  }

  // ---- open cases (dedup), win-rate history, configs -------------------------
  const existingCases = await db.query(
    `SELECT rc.case_id, rc.claim_id, rc.claim_line_id, rc.case_type, rc.status
     FROM recovery_case rc JOIN client c ON c.client_id = rc.client_id
     WHERE rc.tenant_id = $1 ${clientFilter} AND rc.deleted_at IS NULL
       AND rc.status IN ('open', 'in_progress', 'submitted', 'pending_payer')`,
    params,
  );

  const winRates = await db.query(
    `SELECT cl.payer_id, rc.denial_category,
            count(*) FILTER (WHERE rc.status = 'won')  AS won,
            count(*) FILTER (WHERE rc.status = 'lost') AS lost
     FROM recovery_case rc
     JOIN claim cl ON cl.claim_id = rc.claim_id
     WHERE rc.tenant_id = $1 AND rc.denial_category IS NOT NULL
       AND rc.status IN ('won', 'lost')
     GROUP BY cl.payer_id, rc.denial_category`,
    [tenantId],
  );

  const cpc = await db.query(
    `SELECT cpc.client_id, cpc.payer_id, cpc.autopilot_enabled, cpc.min_case_threshold
     FROM client_payer_config cpc JOIN client c ON c.client_id = cpc.client_id
     WHERE cpc.tenant_id = $1 ${clientFilter}`,
    params,
  );

  const thresholds = await db.query(
    `SELECT c.client_id, c.recovery_alert_threshold
     FROM client c WHERE c.tenant_id = $1 ${clientFilter}
       AND c.recovery_alert_threshold IS NOT NULL`,
    params,
  );
  const clientAlertThresholds: Record<string, number> = {};
  for (const r of thresholds.rows) {
    clientAlertThresholds[r.client_id] = Number(r.recovery_alert_threshold);
  }

  return {
    tenantId,
    config: makeConfig(asOf, scope.configOverrides),
    payers: payers.rows.map((r) => ({
      payerId: r.payer_id,
      payerName: r.payer_name,
      appealDeadlineDays: r.appeal_deadline_days,
      timelyFilingLimitDays: r.timely_filing_limit_days,
    })),
    patients: patients.rows.map((r) => ({
      patientId: r.patient_id,
      insuranceIdPrimary: r.insurance_id_primary,
      insuranceIdSecondary: r.insurance_id_secondary,
    })),
    claims: claimInputs,
    remitLines: remit.rows.map((r) => ({
      remittanceLineId: r.remittance_line_id,
      remittanceId: r.remittance_id,
      payerId: r.payer_id,
      checkDate: iso(r.check_date),
      payerClaimNumber: r.payer_claim_number,
      patientMemberId: r.patient_member_id,
      dateOfService: iso(r.date_of_service),
      procedureCode: r.procedure_code,
      billedAmount: num(r.billed_amount),
      allowedAmount: num(r.allowed_amount),
      paidAmount: num(r.paid_amount),
      patientResponsibility: num(r.patient_responsibility),
      adjustmentGroupCode: r.adjustment_group_code,
      adjustmentReasonCode: r.adjustment_reason_code,
      remarkCode: r.remark_code,
      claimId: r.claim_id,
      claimLineId: r.claim_line_id,
    })),
    contracts: contractInputs,
    medicareRates,
    existingCases: existingCases.rows.map((r) => ({
      caseId: r.case_id,
      claimId: r.claim_id,
      claimLineId: r.claim_line_id,
      caseType: r.case_type,
      status: r.status,
    })),
    winRates: winRates.rows.map((r) => ({
      payerId: r.payer_id,
      denialCategory: r.denial_category,
      won: Number(r.won),
      lost: Number(r.lost),
    })),
    clientPayerConfigs: cpc.rows.map((r) => ({
      clientId: r.client_id,
      payerId: r.payer_id,
      autopilotEnabled: r.autopilot_enabled,
      minCaseThreshold: num(r.min_case_threshold),
    })),
    clientAlertThresholds,
  };
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
