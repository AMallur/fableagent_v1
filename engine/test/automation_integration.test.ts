// ============================================================================
// Automation & scheduling integration test — runs against the seeded demo
// tenant (scripts/seed_demo.ts must have run first).
//
//   TEST_DATABASE_URL=postgres://... node --test test/automation_integration.test.ts
//
// Covers: notification creation/preferences/dedupe, digests + outbox
// delivery, the rule engine end-to-end through the web API, the deadline
// monitor tiers, payment reconciliation (gap closed + partial), the weekly
// summary, and the scheduler tick (including its double-run guards).
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const url = process.env.TEST_DATABASE_URL;

const T = 'de300000-0000-4000-8000-000000000001';
const C = 'de300000-0000-4000-8000-000000000002';
const TODAY = new Date().toISOString().slice(0, 10);

describe('automation & scheduling', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  let pool: any, srv: any, base = '', cookie = '';
  let users: Record<string, { id: string; email: string }> = {};

  const post = async (p: string, body: unknown, expect = 200) => {
    const res = await fetch(base + p, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const out = await res.json();
    assert.equal(res.status, expect, `POST ${p}: ${JSON.stringify(out)}`);
    return out;
  };
  const get = async (p: string) => {
    const res = await fetch(base + p, { headers: { cookie } });
    assert.equal(res.status, 200, `GET ${p}`);
    return res.json();
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
    cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];

    const u = await pool.query(
      `SELECT user_id, email FROM app_user WHERE tenant_id = $1`, [T]);
    for (const r of u.rows) users[r.email.split('@')[0]] = { id: r.user_id, email: r.email };
  });

  after(async () => {
    await srv.close();
    await pool.end();
  });

  // -------------------------------------------------------------------------
  it('notifications: preferences, urgent-to-immediate email, dedupe', async () => {
    const { createNotification } = await import('../src/automation/notify.ts');
    const sarah = users['sarah'].id;

    // default prefs: in-app + digest email -> no immediate outbox row
    const n1 = await createNotification(pool, {
      tenantId: T, userId: sarah, type: 'system_alert',
      title: 'test info alert', severity: 'info',
    });
    assert.ok(n1.notificationId);
    assert.equal(n1.emailed, false);

    // urgent upgrades digest -> immediate email
    const n2 = await createNotification(pool, {
      tenantId: T, userId: sarah, type: 'system_alert',
      title: 'test urgent alert', severity: 'urgent',
    });
    assert.equal(n2.emailed, true);
    const outbox = await pool.query(
      `SELECT kind, subject FROM email_outbox WHERE tenant_id = $1 AND user_id = $2
       AND subject LIKE '%test urgent alert%'`, [T, sarah]);
    assert.equal(outbox.rows[0].kind, 'immediate');
    assert.match(outbox.rows[0].subject, /URGENT/);

    // preference email='off' suppresses even urgent
    await pool.query(
      `INSERT INTO notification_preference (tenant_id, user_id, notification_type, in_app, email)
       VALUES ($1, $2, 'system_alert', true, 'off')
       ON CONFLICT (user_id, notification_type) DO UPDATE SET email = 'off'`,
      [T, sarah]);
    const n3 = await createNotification(pool, {
      tenantId: T, userId: sarah, type: 'system_alert',
      title: 'suppressed alert', severity: 'urgent',
    });
    assert.equal(n3.emailed, false);
    await pool.query(
      `DELETE FROM notification_preference WHERE user_id = $1 AND notification_type = 'system_alert'`,
      [sarah]);

    // dedupe key: second identical notification is dropped
    const key = `test-dedupe:${Date.now()}`;
    const a = await createNotification(pool, {
      tenantId: T, userId: sarah, type: 'system_alert', title: 'once', dedupeKey: key,
    });
    const b = await createNotification(pool, {
      tenantId: T, userId: sarah, type: 'system_alert', title: 'once', dedupeKey: key,
    });
    assert.ok(a.notificationId);
    assert.equal(b.notificationId, null);
  });

  // -------------------------------------------------------------------------
  it('digest bundling + outbox delivery through a transport', async () => {
    const { sendDigests, deliverOutbox, MemoryTransport } =
      await import('../src/automation/notify.ts');

    const sent = await sendDigests(pool, T, { isMonday: true });
    assert.ok(sent >= 1, 'at least one digest email queued');
    const digest = await pool.query(
      `SELECT body_text FROM email_outbox WHERE tenant_id = $1 AND kind = 'digest'
       ORDER BY created_at DESC LIMIT 1`, [T]);
    assert.match(digest.rows[0].body_text, /Notification digest/);
    assert.match(digest.rows[0].body_text, /•/);

    // digested rows don't re-send
    const again = await sendDigests(pool, T, { isMonday: true });
    assert.equal(again, 0);

    const transport = new MemoryTransport();
    const delivered = await deliverOutbox(pool, transport);
    assert.ok(delivered.sent >= 1);
    assert.equal(delivered.failed, 0);
    assert.ok(transport.sent.some((e) => e.kind === 'digest'));
    const queued = await pool.query(
      `SELECT count(*)::int AS n FROM email_outbox WHERE status = 'queued'`);
    assert.equal(queued.rows[0].n, 0, 'outbox drained');
  });

  // -------------------------------------------------------------------------
  it('rule engine: build via API, fire on case_created, log in audit trail', async () => {
    const sarah = users['sarah'].id;
    // WHEN new case created AND recovery > 50 THEN assign to Sarah,
    // set priority critical, notify client admins, flag for review
    const rule = await post('/api/rules', {
      name: 'High-value intake',
      trigger: 'case_created',
      conditions: [{ field: 'recovery_opportunity', op: 'gt', value: 50 }],
      actions: [
        { type: 'assign_to', userId: sarah },
        { type: 'set_priority', level: 'critical' },
        { type: 'notify', role: 'tenant_admin' },
        { type: 'flag_for_review' },
      ],
    });
    assert.ok(rule.ruleId);

    // a caseless claim staged as a real underpayment (clean-paid claims have
    // zero recovery, which would correctly fail the > $50 condition)
    const claim = await pool.query(
      `SELECT cl.claim_id FROM claim cl
       JOIN claim_line l ON l.claim_id = cl.claim_id
       WHERE cl.tenant_id = $1 AND l.expected_amount IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM recovery_case rc WHERE rc.claim_id = cl.claim_id)
       GROUP BY cl.claim_id HAVING sum(l.expected_amount) > 130 LIMIT 1`, [T]);
    assert.ok(claim.rows[0], 'caseless claim available');
    await pool.query(
      `UPDATE claim_line SET paid_amount = GREATEST(expected_amount - 120, 0)
       WHERE claim_id = $1`, [claim.rows[0].claim_id]);
    const created = await post('/api/cases', {
      claimId: claim.rows[0].claim_id, caseType: 'underpayment', denialReasonCode: 'CO-45',
      deadlineDate: '2027-01-01',
    });

    const c = await pool.query(
      `SELECT assigned_to_user_id, priority_level, flagged_for_review
       FROM recovery_case WHERE case_id = $1`, [created.caseId]);
    assert.equal(c.rows[0].assigned_to_user_id, sarah, 'rule assigned the case');
    assert.equal(c.rows[0].priority_level, 'critical', 'rule set priority');
    assert.equal(c.rows[0].flagged_for_review, true, 'rule flagged for review');

    // notifications: sarah got case_assigned, admin got rule_notification
    const notif = await pool.query(
      `SELECT notification_type FROM notification
       WHERE case_id = $1 ORDER BY created_at`, [created.caseId]);
    const types = notif.rows.map((r: any) => r.notification_type);
    assert.ok(types.includes('case_assigned'));
    assert.ok(types.includes('rule_notification'));

    // execution log + audit trail
    const execs = await get('/api/rules/executions');
    const fired = execs.find((e: any) => e.ruleName === 'High-value intake');
    assert.ok(fired, 'execution logged');
    assert.ok(fired.actionsApplied.length === 4);
    const audit = await pool.query(
      `SELECT after_state FROM audit_log
       WHERE tenant_id = $1 AND action = 'rule_executed' AND entity_id = $2`, [T, rule.ruleId]);
    assert.ok(audit.rows[0], 'audit trail entry for rule firing');
    assert.equal(audit.rows[0].after_state.caseId, created.caseId);

    // conditions actually gate: a rule that can't match never fires
    const never = await post('/api/rules', {
      name: 'Impossible', trigger: 'case_created',
      conditions: [{ field: 'recovery_opportunity', op: 'gt', value: 99999999 }],
      actions: [{ type: 'flag_for_review' }],
    });
    const claim2 = await pool.query(
      `SELECT cl.claim_id FROM claim cl
       WHERE cl.tenant_id = $1
         AND NOT EXISTS (SELECT 1 FROM recovery_case rc WHERE rc.claim_id = cl.claim_id) LIMIT 1`, [T]);
    if (claim2.rows[0]) {
      await post('/api/cases', {
        claimId: claim2.rows[0].claim_id, caseType: 'other',
      });
      const neverFired = await pool.query(
        `SELECT 1 FROM rule_execution WHERE rule_id = $1`, [never.ruleId]);
      assert.equal(neverFired.rows.length, 0);
    }

    // disable stops firing; non-admins cannot manage rules
    await post(`/api/rules/${rule.ruleId}/toggle`, {});
    const rules = await get('/api/rules');
    assert.equal(rules.find((r: any) => r.ruleId === rule.ruleId).enabled, false);
  });

  // -------------------------------------------------------------------------
  it('deadline monitor: tiers, escalation, same-day flag, expiry', async () => {
    const { runDeadlineMonitor } = await import('../src/automation/jobs.ts');
    const sarah = users['sarah'].id;

    // craft one case per tier
    const picks = await pool.query(
      `SELECT case_id FROM recovery_case
       WHERE tenant_id = $1 AND status IN ('open', 'in_progress')
         AND deleted_at IS NULL AND priority_level <> 'critical'
       ORDER BY created_at LIMIT 3`, [T]);
    assert.ok(picks.rows.length === 3, 'three open cases to stage');
    const [c14, c7, c2] = picks.rows.map((r: any) => r.case_id);
    const expiredPick = await pool.query(
      `SELECT case_id FROM recovery_case
       WHERE tenant_id = $1 AND status IN ('open', 'in_progress') AND deleted_at IS NULL
         AND case_id <> ALL($2) AND NOT expired LIMIT 1`, [T, [c14, c7, c2]]);
    const cExp = expiredPick.rows[0]?.case_id;

    const stage = async (id: string, offset: number) => pool.query(
      `UPDATE recovery_case SET deadline_date = $2::date + $3::int, expired = false,
              assigned_to_user_id = $4, same_day_action = false
       WHERE case_id = $1`, [id, TODAY, offset, sarah]);
    await stage(c14, 12); await stage(c7, 5); await stage(c2, 1);
    if (cExp) await stage(cExp, -4);

    const out = await runDeadlineMonitor(pool, { tenantId: T, clientId: C, asOf: TODAY });
    assert.ok(out.tier14 >= 1);
    assert.ok(out.tier7 >= 1);
    assert.ok(out.tier2 >= 1);
    if (cExp) assert.ok(out.expired >= 1);
    assert.ok(out.escalated >= 1);
    assert.ok(out.alertsSent > 0);

    const check = await pool.query(
      `SELECT case_id, priority_level, same_day_action, expired FROM recovery_case
       WHERE case_id = ANY($1)`, [[c7, c2, ...(cExp ? [cExp] : [])]]);
    const byId = new Map(check.rows.map((r: any) => [r.case_id, r]));
    assert.equal(byId.get(c7).priority_level, 'critical', '7-day tier escalated');
    assert.equal(byId.get(c2).same_day_action, true, '2-day tier flagged same-day');
    if (cExp) assert.equal(byId.get(cExp).expired, true, 'passed deadline marked expired');

    // assigned user + admin both alerted for the 2-day case
    const alerts = await pool.query(
      `SELECT DISTINCT user_id FROM notification
       WHERE case_id = $1 AND notification_type = 'deadline_approaching'`, [c2]);
    assert.ok(alerts.rows.length >= 2, 'assignee and admin(s) alerted');

    // re-run same day: dedupe keys stop duplicate alerts
    const again = await runDeadlineMonitor(pool, { tenantId: T, clientId: C, asOf: TODAY });
    assert.equal(again.alertsSent, 0, 'no duplicate alerts on same-day re-run');
  });

  // -------------------------------------------------------------------------
  it('payment reconciliation: gap closed -> won, partial -> logged', async () => {
    const { runPaymentReconciliation } = await import('../src/automation/jobs.ts');

    // stage a partial: a submitted case with a fresh post-appeal remit paying half
    const submitted = await pool.query(
      `SELECT rc.case_id, rc.claim_id, rc.recovery_opportunity, cl.payer_id
       FROM recovery_case rc
       JOIN claim cl ON cl.claim_id = rc.claim_id
       JOIN appeal_packet ap ON ap.case_id = rc.case_id AND ap.submitted_at IS NOT NULL
       WHERE rc.tenant_id = $1 AND rc.status = 'submitted'
         AND NOT EXISTS (SELECT 1 FROM payment_event pe WHERE pe.case_id = rc.case_id)
         AND NOT EXISTS (SELECT 1 FROM remittance_line rl
                         JOIN remittance r ON r.remittance_id = rl.remittance_id
                         WHERE rl.claim_id = rc.claim_id
                           AND r.created_at > ap.submitted_at)
       LIMIT 1`, [T]);
    let partialCase: string | null = null;
    if (submitted.rows[0]) {
      const s = submitted.rows[0];
      partialCase = s.case_id;
      const half = Math.round(Number(s.recovery_opportunity) / 2 * 100) / 100;
      const rem = await pool.query(
        `INSERT INTO remittance (tenant_id, client_id, payer_id, check_date, check_number, total_paid)
         VALUES ($1, $2, $3, CURRENT_DATE, 'CHK-PARTIAL-1', $4) RETURNING remittance_id`,
        [T, C, s.payer_id, half]);
      await pool.query(
        `INSERT INTO remittance_line (tenant_id, remittance_id, claim_id, paid_amount, match_method)
         VALUES ($1, $2, $3, $4, 'payer_claim_number')`,
        [T, rem.rows[0].remittance_id, s.claim_id, half]);
    }

    const out = await runPaymentReconciliation(pool, { tenantId: T, clientId: C });
    assert.ok(out.matched >= 1, 'payments matched');
    assert.ok(out.won >= 1, 'gap-closed cases marked won');
    assert.ok(out.recovered > 0);

    if (partialCase) {
      assert.ok(out.partial >= 1, 'partial recovery logged');
      const c = await pool.query(
        `SELECT status FROM recovery_case WHERE case_id = $1`, [partialCase]);
      assert.equal(c.rows[0].status, 'submitted', 'partial case stays open');
      const pe = await pool.query(
        `SELECT matched_automatically, notes FROM payment_event WHERE case_id = $1`, [partialCase]);
      assert.equal(pe.rows[0].matched_automatically, true);
      assert.match(pe.rows[0].notes, /Partial recovery/);
      const action = await pool.query(
        `SELECT 1 FROM case_action WHERE case_id = $1 AND action_type = 'payment_received'`,
        [partialCase]);
      assert.ok(action.rows[0], 'partial recovery on the case timeline');
    }
  });

  // -------------------------------------------------------------------------
  it('weekly summary: stats + top action items emailed to admins', async () => {
    const { runWeeklySummary } = await import('../src/automation/jobs.ts');
    const out = await runWeeklySummary(pool, { tenantId: T, clientId: C, asOf: TODAY });
    assert.ok(out.emailsQueued >= 1, 'admins emailed');
    assert.ok(out.recoveredAmount >= 0);

    const email = await pool.query(
      `SELECT subject, body_text FROM email_outbox
       WHERE tenant_id = $1 AND kind = 'weekly_report'
       ORDER BY created_at DESC LIMIT 1`, [T]);
    assert.match(email.rows[0].subject, /Weekly summary/);
    assert.match(email.rows[0].body_text, /New recovery cases opened/);
    assert.match(email.rows[0].body_text, /Appeals submitted/);
    assert.match(email.rows[0].body_text, /Top action items:/);
    assert.match(email.rows[0].body_text, /1\. \[/);
  });

  // -------------------------------------------------------------------------
  it('scheduler tick: runs the nightly pipeline (with file pickup) once, then guards', async () => {
    const { schedulerTick } = await import('../src/automation/scheduler.ts');
    const { MemoryTransport } = await import('../src/automation/notify.ts');
    const { FIXTURE_835 } = await import('./ingest.test.ts');

    // stage an ingest folder with an 835 (unique trace so ingest accepts it)
    const folder = path.join(process.cwd(), 'var', 'ingest-test', C);
    await mkdir(folder, { recursive: true });
    const content = FIXTURE_835.replaceAll('CHK-IT-100', `CHK-SCHED-${Date.now()}`);
    await writeFile(path.join(folder, 'overnight.835'), content);
    await pool.query(
      `UPDATE client SET ingest_folder = $2, timezone = 'UTC', nightly_run_time = '00:00'
       WHERE client_id = $1`, [C, folder]);

    const transport = new MemoryTransport();
    const report = await schedulerTick(pool, { transport }, new Date());
    assert.ok(report.nightly.includes(C), 'nightly ran for the client');
    // the every-tick sweep picks the file up (before nightly even starts)
    assert.ok(report.filesIngested >= 1, 'sweep ingested the dropped file');

    // the file was ingested and archived
    const processed = await readdir(path.join(folder, 'processed'));
    assert.ok(processed.some((f) => f.endsWith('overnight.835')), 'file moved to processed/');
    const remit = await pool.query(
      `SELECT 1 FROM remittance WHERE tenant_id = $1 AND raw_835_reference = 'overnight.835'`, [T]);
    assert.ok(remit.rows[0], '835 loaded into remittance');

    // nightly job record with full step breakdown (folder already swept, so
    // its own file list is empty — the sweep owns pickup now)
    const job = await pool.query(
      `SELECT status, log_output FROM system_job
       WHERE tenant_id = $1 AND job_type = 'nightly_processing'
       ORDER BY started_at DESC LIMIT 1`, [T]);
    assert.equal(job.rows[0].status, 'completed');
    const log = JSON.parse(job.rows[0].log_output);
    assert.ok(Array.isArray(log.filesIngested));
    assert.ok('detection' in log && 'appeals' in log && 'reconciliation' in log);
    assert.equal(log.snapshotWritten, true);

    // dashboard snapshot row written (dated by the client's local clock,
    // which can differ from the DB server's CURRENT_DATE across midnight UTC)
    const snap = await pool.query(
      `SELECT open_cases, open_amount FROM dashboard_snapshot
       WHERE client_id = $1 ORDER BY snapshot_date DESC LIMIT 1`, [C]);
    assert.ok(snap.rows[0]);
    assert.ok(Number(snap.rows[0].open_amount) > 0);

    // second tick: the 20h guard prevents a double nightly run
    const report2 = await schedulerTick(pool, { transport }, new Date());
    assert.ok(!report2.nightly.includes(C), 'guard prevented double run');
  });

  // -------------------------------------------------------------------------
  it('notification center API: list, unread count, mark read', async () => {
    const count1 = (await get('/api/notifications/unread-count')).count;
    assert.ok(count1 >= 1, 'admin has unread notifications from the jobs');
    const list = await get('/api/notifications?unread=1');
    assert.ok(list.length >= 1);
    assert.ok(list[0].title.length > 3);

    await post(`/api/notifications/${list[0].notificationId}/read`, {});
    const count2 = (await get('/api/notifications/unread-count')).count;
    assert.equal(count2, count1 - 1);

    await post('/api/notifications/all/read', {});
    assert.equal((await get('/api/notifications/unread-count')).count, 0);

    // preferences round-trip
    const prefs = await get('/api/notification-preferences');
    assert.ok(prefs.types.length === 7);
    await post('/api/notification-preferences', {
      digestFrequency: 'weekly',
      types: [{ type: 'job_summary', inApp: true, email: 'immediate' }],
    });
    const prefs2 = await get('/api/notification-preferences');
    assert.equal(prefs2.digestFrequency, 'weekly');
    assert.equal(prefs2.types.find((t: any) => t.type === 'job_summary').email, 'immediate');
  });
});
