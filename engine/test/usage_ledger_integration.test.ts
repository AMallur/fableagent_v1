// ============================================================================
// The usage ledger and the attribution policy, against a real Postgres.
//
// Two things are being proved here, and both are about somebody else's money:
//
//   * an invoice can be reconstructed from the ledger AFTER the operational
//     tables have moved on. A recovery that is later corrected, or whose
//     payment_event is revised, must not change what a customer was charged;
//   * the attribution policy is actually enforced by the reconciler, not
//     merely stored. A window, a floor, a basis and a clawback rule that are
//     configurable but ignored are worse than no configuration at all,
//     because the operator believes them.
//
//   TEST_DATABASE_URL=postgres://... node --test test/usage_ledger_integration.test.ts
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

const T = '77777777-0000-0000-0000-000000000001';
const C = '77777777-0000-0000-0000-000000000002';
const P = '77777777-0000-0000-0000-000000000003';
const U = '77777777-0000-0000-0000-000000000004';

const sess = () => ({
  userId: U, tenantId: T, clientId: null, role: 'tenant_admin',
  name: 'Admin', exp: Date.now() + 3_600_000,
} as any);
const scope = () => ({ tenantId: T, clientIds: [C] } as any);

let pool: any;
let seq = 0;

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query(`SELECT set_config('app.allow_invoice_purge', 'on', false)`);
    await c.query(`SET session_replication_role = replica`);
    for (const t of [
      'invoice_line', 'usage_event', 'invoice', 'pricing_plan', 'payment_event',
      'appeal_packet', 'case_action', 'notification', 'recovery_case',
      'remittance_line', 'remittance_provider_adjustment', 'remittance',
      'claim_line', 'claim', 'encounter', 'patient', 'provider',
      'audit_log', 'app_user', 'client',
    ]) await c.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [T]);
    await c.query(`DELETE FROM payer WHERE payer_id = $1`, [P]);
    await c.query(`DELETE FROM tenant WHERE tenant_id = $1`, [T]);
    await c.query(`SET session_replication_role = DEFAULT`);
  } finally { c.release(); }
}

/** A claim with one line, ready to have remittances and a case hung off it. */
async function seedClaim(): Promise<{ claimId: string; claimLineId: string }> {
  seq += 1;
  const patient = await pool.query(
    `INSERT INTO patient (tenant_id, client_id, mrn, first_name, last_name)
     VALUES ($1,$2,$3,'Pat','Ient') RETURNING patient_id`, [T, C, `LMRN-${seq}`]);
  const provider = await pool.query(
    `INSERT INTO provider (tenant_id, client_id, npi_individual, name)
     VALUES ($1,$2,$3,'Dr Ledger') RETURNING provider_id`,
    [T, C, String(3000000000 + seq)]);
  const enc = await pool.query(
    `INSERT INTO encounter (tenant_id, client_id, patient_id, provider_id,
                            date_of_service_start, status)
     VALUES ($1,$2,$3,$4,'2026-06-01','billed') RETURNING encounter_id`,
    [T, C, patient.rows[0].patient_id, provider.rows[0].provider_id]);
  const claim = await pool.query(
    `INSERT INTO claim (tenant_id, client_id, encounter_id, payer_id, claim_type,
                        claim_number_internal, billed_amount, claim_status)
     VALUES ($1,$2,$3,$4,'professional',$5,500,'underpaid') RETURNING claim_id`,
    [T, C, enc.rows[0].encounter_id, P, `LCLM-${seq}`]);
  const line = await pool.query(
    `INSERT INTO claim_line (tenant_id, claim_id, line_number, procedure_code,
                             units, billed_amount)
     VALUES ($1,$2,1,'99213',1,500) RETURNING claim_line_id`,
    [T, claim.rows[0].claim_id]);
  return { claimId: claim.rows[0].claim_id, claimLineId: line.rows[0].claim_line_id };
}

