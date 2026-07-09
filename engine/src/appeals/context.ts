// ============================================================================
// Loads AppealCaseContext rows from Postgres for every recovery case with
// status open or in_progress that doesn't already have a finalized packet
// (ready / submitted / acknowledged). Cases with a draft packet are reloaded
// so the packet can be refreshed (e.g. a missing document has since arrived).
// ============================================================================

import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';
import type { AppealCaseContext } from './types.ts';

export interface AppealScope {
  tenantId: UUID;
  clientId?: UUID;
  asOf?: string;
  /** limit to specific cases (manual regeneration) */
  caseIds?: UUID[];
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

export async function loadAppealContexts(
  db: Queryable, scope: AppealScope,
): Promise<AppealCaseContext[]> {
  const asOf = scope.asOf ?? new Date().toISOString().slice(0, 10);
  const params: unknown[] = [scope.tenantId];
  let filter = '';
  if (scope.clientId) { params.push(scope.clientId); filter += ` AND rc.client_id = $${params.length}`; }
  if (scope.caseIds?.length) { params.push(scope.caseIds); filter += ` AND rc.case_id = ANY($${params.length})`; }

  const cases = await db.query(
    `SELECT rc.case_id, rc.case_type, rc.denial_category, rc.denial_reason_code,
            rc.priority_level, rc.recovery_opportunity, rc.expected_amount,
            rc.paid_amount, rc.confidence_score, rc.deadline_date, rc.claim_line_id,
            rc.client_id, c.client_name, c.address AS client_address,
            c.npi_group, c.appeal_review_threshold,
            cl.claim_id, cl.claim_number_internal, cl.claim_number_payer,
            cl.submission_date, cl.payer_id,
            py.payer_name, py.appeal_address, py.portal_url,
            e.date_of_service_start, e.authorization_number,
            pat.patient_id, pat.first_name AS patient_first, pat.last_name AS patient_last,
            pat.dob AS patient_dob, pat.mrn,
            pr.name AS provider_name, pr.npi_individual,
            draft.packet_id AS draft_packet_id,
            COALESCE(pkts.n, 0) AS prior_packet_count,
            COALESCE(cpc.autopilot_enabled, false) AS autopilot_enabled,
            COALESCE(hist.n, 0) AS prior_category_case_count
     FROM recovery_case rc
     JOIN client c    ON c.client_id = rc.client_id
     JOIN claim cl    ON cl.claim_id = rc.claim_id
     JOIN payer py    ON py.payer_id = cl.payer_id
     JOIN encounter e ON e.encounter_id = cl.encounter_id
     JOIN patient pat ON pat.patient_id = e.patient_id
     JOIN provider pr ON pr.provider_id = e.provider_id
     LEFT JOIN LATERAL (
       SELECT ap.packet_id FROM appeal_packet ap
       WHERE ap.case_id = rc.case_id AND ap.packet_status = 'draft'
         AND ap.deleted_at IS NULL
       ORDER BY ap.created_at DESC LIMIT 1
     ) draft ON true
     LEFT JOIN LATERAL (
       SELECT count(*) AS n FROM appeal_packet ap
       WHERE ap.case_id = rc.case_id
         AND ap.packet_status IN ('submitted', 'acknowledged')
         AND ap.deleted_at IS NULL
     ) pkts ON true
     LEFT JOIN client_payer_config cpc
       ON cpc.client_id = rc.client_id AND cpc.payer_id = cl.payer_id
     LEFT JOIN LATERAL (
       SELECT count(*) AS n FROM recovery_case prior
       JOIN claim pcl ON pcl.claim_id = prior.claim_id
       WHERE prior.tenant_id = rc.tenant_id
         AND pcl.payer_id = cl.payer_id
         AND prior.case_id <> rc.case_id
         AND COALESCE(prior.denial_category, prior.case_type::text)
             = COALESCE(rc.denial_category, rc.case_type::text)
     ) hist ON true
     WHERE rc.tenant_id = $1 ${filter}
       AND rc.status IN ('open', 'in_progress')
       AND rc.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM appeal_packet ap
         WHERE ap.case_id = rc.case_id AND ap.deleted_at IS NULL
           AND ap.packet_status IN ('ready', 'submitted', 'acknowledged')
       )`,
    params,
  );
  if (cases.rows.length === 0) return [];

  const claimIds = [...new Set(cases.rows.map((r) => r.claim_id))];
  const caseIds = cases.rows.map((r) => r.case_id);
  const clientIds = [...new Set(cases.rows.map((r) => r.client_id))];

  const lines = await db.query(
    `SELECT claim_line_id, claim_id, line_number, procedure_code,
            modifier_1, modifier_2, modifier_3, modifier_4, units,
            billed_amount, expected_amount, paid_amount, denial_reason_code
     FROM claim_line WHERE claim_id = ANY($1) AND deleted_at IS NULL
     ORDER BY claim_id, line_number`,
    [claimIds],
  );
  const linesByClaim = groupBy(lines.rows, (r) => r.claim_id);

  const remits = await db.query(
    `SELECT rl.claim_id, rl.procedure_code, rl.billed_amount, rl.allowed_amount,
            rl.paid_amount, rl.adjustment_group_code, rl.adjustment_reason_code,
            r.check_date, r.check_number
     FROM remittance_line rl JOIN remittance r ON r.remittance_id = rl.remittance_id
     WHERE rl.claim_id = ANY($1)`,
    [claimIds],
  );
  const remitsByClaim = groupBy(remits.rows, (r) => r.claim_id);

  // active contract per client+payer as of each claim's DOS — load all for
  // the involved clients and resolve in code
  const contracts = await db.query(
    `SELECT ct.contract_id, ct.client_id, ct.payer_id, ct.effective_date,
            ct.expiration_date, ct.fee_schedule_type,
            l.procedure_code, l.modifier, l.allowed_amount, l.percent_of_medicare
     FROM contract ct
     LEFT JOIN contract_line l ON l.contract_id = ct.contract_id AND l.deleted_at IS NULL
     WHERE ct.client_id = ANY($1) AND ct.deleted_at IS NULL`,
    [clientIds],
  );

  // documents usable for assembly: case-attached + client-level (case_id NULL)
  const docs = await db.query(
    `SELECT document_id, client_id, case_id, document_type, file_name
     FROM document
     WHERE client_id = ANY($1) AND deleted_at IS NULL
       AND (case_id IS NULL OR case_id = ANY($2))
       AND source <> 'system_generated'`,
    [clientIds, caseIds],
  );

  return cases.rows.map((r) => {
    const dos = iso(r.date_of_service_start)!;
    const contractRows = contracts.rows.filter(
      (ct) => ct.client_id === r.client_id && ct.payer_id === r.payer_id
        && iso(ct.effective_date)! <= dos
        && (!ct.expiration_date || iso(ct.expiration_date)! >= dos),
    );
    const contractId = contractRows
      .sort((a, b) => (iso(a.effective_date)! < iso(b.effective_date)! ? 1 : -1))[0]?.contract_id;
    const contractLines = contractRows.filter((ct) => ct.contract_id === contractId && ct.procedure_code);

    return {
      caseId: r.case_id,
      caseType: r.case_type,
      denialCategory: r.denial_category,
      denialReasonCode: r.denial_reason_code,
      priorityLevel: r.priority_level,
      recoveryOpportunity: num(r.recovery_opportunity) ?? 0,
      expectedAmount: num(r.expected_amount),
      paidAmount: num(r.paid_amount),
      confidenceScore: num(r.confidence_score),
      deadlineDate: iso(r.deadline_date),
      claimLineId: r.claim_line_id,
      clientId: r.client_id,
      clientName: r.client_name,
      clientAddress: r.client_address,
      clientNpiGroup: r.npi_group,
      providerName: r.provider_name,
      providerNpi: r.npi_individual,
      payerId: r.payer_id,
      payerName: r.payer_name,
      appealAddress: r.appeal_address,
      portalUrl: r.portal_url,
      patientFirstName: r.patient_first,
      patientLastName: r.patient_last,
      patientDob: iso(r.patient_dob),
      patientMrn: r.mrn,
      claimId: r.claim_id,
      claimNumberInternal: r.claim_number_internal,
      claimNumberPayer: r.claim_number_payer,
      dateOfService: dos,
      submissionDate: iso(r.submission_date),
      authorizationNumber: r.authorization_number,
      claimLines: (linesByClaim.get(r.claim_id) ?? []).map((l) => ({
        claimLineId: l.claim_line_id,
        lineNumber: l.line_number,
        procedureCode: l.procedure_code,
        modifiers: [l.modifier_1, l.modifier_2, l.modifier_3, l.modifier_4].filter(Boolean),
        units: Number(l.units) || 1,
        billedAmount: Number(l.billed_amount),
        expectedAmount: num(l.expected_amount),
        paidAmount: num(l.paid_amount),
        denialReasonCode: l.denial_reason_code,
      })),
      remitLines: (remitsByClaim.get(r.claim_id) ?? []).map((x) => ({
        procedureCode: x.procedure_code,
        billedAmount: num(x.billed_amount),
        allowedAmount: num(x.allowed_amount),
        paidAmount: num(x.paid_amount),
        adjustmentGroupCode: x.adjustment_group_code,
        adjustmentReasonCode: x.adjustment_reason_code,
        checkDate: iso(x.check_date),
        checkNumber: x.check_number,
      })),
      contract: contractId ? {
        feeScheduleType: contractRows[0].fee_schedule_type,
        effectiveDate: iso(contractRows[0].effective_date)!,
        lines: contractLines.map((l) => ({
          procedureCode: l.procedure_code,
          modifier: l.modifier,
          allowedAmount: num(l.allowed_amount),
          percentOfMedicare: num(l.percent_of_medicare),
        })),
      } : null,
      existingDocuments: docs.rows
        .filter((d) => d.client_id === r.client_id && (d.case_id == null || d.case_id === r.case_id))
        .map((d) => ({
          documentId: d.document_id, documentType: d.document_type, fileName: d.file_name,
        })),
      autopilotEnabled: r.autopilot_enabled,
      priorCategoryCaseCount: Number(r.prior_category_case_count),
      priorPacketCount: Number(r.prior_packet_count),
      clientReviewThreshold: num(r.appeal_review_threshold),
      existingDraftPacketId: r.draft_packet_id,
      asOf,
    };
  });
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return map;
}
