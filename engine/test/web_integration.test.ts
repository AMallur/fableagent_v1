// ============================================================================
// Web interface integration test — drives the real HTTP server against the
// seeded demo tenant (scripts/seed_demo.ts must have run).
//
//   TEST_DATABASE_URL=postgres://... node --test test/web_integration.test.ts
//
// Covers: auth, every screen's data API (dashboard, queue + filters/sort,
// case detail, builder, all four reports), and every action (notes, calls,
// assign, bulk, upload -> packet refresh, submit, manual case creation,
// manual payment match, run-detection).
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

describe('operational web interface', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  let pool: any, srv: any, base = '', cookie = '';

  const get = async (path: string, expectStatus = 200) => {
    const res = await fetch(base + path, { headers: { cookie } });
    assert.equal(res.status, expectStatus, `GET ${path}`);
    return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
  };
  const post = async (path: string, body: unknown, expectStatus = 200) => {
    const res = await fetch(base + path, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const out = await res.json();
    assert.equal(res.status, expectStatus, `POST ${path}: ${JSON.stringify(out)}`);
    return out;
  };

  before(async () => {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: url });
    const { startServer } = await import('../src/web/server.ts');
    const { FileSystemDocumentStore } = await import('../src/appeals/storage.ts');
    srv = await startServer(pool, {
      port: 0, sessionSecret: 'test-secret',
      store: new FileSystemDocumentStore(), // same root the seed used
    });
    base = `http://localhost:${srv.port}`;
  });

  after(async () => {
    await srv.close();
    await pool.end();
  });

  it('rejects bad credentials and unauthenticated API calls', async () => {
    const bad = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@meridianrcm.com', password: 'wrong' }),
    });
    assert.equal(bad.status, 401);
    const noAuth = await fetch(base + '/api/dashboard');
    assert.equal(noAuth.status, 401);
    const pageRedirect = await fetch(base + '/dashboard', { redirect: 'manual' });
    assert.equal(pageRedirect.status, 302);
  });

  it('logs in and sets a session cookie', async () => {
    const res = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@meridianrcm.com', password: 'demo1234' }),
    });
    assert.equal(res.status, 200);
    cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
    assert.ok(cookie.startsWith('rcm_session='));
    assert.equal((await res.json()).role, 'tenant_admin');
  });

  it('serves every page shell as HTML', async () => {
    for (const p of ['/dashboard', '/queue', '/builder', '/reports/payers',
                     '/reports/denials', '/reports/reconciliation', '/reports/workload']) {
      const body = await get(p) as string;
      assert.match(body, /<html/i, p);
      assert.match(body, /RCM Recovery/, p);
    }
  });

  it('dashboard: real totals, charts, trend, activity', async () => {
    const d = await get('/api/dashboard') as any;
    assert.ok(d.openTotal.count > 0, 'open cases exist');
    assert.ok(d.openTotal.amount > 0);
    assert.ok(d.topPayers.length >= 2 && d.topPayers[0].amount >= d.topPayers[1].amount);
    assert.ok(d.topCategories.length >= 2);
    assert.ok(d.trend.weeks.length >= 4, '90-day trend has weekly buckets');
    assert.ok(d.trend.identified.some((v: number) => v > 0));
    assert.ok(d.trend.submitted.some((v: number) => v > 0));
    assert.ok(d.trend.recovered.some((v: number) => v > 0));
    assert.equal(d.activity.length, 10);
  });

  it('queue: loads, filters, and sorts real records', async () => {
    const all = (await get('/api/cases') as any).rows;
    assert.ok(all.length >= 10);
    for (const key of ['caseId', 'priority', 'patientName', 'payerName', 'dos',
                       'category', 'amount', 'status', 'daysOpen']) {
      assert.ok(key in all[0], key);
    }
    // filter: priority
    const crit = (await get('/api/cases?priority=critical') as any).rows;
    assert.ok(crit.every((r: any) => r.priority === 'critical'));
    assert.ok(crit.length < all.length);
    // filter: payer
    const payerId = all[0] && (await get('/api/lookups') as any).payers[0].id;
    const byPayer = (await get('/api/cases?payerId=' + payerId) as any).rows;
    assert.ok(byPayer.length > 0 && byPayer.length <= all.length);
    // filter: amount range
    const big = (await get('/api/cases?amountMin=200') as any).rows;
    assert.ok(big.every((r: any) => r.amount >= 200));
    // sort: amount desc
    const sorted = (await get('/api/cases?sort=amount&dir=desc') as any).rows;
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i - 1].amount >= sorted[i].amount, 'amount sorted desc');
    }
    // status filter includes closed cases when asked
    const won = (await get('/api/cases?status=won') as any).rows;
    assert.ok(won.length > 0 && won.every((r: any) => r.status === 'won'));
  });

  it('bulk assign and bulk status change execute', async () => {
    const rows = (await get('/api/cases?status=open') as any).rows.slice(0, 3);
    assert.ok(rows.length >= 2);
    const users = (await get('/api/lookups') as any).users;
    const target = users.find((u: any) => u.name.includes('Sarah'));
    const ids = rows.map((r: any) => r.caseId);
    const r1 = await post('/api/cases/bulk', { caseIds: ids, assignTo: target.id });
    assert.equal(r1.updated, ids.length);
    const after1 = (await get('/api/cases?assignedTo=' + target.id) as any).rows;
    assert.ok(ids.every((id: string) => after1.some((r: any) => r.caseId === id)));
    const r2 = await post('/api/cases/bulk', { caseIds: [ids[0]], status: 'in_progress' });
    assert.equal(r2.updated, 1);
  });

  it('case detail: full panels + note + payer call + reassign', async () => {
    const rows = (await get('/api/cases') as any).rows;
    const caseId = rows[0].caseId;
    const d = await get('/api/cases/' + caseId) as any;
    assert.ok(d.case.recoveryOpportunity > 0);
    assert.ok(d.patient.name && d.patient.mrn);
    assert.ok(d.claim.lines.length > 0);
    assert.ok('variance' in d.claim.lines[0]);
    assert.ok(d.remitLines.length > 0, 'EOB/835 data present');
    assert.ok(d.packet, 'packet attached');
    assert.ok(d.packet.documents.length >= 3, 'letter + eob + claim lines at minimum');
    assert.ok(d.timeline.length > 0);
    // page shell for the case renders
    const html = await get('/case/' + caseId) as string;
    assert.match(html, /Case Summary/);

    const beforeLen = d.timeline.length;
    await post(`/api/cases/${caseId}/note`, { notes: 'integration test note' });
    await post(`/api/cases/${caseId}/call`, { outcome: 'reprocessing_initiated', notes: 'spoke with rep' });
    const users = (await get('/api/lookups') as any).users;
    await post(`/api/cases/${caseId}/assign`, { userId: users[0].id });
    const d2 = await get('/api/cases/' + caseId) as any;
    assert.equal(d2.timeline.length, beforeLen + 3);
    assert.match(d2.timeline.at(-2).notes, /outcome: reprocessing_initiated/);
    assert.equal(d2.case.assignedToId, users[0].id);
  });

  it('letter content is served from document storage', async () => {
    const rows = (await get('/api/cases') as any).rows;
    for (const row of rows) {
      const d = await get('/api/cases/' + row.caseId) as any;
      if (d.packet?.letterDocumentId) {
        const letter = await (await fetch(
          base + `/api/documents/${d.packet.letterDocumentId}/content`, { headers: { cookie } },
        )).text();
        assert.match(letter, /RE: Appeal of claim determination/);
        assert.match(letter, /Enclosures:/);
        return;
      }
    }
    assert.fail('no packet with a letter found');
  });

  it('uploading a missing document flips a draft packet to ready', async () => {
    // find a medical-necessity case whose packet is draft (missing medical_record)
    const draft = await pool.query(
      `SELECT ap.packet_id, rc.case_id FROM appeal_packet ap
       JOIN recovery_case rc ON rc.case_id = ap.case_id
       WHERE ap.packet_status = 'draft' AND 'medical_record' = ANY(ap.missing_document_types)
       LIMIT 1`);
    assert.ok(draft.rows[0], 'seed produced a draft packet missing medical_record');
    const caseId = draft.rows[0].case_id;

    const res = await fetch(
      base + `/api/cases/${caseId}/documents?filename=op-note.txt&type=medical_record`,
      { method: 'POST', headers: { cookie }, body: 'Operative note: medial meniscectomy, documented medical necessity.' });
    const out = await res.json();
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.ok(out.documentId);
    assert.equal(out.packet.packetStatus, 'ready', 'packet refreshed to ready');
    assert.deepEqual(out.packet.missingDocumentTypes, []);

    const d = await get('/api/cases/' + caseId) as any;
    assert.ok(d.timeline.some((t: any) => t.actionType === 'document_uploaded'));
  });

  it('packet submit (electronic) and mark-mailed both execute with guards', async () => {
    // electronic: a ready packet with portal method
    const ready = await pool.query(
      `SELECT ap.packet_id, ap.case_id FROM appeal_packet ap
       WHERE ap.packet_status = 'ready' AND ap.submission_method = 'portal' LIMIT 1`);
    assert.ok(ready.rows[0], 'a ready portal packet exists');
    const r = await post(`/api/packets/${ready.rows[0].packet_id}/submit`, { manual: false });
    assert.equal(r.ok, true);
    // double submit is rejected
    await post(`/api/packets/${ready.rows[0].packet_id}/submit`, { manual: false }, 409);
    const c = await get('/api/cases/' + ready.rows[0].case_id) as any;
    assert.equal(c.packet.status, 'submitted');
    assert.ok(c.timeline.some((t: any) => t.actionType === 'appeal_submitted'));

    // manual: a draft/mail packet can be marked mailed
    const mail = await pool.query(
      `SELECT ap.packet_id FROM appeal_packet ap
       WHERE ap.packet_status IN ('ready','draft') AND ap.submission_method = 'mail' LIMIT 1`);
    if (mail.rows[0]) {
      const m = await post(`/api/packets/${mail.rows[0].packet_id}/submit`,
        { manual: true, method: 'mail' });
      assert.equal(m.ok, true);
    }
  });

  it('builder: search -> claim -> recommendation -> create case (with dupe guard)', async () => {
    // a clean paid claim with no case: search by its patient
    const clean = await pool.query(
      `SELECT cl.claim_id, cl.claim_number_internal, cl.payer_id,
              pat.first_name, pat.last_name
       FROM claim cl
       JOIN encounter e ON e.encounter_id = cl.encounter_id
       JOIN patient pat ON pat.patient_id = e.patient_id
       WHERE cl.tenant_id = 'de300000-0000-4000-8000-000000000001'
         AND NOT EXISTS (SELECT 1 FROM recovery_case rc WHERE rc.claim_id = cl.claim_id)
       LIMIT 1`);
    assert.ok(clean.rows[0], 'a caseless claim exists');
    const target = clean.rows[0];

    const found = await get('/api/claims/search?q=' + encodeURIComponent(target.claim_number_internal)) as any[];
    assert.equal(found.length, 1);
    assert.equal(found[0].hasOpenCase, false);

    const claim = await get('/api/claims/' + target.claim_id) as any;
    assert.ok(claim.lines.length > 0);

    const reco = await get('/api/recommendation?code=CO-45&payerId=' + target.payer_id) as any;
    assert.equal(reco.category, 'contractual');
    assert.ok(reco.recommendedAction.length > 10);
    assert.ok(reco.suggestedDeadline > new Date().toISOString().slice(0, 10));

    const created = await post('/api/cases', {
      claimId: target.claim_id, caseType: 'underpayment', denialReasonCode: 'CO-45',
      deadlineDate: reco.suggestedDeadline, notes: 'manual review of payment',
    });
    assert.ok(created.caseId);
    assert.ok(created.packet, 'packet generated on creation');
    // duplicate guard
    await post('/api/cases', {
      claimId: target.claim_id, caseType: 'underpayment',
    }, 409);
  });

  it('payer performance report + drilldown', async () => {
    const r = await get('/api/reports/payers') as any;
    // >= : other suites in the same pass may add payers with claims
    assert.ok(r.payers.length >= 3);
    const p = r.payers[0];
    for (const k of ['claimsSubmitted', 'expected', 'paid', 'variance', 'variancePct',
                     'appealsSubmitted', 'appealsWon', 'totalRecovered', 'monthTrend',
                     'denialRateByCategory', 'avgDaysToPay']) assert.ok(k in p, k);
    assert.ok(p.claimsSubmitted > 0);
    assert.ok(p.monthTrend.length >= 2, 'month-over-month trend');
    const drill = await get(`/api/reports/payers/${p.payerId}/claims`) as any;
    assert.ok(drill.claims.length > 0);
    assert.ok('variance' in drill.claims[0]);
  });

  it('denial analytics: categories, trend, codes, providers, procedures, root causes', async () => {
    const d = await get('/api/reports/denials') as any;
    assert.ok(d.categories.length >= 4);
    assert.ok(d.categories[0].avoidable && d.categories[0].rootCause);
    assert.ok(d.monthlyTrend.length > 0);
    assert.ok(d.topCodes.length >= 4);
    assert.ok(d.topCodes[0].count >= d.topCodes.at(-1).count);
    assert.ok(d.byProvider.length >= 3);
    assert.ok(d.byProcedure.length >= 3);
    assert.ok(d.avoidability.some((a: any) => a.classification === 'avoidable'));
    assert.ok(d.rootCauses.length >= 3);
  });

  it('reconciliation: auto/manual matched, unmatched queue, manual match action', async () => {
    let r = await get('/api/reports/reconciliation?days=90') as any;
    assert.ok(r.totalRecovered > 0);
    assert.ok(r.recoveryRateByCategory.length > 0);
    if (r.unmatched.length === 0) {
      // another suite's reconciliation job may have drained the seeded queue —
      // stage a fresh post-appeal remittance on a submitted case
      const staged = await pool.query(
        `SELECT rc.case_id, rc.claim_id, rc.recovery_opportunity, cl.payer_id, rc.client_id
         FROM recovery_case rc
         JOIN claim cl ON cl.claim_id = rc.claim_id
         JOIN appeal_packet ap ON ap.case_id = rc.case_id AND ap.submitted_at IS NOT NULL
         WHERE rc.status IN ('submitted', 'pending_payer') AND rc.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM payment_event pe WHERE pe.case_id = rc.case_id)
         LIMIT 1`);
      assert.ok(staged.rows[0], 'a submitted case without payments exists');
      const s = staged.rows[0];
      const rem = await pool.query(
        `INSERT INTO remittance (tenant_id, client_id, payer_id, check_date, check_number, total_paid)
         SELECT rc.tenant_id, $2, $3, CURRENT_DATE, 'CHK-WEBTEST-1', $4
         FROM recovery_case rc WHERE rc.case_id = $1 RETURNING remittance_id, tenant_id`,
        [s.case_id, s.client_id, s.payer_id, s.recovery_opportunity]);
      await pool.query(
        `INSERT INTO remittance_line (tenant_id, remittance_id, claim_id, paid_amount, match_method)
         VALUES ($1, $2, $3, $4, 'payer_claim_number')`,
        [rem.rows[0].tenant_id, rem.rows[0].remittance_id, s.claim_id, s.recovery_opportunity]);
      r = await get('/api/reports/reconciliation?days=90') as any;
    }
    assert.ok(r.unmatched.length > 0, 'unmatched post-appeal remits exist');
    assert.ok(r.autoMatched.length > 0, 'auto-matched recoveries');

    const u = r.unmatched[0];
    const m = await post('/api/reconciliation/match', {
      caseId: u.caseId, remittanceId: u.remittanceId, amount: u.paid,
      date: u.checkDate, markWon: true,
    });
    assert.equal(m.ok, true);
    const r2 = await get('/api/reports/reconciliation?days=90') as any;
    // matching is case-level: every unmatched row for that case clears
    assert.ok(!r2.unmatched.some((x: any) => x.caseId === u.caseId), 'case left the unmatched queue');
    assert.ok(r2.unmatched.length < r.unmatched.length);
    assert.ok(r2.manualMatched.length > r.manualMatched.length);
    assert.ok(r2.totalRecovered > r.totalRecovered);
  });

  it('team workload: assignees, SLA, overdue, weekly trend', async () => {
    const w = await get('/api/reports/workload') as any;
    assert.ok(w.users.length >= 3);
    const withCases = w.users.filter((u: any) => u.openCases > 0);
    assert.ok(withCases.length >= 2, 'cases distributed across users');
    assert.ok(withCases.every((u: any) => u.openAmount > 0));
    assert.ok(w.users.some((u: any) => u.actionsThisWeek > 0));
    assert.ok(w.users.some((u: any) => u.trend.length > 0), 'productivity trend');
    assert.ok(withCases.every((u: any) => u.slaCompliancePct == null || u.slaCompliancePct >= 0));
  });

  it('run-detection quick action executes and reports', async () => {
    const r = await post('/api/run-detection', {});
    assert.ok(r.jobId);
    assert.ok('casesCreated' in r.summary);
  });
});
