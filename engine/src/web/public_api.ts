// ============================================================================
// Public API (/api/v1) for PM/EHR direct connections.
//
// Authentication: per-client API keys, `Authorization: Bearer rcm_<...>` or
// `X-Api-Key`. Only sha256(key) is stored; the full key is shown once at
// creation. Every key carries scopes (read, ingest) and a per-minute rate
// limit; every call lands in api_request_log.
// ============================================================================

import { createHash, randomBytes } from 'node:crypto';
import type { UUID } from '../types.ts';
import type { PoolLike } from '../service.ts';
import type { Queryable } from '../db/snapshot.ts';
import type { Session } from './auth.ts';
import type { Scope } from './queries.ts';
import { assertClientAccess } from './admin_api.ts';
import type { Remittance835 } from '../ingest/parse835.ts';
import type { ClaimFile837 } from '../ingest/parse837.ts';

const err = (message: string, status: number) => Object.assign(new Error(message), { status });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------------------
// key management (admin UI endpoints)
// ---------------------------------------------------------------------------

export async function createApiKey(
  db: Queryable, sess: Session, s: Scope,
  input: { clientId: UUID; name: string; scopes?: string[]; rateLimitPerMinute?: number },
): Promise<{ ok: true; apiKeyId: UUID; apiKey: string; keyPrefix: string }> {
  assertClientAccess(sess, s, input.clientId);
  if (!input.name?.trim()) throw err('key name required', 400);
  const scopes = (input.scopes ?? ['read', 'ingest']).filter((x) => ['read', 'ingest'].includes(x));
  if (scopes.length === 0) throw err('at least one scope (read, ingest)', 400);

  const secret = randomBytes(24).toString('hex');
  const prefix = randomBytes(4).toString('hex');
  const fullKey = `rcm_${prefix}_${secret}`;

  const inserted = await db.query(
    `INSERT INTO api_key (tenant_id, client_id, name, key_prefix, key_hash, scopes,
                          rate_limit_per_minute, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING api_key_id`,
    [s.tenantId, input.clientId, input.name.trim(), `rcm_${prefix}`, sha256(fullKey),
     scopes, input.rateLimitPerMinute ?? 120, sess.userId]);
  // the full key is returned exactly once
  return {
    ok: true, apiKeyId: inserted.rows[0].api_key_id, apiKey: fullKey, keyPrefix: `rcm_${prefix}`,
  };
}

export async function listApiKeys(db: Queryable, sess: Session, s: Scope, clientId: UUID) {
  assertClientAccess(sess, s, clientId);
  const rows = await db.query(
    `SELECT k.api_key_id, k.name, k.key_prefix, k.scopes, k.rate_limit_per_minute,
            k.last_used_at, k.revoked_at, k.created_at,
            (SELECT count(*)::int FROM api_request_log l
             WHERE l.api_key_id = k.api_key_id
               AND l.created_at > now() - interval '30 days') AS calls_30d
     FROM api_key k WHERE k.client_id = $1 ORDER BY k.created_at DESC`, [clientId]);
  return rows.rows.map((k) => ({
    apiKeyId: k.api_key_id, name: k.name, keyPrefix: `${k.key_prefix}…`,
    scopes: k.scopes, rateLimitPerMinute: k.rate_limit_per_minute,
    lastUsedAt: k.last_used_at ? String(k.last_used_at) : null,
    revoked: k.revoked_at != null, calls30d: k.calls_30d,
  }));
}

