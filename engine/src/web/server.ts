// ============================================================================
// The operational interface server — node:http, no framework.
//
//   import { startServer } from './server.ts';
//   const srv = await startServer(pool, { port: 8787 });
//
// Pages are server-rendered shells; data flows through /api/* JSON endpoints.
// Every API route (except login) requires a valid session cookie and scopes
// all queries to the session's tenant + visible clients.
// ============================================================================

import http from 'node:http';
import type { PoolLike } from '../service.ts';
import { runDetectionJob } from '../service.ts';
import { generateAppealPackets } from '../appeals/service.ts';
import { FileSystemDocumentStore, type DocumentStore } from '../appeals/storage.ts';
import {
  COOKIE_NAME, authenticate, changePassword, decodeSession, encodeSession,
  sessionForUser, visibleClientIds, type Session,
} from './auth.ts';
import * as admin from './admin_api.ts';
import * as compliance from './compliance_api.ts';
import * as pub from './public_api.ts';
import { API_ENDPOINTS, buildOpenApi, docsHtml } from './api_docs.ts';
import {
  detectFileKind, ingestFileByKind, ingestParsed835, ingestParsed837, previewIngestFile,
} from '../ingest/service.ts';
import { dispatchAppealSubmission, dispatchCaseWriteback } from '../integration/connectors.ts';
import { validatePassword, ensureDataEncryptionKeyConfigured } from '../security/crypto.ts';
import { requireSecret } from '../security/secrets.ts';
import {
  buildLoginUrl, loadSsoConfig, mapGroupsToRole, spMetadataXml, validateAcsResponse,
} from '../security/sso.ts';
import * as q from './queries.ts';
import * as reports from './reports.ts';
import * as actions from './actions.ts';
import * as auto from './automation_api.ts';
import { processTrigger } from '../automation/rules.ts';
import { CLIENT_JS, STYLESHEET, layout, loginPage } from './ui.ts';
import * as pages from './pages.ts';
import * as pagesAdmin from './pages_admin.ts';

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  session: Session | null;
  scope: q.Scope | null;
  params: string[];
}

type Handler = (ctx: Ctx) => Promise<void>;

export interface ServerOptions {
  port?: number;
  sessionSecret?: string;
  store?: DocumentStore;
  asOf?: () => string;   // injectable clock for tests
}

// HTTPS/Secure-cookie enforcement: on by default in production, no flag to
// remember. FORCE_HTTPS=1 remains as an explicit override for staging or
// other non-production environments that still sit behind TLS — but nothing
// about production behavior depends on anyone setting it.
const requireHttps = (): boolean =>
  process.env.NODE_ENV === 'production' || process.env.FORCE_HTTPS === '1';

function getSessionSecret(explicit?: string): string {
  if (explicit) return explicit;
  return requireSecret('SESSION_SECRET', { devFallback: 'dev-secret-change-me' });
}

