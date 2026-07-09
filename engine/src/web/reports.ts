// ============================================================================
// Report queries: payer performance, denial analytics, payment
// reconciliation, team workload.
// ============================================================================

import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';
import type { Scope } from './queries.ts';

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

// ---------------------------------------------------------------------------
// PAYER PERFORMANCE
// ---------------------------------------------------------------------------

export async function payerPerformance(db: Queryable, s: Scope) {
  const claims = await db.query(
    `SELECT cl.payer_id, py.payer_name,
            count(DISTINCT cl.claim_id)::int AS claims_submitted,
            COALESCE(sum(l.expected_amount), 0) AS expected,
            COALESCE(sum(l.paid_amount), 0) AS paid,
            COALESCE(sum(l.billed_amount), 0) AS billed
     FROM claim cl
     JOIN payer py ON py.payer_id = cl.payer_id
     LEFT JOIN claim_line l ON l.claim_id = cl.claim_id AND l.deleted_at IS NULL
     WHERE cl.tenant_id = $1 AND cl.client_id = ANY($2) AND cl.deleted_at IS NULL
     GROUP BY cl.payer_id, py.payer_name`,
    [s.tenantId, s.clientIds]);

  const daysToPay = await db.query(
    `SELECT cl.payer_id, avg(r.check_date - cl.submission_date) AS avg_days
     FROM remittance_line rl
     JOIN remittance r ON r.remittance_id = rl.remittance_id
     JOIN claim cl ON cl.claim_id = rl.claim_id
     WHERE cl.tenant_id = $1 AND cl.client_id = ANY($2)
       AND r.check_date IS NOT NULL AND cl.submission_date IS NOT NULL
     GROUP BY cl.payer_id`,
    [s.tenantId, s.clientIds]);

  const denials = await db.query(
    `SELECT cl.payer_id, COALESCE(rc.denial_category, rc.case_type::text) AS category,
            count(*)::int AS n
     FROM recovery_case rc JOIN claim cl ON cl.claim_id = rc.claim_id
     WHERE rc.tenant_id = $1 AND rc.client_id = ANY($2) AND rc.deleted_at IS NULL
     GROUP BY 1, 2`,
    [s.tenantId, s.clientIds]);

  const appeals = await db.query(
    `SELECT cl.payer_id,
            count(*) FILTER (WHERE ap.submitted_at IS NOT NULL)::int AS submitted,
            count(DISTINCT rc.case_id) FILTER (WHERE rc.status = 'won')::int AS won,
            count(DISTINCT rc.case_id) FILTER (WHERE rc.status IN ('won','lost'))::int AS resolved
     FROM recovery_case rc
     JOIN claim cl ON cl.claim_id = rc.claim_id
     LEFT JOIN appeal_packet ap ON ap.case_id = rc.case_id AND ap.deleted_at IS NULL
     WHERE rc.tenant_id = $1 AND rc.client_id = ANY($2)
     GROUP BY cl.payer_id`,
    [s.tenantId, s.clientIds]);

  const recovered = await db.query(
    `SELECT cl.payer_id, COALESCE(sum(pe.amount_recovered), 0) AS recovered
     FROM payment_event pe JOIN claim cl ON cl.claim_id = pe.claim_id
     WHERE pe.tenant_id = $1 AND cl.client_id = ANY($2)
     GROUP BY cl.payer_id`,
    [s.tenantId, s.clientIds]);

  const trend = await db.query(
    `SELECT cl.payer_id, date_trunc('month', r.check_date)::date AS month,
            COALESCE(sum(rl.paid_amount), 0) AS paid
     FROM remittance_line rl
     JOIN remittance r ON r.remittance_id = rl.remittance_id
     JOIN claim cl ON cl.claim_id = rl.claim_id
     WHERE cl.tenant_id = $1 AND cl.client_id = ANY($2) AND r.check_date IS NOT NULL
     GROUP BY 1, 2 ORDER BY 2`,
    [s.tenantId, s.clientIds]);

  const byId = <T extends { payer_id: string }>(rows: T[]) =>
    new Map(rows.map((r) => [r.payer_id, r]));
  const dMap = byId(daysToPay.rows);
  const aMap = byId(appeals.rows);
  const rMap = byId(recovered.rows);

  return claims.rows.map((c) => {
    const expected = num(c.expected);
    const paid = num(c.paid);
    const a = aMap.get(c.payer_id);
    const catRows = denials.rows.filter((d) => d.payer_id === c.payer_id);
    const totalCases = catRows.reduce((x, d) => x + d.n, 0);
    return {
      payerId: c.payer_id,
      payerName: c.payer_name,
      claimsSubmitted: c.claims_submitted,
      billed: r2(num(c.billed)),
      expected: r2(expected),
      paid: r2(paid),
      variance: r2(expected - paid),
      variancePct: expected > 0 ? r2(((expected - paid) / expected) * 100) : 0,
      denialRateByCategory: catRows.map((d) => ({
        category: d.category, count: d.n,
        pct: c.claims_submitted > 0 ? r2((d.n / c.claims_submitted) * 100) : 0,
      })),
      totalCases,
      avgDaysToPay: dMap.get(c.payer_id) ? r2(num((dMap.get(c.payer_id) as any).avg_days)) : null,
      appealsSubmitted: a?.submitted ?? 0,
      appealsWon: a?.won ?? 0,
      wonRate: a && a.resolved > 0 ? r2((a.won / a.resolved) * 100) : null,
      totalRecovered: r2(num(rMap.get(c.payer_id)?.recovered)),
      monthTrend: trend.rows
        .filter((t) => t.payer_id === c.payer_id)
        .map((t) => ({ month: iso(t.month), paid: r2(num(t.paid)) })),
    };
  }).sort((a, b) => b.variance - a.variance);
}

