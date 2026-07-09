// ============================================================================
// Read-side queries for the operational interface. Every function takes the
// session's tenant + visible client ids explicitly — same defense-in-depth
// scoping the services use (RLS backs it up under the rcm_app role).
// ============================================================================

import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';

export interface Scope { tenantId: UUID; clientIds: UUID[] }

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

const OPEN_STATUSES = ['open', 'in_progress', 'submitted', 'pending_payer'];

// ---------------------------------------------------------------------------
// MAIN DASHBOARD
// ---------------------------------------------------------------------------

export async function dashboard(db: Queryable, s: Scope, asOf: string) {
  const base = `FROM recovery_case rc
    WHERE rc.tenant_id = $1 AND rc.client_id = ANY($2) AND rc.deleted_at IS NULL
      AND rc.status = ANY($3)`;
  const p = [s.tenantId, s.clientIds, OPEN_STATUSES];

  const totals = await db.query(
    `SELECT count(*)::int AS n, COALESCE(sum(rc.recovery_opportunity), 0) AS amount,
       count(*) FILTER (WHERE rc.deadline_date <= $4::date + 7 AND rc.deadline_date >= $4::date)::int AS week_n,
       COALESCE(sum(rc.recovery_opportunity) FILTER (WHERE rc.deadline_date <= $4::date + 7 AND rc.deadline_date >= $4::date), 0) AS week_amount,
       count(*) FILTER (WHERE rc.deadline_date <= $4::date)::int AS today_n,
       COALESCE(sum(rc.recovery_opportunity) FILTER (WHERE rc.deadline_date <= $4::date), 0) AS today_amount
     ${base}`, [...p, asOf]);

  const topPayers = await db.query(
    `SELECT py.payer_name, COALESCE(sum(rc.recovery_opportunity), 0) AS amount, count(*)::int AS n
     FROM recovery_case rc JOIN claim cl ON cl.claim_id = rc.claim_id
     JOIN payer py ON py.payer_id = cl.payer_id
     WHERE rc.tenant_id = $1 AND rc.client_id = ANY($2) AND rc.deleted_at IS NULL
       AND rc.status = ANY($3)
     GROUP BY py.payer_name ORDER BY amount DESC LIMIT 5`, p);

  const topCategories = await db.query(
    `SELECT COALESCE(rc.denial_category, rc.case_type::text) AS category,
            count(*)::int AS n, COALESCE(sum(rc.recovery_opportunity), 0) AS amount
     FROM recovery_case rc
     WHERE rc.tenant_id = $1 AND rc.client_id = ANY($2) AND rc.deleted_at IS NULL
       AND rc.created_at >= date_trunc('month', $3::date)
     GROUP BY 1 ORDER BY amount DESC LIMIT 5`, [s.tenantId, s.clientIds, asOf]);

  // 90-day trend: identified / submitted / recovered, weekly buckets
  const identified = await db.query(
    `SELECT date_trunc('week', rc.created_at)::date AS wk, COALESCE(sum(rc.recovery_opportunity), 0) AS amount
     FROM recovery_case rc
     WHERE rc.tenant_id = $1 AND rc.client_id = ANY($2) AND rc.deleted_at IS NULL
       AND rc.created_at >= $3::date - 90
     GROUP BY 1 ORDER BY 1`, [s.tenantId, s.clientIds, asOf]);
  const submitted = await db.query(
    `SELECT date_trunc('week', ap.submitted_at)::date AS wk, COALESCE(sum(rc.recovery_opportunity), 0) AS amount
     FROM appeal_packet ap JOIN recovery_case rc ON rc.case_id = ap.case_id
     WHERE ap.tenant_id = $1 AND rc.client_id = ANY($2) AND ap.submitted_at IS NOT NULL
       AND ap.submitted_at >= $3::date - 90
     GROUP BY 1 ORDER BY 1`, [s.tenantId, s.clientIds, asOf]);
  const recovered = await db.query(
    `SELECT date_trunc('week', pe.payment_date)::date AS wk, COALESCE(sum(pe.amount_recovered), 0) AS amount
     FROM payment_event pe JOIN recovery_case rc ON rc.case_id = pe.case_id
     WHERE pe.tenant_id = $1 AND rc.client_id = ANY($2)
       AND pe.payment_date >= $3::date - 90
     GROUP BY 1 ORDER BY 1`, [s.tenantId, s.clientIds, asOf]);

  const weeks = [...new Set([
    ...identified.rows, ...submitted.rows, ...recovered.rows,
  ].map((r) => iso(r.wk)!))].sort();
  const series = (rows: any[]) => {
    const m = new Map(rows.map((r) => [iso(r.wk), num(r.amount)]));
    return weeks.map((w) => m.get(w) ?? 0);
  };

  const activity = await db.query(
    `SELECT ca.action_date, ca.action_type, ca.notes, ca.performed_by_system,
            u.first_name || ' ' || u.last_name AS user_name,
            rc.case_id, pat.first_name || ' ' || pat.last_name AS patient_name
     FROM case_action ca
     JOIN recovery_case rc ON rc.case_id = ca.case_id
     JOIN claim cl ON cl.claim_id = rc.claim_id
     JOIN encounter e ON e.encounter_id = cl.encounter_id
     JOIN patient pat ON pat.patient_id = e.patient_id
     LEFT JOIN app_user u ON u.user_id = ca.performed_by_user_id
     WHERE ca.tenant_id = $1 AND rc.client_id = ANY($2)
     ORDER BY ca.action_date DESC LIMIT 10`, [s.tenantId, s.clientIds]);

  const t = totals.rows[0];
  return {
    openTotal: { count: t.n, amount: num(t.amount) },
    dueThisWeek: { count: t.week_n, amount: num(t.week_amount) },
    dueToday: { count: t.today_n, amount: num(t.today_amount) },
    topPayers: topPayers.rows.map((r) => ({ label: r.payer_name, amount: num(r.amount), count: r.n })),
    topCategories: topCategories.rows.map((r) => ({ label: r.category, amount: num(r.amount), count: r.n })),
    trend: {
      weeks,
      identified: series(identified.rows),
      submitted: series(submitted.rows),
      recovered: series(recovered.rows),
    },
    activity: activity.rows.map((r) => ({
      date: r.action_date instanceof Date ? r.action_date.toISOString() : String(r.action_date),
      actionType: r.action_type,
      by: r.performed_by_system ? 'System' : (r.user_name ?? 'Unknown'),
      caseId: r.case_id,
      patientName: r.patient_name,
      notes: r.notes,
    })),
  };
}

