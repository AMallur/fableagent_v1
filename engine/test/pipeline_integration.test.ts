// ============================================================================
// Full-pipeline integration test against a real Postgres:
//
//   837 file -> ingest_837 (patients, encounters, claims)
//   835 file -> ingest_835 (remittance + lines with matching hints)
//   run_detection        (match, price, detect, create cases)
//   generate_appeals     (letters, documents, packets, corrected claims)
//   submission queue + document retrieval by case / patient / payer / dates
//
//   TEST_DATABASE_URL=postgres://... node --test test/pipeline_integration.test.ts
// Skips cleanly when TEST_DATABASE_URL is unset. Expects migrations 0001-0010.
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { FIXTURE_835, FIXTURE_837 } from './ingest.test.ts';
import { MemoryDocumentStore } from '../src/appeals/storage.ts';

const url = process.env.TEST_DATABASE_URL;

describe('full pipeline: ingest -> detect -> appeal -> queue', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  let pool: any;
  const store = new MemoryDocumentStore();

  const T = '88888888-0000-0000-0000-000000000001';
  const C = '88888888-0000-0000-0000-000000000002';
  const P = '88888888-0000-0000-0000-000000000003';
  const AS_OF = '2026-07-05';

  async function cleanup() {
    const client = await pool.connect();
    const q = (t: string, p?: unknown[]) => client.query(t, p);
    try {
      await q(`SET session_replication_role = replica`);
      for (const table of [
        'appeal_packet_document', 'appeal_packet', 'corrected_claim', 'case_action',
        'payment_event', 'recovery_case', 'document', 'remittance_line', 'remittance',
        'claim_line', 'claim', 'encounter', 'patient', 'client_payer_config',
        'contract_line', 'contract', 'provider', 'system_job', 'audit_log', 'client',
      ]) {
        await q(`DELETE FROM ${table} WHERE tenant_id = $1`, [T]);
      }
      await q(`DELETE FROM payer WHERE tenant_id = $1`, [T]); // ingest-created stubs
      await q(`DELETE FROM payer WHERE payer_id = $1`, [P]);
      await q(`DELETE FROM medicare_fee_schedule WHERE procedure_code IN ('99213', '99214')`);
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
    const q = (t: string, p?: unknown[]) => pool.query(t, p);

    // reference data only — patients/claims/remits arrive via EDI
    await q(`INSERT INTO tenant (tenant_id, tenant_name, tenant_type)
             VALUES ($1, 'Pipeline Tenant', 'billing_company')`, [T]);
    await q(`INSERT INTO client (client_id, tenant_id, client_name, npi_group, address,
                                 recovery_alert_threshold, appeal_review_threshold)
             VALUES ($1, $2, 'Alpha Ortho Group', '1234567890',
                     '{"line1":"100 Main St","city":"Austin","state":"TX","zip":"78701"}', 100, 5000)`,
      [C, T]);
    await q(`INSERT INTO payer (payer_id, payer_name, payer_type, payer_id_code,
                                portal_url, appeal_address, timely_filing_limit_days, appeal_deadline_days)
             VALUES ($1, 'United Commercial', 'commercial', '87726',
                     'https://portal.example.com', 'PO Box 100, Hartford, CT 06101', 90, 180)`, [P]);
    await q(`INSERT INTO contract (tenant_id, client_id, payer_id, effective_date, fee_schedule_type)
             VALUES ($1, $2, $3, '2026-01-01', 'fee_schedule') RETURNING contract_id`, [T, C, P])
      .then(({ rows }: any) => q(
        `INSERT INTO contract_line (tenant_id, contract_id, procedure_code, allowed_amount)
         VALUES ($1, $2, '99213', 125.00), ($1, $2, '99214', 185.00)`, [T, rows[0].contract_id]));
    await q(`INSERT INTO client_payer_config (tenant_id, client_id, payer_id, autopilot_enabled)
             VALUES ($1, $2, $3, true)`, [T, C, P]);
    // prior appeal history so 'new denial pattern' review rule doesn't fire here
    // (proven separately in the assembly unit tests)
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  it('ingests the 837: patients, encounters, claims, lines', async () => {
    const { ingest837Job } = await import('../src/ingest/service.ts');
    const out = await ingest837Job(pool, {
      tenantId: T, clientId: C, content: FIXTURE_837, fileName: 'claims-20260605.837',
    });
    assert.equal(out.recordsProcessed, 2);
    assert.equal(out.skipped, 0);

    const claims = await pool.query(
      `SELECT claim_number_internal, billed_amount, claim_status FROM claim
       WHERE tenant_id = $1 ORDER BY claim_number_internal`, [T]);
    assert.deepEqual(
      claims.rows.map((r: any) => [r.claim_number_internal, Number(r.billed_amount), r.claim_status]),
      [['IT-CLM-1', 250, 'submitted'], ['IT-CLM-2', 250, 'submitted']],
    );
    const patient = await pool.query(
      `SELECT first_name, last_name, dob::text AS dob FROM patient WHERE tenant_id = $1`, [T]);
    assert.equal(patient.rows.length, 1); // both claims, one patient
    assert.deepEqual(patient.rows[0], { first_name: 'JANE', last_name: 'DOE', dob: '1980-05-01' });
    const enc = await pool.query(
      `SELECT authorization_number FROM encounter WHERE tenant_id = $1
       ORDER BY date_of_service_start`, [T]);
    assert.equal(enc.rows[0].authorization_number, null);       // claim 1
    assert.equal(enc.rows[1].authorization_number, 'AUTH-42');  // claim 2 (CO-197)

    // re-ingest is idempotent
    const again = await ingest837Job(pool, {
      tenantId: T, clientId: C, content: FIXTURE_837, fileName: 'claims-20260605.837',
    });
    assert.equal(again.recordsProcessed, 0);
    assert.equal(again.skipped, 2);
  });

  it('sets payer claim numbers then ingests the 835', async () => {
    // the payer's ICN normally arrives on a 277/835; the detection engine can
    // also match by number — here CLP07 in the 835 carries it, and our claims
    // need it set for the primary match path. Simulate the clearinghouse
    // update:
    await pool.query(
      `UPDATE claim SET claim_number_payer = 'IT-ICN-1' WHERE tenant_id = $1 AND claim_number_internal = 'IT-CLM-1'`, [T]);
    await pool.query(
      `UPDATE claim SET claim_number_payer = 'IT-ICN-2' WHERE tenant_id = $1 AND claim_number_internal = 'IT-CLM-2'`, [T]);

    const { ingest835Job } = await import('../src/ingest/service.ts');
    const out = await ingest835Job(pool, {
      tenantId: T, clientId: C, content: FIXTURE_835, fileName: 'era-20260625.835',
    });
    assert.equal(out.recordsProcessed, 2);
    // payer resolved by payer_id_code 87726 — no stub created
    assert.equal(out.warnings.length, 0);

    const remit = await pool.query(
      `SELECT check_number, total_paid FROM remittance WHERE tenant_id = $1`, [T]);
    assert.equal(remit.rows[0].check_number, 'CHK-IT-100');
    assert.equal(Number(remit.rows[0].total_paid), 80);

    // duplicate file is skipped
    const again = await ingest835Job(pool, {
      tenantId: T, clientId: C, content: FIXTURE_835, fileName: 'era-20260625.835',
    });
    assert.equal(again.recordsProcessed, 0);
    assert.match(again.warnings[0], /already loaded/);
  });

  it('detection matches the remit and creates the cases', async () => {
    const { runDetectionJob } = await import('../src/service.ts');
    const out = await runDetectionJob(pool, { tenantId: T, clientId: C, asOf: AS_OF });
    assert.equal(out.result.summary.matched, 2);
    assert.equal(out.result.summary.unmatched, 0);
    assert.equal(out.result.summary.casesCreated, 2);
    // 45 underpaid (99213: 125-80) + 185 denied (99214 contract rate)
    assert.equal(out.result.summary.totalRecoveryOpportunity, 230);
    // above the client's $100 alert threshold
    assert.equal(out.result.summary.alerts.length, 1);

    const cases = await pool.query(
      `SELECT case_type, denial_reason_code FROM recovery_case
       WHERE tenant_id = $1 ORDER BY case_type::text`, [T]);
    assert.deepEqual(
      cases.rows.map((r: any) => [r.case_type, r.denial_reason_code]),
      // the 835's CAS*CO*45 rides on the underpayment case as its denial code
      [['authorization', 'CO-197'], ['underpayment', 'CO-45']],
    );
  });

  it('generates appeal packets with letters and assembled documents', async () => {
    const { generateAppealPackets } = await import('../src/appeals/service.ts');
    const out = await generateAppealPackets(pool, {
      tenantId: T, clientId: C, asOf: AS_OF, store,
    });
    assert.equal(out.summary.casesProcessed, 2);
    assert.equal(out.summary.packetsCreated, 2);
    assert.equal(out.summary.ready, 2);      // auth attestation + contract excerpt generated
    assert.equal(out.summary.draft, 0);

    const authPacket = out.packets.find((p) => p.appealType === 'first_level' && p.documentCount === 4)!;
    // letter + eob + claim lines + auth attestation
    assert.ok(authPacket, 'authorization packet with 4 documents');

    // letter content is retrievable from the store and references the auth number
    const letterDoc = await pool.query(
      `SELECT d.storage_path FROM appeal_packet ap
       JOIN document d ON d.document_id = ap.letter_document_id
       JOIN recovery_case rc ON rc.case_id = ap.case_id
       WHERE ap.tenant_id = $1 AND rc.case_type = 'authorization'`, [T]);
    const letter = await store.get(letterDoc.rows[0].storage_path);
    assert.match(letter, /Authorization number AUTH-42 was issued/);
    assert.match(letter, /Amount in dispute: \$185\.00/);
    assert.match(letter, /United Commercial/);

    // the underpayment letter shows the contract calculation
    const upLetter = await pool.query(
      `SELECT d.storage_path FROM appeal_packet ap
       JOIN document d ON d.document_id = ap.letter_document_id
       JOIN recovery_case rc ON rc.case_id = ap.case_id
       WHERE ap.tenant_id = $1 AND rc.case_type = 'underpayment'`, [T]);
    const up = await store.get(upLetter.rows[0].storage_path);
    assert.match(up, /contracted rate \$125\.00, paid \$80\.00, underpayment \$45\.00/);

    // every document row landed with system_generated source and case linkage
    const docs = await pool.query(
      `SELECT count(*)::int AS n FROM document
       WHERE tenant_id = $1 AND source = 'system_generated' AND case_id IS NOT NULL`, [T]);
    assert.ok(docs.rows[0].n >= 7);

    // re-run: no duplicate packets (finalized 'ready' packets are skipped)
    const again = await generateAppealPackets(pool, {
      tenantId: T, clientId: C, asOf: AS_OF, store,
    });
    assert.equal(again.summary.casesProcessed, 0);
  });

  it('serves the submission queue sorted by priority then deadline', async () => {
    const { loadSubmissionQueue } = await import('../src/appeals/queue.ts');
    const queue = await loadSubmissionQueue(pool, { tenantId: T, clientId: C });
    assert.equal(queue.length, 2);
    for (const item of queue) {
      assert.equal(item.patientName, 'JANE DOE');
      assert.equal(item.payerName, 'United Commercial');
      assert.ok(item.deadlineDate);
      assert.ok(item.requiredAction.length > 5);
    }
    // same priority + deadline: higher recovery first
    assert.ok((queue[0].recoveryAmount ?? 0) >= (queue[1].recoveryAmount ?? 0));
    assert.equal(queue[0].recoveryAmount, 185); // the CO-197 denial

    // first run against this payer: 'new denial pattern' + sub-0.85 confidence
    // force review on both packets — autopilot never overrides review flags.
    // (the auto-submit path is proven in the assembly unit tests)
    for (const item of queue) {
      assert.equal(item.needsReview, true);
      assert.equal(item.autoSubmit, false);
      assert.match(item.requiredAction, /^review required:/);
      assert.match(item.needsReviewReasons.join(' '), /new denial pattern/);
    }
  });

  it('retrieves documents by case, patient, payer, and date range', async () => {
    const { findDocuments, findPackets } = await import('../src/appeals/queue.ts');

    const caseRow = await pool.query(
      `SELECT case_id FROM recovery_case WHERE tenant_id = $1 AND case_type = 'authorization'`, [T]);
    const patientRow = await pool.query(
      `SELECT patient_id FROM patient WHERE tenant_id = $1`, [T]);

    const byCase = await findDocuments(pool, { tenantId: T, caseId: caseRow.rows[0].case_id });
    assert.equal(byCase.length, 4);

    const byPatient = await findDocuments(pool, { tenantId: T, patientId: patientRow.rows[0].patient_id });
    assert.ok(byPatient.length >= 7); // both cases' documents

    const byPayer = await findDocuments(pool, {
      tenantId: T, payerId: P, documentType: 'appeal_letter',
    });
    assert.equal(byPayer.length, 2);

    const inRange = await findDocuments(pool, {
      tenantId: T, uploadedFrom: '2020-01-01', uploadedTo: '2099-12-31',
    });
    assert.ok(inRange.length >= 7);
    const outOfRange = await findDocuments(pool, {
      tenantId: T, uploadedFrom: '2000-01-01', uploadedTo: '2000-12-31',
    });
    assert.equal(outOfRange.length, 0);

    const packets = await findPackets(pool, { tenantId: T, payerId: P, packetStatus: 'ready' });
    assert.equal(packets.length, 2);
    assert.equal(Number(packets[0].document_count) + Number(packets[1].document_count), byPatient.length);
  });
});
