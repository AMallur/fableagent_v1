// ============================================================================
// Demo/dev seed: provisions a tenant with users (password: demo1234), payers,
// contracts, and ~3 months of claims + remittances with a realistic denial
// mix, then runs the REAL detection and appeal-generation pipelines, then
// simulates team activity (assignments, submissions, wins, payments) so every
// screen of the interface has live data.
//
//   DATABASE_URL=postgres://... node scripts/seed_demo.ts
//
// Idempotent: re-running clears the tenant's claims/cases/appeals data and
// resets the tenant/client/users in place (upsert, not delete-and-recreate —
// audit_log is immutable and FK-references both, so those two can never be
// hard-deleted once any audit history exists for them) and regenerates
// everything else fresh. Requires no special database privileges — works
// against a plain, non-superuser application role (e.g. Cloud SQL).
// ============================================================================

import { hashPassword } from '../src/web/auth.ts';
import { runDetectionJob } from '../src/service.ts';
import { generateAppealPackets } from '../src/appeals/service.ts';
import { FileSystemDocumentStore } from '../src/appeals/storage.ts';

const { default: pg } = await import('pg');
const { pgSslConfig } = await import('../src/web/db_ssl.ts');
const { readFileSync } = await import('node:fs');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/rcm_dev',
  ssl: pgSslConfig(readFileSync),
});

const T = 'de300000-0000-4000-8000-000000000001';
const C = 'de300000-0000-4000-8000-000000000002';

const PASSWORD = hashPassword('demo1234');
const USERS = [
  ['admin@meridianrcm.com', 'Maya', 'Admin', 'tenant_admin'],
  ['sarah@meridianrcm.com', 'Sarah', 'Biller', 'biller'],
  ['colin@meridianrcm.com', 'Colin', 'Collector', 'collector'],
] as const;
const DEMO_EMAILS = USERS.map((u) => u[0]);

// One dedicated connection for the whole script (not pool.query() per call,
// which hands back a random connection each time) — RLS needs
// app.current_tenant_id set on the SAME connection every statement runs on.
// Session-scoped (is_local=false), not transaction-scoped: each q() call
// below auto-commits individually, same as the original pool.query() calls
// did, which matters because runDetectionJob()/generateAppealPackets() read
// this data back over their own separate connections partway through.
const client = await pool.connect();
await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [T]);
const q = (text: string, p?: unknown[]) => client.query(text, p);

