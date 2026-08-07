// ============================================================================
// Optum / Change Healthcare Professional Claims API client.
//
// Real OAuth2 client-credentials auth (token cached until near expiry) and a
// bounded retry with exponential backoff on transient failures only. 4xx
// content errors (bad claim data, rejected auth) are never retried — retrying
// those just repeats the same rejection and burns the sandbox/production
// rate limit for nothing.
//
// Config resolves from OPTUM_CLIENT_ID / OPTUM_CLIENT_SECRET (via
// optionalSecret, so the `${NAME}_FILE` Docker/K8s-secret convention works
// here too) plus OPTUM_TOKEN_URL / OPTUM_API_BASE_URL, defaulting to Optum's
// documented sandbox host and v2 token endpoint.
//
// IMPORTANT: submissions through this client carry PHI-derived claim data
// (patient name, DOB, diagnosis, procedure). Do not point OPTUM_API_BASE_URL
// at anything but the sandbox host, and do not set
// OPTUM_ALLOW_LIVE_SUBMISSION=1, until a signed BAA covers this integration
// and the connector has completed the certification gate in
// docs/PRODUCTION_READINESS.md (idempotency, real tracking reference,
// acknowledgement reconciliation).
// ============================================================================

import { optionalSecret } from '../security/secrets.ts';

export interface OptumConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  apiBaseUrl: string;
}

export function loadOptumConfig(): OptumConfig | null {
  const clientId = optionalSecret('OPTUM_CLIENT_ID');
  const clientSecret = optionalSecret('OPTUM_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    tokenUrl: process.env.OPTUM_TOKEN_URL || 'https://sandbox-apigw.optum.com/apip/auth/v2/token',
    apiBaseUrl: process.env.OPTUM_API_BASE_URL || 'https://sandbox-apigw.optum.com',
  };
}

export class OptumAuthError extends Error {}

interface CachedToken { token: string; expiresAt: number; }
let cachedToken: CachedToken | null = null;

async function getAccessToken(config: OptumConfig, fetchImpl: typeof fetch): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const res = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new OptumAuthError(`Optum token request failed (${res.status}): ${text}`);

  let json: { access_token?: string; expires_in?: number };
  try {
    json = JSON.parse(text);
  } catch {
    throw new OptumAuthError(`Optum token endpoint returned non-JSON: ${text}`);
  }
  if (!json.access_token) throw new OptumAuthError(`Optum token response missing access_token: ${text}`);

  const ttlMs = (json.expires_in ?? 3600) * 1000;
  cachedToken = { token: json.access_token, expiresAt: Date.now() + ttlMs };
  return cachedToken.token;
}

export interface SubmitResult {
  ok: boolean;
  status: number;
  body: unknown;
  attempts: number;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export type ProfessionalClaimsPath =
  | '/medicalnetwork/professionalclaims/v3/validation'
  | '/medicalnetwork/professionalclaims/v3/submission';

/**
 * POSTs a professional-claims request with a bounded number of retries.
 * Only transient failures (network errors, 408/429/5xx) are retried, with
 * exponential backoff; a 4xx content rejection returns immediately with
 * ok: false so the caller can record it as a permanent failure rather than
 * loop forever on data the payer/clearinghouse will never accept as-is.
 *
 * traceId is sent as x-chng-trace-id, letting Optum correlate retried
 * attempts of the same logical submission (pass the packet's idempotencyKey).
 */
export async function submitProfessionalClaim(
  path: ProfessionalClaimsPath,
  payload: Record<string, unknown>,
  opts: { traceId?: string; maxAttempts?: number; fetchImpl?: typeof fetch } = {},
): Promise<SubmitResult> {
  const config = loadOptumConfig();
  if (!config) throw new OptumAuthError('OPTUM_CLIENT_ID/OPTUM_CLIENT_SECRET are not configured');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxAttempts = opts.maxAttempts ?? 3;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const token = await getAccessToken(config, fetchImpl);
      const res = await fetchImpl(`${config.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(opts.traceId ? { 'x-chng-trace-id': opts.traceId } : {}),
        },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = text; }

      if (res.ok) return { ok: true, status: res.status, body, attempts: attempt };
      if (!RETRYABLE_STATUS.has(res.status)) {
        return { ok: false, status: res.status, body, attempts: attempt };
      }
      lastError = new Error(`Optum ${path} returned retryable status ${res.status}: ${text}`);
    } catch (err) {
      // bad credentials are permanent — retrying with the same secret never helps
      if (err instanceof OptumAuthError) throw err;
      lastError = err;
    }
    if (attempt < maxAttempts) await sleep(2 ** attempt * 250); // 500ms, 1s, 2s, ...
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** test-only: the access-token cache is module-level state, so tests need a way to reset it */
export function __resetOptumTokenCacheForTests(): void {
  cachedToken = null;
}
