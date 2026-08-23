// ============================================================================
// Builds an EngineInput snapshot from the Postgres schema (db/migrations).
// Scope: one tenant, optionally narrowed to one client. Only remittance
// lines never processed before (match_method IS NULL) enter the run.
// ============================================================================

import type {
  ClaimInput, ContractInput, EngineConfig, EngineInput, NcciBundlingPolicy,
  NcciDatasetInput, NcciEditInput, NcciServiceSetting, UUID,
} from '../types.ts';
import { makeConfig } from '../config.ts';
import { proceduresNeedingNcci } from '../steps/ncci.ts';

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
  // New clients fail closed until their client/payer profile has explicitly
  // enabled detection. Legacy clients preserve pre-readiness behavior via the
  // database capability function.
  const remit = await db.query(
    `SELECT rl.remittance_line_id, rl.remittance_id, r.payer_id, r.check_date,
            rl.payer_claim_number, rl.patient_member_id, rl.date_of_service,
            rl.procedure_code, rl.billed_amount, rl.allowed_amount, rl.paid_amount,
            rl.patient_responsibility, rl.adjustment_group_code,
            rl.adjustment_reason_code, rl.adjustments, rl.remark_code,
            rl.claim_status_code, rl.is_reversal, rl.adjudicated_procedure_code,
            rl.paid_units, rl.original_units, rl.payer_recoded,
            rl.claim_id, rl.claim_line_id, rl.matched_at
     FROM remittance_line rl
     JOIN remittance r ON r.remittance_id = rl.remittance_id
     WHERE rl.tenant_id = $1 ${scope.clientId ? 'AND r.client_id = $2' : ''}
       AND rl.match_method IS NULL
       AND app.client_payer_capability_enabled(r.client_id, r.payer_id, 'detection')`,
    params,
  );

  // ---- claims + lines + encounter context + available documents ------------
  const claims = await db.query(
    `SELECT cl.claim_id, cl.client_id, cl.payer_id, cl.claim_type, cl.claim_status,
            cl.claim_number_internal, cl.claim_number_payer, cl.submission_date,
            cl.payer_sequence, cl.prior_payer_paid,
            e.patient_id, e.date_of_service_start, e.place_of_service, e.authorization_number,
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
       AND cl.created_at > now() - make_interval(days => ${lookback})
       AND app.client_payer_capability_enabled(cl.client_id, cl.payer_id, 'detection')`,
    params,
  );
  const claimIds = claims.rows.map((r) => r.claim_id);

  const lines = claimIds.length === 0 ? { rows: [] } : await db.query(
    `SELECT claim_line_id, claim_id, line_number, procedure_code,
            modifier_1, modifier_2, modifier_3, modifier_4, units,
            billed_amount, expected_amount, allowed_amount, paid_amount,
            patient_responsibility,
            denial_reason_code, line_status, prior_payer_paid
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
    claimType: r.claim_type,
    dateOfServiceStart: iso(r.date_of_service_start),
    placeOfService: r.place_of_service,
    submissionDate: iso(r.submission_date),
    claimStatus: r.claim_status,
    authorizationNumber: r.authorization_number,
    availableDocumentTypes: r.doc_types ?? [],
    payerSequence: r.payer_sequence ?? 'primary',
    priorPayerPaid: num(r.prior_payer_paid),
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
      patientResponsibility: num(l.patient_responsibility),
      denialReasonCode: l.denial_reason_code,
      lineStatus: l.line_status,
      priorPayerPaid: num(l.prior_payer_paid),
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
    `SELECT payer_id, payer_name, appeal_deadline_days, timely_filing_limit_days,
            payment_reduction_percent, bundling_edit_source
     FROM payer WHERE (tenant_id IS NULL OR tenant_id = $1) AND deleted_at IS NULL`,
    [tenantId],
  );

  // ---- contracts + lines ------------------------------------------------------
  const contracts = await db.query(
    `SELECT ct.contract_id, ct.client_id, ct.payer_id, ct.effective_date,
            ct.expiration_date, ct.fee_schedule_type, ct.apply_lesser_of_billed
     FROM contract ct JOIN client c ON c.client_id = ct.client_id
     WHERE ct.tenant_id = $1 ${clientFilter} AND ct.deleted_at IS NULL
       AND ct.status = 'active'
       AND app.client_payer_capability_enabled(ct.client_id, ct.payer_id, 'detection')`,
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
    applyLesserOfBilled: r.apply_lesser_of_billed !== false,
    lines: (clByContract.get(r.contract_id) ?? []).map((l) => ({
      procedureCode: l.procedure_code,
      modifier: l.modifier,
      allowedAmount: num(l.allowed_amount),
      percentOfMedicare: num(l.percent_of_medicare),
      effectiveDate: iso(l.effective_date),
    })),
  }));

  // ---- modifier payment rules (shared defaults + tenant overrides) -----------
  const modifierRules = await db.query(
    `SELECT modifier, percent_of_allowed, apply_order, payer_id, tenant_id
     FROM modifier_payment_rule
     WHERE (tenant_id IS NULL OR tenant_id = $1) AND deleted_at IS NULL`,
    [tenantId],
  );

  // ---- medicare reference rates ----------------------------------------------
  const medicare = await db.query(
    `SELECT DISTINCT ON (procedure_code, COALESCE(modifier, ''), COALESCE(locality, ''), service_setting)
            m.procedure_code, m.modifier, m.rate, m.locality, m.service_setting, m.dataset_id
     FROM medicare_fee_schedule m
     LEFT JOIN reference_dataset rd ON rd.dataset_id = m.dataset_id
     ORDER BY procedure_code, COALESCE(modifier, ''), COALESCE(locality, ''),
              service_setting, COALESCE(rd.effective_date, make_date(effective_year, 1, 1)) DESC,
              rd.imported_at DESC NULLS LAST`,
  );
  const medicareRates: Record<string, number> = {};
  for (const r of medicare.rows) {
    const detailed = `${r.procedure_code}|${r.modifier ?? ''}|${r.locality ?? ''}|${r.service_setting}`;
    medicareRates[detailed] = Number(r.rate);
    // Pre-provenance rows remain usable during migration. Versioned imports
    // never populate the ambiguous legacy key.
    if (r.dataset_id == null) medicareRates[`${r.procedure_code}|${r.modifier ?? ''}`] = Number(r.rate);
  }

  const localityRows = await db.query(
    `SELECT c.client_id, cmc.medicare_locality
     FROM client c
     JOIN client_medicare_config cmc
       ON cmc.tenant_id = c.tenant_id AND cmc.client_id = c.client_id
     WHERE c.tenant_id = $1 ${clientFilter}`, params);
  const medicareLocalityByClient: Record<string, string> = {};
  for (const r of localityRows.rows) medicareLocalityByClient[r.client_id] = r.medicare_locality;

  // ---- CMS NCCI procedure-to-procedure edits ---------------------------------
  // Narrow on purpose. The published tables run to millions of pairs; only
  // edits whose BOTH sides appear on this run's claims can ever fire, and the
  // (service_setting, column_one_code, column_two_code) index makes that a
  // cheap lookup. Loading the tables wholesale would put a quarter of a
  // gigabyte of reference data into a per-run snapshot to answer questions
  // about a handful of codes.
  //
  // Only the newest imported dataset per service setting is consulted: the CMS
  // PTP files are cumulative full replacements each quarter, so an older
  // import is superseded rather than additive, and mixing the two would revive
  // edits CMS has since withdrawn.
  const runProcedures = proceduresNeedingNcci(claimInputs);
  const ncciDatasetRows = await db.query(
    `SELECT DISTINCT ON (scope) dataset_id, scope, version, effective_date
     FROM reference_dataset
     WHERE dataset_kind = 'ncci_ptp'
     ORDER BY scope, effective_date DESC NULLS LAST, imported_at DESC`,
  );
  const ncciDatasets: NcciDatasetInput[] = ncciDatasetRows.rows
    .filter((r) => r.scope === 'practitioner' || r.scope === 'outpatient_hospital')
    .map((r) => ({
      serviceSetting: r.scope as NcciServiceSetting,
      version: r.version,
      effectiveDate: iso(r.effective_date),
    }));
  const ncciDatasetIds = ncciDatasetRows.rows
    .filter((r) => r.scope === 'practitioner' || r.scope === 'outpatient_hospital')
    .map((r) => r.dataset_id);

  const ncciRows = (runProcedures.length === 0 || ncciDatasetIds.length === 0)
    ? { rows: [] }
    : await db.query(
      `SELECT service_setting, column_one_code, column_two_code,
              effective_date, deletion_date, modifier_indicator
       FROM ncci_ptp_edit
       WHERE dataset_id = ANY($1)
         AND column_one_code = ANY($2) AND column_two_code = ANY($2)`,
      [ncciDatasetIds, runProcedures],
    );
  const ncciEdits: NcciEditInput[] = ncciRows.rows.map((r) => ({
    serviceSetting: r.service_setting,
    columnOneCode: r.column_one_code,
    columnTwoCode: r.column_two_code,
    effectiveDate: iso(r.effective_date)!,
    deletionDate: iso(r.deletion_date),
    modifierIndicator: Number(r.modifier_indicator) as 0 | 1 | 9,
  }));

  const ncciPolicyRows = await db.query(
    `SELECT c.client_id, c.ncci_bundling_policy
     FROM client c WHERE c.tenant_id = $1 ${clientFilter}`, params);
  const ncciBundlingPolicyByClient: Record<string, NcciBundlingPolicy> = {};
  for (const r of ncciPolicyRows.rows) {
    ncciBundlingPolicyByClient[r.client_id] = r.ncci_bundling_policy ?? 'advisory';
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
      paymentReductionPercent: num(r.payment_reduction_percent),
      bundlingEditSource: r.bundling_edit_source ?? 'ncci',
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
      adjustments: Array.isArray(r.adjustments)
        ? r.adjustments.map((a: any) => ({
          groupCode: String(a.groupCode ?? ''),
          reasonCode: String(a.reasonCode ?? ''),
          amount: Number(a.amount ?? 0),
          quantity: num(a.quantity),
        })).filter((a: any) => a.groupCode && a.reasonCode)
        : [],
      adjustmentGroupCode: r.adjustment_group_code,
      adjustmentReasonCode: r.adjustment_reason_code,
      remarkCode: r.remark_code,
      claimStatusCode: r.claim_status_code,
      isReversal: r.is_reversal === true,
      adjudicatedProcedureCode: r.adjudicated_procedure_code,
      payerRecoded: r.payer_recoded === true,
      paidUnits: num(r.paid_units),
      originalUnits: num(r.original_units),
      claimId: r.claim_id,
      claimLineId: r.claim_line_id,
      previouslyProcessed: r.matched_at != null,
    })),
    contracts: contractInputs,
    modifierRules: modifierRules.rows.map((r) => ({
      modifier: r.modifier,
      percentOfAllowed: Number(r.percent_of_allowed),
      applyOrder: r.apply_order,
      payerId: r.payer_id,
      tenantId: r.tenant_id,
    })),
    medicareRates,
    medicareLocalityByClient,
    ncciEdits,
    ncciDatasets,
    ncciBundlingPolicyByClient,
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
