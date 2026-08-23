// ============================================================================
// NCCI edits loaded from real imported reference data.
//
// The pure logic is covered in ncci.test.ts. What is proved here is the part
// that only a database can prove: that the snapshot picks the right CMS
// dataset, that it does not load edits the run cannot use, and that an
// indicator-0 pair reaches the engine and changes what the case says.
//
//   TEST_DATABASE_URL=postgres://... node --test test/ncci_integration.test.ts
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

const T = '88888888-0000-0000-0000-000000000001';
const C = '88888888-0000-0000-0000-000000000002';
const P = '88888888-0000-0000-0000-000000000003';

let pool: any;

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query(`SET session_replication_role = replica`);
    for (const t of [
      'remittance_line', 'remittance', 'claim_line', 'claim', 'encounter',
      'patient', 'provider', 'contract_line', 'contract', 'client_payer_config',
      'audit_log', 'client',
    ]) await c.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [T]);
    await c.query(`DELETE FROM payer WHERE payer_id = $1`, [P]);
    await c.query(`DELETE FROM tenant WHERE tenant_id = $1`, [T]);
    await c.query(
      `DELETE FROM reference_dataset WHERE dataset_kind = 'ncci_ptp'
         AND version LIKE 'TEST-%'`);
    await c.query(`SET session_replication_role = DEFAULT`);
  } finally { c.release(); }
}

/**
 * A dataset of PTP edits. `version` distinguishes quarters; `scope` is the CMS
 * table (the importer stores the service setting there).
 */
async function seedNcciDataset(
  version: string, setting: 'practitioner' | 'outpatient_hospital',
  effectiveDate: string,
  edits: Array<[string, string, 0 | 1 | 9, string]>,
): Promise<void> {
  const ds = await pool.query(
    `INSERT INTO reference_dataset
       (dataset_kind, version, scope, source_url, effective_date, source_sha256, row_count)
     VALUES ('ncci_ptp', $1, $2, 'https://www.cms.gov/ncci-test', $3::date, $4, $5)
     RETURNING dataset_id`,
    [version, setting, effectiveDate, version.padEnd(64, '0').slice(0, 64)
      .replace(/[^0-9a-f]/g, '0'), edits.length]);
  for (const [one, two, indicator, editEffective] of edits) {
    await pool.query(
      `INSERT INTO ncci_ptp_edit (dataset_id, service_setting, column_one_code,
                                  column_two_code, effective_date, modifier_indicator)
       VALUES ($1,$2,$3,$4,$5::date,$6)`,
      [ds.rows[0].dataset_id, setting, one, two, editEffective, indicator]);
  }
}