export async function startServer(pool: PoolLike, opts: ServerOptions = {}) {
  // fail at boot, not on the first request that happens to need these
  const secret = getSessionSecret(opts.sessionSecret);
  ensureDataEncryptionKeyConfigured();

  const store = opts.store ?? new FileSystemDocumentStore();
  const today = opts.asOf ?? (() => new Date().toISOString().slice(0, 10));

  // ---- helpers --------------------------------------------------------------
  const json = (ctx: Ctx, status: number, body: unknown) => {
    ctx.res.writeHead(status, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify(body));
  };
  const html = (ctx: Ctx, body: string, status = 200) => {
    ctx.res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    ctx.res.end(body);
  };
  const redirect = (ctx: Ctx, to: string) => {
    ctx.res.writeHead(302, { Location: to });
    ctx.res.end();
  };
  const baseUrl = (ctx: Ctx): string => {
    const proto = requireHttps() ? 'https'
      : (ctx.req.headers['x-forwarded-proto'] as string) ?? 'http';
    return `${proto}://${ctx.req.headers.host ?? 'localhost'}`;
  };
  const readBody = (req: http.IncomingMessage, limit = 25 * 1024 * 1024): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); }
        else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  const readJson = async (req: http.IncomingMessage): Promise<any> => {
    const raw = await readBody(req, 1024 * 1024);
    if (!raw.length) return {};
    try { return JSON.parse(raw.toString('utf8')); }
    catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
  };

  const page = (ctx: Ctx, title: string, active: string, body: string, script: string) =>
    html(ctx, layout({
      title, active, body, script,
      userName: ctx.session!.name, role: ctx.session!.role,
    }));

  // ---- public API (/api/v1) helpers ----------------------------------------
  const rateLimiter = new pub.RateLimiter();

  /** API-key-authenticated route: auth -> scope -> rate limit -> handler -> log */
  const apiKeyed = (
    method: string, pattern: RegExp, scope: 'read' | 'ingest',
    h: (ctx: Ctx, id: pub.ApiIdentity) => Promise<void>,
  ) => route(method, pattern, async (ctx) => {
    const started = Date.now();
    let identity: pub.ApiIdentity | null = null;
    let status = 500;
    try {
      identity = await pub.authenticateApiKey(pool, ctx.req.headers);
      if (!identity) {
        status = 401;
        return json(ctx, 401, { error: 'missing, invalid, or revoked API key' });
      }
      if (!identity.scopes.includes(scope)) {
        status = 403;
        return json(ctx, 403, { error: `API key lacks the '${scope}' scope` });
      }
      const retryAfter = rateLimiter.check(identity.apiKeyId, identity.rateLimitPerMinute);
      if (retryAfter != null) {
        status = 429;
        ctx.res.setHeader('Retry-After', String(retryAfter));
        return json(ctx, 429, { error: 'rate limit exceeded', retryAfterSeconds: retryAfter });
      }
      await h(ctx, identity);
      status = ctx.res.statusCode;
    } catch (err: any) {
      status = err?.status ?? 500;
      if (status >= 500) console.error(err);
      if (!ctx.res.headersSent) {
        json(ctx, status, { error: err?.message ?? 'internal error' });
      }
    } finally {
      await pub.logApiRequest(pool, {
        tenantId: identity?.tenantId ?? null, apiKeyId: identity?.apiKeyId ?? null,
        method, path: ctx.url.pathname, status,
        durationMs: Date.now() - started,
        ip: ctx.req.socket.remoteAddress ?? null,
      });
    }
  });

  const requireAuth = (h: Handler, kind: 'api' | 'page'): Handler => async (ctx) => {
    if (!ctx.session) {
      return kind === 'api' ? json(ctx, 401, { error: 'unauthorized' }) : redirect(ctx, '/login');
    }
    ctx.scope = { tenantId: ctx.session.tenantId, clientIds: await visibleClientIds(pool, ctx.session) };
    return h(ctx);
  };

  // ---- routes ---------------------------------------------------------------
  const routes: Array<[string, RegExp, Handler]> = [];
  const route = (method: string, pattern: RegExp, h: Handler) => routes.push([method, pattern, h]);
  const authed = (method: string, pattern: RegExp, h: Handler) =>
    route(method, pattern, requireAuth(h, pattern.source.startsWith('^\\/api') ? 'api' : 'page'));

  // health check — unauthenticated, no session/tenant context; verifies the
  // process can actually reach the database, not just that it's listening.
  // Used by the Docker HEALTHCHECK and any external uptime/orchestrator probe.
  route('GET', /^\/healthz$/, async (ctx) => {
    try {
      await pool.query('SELECT 1');
      json(ctx, 200, { status: 'ok' });
    } catch (err: any) {
      json(ctx, 503, { status: 'unhealthy', error: err?.message ?? 'database unreachable' });
    }
  });

  // static assets
  route('GET', /^\/assets\/app\.css$/, async (ctx) => {
    ctx.res.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'max-age=300' });
    ctx.res.end(STYLESHEET);
  });
  route('GET', /^\/assets\/app\.js$/, async (ctx) => {
    ctx.res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'max-age=300' });
    ctx.res.end(CLIENT_JS);
  });

  const secureFlag = requireHttps() ? '; Secure' : '';
  const setSessionCookie = (ctx: Ctx, session: Session) => {
    ctx.res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${encodeSession(session, secret)}; HttpOnly; Path=/; SameSite=Lax${secureFlag}`);
  };

  // auth
  route('GET', /^\/login$/, async (ctx) => html(ctx, loginPage()));
  route('POST', /^\/api\/login$/, async (ctx) => {
    const body = await readJson(ctx.req);
    const outcome = await authenticate(
      pool, String(body.email ?? ''), String(body.password ?? ''),
      { totp: body.totp ? String(body.totp) : undefined, ip: ctx.req.socket.remoteAddress },
    );
    switch (outcome.kind) {
      case 'ok':
        setSessionCookie(ctx, outcome.session);
        return json(ctx, 200, { ok: true, name: outcome.session.name, role: outcome.session.role });
      case 'locked':
        return json(ctx, 423, { error: `account locked until ${outcome.until}` });
      case 'mfa_required':
        return json(ctx, 428, { mfaRequired: true, error: 'enter your authenticator code' });
      case 'mfa_invalid':
        return json(ctx, 401, { mfaRequired: true, error: 'invalid authenticator code' });
      case 'mfa_enroll':
        return json(ctx, 428, {
          mfaEnroll: true, secret: outcome.secret, otpauthUri: outcome.otpauthUri,
          error: 'MFA enrollment required for admin accounts — scan the secret, then sign in with a code',
        });
      case 'password_expired':
        return json(ctx, 403, {
          passwordExpired: true,
          error: 'password older than 90 days — set a new password to continue',
        });
      default:
        return json(ctx, 401, { error: 'invalid email or password' });
    }
  });
  route('POST', /^\/api\/change-password$/, async (ctx) => {
    const body = await readJson(ctx.req);
    const out = await changePassword(
      pool, String(body.email ?? ''), String(body.oldPassword ?? ''),
      String(body.newPassword ?? ''), validatePassword);
    out.ok ? json(ctx, 200, out) : json(ctx, 400, { error: (out as any).error });
  });
  route('POST', /^\/api\/accept-invite$/, async (ctx) => {
    const body = await readJson(ctx.req);
    json(ctx, 200, await admin.acceptInvite(pool, String(body.token ?? ''), String(body.password ?? '')));
  });
  route('GET', /^\/accept-invite$/, async (ctx) => html(ctx, pagesAdmin.acceptInvitePage()));

  // SSO / SAML
  route('GET', /^\/sso\/metadata$/, async (ctx) => {
    const tenantId = ctx.url.searchParams.get('tenant') ?? '';
    ctx.res.writeHead(200, { 'Content-Type': 'application/xml' });
    ctx.res.end(spMetadataXml(baseUrl(ctx), tenantId));
  });
  route('GET', /^\/sso\/login$/, async (ctx) => {
    const tenantId = ctx.url.searchParams.get('tenant') ?? '';
    const cfg = await loadSsoConfig(pool, tenantId);
    if (!cfg?.enabled) return json(ctx, 409, { error: 'SSO is not enabled for this tenant' });
    redirect(ctx, await buildLoginUrl(baseUrl(ctx), tenantId, cfg));
  });
  route('POST', /^\/sso\/acs$/, async (ctx) => {
    const tenantId = ctx.url.searchParams.get('tenant') ?? '';
    const cfg = await loadSsoConfig(pool, tenantId);
    if (!cfg?.enabled) return json(ctx, 409, { error: 'SSO is not enabled for this tenant' });
    const raw = (await readBody(ctx.req, 1024 * 1024)).toString('utf8');
    const form = Object.fromEntries(new URLSearchParams(raw));
    const assertion = await validateAcsResponse(baseUrl(ctx), tenantId, cfg, form);
    const role = mapGroupsToRole(cfg.group_role_mappings ?? [], assertion.groups, cfg.default_role);

    // match by email or JIT-provision
    let user = await pool.query(
      `SELECT user_id FROM app_user
       WHERE tenant_id = $1 AND email = $2 AND deleted_at IS NULL`, [tenantId, assertion.email]);
    if (!user.rows[0]) {
      user = await pool.query(
        `INSERT INTO app_user (tenant_id, email, first_name, role, status, password_changed_at)
         VALUES ($1, $2, $3, $4, 'active', now()) RETURNING user_id`,
        [tenantId, assertion.email, assertion.displayName ?? assertion.email.split('@')[0], role]);
    } else {
      await pool.query(
        `UPDATE app_user SET role = $2, status = 'active' WHERE user_id = $1`,
        [user.rows[0].user_id, role]);
    }
    await pool.query(
      `SELECT app.log_security_event($1, $2, 'sso_login', $3, $4::inet)`,
      [tenantId, user.rows[0].user_id,
       JSON.stringify({ email: assertion.email, role, groups: assertion.groups }),
       ctx.req.socket.remoteAddress ?? null]);
    const session = await sessionForUser(pool, user.rows[0].user_id);
    if (!session) return json(ctx, 403, { error: 'user is not active' });
    setSessionCookie(ctx, session);
    redirect(ctx, '/dashboard');
  });
  route('POST', /^\/api\/logout$/, async (ctx) => {
    ctx.res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
    json(ctx, 200, { ok: true });
  });
  route('GET', /^\/$/, async (ctx) => redirect(ctx, ctx.session ? '/dashboard' : '/login'));

  // pages
  authed('GET', /^\/dashboard$/, async (ctx) =>
    page(ctx, 'Dashboard', 'dashboard', pages.DASHBOARD_BODY, pages.DASHBOARD_JS));
  authed('GET', /^\/queue$/, async (ctx) =>
    page(ctx, 'Recovery Case Queue', 'queue', pages.QUEUE_BODY, pages.QUEUE_JS));
  authed('GET', /^\/case\/([0-9a-f-]{36})$/, async (ctx) =>
    page(ctx, 'Case Detail', 'queue', pages.CASE_BODY, pages.CASE_JS));
  authed('GET', /^\/builder$/, async (ctx) =>
    page(ctx, 'Appeal Packet Builder', 'builder', pages.BUILDER_BODY, pages.BUILDER_JS));
  authed('GET', /^\/reports\/payers$/, async (ctx) =>
    page(ctx, 'Payer Performance', 'payers', pages.PAYERS_BODY, pages.PAYERS_JS));
  authed('GET', /^\/reports\/denials$/, async (ctx) =>
    page(ctx, 'Denial Analytics', 'denials', pages.DENIALS_BODY, pages.DENIALS_JS));
  authed('GET', /^\/reports\/reconciliation$/, async (ctx) =>
    page(ctx, 'Payment Reconciliation', 'reconciliation', pages.RECON_BODY, pages.RECON_JS));
  authed('GET', /^\/reports\/workload$/, async (ctx) =>
    page(ctx, 'Team Workload', 'workload', pages.WORKLOAD_BODY, pages.WORKLOAD_JS));
  authed('GET', /^\/notifications$/, async (ctx) =>
    page(ctx, 'Notifications', 'notifications', pages.NOTIFS_BODY, pages.NOTIFS_JS));
  authed('GET', /^\/rules$/, async (ctx) =>
    page(ctx, 'Automation Rules', 'rules', pages.RULES_BODY, pages.RULES_JS));
  authed('GET', /^\/admin$/, async (ctx) =>
    page(ctx, 'Tenant Overview', 'admin', pagesAdmin.ADMIN_BODY, pagesAdmin.ADMIN_JS));
  authed('GET', /^\/admin\/users$/, async (ctx) =>
    page(ctx, 'User Management', 'admin-users', pagesAdmin.USERS_BODY, pagesAdmin.USERS_JS));
  authed('GET', /^\/admin\/client\/([0-9a-f-]{36})$/, async (ctx) =>
    page(ctx, 'Client Administration', 'admin-client',
      pagesAdmin.CLIENT_ADMIN_BODY, pagesAdmin.CLIENT_ADMIN_JS));
  authed('GET', /^\/compliance$/, async (ctx) =>
    page(ctx, 'Audit & Compliance', 'compliance',
      pagesAdmin.COMPLIANCE_BODY, pagesAdmin.COMPLIANCE_JS));

  // ---- data APIs ------------------------------------------------------------
  authed('GET', /^\/api\/dashboard$/, async (ctx) =>
    json(ctx, 200, await q.dashboard(pool, ctx.scope!, today())));

  authed('GET', /^\/api\/lookups$/, async (ctx) =>
    json(ctx, 200, await q.lookups(pool, ctx.scope!)));

  authed('GET', /^\/api\/whoami$/, async (ctx) =>
    json(ctx, 200, {
      userId: ctx.session!.userId, name: ctx.session!.name, role: ctx.session!.role,
      clientId: ctx.session!.clientId ?? (ctx.scope!.clientIds.length === 1 ? ctx.scope!.clientIds[0] : null),
    }));

  authed('GET', /^\/api\/cases$/, async (ctx) => {
    const f = Object.fromEntries(ctx.url.searchParams) as q.QueueFilters;
    json(ctx, 200, { rows: await q.caseQueue(pool, ctx.scope!, f) });
  });

  authed('POST', /^\/api\/cases\/bulk$/, async (ctx) => {
    const body = await readJson(ctx.req);
    json(ctx, 200, await actions.bulkAction(pool, ctx.session!, ctx.scope!, body.caseIds,
      { assignTo: 'assignTo' in body ? body.assignTo : undefined, status: body.status }));
  });

  authed('GET', /^\/api\/cases\/([0-9a-f-]{36})$/, async (ctx) => {
    const detail = await q.caseDetail(pool, ctx.scope!, ctx.params[0]);
    if (!detail) return json(ctx, 404, { error: 'case not found' });
    // HIPAA: record who viewed this patient's record
    await pool.query(`SELECT app.log_phi_access($1, $2, $3, $4, $5::inet)`,
      [ctx.scope!.tenantId, ctx.session!.userId, detail.patient.patientId,
       `case detail ${ctx.params[0]}`, ctx.req.socket.remoteAddress ?? null]).catch(() => {});
    json(ctx, 200, detail);
  });

  authed('POST', /^\/api\/cases\/([0-9a-f-]{36})\/note$/, async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.notes?.trim()) return json(ctx, 400, { error: 'notes required' });
    json(ctx, 200, await actions.addNote(pool, ctx.session!, ctx.scope!, ctx.params[0], body.notes.trim()));
  });

  authed('POST', /^\/api\/cases\/([0-9a-f-]{36})\/call$/, async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.outcome) return json(ctx, 400, { error: 'outcome required' });
    json(ctx, 200, await actions.logPayerCall(
      pool, ctx.session!, ctx.scope!, ctx.params[0], body.outcome, body.notes ?? ''));
  });

  authed('POST', /^\/api\/cases\/([0-9a-f-]{36})\/assign$/, async (ctx) => {
    const body = await readJson(ctx.req);
    json(ctx, 200, await actions.assignCase(
      pool, ctx.session!, ctx.scope!, ctx.params[0], body.userId ?? null));
  });

  authed('POST', /^\/api\/cases\/([0-9a-f-]{36})\/status$/, async (ctx) => {
    const body = await readJson(ctx.req);
    const out = await actions.setCaseStatus(
      pool, ctx.session!, ctx.scope!, ctx.params[0], body.status);
    await processTrigger(pool, {
      trigger: 'status_changed', tenantId: ctx.scope!.tenantId,
      caseId: ctx.params[0], detail: `status → ${body.status}`,
    }).catch(() => {});
    // outbound hook: PM/EHR write-back when the client has a PM configured
    await dispatchCaseWriteback(pool, {
      tenantId: ctx.scope!.tenantId, caseId: ctx.params[0], status: body.status,
    }).catch(() => {});
    json(ctx, 200, out);
  });

  authed('POST', /^\/api\/cases\/([0-9a-f-]{36})\/documents$/, async (ctx) => {
    const fileName = ctx.url.searchParams.get('filename') ?? 'upload.bin';
    const documentType = ctx.url.searchParams.get('type') ?? 'other';
    const content = await readBody(ctx.req);
    const out = await actions.uploadCaseDocument(
      pool, ctx.session!, ctx.scope!, store, ctx.params[0], fileName, documentType, content);
    await processTrigger(pool, {
      trigger: 'document_uploaded', tenantId: ctx.scope!.tenantId,
      caseId: ctx.params[0], detail: `${documentType} uploaded`,
    }).catch(() => {});
    json(ctx, 200, out);
  });

  authed('GET', /^\/api\/documents\/([0-9a-f-]{36})\/content$/, async (ctx) => {
    const doc = await pool.query(
      `SELECT storage_path, file_name FROM document
       WHERE document_id = $1 AND tenant_id = $2 AND client_id = ANY($3) AND deleted_at IS NULL`,
      [ctx.params[0], ctx.scope!.tenantId, ctx.scope!.clientIds]);
    if (!doc.rows[0]) return json(ctx, 404, { error: 'document not found' });
    const raw = await store.getRaw(doc.rows[0].storage_path);
    const isText = /\.(txt|csv|json)$/i.test(doc.rows[0].file_name);
    ctx.res.writeHead(200, {
      'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      'Content-Disposition': `inline; filename="${doc.rows[0].file_name}"`,
    });
    ctx.res.end(raw);
  });

  authed('POST', /^\/api\/packets\/([0-9a-f-]{36})\/submit$/, async (ctx) => {
    const body = await readJson(ctx.req);
    const out = await actions.submitPacket(pool, ctx.session!, ctx.scope!, ctx.params[0], {
      method: body.method, payerReference: body.payerReference, manual: !!body.manual,
    });
    await processTrigger(pool, {
      trigger: 'status_changed', tenantId: ctx.scope!.tenantId,
      caseId: out.caseId, detail: 'appeal submitted',
    }).catch(() => {});
    // outbound hook: electronic submissions dispatch through the connector layer
    let delivery = null;
    if (!body.manual) {
      delivery = await dispatchAppealSubmission(pool, {
        tenantId: ctx.scope!.tenantId, packetId: ctx.params[0],
      }).catch(() => null);
    }
    json(ctx, 200, { ...out, delivery });
  });

  // builder
  authed('GET', /^\/api\/claims\/search$/, async (ctx) => {
    const term = ctx.url.searchParams.get('q') ?? '';
    if (term.trim().length < 2) return json(ctx, 200, []);
    json(ctx, 200, await q.searchClaims(pool, ctx.scope!, term.trim()));
  });
  authed('GET', /^\/api\/claims\/([0-9a-f-]{36})$/, async (ctx) => {
    const claim = await q.claimForBuilder(pool, ctx.scope!, ctx.params[0]);
    claim ? json(ctx, 200, claim) : json(ctx, 404, { error: 'claim not found' });
  });
  authed('GET', /^\/api\/recommendation$/, async (ctx) =>
    json(ctx, 200, await actions.recommendation(
      pool, ctx.scope!, ctx.url.searchParams.get('code'),
      ctx.url.searchParams.get('payerId'), today())));
  authed('POST', /^\/api\/cases$/, async (ctx) => {
    const body = await readJson(ctx.req);
    const created = await actions.createManualCase(pool, ctx.session!, ctx.scope!, body, today());
    await processTrigger(pool, {
      trigger: 'case_created', tenantId: ctx.scope!.tenantId, caseId: created.caseId,
    }).catch(() => {});
    // generate the packet for the new case right away
    const gen = await generateAppealPackets(pool, {
      tenantId: ctx.scope!.tenantId, caseIds: [created.caseId], asOf: today(), store,
    }).catch(() => null);
    json(ctx, 200, {
      ...created,
      packet: gen?.packets[0] ? {
        packetId: gen.packets[0].packetId,
        packetStatus: gen.packets[0].packetStatus,
        missingDocumentTypes: gen.packets[0].missingDocumentTypes,
      } : null,
    });
  });

  // quick action: run detection
  authed('POST', /^\/api\/run-detection$/, async (ctx) => {
    const out = await runDetectionJob(pool, {
      tenantId: ctx.scope!.tenantId,
      clientId: ctx.scope!.clientIds.length === 1 ? ctx.scope!.clientIds[0] : undefined,
      asOf: today(),
    });
    json(ctx, 200, { jobId: out.jobId, summary: out.result.summary });
  });

  // reports
  authed('GET', /^\/api\/reports\/payers$/, async (ctx) =>
    json(ctx, 200, { payers: await reports.payerPerformance(pool, ctx.scope!) }));
  authed('GET', /^\/api\/reports\/payers\/([0-9a-f-]{36})\/claims$/, async (ctx) =>
    json(ctx, 200, { claims: await reports.payerClaimDrilldown(pool, ctx.scope!, ctx.params[0]) }));
  authed('GET', /^\/api\/reports\/denials$/, async (ctx) =>
    json(ctx, 200, await reports.denialAnalytics(pool, ctx.scope!)));
  authed('GET', /^\/api\/reports\/reconciliation$/, async (ctx) =>
    json(ctx, 200, await reports.reconciliation(
      pool, ctx.scope!, Number(ctx.url.searchParams.get('days')) || 30)));
  authed('GET', /^\/api\/reports\/workload$/, async (ctx) =>
    json(ctx, 200, await reports.teamWorkload(pool, ctx.scope!)));
  authed('POST', /^\/api\/reconciliation\/match$/, async (ctx) => {
    const body = await readJson(ctx.req);
    const out = await actions.manualMatch(pool, ctx.session!, ctx.scope!, body);
    await processTrigger(pool, {
      trigger: 'payment_received', tenantId: ctx.scope!.tenantId, caseId: body.caseId,
    }).catch(() => {});
    json(ctx, 200, out);
  });

  // ---- notification center ---------------------------------------------------
  authed('GET', /^\/api\/notifications$/, async (ctx) =>
    json(ctx, 200, await auto.listNotifications(
      pool, ctx.session!, ctx.url.searchParams.get('unread') === '1')));
  authed('GET', /^\/api\/notifications\/unread-count$/, async (ctx) =>
    json(ctx, 200, { count: await auto.unreadCount(pool, ctx.session!) }));
  authed('POST', /^\/api\/notifications\/(all|[0-9a-f-]{36})\/read$/, async (ctx) =>
    json(ctx, 200, await auto.markRead(pool, ctx.session!, ctx.params[0] as any)));
  authed('GET', /^\/api\/notification-preferences$/, async (ctx) =>
    json(ctx, 200, await auto.getPreferences(pool, ctx.session!)));
  authed('POST', /^\/api\/notification-preferences$/, async (ctx) =>
    json(ctx, 200, await auto.savePreferences(pool, ctx.session!, await readJson(ctx.req))));

  // ---- automation rules --------------------------------------------------------
  authed('GET', /^\/api\/rules$/, async (ctx) =>
    json(ctx, 200, await auto.listRules(pool, ctx.scope!)));
  authed('GET', /^\/api\/rules\/executions$/, async (ctx) =>
    json(ctx, 200, await auto.listRuleExecutions(pool, ctx.scope!)));
  authed('POST', /^\/api\/rules$/, async (ctx) =>
    json(ctx, 200, await auto.createRule(pool, ctx.session!, ctx.scope!, await readJson(ctx.req))));
  authed('POST', /^\/api\/rules\/([0-9a-f-]{36})\/toggle$/, async (ctx) =>
    json(ctx, 200, await auto.toggleRule(pool, ctx.session!, ctx.scope!, ctx.params[0])));
  authed('POST', /^\/api\/rules\/([0-9a-f-]{36})\/delete$/, async (ctx) =>
    json(ctx, 200, await auto.deleteRule(pool, ctx.session!, ctx.scope!, ctx.params[0])));

  // ---- enterprise admin --------------------------------------------------------
  authed('GET', /^\/api\/admin\/overview$/, async (ctx) =>
    json(ctx, 200, await admin.tenantOverview(pool, ctx.session!, ctx.scope!)));
  authed('POST', /^\/api\/admin\/clients$/, async (ctx) =>
    json(ctx, 200, await admin.createClient(pool, ctx.session!, ctx.scope!, await readJson(ctx.req))));
  authed('GET', /^\/api\/admin\/clients\/([0-9a-f-]{36})$/, async (ctx) =>
    json(ctx, 200, await admin.clientDetail(pool, ctx.session!, ctx.scope!, ctx.params[0])));
  authed('POST', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/settings$/, async (ctx) =>
    json(ctx, 200, await admin.updateClientSettings(
      pool, ctx.session!, ctx.scope!, ctx.params[0], await readJson(ctx.req))));
  authed('POST', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/features$/, async (ctx) => {
    const body = await readJson(ctx.req);
    json(ctx, 200, await admin.setClientFeature(
      pool, ctx.session!, ctx.scope!, ctx.params[0], body.feature, !!body.enabled));
  });
  authed('POST', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/subscription$/, async (ctx) => {
    const body = await readJson(ctx.req);
    json(ctx, 200, await admin.setSubscriptionStatus(
      pool, ctx.session!, ctx.scope!, ctx.params[0], body.status));
  });
  authed('GET', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/onboarding$/, async (ctx) => {
    // readable by every member of the client (the dashboard shows progress);
    // completing steps stays admin-only
    if (!ctx.scope!.clientIds.includes(ctx.params[0])) {
      return json(ctx, 404, { error: 'client not found' });
    }
    json(ctx, 200, { steps: await admin.refreshOnboarding(pool, ctx.session!, ctx.params[0]) });
  });
  authed('POST', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/onboarding\/([a-z_0-9]+)\/complete$/,
    async (ctx) => json(ctx, 200, await admin.completeOnboardingStep(
      pool, ctx.session!, ctx.scope!, ctx.params[0], ctx.params[1])));
  authed('POST', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/payer-config$/, async (ctx) =>
    json(ctx, 200, await admin.upsertPayerConfig(
      pool, ctx.session!, ctx.scope!, ctx.params[0], await readJson(ctx.req))));
  authed('POST', /^\/api\/admin\/payers$/, async (ctx) =>
    json(ctx, 200, await admin.createTenantPayer(pool, ctx.session!, ctx.scope!, await readJson(ctx.req))));
  authed('POST', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/contracts$/, async (ctx) =>
    json(ctx, 200, await admin.createContract(
      pool, ctx.session!, ctx.scope!, ctx.params[0], await readJson(ctx.req))));
  authed('POST', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/documents$/, async (ctx) => {
    admin.assertClientAccess(ctx.session!, ctx.scope!, ctx.params[0]);
    const fileName = (ctx.url.searchParams.get('filename') ?? 'upload.bin')
      .replace(/[^\w.\-]+/g, '_').slice(0, 120);
    const documentType = ctx.url.searchParams.get('type') ?? 'contract';
    if (!['contract', 'fee_schedule', 'payer_policy'].includes(documentType)) {
      return json(ctx, 400, { error: 'type must be contract, fee_schedule, or payer_policy' });
    }
    const content = await readBody(ctx.req);
    const storagePath = await store.put(
      `${ctx.scope!.tenantId}/clients/${ctx.params[0]}/${Date.now()}-${fileName}`, content);
    const doc = await pool.query(
      `INSERT INTO document (tenant_id, client_id, document_type, file_name, storage_path,
                             uploaded_by, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'user_upload') RETURNING document_id`,
      [ctx.scope!.tenantId, ctx.params[0], documentType, fileName, storagePath, ctx.session!.userId]);
    json(ctx, 200, { ok: true, documentId: doc.rows[0].document_id });
  });
  authed('POST', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/integration$/, async (ctx) =>
    json(ctx, 200, await admin.saveIntegration(
      pool, ctx.session!, ctx.scope!, ctx.params[0], await readJson(ctx.req))));
  authed('POST', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/integration\/test$/, async (ctx) =>
    json(ctx, 200, await admin.testIntegration(pool, ctx.session!, ctx.scope!, ctx.params[0])));
  authed('POST', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/ingest$/, async (ctx) => {
    // manual upload commit: raw 835/837/CSV body -> ingest job; ?detect=1
    // chains a detection run (the preview endpoint parses without writing)
    admin.assertClientAccess(ctx.session!, ctx.scope!, ctx.params[0]);
    const fileName = ctx.url.searchParams.get('filename') ?? 'upload.835';
    const content = (await readBody(ctx.req)).toString('utf8');
    const out = await ingestFileByKind(pool, {
      tenantId: ctx.scope!.tenantId, clientId: ctx.params[0], content, fileName,
    });
    let detection = null;
    if (ctx.url.searchParams.get('detect') === '1') {
      const det = await runDetectionJob(pool, {
        tenantId: ctx.scope!.tenantId, clientId: ctx.params[0],
      });
      detection = det.result.summary;
    }
    json(ctx, 200, { ...out, detection });
  });
  authed('GET', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/billing$/, async (ctx) =>
    json(ctx, 200, await admin.billingSummary(pool, ctx.session!, ctx.scope!, ctx.params[0])));
  authed('POST', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/billing\/invoice$/, async (ctx) => {
    const body = await readJson(ctx.req);
    json(ctx, 200, await admin.generateInvoice(
      pool, ctx.session!, ctx.scope!, ctx.params[0], String(body.month ?? '')));
  });
  authed('POST', /^\/api\/admin\/plan$/, async (ctx) => {
    const body = await readJson(ctx.req);
    json(ctx, 200, await admin.changePlan(pool, ctx.session!, ctx.scope!, String(body.tier ?? '')));
  });

  // user management
  authed('GET', /^\/api\/admin\/users$/, async (ctx) =>
    json(ctx, 200, await admin.listUsers(pool, ctx.session!, ctx.scope!)));
  authed('POST', /^\/api\/admin\/users\/invite$/, async (ctx) =>
    json(ctx, 200, await admin.inviteUser(pool, ctx.session!, ctx.scope!, await readJson(ctx.req))));
  authed('POST', /^\/api\/admin\/users\/([0-9a-f-]{36})\/deactivate$/, async (ctx) =>
    json(ctx, 200, await admin.deactivateUser(pool, ctx.session!, ctx.scope!, ctx.params[0])));
  authed('POST', /^\/api\/admin\/users\/([0-9a-f-]{36})\/reset$/, async (ctx) =>
    json(ctx, 200, await admin.resetUserAccess(pool, ctx.session!, ctx.scope!, ctx.params[0])));
  authed('POST', /^\/api\/admin\/users\/([0-9a-f-]{36})\/assign$/, async (ctx) => {
    const body = await readJson(ctx.req);
    json(ctx, 200, await admin.assignUserToClient(
      pool, ctx.session!, ctx.scope!, ctx.params[0], body.clientId ?? null));
  });
  authed('GET', /^\/api\/admin\/users\/([0-9a-f-]{36})\/activity$/, async (ctx) =>
    json(ctx, 200, await admin.userActivity(pool, ctx.session!, ctx.scope!, ctx.params[0])));

  // SSO configuration
  authed('GET', /^\/api\/admin\/sso$/, async (ctx) => {
    admin.requireTenantAdmin(ctx.session!);
    const cfg = await loadSsoConfig(pool, ctx.scope!.tenantId);
    json(ctx, 200, {
      config: cfg, metadataUrl: `/sso/metadata?tenant=${ctx.scope!.tenantId}`,
      loginUrl: `/sso/login?tenant=${ctx.scope!.tenantId}`,
    });
  });
  authed('POST', /^\/api\/admin\/sso$/, async (ctx) => {
    admin.requireTenantAdmin(ctx.session!);
    const body = await readJson(ctx.req);
    await pool.query(
      `INSERT INTO sso_config (tenant_id, enabled, idp_entity_id, idp_sso_url,
                               idp_certificate, group_attribute, group_role_mappings, default_role)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'groups'), $7, COALESCE($8, 'viewer'))
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled = $2, idp_entity_id = $3, idp_sso_url = $4, idp_certificate = $5,
         group_attribute = COALESCE($6, 'groups'),
         group_role_mappings = $7, default_role = COALESCE($8, 'viewer')`,
      [ctx.scope!.tenantId, !!body.enabled, body.idpEntityId ?? null, body.idpSsoUrl ?? null,
       body.idpCertificate ?? null, body.groupAttribute ?? null,
       JSON.stringify(body.groupRoleMappings ?? []), body.defaultRole ?? null]);
    json(ctx, 200, { ok: true });
  });

  // ---- compliance ---------------------------------------------------------------
  authed('GET', /^\/api\/compliance\/audit$/, async (ctx) =>
    json(ctx, 200, { rows: await compliance.auditTrail(
      pool, ctx.session!, ctx.scope!, Object.fromEntries(ctx.url.searchParams) as any) }));
  authed('GET', /^\/api\/compliance\/audit-filters$/, async (ctx) =>
    json(ctx, 200, await compliance.auditFilters(pool, ctx.session!, ctx.scope!)));
  authed('GET', /^\/api\/compliance\/phi-access$/, async (ctx) =>
    json(ctx, 200, { rows: await compliance.phiAccessLog(
      pool, ctx.session!, ctx.scope!, Object.fromEntries(ctx.url.searchParams) as any) }));
  authed('GET', /^\/api\/compliance\/jobs$/, async (ctx) =>
    json(ctx, 200, { rows: await compliance.systemJobLog(
      pool, ctx.session!, ctx.scope!, Object.fromEntries(ctx.url.searchParams) as any) }));
  authed('POST', /^\/api\/compliance\/jobs\/([0-9a-f-]{36})\/rerun$/, async (ctx) =>
    json(ctx, 200, await compliance.rerunJob(pool, ctx.session!, ctx.scope!, ctx.params[0])));

  // export approval workflow
  authed('POST', /^\/api\/exports$/, async (ctx) => {
    const body = await readJson(ctx.req);
    json(ctx, 200, await compliance.requestExport(
      pool, ctx.session!, ctx.scope!, String(body.exportType ?? ''), body.params ?? {}));
  });
  authed('GET', /^\/api\/exports$/, async (ctx) =>
    json(ctx, 200, { rows: await compliance.listExports(pool, ctx.session!, ctx.scope!) }));
  authed('POST', /^\/api\/exports\/([0-9a-f-]{36})\/(approve|deny)$/, async (ctx) =>
    json(ctx, 200, await compliance.decideExport(
      pool, ctx.session!, ctx.scope!, ctx.params[0], ctx.params[1] === 'approve')));
  authed('GET', /^\/api\/exports\/([0-9a-f-]{36})\/download$/, async (ctx) => {
    const out = await compliance.downloadExport(pool, ctx.session!, ctx.scope!, ctx.params[0]);
    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${out.fileName}"`,
    });
    ctx.res.end(out.csv);
  });

  // ---- API key management (admin UI) -----------------------------------------
  authed('POST', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/api-keys$/, async (ctx) => {
    const body = await readJson(ctx.req);
    json(ctx, 200, await pub.createApiKey(pool, ctx.session!, ctx.scope!, {
      clientId: ctx.params[0], name: body.name, scopes: body.scopes,
      rateLimitPerMinute: body.rateLimitPerMinute,
    }));
  });
  authed('GET', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/api-keys$/, async (ctx) =>
    json(ctx, 200, { keys: await pub.listApiKeys(pool, ctx.session!, ctx.scope!, ctx.params[0]) }));
  authed('POST', /^\/api\/admin\/api-keys\/([0-9a-f-]{36})\/revoke$/, async (ctx) =>
    json(ctx, 200, await pub.revokeApiKey(pool, ctx.session!, ctx.scope!, ctx.params[0])));

  // ---- inbound SFTP credentials (admin UI) ------------------------------------
  authed('POST', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/sftp-credentials$/, async (ctx) =>
    json(ctx, 200, await admin.generateSftpCredentials(pool, ctx.session!, ctx.scope!, ctx.params[0])));
  authed('POST', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/sftp-credentials\/revoke$/, async (ctx) =>
    json(ctx, 200, await admin.revokeSftpCredentials(pool, ctx.session!, ctx.scope!, ctx.params[0])));

  // manual upload: parse-only preview before committing
  authed('POST', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/ingest\/preview$/, async (ctx) => {
    admin.assertClientAccess(ctx.session!, ctx.scope!, ctx.params[0]);
    const fileName = ctx.url.searchParams.get('filename') ?? 'upload';
    const content = (await readBody(ctx.req)).toString('utf8');
    json(ctx, 200, previewIngestFile(fileName, content));
  });

  // outbound deliveries (integration visibility)
  authed('GET', /^\/api\/admin\/clients\/([0-9a-f-]{36})\/deliveries$/, async (ctx) => {
    admin.assertClientAccess(ctx.session!, ctx.scope!, ctx.params[0]);
    const rows = await pool.query(
      `SELECT delivery_id, connector, kind, status, detail, attempts, created_at
       FROM outbound_delivery WHERE client_id = $1 AND tenant_id = $2
       ORDER BY created_at DESC LIMIT 50`,
      [ctx.params[0], ctx.scope!.tenantId]);
    json(ctx, 200, { deliveries: rows.rows });
  });

  // ---- public API documentation (no auth — the IdP/buyer reads these) --------
  route('GET', /^\/api\/v1\/docs$/, async (ctx) => html(ctx, docsHtml(baseUrl(ctx))));
  route('GET', /^\/api\/v1\/openapi\.json$/, async (ctx) =>
    json(ctx, 200, buildOpenApi(baseUrl(ctx))));

  // ---- public API v1 (API-key authenticated) ----------------------------------
  apiKeyed('POST', /^\/api\/v1\/claims\/ingest$/, 'ingest', async (ctx, id) => {
    const raw = (await readBody(ctx.req)).toString('utf8');
    const isJson = (ctx.req.headers['content-type'] ?? '').includes('json');
    const params = {
      tenantId: id.tenantId, clientId: id.clientId,
      content: isJson ? '' : raw, fileName: `api-claims-${Date.now()}.837`,
    };
    const out = isJson
      ? await ingestParsed837(pool, params, pub.json837ToClaimFile(JSON.parse(raw || '{}')))
      : await (async () => {
        if (detectFileKind(params.fileName, raw) !== '837' && !/\*837\*/.test(raw.slice(0, 400))) {
          throw Object.assign(new Error('body is not an 837 transaction — send raw X12 or application/json'), { status: 400 });
        }
        return ingestFileByKind(pool, { ...params, content: raw });
      })();
    json(ctx, 200, {
      jobId: out.jobId, recordsProcessed: out.recordsProcessed,
      skipped: out.skipped, warnings: out.warnings,
    });
  });

  apiKeyed('POST', /^\/api\/v1\/remittances\/ingest$/, 'ingest', async (ctx, id) => {
    const raw = (await readBody(ctx.req)).toString('utf8');
    const isJson = (ctx.req.headers['content-type'] ?? '').includes('json');
    const params = {
      tenantId: id.tenantId, clientId: id.clientId,
      content: raw, fileName: `api-remit-${Date.now()}.835`,
    };
    const out = isJson
      ? await ingestParsed835(pool, { ...params, content: '' },
          [pub.json835ToRemittance(JSON.parse(raw || '{}'))])
      : await ingestFileByKind(pool, params);
    // spec: remittance ingest triggers matching and detection
    const det = await runDetectionJob(pool, {
      tenantId: id.tenantId, clientId: id.clientId,
    });
    json(ctx, 200, {
      jobId: out.jobId, recordsProcessed: out.recordsProcessed,
      skipped: out.skipped, warnings: out.warnings,
      detection: {
        matched: det.result.summary.matched,
        unmatched: det.result.summary.unmatched,
        casesCreated: det.result.summary.casesCreated,
        casesUpdated: det.result.summary.casesUpdated,
        totalRecoveryOpportunity: det.result.summary.totalRecoveryOpportunity,
      },
    });
  });

  apiKeyed('GET', /^\/api\/v1\/cases$/, 'read', async (ctx, id) => {
    const f = Object.fromEntries(ctx.url.searchParams) as q.QueueFilters;
    const rows = await q.caseQueue(pool, { tenantId: id.tenantId, clientIds: [id.clientId] }, f);
    json(ctx, 200, { cases: rows });
  });

  apiKeyed('GET', /^\/api\/v1\/cases\/([0-9a-f-]{36})$/, 'read', async (ctx, id) => {
    const detail = await q.caseDetail(
      pool, { tenantId: id.tenantId, clientIds: [id.clientId] }, ctx.params[0]);
    if (!detail) return json(ctx, 404, { error: 'case not found' });
    await pool.query(`SELECT app.log_phi_access($1, NULL, $2, $3, $4::inet)`,
      [id.tenantId, detail.patient.patientId, `api case detail (key ${id.apiKeyId})`,
       ctx.req.socket.remoteAddress ?? null]).catch(() => {});
    json(ctx, 200, detail);
  });

  apiKeyed('POST', /^\/api\/v1\/cases\/([0-9a-f-]{36})\/actions$/, 'ingest', async (ctx, id) => {
    const body = await readJson(ctx.req);
    json(ctx, 200, await pub.logExternalCaseAction(pool, id, ctx.params[0], body));
  });

  apiKeyed('GET', /^\/api\/v1\/reports\/recovery-summary$/, 'read', async (ctx, id) => {
    json(ctx, 200, await pub.recoverySummary(pool, id));
  });

  // ---- dispatcher -----------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // HTTPS enforcement (behind a TLS-terminating proxy): redirect plain HTTP
    // and pin HSTS. On by default in production — see requireHttps() above.
    if (requireHttps()) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      if ((req.headers['x-forwarded-proto'] ?? 'http') !== 'https') {
        res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
        res.end();
        return;
      }
    }

    const cookies = Object.fromEntries(
      (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=') as [string, string]),
    );
    const session = decodeSession(cookies[COOKIE_NAME], secret);
    const ctx: Ctx = { req, res, url, session, scope: null, params: [] };

    // sliding session: renew the cookie when less than half the tenant's
    // timeout window remains
    if (session?.tm && session.exp - Date.now() < (session.tm * 60_000) / 2) {
      const renewed = { ...session, exp: Date.now() + session.tm * 60_000 };
      res.setHeader('Set-Cookie',
        `${COOKIE_NAME}=${encodeSession(renewed, secret)}; HttpOnly; Path=/; SameSite=Lax${secureFlag}`);
    }

    try {
      for (const [method, pattern, handler] of routes) {
        if (req.method !== method) continue;
        const m = url.pathname.match(pattern);
        if (!m) continue;
        ctx.params = m.slice(1);
        await handler(ctx);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err: any) {
      const status = err?.status ?? 500;
      if (status >= 500) console.error(err);
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err?.message ?? 'internal error' }));
      } else res.end();
    }
  });

  const port = opts.port ?? (Number(process.env.PORT) || 8787);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return {
    server,
    port: (server.address() as any).port as number,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve()))),
  };
}
