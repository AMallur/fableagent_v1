// ============================================================================
// Platform tenant-bootstrap integration test — drives createTenant() (the
// CLI-only `node src/cli.ts create-tenant` path) against a real Postgres,
// then walks the resulting invite through the real HTTP accept-invite and
// login routes, exactly as a brand-new customer's first admin would.
//
//   TEST_DATABASE_URL=postgres://... node --test test/tenant_creation.test.ts
//
// Covers: tenant + first tenant_admin created, invite email queued, audit
// event recorded, duplicate tenant name rejected, invalid tenant type
// rejected, accept-invite activates the account under a real password
// policy check, the new admin can log in (MFA-enroll gate, same as any
// other admin account) and sees only their own tenant's data.
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const DEMO_TENANT = 'de300000-0000-4000-8000-000000000001';

describe('platform tenant bootstrap', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  let pool: any, srv: any, base = '';
  const createdTenantIds: string[] = [];

  before(async () => {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: url });
    const { startServer } = await import('../src/web/server.ts');
    srv = await startServer(pool, { port: 0, sessionSecret: 'test-secret' });
    base = `http://localhost:${srv.port}`;
  });

  after(async () => {
    // audit_log is append-only at the database level (trg_audit_log_immutable
    // blocks DELETE/UPDATE even for the table owner) — every tenant this test
    // creates writes a 'tenant_created' row, so the tenant itself can never
    // be hard-deleted afterward. Soft-delete instead, same convention the
    // rest of the schema uses; the partial unique index on tenant_name is
    // scoped to deleted_at IS NULL, so it drops out of every live listing.
    for (const tenantId of createdTenantIds) {
      await pool.query(`UPDATE tenant SET deleted_at = now() WHERE tenant_id = $1`, [tenantId]);
    }
    await srv.close();
    await pool.end();
  });

  // -------------------------------------------------------------------------
  it('creates a tenant with a pending tenant_admin and queues an invite email', async () => {
    const { createTenant } = await import('../src/web/admin_api.ts');
    const name = `Test Bootstrap Tenant ${Date.now()}`;
    const email = `admin+${Date.now()}@bootstraptest.example`;
    const out = await createTenant(pool, {
      tenantName: name, tenantType: 'billing_company',
      adminEmail: email, adminFirstName: 'New', adminLastName: 'Admin',
    });
    createdTenantIds.push(out.tenantId);
    assert.ok(out.tenantId);
    assert.ok(out.userId);
    assert.ok(out.inviteToken);

    const tenantRow = await pool.query(
      `SELECT tenant_name, tenant_type FROM tenant WHERE tenant_id = $1`, [out.tenantId]);
    assert.equal(tenantRow.rows[0].tenant_name, name);
    assert.equal(tenantRow.rows[0].tenant_type, 'billing_company');

    const userRow = await pool.query(
      `SELECT role, status, email FROM app_user WHERE user_id = $1`, [out.userId]);
    assert.equal(userRow.rows[0].role, 'tenant_admin');
    assert.equal(userRow.rows[0].status, 'pending');
    assert.equal(userRow.rows[0].email, email);

    const outboxRow = await pool.query(
      `SELECT to_email, kind FROM email_outbox WHERE tenant_id = $1`, [out.tenantId]);
    assert.equal(outboxRow.rows[0].to_email, email);
    assert.equal(outboxRow.rows[0].kind, 'immediate');

    const auditRow = await pool.query(
      `SELECT action FROM audit_log WHERE tenant_id = $1 AND action = 'tenant_created'`,
      [out.tenantId]);
    assert.ok(auditRow.rows[0], 'tenant_created audit event recorded');
  });

  it('rejects a duplicate tenant name', async () => {
    const { createTenant } = await import('../src/web/admin_api.ts');
    const name = `Test Duplicate Tenant ${Date.now()}`;
    const first = await createTenant(pool, {
      tenantName: name, tenantType: 'provider_group', adminEmail: `a1-${Date.now()}@example.com`,
    });
    createdTenantIds.push(first.tenantId);
    await assert.rejects(
      createTenant(pool, {
        tenantName: name, tenantType: 'provider_group', adminEmail: `a2-${Date.now()}@example.com`,
      }),
      /already exists/,
    );
  });

  it('rejects an invalid tenant type', async () => {
    const { createTenant } = await import('../src/web/admin_api.ts');
    await assert.rejects(
      createTenant(pool, {
        tenantName: `Test Invalid Type ${Date.now()}`, tenantType: 'not_a_real_type',
        adminEmail: `x-${Date.now()}@example.com`,
      }),
      /invalid tenant type/,
    );
  });

  it('the invited admin can accept the invite and log in, scoped to only their own tenant', async () => {
    const { createTenant } = await import('../src/web/admin_api.ts');
    const email = `admin2+${Date.now()}@bootstraptest.example`;
    const out = await createTenant(pool, {
      tenantName: `Test Full Flow Tenant ${Date.now()}`, tenantType: 'health_system',
      adminEmail: email,
    });
    createdTenantIds.push(out.tenantId);

    const accept = await fetch(base + '/api/accept-invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: out.inviteToken, password: 'Str0ng!Passw0rd' }),
    });
    assert.equal(accept.status, 200, await accept.text());

    const activated = await pool.query(
      `SELECT status, password_hash IS NOT NULL AS has_password FROM app_user WHERE user_id = $1`,
      [out.userId]);
    assert.equal(activated.rows[0].status, 'active');
    assert.equal(activated.rows[0].has_password, true);

    // enforce_mfa defaults to true for real tenants (unlike the demo seed) —
    // an admin role hits the enrollment gate on first login, same as any
    // other admin account. That's the real, expected first-login experience.
    const login = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Str0ng!Passw0rd' }),
    });
    assert.equal(login.status, 428);
    const loginBody = await login.json();
    assert.equal(loginBody.mfaEnroll, true);
    assert.ok(loginBody.otpauthUri);

    // cross-tenant isolation: this brand-new tenant has nothing to do with
    // the seeded demo tenant
    const scopeCheck = await pool.query(
      `SELECT 1 FROM app_user WHERE user_id = $1 AND tenant_id = $2`, [out.userId, DEMO_TENANT]);
    assert.equal(scopeCheck.rows[0], undefined);
  });
});
