// ============================================================================
// Enterprise administration integration test — runs against the seeded demo
// tenant (scripts/seed_demo.ts must have run first; the suite mutates state,
// so reseed before each pass).
//
//   TEST_DATABASE_URL=postgres://... node --test test/admin_integration.test.ts
//
// Covers: login lockout, MFA enrollment + TOTP login when enforced, password
// policy + rotation, tenant overview, client creation with BAA gate +
// onboarding auto-evaluation, invites (policy-checked accept, login,
// deactivate), payer/feature/subscription config, integration settings with
// encrypted credentials + manual upload zone, billing/invoices/plan change,
// compliance reports (audit, PHI, jobs + rerun), export approval workflow,
// audit-log immutability, and SSO config + metadata + group mapping.
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { totpCode } from '../src/security/crypto.ts';
import { FIXTURE_835 } from './ingest.test.ts';

const url = process.env.TEST_DATABASE_URL;
const T = 'de300000-0000-4000-8000-000000000001';
const C = 'de300000-0000-4000-8000-000000000002';

describe('enterprise administration', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  let pool: any, srv: any, base = '';
  let adminCookie = '', billerCookie = '';
  let newClientId = '';

  const login = async (email: string, password: string, totp?: string) => {
    const res = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, totp }),
    });
    return { status: res.status, body: await res.json(),
      cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] };
  };
  const call = (cookie: string) => ({
    get: async (p: string, expect = 200) => {
      const res = await fetch(base + p, { headers: { cookie } });
      assert.equal(res.status, expect, `GET ${p}`);
      return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
    },
    post: async (p: string, body: unknown, expect = 200) => {
      const res = await fetch(base + p, {
        method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      assert.equal(res.status, expect, `POST ${p}: ${JSON.stringify(out)}`);
      return out;
    },
  });

  before(async () => {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: url });
    const { startServer } = await import('../src/web/server.ts');
    srv = await startServer(pool, { port: 0, sessionSecret: 'test-secret' });
    base = `http://localhost:${srv.port}`;
    adminCookie = (await login('admin@meridianrcm.com', 'demo1234')).cookie;
    billerCookie = (await login('sarah@meridianrcm.com', 'demo1234')).cookie;
  });

  after(async () => {
    await srv.close();
    await pool.end();
  });

  // -------------------------------------------------------------------------
  it('locks the account after 5 failed logins, unlockable by admin reset', async () => {
    for (let i = 0; i < 4; i++) {
      assert.equal((await login('colin@meridianrcm.com', 'wrong')).status, 401);
    }
    const fifth = await login('colin@meridianrcm.com', 'wrong');
    assert.equal(fifth.status, 423);
    assert.match(fifth.body.error, /locked/);
    // even the correct password is rejected while locked
    assert.equal((await login('colin@meridianrcm.com', 'demo1234')).status, 423);
    // lockout events are in the audit trail
    const audit = await pool.query(
      `SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'login_lockout'`, [T]);
    assert.ok(audit.rows[0]);
    // clear for later tests
    await pool.query(
      `UPDATE app_user SET locked_until = NULL, failed_login_attempts = 0
       WHERE email = 'colin@meridianrcm.com'`);
  });

  it('enforces MFA for admin roles: enrollment, then TOTP login', async () => {
    await pool.query(`UPDATE tenant SET enforce_mfa = true WHERE tenant_id = $1`, [T]);
    // first login: enrollment challenge with a secret
    const enroll = await login('admin@meridianrcm.com', 'demo1234');
    assert.equal(enroll.status, 428);
    assert.equal(enroll.body.mfaEnroll, true);
    assert.ok(enroll.body.secret);
    assert.match(enroll.body.otpauthUri, /^otpauth:\/\/totp\//);
    // wrong code re-prompts enrollment
    const bad = await login('admin@meridianrcm.com', 'demo1234', '000000');
    assert.equal(bad.status, 428);
    // valid code completes enrollment and logs in
    const good = await login('admin@meridianrcm.com', 'demo1234', totpCode(enroll.body.secret));
    assert.equal(good.status, 200, JSON.stringify(good.body));
    // subsequent logins demand a code
    const noCode = await login('admin@meridianrcm.com', 'demo1234');
    assert.equal(noCode.status, 428);
    assert.equal(noCode.body.mfaRequired, true);
    const withCode = await login('admin@meridianrcm.com', 'demo1234', totpCode(enroll.body.secret));
    assert.equal(withCode.status, 200);
    adminCookie = withCode.cookie;
    // the secret is encrypted at rest
    const stored = await pool.query(
      `SELECT mfa_secret FROM app_user WHERE email = 'admin@meridianrcm.com'`);
    assert.ok(stored.rows[0].mfa_secret.startsWith('enc1:'));
    assert.ok(!stored.rows[0].mfa_secret.includes(enroll.body.secret));
    // non-admin (biller) logs in without MFA even when enforced
    assert.equal((await login('sarah@meridianrcm.com', 'demo1234')).status, 200);
    await pool.query(`UPDATE tenant SET enforce_mfa = false WHERE tenant_id = $1`, [T]);
  });

  it('enforces 90-day password rotation for admins, with policy-checked change', async () => {
    // defensive: independent of the MFA test's cleanup
    await pool.query(`UPDATE tenant SET enforce_mfa = false WHERE tenant_id = $1`, [T]);
    await pool.query(
      `UPDATE app_user SET password_changed_at = now() - interval '100 days'
       WHERE email = 'admin@meridianrcm.com'`);
    const expired = await login('admin@meridianrcm.com', 'demo1234');
    assert.equal(expired.status, 403);
    assert.equal(expired.body.passwordExpired, true);
    // weak new password rejected by policy
    const weak = await fetch(base + '/api/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@meridianrcm.com', oldPassword: 'demo1234',
        newPassword: 'short' }),
    });
    assert.equal(weak.status, 400);
    assert.match((await weak.json()).error, /policy/);
    // strong password accepted; login works again
    const strong = await fetch(base + '/api/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@meridianrcm.com', oldPassword: 'demo1234',
        newPassword: 'N3w!AdminPassw0rd' }),
    });
    assert.equal(strong.status, 200);
    const back = await login('admin@meridianrcm.com', 'N3w!AdminPassw0rd');
    assert.equal(back.status, 200);
    adminCookie = back.cookie;
    // restore the demo password for later suites
    await fetch(base + '/api/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@meridianrcm.com',
        oldPassword: 'N3w!AdminPassw0rd', newPassword: 'demo1234demoA!' }),
    });
    await pool.query(
      `UPDATE app_user SET password_hash = (SELECT password_hash FROM app_user
        WHERE email = 'sarah@meridianrcm.com'), password_changed_at = now()
       WHERE email = 'admin@meridianrcm.com'`);
    adminCookie = (await login('admin@meridianrcm.com', 'demo1234')).cookie;
  });

  // -------------------------------------------------------------------------
  it('tenant overview: AUM, recovered, cases, users, health', async () => {
    const admin = call(adminCookie);
    const d = await admin.get('/api/admin/overview') as any;
    assert.ok(d.totals.clients >= 1);
    assert.ok(d.totals.aum > 0, 'AUM in recovery');
    assert.ok(d.totals.recovered > 0, 'recovered all time');
    assert.ok(d.totals.activeCases > 0);
    assert.ok(d.totals.users >= 3);
    assert.ok(['healthy', 'degraded'].includes(d.health.status));
    assert.ok(d.clients[0].onboarding.total === 8);
    // tenant admin screens are role-gated
    await call(billerCookie).get('/api/admin/overview', 403);
  });

  it('client creation requires BAA; onboarding checklist auto-evaluates', async () => {
    const admin = call(adminCookie);
    await admin.post('/api/admin/clients', { clientName: 'NoBaa Clinic', baaAcknowledged: false }, 428);
    const created = await admin.post('/api/admin/clients', {
      clientName: 'Westlake Cardiology', taxId: '74-9998888', npiGroup: '5556667770',
      state: 'TX', baaAcknowledged: true,
    });
    newClientId = created.clientId;

    const ob1 = await admin.get(`/api/admin/clients/${newClientId}/onboarding`) as any;
    assert.equal(ob1.steps.length, 8);
    // profile is incomplete (no address yet), nothing else exists yet
    assert.equal(ob1.steps.filter((s: any) => s.completed).length, 0);

    // complete the profile -> step 1 auto-completes
    await admin.post(`/api/admin/clients/${newClientId}/settings`, {
      address: { line1: '55 Lake Blvd', city: 'Austin', state: 'TX', zip: '78746' },
    });
    const ob2 = await admin.get(`/api/admin/clients/${newClientId}/onboarding`) as any;
    assert.equal(ob2.steps.find((s: any) => s.key === 'profile').completed, true);

    // the demo client (fully seeded) auto-completes steps 1-7; step 8 is manual
    const obDemo = await admin.get(`/api/admin/clients/${C}/onboarding`) as any;
    assert.equal(obDemo.steps.filter((s: any) => s.completed).length, 7);
    assert.equal(obDemo.steps.find((s: any) => s.key === 'admin_review').completed, false);
    await admin.post(`/api/admin/clients/${C}/onboarding/admin_review/complete`, {});
    const obDone = await admin.get(`/api/admin/clients/${C}/onboarding`) as any;
    assert.equal(obDone.steps.filter((s: any) => s.completed).length, 8);
  });

  it('user management: invite -> policy-checked accept -> login; deactivate blocks', async () => {
    const admin = call(adminCookie);
    const invited = await admin.post('/api/admin/users/invite', {
      email: 'newbiller@meridianrcm.com', firstName: 'Nina', lastName: 'New',
      role: 'biller', clientId: C,
    });
    assert.ok(invited.inviteToken);
    // duplicate invite blocked
    await admin.post('/api/admin/users/invite',
      { email: 'newbiller@meridianrcm.com', role: 'biller' }, 409);
    // invite email queued
    const outbox = await pool.query(
      `SELECT 1 FROM email_outbox WHERE to_email = 'newbiller@meridianrcm.com'`);
    assert.ok(outbox.rows[0]);
    // weak password rejected on accept
    const weak = await fetch(base + '/api/accept-invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invited.inviteToken, password: 'weakpw' }),
    });
    assert.equal(weak.status, 400);
    // strong password activates the account
    const ok = await fetch(base + '/api/accept-invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invited.inviteToken, password: 'Nina!Secure99pw' }),
    });
    assert.equal(ok.status, 200);
    // token is single-use
    const reuse = await fetch(base + '/api/accept-invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invited.inviteToken, password: 'Nina!Secure99pw' }),
    });
    assert.equal(reuse.status, 410);
    assert.equal((await login('newbiller@meridianrcm.com', 'Nina!Secure99pw')).status, 200);

    // client-scoped user sees only their client's cases
    const ninaCookie = (await login('newbiller@meridianrcm.com', 'Nina!Secure99pw')).cookie;
    const rows = (await call(ninaCookie).get('/api/cases?status=all') as any).rows;
    assert.ok(rows.length > 0);

    // deactivation blocks login
    await admin.post(`/api/admin/users/${invited.userId}/deactivate`, {});
    assert.equal((await login('newbiller@meridianrcm.com', 'Nina!Secure99pw')).status, 401);
    // user activity log exists
    const activity = await admin.get(`/api/admin/users/${invited.userId}/activity`) as any;
    assert.ok(activity.some((a: any) => a.action === 'invite_accepted'));
  });

  it('payer config, features, subscription status', async () => {
    const admin = call(adminCookie);
    // tenant-scoped payer is fully editable
    const payer = await admin.post('/api/admin/payers', {
      payerName: 'Westlake Health Plan', payerType: 'commercial',
      timelyFilingDays: 120, appealDeadlineDays: 90,
    });
    await admin.post(`/api/admin/clients/${C}/payer-config`, {
      payerId: payer.payerId, autopilot: true, reviewThreshold: 2500,
      timelyFilingDays: 100, portalUrl: 'https://portal.westlake.example',
    });
    const detail = await admin.get(`/api/admin/clients/${C}`) as any;
    const p = detail.payers.find((x: any) => x.payerId === payer.payerId);
    assert.equal(p.autopilot, true);
    assert.equal(p.reviewThreshold, 2500);
    assert.equal(p.timelyFilingDays, 100);
    assert.equal(p.editable, true);
    // shared master payer fields are rejected
    const shared = detail.payers.find((x: any) => !x.editable);
    assert.ok(shared, 'a shared payer exists');
    await admin.post(`/api/admin/clients/${C}/payer-config`,
      { payerId: shared.payerId, timelyFilingDays: 45 }, 409);
    // but its client-level config still saves
    await admin.post(`/api/admin/clients/${C}/payer-config`,
      { payerId: shared.payerId, autopilot: false, reviewThreshold: 1000 });

    // feature flags + subscription
    await admin.post(`/api/admin/clients/${C}/features`, { feature: 'analytics', enabled: false });
    await admin.post(`/api/admin/clients/${C}/subscription`, { status: 'active' });
    const d2 = await admin.get(`/api/admin/clients/${C}`) as any;
    assert.equal(d2.client.features.analytics, false);
    assert.equal(d2.client.subscription, 'active');
    await admin.post(`/api/admin/clients/${C}/features`, { feature: 'analytics', enabled: true });
  });

  it('integration settings: encrypted credentials, connection test, manual upload zone', async () => {
    const admin = call(adminCookie);
    const saved = await admin.post(`/api/admin/clients/${C}/integration`, {
      sftpHost: 'localhost', sftpUsername: 'meridian-drop',
      sftpPassword: 'super-secret-sftp-pw', sftpPath: '/inbound/835',
      clearinghouseName: 'Availity', pmSystem: 'athenahealth',
    });
    assert.equal(saved.sftpPasswordStored, true);
    // credential is encrypted at rest — never plaintext
    const row = await pool.query(
      `SELECT sftp_password_encrypted FROM client_integration WHERE client_id = $1`, [C]);
    assert.ok(row.rows[0].sftp_password_encrypted.startsWith('enc1:'));
    assert.ok(!row.rows[0].sftp_password_encrypted.includes('super-secret'));
    // the API never returns the password
    const detail = await admin.get(`/api/admin/clients/${C}`) as any;
    assert.equal(detail.integration.sftpPasswordSet, true);
    assert.ok(!JSON.stringify(detail.integration).includes('super-secret'));
    // connection test (localhost resolves)
    const test = await admin.post(`/api/admin/clients/${C}/integration/test`, {});
    assert.equal(test.tested, true);

    // manual upload zone runs a real ingest
    const content = FIXTURE_835.replaceAll('CHK-IT-100', `CHK-ADMIN-${Date.now()}`);
    const res = await fetch(base + `/api/admin/clients/${C}/ingest?filename=manual.835`, {
      method: 'POST', headers: { cookie: adminCookie }, body: content,
    });
    const out = await res.json();
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.equal(out.recordsProcessed, 2);
  });

  it('billing: usage, invoice generation, plan change', async () => {
    const admin = call(adminCookie);
    const b1 = await admin.get(`/api/admin/clients/${C}/billing`) as any;
    assert.equal(b1.plan, 'professional');
    assert.ok(b1.usageThisPeriod.claimsProcessed >= 0);
    assert.ok(b1.availablePlans.length === 3);

    const month = new Date().toISOString().slice(0, 7);
    const inv = await admin.post(`/api/admin/clients/${C}/billing/invoice`, { month });
    assert.ok(inv.amountDue >= b1.pricing.base, 'base fee + per-case usage');
    const b2 = await admin.get(`/api/admin/clients/${C}/billing`) as any;
    assert.equal(b2.invoices.length, 1);
    assert.ok(b2.invoices[0].casesCreated >= 0);

    await admin.post('/api/admin/plan', { tier: 'enterprise' });
    const b3 = await admin.get(`/api/admin/clients/${C}/billing`) as any;
    assert.equal(b3.plan, 'enterprise');
    await admin.post('/api/admin/plan', { tier: 'professional' });
    // billers cannot change plans
    await call(billerCookie).post('/api/admin/plan', { tier: 'enterprise' }, 403);
  });

  // -------------------------------------------------------------------------
  it('PHI access is logged when patient records are viewed', async () => {
    const admin = call(adminCookie);
    const rows = (await admin.get('/api/cases') as any).rows;
    await admin.get('/api/cases/' + rows[0].caseId);
    const phi = await admin.get('/api/compliance/phi-access') as any;
    assert.ok(phi.rows.length >= 1, 'PHI access recorded');
    assert.equal(phi.rows[0].user, 'Maya Admin');
    assert.ok(phi.rows[0].patientName);
    assert.match(phi.rows[0].context, /case detail/);
  });

  it('audit trail report filters; audit log is immutable at the DB level', async () => {
    const admin = call(adminCookie);
    const all = await admin.get('/api/compliance/audit?limit=50') as any;
    assert.ok(all.rows.length > 10);
    const logins = await admin.get('/api/compliance/audit?action=login_succeeded') as any;
    assert.ok(logins.rows.length >= 1);
    assert.ok(logins.rows.every((r: any) => r.action === 'login_succeeded'));
    const filters = await admin.get('/api/compliance/audit-filters') as any;
    assert.ok(filters.actions.includes('phi_accessed'));

    // immutability: UPDATE and DELETE raise, even as the table owner
    await assert.rejects(
      pool.query(`UPDATE audit_log SET action = 'forged' WHERE tenant_id = $1`, [T]),
      /append-only/);
    await assert.rejects(
      pool.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [T]),
      /append-only/);
  });

  it('system job log with error detail and rerun of failed jobs', async () => {
    const admin = call(adminCookie);
    // manufacture a failed detection job record
    const failed = await pool.query(
      `INSERT INTO system_job (tenant_id, client_id, job_type, status, started_at,
                               completed_at, errors_count, log_output)
       VALUES ($1, $2, 'run_detection', 'failed', now(), now(), 1, 'Error: simulated failure')
       RETURNING job_id`, [T, C]);
    const jobs = await admin.get('/api/compliance/jobs?status=failed') as any;
    const target = jobs.rows.find((j: any) => j.jobId === failed.rows[0].job_id);
    assert.ok(target);
    assert.match(target.detail, /simulated failure/);
    assert.equal(target.rerunnable, true);

    const rerun = await admin.post(`/api/compliance/jobs/${failed.rows[0].job_id}/rerun`, {});
    assert.ok(rerun.newJobId);
    const newJob = await pool.query(
      `SELECT status FROM system_job WHERE job_id = $1`, [rerun.newJobId]);
    assert.equal(newJob.rows[0].status, 'completed');
  });

  it('data export: non-admin requires approval; admin auto-approves; all logged', async () => {
    const biller = call(billerCookie);
    const admin = call(adminCookie);

    const req = await biller.post('/api/exports', { exportType: 'cases', params: {} });
    assert.equal(req.status, 'pending');
    // download before approval is blocked
    const early = await fetch(base + `/api/exports/${req.exportId}/download`,
      { headers: { cookie: billerCookie } });
    assert.equal(early.status, 403);

    await admin.post(`/api/exports/${req.exportId}/approve`, {});
    const dl = await fetch(base + `/api/exports/${req.exportId}/download`,
      { headers: { cookie: billerCookie } });
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-type') ?? '', /text\/csv/);
    const csv = await dl.text();
    assert.match(csv.split('\n')[0], /case_id/);
    assert.ok(csv.split('\n').length > 5);

    // admin's own export auto-approves
    const own = await admin.post('/api/exports', { exportType: 'audit_trail', params: {} });
    assert.equal(own.status, 'approved');
    // the full chain is in the audit trail
    const audit = await admin.get('/api/compliance/audit?action=data_export_downloaded') as any;
    assert.ok(audit.rows.length >= 1);
  });

  // -------------------------------------------------------------------------
  it('SSO: config round-trip, SP metadata, login redirect guard', async () => {
    const admin = call(adminCookie);
    await admin.post('/api/admin/sso', {
      enabled: false, idpEntityId: 'https://idp.example.com/metadata',
      idpSsoUrl: 'https://idp.example.com/sso',
      idpCertificate: 'MIIB-fake-cert-for-config-test',
      groupAttribute: 'groups', defaultRole: 'viewer',
      groupRoleMappings: [{ group: 'rcm-admins', role: 'tenant_admin' }],
    });
    const cfg = await admin.get('/api/admin/sso') as any;
    assert.equal(cfg.config.idp_sso_url, 'https://idp.example.com/sso');
    assert.equal(cfg.config.group_role_mappings[0].role, 'tenant_admin');

    // SP metadata serves valid XML without auth (the IdP fetches it)
    const md = await fetch(base + `/sso/metadata?tenant=${T}`);
    assert.equal(md.status, 200);
    const xml = await md.text();
    assert.match(xml, /EntityDescriptor/);
    assert.match(xml, /AssertionConsumerService/);

    // disabled SSO refuses to start a login
    const disabled = await fetch(base + `/sso/login?tenant=${T}`, { redirect: 'manual' });
    assert.equal(disabled.status, 409);

    // enabled SSO redirects to the IdP with a SAMLRequest
    await admin.post('/api/admin/sso', {
      enabled: true, idpEntityId: 'https://idp.example.com/metadata',
      idpSsoUrl: 'https://idp.example.com/sso',
      idpCertificate: 'MIIB-fake-cert-for-config-test',
      groupRoleMappings: [], defaultRole: 'viewer',
    });
    const redir = await fetch(base + `/sso/login?tenant=${T}`, { redirect: 'manual' });
    assert.equal(redir.status, 302);
    const loc = redir.headers.get('location') ?? '';
    assert.match(loc, /^https:\/\/idp\.example\.com\/sso\?/);
    assert.match(loc, /SAMLRequest=/);
    // a garbage assertion is rejected, never a session
    const acs = await fetch(base + `/sso/acs?tenant=${T}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'SAMLResponse=' + encodeURIComponent(Buffer.from('<junk/>').toString('base64')),
    });
    assert.ok(acs.status >= 400);
    await pool.query(`UPDATE sso_config SET enabled = false WHERE tenant_id = $1`, [T]);
  });

  it('admin page shells render for admins and are hidden from non-admins', async () => {
    for (const p of ['/admin', '/admin/users', `/admin/client/${C}`, '/compliance']) {
      const html = await call(adminCookie).get(p) as string;
      assert.match(html, /<html/i, p);
    }
    // page shells load for billers too but their API calls 403 (tested above);
    // nav hides admin sections — check the rendered nav has no Tenant Overview
    const billerDash = await call(billerCookie).get('/dashboard') as string;
    assert.ok(!billerDash.includes('Tenant Overview'));
    const adminDash = await call(adminCookie).get('/dashboard') as string;
    assert.ok(adminDash.includes('Tenant Overview'));
  });
});
