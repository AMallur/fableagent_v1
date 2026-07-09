// ============================================================================
// Integration test: full service path against a real Postgres.
//
//   TEST_DATABASE_URL=postgres://... node --test test/integration.test.ts
//
// Skips (cleanly) when TEST_DATABASE_URL is unset. Expects the db/migrations
// chain (0001-0009) to be applied. Seeds a tenant end-to-end, drops in an
// unprocessed 835 line paying below contract plus a denied line, runs
// runDetectionJob, and asserts on what landed in the database.
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

describe('detection service against Postgres', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  let pool: any;

  const T = '99999999-0000-0000-0000-000000000001';   // tenant
  const C = '99999999-0000-0000-0000-000000000002';   // client
  const P = '99999999-0000-0000-0000-000000000003';   // payer
  const PAT = '99999999-0000-0000-0000-000000000004'; // patient
  const PROV = '99999999-0000-0000-0000-000000000005';
  const ENC1 = '99999999-0000-0000-0000-000000000006';
  const CLM1 = '99999999-0000-0000-0000-000000000007';
  const CL1 = '99999999-0000-0000-0000-000000000008'; // claim line (underpaid)
  const ENC2 = '99999999-0000-0000-0000-000000000016';
  const CLM2 = '99999999-0000-0000-0000-000000000017';
  const CL2 = '99999999-0000-0000-0000-000000000018'; // claim line (denied CO-197)
  const CT = '99999999-0000-0000-0000-000000000009';  // contract
  const REM = '99999999-0000-0000-0000-000000000010';
  const RL1 = '99999999-0000-0000-0000-000000000011';
  const RL2 = '99999999-0000-0000-0000-000000000012';
  const RL3 = '99999999-0000-0000-0000-000000000013'; // will not match

  // FK-ordered teardown, also run before seeding so a previously crashed run
  // can't poison this one. Runs on one connection with triggers disabled
  // (superuser): the audit trigger would otherwise write fresh audit_log rows
  // during these very deletes — intended in production, inconvenient here.
  async function cleanup() {
    const client = await pool.connect();
    const q = (text: string, p?: unknown[]) => client.query(text, p);
    try {
      await q(`SET session_replication_role = replica`);
      await q(`DELETE FROM case_action WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM payment_event WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM recovery_case WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM remittance_line WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM remittance WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM claim_line WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM claim WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM encounter WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM patient WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM client_payer_config WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM contract_line WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM contract WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM provider WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM system_job WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM audit_log WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM client WHERE tenant_id = $1`, [T]);
      await q(`DELETE FROM payer WHERE payer_id = $1`, [P]);
      await q(`DELETE FROM tenant WHERE tenant_id = $1`, [T]);
      await q(`SET session_replication_role = DEFAULT`);
    } finally {
      client.release();
    }
  }

  before(async () => {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: url });
    await cleanup();
    const q = (text: string, p?: unknown[]) => pool.query(text, p);

    await q(`INSERT INTO tenant (tenant_id, tenant_name, tenant_type)
             VALUES ($1, 'IT Tenant', 'billing_company')`, [T]);
    await q(`INSERT INTO client (client_id, tenant_id, client_name, recovery_alert_threshold)
             VALUES ($1, $2, 'IT Client', 100)`, [C, T]);
    await q(`INSERT INTO payer (payer_id, payer_name, payer_type, appeal_deadline_days, timely_filing_limit_days)
             VALUES ($1, 'IT Payer', 'commercial', 180, 90)`, [P]);
    await q(`INSERT INTO provider (provider_id, tenant_id, client_id, npi_individual, name)
             VALUES ($1, $2, $3, '1111111111', 'Dr. IT')`, [PROV, T, C]);
    await q(`INSERT INTO patient (patient_id, tenant_id, client_id, mrn, first_name, last_name, insurance_id_primary)
             VALUES ($1, $2, $3, 'IT-MRN', 'Ida', 'Test', 'MEM-IT-1')`, [PAT, T, C]);
    await q(`INSERT INTO contract (contract_id, tenant_id, client_id, payer_id, effective_date, fee_schedule_type)
             VALUES ($1, $2, $3, $4, '2026-01-01', 'fee_schedule')`, [CT, T, C, P]);
    await q(`INSERT INTO contract_line (tenant_id, contract_id, procedure_code, allowed_amount)
             VALUES ($1, $2, '99213', 125.00)`, [T, CT]);
    await q(`INSERT INTO client_payer_config (tenant_id, client_id, payer_id, autopilot_enabled)
             VALUES ($1, $2, $3, true)`, [T, C, P]);

    // claim 1: paid below contract (expect underpayment case)
    await q(`INSERT INTO encounter (encounter_id, tenant_id, client_id, patient_id, provider_id, date_of_service_start)
             VALUES ($1, $2, $3, $4, $5, '2026-06-01')`, [ENC1, T, C, PAT, PROV]);
    await q(`INSERT INTO claim (claim_id, tenant_id, client_id, encounter_id, payer_id, claim_type,
                                claim_number_internal, claim_number_payer, submission_date, billed_amount)
             VALUES ($1, $2, $3, $4, $5, 'professional', 'IT-CLM-1', 'IT-ICN-1', '2026-06-05', 250)`,
      [CLM1, T, C, ENC1, P]);
    await q(`INSERT INTO claim_line (claim_line_id, tenant_id, claim_id, line_number, procedure_code, billed_amount)
             VALUES ($1, $2, $3, 1, '99213', 250)`, [CL1, T, CLM1]);

    // claim 2: denied CO-197, has auth number (expect authorization case, high score)
    await q(`INSERT INTO encounter (encounter_id, tenant_id, client_id, patient_id, provider_id,
                                    date_of_service_start, authorization_number)
             VALUES ($1, $2, $3, $4, $5, '2026-06-02', 'AUTH-42')`, [ENC2, T, C, PAT, PROV]);
    await q(`INSERT INTO claim (claim_id, tenant_id, client_id, encounter_id, payer_id, claim_type,
                                claim_number_internal, claim_number_payer, submission_date, billed_amount)
             VALUES ($1, $2, $3, $4, $5, 'professional', 'IT-CLM-2', 'IT-ICN-2', '2026-06-06', 250)`,
      [CLM2, T, C, ENC2, P]);
    await q(`INSERT INTO claim_line (claim_line_id, tenant_id, claim_id, line_number, procedure_code, billed_amount)
             VALUES ($1, $2, $3, 1, '99213', 250)`, [CL2, T, CLM2]);

    // the 835
    await q(`INSERT INTO remittance (remittance_id, tenant_id, client_id, payer_id, check_date, check_number, total_paid)
             VALUES ($1, $2, $3, $4, '2026-06-25', 'IT-CHK', 80)`, [REM, T, C, P]);
    await q(`INSERT INTO remittance_line (remittance_line_id, tenant_id, remittance_id, payer_claim_number,
                                          procedure_code, billed_amount, paid_amount, adjustment_group_code, adjustment_reason_code)
             VALUES ($1, $2, $3, 'IT-ICN-1', '99213', 250, 80, 'CO', '45')`, [RL1, T, REM]);
    await q(`INSERT INTO remittance_line (remittance_line_id, tenant_id, remittance_id, payer_claim_number,
                                          procedure_code, billed_amount, paid_amount, adjustment_group_code, adjustment_reason_code)
             VALUES ($1, $2, $3, 'IT-ICN-2', '99213', 250, 0, 'CO', '197')`, [RL2, T, REM]);
    await q(`INSERT INTO remittance_line (remittance_line_id, tenant_id, remittance_id, payer_claim_number,
                                          patient_member_id, date_of_service, procedure_code, billed_amount, paid_amount)
             VALUES ($1, $2, $3, 'IT-ICN-NOPE', 'MEM-UNKNOWN', '2026-06-03', '99999', 50, 0)`, [RL3, T, REM]);
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  it('runs the job end-to-end and persists everything', async () => {
    const { runDetectionJob } = await import('../src/service.ts');
    const out = await runDetectionJob(pool, { tenantId: T, clientId: C, asOf: '2026-07-01' });

    // engine result
    assert.equal(out.result.summary.remitLinesProcessed, 3);
    assert.equal(out.result.summary.matched, 2);
    assert.equal(out.result.summary.unmatched, 1);
    assert.equal(out.result.summary.casesCreated, 2);
    assert.equal(out.result.summary.totalRecoveryOpportunity, 170); // 45 + 125
    assert.equal(out.result.summary.alerts.length, 1);              // threshold 100

    // remit lines linked / flagged
    const rl = await pool.query(
      `SELECT remittance_line_id, claim_line_id, match_method FROM remittance_line
       WHERE tenant_id = $1 ORDER BY remittance_line_id`, [T]);
    const byId = new Map(rl.rows.map((r: any) => [r.remittance_line_id, r]));
    assert.equal(byId.get(RL1).match_method, 'payer_claim_number');
    assert.equal(byId.get(RL1).claim_line_id, CL1);
    assert.equal(byId.get(RL2).match_method, 'payer_claim_number');
    assert.equal(byId.get(RL3).match_method, 'unmatched');

    // claim lines priced + statused
    const cl = await pool.query(
      `SELECT claim_line_id, expected_amount, expected_source, paid_amount, line_status,
              denial_reason_code
       FROM claim_line WHERE tenant_id = $1`, [T]);
    const lineById = new Map(cl.rows.map((r: any) => [r.claim_line_id, r]));
    assert.equal(Number(lineById.get(CL1).expected_amount), 125);
    assert.equal(lineById.get(CL1).expected_source, 'contract');
    assert.equal(lineById.get(CL1).line_status, 'underpaid');
    assert.equal(lineById.get(CL2).line_status, 'denied');
    assert.equal(lineById.get(CL2).denial_reason_code, 'CO-197');

    // claim statuses
    const claims = await pool.query(
      `SELECT claim_id, claim_status FROM claim WHERE tenant_id = $1`, [T]);
    const statusById = new Map(claims.rows.map((r: any) => [r.claim_id, r.claim_status]));
    assert.equal(statusById.get(CLM1), 'underpaid');
    assert.equal(statusById.get(CLM2), 'denied');

    // cases in the database
    const cases = await pool.query(
      `SELECT case_type, denial_category, recovery_opportunity, priority_level,
              appealability_score, auto_action, auto_created, status,
              deadline_date::text AS deadline_date
       FROM recovery_case WHERE tenant_id = $1 ORDER BY case_type::text`, [T]);
    assert.equal(cases.rows.length, 2);
    const [auth, under] = cases.rows;
    assert.equal(auth.case_type, 'authorization');
    assert.equal(auth.denial_category, 'authorization');
    assert.ok(auth.appealability_score >= 70);       // auth number exists
    assert.equal(auth.auto_action, true);            // autopilot on
    assert.equal(under.case_type, 'underpayment');
    assert.equal(Number(under.recovery_opportunity), 45);
    assert.equal(under.auto_created, true);
    assert.equal(String(auth.deadline_date).slice(0, 10), '2026-12-22');

    // system activity note on each case
    const actions = await pool.query(
      `SELECT count(*)::int AS n FROM case_action
       WHERE tenant_id = $1 AND performed_by_system`, [T]);
    assert.equal(actions.rows[0].n, 2);

    // job bookkeeping
    const job = await pool.query(
      `SELECT status, records_processed, errors_count, log_output
       FROM system_job WHERE job_id = $1`, [out.jobId]);
    assert.equal(job.rows[0].status, 'completed');
    assert.equal(job.rows[0].records_processed, 3);
    assert.equal(job.rows[0].errors_count, 1);       // the unmatched line
    assert.equal(JSON.parse(job.rows[0].log_output).casesCreated, 2);
  });

  it('a second run is idempotent: refreshes cases instead of duplicating', async () => {
    const { runDetectionJob } = await import('../src/service.ts');
    // simulate the 835 lines arriving again unprocessed
    await pool.query(
      `UPDATE remittance_line SET match_method = NULL, claim_id = NULL, claim_line_id = NULL
       WHERE tenant_id = $1 AND remittance_line_id IN ($2, $3)`, [T, RL1, RL2]);

    const out = await runDetectionJob(pool, { tenantId: T, clientId: C, asOf: '2026-07-01' });
    assert.equal(out.result.summary.casesCreated, 0);
    assert.equal(out.result.summary.casesUpdated, 2);

    const n = await pool.query(
      `SELECT count(*)::int AS n FROM recovery_case WHERE tenant_id = $1`, [T]);
    assert.equal(n.rows[0].n, 2); // still exactly two cases
  });

  it('dry run writes nothing', async () => {
    const { runDetectionJob } = await import('../src/service.ts');
    await pool.query(
      `UPDATE remittance_line SET match_method = NULL, claim_id = NULL, claim_line_id = NULL
       WHERE tenant_id = $1 AND remittance_line_id = $2`, [T, RL1]);

    const before = await pool.query(
      `SELECT count(*)::int AS n FROM system_job WHERE tenant_id = $1`, [T]);
    const out = await runDetectionJob(pool, { tenantId: T, clientId: C, asOf: '2026-07-01', dryRun: true });
    assert.equal(out.jobId, null);
    assert.ok(out.result.summary.remitLinesProcessed >= 1);

    const after = await pool.query(
      `SELECT count(*)::int AS n FROM system_job WHERE tenant_id = $1`, [T]);
    assert.equal(after.rows[0].n, before.rows[0].n); // no job row
    const rl = await pool.query(
      `SELECT match_method FROM remittance_line WHERE remittance_line_id = $1`, [RL1]);
    assert.equal(rl.rows[0].match_method, null);     // still unprocessed
  });
});
