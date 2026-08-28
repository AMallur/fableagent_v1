// ============================================================================
// Go-live controls against a real Postgres.
//
// Two things are proved: the preflight actually reads the database and refuses
// on a real deficiency rather than reciting a checklist, and shadow mode is
// enforced at the moments that matter — nothing is transmitted to a payer and
// no invoice can be issued.
//
//   TEST_DATABASE_URL=postgres://... node --test test/golive_integration.test.ts
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

const T = '99999999-0000-0000-0000-000000000001';
const C = '99999999-0000-0000-0000-000000000002';
const P = '99999999-0000-0000-0000-000000000003';
const U = '99999999-0000-0000-0000-000000000004';

const sess = () => ({
  userId: U, tenantId: T, clientId: null, role: 'tenant_admin',
  name: 'Admin', exp: Date.now() + 3_600_000,
} as any);
const scope = () => ({ tenantId: T, clientIds: [C] } as any);

let pool: any;
let savedEnv: Record<string, string | undefined> = {};

/**
 * Going live legitimately depends on the deployment being configured — the
 * preflight folds inspectRuntimeReadiness in on purpose. A test process has
 * none of those variables, so it stands in for a configured deployment here
 * rather than pretending the dependency does not exist.
 */
function withConfiguredDeployment(): void {
  savedEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    SESSION_SECRET: process.env.SESSION_SECRET,
    DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY,
  };
  process.env.DATABASE_URL ??= url;
  process.env.SESSION_SECRET ??= 'golive-test-secret';
  process.env.DATA_ENCRYPTION_KEY ??= 'golive-test-key';
}

function restoreDeployment(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query(`SELECT set_config('app.allow_invoice_purge', 'on', false)`);
    await c.query(`SET session_replication_role = replica`);
    for (const t of [
      'go_live_check', 'invoice_line', 'usage_event', 'invoice', 'pricing_plan',
      'client_payer_config', 'contract_line', 'contract', 'client_medicare_config',
      'audit_log', 'app_user', 'client',
    ]) await c.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [T]);
    await c.query(`DELETE FROM payer WHERE payer_id = $1`, [P]);
    await c.query(`DELETE FROM tenant WHERE tenant_id = $1`, [T]);
    await c.query(`SET session_replication_role = DEFAULT`);
  } finally { c.release(); }
}

const check = (r: any, key: string) => r.checks.find((x: any) => x.key === key);

