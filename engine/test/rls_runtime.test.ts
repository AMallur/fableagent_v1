import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.RLS_DATABASE_URL;
const TENANT = 'de300000-0000-4000-8000-000000000001';

describe('real non-superuser RLS runtime', { skip: !url && 'RLS_DATABASE_URL not set' }, () => {
  let raw: any;

  before(async () => {
    const { default: pg } = await import('pg');
    raw = new pg.Pool({ connectionString: url, max: 2 });
  });

  after(async () => { await raw?.end(); });

  it('fails closed without a tenant and exposes rows only through a bound context', async () => {
    const bare = await raw.query(`SELECT client_id FROM client`);
    assert.equal(bare.rows.length, 0, 'RLS must hide all tenant rows without context');

    const { TenantContextPool } = await import('../src/db/tenant_pool.ts');
    const scoped = new TenantContextPool(raw);
    const visible = await scoped.runAsTenant(TENANT, () => scoped.query(
      `SELECT client_id FROM client WHERE tenant_id = $1`, [TENANT]));
    assert.ok(visible.rows.length > 0, 'bound tenant sees its seeded clients');
  });

  it('clears login tenant state before returning a connection to the pool', async () => {
    const { authenticate } = await import('../src/web/auth.ts');
    const result = await authenticate(raw, 'admin@meridianrcm.com', 'demo1234');
    assert.equal(result.kind, 'ok');
    const bare = await raw.query(`SELECT client_id FROM client`);
    assert.equal(bare.rows.length, 0, 'released login connection must not retain tenant context');
  });

  it('serves an authenticated request through the tenant-aware server wrapper', async () => {
    const { startServer } = await import('../src/web/server.ts');
    const srv = await startServer(raw, { port: 0, sessionSecret: 'rls-regression-secret' });
    try {
      const base = `http://localhost:${srv.port}`;
      const login = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@meridianrcm.com', password: 'demo1234' }),
      });
      assert.equal(login.status, 200);
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
      const dashboard = await fetch(`${base}/api/dashboard`, { headers: { cookie } });
      assert.equal(dashboard.status, 200, await dashboard.text());
    } finally {
      await srv.close();
    }
  });

  // --------------------------------------------------------------------
  // Billing tables under real permissions.
  //
  // Every other integration suite connects as a superuser, which bypasses
  // row-level security entirely — so nothing else in CI would notice if the
  // billing tables lost their policies or their grants. These are the tables
  // that decide what a customer is charged, and this repository has been
  // burned by exactly this blind spot before (migrations 0016/0017 exist
  // because login and tenant creation were structurally broken under real
  // permissions while a superuser-backed suite reported green).
  // --------------------------------------------------------------------

  it('hides billing and ledger rows from a connection with no tenant bound', async () => {
    for (const table of ['usage_event', 'invoice', 'invoice_line', 'pricing_plan']) {
      const bare = await raw.query(`SELECT 1 FROM ${table} LIMIT 1`);
      assert.equal(bare.rows.length, 0,
        `${table} must expose nothing without a tenant context`);
    }
  });

  it('lets the runtime role write and settle a ledger row inside a tenant', async () => {
    const { TenantContextPool } = await import('../src/db/tenant_pool.ts');
    const scoped = new TenantContextPool(raw);

    await scoped.runAsTenant(TENANT, async () => {
      // Self-clean: a previous failed run can leave the probe rows behind, and
      // the live-period unique index would then reject this one.
      await scoped.query(`SELECT set_config('app.allow_invoice_purge', 'on', false)`);
      await scoped.query(`DELETE FROM usage_event WHERE tenant_id = $1 AND amount = 123.45`,
        [TENANT]);
      await scoped.query(`DELETE FROM invoice WHERE tenant_id = $1 AND plan = 'rls-probe'`,
        [TENANT]);
      await scoped.query(`SELECT set_config('app.allow_invoice_purge', 'off', false)`);

      const client = await scoped.query(
        `SELECT client_id FROM client WHERE tenant_id = $1 LIMIT 1`, [TENANT]);
      assert.ok(client.rows[0], 'bound tenant sees its own client');
      const clientId = client.rows[0].client_id;

      const ue = await scoped.query(
        `INSERT INTO usage_event (tenant_id, client_id, event_type, occurred_at, amount)
         VALUES ($1,$2,'recovery_attributed', CURRENT_DATE, 123.45)
         RETURNING usage_event_id`, [TENANT, clientId]);
      const usageEventId = ue.rows[0].usage_event_id;
      assert.ok(usageEventId, 'the runtime role can append to the ledger');

      const inv = await scoped.query(
        `INSERT INTO invoice (tenant_id, client_id, period_start, period_end, plan, status)
         VALUES ($1,$2,'2099-02-01','2099-02-28','rls-probe','draft')
         RETURNING invoice_id`, [TENANT, clientId]);
      const invoiceId = inv.rows[0].invoice_id;

      // Claim, then release — the only mutation the ledger permits.
      await scoped.query(
        `UPDATE usage_event SET invoice_id = $1 WHERE usage_event_id = $2`,
        [invoiceId, usageEventId]);
      const claimed = await scoped.query(
        `SELECT invoice_id FROM usage_event WHERE usage_event_id = $1`, [usageEventId]);
      assert.equal(claimed.rows[0].invoice_id, invoiceId);

      await scoped.query(
        `UPDATE usage_event SET invoice_id = NULL WHERE usage_event_id = $1`, [usageEventId]);

      // The append-only guarantee must hold for the runtime role too, not
      // only for the superuser the other suites use.
      await assert.rejects(
        () => scoped.query(
          `UPDATE usage_event SET amount = 1 WHERE usage_event_id = $1`, [usageEventId]),
        /append-only/);
      await assert.rejects(
        () => scoped.query(
          `DELETE FROM usage_event WHERE usage_event_id = $1`, [usageEventId]),
        /cannot be deleted/);

      // Teardown: the ledger refuses deletion by design, so this probe row is
      // removed through the same administrative escape the demo reseed uses.
      // Session-scoped, not SET LOCAL — there is no surrounding transaction
      // here, and SET LOCAL outside one silently does nothing.
      await scoped.query(`SELECT set_config('app.allow_invoice_purge', 'on', false)`);
      await scoped.query(`DELETE FROM usage_event WHERE usage_event_id = $1`, [usageEventId]);
      await scoped.query(`DELETE FROM invoice WHERE invoice_id = $1`, [invoiceId]);
      await scoped.query(`SELECT set_config('app.allow_invoice_purge', 'off', false)`);
    });
  });

  it('will not let one tenant read another tenant billing rows', async () => {
    const { TenantContextPool } = await import('../src/db/tenant_pool.ts');
    const scoped = new TenantContextPool(raw);
    const OTHER = '00000000-0000-4000-8000-0000000000ff';
    const seen = await scoped.runAsTenant(OTHER, () => scoped.query(
      `SELECT 1 FROM invoice LIMIT 1`));
    assert.equal(seen.rows.length, 0,
      'an unrelated tenant context must see no invoices at all');
  });
});