// deterministic PRNG so re-seeds are comparable
let rngState = 42;
const rnd = () => (rngState = (rngState * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pickFrom = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
const randInt = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const TODAY = new Date();
const dayISO = (offset: number) => {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

console.log('cleaning previous demo tenant…');
// audit_log is append-only at the database level (trg_audit_log_immutable
// blocks DELETE/UPDATE even for the table owner — real safeguard, verified
// elsewhere) and it FK-references both tenant and app_user, so those two
// (and client, for the same "stable ID across reseeds" reason) can never be
// hard-deleted-and-recreated once any audit history points at them — only
// upserted in place, below. This also means every DELETE below now runs
// under REAL foreign-key enforcement (no session_replication_role bypass),
// so it has to be genuine dependency order, not just "worked because
// triggers were off."
for (const table of [
  'onboarding_step', 'client_integration', 'sso_config', 'data_export_request', 'invoice',
  'rule_execution', 'automation_rule', 'notification_preference', 'notification',
  'email_outbox', 'dashboard_snapshot',
  // outbound_delivery/appeal_packet_document/case_action/payment_event/
  // corrected_claim all reference recovery_case (some also reference
  // appeal_packet, document, remittance, claim, claim_line) — all must go
  // before their referenced parent. appeal_packet itself references
  // document (letter_document_id), so it has to go before document too,
  // even though appeal_packet_document (which references BOTH) has to go
  // before appeal_packet.
  'outbound_delivery', 'appeal_packet_document', 'case_action', 'appeal_packet',
  'document', 'payment_event', 'corrected_claim', 'recovery_case',
  'remittance_line', 'remittance',
  'claim_line', 'claim', 'encounter', 'patient', 'client_payer_config',
  'contract_line', 'contract', 'provider', 'system_job',
]) await q(`DELETE FROM ${table} WHERE tenant_id = $1`, [T]);
await q(`DELETE FROM payer WHERE tenant_id = $1 OR payer_id_code LIKE 'DEMO%'`, [T]);
await q(`DELETE FROM medicare_fee_schedule WHERE locality = 'DEMO'`);
// other clients/users under this tenant (e.g. test-created via the real
// admin API, which doesn't clean up after itself — it relies on this reset)
// besides the known demo ones. client has no incoming FK from audit_log, so
// it's safe to hard-delete; app_user does, so it's soft-deleted instead —
// same reasoning as the tenant/client/app_user upserts above. Users first,
// clearing client_id: app_user.client_id is a real FK to client, so a
// stray user still pointing at a to-be-deleted client would block it even
// once soft-deleted (the row, and its FK value, still exists either way).
await q(`UPDATE app_user SET deleted_at = now(), status = 'inactive', client_id = NULL
         WHERE tenant_id = $1 AND email <> ALL($2) AND deleted_at IS NULL`,
  [T, DEMO_EMAILS]);
await q(`DELETE FROM client WHERE tenant_id = $1 AND client_id <> $2`, [T, C]);

console.log('creating tenant, client, users, payers, contracts…');
// enforce_mfa=false is a demo convenience — production tenants default to
// MFA-enforced for admin roles (the admin test suite proves that flow)
await q(`INSERT INTO tenant (tenant_id, tenant_name, tenant_type, subscription_tier, enforce_mfa)
         VALUES ($1, 'Meridian RCM Partners', 'billing_company', 'professional', false)
         ON CONFLICT (tenant_id) DO UPDATE SET
           tenant_name = EXCLUDED.tenant_name, tenant_type = EXCLUDED.tenant_type,
           subscription_tier = EXCLUDED.subscription_tier, enforce_mfa = EXCLUDED.enforce_mfa,
           status = 'active', deleted_at = NULL, updated_at = now()`, [T]);
await q(`INSERT INTO client (client_id, tenant_id, client_name, tax_id, npi_group, specialty, state,
                             address, recovery_alert_threshold, appeal_review_threshold)
         VALUES ($1, $2, 'Alpha Orthopedic Group', '74-1234567', '1234567890', 'orthopedics', 'TX',
                 '{"line1":"100 Main St, Suite 400","city":"Austin","state":"TX","zip":"78701"}',
                 25000, 4000)
         ON CONFLICT (client_id) DO UPDATE SET
           client_name = EXCLUDED.client_name, tax_id = EXCLUDED.tax_id, npi_group = EXCLUDED.npi_group,
           specialty = EXCLUDED.specialty, state = EXCLUDED.state, address = EXCLUDED.address,
           recovery_alert_threshold = EXCLUDED.recovery_alert_threshold,
           appeal_review_threshold = EXCLUDED.appeal_review_threshold,
           status = 'active', deleted_at = NULL, updated_at = now()`, [C, T]);

const userIds: string[] = [];
for (const [email, first, last, role] of USERS) {
  const r = await q(
    `INSERT INTO app_user (tenant_id, email, first_name, last_name, role, password_hash,
                           mfa_enabled, password_changed_at)
     VALUES ($1, $2, $3, $4, $5, $6, false, now())
     ON CONFLICT (tenant_id, email) WHERE deleted_at IS NULL DO UPDATE SET
       first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, role = EXCLUDED.role,
       password_hash = EXCLUDED.password_hash, mfa_enabled = false, password_changed_at = now(),
       client_id = NULL, status = 'active', failed_login_attempts = 0, locked_until = NULL,
       mfa_secret = NULL, invite_token = NULL, invite_expires_at = NULL
     RETURNING user_id`,
    [T, email, first, last, role, PASSWORD]);
  userIds.push(r.rows[0].user_id);
}
const [adminId, sarahId, colinId] = userIds;
// sarah and colin work the demo client (also satisfies onboarding step 7)
await q(`UPDATE app_user SET client_id = $1 WHERE user_id = ANY($2)`, [C, [sarahId, colinId]]);

// BAA acknowledgment + onboarding checklist for the demo client
await q(`UPDATE client SET baa_acknowledged_at = now(), baa_acknowledged_by = $2
         WHERE client_id = $1`, [C, adminId]);
{
  const { ONBOARDING_STEPS } = await import('../src/web/admin_api.ts');
  for (let i = 0; i < ONBOARDING_STEPS.length; i++) {
    await q(
      `INSERT INTO onboarding_step (tenant_id, client_id, step_number, step_key, label)
       VALUES ($1, $2, $3, $4, $5)`,
      [T, C, i + 1, ONBOARDING_STEPS[i].key, ONBOARDING_STEPS[i].label]);
  }
}

const PAYERS = [
  // shared: true showcases real global master-data payers (tenant_id NULL,
  // visible to every tenant, not per-tenant editable) alongside tenant-owned
  // ones — both are real, distinct product behaviors worth demonstrating
  { name: 'Unity Health Plan', code: 'DEMO-UNI', type: 'commercial', portal: 'https://portal.unityhealth.example', deadline: 180, autopilot: true, shared: true },
  { name: 'Meridian Blue', code: 'DEMO-MBL', type: 'commercial', portal: 'https://providers.meridianblue.example', deadline: 90, autopilot: false, shared: false },
  { name: 'Great Plains Medicaid', code: 'DEMO-GPM', type: 'managed_medicaid', portal: null, deadline: 60, autopilot: false, shared: false },
];
const payerIds: string[] = [];
for (const p of PAYERS) {
  // a shared payer needs tenant_id NULL, which payer_insert's RLS policy
  // only allows through a connection with NO tenant context set at all
  // (see 0018_payer_shared_insert.sql) — clear it for just this one insert
  if (p.shared) await client.query(`SELECT set_config('app.current_tenant_id', '', false)`);
  const r = await q(
    `INSERT INTO payer (tenant_id, payer_name, payer_type, payer_id_code, portal_url, appeal_address,
                        timely_filing_limit_days, appeal_deadline_days)
     VALUES ($1, $2, $3, $4, $5, $6, 95, $7) RETURNING payer_id`,
    [p.shared ? null : T, p.name, p.type, p.code, p.portal,
     `PO Box ${randInt(100, 999)}, Hartford, CT 06101`, p.deadline]);
  if (p.shared) await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [T]);
  payerIds.push(r.rows[0].payer_id);
  await q(`INSERT INTO client_payer_config (tenant_id, client_id, payer_id, autopilot_enabled)
           VALUES ($1, $2, $3, $4)`, [T, C, r.rows[0].payer_id, p.autopilot]);
}

const RATES: Record<string, number> = {
  '99213': 125, '99214': 185, '99215': 245, '20610': 190,
  '29881': 850, '73721': 320, '97110': 45,
};
for (const payerId of payerIds) {
  const ct = await q(
    `INSERT INTO contract (tenant_id, client_id, payer_id, effective_date, fee_schedule_type)
     VALUES ($1, $2, $3, $4, 'fee_schedule') RETURNING contract_id`,
    [T, C, payerId, dayISO(-400)]);
  for (const [code, rate] of Object.entries(RATES)) {
    await q(`INSERT INTO contract_line (tenant_id, contract_id, procedure_code, allowed_amount)
             VALUES ($1, $2, $3, $4)`,
      [T, ct.rows[0].contract_id, code, Math.round(rate * (0.9 + payerIds.indexOf(payerId) * 0.1) * 100) / 100]);
  }
}
for (const [code, rate] of Object.entries(RATES)) {
  await q(`INSERT INTO medicare_fee_schedule (procedure_code, rate, effective_year, locality)
           VALUES ($1, $2, $3, 'DEMO')`, [code, Math.round(rate * 0.7 * 100) / 100, TODAY.getUTCFullYear()]);
}

console.log('creating providers, patients…');
const PROVIDERS = [
  ['1111111111', 'Dr. Alan Smith', 'orthopedic surgery'],
  ['2222222222', 'Dr. Bela Nguyen', 'sports medicine'],
  ['3333333333', 'Dr. Carla Ortiz', 'physical medicine'],
  ['4444444444', 'Dr. David Kim', 'orthopedic surgery'],
];
const providerIds: string[] = [];
for (const [npi, name, spec] of PROVIDERS) {
  const r = await q(
    `INSERT INTO provider (tenant_id, client_id, npi_individual, name, specialty)
     VALUES ($1, $2, $3, $4, $5) RETURNING provider_id`, [T, C, npi, name, spec]);
  providerIds.push(r.rows[0].provider_id);
}

const FIRST = ['James', 'Maria', 'Robert', 'Linda', 'Wei', 'Aisha', 'Carlos', 'Emma',
  'Noah', 'Priya', 'Liam', 'Sofia', 'Ethan', 'Grace', 'Diego', 'Hana', 'Owen', 'Zara',
  'Lucas', 'Nina', 'Mason', 'Ivy', 'Felix', 'Ruth'];
const patientIds: string[] = [];
for (let i = 0; i < FIRST.length; i++) {
  const r = await q(
    `INSERT INTO patient (tenant_id, client_id, mrn, first_name, last_name, dob, gender,
                          insurance_id_primary, payer_id_primary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING patient_id`,
    [T, C, `MRN-${1000 + i}`, FIRST[i], 'Demo' + String.fromCharCode(65 + (i % 26)),
     dayISO(-randInt(9000, 25000)), i % 2 ? 'F' : 'M', `MEM-${7000 + i}`,
     payerIds[i % payerIds.length]]);
  patientIds.push(r.rows[0].patient_id);
}

// denial scenario mix: [carc group, carc, payment factor of expected, weight]
const SCENARIOS: Array<{ carc: string | null; group: string | null; payFactor: number; w: number }> = [
  { carc: null, group: null, payFactor: 1.0, w: 34 },        // clean, paid at contract
  { carc: '45', group: 'CO', payFactor: 0.62, w: 14 },       // contractual underpayment
  { carc: '45', group: 'CO', payFactor: 1.0, w: 10 },        // normal write-off, paid clean
  { carc: '197', group: 'CO', payFactor: 0, w: 9 },          // auth denial
  { carc: '50', group: 'CO', payFactor: 0, w: 8 },           // medical necessity
  { carc: '4', group: 'CO', payFactor: 0, w: 7 },            // missing modifier
  { carc: '29', group: 'CO', payFactor: 0, w: 6 },           // timely filing
  { carc: '18', group: 'CO', payFactor: 0, w: 4 },           // duplicate
  { carc: '97', group: 'CO', payFactor: 0, w: 4 },           // bundling
  { carc: '22', group: 'CO', payFactor: 0, w: 2 },           // COB
  { carc: '27', group: 'CO', payFactor: 0, w: 2 },           // eligibility
];
const DECK: typeof SCENARIOS = SCENARIOS.flatMap((s) => Array(s.w).fill(s));

console.log('creating 90 days of claims + remittances…');
const CODES = Object.keys(RATES);
let claimSeq = 1000;
for (let i = 0; i < 78; i++) {
  const scenario = pickFrom(DECK);
  const payerIdx = randInt(0, payerIds.length - 1);
  const payerId = payerIds[payerIdx];
  const patientId = pickFrom(patientIds);
  const providerId = pickFrom(providerIds);
  const dosOffset = -randInt(20, 90);
  const dos = dayISO(dosOffset);
  const code = pickFrom(CODES);
  const contractRate = Math.round(RATES[code] * (0.9 + payerIdx * 0.1) * 100) / 100;
  const billed = Math.round(contractRate * 2 * 100) / 100;
  const authDenial = scenario.carc === '197';
  const emPair = scenario.carc === '4' && rnd() > 0.5;

  const enc = await q(
    `INSERT INTO encounter (tenant_id, client_id, patient_id, provider_id, date_of_service_start,
                            place_of_service, authorization_number, diagnosis_codes, status)
     VALUES ($1,$2,$3,$4,$5,'11',$6,$7,'billed') RETURNING encounter_id`,
    [T, C, patientId, providerId, dos,
     authDenial && rnd() > 0.35 ? `AUTH-${randInt(10000, 99999)}` : null,
     ['M17.11', 'M25.561', 'S83.242A'].slice(0, randInt(1, 3))]);

  claimSeq += 1;
  const number = `CLM-${claimSeq}`;
  const icn = `ICN-${PAYERS[payerIdx].code.slice(5)}-${claimSeq}`;
  const submission = dayISO(dosOffset + (scenario.carc === '29' ? randInt(100, 130) : randInt(2, 6)));
  const cl = await q(
    `INSERT INTO claim (tenant_id, client_id, encounter_id, payer_id, claim_type,
                        claim_number_internal, claim_number_payer, submission_date,
                        billed_amount, claim_status)
     VALUES ($1,$2,$3,$4,'professional',$5,$6,$7,$8,'submitted') RETURNING claim_id`,
    [T, C, enc.rows[0].encounter_id, payerId, number, icn, submission, billed]);
  const claimId = cl.rows[0].claim_id;

  await q(
    `INSERT INTO claim_line (tenant_id, claim_id, line_number, procedure_code, units, billed_amount)
     VALUES ($1, $2, 1, $3, 1, $4)`, [T, claimId, code, billed]);
  if (emPair) {
    // paid E/M sibling so the CO-4 correction rule has context
    await q(
      `INSERT INTO claim_line (tenant_id, claim_id, line_number, procedure_code, units, billed_amount, paid_amount)
       VALUES ($1, $2, 2, '20610', 1, 380, 171)`, [T, claimId]);
  }

  const checkOffset = dosOffset + randInt(18, 32);
  const paid = Math.round(contractRate * scenario.payFactor * 100) / 100;
  // created_at backdated to the check date so "remit received after appeal"
  // reconciliation logic sees realistic arrival times
  const rem = await q(
    `INSERT INTO remittance (tenant_id, client_id, payer_id, check_date, check_number,
                             eft_trace_number, total_paid, raw_835_reference, processed_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7, now(), $4::date::timestamptz) RETURNING remittance_id`,
    [T, C, payerId, dayISO(checkOffset), `CHK-${claimSeq}`, paid, `era-${claimSeq}.835`]);
  await q(
    `INSERT INTO remittance_line
       (tenant_id, remittance_id, procedure_code, billed_amount, allowed_amount, paid_amount,
        adjustment_group_code, adjustment_reason_code, payer_claim_number, patient_member_id,
        date_of_service)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
             (SELECT insurance_id_primary FROM patient WHERE patient_id = $10), $11)`,
    [T, rem.rows[0].remittance_id, code, billed, contractRate, paid,
     scenario.group, scenario.carc, icn, patientId, dos]);
}

console.log('running detection engine…');
const det = await runDetectionJob(pool, { tenantId: T, clientId: C });
console.log(`  ${det.result.summary.casesCreated} cases created, `
  + `$${det.result.summary.totalRecoveryOpportunity.toFixed(2)} identified`);

console.log('generating appeal packets…');
const store = new FileSystemDocumentStore();
const gen = await generateAppealPackets(pool, { tenantId: T, clientId: C, store });
console.log(`  ${gen.summary.packetsCreated} packets (${gen.summary.ready} ready, ${gen.summary.draft} draft)`);

console.log('simulating team activity…');
const cases = await q(
  `SELECT rc.case_id, rc.claim_id, rc.recovery_opportunity, rc.created_at,
          ap.packet_id, ap.packet_status, ap.submission_method
   FROM recovery_case rc
   LEFT JOIN appeal_packet ap ON ap.case_id = rc.case_id AND ap.deleted_at IS NULL
   WHERE rc.tenant_id = $1 ORDER BY rc.case_id`, [T]);

const workers = [sarahId, colinId, adminId];
let i = 0;
let submittedCount = 0;
for (const c of cases.rows) {
  i += 1;
  const worker = workers[i % workers.length];
  await q(`UPDATE recovery_case SET assigned_to_user_id = $1 WHERE case_id = $2`, [worker, c.case_id]);

  // sprinkle of human notes/calls across the last 8 weeks (workload trends)
  if (i % 2 === 0) {
    await q(
      `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_user_id, notes, action_date)
       VALUES ($1, $2, 'note', $3, 'Reviewed remittance and contract terms.', now() - ($4 || ' days')::interval)`,
      [T, c.case_id, worker, randInt(1, 55)]);
  }
  if (i % 5 === 0) {
    await q(
      `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_user_id, notes, action_date)
       VALUES ($1, $2, 'payer_call_logged', $3, 'Payer call — outcome: reprocessing_initiated', now() - ($4 || ' days')::interval)`,
      [T, c.case_id, worker, randInt(1, 40)]);
  }

  // submit ~60% of ready packets, dated over the past 8 weeks
  if (c.packet_id && c.packet_status === 'ready' && i % 5 !== 0) {
    submittedCount += 1;
    const daysAgo = randInt(3, 55);
    await q(
      `UPDATE appeal_packet SET packet_status = 'submitted',
              submitted_at = now() - ($2 || ' days')::interval
       WHERE packet_id = $1`, [c.packet_id, daysAgo]);
    await q(`UPDATE recovery_case SET status = 'submitted' WHERE case_id = $1`, [c.case_id]);
    await q(
      `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_user_id, notes, action_date)
       VALUES ($1, $2, 'appeal_submitted', $3, $4, now() - ($5 || ' days')::interval)`,
      [T, c.case_id, worker,
       `Appeal submitted via ${c.submission_method ?? 'mail'}`, daysAgo]);

    // ~55% of submitted appeals get an outcome
    const roll = rnd();
    if (roll < 0.40 && daysAgo > 10) {
      // WON: payer pays; alternate auto/manual matching
      const payDaysAgo = randInt(1, daysAgo - 5);
      const auto = i % 2 === 0;
      await q(
        `INSERT INTO payment_event (tenant_id, case_id, claim_id, amount_recovered, payment_date,
                                    matched_automatically, verified_by_user_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'Recovery payment posted after appeal')`,
        [T, c.case_id, c.claim_id, c.recovery_opportunity, dayISO(-payDaysAgo),
         auto, auto ? null : worker]);
      await q(`UPDATE recovery_case SET status = 'won' WHERE case_id = $1`, [c.case_id]);
      await q(
        `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_user_id, notes, action_date)
         VALUES ($1, $2, 'payment_received', $3, 'Recovery payment received — case won', now() - ($4 || ' days')::interval)`,
        [T, c.case_id, worker, payDaysAgo]);
    } else if (roll < 0.52 && daysAgo > 20) {
      await q(`UPDATE recovery_case SET status = 'lost' WHERE case_id = $1`, [c.case_id]);
    } else if (roll < 0.75 && daysAgo > 8) {
      // payer paid but nothing matched yet -> manual reconciliation queue
      const rem2 = await q(
        `INSERT INTO remittance (tenant_id, client_id, payer_id, check_date, check_number, total_paid)
         SELECT $1, $2, cl.payer_id, $4, 'CHK-R-' || $5, $6 FROM claim cl WHERE cl.claim_id = $3
         RETURNING remittance_id`,
        [T, C, c.claim_id, dayISO(-randInt(1, 6)), i, c.recovery_opportunity]);
      await q(
        `INSERT INTO remittance_line (tenant_id, remittance_id, claim_id, paid_amount, match_method)
         VALUES ($1, $2, $3, $4, 'payer_claim_number')`,
        [T, rem2.rows[0].remittance_id, c.claim_id, c.recovery_opportunity]);
    }
  }
}
console.log(`  ${submittedCount} appeals submitted; wins, losses, and unmatched payments simulated`);

const counts = await q(
  `SELECT (SELECT count(*) FROM claim WHERE tenant_id = $1) AS claims,
          (SELECT count(*) FROM recovery_case WHERE tenant_id = $1) AS cases,
          (SELECT count(*) FROM appeal_packet WHERE tenant_id = $1) AS packets,
          (SELECT count(*) FROM payment_event WHERE tenant_id = $1) AS payments,
          (SELECT count(*) FROM document WHERE tenant_id = $1) AS documents`, [T]);
console.log('seed complete:', counts.rows[0]);
console.log('\nlogin: admin@meridianrcm.com / sarah@meridianrcm.com / colin@meridianrcm.com');
console.log('password: demo1234');
client.release();
await pool.end();
