// ============================================================================
// ERA financial integrity against a real Postgres:
//
//   * an out-of-balance 835 is rejected under the strict policy and writes
//     nothing; the same file loads under the warn policy and is marked
//   * PLB provider-level adjustments persist, categorized and linked back to
//     the claim the payer recouped
//   * reversal, adjudicated-code and unit columns persist, and a reversal
//     never becomes a recovery case
//   * recovery attribution is line-scoped and netted of reversals and
//     recoupments, and a post-appeal takeback reverses the credited recovery
//
//   TEST_DATABASE_URL=postgres://... node --test test/era_integrity_integration.test.ts
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

describe('835 financial integrity', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  let pool: any;

  const T = '77777777-0000-0000-0000-000000000001';
  const C = '77777777-0000-0000-0000-000000000002';
  const P = '77777777-0000-0000-0000-000000000003';

  const ISA = 'ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *260625*1200*^*00501*000000001*0*P*:~';
  const era = (lines: string[]) => [
    ISA,
    'GS*HP*SENDER*RECEIVER*20260625*1200*1*X*005010X221A1~',
    'ST*835*0001~',
    ...lines,
    'SE*12*0001~',
    'GE*1*1~',
    'IEA*1*000000001~',
  ].join('\n');

  async function cleanup() {
    const client = await pool.connect();
    try {
      await client.query(`SET session_replication_role = replica`);
      for (const table of [
        'appeal_packet_document', 'appeal_packet', 'case_action', 'notification',
        'payment_event', 'corrected_claim', 'recovery_case', 'document',
        'remittance_line', 'remittance_provider_adjustment', 'remittance',
        'claim_line', 'claim', 'encounter', 'patient', 'client_payer_config',
        'contract_line', 'contract', 'provider', 'system_job', 'audit_log', 'client',
      ]) {
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [T]);
      }
      await client.query(`DELETE FROM payer WHERE tenant_id = $1 OR payer_id = $2`, [T, P]);
      await client.query(`DELETE FROM tenant WHERE tenant_id = $1`, [T]);
      await client.query(`SET session_replication_role = DEFAULT`);
    } finally {
      client.release();
    }
  }

  /** One submitted claim with a single $250 line, paid $80 by CHK-BASE. */
  let npiSeq = 0;
  const nextNpi = () => String(1000000000 + (++npiSeq));

  async function seedClaim(internal: string, icn: string): Promise<{
    claimId: string; claimLineId: string;
  }> {
    const patient = await pool.query(
      `INSERT INTO patient (tenant_id, client_id, mrn, first_name, last_name)
       VALUES ($1, $2, $3, 'Jane', 'Doe') RETURNING patient_id`, [T, C, `MRN-${internal}`]);
    const provider = await pool.query(
      `INSERT INTO provider (tenant_id, client_id, npi_individual, name)
       VALUES ($1, $2, $3, 'Dr Who') RETURNING provider_id`, [T, C, nextNpi()]);
    const encounter = await pool.query(
      `INSERT INTO encounter (tenant_id, client_id, patient_id, provider_id,
                              date_of_service_start, place_of_service, status)
       VALUES ($1, $2, $3, $4, '2026-06-01', '11', 'billed') RETURNING encounter_id`,
      [T, C, patient.rows[0].patient_id, provider.rows[0].provider_id]);
    const claim = await pool.query(
      `INSERT INTO claim (tenant_id, client_id, encounter_id, payer_id, claim_type,
                          claim_number_internal, claim_number_payer, submission_date,
                          billed_amount, claim_status)
       VALUES ($1, $2, $3, $4, 'professional', $5, $6, '2026-06-05', 250, 'submitted')
       RETURNING claim_id`,
      [T, C, encounter.rows[0].encounter_id, P, internal, icn]);
    const line = await pool.query(
      `INSERT INTO claim_line (tenant_id, claim_id, line_number, procedure_code, units,
                               billed_amount)
       VALUES ($1, $2, 1, '99213', 1, 250) RETURNING claim_line_id`,
      [T, claim.rows[0].claim_id]);
    return { claimId: claim.rows[0].claim_id, claimLineId: line.rows[0].claim_line_id };
  }

  before(async () => {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: url });
    await cleanup();
    await pool.query(
      `INSERT INTO tenant (tenant_id, tenant_name, tenant_type)
       VALUES ($1, 'ERA Integrity Tenant', 'billing_company')`, [T]);
    await pool.query(
      `INSERT INTO client (client_id, tenant_id, client_name, npi_group)
       VALUES ($1, $2, 'Balance Test Group', '1234567890')`, [C, T]);
    await pool.query(
      `INSERT INTO payer (payer_id, payer_name, payer_type, payer_id_code, appeal_deadline_days)
       VALUES ($1, 'Balance Test Payer', 'commercial', 'BAL-1', 180)`, [P]);
    const contract = await pool.query(
      `INSERT INTO contract (tenant_id, client_id, payer_id, effective_date,
                             fee_schedule_type, status, approved_at)
       VALUES ($1, $2, $3, '2026-01-01', 'fee_schedule', 'active', now())
       RETURNING contract_id`, [T, C, P]);
    await pool.query(
      `INSERT INTO contract_line (tenant_id, contract_id, procedure_code, allowed_amount)
       VALUES ($1, $2, '99213', 200.00)`, [T, contract.rows[0].contract_id]);
    await pool.query(
      `INSERT INTO client_payer_config (tenant_id, client_id, payer_id, autopilot_enabled)
       VALUES ($1, $2, $3, false)`, [T, C, P]);
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  // -------------------------------------------------------------------------
  it('rejects an out-of-balance 835 under the strict policy and writes nothing', async () => {
    const { ingest835Job } = await import('../src/ingest/service.ts');
    const unbalanced = era([
      'BPR*I*80.00*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260625~',
      'TRN*1*CHK-BAD*1~',
      'N1*PR*Balance Test Payer*PI*BAL-1~',
      'CLP*BAD-1*1*250.00*80.00*0*12*BAD-ICN-1~',
      'SVC*HC:99213*250.00*80.00**1~',
      'CAS*CO*45*150~',   // $20 unexplained
    ]);

    await assert.rejects(
      () => ingest835Job(pool, {
        tenantId: T, clientId: C, content: unbalanced, fileName: 'bad.835',
      }),
      /does not balance/);

    const written = await pool.query(
      `SELECT count(*)::int AS n FROM remittance WHERE tenant_id = $1 AND check_number = 'CHK-BAD'`,
      [T]);
    assert.equal(written.rows[0].n, 0, 'nothing was written');

    const job = await pool.query(
      `SELECT status, log_output FROM system_job
       WHERE tenant_id = $1 AND job_type = 'ingest_835'
       ORDER BY started_at DESC LIMIT 1`, [T]);
    assert.equal(job.rows[0].status, 'failed');
    assert.match(String(job.rows[0].log_output), /does not balance/);
  });

  it('loads the same file under the warn policy and records the imbalance', async () => {
    const { ingest835Job } = await import('../src/ingest/service.ts');
    await pool.query(`UPDATE client SET era_balance_policy = 'warn' WHERE client_id = $1`, [C]);
    const unbalanced = era([
      'BPR*I*80.00*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260625~',
      'TRN*1*CHK-WARN*1~',
      'N1*PR*Balance Test Payer*PI*BAL-1~',
      'CLP*WARN-1*1*250.00*80.00*0*12*WARN-ICN-1~',
      'SVC*HC:99213*250.00*80.00**1~',
      'CAS*CO*45*150~',
    ]);
    const out = await ingest835Job(pool, {
      tenantId: T, clientId: C, content: unbalanced, fileName: 'warn.835',
    });
    assert.equal(out.recordsProcessed, 1);
    assert.ok(out.warnings.some((w: string) => /out of balance/.test(w)));

    const remit = await pool.query(
      `SELECT balance_status, balance_variance, balance_detail FROM remittance
       WHERE tenant_id = $1 AND check_number = 'CHK-WARN'`, [T]);
    assert.equal(remit.rows[0].balance_status, 'out_of_balance');
    // The check total ties out; it is the claim and line rules that fail, so
    // the stored detail is what tells an operator what to take back to the
    // payer — the transaction variance alone would read as zero.
    assert.equal(Number(remit.rows[0].balance_variance), 0);
    const rules = remit.rows[0].balance_detail.map((f: any) => f.rule);
    assert.deepEqual(rules.sort(), ['claim', 'service_line']);
    assert.match(remit.rows[0].balance_detail[0].message, /less adjustments/);

    await pool.query(`UPDATE client SET era_balance_policy = 'strict' WHERE client_id = $1`, [C]);
  });

  it('accepts a conforming 835 within the client tolerance', async () => {
    const { ingest835Job } = await import('../src/ingest/service.ts');
    await pool.query(
      `UPDATE client SET era_balance_tolerance = 0.02 WHERE client_id = $1`, [C]);
    const out = await ingest835Job(pool, {
      tenantId: T, clientId: C, fileName: 'rounding.835',
      content: era([
        'BPR*I*79.99*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260625~',
        'TRN*1*CHK-ROUND*1~',
        'N1*PR*Balance Test Payer*PI*BAL-1~',
        'CLP*ROUND-1*1*250.00*80.00*0*12*ROUND-ICN-1~',
        'SVC*HC:99213*250.00*80.00**1~',
        'CAS*CO*45*170~',
      ]),
    });
    assert.equal(out.recordsProcessed, 1);
    const remit = await pool.query(
      `SELECT balance_status FROM remittance WHERE tenant_id = $1 AND check_number = 'CHK-ROUND'`,
      [T]);
    assert.equal(remit.rows[0].balance_status, 'balanced');
    await pool.query(`UPDATE client SET era_balance_tolerance = 0 WHERE client_id = $1`, [C]);
  });

  // -------------------------------------------------------------------------
  it('persists PLB adjustments, categorized and linked to the recouped claim', async () => {
    const { ingest835Job } = await import('../src/ingest/service.ts');
    const seeded = await seedClaim('PLB-CLM-1', 'PLB-ICN-1');
    assert.ok(seeded.claimId);

    const out = await ingest835Job(pool, {
      tenantId: T, clientId: C, fileName: 'plb.835',
      content: era([
        // 80.00 paid - (125.00 - 3.10) = -41.90
        'BPR*I*-41.90*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260626~',
        'TRN*1*CHK-PLB*1~',
        'N1*PR*Balance Test Payer*PI*BAL-1~',
        'CLP*OTHER-1*1*250.00*80.00*0*12*OTHER-ICN~',
        'SVC*HC:99213*250.00*80.00**1~',
        'CAS*CO*45*170~',
        'PLB*1234567890*20261231*WO:PLB-ICN-1*125.00*L6:INT-1*-3.10~',
      ]),
    });
    assert.ok(out.warnings.some((w: string) => /recoupment of \$125\.00/.test(w)));

    const plb = await pool.query(
      `SELECT pa.reason_code, pa.category, pa.reference_id, pa.amount, pa.claim_id,
              pa.sequence_number, pa.provider_npi
       FROM remittance_provider_adjustment pa
       JOIN remittance r ON r.remittance_id = pa.remittance_id
       WHERE r.check_number = 'CHK-PLB' ORDER BY pa.sequence_number`, []);
    assert.equal(plb.rows.length, 2);
    assert.equal(plb.rows[0].reason_code, 'WO');
    assert.equal(plb.rows[0].category, 'recoupment');
    assert.equal(Number(plb.rows[0].amount), 125);
    assert.equal(plb.rows[0].claim_id, seeded.claimId, 'linked to the recouped claim by ICN');
    assert.equal(plb.rows[0].provider_npi, '1234567890');
    assert.equal(plb.rows[1].reason_code, 'L6');
    assert.equal(plb.rows[1].category, 'interest');
    assert.equal(plb.rows[1].claim_id, null, 'no claim carries that reference');

    const remit = await pool.query(
      `SELECT balance_status, provider_adjustment_total, claim_payment_total
       FROM remittance WHERE check_number = 'CHK-PLB'`, []);
    assert.equal(remit.rows[0].balance_status, 'balanced');
    assert.equal(Number(remit.rows[0].provider_adjustment_total), 121.9);
    assert.equal(Number(remit.rows[0].claim_payment_total), 80);
  });

  // -------------------------------------------------------------------------
  it('persists reversal and adjudication detail, and creates no case from a reversal',
    async () => {
      const { ingest835Job } = await import('../src/ingest/service.ts');
      const { runDetectionJob } = await import('../src/service.ts');
      const seeded = await seedClaim('REV-CLM-1', 'REV-ICN-1');

      // original payment: $200, exactly the contract rate — nothing owed
      await ingest835Job(pool, {
        tenantId: T, clientId: C, fileName: 'rev-1.835',
        content: era([
          'BPR*I*200.00*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260626~',
          'TRN*1*CHK-REV-1*1~',
          'N1*PR*Balance Test Payer*PI*BAL-1~',
          'CLP*REV-CLM-1*1*250.00*200.00*0*12*REV-ICN-1~',
          'SVC*HC:99213*250.00*200.00**1~',
          'CAS*CO*45*50~',
        ]),
      });
      await runDetectionJob(pool, { tenantId: T, clientId: C, asOf: '2026-06-27' });

      // then the payer reverses it and pays nothing back yet
      await ingest835Job(pool, {
        tenantId: T, clientId: C, fileName: 'rev-2.835',
        content: era([
          'BPR*I*-200.00*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260701~',
          'TRN*1*CHK-REV-2*1~',
          'N1*PR*Balance Test Payer*PI*BAL-1~',
          'CLP*REV-CLM-1*22*-250.00*-200.00*0*12*REV-ICN-1~',
          'SVC*HC:99213*-250.00*-200.00**1~',
          'CAS*CO*45*-50~',
        ]),
      });

      const stored = await pool.query(
        `SELECT rl.claim_status_code, rl.is_reversal, rl.paid_units, rl.payer_recoded
         FROM remittance_line rl JOIN remittance r ON r.remittance_id = rl.remittance_id
         WHERE r.check_number = 'CHK-REV-2'`, []);
      assert.equal(stored.rows[0].claim_status_code, '22');
      assert.equal(stored.rows[0].is_reversal, true);
      assert.equal(stored.rows[0].payer_recoded, false);

      const before = await pool.query(
        `SELECT count(*)::int AS n FROM recovery_case WHERE claim_id = $1`, [seeded.claimId]);
      const result = await runDetectionJob(pool, {
        tenantId: T, clientId: C, asOf: '2026-07-02',
      });
      const after = await pool.query(
        `SELECT count(*)::int AS n FROM recovery_case WHERE claim_id = $1`, [seeded.claimId]);

      assert.equal(after.rows[0].n, before.rows[0].n,
        'the reversal alone must not open a $200 "underpayment"');
      const summary = result.result.summary;
      assert.ok(summary.reversals.lines >= 1, 'the reversal is reported');
      assert.ok(summary.anomalies.some((a: any) => a.type === 'payment_reversed'));
    });

  it('records the payer re-code and the submitted code it belongs to', async () => {
    const { ingest835Job } = await import('../src/ingest/service.ts');
    await seedClaim('RECODE-CLM-1', 'RECODE-ICN-1');
    await ingest835Job(pool, {
      tenantId: T, clientId: C, fileName: 'recode.835',
      content: era([
        'BPR*I*70.00*C*ACH*CCP*01*9*DA*1*1**01*9*DA*1*20260626~',
        'TRN*1*CHK-RECODE*1~',
        'N1*PR*Balance Test Payer*PI*BAL-1~',
        'CLP*RECODE-CLM-1*1*250.00*70.00*0*12*RECODE-ICN-1~',
        // submitted 99213, adjudicated as 99212, and 3 units cut to 1
        'SVC*HC:99212*250.00*70.00**1*HC:99213*3~',
        'CAS*CO*45*180~',
      ]),
    });
    const line = await pool.query(
      `SELECT rl.procedure_code, rl.adjudicated_procedure_code, rl.payer_recoded,
              rl.paid_units, rl.original_units
       FROM remittance_line rl JOIN remittance r ON r.remittance_id = rl.remittance_id
       WHERE r.check_number = 'CHK-RECODE'`, []);
    assert.equal(line.rows[0].procedure_code, '99213', 'matched on what we submitted');
    assert.equal(line.rows[0].adjudicated_procedure_code, '99212');
    assert.equal(line.rows[0].payer_recoded, true);
    assert.equal(Number(line.rows[0].paid_units), 1);
    assert.equal(Number(line.rows[0].original_units), 3);
  });

  // -------------------------------------------------------------------------
  // ---- recovery attribution ----------------------------------------------
  // Flat rather than nested: a nested describe's async setup is not awaited by
  // the outer after() hook, which closes the pool out from under it.
  let attrCaseId: string;
  let attrClaimId: string;
  let attrClaimLineId: string;
  let attrSiblingLineId: string;

  async function seedAttributionCase() {
    const seeded = await seedClaim('ATTR-CLM-1', 'ATTR-ICN-1');
    attrClaimId = seeded.claimId;
    attrClaimLineId = seeded.claimLineId;
    const sibling = await pool.query(
      `INSERT INTO claim_line (tenant_id, claim_id, line_number, procedure_code, units,
                               billed_amount)
       VALUES ($1, $2, 2, '99214', 1, 400) RETURNING claim_line_id`, [T, attrClaimId]);
    attrSiblingLineId = sibling.rows[0].claim_line_id;

    const rc = await pool.query(
      `INSERT INTO recovery_case
         (tenant_id, client_id, claim_id, claim_line_id, case_type, status,
          recovery_opportunity, priority_level, deadline_date)
       VALUES ($1, $2, $3, $4, 'underpayment', 'submitted', 120, 'high',
               CURRENT_DATE + 60)
       RETURNING case_id`, [T, C, attrClaimId, attrClaimLineId]);
    attrCaseId = rc.rows[0].case_id;
    await pool.query(
      `INSERT INTO appeal_packet (tenant_id, case_id, appeal_type, packet_status, submitted_at)
       VALUES ($1, $2, 'first_level', 'submitted', now() - interval '1 day')`, [T, attrCaseId]);
  }

  /** Post a remittance line dated after the appeal went out. */
  async function postRemit(opts: {
    check: string; paid: number; claimLineId?: string | null; reversal?: boolean;
  }): Promise<string> {
    const rem = await pool.query(
      `INSERT INTO remittance (tenant_id, client_id, payer_id, check_date, check_number,
                               total_paid, balance_status)
       VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, 'balanced') RETURNING remittance_id`,
      [T, C, P, opts.check, opts.paid]);
    await pool.query(
      `INSERT INTO remittance_line (tenant_id, remittance_id, claim_id, claim_line_id,
                                    paid_amount, is_reversal, match_method)
       VALUES ($1, $2, $3, $4, $5, $6, 'payer_claim_number')`,
      [T, rem.rows[0].remittance_id, attrClaimId,
       opts.claimLineId === undefined ? attrClaimLineId : opts.claimLineId,
       opts.paid, opts.reversal ?? false]);
    return rem.rows[0].remittance_id;
  }

  it('attribution: ignores payment landing on a different line of the same claim', async () => {
    const { runPaymentReconciliation } = await import('../src/automation/jobs.ts');
    await seedAttributionCase();
    await postRemit({ check: 'CHK-SIBLING', paid: 500, claimLineId: attrSiblingLineId });
    const out = await runPaymentReconciliation(pool, { tenantId: T, clientId: C });
    assert.equal(out.matched, 0, 'a sibling line is not this case recovery');
    const pe = await pool.query(
      `SELECT count(*)::int AS n FROM payment_event WHERE case_id = $1`, [attrCaseId]);
    assert.equal(pe.rows[0].n, 0);
  });

  it('attribution: line-scoped cash, net of a reversal on the same line', async () => {
    const { runPaymentReconciliation } = await import('../src/automation/jobs.ts');
    await postRemit({ check: 'CHK-ATTR-1', paid: 100 });
    await postRemit({ check: 'CHK-ATTR-REV', paid: -40, reversal: true });

    const out = await runPaymentReconciliation(pool, { tenantId: T, clientId: C });
    assert.equal(out.matched, 1);
    assert.equal(out.recovered, 60, '100 paid less 40 reversed');
    assert.equal(out.partial, 1, 'still short of the $120 opportunity');

    const pe = await pool.query(
      `SELECT amount_recovered, attribution_basis, attribution_scope, claim_line_id,
              gross_post_appeal_paid, reversals_netted, recoupments_netted,
              unallocated_paid, notes
       FROM payment_event WHERE case_id = $1`, [attrCaseId]);
    assert.equal(pe.rows.length, 1);
    assert.equal(Number(pe.rows[0].amount_recovered), 60);
    assert.equal(pe.rows[0].attribution_basis, 'incremental_net');
    assert.equal(pe.rows[0].attribution_scope, 'claim_line');
    assert.equal(pe.rows[0].claim_line_id, attrClaimLineId);
    assert.equal(Number(pe.rows[0].gross_post_appeal_paid), 100);
    assert.equal(Number(pe.rows[0].reversals_netted), 40);
    assert.equal(Number(pe.rows[0].unallocated_paid), 0);
    assert.match(pe.rows[0].notes, /less \$40\.00 reversed/);

    const status = await pool.query(
      `SELECT status FROM recovery_case WHERE case_id = $1`, [attrCaseId]);
    assert.equal(status.rows[0].status, 'submitted', 'partial recovery leaves it open');
  });

  it('attribution: does not double-count the same cash on the next run', async () => {
    const { runPaymentReconciliation } = await import('../src/automation/jobs.ts');
    const out = await runPaymentReconciliation(pool, { tenantId: T, clientId: C });
    assert.equal(out.matched, 0);
    assert.equal(out.recouped, 0);
  });

  it('attribution: nets a PLB recoupment and reverses the credited recovery out', async () => {
    const { runPaymentReconciliation } = await import('../src/automation/jobs.ts');
    const remittanceId = await postRemit({ check: 'CHK-ATTR-PLB', paid: 0 });
    await pool.query(
      `INSERT INTO remittance_provider_adjustment
         (tenant_id, remittance_id, sequence_number, reason_code, reference_id,
          amount, category, claim_id, matched_at)
       VALUES ($1, $2, 1, 'WO', 'ATTR-ICN-1', 25.00, 'recoupment', $3, now())`,
      [T, remittanceId, attrClaimId]);

    const out = await runPaymentReconciliation(pool, { tenantId: T, clientId: C });
    assert.equal(out.recouped, 1);
    assert.equal(out.clawedBack, 25);
    assert.equal(out.recovered, -25);

    const total = await pool.query(
      `SELECT COALESCE(sum(amount_recovered), 0) AS net FROM payment_event WHERE case_id = $1`,
      [attrCaseId]);
    assert.equal(Number(total.rows[0].net), 35, '60 attributed less 25 taken back');

    const action = await pool.query(
      `SELECT notes FROM case_action
       WHERE case_id = $1 AND action_type = 'payment_recouped'`, [attrCaseId]);
    assert.equal(action.rows.length, 1);
    assert.match(action.rows[0].notes, /taken back after appeal/);
  });

  it('attribution: never reverses a recovery a person matched by hand', async () => {
    const { runPaymentReconciliation } = await import('../src/automation/jobs.ts');
    const seeded = await seedClaim('MANUAL-CLM-1', 'MANUAL-ICN-1');
    const rc = await pool.query(
      `INSERT INTO recovery_case
         (tenant_id, client_id, claim_id, claim_line_id, case_type, status,
          recovery_opportunity, priority_level, deadline_date)
       VALUES ($1, $2, $3, $4, 'underpayment', 'submitted', 90, 'high', CURRENT_DATE + 60)
       RETURNING case_id`, [T, C, seeded.claimId, seeded.claimLineId]);
    const manualCaseId = rc.rows[0].case_id;
    await pool.query(
      `INSERT INTO appeal_packet (tenant_id, case_id, appeal_type, packet_status, submitted_at)
       VALUES ($1, $2, 'first_level', 'submitted', now() - interval '1 day')`,
      [T, manualCaseId]);
    // a biller verified and recorded this recovery themselves
    await pool.query(
      `INSERT INTO payment_event
         (tenant_id, case_id, claim_line_id, claim_id, amount_recovered, payment_date,
          matched_automatically, attribution_basis, notes)
       VALUES ($1, $2, $3, $4, 90, CURRENT_DATE, false, 'manual', 'verified against the EOB')`,
      [T, manualCaseId, seeded.claimLineId, seeded.claimId]);

    // the payer then recoups against the claim
    const rem = await pool.query(
      `INSERT INTO remittance (tenant_id, client_id, payer_id, check_date, check_number,
                               total_paid, balance_status)
       VALUES ($1, $2, $3, CURRENT_DATE, 'CHK-MANUAL-PLB', 0, 'balanced')
       RETURNING remittance_id`, [T, C, P]);
    await pool.query(
      `INSERT INTO remittance_provider_adjustment
         (tenant_id, remittance_id, sequence_number, reason_code, reference_id,
          amount, category, claim_id, matched_at)
       VALUES ($1, $2, 1, 'WO', 'MANUAL-ICN-1', 90.00, 'recoupment', $3, now())`,
      [T, rem.rows[0].remittance_id, seeded.claimId]);

    const out = await runPaymentReconciliation(pool, { tenantId: T, clientId: C });
    assert.equal(out.clawedBack, 0, 'nothing automatic to reverse');

    const events = await pool.query(
      `SELECT amount_recovered, attribution_basis FROM payment_event WHERE case_id = $1`,
      [manualCaseId]);
    assert.equal(events.rows.length, 1, 'the manual recovery stands untouched');
    assert.equal(Number(events.rows[0].amount_recovered), 90);

    // but the operator is still told the payer took the money back
    const action = await pool.query(
      `SELECT notes FROM case_action
       WHERE case_id = $1 AND action_type = 'payment_recouped'`, [manualCaseId]);
    assert.equal(action.rows.length, 1);
    assert.match(action.rows[0].notes, /No automatically attributed recovery to reverse/);
  });

  it('attribution: takes payment the payer never resolved to a line, and says so', async () => {
    const { runPaymentReconciliation } = await import('../src/automation/jobs.ts');
    await postRemit({ check: 'CHK-ATTR-HEADER', paid: 30, claimLineId: null });
    const out = await runPaymentReconciliation(pool, { tenantId: T, clientId: C });
    assert.equal(out.matched, 1);
    assert.equal(out.recovered, 30);

    const pe = await pool.query(
      `SELECT unallocated_paid, notes FROM payment_event
       WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`, [attrCaseId]);
    assert.equal(Number(pe.rows[0].unallocated_paid), 30);
    assert.match(pe.rows[0].notes, /not resolved to a service line/);
  });
});