/** A case with a submitted appeal, so the reconciler will look at it. */
async function seedAppealedCase(
  claimId: string, claimLineId: string | null, opportunity: number, submittedAt: string,
): Promise<string> {
  const rc = await pool.query(
    `INSERT INTO recovery_case (tenant_id, client_id, claim_id, claim_line_id, case_type,
                                status, recovery_opportunity, priority_level)
     VALUES ($1,$2,$3,$4,'underpayment','submitted',$5,'high') RETURNING case_id`,
    [T, C, claimId, claimLineId, opportunity]);
  await pool.query(
    `INSERT INTO appeal_packet (tenant_id, case_id, packet_status, appeal_type, submitted_at)
     VALUES ($1,$2,'submitted','first_level',$3::timestamptz)`,
    [T, rc.rows[0].case_id, submittedAt]);
  return rc.rows[0].case_id;
}

/** A remittance line paying `paid` against a claim line, created at `createdAt`. */
async function seedRemittance(
  claimId: string, claimLineId: string | null, paid: number,
  createdAt: string, opts: { isReversal?: boolean; checkDate?: string } = {},
): Promise<void> {
  seq += 1;
  const r = await pool.query(
    `INSERT INTO remittance (tenant_id, client_id, payer_id, check_number, check_date,
                             total_paid, created_at)
     VALUES ($1,$2,$3,$4,$5::date,$6,$7::timestamptz) RETURNING remittance_id`,
    [T, C, P, `CHK-${seq}`, opts.checkDate ?? createdAt.slice(0, 10),
     Math.abs(paid), createdAt]);
  await pool.query(
    `INSERT INTO remittance_line (tenant_id, remittance_id, claim_id, claim_line_id,
                                  procedure_code, billed_amount, paid_amount, is_reversal)
     VALUES ($1,$2,$3,$4,'99213',500,$5,$6)`,
    [T, r.rows[0].remittance_id, claimId, claimLineId, paid, opts.isReversal ?? false]);
  // created_at defaults to now(); the reconciler compares it against the appeal
  // submission, so it has to be the date this remittance actually arrived.
  await pool.query(
    `UPDATE remittance SET created_at = $2::timestamptz WHERE remittance_id = $1`,
    [r.rows[0].remittance_id, createdAt]);
}