/** A claim whose second line was denied CO-97 while the first was paid. */
async function seedBundlingDenial(modifier: string | null): Promise<void> {
  const patient = await pool.query(
    `INSERT INTO patient (tenant_id, client_id, mrn, first_name, last_name)
     VALUES ($1,$2,$3,'Pat','Ient') RETURNING patient_id`,
    [T, C, `NMRN-${modifier ?? 'none'}`]);
  const provider = await pool.query(
    `INSERT INTO provider (tenant_id, client_id, npi_individual, name)
     VALUES ($1,$2,$3,'Dr NCCI') RETURNING provider_id`,
    [T, C, modifier ? '4000000001' : '4000000002']);
  const enc = await pool.query(
    `INSERT INTO encounter (tenant_id, client_id, patient_id, provider_id,
                            date_of_service_start, status)
     VALUES ($1,$2,$3,$4,'2026-06-01','billed') RETURNING encounter_id`,
    [T, C, patient.rows[0].patient_id, provider.rows[0].provider_id]);
  const claim = await pool.query(
    `INSERT INTO claim (tenant_id, client_id, encounter_id, payer_id, claim_type,
                        claim_number_internal, claim_number_payer, billed_amount,
                        claim_status, submission_date)
     VALUES ($1,$2,$3,$4,'professional',$5,$5,550,'submitted','2026-06-05')
     RETURNING claim_id`,
    [T, C, enc.rows[0].encounter_id, P, `NCLM-${modifier ?? 'none'}`]);
  await pool.query(
    `INSERT INTO claim_line (tenant_id, claim_id, line_number, procedure_code,
                             units, billed_amount, paid_amount)
     VALUES ($1,$2,1,'11042',1,300,220)`, [T, claim.rows[0].claim_id]);
  await pool.query(
    `INSERT INTO claim_line (tenant_id, claim_id, line_number, procedure_code,
                             modifier_1, units, billed_amount, paid_amount)
     VALUES ($1,$2,2,'97597',$3,1,250,0)`,
    [T, claim.rows[0].claim_id, modifier]);

  const r = await pool.query(
    `INSERT INTO remittance (tenant_id, client_id, payer_id, check_number, check_date)
     VALUES ($1,$2,$3,$4,'2026-06-20') RETURNING remittance_id`,
    [T, C, P, `NCHK-${modifier ?? 'none'}`]);
  await pool.query(
    `INSERT INTO remittance_line (tenant_id, remittance_id, payer_claim_number,
                                  procedure_code, date_of_service, billed_amount,
                                  allowed_amount, paid_amount, patient_responsibility,
                                  adjustment_group_code, adjustment_reason_code, adjustments)
     VALUES ($1,$2,$3,'97597','2026-06-01',250,0,0,0,'CO','97',$4::jsonb)`,
    [T, r.rows[0].remittance_id, `NCLM-${modifier ?? 'none'}`,
     JSON.stringify([{ groupCode: 'CO', reasonCode: '97', amount: 250 }])]);
}

const snapshot = async () => {
  const { loadSnapshot } = await import('../src/db/snapshot.ts');
  return loadSnapshot(pool, { tenantId: T, clientId: C, asOf: '2026-07-01' });
};