// ---------------------------------------------------------------------------
// RECOVERY CASE QUEUE
// ---------------------------------------------------------------------------

export interface QueueFilters {
  priority?: string;
  payerId?: string;
  category?: string;
  status?: string;         // default: open statuses; 'all' = everything
  assignedTo?: string;     // user id or 'unassigned'
  dosFrom?: string; dosTo?: string;
  deadlineFrom?: string; deadlineTo?: string;
  amountMin?: string; amountMax?: string;
  sort?: string; dir?: string;
}

const QUEUE_SORTS: Record<string, string> = {
  priority: 'rc.priority_level',
  case_id: 'rc.created_at',
  patient: 'patient_name',
  payer: 'py.payer_name',
  dos: 'e.date_of_service_start',
  procedure: 'procedure_code',
  category: 'denial_category',
  amount: 'rc.recovery_opportunity',
  deadline: 'rc.deadline_date',
  status: 'rc.status',
  assigned: 'assigned_to',
  days_open: 'rc.created_at',
};

export async function caseQueue(db: Queryable, s: Scope, f: QueueFilters) {
  const params: unknown[] = [s.tenantId, s.clientIds];
  const where: string[] = [
    'rc.tenant_id = $1', 'rc.client_id = ANY($2)', 'rc.deleted_at IS NULL',
  ];

  if (f.status && f.status !== 'all') {
    params.push(f.status); where.push(`rc.status = $${params.length}`);
  } else if (!f.status) {
    params.push(OPEN_STATUSES); where.push(`rc.status = ANY($${params.length})`);
  }
  if (f.priority) { params.push(f.priority); where.push(`rc.priority_level = $${params.length}`); }
  if (f.payerId) { params.push(f.payerId); where.push(`cl.payer_id = $${params.length}`); }
  if (f.category) {
    params.push(f.category);
    where.push(`COALESCE(rc.denial_category, rc.case_type::text) = $${params.length}`);
  }
  if (f.assignedTo === 'unassigned') where.push('rc.assigned_to_user_id IS NULL');
  else if (f.assignedTo) { params.push(f.assignedTo); where.push(`rc.assigned_to_user_id = $${params.length}`); }
  if (f.dosFrom) { params.push(f.dosFrom); where.push(`e.date_of_service_start >= $${params.length}`); }
  if (f.dosTo) { params.push(f.dosTo); where.push(`e.date_of_service_start <= $${params.length}`); }
  if (f.deadlineFrom) { params.push(f.deadlineFrom); where.push(`rc.deadline_date >= $${params.length}`); }
  if (f.deadlineTo) { params.push(f.deadlineTo); where.push(`rc.deadline_date <= $${params.length}`); }
  if (f.amountMin) { params.push(f.amountMin); where.push(`rc.recovery_opportunity >= $${params.length}`); }
  if (f.amountMax) { params.push(f.amountMax); where.push(`rc.recovery_opportunity <= $${params.length}`); }

  const sortCol = QUEUE_SORTS[f.sort ?? ''] ?? 'rc.priority_level';
  let dir = f.dir === 'desc' ? 'DESC' : 'ASC';
  if (f.sort === 'days_open') dir = dir === 'ASC' ? 'DESC' : 'ASC'; // days open inverts created_at

  const rows = await db.query(
    `SELECT rc.case_id, rc.priority_level, rc.status, rc.case_type,
            COALESCE(rc.denial_category, rc.case_type::text) AS denial_category,
            rc.denial_reason_code, rc.recovery_opportunity, rc.deadline_date,
            rc.created_at, rc.assigned_to_user_id,
            TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS assigned_to,
            pat.first_name || ' ' || pat.last_name AS patient_name,
            py.payer_name, e.date_of_service_start AS dos,
            COALESCE(target_line.procedure_code, first_line.procedure_code) AS procedure_code,
            (CURRENT_DATE - rc.created_at::date)::int AS days_open
     FROM recovery_case rc
     JOIN claim cl ON cl.claim_id = rc.claim_id
     JOIN encounter e ON e.encounter_id = cl.encounter_id
     JOIN patient pat ON pat.patient_id = e.patient_id
     JOIN payer py ON py.payer_id = cl.payer_id
     LEFT JOIN app_user u ON u.user_id = rc.assigned_to_user_id
     LEFT JOIN claim_line target_line ON target_line.claim_line_id = rc.claim_line_id
     LEFT JOIN LATERAL (
       SELECT procedure_code FROM claim_line
       WHERE claim_id = cl.claim_id AND deleted_at IS NULL
       ORDER BY line_number LIMIT 1
     ) first_line ON true
     WHERE ${where.join(' AND ')}
     ORDER BY ${sortCol} ${dir} NULLS LAST, rc.deadline_date ASC NULLS LAST
     LIMIT 500`,
    params,
  );

  return rows.rows.map((r) => ({
    caseId: r.case_id,
    priority: r.priority_level,
    status: r.status,
    caseType: r.case_type,
    category: r.denial_category,
    denialCode: r.denial_reason_code,
    patientName: r.patient_name,
    payerName: r.payer_name,
    dos: iso(r.dos),
    procedureCode: r.procedure_code,
    amount: num(r.recovery_opportunity),
    deadline: iso(r.deadline_date),
    assignedToId: r.assigned_to_user_id,
    assignedTo: r.assigned_to || null,
    daysOpen: r.days_open,
  }));
}