async function setPolicy(policy: Record<string, unknown>): Promise<void> {
  const sets = Object.keys(policy).map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE client SET ${sets} WHERE client_id = $1`, [C, ...Object.values(policy)]);
}

const reconcile = async () => {
  const { runPaymentReconciliation } = await import('../src/automation/jobs.ts');
  return runPaymentReconciliation(pool, { tenantId: T, clientId: C });
};

describe('usage ledger and attribution policy',
  { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
    before(async () => {
      const { default: pg } = await import('pg');
      pool = new pg.Pool({ connectionString: url });
      await cleanup();
      await pool.query(
        `INSERT INTO tenant (tenant_id, tenant_name, tenant_type)
         VALUES ($1,'Ledger Tenant','billing_company')`, [T]);
      await pool.query(
        `INSERT INTO client (client_id, tenant_id, client_name, npi_group, subscription_status, operating_mode)
         VALUES ($1,$2,'Ledger Group','1234567890','active','live')`, [C, T]);
      await pool.query(
        `INSERT INTO app_user (user_id, tenant_id, email, first_name, last_name, role, password_hash)
         VALUES ($1,$2,'admin@ledger.test','A','Dmin','tenant_admin','x')`, [U, T]);
      await pool.query(
        `INSERT INTO payer (payer_id, payer_name, payer_type)
         VALUES ($1,'Ledger Payer','commercial')`, [P]);
      await pool.query(
        `INSERT INTO pricing_plan (tenant_id, client_id, plan_name, effective_date,
                                   contingency_percent)
         VALUES ($1,$2,'Contingency only','2026-01-01',20)`, [T, C]);
      await pool.query(
        `UPDATE pricing_plan SET agreement_reference = 'MSA-TEST-001',
           agreement_executed_on = '2026-01-01' WHERE tenant_id = $1`, [T]);
      await pool.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [T]);
    });

    after(async () => { await cleanup(); await pool.end(); });

    // ---------------------------------------------------------------------
    // The ledger itself
    // ---------------------------------------------------------------------

    it('appends one ledger row per payment event, and only one', async () => {
      const { syncUsageLedger } = await import('../src/web/usage_ledger.ts');
      const { claimId, claimLineId } = await seedClaim();
      const caseId = await seedAppealedCase(claimId, claimLineId, 300, '2026-06-01');
      await pool.query(
        `INSERT INTO payment_event (tenant_id, case_id, claim_id, claim_line_id,
                                    amount_recovered, payment_date, matched_automatically,
                                    attribution_basis)
         VALUES ($1,$2,$3,$4,300,'2026-06-15',true,'incremental_net')`,
        [T, caseId, claimId, claimLineId]);

      const first = await syncUsageLedger(pool, T, C);
      assert.equal(first.appended, 1);
      // Running it again is a no-op, not a second charge. This is the property
      // the whole design rests on: the sync is called from reconciliation AND
      // from invoice generation, so it will always run more than once.
      const second = await syncUsageLedger(pool, T, C);
      assert.equal(second.appended, 0);

      const rows = await pool.query(
        `SELECT event_type, amount, occurred_at, detail FROM usage_event
         WHERE tenant_id = $1 AND case_id = $2`, [T, caseId]);
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0].event_type, 'recovery_attributed');
      assert.equal(Number(rows.rows[0].amount), 300);
      // The detail freezes enough to answer a customer without the live tables.
      assert.ok(rows.rows[0].detail.claimNumber, 'claim number is frozen on the row');
      assert.equal(rows.rows[0].detail.payerName, 'Ledger Payer');
    });

    it('records a takeback as a negative event rather than amending the original',
      async () => {
        const { syncUsageLedger } = await import('../src/web/usage_ledger.ts');
        const { claimId, claimLineId } = await seedClaim();
        const caseId = await seedAppealedCase(claimId, claimLineId, 500, '2026-06-01');
        await pool.query(
          `INSERT INTO payment_event (tenant_id, case_id, claim_id, claim_line_id,
                                      amount_recovered, payment_date, matched_automatically,
                                      attribution_basis)
           VALUES ($1,$2,$3,$4,500,'2026-06-10',true,'incremental_net'),
                  ($1,$2,$3,$4,-120,'2026-06-28',true,'incremental_net')`,
          [T, caseId, claimId, claimLineId]);
        await syncUsageLedger(pool, T, C);

        const rows = await pool.query(
          `SELECT event_type, amount FROM usage_event
           WHERE tenant_id = $1 AND case_id = $2 ORDER BY amount DESC`, [T, caseId]);
        assert.equal(rows.rows.length, 2);
        assert.equal(rows.rows[0].event_type, 'recovery_attributed');
        assert.equal(rows.rows[1].event_type, 'recovery_clawed_back');
        assert.equal(Number(rows.rows[1].amount), -120);
      });

    it('is append-only in the database, not merely by convention', async () => {
      const row = await pool.query(
        `SELECT usage_event_id FROM usage_event WHERE tenant_id = $1 LIMIT 1`, [T]);
      const id = row.rows[0].usage_event_id;
      await assert.rejects(
        () => pool.query(`UPDATE usage_event SET amount = 1 WHERE usage_event_id = $1`, [id]),
        /append-only/);
      await assert.rejects(
        () => pool.query(
          `UPDATE usage_event SET occurred_at = '2020-01-01' WHERE usage_event_id = $1`, [id]),
        /append-only/);
      await assert.rejects(
        () => pool.query(`DELETE FROM usage_event WHERE usage_event_id = $1`, [id]),
        /cannot be deleted/);
    });

    it('reproduces an issued invoice from the ledger after the source data changes',
      async () => {
        const { generateInvoice, issueInvoice, invoiceDetail } =
          await import('../src/web/billing.ts');

        const inv = await generateInvoice(pool, sess(), scope(), C, '2026-06');
        // 300 + 500 - 120 seeded above
        assert.equal(inv.attributedRecovery, 680);
        assert.equal(inv.contingencyFee, 136);
        await issueInvoice(pool, sess(), scope(), inv.invoiceId);

        // Now the operational record moves: somebody corrects a payment_event.
        // This is exactly the case the ledger exists for.
        await pool.query(
          `UPDATE payment_event SET amount_recovered = 9999
           WHERE tenant_id = $1 AND amount_recovered = 300`, [T]);

        const detail = await invoiceDetail(pool, sess(), scope(), inv.invoiceId);
        assert.equal(detail.attributedRecovery, 680, 'the bill did not move');
        const fromLedger = detail.ledger.reduce((t: number, r: any) => t + r.amount, 0);
        assert.equal(fromLedger, 680,
          'and the ledger it was built from still sums to the same figure');
        assert.equal(detail.ledger.length, 3);
        assert.ok(detail.ledger.every((r: any) => r.invoiceNumber),
          'every ledger row names the invoice that billed it');
      });

    it('will not let a second invoice claim a ledger row the first one holds',
      async () => {
        const held = await pool.query(
          `SELECT usage_event_id, invoice_id FROM usage_event
           WHERE tenant_id = $1 AND invoice_id IS NOT NULL LIMIT 1`, [T]);
        const other = await pool.query(
          `INSERT INTO invoice (tenant_id, client_id, period_start, period_end, plan, status)
           VALUES ($1,$2,'2026-09-01','2026-09-30','x','draft') RETURNING invoice_id`, [T, C]);
        await assert.rejects(
          () => pool.query(
            `UPDATE usage_event SET invoice_id = $1 WHERE usage_event_id = $2`,
            [other.rows[0].invoice_id, held.rows[0].usage_event_id]),
          /already billed on invoice/);
        await pool.query(`SELECT set_config('app.allow_invoice_purge', 'on', false)`);
        await pool.query(
          `DELETE FROM invoice WHERE invoice_id = $1`, [other.rows[0].invoice_id]);
      });

    it('releases the ledger rows when the invoice is voided, and keeps the events',
      async () => {
        const { voidInvoice } = await import('../src/web/billing.ts');
        const issued = await pool.query(
          `SELECT invoice_id FROM invoice
           WHERE tenant_id = $1 AND status = 'issued' LIMIT 1`, [T]);
        const before = await pool.query(
          `SELECT count(*)::int AS n FROM usage_event WHERE tenant_id = $1`, [T]);

        await voidInvoice(pool, sess(), scope(), issued.rows[0].invoice_id, 'wrong period');

        const after = await pool.query(
          `SELECT count(*)::int AS n,
                  count(*) FILTER (WHERE invoice_id IS NULL)::int AS unbilled
           FROM usage_event WHERE tenant_id = $1`, [T]);
        assert.equal(after.rows[0].n, before.rows[0].n,
          'voiding a bill does not unmake the things that were billed');
        assert.equal(after.rows[0].unbilled, before.rows[0].n,
          'but they are billable again');
      });

    // ---------------------------------------------------------------------
    // Attribution policy, enforced by the reconciler
    // ---------------------------------------------------------------------

    it('attributes payment inside the window and ignores payment outside it', async () => {
      await setPolicy({ attribution_window_days: 30 });
      const inside = await seedClaim();
      const outside = await seedClaim();
      const a = await seedAppealedCase(inside.claimId, inside.claimLineId, 400, '2026-06-01');
      const b = await seedAppealedCase(outside.claimId, outside.claimLineId, 400, '2026-06-01');
      await seedRemittance(inside.claimId, inside.claimLineId, 400, '2026-06-20T00:00:00Z');
      await seedRemittance(outside.claimId, outside.claimLineId, 400, '2026-08-20T00:00:00Z');

      await reconcile();

      const attributed = async (caseId: string) => Number((await pool.query(
        `SELECT COALESCE(sum(amount_recovered), 0) AS t FROM payment_event
         WHERE tenant_id = $1 AND case_id = $2`, [T, caseId])).rows[0].t);
      assert.equal(await attributed(a), 400, 'inside the window');
      assert.equal(await attributed(b), 0,
        'payment 80 days after submission is not this appeal doing its work');
    });

    it('measures the window on the payer check date, not when we loaded the file',
      async () => {
        // A client backfilling historical remittances stamps every row with
        // today. If the window were measured on ingestion time, a payment the
        // payer cut a year after the appeal would look same-day and be billed;
        // and a timely payment loaded late would be wrongly excluded.
        await setPolicy({ attribution_window_days: 30 });
        const late = await seedClaim();
        const timely = await seedClaim();
        const a = await seedAppealedCase(late.claimId, late.claimLineId, 400, '2026-06-01');
        const b = await seedAppealedCase(timely.claimId, timely.claimLineId, 400, '2026-06-01');

        // Backfilled today, but the payer actually paid 5 months later.
        await seedRemittance(late.claimId, late.claimLineId, 400,
          '2026-06-05T00:00:00Z', { checkDate: '2026-11-01' });
        // Paid inside the window, but the file only reached us months after.
        await seedRemittance(timely.claimId, timely.claimLineId, 400,
          '2026-12-20T00:00:00Z', { checkDate: '2026-06-20' });

        await reconcile();

        const attributed = async (caseId: string) => Number((await pool.query(
          `SELECT COALESCE(sum(amount_recovered), 0) AS t FROM payment_event
           WHERE tenant_id = $1 AND case_id = $2`, [T, caseId])).rows[0].t);
        assert.equal(await attributed(a), 0,
          'a backfilled row must not smuggle a late payment inside the window');
        assert.equal(await attributed(b), 400,
          'a timely payment stays attributable however late the file arrived');
        await setPolicy({ attribution_window_days: null });
      });

    it('does not open a billable event for movement below the floor', async () => {
      await setPolicy({ attribution_window_days: null, attribution_min_amount: 25 });
      const noise = await seedClaim();
      const real = await seedClaim();
      const a = await seedAppealedCase(noise.claimId, noise.claimLineId, 400, '2026-06-01');
      const b = await seedAppealedCase(real.claimId, real.claimLineId, 400, '2026-06-01');
      await seedRemittance(noise.claimId, noise.claimLineId, 8, '2026-06-20T00:00:00Z');
      await seedRemittance(real.claimId, real.claimLineId, 80, '2026-06-20T00:00:00Z');

      await reconcile();

      const events = async (caseId: string) => Number((await pool.query(
        `SELECT count(*)::int AS n FROM payment_event WHERE tenant_id = $1 AND case_id = $2`,
        [T, caseId])).rows[0].n);
      assert.equal(await events(a), 0, '$8 of movement is noise');
      assert.equal(await events(b), 1);
      await setPolicy({ attribution_min_amount: 0 });
    });

    it('nets reversals under the default basis and does not under gross', async () => {
      // Same facts, two clients' worth of policy: a payer reissues a claim,
      // which pays the original amount again plus the correction.
      const mk = async () => {
        const c = await seedClaim();
        const id = await seedAppealedCase(c.claimId, c.claimLineId, 300, '2026-06-01');
        await seedRemittance(c.claimId, c.claimLineId, 500, '2026-06-10T00:00:00Z');
        await seedRemittance(c.claimId, c.claimLineId, -500, '2026-06-11T00:00:00Z',
          { isReversal: true });
        await seedRemittance(c.claimId, c.claimLineId, 800, '2026-06-12T00:00:00Z');
        return id;
      };
      const attributed = async (caseId: string) => Number((await pool.query(
        `SELECT COALESCE(sum(amount_recovered), 0) AS t FROM payment_event
         WHERE tenant_id = $1 AND case_id = $2`, [T, caseId])).rows[0].t);

      await setPolicy({ attribution_basis: 'incremental_net' });
      const net = await mk();
      await reconcile();
      assert.equal(await attributed(net), 800,
        'the reissue nets against the reversal: 1300 gross less 500 reversed');

      await setPolicy({ attribution_basis: 'gross_post_appeal' });
      const gross = await mk();
      await reconcile();
      assert.equal(await attributed(gross), 1300,
        'the generous reading credits every dollar paid after submission');
      await setPolicy({ attribution_basis: 'incremental_net' });
    });

    it('reverses a takeback under auto and only flags it under flag_only', async () => {
      const build = async () => {
        const c = await seedClaim();
        const id = await seedAppealedCase(c.claimId, c.claimLineId, 600, '2026-06-01');
        await seedRemittance(c.claimId, c.claimLineId, 600, '2026-06-10T00:00:00Z');
        await reconcile();
        // ... and then the payer takes it back
        await seedRemittance(c.claimId, c.claimLineId, -600, '2026-06-25T00:00:00Z',
          { isReversal: true });
        return id;
      };
      const attributed = async (caseId: string) => Number((await pool.query(
        `SELECT COALESCE(sum(amount_recovered), 0) AS t FROM payment_event
         WHERE tenant_id = $1 AND case_id = $2`, [T, caseId])).rows[0].t);

      await setPolicy({ clawback_policy: 'auto' });
      const autoCase = await build();
      await reconcile();
      assert.equal(await attributed(autoCase), 0, 'the credited recovery is reversed out');

      await setPolicy({ clawback_policy: 'flag_only' });
      const flagged = await build();
      await reconcile();
      assert.equal(await attributed(flagged), 600,
        'the figure stands until a person decides');
      const action = await pool.query(
        `SELECT notes FROM case_action
         WHERE tenant_id = $1 AND case_id = $2 AND action_type = 'payment_recouped'`,
        [T, flagged]);
      assert.equal(action.rows.length, 1);
      assert.match(action.rows[0].notes, /LEFT STANDING/);

      // ...and it does not re-alert every night thereafter.
      await reconcile();
      const again = await pool.query(
        `SELECT count(*)::int AS n FROM case_action
         WHERE tenant_id = $1 AND case_id = $2 AND action_type = 'payment_recouped'`,
        [T, flagged]);
      assert.equal(again.rows[0].n, 1, 'escalated once, not nightly');
      await setPolicy({ clawback_policy: 'auto' });
    });

    it('drops unallocated payment when the client has excluded it', async () => {
      // Remittance detail the payer never resolved to a service line carries a
      // claim and nothing more, so attributing it to a line-scoped case is a
      // judgement call. Both answers are defensible; the point is that the
      // setting decides, and that the amount is reported either way.
      const mk = async () => {
        const c = await seedClaim();
        const id = await seedAppealedCase(c.claimId, c.claimLineId, 300, '2026-06-01');
        await seedRemittance(c.claimId, null, 250, '2026-06-15T00:00:00Z');
        return id;
      };
      const attributed = async (caseId: string) => Number((await pool.query(
        `SELECT COALESCE(sum(amount_recovered), 0) AS t FROM payment_event
         WHERE tenant_id = $1 AND case_id = $2`, [T, caseId])).rows[0].t);

      await setPolicy({ attribution_include_unallocated: true });
      const included = await mk();
      await reconcile();
      assert.equal(await attributed(included), 250);
      const note = await pool.query(
        `SELECT unallocated_paid, notes FROM payment_event
         WHERE tenant_id = $1 AND case_id = $2`, [T, included]);
      assert.equal(Number(note.rows[0].unallocated_paid), 250);
      assert.match(note.rows[0].notes, /not resolved to a service line/);

      await setPolicy({ attribution_include_unallocated: false });
      const excluded = await mk();
      await reconcile();
      assert.equal(await attributed(excluded), 0);
      await setPolicy({ attribution_include_unallocated: true });
    });

    it('regenerating a draft keeps its lines instead of emptying it', async () => {
      // Regeneration releases the draft's ledger rows so they can be
      // re-claimed. If the release happened after the figures were computed,
      // the rows would be excluded as already-billed and then orphaned, and
      // the customer would get an invoice for nothing.
      const { generateInvoice } = await import('../src/web/billing.ts');
      const { claimId, claimLineId } = await seedClaim();
      const caseId = await seedAppealedCase(claimId, claimLineId, 900, '2026-06-01');
      await pool.query(
        `INSERT INTO payment_event (tenant_id, case_id, claim_id, claim_line_id,
                                    amount_recovered, payment_date, matched_automatically,
                                    attribution_basis)
         VALUES ($1,$2,$3,$4,900,'2026-10-12',true,'incremental_net')`,
        [T, caseId, claimId, claimLineId]);

      const first = await generateInvoice(pool, sess(), scope(), C, '2026-10');
      assert.equal(first.attributedRecovery, 900);
      assert.equal(first.lines.length, 1);

      // A preview of a month that already has a draft must say what
      // regenerating would produce, not report an empty bill because the
      // draft is holding the rows.
      const { previewInvoice } = await import('../src/web/billing.ts');
      const preview = await previewInvoice(pool, sess(), scope(), C, '2026-10');
      assert.equal(preview.attributedRecovery, 900);
      assert.equal(preview.lines.length, 1);

      const second = await generateInvoice(pool, sess(), scope(), C, '2026-10');
      assert.equal(second.attributedRecovery, 900, 'the draft still bills its recovery');
      assert.equal(second.lines.length, 1);
      const stored = await pool.query(
        `SELECT count(*)::int AS n FROM invoice_line WHERE invoice_id = $1`,
        [second.invoiceId]);
      assert.equal(stored.rows[0].n, 1);
      const claimed = await pool.query(
        `SELECT count(*)::int AS n FROM usage_event WHERE invoice_id = $1`,
        [second.invoiceId]);
      assert.equal(claimed.rows[0].n, 1, 'and the ledger row is claimed by it');
    });

    it('rolls the whole bill back when a write fails mid-flight', async () => {
      // The defect this guards: generateInvoice releases the ledger rows the
      // draft holds and then re-claims them. Before it was transactional, a
      // failure in between left the invoice asserting totals for recoveries
      // the ledger showed as unbilled — and the next period billed them again.
      const { generateInvoice } = await import('../src/web/billing.ts');
      const { claimId, claimLineId } = await seedClaim();
      const caseId = await seedAppealedCase(claimId, claimLineId, 700, '2026-06-01');
      await pool.query(
        `INSERT INTO payment_event (tenant_id, case_id, claim_id, claim_line_id,
                                    amount_recovered, payment_date, matched_automatically,
                                    attribution_basis)
         VALUES ($1,$2,$3,$4,700,'2026-11-09',true,'incremental_net')`,
        [T, caseId, claimId, claimLineId]);

      const good = await generateInvoice(pool, sess(), scope(), C, '2026-11');
      assert.equal(good.attributedRecovery, 700);
      const claimedBefore = await pool.query(
        `SELECT count(*)::int AS n FROM usage_event WHERE invoice_id = $1`, [good.invoiceId]);
      assert.equal(claimedBefore.rows[0].n, 1);

      // Fail on the invoice_line insert — after the release and the re-claim,
      // the worst possible moment.
      let failed = false;
      const sabotaged = {
        query: (text: string, params?: unknown[]) => {
          if (/INSERT INTO invoice_line/.test(text)) {
            failed = true;
            return Promise.reject(new Error('simulated failure mid-invoice'));
          }
          return (pool as any).query(text, params);
        },
        connect: async () => {
          const c = await (pool as any).connect();
          return {
            query: (text: string, params?: unknown[]) => {
              if (/INSERT INTO invoice_line/.test(text)) {
                failed = true;
                return Promise.reject(new Error('simulated failure mid-invoice'));
              }
              return c.query(text, params);
            },
            release: () => c.release(),
          };
        },
      } as any;

      await assert.rejects(
        () => generateInvoice(sabotaged, sess(), scope(), C, '2026-11'),
        /simulated failure mid-invoice/);
      assert.equal(failed, true, 'the sabotage actually fired');

      // The ledger row must still be exactly where it was: claimed by the
      // invoice, billed once, not orphaned.
      const after = await pool.query(
        `SELECT count(*)::int AS claimed FROM usage_event WHERE invoice_id = $1`,
        [good.invoiceId]);
      assert.equal(after.rows[0].claimed, 1,
        'a failed regeneration must not release the rows it was rebuilding');
      const lines = await pool.query(
        `SELECT count(*)::int AS n FROM invoice_line WHERE invoice_id = $1`, [good.invoiceId]);
      assert.equal(lines.rows[0].n, 1, 'and must not destroy the lines already billed');

      // And nothing is now double-billable.
      const unbilled = await pool.query(
        `SELECT count(*)::int AS n FROM usage_event
         WHERE tenant_id = $1 AND case_id = $2 AND invoice_id IS NULL`, [T, caseId]);
      assert.equal(unbilled.rows[0].n, 0);
    });

    it('rejects an attribution policy the operator has fat-fingered', async () => {
      const { updateClientSettings } = await import('../src/web/admin_api.ts');
      await assert.rejects(
        () => updateClientSettings(pool, sess(), scope(), C, { attributionBasis: 'generous' }),
        /attributionBasis must be one of/);
      await assert.rejects(
        () => updateClientSettings(pool, sess(), scope(), C, { clawbackPolicy: 'never' }),
        /clawbackPolicy must be one of/);
      await assert.rejects(
        () => updateClientSettings(pool, sess(), scope(), C, { attributionWindowDays: 0 }),
        /whole number of days/);
      // Blank means "no window", not zero — which would attribute nothing.
      await updateClientSettings(pool, sess(), scope(), C, { attributionWindowDays: '' });
      const row = await pool.query(
        `SELECT attribution_window_days FROM client WHERE client_id = $1`, [C]);
      assert.equal(row.rows[0].attribution_window_days, null);
    });
  });