describe('NCCI edits from imported reference data',
  { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
    before(async () => {
      const { default: pg } = await import('pg');
      pool = new pg.Pool({ connectionString: url });
      await cleanup();
      await pool.query(
        `INSERT INTO tenant (tenant_id, tenant_name, tenant_type)
         VALUES ($1,'NCCI Tenant','billing_company')`, [T]);
      await pool.query(
        `INSERT INTO client (client_id, tenant_id, client_name, npi_group)
         VALUES ($1,$2,'NCCI Group','1234567890')`, [C, T]);
      await pool.query(
        `INSERT INTO payer (payer_id, payer_name, payer_type, appeal_deadline_days)
         VALUES ($1,'NCCI Payer','commercial',180)`, [P]);
      const ct = await pool.query(
        `INSERT INTO contract (tenant_id, client_id, payer_id,
                               effective_date, fee_schedule_type, status, approved_at)
         VALUES ($1,$2,$3,'2026-01-01','fee_schedule','active', now())
         RETURNING contract_id`, [T, C, P]);
      for (const [code, rate] of [['11042', 220], ['97597', 200]] as const) {
        await pool.query(
          `INSERT INTO contract_line (tenant_id, contract_id, procedure_code, allowed_amount)
           VALUES ($1,$2,$3,$4)`, [T, ct.rows[0].contract_id, code, rate]);
      }
      await pool.query(
        `INSERT INTO client_payer_config (tenant_id, client_id, payer_id, autopilot_enabled)
         VALUES ($1,$2,$3,false)`, [T, C, P]);
      await pool.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [T]);
    });

    after(async () => { await cleanup(); await pool.end(); });

    it('reports no NCCI data loaded rather than inventing an answer', async () => {
      await seedBundlingDenial('59');
      const input = await snapshot();
      assert.deepEqual(input.ncciDatasets, [],
        'no ncci_ptp dataset has been imported for this database');
      const { runEngine } = await import('../src/engine.ts');
      const r = runEngine(input);
      const c = r.casesCreated.find((x: any) => x.caseType === 'bundling');
      assert.ok(c, 'the bundling denial is still worked');
      assert.match(c!.evidenceNote ?? '', /could not be checked against CMS edits/);
    });

    it('consults only the newest dataset for a service setting', async () => {
      // The CMS PTP files are cumulative quarterly replacements. Loading two
      // quarters at once would revive an edit the newer file withdrew, so only
      // the latest is read.
      await seedNcciDataset('TEST-2025Q1', 'practitioner', '2025-01-01',
        [['11042', '97597', 0, '2020-01-01']]);
      await seedNcciDataset('TEST-2026Q2', 'practitioner', '2026-04-01',
        [['11042', '97597', 1, '2020-01-01']]);
      // ...and a table for the other setting, which a professional claim
      // must not be answered from.
      await seedNcciDataset('TEST-2026Q2-OPH', 'outpatient_hospital', '2026-04-01',
        [['11042', '97597', 0, '2020-01-01']]);

      const input = await snapshot();
      assert.equal(input.ncciDatasets!.length, 2, 'one dataset per service setting');
      assert.deepEqual(
        input.ncciDatasets!.map((d: any) => d.version).sort(),
        ['TEST-2026Q2', 'TEST-2026Q2-OPH']);
      const practitioner = input.ncciEdits!.filter(
        (e: any) => e.serviceSetting === 'practitioner');
      assert.equal(practitioner.length, 1);
      assert.equal(practitioner[0].modifierIndicator, 1,
        'the withdrawn indicator-0 edit from the older quarter is not loaded');
    });

    it('loads only edits whose both sides appear on the run', async () => {
      await seedNcciDataset('TEST-2026Q2-WIDE', 'practitioner', '2026-04-02',
        [['11042', '97597', 1, '2020-01-01'],
         ['29580', '36415', 0, '2020-01-01'],
         ['11042', '36415', 0, '2020-01-01']]);
      const input = await snapshot();
      // Only 11042/97597 has both codes on the claim. The pairs involving
      // 36415 are in the same dataset and are not loaded: the published tables
      // run to millions of rows, and pulling them wholesale to answer one
      // question is the difference between a snapshot and a memory leak.
      const practitioner = input.ncciEdits!.filter(
        (e: any) => e.serviceSetting === 'practitioner');
      assert.equal(practitioner.length, 1);
      assert.equal(practitioner[0].columnOneCode, '11042');
      assert.equal(practitioner[0].columnTwoCode, '97597');
      assert.equal(
        input.ncciEdits!.some((e: any) => e.columnTwoCode === '36415'), false,
        'a pair whose column-two code is not on any line of the run is never loaded');
    });

    it('carries an indicator-1 override the payer ignored through to the case',
      async () => {
        const { runEngine } = await import('../src/engine.ts');
        const r = runEngine(await snapshot());
        const c = r.casesCreated.find((x: any) => x.caseType === 'bundling');
        assert.ok(c);
        assert.equal(c!.recoveryLikelihood, 'high');
        assert.match(c!.recommendedAction, /modifier 59 was billed/);
        assert.match(c!.evidenceNote ?? '', /modifier indicator 1/);
      });

    it('turns an indicator-0 pair into a case that says not to appeal', async () => {
      await pool.query(
        `UPDATE ncci_ptp_edit SET modifier_indicator = 0
         WHERE dataset_id IN (SELECT dataset_id FROM reference_dataset
                              WHERE version = 'TEST-2026Q2-WIDE')`);
      const { runEngine } = await import('../src/engine.ts');
      const input = await snapshot();
      const r = runEngine(input);
      const c = r.casesCreated.find((x: any) => x.caseType === 'bundling');
      assert.ok(c);
      assert.equal(c!.recoveryLikelihood, 'low');
      assert.match(c!.recommendedAction, /Do not appeal/);

      // ...and the client can ask for it not to be opened at all.
      await pool.query(
        `UPDATE client SET ncci_bundling_policy = 'suppress_unappealable'
         WHERE client_id = $1`, [C]);
      const suppressed = runEngine(await snapshot());
      assert.equal(
        suppressed.casesCreated.some((x: any) => x.caseType === 'bundling'), false);
      assert.equal(
        suppressed.skipped.filter(
          (x: any) => x.reason === 'ncci_not_separately_payable').length, 1);
      await pool.query(
        `UPDATE client SET ncci_bundling_policy = 'advisory' WHERE client_id = $1`, [C]);
    });
  });