describe('go-live controls', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  before(async () => {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: url });
    await cleanup();
    await pool.query(
      `INSERT INTO tenant (tenant_id, tenant_name, tenant_type)
       VALUES ($1,'Go Live Tenant','billing_company')`, [T]);
    await pool.query(
      `INSERT INTO client (client_id, tenant_id, client_name, npi_group, subscription_status)
       VALUES ($1,$2,'Go Live Group','1234567890','active')`, [C, T]);
    await pool.query(
      `INSERT INTO app_user (user_id, tenant_id, email, first_name, last_name, role, password_hash)
       VALUES ($1,$2,'admin@golive.test','A','Dmin','tenant_admin','x')`, [U, T]);
    await pool.query(
      `INSERT INTO payer (payer_id, payer_name, payer_type) VALUES ($1,'GL Payer','commercial')`,
      [P]);
    await pool.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [T]);
    withConfiguredDeployment();
  });

  after(async () => { restoreDeployment(); await cleanup(); await pool.end(); });

  it('starts a new client in shadow mode', async () => {
    const r = await pool.query(
      `SELECT operating_mode FROM client WHERE client_id = $1`, [C]);
    assert.equal(r.rows[0].operating_mode, 'shadow',
      'a client nobody has cleared must not be transmitting or billing');
  });

  it('blocks on the real deficiencies and names a remedy for each', async () => {
    const { assessGoLive } = await import('../src/integration/golive.ts');
    const r = await assessGoLive(pool, T, C, {});
    assert.equal(r.cleared, false);

    // No BAA, no pricing plan, no contract, no activated payer — each blocking.
    assert.equal(check(r, 'baa').status, 'fail');
    assert.equal(check(r, 'pricing_plan').status, 'fail');
    assert.equal(check(r, 'contracts').status, 'fail');
    assert.equal(check(r, 'payer_activation').status, 'fail');
    for (const c of r.checks.filter((x: any) => x.status === 'fail')) {
      assert.ok(c.remedy.length > 0, `${c.key} must say what to do about itself`);
    }
  });

  it('refuses to go live while anything blocking fails', async () => {
    const { setOperatingMode } = await import('../src/web/admin_api.ts');
    await assert.rejects(
      () => setOperatingMode(pool, sess(), scope(), C, 'live'),
      /blocking check\(s\) must be resolved/);
    const r = await pool.query(`SELECT operating_mode FROM client WHERE client_id = $1`, [C]);
    assert.equal(r.rows[0].operating_mode, 'shadow', 'a refused go-live must not move the mode');
  });

  it('clears once the real prerequisites exist, and records the evidence', async () => {
    await pool.query(
      `UPDATE client SET baa_acknowledged_at = now(), baa_acknowledged_by = $2
       WHERE client_id = $1`, [C, U]);
    const ct = await pool.query(
      `INSERT INTO contract (tenant_id, client_id, payer_id, effective_date,
                             fee_schedule_type, status, approved_at)
       VALUES ($1,$2,$3,'2026-01-01','fee_schedule','active', now()) RETURNING contract_id`,
      [T, C, P]);
    await pool.query(
      `INSERT INTO contract_line (tenant_id, contract_id, procedure_code, allowed_amount)
       VALUES ($1,$2,'99213',125)`, [T, ct.rows[0].contract_id]);
    await pool.query(
      `INSERT INTO client_payer_config (tenant_id, client_id, payer_id, autopilot_enabled)
       VALUES ($1,$2,$3,false)`, [T, C, P]);
    await pool.query(
      `INSERT INTO pricing_plan (tenant_id, client_id, plan_name, effective_date,
                                 contingency_percent, agreement_reference,
                                 agreement_executed_on, agreed_attribution_basis)
       VALUES ($1,$2,'Pilot contingency','2026-01-01',18,'OF-2026-TEST',
               '2026-01-01','incremental_net')`, [T, C]);
    // A base fee so an invoice has something on it; the signed-terms gate
    // deliberately does not fire on a $0 bill.
    await pool.query(
      `UPDATE pricing_plan SET base_fee = 500 WHERE tenant_id = $1`, [T]);

    const { setOperatingMode } = await import('../src/web/admin_api.ts');
    const out = await setOperatingMode(pool, sess(), scope(), C, 'live');
    assert.equal(out.operatingMode, 'live');

    const rec = await pool.query(
      `SELECT cleared, blocking_failures, detail FROM go_live_check
       WHERE tenant_id = $1 ORDER BY checked_at DESC LIMIT 1`, [T]);
    assert.equal(rec.rows[0].cleared, true);
    assert.equal(rec.rows[0].blocking_failures, 0);
    assert.ok(Array.isArray(rec.rows[0].detail.checks),
      'the evidence records what was actually true at the moment of approval');

    const cl = await pool.query(
      `SELECT operating_mode, go_live_at, go_live_approved_by, go_live_evidence
       FROM client WHERE client_id = $1`, [C]);
    assert.equal(cl.rows[0].operating_mode, 'live');
    assert.ok(cl.rows[0].go_live_at);
    assert.equal(cl.rows[0].go_live_approved_by, U);
    assert.ok(cl.rows[0].go_live_evidence, 'the approval points at the preflight it relied on');
  });

  it('catches an attribution basis that contradicts the signed agreement', async () => {
    const { assessGoLive } = await import('../src/integration/golive.ts');
    await pool.query(
      `UPDATE client SET attribution_basis = 'gross_post_appeal' WHERE client_id = $1`, [C]);
    const r = await assessGoLive(pool, T, C, {});
    const c = check(r, 'attribution_matches_agreement');
    assert.equal(c.status, 'fail');
    assert.equal(c.severity, 'block');
    assert.match(c.detail, /agreement says incremental_net/);
    await pool.query(
      `UPDATE client SET attribution_basis = 'incremental_net' WHERE client_id = $1`, [C]);
  });

  it('refuses to issue an invoice for a client in shadow mode', async () => {
    const { generateInvoice, issueInvoice } = await import('../src/web/billing.ts');
    const inv = await generateInvoice(pool, sess(), scope(), C, '2026-07');
    await pool.query(`UPDATE client SET operating_mode = 'shadow' WHERE client_id = $1`, [C]);
    await assert.rejects(
      () => issueInvoice(pool, sess(), scope(), inv.invoiceId), /shadow mode/);
    await pool.query(`UPDATE client SET operating_mode = 'live' WHERE client_id = $1`, [C]);
  });

  it('refuses to issue an invoice under a plan naming no executed agreement', async () => {
    const { generateInvoice, issueInvoice } = await import('../src/web/billing.ts');
    await pool.query(`UPDATE pricing_plan SET agreement_reference = NULL WHERE tenant_id = $1`, [T]);
    const inv = await generateInvoice(pool, sess(), scope(), C, '2026-08');
    await assert.rejects(
      () => issueInvoice(pool, sess(), scope(), inv.invoiceId), /no executed agreement/);
    await pool.query(
      `UPDATE pricing_plan SET agreement_reference = 'OF-2026-TEST' WHERE tenant_id = $1`, [T]);
  });

  it('renders a statement a customer can audit against their own remittances', async () => {
    const { generateInvoice, issueInvoice } = await import('../src/web/billing.ts');
    const { renderStatement } = await import('../src/web/statement.ts');
    const inv = await generateInvoice(pool, sess(), scope(), C, '2026-09');

    const draft = await renderStatement(pool, sess(), scope(), inv.invoiceId);
    assert.match(draft.html, /Draft — not a bill/,
      'a draft must be unmistakable if it is forwarded');

    await issueInvoice(pool, sess(), scope(), inv.invoiceId);
    const issued = await renderStatement(pool, sess(), scope(), inv.invoiceId);
    assert.doesNotMatch(issued.html, /Draft — not a bill/);
    assert.match(issued.html, /INV-2026/, 'the statement carries its invoice number');
    assert.match(issued.html, /How this was calculated/);
    assert.match(issued.html, /OF-2026-TEST/, 'and names the agreement it is charged under');
    // Self-contained: nothing to fetch, so it survives a hospital network.
    assert.doesNotMatch(issued.html, /<(script|link|img)\b/i);
    assert.doesNotMatch(issued.html, /https?:\/\//);
  });

  it('escapes customer-supplied text rather than interpolating it into the page', async () => {
    const { renderStatement } = await import('../src/web/statement.ts');
    await pool.query(
      `UPDATE client SET client_name = $2 WHERE client_id = $1`,
      [C, 'Go Live <script>alert(1)</script> Group']);
    const invId = (await pool.query(
      `SELECT invoice_id FROM invoice WHERE client_id = $1 ORDER BY period_start DESC LIMIT 1`,
      [C])).rows[0].invoice_id;
    const out = await renderStatement(pool, sess(), scope(), invId);
    assert.doesNotMatch(out.html, /<script>alert/);
    assert.match(out.html, /&lt;script&gt;/);
    await pool.query(`UPDATE client SET client_name = 'Go Live Group' WHERE client_id = $1`, [C]);
  });

  it('builds an evidence pack a recipient can verify has not been altered', async () => {
    const { buildEvidencePack, evidencePackHash } = await import('../src/web/statement.ts');
    const pack = await buildEvidencePack(pool, sess(), scope(), C, '2026-01-01', '2026-12-31');

    assert.ok(/^[0-9a-f]{64}$/.test(pack.contentHash));
    assert.equal(pack.packId, `EV-${pack.contentHash.slice(0, 12)}`);
    assert.equal(pack.commercialTerms?.agreement_reference, 'OF-2026-TEST');
    assert.equal(pack.attributionPolicy.basis, 'incremental_net');
    assert.ok(pack.goLiveChecks.length > 0, 'the go-live decisions are part of the evidence');

    // The property that matters to whoever receives it: the hash can be
    // recomputed from the pack itself.
    assert.equal(evidencePackHash(pack as any), pack.contentHash,
      'a recipient must be able to verify the copy they hold');

    // And it detects alteration of the substance.
    const tampered = JSON.parse(JSON.stringify(pack));
    tampered.invoices[0].amount_due = '999999.00';
    assert.notEqual(evidencePackHash(tampered), pack.contentHash);

    // Reprinting the same pack must not change its identity — the generation
    // timestamp is envelope, not content.
    const reprinted = JSON.parse(JSON.stringify(pack));
    reprinted.generatedAt = '2030-01-01T00:00:00.000Z';
    assert.equal(evidencePackHash(reprinted), pack.contentHash);

    assert.ok(pack.scopeNotes.some((n) => /not evidence the accuracy of payer adjudication/.test(n)),
      'the pack must not overstate what it proves');
    assert.ok(pack.scopeNotes.some((n) => /not a cryptographic signature/.test(n)));
  });

  it('rejects a nonsense evidence period instead of returning an empty pack', async () => {
    const { buildEvidencePack } = await import('../src/web/statement.ts');
    await assert.rejects(
      () => buildEvidencePack(pool, sess(), scope(), C, '2026-12-31', '2026-01-01'),
      /from must not be after to/);
    await assert.rejects(
      () => buildEvidencePack(pool, sess(), scope(), C, 'last month', '2026-01-01'),
      /YYYY-MM-DD/);
  });

  it('lets a client be returned to shadow without a preflight', async () => {
    // Stopping must never be harder than starting.
    const { setOperatingMode } = await import('../src/web/admin_api.ts');
    const out = await setOperatingMode(pool, sess(), scope(), C, 'shadow', 'pilot paused');
    assert.equal(out.operatingMode, 'shadow');
    const cl = await pool.query(
      `SELECT operating_mode, go_live_at FROM client WHERE client_id = $1`, [C]);
    assert.equal(cl.rows[0].operating_mode, 'shadow');
    assert.equal(cl.rows[0].go_live_at, null);
  });
});
