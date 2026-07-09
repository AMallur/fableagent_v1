// ============================================================================
// Integration & ingestion layer test — runs against the seeded demo tenant
// (reseed before each pass).
//
//   TEST_DATABASE_URL=postgres://... node --test test/api_integration.test.ts
//
// Covers: API key lifecycle (create/list/revoke, shown-once secret), /api/v1
// auth + scopes + rate limiting + request logging, claims ingest (raw X12 and
// JSON), remittance ingest with detection trigger, cases list/detail/actions,
// recovery summary, manual-upload preview→commit, CSV ingest, the SFTP-drop
// sweep with processed/errors routing, outbound connector dispatch, and the
// generated API docs.
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { FIXTURE_835, FIXTURE_837 } from './ingest.test.ts';

const url = process.env.TEST_DATABASE_URL;
const T = 'de300000-0000-4000-8000-000000000001';
const C = 'de300000-0000-4000-8000-000000000002';

describe('integration & ingestion layer', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  let pool: any, srv: any, base = '', adminCookie = '', apiKey = '', apiKeyId = '';

  const admin = {
    get: async (p: string, expect = 200) => {
      const res = await fetch(base + p, { headers: { cookie: adminCookie } });
      assert.equal(res.status, expect, `GET ${p}`);
      return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
    },
    post: async (p: string, body: unknown, expect = 200) => {
      const res = await fetch(base + p, {
        method: 'POST', headers: { cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      assert.equal(res.status, expect, `POST ${p}: ${JSON.stringify(out)}`);
      return out;
    },
  };
  const v1 = async (method: string, p: string, opts: {
    body?: string; contentType?: string; key?: string; expect?: number;
  } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        Authorization: `Bearer ${opts.key ?? apiKey}`,
        ...(opts.contentType ? { 'Content-Type': opts.contentType } : {}),
      },
      body: opts.body,
    });
    const out = await res.json().catch(() => ({}));
    if (opts.expect != null) assert.equal(res.status, opts.expect, `${method} ${p}: ${JSON.stringify(out)}`);
    return { status: res.status, body: out, headers: res.headers };
  };

  before(async () => {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: url });
    const { startServer } = await import('../src/web/server.ts');
    srv = await startServer(pool, { port: 0, sessionSecret: 'test-secret' });
    base = `http://localhost:${srv.port}`;
    const res = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@meridianrcm.com', password: 'demo1234' }),
    });
    adminCookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  });

  after(async () => {
    await srv.close();
    await pool.end();
  });

  // -------------------------------------------------------------------------
  it('API key lifecycle: create (shown once), hashed at rest, list, revoke', async () => {
    const created = await admin.post(`/api/admin/clients/${C}/api-keys`, { name: 'pm-system prod' });
    assert.match(created.apiKey, /^rcm_[0-9a-f]{8}_[0-9a-f]{48}$/);
    apiKey = created.apiKey;
    apiKeyId = created.apiKeyId;
    // only the hash is stored
    const row = await pool.query(
      `SELECT key_hash, key_prefix FROM api_key WHERE api_key_id = $1`, [apiKeyId]);
    assert.ok(!row.rows[0].key_hash.includes(apiKey.slice(-20)));
    assert.ok(apiKey.startsWith(row.rows[0].key_prefix));

    const { keys } = await admin.get(`/api/admin/clients/${C}/api-keys`) as any;
    assert.equal(keys[0].name, 'pm-system prod');
    assert.deepEqual(keys[0].scopes, ['read', 'ingest']);

    // a second key can be created and revoked; the revoked key stops working
    const second = await admin.post(`/api/admin/clients/${C}/api-keys`, { name: 'temp' });
    await v1('GET', '/api/v1/reports/recovery-summary', { key: second.apiKey, expect: 200 });
    await admin.post(`/api/admin/api-keys/${second.apiKeyId}/revoke`, {});
    await v1('GET', '/api/v1/reports/recovery-summary', { key: second.apiKey, expect: 401 });
  });

  it('rejects missing/garbage keys and enforces scopes', async () => {
    const noKey = await fetch(base + '/api/v1/cases');
    assert.equal(noKey.status, 401);
    await v1('GET', '/api/v1/cases', { key: 'rcm_dead_beef', expect: 401 });

    const readOnly = await admin.post(`/api/admin/clients/${C}/api-keys`,
      { name: 'read only', scopes: ['read'] });
    await v1('GET', '/api/v1/cases', { key: readOnly.apiKey, expect: 200 });
    await v1('POST', '/api/v1/claims/ingest', {
      key: readOnly.apiKey, contentType: 'application/json',
      body: JSON.stringify({ claims: [] }), expect: 403,
    });
  });

  it('ingests claims via JSON and raw X12; idempotent on re-send', async () => {
    const jsonClaims = {
      billingProvider: { name: 'ALPHA ORTHO GROUP', npi: '1234567890' },
      transactionDate: '2026-07-01',
      claims: [{
        claimNumber: 'API-CLM-1', chargeAmount: 400, placeOfService: '11',
        diagnosisCodes: ['M17.11'], payerName: 'Unity Health Plan',
        subscriber: { firstName: 'Api', lastName: 'Patient', memberId: 'MEM-API-1', dob: '1975-01-02' },
        renderingProvider: { name: 'Dr. Alan Smith', npi: '1111111111' },
        lines: [{ procedureCode: '99214', chargeAmount: 400, units: 1, dateOfService: '2026-06-25' }],
      }],
    };
    const r1 = await v1('POST', '/api/v1/claims/ingest', {
      contentType: 'application/json', body: JSON.stringify(jsonClaims), expect: 200,
    });
    assert.equal(r1.body.recordsProcessed, 1);
    const claim = await pool.query(
      `SELECT claim_id, billed_amount FROM claim
       WHERE client_id = $1 AND claim_number_internal = 'API-CLM-1'`, [C]);
    assert.equal(Number(claim.rows[0].billed_amount), 400);

    // idempotent
    const r2 = await v1('POST', '/api/v1/claims/ingest', {
      contentType: 'application/json', body: JSON.stringify(jsonClaims), expect: 200,
    });
    assert.equal(r2.body.recordsProcessed, 0);
    assert.equal(r2.body.skipped, 1);

    // raw X12 with fresh claim numbers
    const raw = FIXTURE_837.replaceAll('IT-CLM-', 'API-X12-');
    const r3 = await v1('POST', '/api/v1/claims/ingest', {
      contentType: 'text/plain', body: raw, expect: 200,
    });
    assert.equal(r3.body.recordsProcessed, 2);

    // validation errors are 400 with a field pointer
    const bad = await v1('POST', '/api/v1/claims/ingest', {
      contentType: 'application/json',
      body: JSON.stringify({ claims: [{ lines: [] }] }), expect: 400,
    });
    assert.match(bad.body.error, /claimNumber/);
  });

  it('ingests a remittance via JSON, triggers matching + detection', async () => {
    // pay API-CLM-1 at $100 vs $185 contract rate (99214 on Unity) -> underpayment
    await pool.query(
      `UPDATE claim SET claim_number_payer = 'API-ICN-1'
       WHERE client_id = $1 AND claim_number_internal = 'API-CLM-1'`, [C]);
    const r = await v1('POST', '/api/v1/remittances/ingest', {
      contentType: 'application/json',
      expect: 200,
      body: JSON.stringify({
        payer: { name: 'Unity Health Plan', idCode: 'DEMO-UNI' },
        checkNumber: 'CHK-API-1', checkDate: '2026-07-06', totalPaid: 100,
        claims: [{
          claimNumber: 'API-CLM-1', payerClaimNumber: 'API-ICN-1',
          billedAmount: 400, paidAmount: 100,
          patient: { firstName: 'Api', lastName: 'Patient', memberId: 'MEM-API-1' },
          lines: [{
            procedureCode: '99214', billedAmount: 400, paidAmount: 100,
            dateOfService: '2026-06-25',
            adjustments: [{ groupCode: 'CO', reasonCode: '45', amount: 300 }],
          }],
        }],
      }),
    });
    assert.equal(r.body.recordsProcessed, 1);
    assert.ok(r.body.detection, 'detection summary returned');
    assert.ok(r.body.detection.matched >= 1);
    assert.ok(r.body.detection.casesCreated >= 1, 'underpayment case created');

    const rc = await pool.query(
      `SELECT rc.case_type, rc.recovery_opportunity FROM recovery_case rc
       JOIN claim cl ON cl.claim_id = rc.claim_id
       WHERE cl.claim_number_internal = 'API-CLM-1'`);
    assert.equal(rc.rows[0].case_type, 'underpayment');
    assert.ok(Number(rc.rows[0].recovery_opportunity) > 0);
  });

  it('reads cases with filters, case detail, and logs external actions', async () => {
    const all = (await v1('GET', '/api/v1/cases?status=all', { expect: 200 })).body.cases;
    assert.ok(all.length > 10);
    const open = (await v1('GET', '/api/v1/cases', { expect: 200 })).body.cases;
    assert.ok(open.every((c: any) =>
      ['open', 'in_progress', 'submitted', 'pending_payer'].includes(c.status)));
    const crit = (await v1('GET', '/api/v1/cases?priority=critical', { expect: 200 })).body.cases;
    assert.ok(crit.every((c: any) => c.priority === 'critical'));

    const detail = (await v1('GET', `/api/v1/cases/${open[0].caseId}`, { expect: 200 })).body;
    assert.ok(detail.claim.lines.length > 0);
    assert.ok(detail.patient.name);
    // API PHI reads are logged too
    const phi = await pool.query(
      `SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'phi_accessed'
       AND after_state->>'context' LIKE 'api case detail%'`, [T]);
    assert.ok(phi.rows[0]);

    const action = await v1('POST', `/api/v1/cases/${open[0].caseId}/actions`, {
      contentType: 'application/json', expect: 200,
      body: JSON.stringify({ actionType: 'note', source: 'athenahealth', notes: 'synced from PM' }),
    });
    assert.ok(action.body.actionId);
    const timeline = (await v1('GET', `/api/v1/cases/${open[0].caseId}`, { expect: 200 })).body.timeline;
    assert.ok(timeline.some((t: any) => /via API: athenahealth/.test(t.notes ?? '')));

    // another client's case is a 404, not a 403 (existence not revealed)
    const foreign = await pool.query(
      `SELECT case_id FROM recovery_case WHERE client_id <> $1 LIMIT 1`, [C]);
    if (foreign.rows[0]) {
      await v1('GET', `/api/v1/cases/${foreign.rows[0].case_id}`, { expect: 404 });
    }
  });

  it('recovery summary returns live aggregates', async () => {
    const s = (await v1('GET', '/api/v1/reports/recovery-summary', { expect: 200 })).body;
    assert.ok(s.openCases > 0);
    assert.ok(s.openRecoveryOpportunity > 0);
    assert.ok(s.recoveredAllTime >= 0);
    assert.ok(Array.isArray(s.openByCategory) && s.openByCategory.length > 0);
  });

  it('rate limits per key with Retry-After', async () => {
    const limited = await admin.post(`/api/admin/clients/${C}/api-keys`,
      { name: 'tiny limit', rateLimitPerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      await v1('GET', '/api/v1/reports/recovery-summary', { key: limited.apiKey, expect: 200 });
    }
    const over = await v1('GET', '/api/v1/reports/recovery-summary', { key: limited.apiKey });
    assert.equal(over.status, 429);
    assert.ok(Number(over.headers.get('retry-after')) >= 1);
  });

  it('logs every API call with status and latency', async () => {
    const logs = await pool.query(
      `SELECT method, path, status, duration_ms FROM api_request_log
       WHERE api_key_id = $1 ORDER BY created_at`, [apiKeyId]);
    assert.ok(logs.rows.length >= 5);
    assert.ok(logs.rows.every((r: any) => r.duration_ms >= 0));
    assert.ok(logs.rows.some((r: any) => r.path === '/api/v1/claims/ingest' && r.status === 200));
    assert.ok(logs.rows.some((r: any) => r.status === 400), '400s are logged too');
  });

  // -------------------------------------------------------------------------
  it('manual upload: preview parses without writing; commit ingests + detects', async () => {
    const csv = [
      'claim_number,payer_claim_number,procedure_code,billed_amount,paid_amount,group_code,reason_code,check_number,check_date,payer_name',
      'API-CLM-1,API-ICN-1,99214,400,50,CO,45,CHK-CSV-9,2026-07-06,Unity Health Plan',
    ].join('\n');

    const before = await pool.query(
      `SELECT count(*)::int AS n FROM remittance WHERE client_id = $1`, [C]);
    const preview = await fetch(
      base + `/api/admin/clients/${C}/ingest/preview?filename=export.csv`,
      { method: 'POST', headers: { cookie: adminCookie }, body: csv });
    const p = await preview.json();
    assert.equal(p.kind, 'csv');
    assert.equal(p.ok, true);
    assert.equal(p.summary.lines, 1);
    assert.equal(p.summary.totalPaid, 50);
    const mid = await pool.query(
      `SELECT count(*)::int AS n FROM remittance WHERE client_id = $1`, [C]);
    assert.equal(mid.rows[0].n, before.rows[0].n, 'preview wrote nothing');

    const commit = await fetch(
      base + `/api/admin/clients/${C}/ingest?detect=1&filename=export.csv`,
      { method: 'POST', headers: { cookie: adminCookie }, body: csv });
    const out = await commit.json();
    assert.equal(commit.status, 200, JSON.stringify(out));
    assert.equal(out.recordsProcessed, 1);
    assert.ok(out.detection, 'detection ran on commit');
    const after2 = await pool.query(
      `SELECT count(*)::int AS n FROM remittance WHERE client_id = $1 AND check_number = 'CHK-CSV-9'`, [C]);
    assert.equal(after2.rows[0].n, 1);
  });

  // -------------------------------------------------------------------------
  it('SFTP-drop sweep: ingests good files, quarantines bad ones with a log', async () => {
    const { sweepClientFolder } = await import('../src/integration/sweep.ts');
    const folder = path.join(process.cwd(), 'var', 'ingest-test', 'sweep', C);
    await mkdir(folder, { recursive: true });
    await pool.query(`UPDATE client SET ingest_folder = $2 WHERE client_id = $1`, [C, folder]);

    await writeFile(path.join(folder, 'good.835'),
      FIXTURE_835.replaceAll('CHK-IT-100', `CHK-SWEEP-${Date.now()}`));
    await writeFile(path.join(folder, 'bad.csv'), 'this,is\nnot,a,remit');
    await writeFile(path.join(folder, 'ignore.txt'), 'not an EDI file');

    const result = await sweepClientFolder(pool, { tenantId: T, clientId: C });
    const byName = new Map(result.files.map((f) => [f.fileName, f]));
    assert.equal(byName.get('good.835')!.status, 'ingested');
    assert.equal(byName.get('good.835')!.records, 2);
    assert.equal(byName.get('bad.csv')!.status, 'failed');
    assert.ok(!byName.has('ignore.txt'), 'non-EDI files are left alone');

    const processed = await readdir(path.join(folder, 'processed'));
    assert.ok(processed.some((f) => f.endsWith('good.835')));
    const errors = await readdir(path.join(folder, 'errors'));
    assert.ok(errors.includes('bad.csv'));
    assert.ok(errors.includes('bad.csv.log'));
    const log = await readFile(path.join(folder, 'errors', 'bad.csv.log'), 'utf8');
    assert.match(log, /bad\.csv/);
    assert.match(log, /CSV|rejected|header/i);

    // second sweep: folder is clean, nothing re-processes
    const again = await sweepClientFolder(pool, { tenantId: T, clientId: C });
    assert.equal(again.files.length, 0);
  });

  // -------------------------------------------------------------------------
  it('outbound connectors: electronic submit dispatches; PM write-back on status change', async () => {
    // ensure a clearinghouse + PM are configured
    await admin.post(`/api/admin/clients/${C}/integration`,
      { clearinghouseName: 'Availity', pmSystem: 'athenahealth' });

    const ready = await pool.query(
      `SELECT ap.packet_id, ap.case_id FROM appeal_packet ap
       WHERE ap.packet_status = 'ready' AND ap.submission_method = 'portal' LIMIT 1`);
    assert.ok(ready.rows[0], 'a ready portal packet exists');
    const sub = await admin.post(`/api/packets/${ready.rows[0].packet_id}/submit`, { manual: false });
    assert.ok(sub.delivery, 'connector dispatch recorded');
    assert.equal(sub.delivery.connector, 'payer_portal');
    assert.equal(sub.delivery.status, 'not_configured');

    // PM write-back on case status change
    const someCase = await pool.query(
      `SELECT case_id FROM recovery_case
       WHERE client_id = $1 AND status = 'open' AND deleted_at IS NULL LIMIT 1`, [C]);
    await admin.post(`/api/cases/${someCase.rows[0].case_id}/status`, { status: 'in_progress' });
    const wb = await pool.query(
      `SELECT connector, kind, status FROM outbound_delivery
       WHERE case_id = $1 AND kind = 'pm_writeback'`, [someCase.rows[0].case_id]);
    assert.ok(wb.rows[0], 'write-back delivery recorded');
    assert.equal(wb.rows[0].status, 'not_configured');

    const { deliveries } = await admin.get(`/api/admin/clients/${C}/deliveries`) as any;
    assert.ok(deliveries.length >= 2);
  });

  // -------------------------------------------------------------------------
  it('serves generated API documentation and OpenAPI spec publicly', async () => {
    const docs = await fetch(base + '/api/v1/docs');
    assert.equal(docs.status, 200);
    const html = await docs.text();
    assert.match(html, /API Reference/);
    assert.match(html, /POST<\/span> <code>\/api\/v1\/remittances\/ingest/);
    assert.match(html, /Authorization: Bearer rcm_/);
    assert.match(html, /429/);

    const spec = await fetch(base + '/api/v1/openapi.json');
    assert.equal(spec.status, 200);
    const openapi = await spec.json();
    assert.equal(openapi.openapi, '3.0.3');
    assert.ok(openapi.paths['/api/v1/claims/ingest'].post);
    assert.ok(openapi.paths['/api/v1/cases'].get);
    assert.ok(openapi.paths['/api/v1/cases/{caseId}'].get);
    assert.ok(openapi.components.securitySchemes.apiKey);
  });
});