export async function payerClaimDrilldown(db: Queryable, s: Scope, payerId: UUID) {
  const rows = await db.query(
    `SELECT cl.claim_id, cl.claim_number_internal, cl.claim_status,
            e.date_of_service_start AS dos,
            pat.first_name || ' ' || pat.last_name AS patient_name,
            COALESCE(sum(l.billed_amount), 0) AS billed,
            COALESCE(sum(l.expected_amount), 0) AS expected,
            COALESCE(sum(l.paid_amount), 0) AS paid,
            count(rc.case_id)::int AS cases
     FROM claim cl
     JOIN encounter e ON e.encounter_id = cl.encounter_id
     JOIN patient pat ON pat.patient_id = e.patient_id
     LEFT JOIN claim_line l ON l.claim_id = cl.claim_id AND l.deleted_at IS NULL
     LEFT JOIN recovery_case rc ON rc.claim_id = cl.claim_id AND rc.deleted_at IS NULL
     WHERE cl.tenant_id = $1 AND cl.client_id = ANY($2) AND cl.payer_id = $3
       AND cl.deleted_at IS NULL
     GROUP BY cl.claim_id, cl.claim_number_internal, cl.claim_status,
              e.date_of_service_start, patient_name
     ORDER BY e.date_of_service_start DESC LIMIT 200`,
    [s.tenantId, s.clientIds, payerId]);
  return rows.rows.map((r) => ({
    claimId: r.claim_id, number: r.claim_number_internal, status: r.claim_status,
    dos: iso(r.dos), patientName: r.patient_name,
    billed: r2(num(r.billed)), expected: r2(num(r.expected)), paid: r2(num(r.paid)),
    variance: r2(num(r.expected) - num(r.paid)), cases: r.cases,
  }));
}

// ---------------------------------------------------------------------------
// DENIAL ANALYTICS
// ---------------------------------------------------------------------------

/** avoidability + root cause taxonomy per denial category */
export const CATEGORY_CLASSIFICATION: Record<string, { avoidable: string; rootCause: string }> = {
  coding: { avoidable: 'avoidable', rootCause: 'coding_and_billing' },
  bundling: { avoidable: 'partially_avoidable', rootCause: 'coding_and_billing' },
  authorization: { avoidable: 'avoidable', rootCause: 'authorization_workflow' },
  timely_filing: { avoidable: 'avoidable', rootCause: 'billing_process' },
  duplicate: { avoidable: 'avoidable', rootCause: 'billing_process' },
  patient_eligibility: { avoidable: 'avoidable', rootCause: 'front_end_registration' },
  coordination_of_benefits: { avoidable: 'avoidable', rootCause: 'front_end_registration' },
  clinical_medical_necessity: { avoidable: 'partially_avoidable', rootCause: 'clinical_documentation' },
  contractual: { avoidable: 'payer_side', rootCause: 'payer_behavior' },
  underpayment: { avoidable: 'payer_side', rootCause: 'payer_behavior' },
};

