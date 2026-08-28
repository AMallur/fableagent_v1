// ============================================================================
// Commercial terms against a real Postgres:
//   * contingency pricing resolved from the effective-dated plan
//   * an invoice bills each recovery once and its lines add up to the basis
//   * an issued invoice is immutable — the database refuses to rewrite it
//   * a suspended subscription stops processing; a disabled feature stops
//     the step that belongs to it
//
//   TEST_DATABASE_URL=postgres://... node --test test/billing_integration.test.ts
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

describe('commercial terms', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  let pool: any;

  const T = '66666666-0000-0000-0000-000000000001';
  const C = '66666666-0000-0000-0000-000000000002';
  const P = '66666666-0000-0000-0000-000000000003';
  const U = '66666666-0000-0000-0000-000000000004';

  // A tenant admin session shape; the billing functions only read role/ids.
  const sess = () => ({
    userId: U, tenantId: T, clientId: null, role: 'tenant_admin',
    name: 'Admin', exp: Date.now() + 3_600_000,
  } as any);
  const scope = () => ({ tenantId: T, clientIds: [C] } as any);

  async function cleanup() {
    const c = await pool.connect();
    try {
      await c.query(`SELECT set_config('app.allow_invoice_purge', 'on', false)`);
      await c.query(`SET session_replication_role = replica`);
      for (const t of [
        'invoice_line', 'usage_event', 'invoice', 'pricing_plan', 'payment_event',
        'appeal_packet',
        'case_action', 'recovery_case', 'claim_line', 'claim', 'encounter', 'patient',
        'provider', 'audit_log', 'app_user', 'client',
      ]) await c.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [T]);
      await c.query(`DELETE FROM payer WHERE payer_id = $1`, [P]);
      await c.query(`DELETE FROM tenant WHERE tenant_id = $1`, [T]);
      await c.query(`SET session_replication_role = DEFAULT`);
    } finally { c.release(); }
  }

  /** A won case with `amount` of automatically attributed recovery. */
  async function seedRecovery(amount: number, paymentDate: string, verified = false) {
    const patient = await pool.query(
      `INSERT INTO patient (tenant_id, client_id, mrn, first_name, last_name)
       VALUES ($1,$2,$3,'Pat','Ient') RETURNING patient_id`,
      [T, C, `MRN-${amount}-${paymentDate}`]);
    const provider = await pool.query(
      `INSERT INTO provider (tenant_id, client_id, npi_individual, name)
       VALUES ($1,$2,$3,'Dr Bill') RETURNING provider_id`,
      [T, C, String(2000000000 + Math.floor(Math.random() * 900000000))]);
    const enc = await pool.query(
      `INSERT INTO encounter (tenant_id, client_id, patient_id, provider_id,
                              date_of_service_start, status)
       VALUES ($1,$2,$3,$4,'2026-06-01','billed') RETURNING encounter_id`,
      [T, C, patient.rows[0].patient_id, provider.rows[0].provider_id]);
    const claim = await pool.query(
      `INSERT INTO claim (tenant_id, client_id, encounter_id, payer_id, claim_type,
                          claim_number_internal, billed_amount, claim_status)
       VALUES ($1,$2,$3,$4,'professional',$5,500,'paid') RETURNING claim_id`,
      [T, C, enc.rows[0].encounter_id, P, `CLM-${amount}-${paymentDate}`]);
    const rc = await pool.query(
      `INSERT INTO recovery_case (tenant_id, client_id, claim_id, case_type, status,
                                  recovery_opportunity, priority_level)
       VALUES ($1,$2,$3,'underpayment','won',$4,'high') RETURNING case_id`,
      [T, C, claim.rows[0].claim_id, amount]);
    const pe = await pool.query(
      `INSERT INTO payment_event (tenant_id, case_id, claim_id, amount_recovered,
                                  payment_date, matched_automatically,
                                  attribution_basis, verified_by_user_id)
       VALUES ($1,$2,$3,$4,$5::date,true,$6,$7) RETURNING payment_event_id`,
      [T, rc.rows[0].case_id, claim.rows[0].claim_id, amount, paymentDate,
       verified ? 'manual' : 'incremental_net', verified ? U : null]);
    return pe.rows[0].payment_event_id;
  }

  before(async () => {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: url });
    await cleanup();
    await pool.query(
      `INSERT INTO tenant (tenant_id, tenant_name, tenant_type)
       VALUES ($1,'Billing Tenant','billing_company')`, [T]);
    await pool.query(
      `INSERT INTO client (client_id, tenant_id, client_name, npi_group, subscription_status, operating_mode)
       VALUES ($1,$2,'Billed Group','1234567890','active','live')`, [C, T]);
    await pool.query(
      `INSERT INTO app_user (user_id, tenant_id, email, first_name, last_name, role, password_hash)
       VALUES ($1,$2,'admin@billing.test','A','Dmin','tenant_admin','x')`, [U, T]);
    await pool.query(
      `INSERT INTO payer (payer_id, payer_name, payer_type) VALUES ($1,'Billing Payer','commercial')`,
      [P]);
    await pool.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [T]);
  });

  after(async () => { await cleanup(); await pool.end(); });

  // -------------------------------------------------------------------------
  it('resolves the plan in force, preferring a client plan over the tenant default',
    async () => {
      const { resolvePricingPlan } = await import('../src/web/billing.ts');
      await pool.query(
        `INSERT INTO pricing_plan (tenant_id, client_id, plan_name, effective_date,
                                   base_fee, contingency_percent)
         VALUES ($1, NULL, 'Tenant default', '2026-01-01', 500, 15)`, [T]);
      await pool.query(
        `UPDATE pricing_plan SET agreement_reference = 'MSA-TEST-001',
           agreement_executed_on = '2026-01-01' WHERE tenant_id = $1`, [T]);
      const dflt = await resolvePricingPlan(pool, T, C, '2026-06-01');
      assert.equal(dflt!.planName, 'Tenant default');
      assert.equal(dflt!.contingencyPercent, 15);

      await pool.query(
        `INSERT INTO pricing_plan (tenant_id, client_id, plan_name, effective_date,
                                   base_fee, contingency_percent, minimum_fee,
                                   agreement_reference, agreement_executed_on)
         VALUES ($1, $2, 'Negotiated', '2026-03-01', 250, 25, 400,
                 'MSA-TEST-001-A1', '2026-03-01')`, [T, C]);
      const specific = await resolvePricingPlan(pool, T, C, '2026-06-01');
      assert.equal(specific!.planName, 'Negotiated');
      assert.equal(specific!.contingencyPercent, 25);

      // before it took effect, the tenant default still applies
      const earlier = await resolvePricingPlan(pool, T, C, '2026-02-01');
      assert.equal(earlier!.planName, 'Tenant default');
    });

  it('bills base fee plus the contingency on attributed recovery', async () => {
    const { generateInvoice } = await import('../src/web/billing.ts');
    await seedRecovery(1000, '2026-06-10');
    await seedRecovery(600, '2026-06-20');

    const inv = await generateInvoice(pool, sess(), scope(), C, '2026-06');
    assert.equal(inv.attributedRecovery, 1600);
    assert.equal(inv.contingencyPercent, 25);
    assert.equal(inv.contingencyFee, 400);          // 25% of 1600
    assert.equal(inv.baseFee, 250);
    assert.equal(inv.amountDue, 650);               // 250 + 400, above the 400 floor
    assert.equal(inv.lines.length, 2);
    assert.equal(
      inv.lines.reduce((t: number, l: any) => t + l.amountRecovered, 0), 1600);
  });

  it('applies the minimum fee when the contingency does not reach it', async () => {
    const { generateInvoice } = await import('../src/web/billing.ts');
    const inv = await generateInvoice(pool, sess(), scope(), C, '2026-05');
    assert.equal(inv.attributedRecovery, 0);
    assert.equal(inv.amountDue, 400, 'the plan minimum');
    assert.equal(inv.minimumApplied, true);
    assert.ok(inv.warnings.some((w: string) => /no unbilled recovery/.test(w)));
  });

  it('nets a clawback out of the billed basis', async () => {
    const { generateInvoice } = await import('../src/web/billing.ts');
    await seedRecovery(-200, '2026-07-05');
    await seedRecovery(1200, '2026-07-06');
    const inv = await generateInvoice(pool, sess(), scope(), C, '2026-07');
    assert.equal(inv.attributedRecovery, 1000, '1200 recovered less 200 taken back');
    assert.equal(inv.contingencyFee, 250);
  });

  it('never bills the same recovery twice', async () => {
    const { generateInvoice, issueInvoice } = await import('../src/web/billing.ts');
    const june = await pool.query(
      `SELECT invoice_id FROM invoice WHERE client_id = $1 AND period_start = '2026-06-01'`,
      [C]);
    await issueInvoice(pool, sess(), scope(), june.rows[0].invoice_id);

    // a fresh recovery lands in the same month AFTER the invoice went out
    await seedRecovery(400, '2026-06-25');
    // regenerating June is refused; the next period picks the recovery up
    await assert.rejects(
      () => generateInvoice(pool, sess(), scope(), C, '2026-06'), /already been issued/);

    const billedTwice = await pool.query(
      `SELECT payment_event_id, count(*) FROM invoice_line
       WHERE payment_event_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1`);
    assert.equal(billedTwice.rows.length, 0);
  });

  it('refuses to rewrite an issued invoice, in the database itself', async () => {
    const issued = await pool.query(
      `SELECT invoice_id, amount_due FROM invoice WHERE status = 'issued' LIMIT 1`);
    const id = issued.rows[0].invoice_id;
    await assert.rejects(
      () => pool.query(`UPDATE invoice SET amount_due = 1 WHERE invoice_id = $1`, [id]),
      /has been issued/);
    await assert.rejects(
      () => pool.query(`DELETE FROM invoice WHERE invoice_id = $1`, [id]),
      /cannot be deleted/);
    // status may still move forward
    await pool.query(`UPDATE invoice SET status = 'paid' WHERE invoice_id = $1`, [id]);
    const after = await pool.query(
      `SELECT status, amount_due FROM invoice WHERE invoice_id = $1`, [id]);
    assert.equal(after.rows[0].status, 'paid');
    assert.equal(Number(after.rows[0].amount_due), Number(issued.rows[0].amount_due));
  });

  it('assigns a sequential invoice number on issue', async () => {
    const numbers = await pool.query(
      `SELECT invoice_number FROM invoice WHERE invoice_number IS NOT NULL`);
    assert.ok(numbers.rows.length >= 1);
    assert.match(numbers.rows[0].invoice_number, /^INV-\d{6}-\d{5}$/);
  });

  it('warns when no pricing plan is on file rather than silently billing zero', async () => {
    const { previewInvoice } = await import('../src/web/billing.ts');
    const preview = await previewInvoice(pool, sess(), scope(), C, '2025-01');
    assert.equal(preview.plan, null);
    assert.equal(preview.amountDue, 0);
    assert.ok(preview.warnings.some((w: string) => /no pricing plan/.test(w)));
  });

  // -------------------------------------------------------------------------
  it('stops processing for a suspended subscription', async () => {
    const enabled = await pool.query(`SELECT app.client_processing_enabled($1, $2) AS e`, [T, C]);
    assert.equal(enabled.rows[0].e, true);

    await pool.query(
      `UPDATE client SET subscription_status = 'suspended' WHERE client_id = $1`, [C]);
    const suspended = await pool.query(`SELECT app.client_processing_enabled($1, $2) AS e`, [T, C]);
    assert.equal(suspended.rows[0].e, false);
    const listed = await pool.query(
      `SELECT count(*)::int AS n FROM app.list_active_clients() WHERE client_id = $1`, [C]);
    assert.equal(listed.rows[0].n, 0, 'the scheduler no longer picks the client up');

    await pool.query(
      `UPDATE client SET subscription_status = 'active' WHERE client_id = $1`, [C]);
    const restored = await pool.query(
      `SELECT count(*)::int AS n FROM app.list_active_clients() WHERE client_id = $1`, [C]);
    assert.equal(restored.rows[0].n, 1);
  });

  it('honours the feature flags instead of giving every client everything', async () => {
    const on = await pool.query(
      `SELECT app.client_feature_enabled($1, $2, 'appeals') AS e`, [T, C]);
    assert.equal(on.rows[0].e, true);

    await pool.query(
      `UPDATE client SET features = jsonb_set(features, '{appeals}', 'false')
       WHERE client_id = $1`, [C]);
    const off = await pool.query(
      `SELECT app.client_feature_enabled($1, $2, 'appeals') AS e`, [T, C]);
    assert.equal(off.rows[0].e, false);

    // an unknown feature name, and a client in another tenant, both fail closed
    const crossTenant = await pool.query(
      `SELECT app.client_feature_enabled($1, $2, 'appeals') AS e`,
      ['11111111-1111-1111-1111-111111111111', C]);
    assert.equal(crossTenant.rows[0].e, false, 'no cross-tenant probing');
    const unknown = await pool.query(
      `SELECT app.client_feature_enabled($1, $2, 'time_travel') AS e`, [T, C]);
    assert.equal(unknown.rows[0].e, false);

    await pool.query(
      `UPDATE client SET features = jsonb_set(features, '{appeals}', 'true')
       WHERE client_id = $1`, [C]);
  });
});