export async function revokeApiKey(db: Queryable, sess: Session, s: Scope, apiKeyId: UUID) {
  const key = await db.query(
    `SELECT client_id FROM api_key WHERE api_key_id = $1 AND tenant_id = $2`,
    [apiKeyId, s.tenantId]);
  if (!key.rows[0]) throw err('key not found', 404);
  assertClientAccess(sess, s, key.rows[0].client_id);
  await db.query(
    `UPDATE api_key SET revoked_at = now() WHERE api_key_id = $1`, [apiKeyId]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// authentication + rate limiting
// ---------------------------------------------------------------------------

export interface ApiIdentity {
  apiKeyId: UUID;
  tenantId: UUID;
  clientId: UUID;
  scopes: string[];
  rateLimitPerMinute: number;
}

export async function authenticateApiKey(
  db: Queryable, headers: Record<string, string | string[] | undefined>,
): Promise<ApiIdentity | null> {
  const auth = String(headers.authorization ?? '');
  const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim()
    : String(headers['x-api-key'] ?? '').trim();
  if (!raw.startsWith('rcm_')) return null;

  const rows = await db.query(
    `SELECT k.api_key_id, k.tenant_id, k.client_id, k.scopes, k.rate_limit_per_minute
     FROM api_key k
     JOIN client c ON c.client_id = k.client_id AND c.deleted_at IS NULL
       AND c.subscription_status <> 'cancelled'
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL`, [sha256(raw)]);
  const k = rows.rows[0];
  if (!k) return null;
  // last_used, throttled to one write per minute per key
  await db.query(
    `UPDATE api_key SET last_used_at = now()
     WHERE api_key_id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [k.api_key_id]).catch(() => {});
  return {
    apiKeyId: k.api_key_id, tenantId: k.tenant_id, clientId: k.client_id,
    scopes: k.scopes, rateLimitPerMinute: k.rate_limit_per_minute,
  };
}

/**
 * Fixed-window per-key rate limiter (in-process). For multi-node deployments
 * move the counter to Postgres/Redis — the interface stays the same.
 */
export class RateLimiter {
  private windows = new Map<string, { windowStart: number; count: number }>();

  /** returns retry-after seconds when limited, or null when allowed */
  check(key: string, limitPerMinute: number, nowMs = Date.now()): number | null {
    const windowStart = Math.floor(nowMs / 60_000) * 60_000;
    const w = this.windows.get(key);
    if (!w || w.windowStart !== windowStart) {
      this.windows.set(key, { windowStart, count: 1 });
      return null;
    }
    w.count += 1;
    if (w.count > limitPerMinute) {
      return Math.max(1, Math.ceil((windowStart + 60_000 - nowMs) / 1000));
    }
    return null;
  }
}

export async function logApiRequest(
  db: Queryable, entry: {
    tenantId: UUID | null; apiKeyId: UUID | null; method: string; path: string;
    status: number; durationMs: number; ip: string | null;
  },
): Promise<void> {
  if (!entry.tenantId) return;   // unauthenticated probes aren't tenant-attributable
  await db.query(
    `INSERT INTO api_request_log (tenant_id, api_key_id, method, path, status, duration_ms, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7::inet)`,
    [entry.tenantId, entry.apiKeyId, entry.method, entry.path, entry.status,
     entry.durationMs, entry.ip]).catch(() => {});
}

// ---------------------------------------------------------------------------
// JSON -> parsed-EDI transforms (the API accepts raw X12 or structured JSON)
// ---------------------------------------------------------------------------

export function json837ToClaimFile(body: any): ClaimFile837 {
  const claims = body?.claims;
  if (!Array.isArray(claims) || claims.length === 0) {
    throw err('body must be {"claims": [...]} with at least one claim', 400);
  }
  return {
    transactionDate: body.transactionDate ?? null,
    billingProviderName: body.billingProvider?.name ?? null,
    billingProviderNpi: body.billingProvider?.npi ?? null,
    claims: claims.map((c: any, i: number) => {
      if (!c.claimNumber) throw err(`claims[${i}]: claimNumber is required`, 400);
      if (!Array.isArray(c.lines) || c.lines.length === 0) {
        throw err(`claims[${i}]: at least one service line is required`, 400);
      }
      return {
        patientControlNumber: String(c.claimNumber),
        chargeAmount: c.chargeAmount ?? null,
        placeOfService: c.placeOfService ?? null,
        diagnosisCodes: c.diagnosisCodes ?? [],
        authorizationNumber: c.authorizationNumber ?? null,
        subscriber: {
          lastName: c.subscriber?.lastName ?? '',
          firstName: c.subscriber?.firstName ?? '',
          memberId: c.subscriber?.memberId ?? '',
          dob: c.subscriber?.dob ?? null,
          gender: c.subscriber?.gender ?? null,
        },
        payerName: c.payerName ?? null,
        renderingProviderNpi: c.renderingProvider?.npi ?? null,
        renderingProviderName: c.renderingProvider?.name ?? null,
        lines: c.lines.map((l: any, j: number) => {
          if (!l.procedureCode) throw err(`claims[${i}].lines[${j}]: procedureCode is required`, 400);
          return {
            procedureCode: String(l.procedureCode),
            modifiers: l.modifiers ?? [],
            chargeAmount: l.chargeAmount ?? null,
            units: l.units ?? 1,
            dateOfService: l.dateOfService ?? null,
          };
        }),
      };
    }),
  };
}

export function json835ToRemittance(body: any): Remittance835 {
  const claims = body?.claims;
  if (!Array.isArray(claims) || claims.length === 0) {
    throw err('body must be {"claims": [...]} with at least one claim payment', 400);
  }
  return {
    payerName: body.payer?.name ?? '',
    payerIdCode: body.payer?.idCode ?? null,
    payeeName: body.payee?.name ?? '',
    payeeNpi: body.payee?.npi ?? null,
    totalPaid: body.totalPaid ?? null,
    checkDate: body.checkDate ?? null,
    traceNumber: body.checkNumber ?? body.traceNumber ?? null,
    claims: claims.map((c: any, i: number) => {
      if (!c.claimNumber && !c.payerClaimNumber) {
        throw err(`claims[${i}]: claimNumber or payerClaimNumber is required`, 400);
      }
      return {
        patientControlNumber: c.claimNumber ?? '',
        statusCode: c.statusCode ?? '1',
        billedAmount: c.billedAmount ?? null,
        paidAmount: c.paidAmount ?? null,
        patientResponsibility: c.patientResponsibility ?? null,
        payerClaimNumber: c.payerClaimNumber ?? '',
        patient: {
          lastName: c.patient?.lastName ?? '',
          firstName: c.patient?.firstName ?? '',
          memberId: c.patient?.memberId ?? '',
        },
        claimDate: c.dateOfService ?? null,
        adjustments: (c.adjustments ?? []).map((a: any) => ({
          groupCode: a.groupCode ?? 'CO', reasonCode: String(a.reasonCode ?? ''),
          amount: a.amount ?? 0,
        })),
        lines: (c.lines ?? []).map((l: any) => ({
          procedureCode: l.procedureCode ?? '',
          modifiers: l.modifiers ?? [],
          billedAmount: l.billedAmount ?? null,
          paidAmount: l.paidAmount ?? null,
          allowedAmount: l.allowedAmount ?? null,
          units: l.units ?? 1,
          dateOfService: l.dateOfService ?? null,
          adjustments: (l.adjustments ?? []).map((a: any) => ({
            groupCode: a.groupCode ?? 'CO', reasonCode: String(a.reasonCode ?? ''),
            amount: a.amount ?? 0,
          })),
          remarkCodes: l.remarkCodes ?? [],
        })),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// v1 read endpoints
// ---------------------------------------------------------------------------

export async function recoverySummary(pool: PoolLike, id: ApiIdentity) {
  const rows = await pool.query(
    `SELECT
       count(*) FILTER (WHERE rc.status IN ('open','in_progress','submitted','pending_payer'))::int AS open_cases,
       COALESCE(sum(rc.recovery_opportunity) FILTER
         (WHERE rc.status IN ('open','in_progress','submitted','pending_payer')), 0) AS open_amount,
       count(*) FILTER (WHERE rc.status = 'won')::int AS won_cases,
       (SELECT COALESCE(sum(pe.amount_recovered), 0) FROM payment_event pe
        JOIN recovery_case rc2 ON rc2.case_id = pe.case_id
        WHERE rc2.client_id = $1) AS recovered_total,
       (SELECT COALESCE(sum(pe.amount_recovered), 0) FROM payment_event pe
        JOIN recovery_case rc2 ON rc2.case_id = pe.case_id
        WHERE rc2.client_id = $1 AND pe.payment_date >= CURRENT_DATE - 30) AS recovered_30d,
       count(*) FILTER (WHERE rc.status IN ('open','in_progress')
         AND rc.deadline_date <= CURRENT_DATE + 14)::int AS due_within_14d
     FROM recovery_case rc
     WHERE rc.client_id = $1 AND rc.deleted_at IS NULL`, [id.clientId]);
  const byCategory = await pool.query(
    `SELECT COALESCE(rc.denial_category, rc.case_type::text) AS category,
            count(*)::int AS count, COALESCE(sum(rc.recovery_opportunity), 0) AS amount
     FROM recovery_case rc
     WHERE rc.client_id = $1 AND rc.deleted_at IS NULL
       AND rc.status IN ('open','in_progress','submitted','pending_payer')
     GROUP BY 1 ORDER BY amount DESC LIMIT 10`, [id.clientId]);
  const r = rows.rows[0];
  const n = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
  return {
    openCases: r.open_cases,
    openRecoveryOpportunity: n(r.open_amount),
    casesWon: r.won_cases,
    recoveredAllTime: n(r.recovered_total),
    recoveredLast30Days: n(r.recovered_30d),
    dueWithin14Days: r.due_within_14d,
    openByCategory: byCategory.rows.map((c) => ({
      category: c.category, count: c.count, amount: n(c.amount),
    })),
  };
}

const EXTERNAL_ACTION_TYPES = new Set(['note', 'payer_call_logged', 'status_changed']);

export async function logExternalCaseAction(
  pool: PoolLike, id: ApiIdentity, caseId: UUID,
  input: { actionType?: string; notes: string; source?: string },
): Promise<{ ok: true; actionId: UUID }> {
  if (!input.notes?.trim()) throw err('notes is required', 400);
  const actionType = input.actionType ?? 'note';
  if (!EXTERNAL_ACTION_TYPES.has(actionType)) {
    throw err(`actionType must be one of: ${[...EXTERNAL_ACTION_TYPES].join(', ')}`, 400);
  }
  const owned = await pool.query(
    `SELECT 1 FROM recovery_case
     WHERE case_id = $1 AND tenant_id = $2 AND client_id = $3 AND deleted_at IS NULL`,
    [caseId, id.tenantId, id.clientId]);
  if (!owned.rows[0]) throw err('case not found', 404);
  const inserted = await pool.query(
    `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_system, notes)
     VALUES ($1, $2, $3, true, $4) RETURNING action_id`,
    [id.tenantId, caseId, actionType,
     `[via API${input.source ? `: ${input.source}` : ''}] ${input.notes.trim()}`]);
  return { ok: true, actionId: inserted.rows[0].action_id };
}