export async function denialAnalytics(db: Queryable, s: Scope) {
  const categories = await db.query(
    `SELECT COALESCE(rc.denial_category, rc.case_type::text) AS category,
            count(*)::int AS n, COALESCE(sum(rc.recovery_opportunity), 0) AS amount
     FROM recovery_case rc
     WHERE rc.tenant_id = $1 AND rc.client_id = ANY($2) AND rc.deleted_at IS NULL
     GROUP BY 1 ORDER BY amount DESC`,
    [s.tenantId, s.clientIds]);

  const monthly = await db.query(
    `SELECT date_trunc('month', rc.created_at)::date AS month,
            COALESCE(rc.denial_category, rc.case_type::text) AS category,
            count(*)::int AS n
     FROM recovery_case rc
     WHERE rc.tenant_id = $1 AND rc.client_id = ANY($2) AND rc.deleted_at IS NULL
     GROUP BY 1, 2 ORDER BY 1`,
    [s.tenantId, s.clientIds]);

  const codes = await db.query(
    `SELECT rc.denial_reason_code AS code, count(*)::int AS n,
            COALESCE(sum(rc.recovery_opportunity), 0) AS amount
     FROM recovery_case rc
     WHERE rc.tenant_id = $1 AND rc.client_id = ANY($2) AND rc.deleted_at IS NULL
       AND rc.denial_reason_code IS NOT NULL
     GROUP BY 1 ORDER BY n DESC LIMIT 15`,
    [s.tenantId, s.clientIds]);

  const byProvider = await db.query(
    `SELECT pr.name AS provider_name,
            count(DISTINCT cl.claim_id)::int AS claims,
            count(DISTINCT rc.case_id)::int AS denials
     FROM claim cl
     JOIN encounter e ON e.encounter_id = cl.encounter_id
     JOIN provider pr ON pr.provider_id = e.provider_id
     LEFT JOIN recovery_case rc ON rc.claim_id = cl.claim_id
       AND rc.deleted_at IS NULL AND rc.denial_reason_code IS NOT NULL
     WHERE cl.tenant_id = $1 AND cl.client_id = ANY($2) AND cl.deleted_at IS NULL
     GROUP BY pr.name ORDER BY denials DESC`,
    [s.tenantId, s.clientIds]);

  const byProcedure = await db.query(
    `SELECT l.procedure_code, count(*)::int AS lines,
            count(*) FILTER (WHERE l.denial_reason_code IS NOT NULL)::int AS denied
     FROM claim_line l JOIN claim cl ON cl.claim_id = l.claim_id
     WHERE cl.tenant_id = $1 AND cl.client_id = ANY($2) AND l.deleted_at IS NULL
     GROUP BY 1 HAVING count(*) FILTER (WHERE l.denial_reason_code IS NOT NULL) > 0
     ORDER BY denied DESC LIMIT 15`,
    [s.tenantId, s.clientIds]);

  const classify = (category: string) =>
    CATEGORY_CLASSIFICATION[category] ?? { avoidable: 'unclassified', rootCause: 'other' };

  const avoidability = new Map<string, { count: number; amount: number }>();
  const rootCauses = new Map<string, { count: number; amount: number }>();
  for (const c of categories.rows) {
    const cls = classify(c.category);
    for (const [map, key] of [[avoidability, cls.avoidable], [rootCauses, cls.rootCause]] as const) {
      const agg = map.get(key) ?? { count: 0, amount: 0 };
      agg.count += c.n;
      agg.amount = r2(agg.amount + num(c.amount));
      map.set(key, agg);
    }
  }

  return {
    categories: categories.rows.map((c) => ({
      category: c.category, count: c.n, amount: r2(num(c.amount)),
      ...classify(c.category),
    })),
    monthlyTrend: monthly.rows.map((m) => ({
      month: iso(m.month), category: m.category, count: m.n,
    })),
    topCodes: codes.rows.map((c) => ({
      code: c.code, count: c.n, amount: r2(num(c.amount)),
    })),
    byProvider: byProvider.rows.map((p) => ({
      provider: p.provider_name, claims: p.claims, denials: p.denials,
      rate: p.claims > 0 ? r2((p.denials / p.claims) * 100) : 0,
    })),
    byProcedure: byProcedure.rows.map((p) => ({
      procedureCode: p.procedure_code, lines: p.lines, denied: p.denied,
      rate: p.lines > 0 ? r2((p.denied / p.lines) * 100) : 0,
    })),
    avoidability: [...avoidability].map(([k, v]) => ({ classification: k, ...v })),
    rootCauses: [...rootCauses].map(([k, v]) => ({ rootCause: k, ...v })),
  };
}

