import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadOptumConfig, submitProfessionalClaim, OptumAuthError,
  __resetOptumTokenCacheForTests,
} from '../src/integration/optum_client.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('Optum client config', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
    __resetOptumTokenCacheForTests();
  });

  it('is unconfigured when credentials are missing', () => {
    delete process.env.OPTUM_CLIENT_ID;
    delete process.env.OPTUM_CLIENT_SECRET;
    assert.equal(loadOptumConfig(), null);
  });

  it('defaults to the documented sandbox token URL and API base', () => {
    process.env.OPTUM_CLIENT_ID = 'id';
    process.env.OPTUM_CLIENT_SECRET = 'secret';
    delete process.env.OPTUM_TOKEN_URL;
    delete process.env.OPTUM_API_BASE_URL;
    const config = loadOptumConfig();
    assert.equal(config?.tokenUrl, 'https://sandbox-apigw.optum.com/apip/auth/v2/token');
    assert.equal(config?.apiBaseUrl, 'https://sandbox-apigw.optum.com');
  });
});

describe('submitProfessionalClaim', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.OPTUM_CLIENT_ID = 'test-id';
    process.env.OPTUM_CLIENT_SECRET = 'test-secret';
    __resetOptumTokenCacheForTests();
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    __resetOptumTokenCacheForTests();
  });

  it('throws OptumAuthError when unconfigured', async () => {
    delete process.env.OPTUM_CLIENT_ID;
    delete process.env.OPTUM_CLIENT_SECRET;
    await assert.rejects(
      () => submitProfessionalClaim('/medicalnetwork/professionalclaims/v3/validation', {}),
      OptumAuthError,
    );
  });

  it('fetches a token once and reuses it across calls (cache hit)', async () => {
    let tokenCalls = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/token')) {
        tokenCalls += 1;
        return jsonResponse(200, { access_token: 'tok', expires_in: 3600 });
      }
      return jsonResponse(200, { status: 'SUCCESS' });
    }) as typeof fetch;

    await submitProfessionalClaim('/medicalnetwork/professionalclaims/v3/validation', {}, { fetchImpl });
    await submitProfessionalClaim('/medicalnetwork/professionalclaims/v3/validation', {}, { fetchImpl });
    assert.equal(tokenCalls, 1);
  });

  it('sends the Bearer token and x-chng-trace-id header on the API call', async () => {
    let capturedHeaders: Headers | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('/token')) return jsonResponse(200, { access_token: 'tok', expires_in: 3600 });
      capturedHeaders = new Headers(init?.headers);
      return jsonResponse(200, { status: 'SUCCESS' });
    }) as typeof fetch;

    await submitProfessionalClaim(
      '/medicalnetwork/professionalclaims/v3/validation', {}, { fetchImpl, traceId: 'trace-123' },
    );
    assert.equal(capturedHeaders?.get('authorization'), 'Bearer tok');
    assert.equal(capturedHeaders?.get('x-chng-trace-id'), 'trace-123');
  });

  it('returns ok:false without retrying on a 400 content rejection', async () => {
    let apiCalls = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/token')) return jsonResponse(200, { access_token: 'tok', expires_in: 3600 });
      apiCalls += 1;
      return jsonResponse(400, { errors: [{ description: 'bad claim' }] });
    }) as typeof fetch;

    const result = await submitProfessionalClaim(
      '/medicalnetwork/professionalclaims/v3/validation', {}, { fetchImpl },
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(apiCalls, 1); // no retry on permanent rejection
  });

  it('retries a transient 503 with backoff, then succeeds', async () => {
    let apiCalls = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/token')) return jsonResponse(200, { access_token: 'tok', expires_in: 3600 });
      apiCalls += 1;
      if (apiCalls < 3) return jsonResponse(503, { error: 'unavailable' });
      return jsonResponse(200, { status: 'SUCCESS' });
    }) as typeof fetch;

    const result = await submitProfessionalClaim(
      '/medicalnetwork/professionalclaims/v3/submission', {}, { fetchImpl, maxAttempts: 3 },
    );
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
    assert.equal(apiCalls, 3);
  });

  it('throws after exhausting retries on persistent transient failures', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/token')) return jsonResponse(200, { access_token: 'tok', expires_in: 3600 });
      return jsonResponse(500, { error: 'down' });
    }) as typeof fetch;

    await assert.rejects(() => submitProfessionalClaim(
      '/medicalnetwork/professionalclaims/v3/submission', {}, { fetchImpl, maxAttempts: 2 },
    ));
  });

  it('surfaces a token request failure as OptumAuthError', async () => {
    const fetchImpl = (async () => jsonResponse(401, { error: 'invalid_client' })) as typeof fetch;
    await assert.rejects(
      () => submitProfessionalClaim('/medicalnetwork/professionalclaims/v3/validation', {}, { fetchImpl }),
      OptumAuthError,
    );
  });
});
