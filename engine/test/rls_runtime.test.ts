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
});