// ---------------------------------------------------------------------------
// PAYMENT RECONCILIATION
// ---------------------------------------------------------------------------

export async function reconciliation(db: Queryable, s: Scope, periodDays = 30) {
  // remits received on a claim after its appeal went out
  const postAppeal = await db.query(
    `SELECT DISTINCT ON (rl.remittance_line_id)
            rc.case_id, rl.remittance_line_id, rl.remittance_id, rl.paid_amount,
            r.check_date, r.check_number, ap.submitted_at,
            cl.claim_number_internal, rc.recovery_opportunity,
            pat.first_name || ' ' || pat.last_name AS patient_name,
            py.payer_name,
            EXISTS (SELECT 1 FROM payment_event pe WHERE pe.case_id = rc.case_id) AS matched
     FROM recovery_case rc
     JOIN appeal_packet ap ON ap.case_id = rc.case_id
       AND ap.submitted_at IS NOT NULL AND ap.deleted_at IS NULL
     JOIN claim cl ON cl.claim_id = rc.claim_id
     JOIN encounter e ON e.encounter_id = cl.encounter_id
     JOIN patient pat ON pat.patient_id = e.patient_id
     JOIN payer py ON py.payer_id = cl.payer_id
     JOIN remittance_line rl ON rl.claim_id = rc.claim_id
     JOIN remittance r ON r.remittance_id = rl.remittance_id
     WHERE rc.tenant_id = $1 AND rc.client_id = ANY($2)
       AND r.created_at > ap.submitted_at
     ORDER BY rl.remittance_line_id, r.check_date DESC`,
    [s.tenantId, s.clientIds]);

  const matched = await db.query(
    `SELECT pe.payment_event_id, pe.case_id, pe.amount_recovered, pe.payment_date,
            pe.matched_automatically, pe.notes,
            TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS verified_by,
            cl.claim_number_internal, py.payer_name,
            pat.first_name || ' ' || pat.last_name AS patient_name,
            COALESCE(rc.denial_category, rc.case_type::text) AS category
     FROM payment_event pe
     JOIN recovery_case rc ON rc.case_id = pe.case_id
     JOIN claim cl ON cl.claim_id = pe.claim_id
     JOIN encounter e ON e.encounter_id = cl.encounter_id
     JOIN patient pat ON pat.patient_id = e.patient_id
     JOIN payer py ON py.payer_id = cl.payer_id
     LEFT JOIN app_user u ON u.user_id = pe.verified_by_user_id
     WHERE pe.tenant_id = $1 AND rc.client_id = ANY($2)
       AND pe.payment_date >= CURRENT_DATE - $3::int
     ORDER BY pe.payment_date DESC`,
    [s.tenantId, s.clientIds, periodDays]);

  const rates = await db.query(
    `SELECT COALESCE(rc.denial_category, rc.case_type::text) AS category,
            COALESCE(sum(rc.recovery_opportunity), 0) AS identified,
            COALESCE(sum(pe.amount_recovered), 0) AS recovered
     FROM recovery_case rc
     LEFT JOIN payment_event pe ON pe.case_id = rc.case_id
     WHERE rc.tenant_id = $1 AND rc.client_id = ANY($2) AND rc.deleted_at IS NULL
     GROUP BY 1 ORDER BY identified DESC`,
    [s.tenantId, s.clientIds]);

  const rows = postAppeal.rows.map((r) => ({
    caseId: r.case_id, remittanceLineId: r.remittance_line_id,
    remittanceId: r.remittance_id,
    claimNumber: r.claim_number_internal, patientName: r.patient_name,
    payerName: r.payer_name, paid: num(r.paid_amount),
    checkDate: iso(r.check_date), checkNumber: r.check_number,
    appealSubmittedAt: iso(r.submitted_at),
    recoveryOpportunity: num(r.recovery_opportunity),
    matched: r.matched,
  }));

  return {
    postAppealRemits: rows,
    autoMatched: matched.rows.filter((m) => m.matched_automatically).map(mapEvent),
    manualMatched: matched.rows.filter((m) => !m.matched_automatically).map(mapEvent),
    unmatched: rows.filter((r) => !r.matched && r.paid > 0),
    totalRecovered: r2(matched.rows.reduce((x, m) => x + num(m.amount_recovered), 0)),
    periodDays,
    recoveryRateByCategory: rates.rows.map((r) => ({
      category: r.category,
      identified: r2(num(r.identified)),
      recovered: r2(num(r.recovered)),
      rate: num(r.identified) > 0 ? r2((num(r.recovered) / num(r.identified)) * 100) : 0,
    })),
  };

  function mapEvent(m: any) {
    return {
      paymentEventId: m.payment_event_id, caseId: m.case_id,
      amount: num(m.amount_recovered), date: iso(m.payment_date),
      claimNumber: m.claim_number_internal, patientName: m.patient_name,
      payerName: m.payer_name, category: m.category,
      verifiedBy: m.verified_by || null, notes: m.notes,
    };
  }
}