// ---------------------------------------------------------------------------
// CASE DETAIL
// ---------------------------------------------------------------------------

export async function caseDetail(db: Queryable, s: Scope, caseId: UUID) {
  const c = await db.query(
    `SELECT rc.*, cl.claim_number_internal, cl.claim_number_payer, cl.submission_date,
            cl.billed_amount AS claim_billed, cl.claim_status, cl.payer_id,
            e.date_of_service_start, e.authorization_number,
            pat.patient_id, pat.first_name, pat.last_name, pat.dob, pat.mrn,
            pat.insurance_id_primary,
            py.payer_name, py.payer_type, py.portal_url, py.appeal_address,
            py.appeal_deadline_days, py.timely_filing_limit_days,
            TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS assigned_to
     FROM recovery_case rc
     JOIN claim cl ON cl.claim_id = rc.claim_id
     JOIN encounter e ON e.encounter_id = cl.encounter_id
     JOIN patient pat ON pat.patient_id = e.patient_id
     JOIN payer py ON py.payer_id = cl.payer_id
     LEFT JOIN app_user u ON u.user_id = rc.assigned_to_user_id
     WHERE rc.case_id = $1 AND rc.tenant_id = $2 AND rc.client_id = ANY($3)
       AND rc.deleted_at IS NULL`,
    [caseId, s.tenantId, s.clientIds],
  );
  if (!c.rows[0]) return null;
  const r = c.rows[0];

  const lines = await db.query(
    `SELECT claim_line_id, line_number, procedure_code,
            modifier_1, modifier_2, modifier_3, modifier_4, units,
            billed_amount, expected_amount, expected_source, paid_amount,
            denial_reason_code, denial_reason_description, line_status
     FROM claim_line WHERE claim_id = $1 AND deleted_at IS NULL ORDER BY line_number`,
    [r.claim_id],
  );

  const remits = await db.query(
    `SELECT rl.procedure_code, rl.billed_amount, rl.allowed_amount, rl.paid_amount,
            rl.patient_responsibility, rl.adjustment_group_code, rl.adjustment_reason_code,
            rl.remark_code, r2.check_date, r2.check_number, r2.raw_835_reference
     FROM remittance_line rl JOIN remittance r2 ON r2.remittance_id = rl.remittance_id
     WHERE rl.claim_id = $1 ORDER BY r2.check_date`,
    [r.claim_id],
  );

  const packets = await db.query(
    `SELECT ap.packet_id, ap.packet_status, ap.appeal_type, ap.submission_method,
            ap.auto_submit, ap.needs_review, ap.needs_review_reasons,
            ap.missing_document_types, ap.letter_document_id, ap.submitted_at,
            ap.payer_reference_number, ap.created_at
     FROM appeal_packet ap
     WHERE ap.case_id = $1 AND ap.deleted_at IS NULL
     ORDER BY ap.created_at DESC`,
    [caseId],
  );
  const packet = packets.rows[0] ?? null;

  const docs = packet ? await db.query(
    `SELECT d.document_id, d.document_type, d.file_name, d.source, apd.sort_order
     FROM appeal_packet_document apd JOIN document d ON d.document_id = apd.document_id
     WHERE apd.packet_id = $1 ORDER BY apd.sort_order`,
    [packet.packet_id],
  ) : { rows: [] };

  const timeline = await db.query(
    `SELECT ca.action_id, ca.action_type, ca.action_date, ca.notes,
            ca.performed_by_system, ca.related_document_id,
            TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS user_name
     FROM case_action ca LEFT JOIN app_user u ON u.user_id = ca.performed_by_user_id
     WHERE ca.case_id = $1 ORDER BY ca.action_date ASC`,
    [caseId],
  );

  const correction = await db.query(
    `SELECT corrected_claim_id, original_fields, corrected_fields, correction_reason,
            confidence_score, needs_manual_review, status
     FROM corrected_claim WHERE case_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [caseId],
  );

  return {
    case: {
      caseId: r.case_id, status: r.status, priority: r.priority_level,
      caseType: r.case_type, category: r.denial_category, denialCode: r.denial_reason_code,
      createdAt: iso(r.created_at), deadline: iso(r.deadline_date), expired: r.expired,
      recoveryOpportunity: num(r.recovery_opportunity),
      expectedAmount: r.expected_amount == null ? null : num(r.expected_amount),
      paidAmount: r.paid_amount == null ? null : num(r.paid_amount),
      confidenceScore: r.confidence_score == null ? null : num(r.confidence_score),
      appealabilityScore: r.appealability_score,
      recommendedAction: r.recommended_action,
      assignedToId: r.assigned_to_user_id, assignedTo: r.assigned_to || null,
      clientId: r.client_id,
    },
    patient: {
      patientId: r.patient_id, name: `${r.first_name} ${r.last_name}`,
      dob: iso(r.dob), mrn: r.mrn, insuranceId: r.insurance_id_primary,
    },
    claim: {
      claimId: r.claim_id, number: r.claim_number_internal, payerNumber: r.claim_number_payer,
      dos: iso(r.date_of_service_start), submissionDate: iso(r.submission_date),
      billed: num(r.claim_billed), status: r.claim_status,
      authorizationNumber: r.authorization_number,
      lines: lines.rows.map((l) => ({
        claimLineId: l.claim_line_id, lineNumber: l.line_number,
        procedureCode: l.procedure_code,
        modifiers: [l.modifier_1, l.modifier_2, l.modifier_3, l.modifier_4].filter(Boolean),
        units: num(l.units), billed: num(l.billed_amount),
        expected: l.expected_amount == null ? null : num(l.expected_amount),
        expectedSource: l.expected_source,
        paid: l.paid_amount == null ? null : num(l.paid_amount),
        variance: l.expected_amount == null ? null
          : Math.round((num(l.expected_amount) - num(l.paid_amount)) * 100) / 100,
        denialCode: l.denial_reason_code, denialDescription: l.denial_reason_description,
        lineStatus: l.line_status,
      })),
    },
    payer: {
      payerId: r.payer_id, name: r.payer_name, type: r.payer_type,
      portalUrl: r.portal_url, appealAddress: r.appeal_address,
      appealDeadlineDays: r.appeal_deadline_days,
    },
    remitLines: remits.rows.map((x) => ({
      procedureCode: x.procedure_code,
      billed: x.billed_amount == null ? null : num(x.billed_amount),
      allowed: x.allowed_amount == null ? null : num(x.allowed_amount),
      paid: x.paid_amount == null ? null : num(x.paid_amount),
      patientResp: x.patient_responsibility == null ? null : num(x.patient_responsibility),
      adjustment: x.adjustment_reason_code
        ? `${x.adjustment_group_code ?? ''}-${x.adjustment_reason_code}` : null,
      remarkCode: x.remark_code,
      checkDate: iso(x.check_date), checkNumber: x.check_number,
      raw835: x.raw_835_reference,
    })),
    packet: packet ? {
      packetId: packet.packet_id, status: packet.packet_status,
      appealType: packet.appeal_type, submissionMethod: packet.submission_method,
      autoSubmit: packet.auto_submit, needsReview: packet.needs_review,
      needsReviewReasons: packet.needs_review_reasons ?? [],
      missingDocumentTypes: packet.missing_document_types ?? [],
      letterDocumentId: packet.letter_document_id,
      submittedAt: packet.submitted_at ? String(packet.submitted_at) : null,
      payerReference: packet.payer_reference_number,
      documents: docs.rows.map((d) => ({
        documentId: d.document_id, documentType: d.document_type,
        fileName: d.file_name, source: d.source,
      })),
      history: packets.rows.slice(0).map((h) => ({
        packetId: h.packet_id, status: h.packet_status, appealType: h.appeal_type,
        submittedAt: h.submitted_at ? String(h.submitted_at) : null,
        createdAt: iso(h.created_at),
      })),
    } : null,
    correction: correction.rows[0] ?? null,
    timeline: timeline.rows.map((a) => ({
      actionId: a.action_id, actionType: a.action_type,
      date: a.action_date instanceof Date ? a.action_date.toISOString() : String(a.action_date),
      by: a.performed_by_system ? 'System' : (a.user_name || 'Unknown'),
      notes: a.notes, relatedDocumentId: a.related_document_id,
    })),
  };
}

// ---------------------------------------------------------------------------
// lookups (filter dropdowns, assign lists, builder)
// ---------------------------------------------------------------------------

export async function lookups(db: Queryable, s: Scope) {
  const payers = await db.query(
    `SELECT DISTINCT py.payer_id, py.payer_name
     FROM payer py JOIN claim cl ON cl.payer_id = py.payer_id
     WHERE cl.tenant_id = $1 AND cl.client_id = ANY($2)
     ORDER BY py.payer_name`, [s.tenantId, s.clientIds]);
  const users = await db.query(
    `SELECT user_id, TRIM(first_name || ' ' || last_name) AS name, role
     FROM app_user WHERE tenant_id = $1 AND status = 'active' AND deleted_at IS NULL
     ORDER BY name`, [s.tenantId]);
  const categories = await db.query(
    `SELECT DISTINCT COALESCE(denial_category, case_type::text) AS category
     FROM recovery_case WHERE tenant_id = $1 AND client_id = ANY($2) ORDER BY 1`,
    [s.tenantId, s.clientIds]);
  return {
    payers: payers.rows.map((r) => ({ id: r.payer_id, name: r.payer_name })),
    users: users.rows.map((r) => ({ id: r.user_id, name: r.name, role: r.role })),
    categories: categories.rows.map((r) => r.category),
    statuses: [...OPEN_STATUSES, 'won', 'lost', 'closed_no_action'],
    priorities: ['critical', 'high', 'medium', 'low'],
  };
}

export async function searchClaims(db: Queryable, s: Scope, q: string) {
  const like = `%${q}%`;
  const rows = await db.query(
    `SELECT cl.claim_id, cl.claim_number_internal, cl.claim_number_payer,
            cl.billed_amount, cl.claim_status, e.date_of_service_start AS dos,
            pat.first_name || ' ' || pat.last_name AS patient_name,
            py.payer_name, py.payer_id,
            EXISTS (SELECT 1 FROM recovery_case rc WHERE rc.claim_id = cl.claim_id
                    AND rc.deleted_at IS NULL AND rc.status = ANY($4)) AS has_open_case
     FROM claim cl
     JOIN encounter e ON e.encounter_id = cl.encounter_id
     JOIN patient pat ON pat.patient_id = e.patient_id
     JOIN payer py ON py.payer_id = cl.payer_id
     WHERE cl.tenant_id = $1 AND cl.client_id = ANY($2) AND cl.deleted_at IS NULL
       AND (cl.claim_number_internal ILIKE $3 OR cl.claim_number_payer ILIKE $3
            OR pat.first_name ILIKE $3 OR pat.last_name ILIKE $3
            OR pat.first_name || ' ' || pat.last_name ILIKE $3
            OR e.date_of_service_start::text = $5)
     ORDER BY e.date_of_service_start DESC LIMIT 25`,
    [s.tenantId, s.clientIds, like, OPEN_STATUSES, q.trim()],
  );
  return rows.rows.map((r) => ({
    claimId: r.claim_id, number: r.claim_number_internal, payerNumber: r.claim_number_payer,
    billed: num(r.billed_amount), status: r.claim_status, dos: iso(r.dos),
    patientName: r.patient_name, payerName: r.payer_name, payerId: r.payer_id,
    hasOpenCase: r.has_open_case,
  }));
}

export async function claimForBuilder(db: Queryable, s: Scope, claimId: UUID) {
  const rows = await db.query(
    `SELECT cl.claim_id, cl.client_id, cl.claim_number_internal, cl.billed_amount,
            cl.claim_status, cl.payer_id, py.payer_name, py.appeal_deadline_days,
            e.date_of_service_start AS dos,
            pat.first_name || ' ' || pat.last_name AS patient_name
     FROM claim cl
     JOIN encounter e ON e.encounter_id = cl.encounter_id
     JOIN patient pat ON pat.patient_id = e.patient_id
     JOIN payer py ON py.payer_id = cl.payer_id
     WHERE cl.claim_id = $1 AND cl.tenant_id = $2 AND cl.client_id = ANY($3)`,
    [claimId, s.tenantId, s.clientIds],
  );
  if (!rows.rows[0]) return null;
  const r = rows.rows[0];
  const lines = await db.query(
    `SELECT claim_line_id, line_number, procedure_code, billed_amount,
            expected_amount, paid_amount, denial_reason_code
     FROM claim_line WHERE claim_id = $1 AND deleted_at IS NULL ORDER BY line_number`,
    [claimId],
  );
  return {
    claimId: r.claim_id, clientId: r.client_id, number: r.claim_number_internal,
    billed: num(r.billed_amount), status: r.claim_status, dos: iso(r.dos),
    patientName: r.patient_name, payerId: r.payer_id, payerName: r.payer_name,
    appealDeadlineDays: r.appeal_deadline_days,
    lines: lines.rows.map((l) => ({
      claimLineId: l.claim_line_id, lineNumber: l.line_number,
      procedureCode: l.procedure_code, billed: num(l.billed_amount),
      expected: l.expected_amount == null ? null : num(l.expected_amount),
      paid: l.paid_amount == null ? null : num(l.paid_amount),
      denialCode: l.denial_reason_code,
    })),
  };
}