// ---------------------------------------------------------------------------
// TEAM WORKLOAD
// ---------------------------------------------------------------------------

export async function teamWorkload(db: Queryable, s: Scope) {
  const byAssignee = await db.query(
    `SELECT u.user_id, TRIM(u.first_name || ' ' || u.last_name) AS name, u.role,
            count(rc.case_id)::int AS open_cases,
            COALESCE(sum(rc.recovery_opportunity), 0) AS open_amount,
            count(rc.case_id) FILTER (WHERE rc.deadline_date < CURRENT_DATE)::int AS overdue,
            count(rc.case_id) FILTER (WHERE EXISTS (
              SELECT 1 FROM case_action ca WHERE ca.case_id = rc.case_id
                AND ca.performed_by_user_id = u.user_id
                AND ca.action_date >= CURRENT_DATE - 7))::int AS touched_7d
     FROM app_user u
     LEFT JOIN recovery_case rc ON rc.assigned_to_user_id = u.user_id
       AND rc.deleted_at IS NULL AND rc.status = ANY($3) AND rc.client_id = ANY($2)
     WHERE u.tenant_id = $1 AND u.status = 'active' AND u.deleted_at IS NULL
     GROUP BY u.user_id, name, u.role ORDER BY open_amount DESC`,
    [s.tenantId, s.clientIds, OPEN_STATUSES_LOCAL]);

  const actionsThisWeek = await db.query(
    `SELECT ca.performed_by_user_id AS user_id, count(*)::int AS n
     FROM case_action ca JOIN recovery_case rc ON rc.case_id = ca.case_id
     WHERE ca.tenant_id = $1 AND rc.client_id = ANY($2)
       AND ca.performed_by_user_id IS NOT NULL
       AND ca.action_date >= date_trunc('week', CURRENT_DATE)
     GROUP BY 1`,
    [s.tenantId, s.clientIds]);

  const trend = await db.query(
    `SELECT ca.performed_by_user_id AS user_id,
            date_trunc('week', ca.action_date)::date AS week, count(*)::int AS n
     FROM case_action ca JOIN recovery_case rc ON rc.case_id = ca.case_id
     WHERE ca.tenant_id = $1 AND rc.client_id = ANY($2)
       AND ca.performed_by_user_id IS NOT NULL
       AND ca.action_date >= CURRENT_DATE - 56
     GROUP BY 1, 2 ORDER BY 2`,
    [s.tenantId, s.clientIds]);

  const weekActions = new Map(actionsThisWeek.rows.map((r) => [r.user_id, r.n]));

  return {
    users: byAssignee.rows.map((u) => ({
      userId: u.user_id, name: u.name, role: u.role,
      openCases: u.open_cases, openAmount: r2(num(u.open_amount)),
      overdue: u.overdue,
      actionsThisWeek: weekActions.get(u.user_id) ?? 0,
      // SLA: share of open assigned cases the user touched in the last 7 days
      slaCompliancePct: u.open_cases > 0 ? r2((u.touched_7d / u.open_cases) * 100) : null,
      trend: trend.rows.filter((t) => t.user_id === u.user_id)
        .map((t) => ({ week: iso(t.week), actions: t.n })),
    })),
  };
}
const OPEN_STATUSES_LOCAL = ['open', 'in_progress', 'submitted', 'pending_payer'];
