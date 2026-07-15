// ============================================================================
// Optum sandbox explorer: fetches an OAuth2 bearer token from Optum's
// developer sandbox and (optionally) fires one test API call, saving the raw
// response to var/optum_sandbox/ so its shape can be compared against this
// engine's internal types (see engine/src/types.ts) before writing a real
// ingest adapter.
//
// This is a throwaway exploration tool, not a connector — nothing here is
// wired into the engine, and it writes nothing to Postgres.
//
// Required env vars:
//   OPTUM_CLIENT_ID       - from the sandbox access email
//   OPTUM_CLIENT_SECRET   - from the sandbox access email
//
// Optional env vars (only needed once you're ready to call an actual
// endpoint — get the exact values from the OpenAPI spec you download in the
// developer.optum.com portal for the product you're testing):
//   OPTUM_TOKEN_URL       - defaults to the documented sandbox token endpoint
//   OPTUM_API_BASE_URL    - e.g. https://apigw.optum.com/apip/<product-path>
//   OPTUM_ENDPOINT_PATH   - the specific resource path, e.g. /eligibility/v3/...
//   OPTUM_TEST_PAYLOAD    - JSON string body, built from the sandbox's
//                           predefined test member ID / payer ID / NPI values
//
//   OPTUM_CLIENT_ID=... OPTUM_CLIENT_SECRET=... node scripts/optum_sandbox_explore.ts
// ============================================================================

import { mkdirSync, writeFileSync } from 'node:fs';

const TOKEN_URL =
  process.env.OPTUM_TOKEN_URL ?? 'https://sandbox-apigw.optum.com/apip/auth/sntl/v1/token';
const CLIENT_ID = process.env.OPTUM_CLIENT_ID;
const CLIENT_SECRET = process.env.OPTUM_CLIENT_SECRET;
const API_BASE = process.env.OPTUM_API_BASE_URL;
const ENDPOINT_PATH = process.env.OPTUM_ENDPOINT_PATH;
const TEST_PAYLOAD = process.env.OPTUM_TEST_PAYLOAD;

async function getAccessToken(): Promise<string> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Set OPTUM_CLIENT_ID and OPTUM_CLIENT_SECRET first.');
  }

  const body = {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'client_credentials',
  };

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Token request failed (${res.status}) at ${TOKEN_URL}.\n` +
        `Response: ${text}\n` +
        `If this 404s or rejects the field names, check "Access our APIs" in the ` +
        `developer.optum.com portal — the sandbox may want the credentials as a ` +
        `Basic Auth header instead of form fields, or a different grant_type.`,
    );
  }

  let json: { access_token?: string; accessToken?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Token endpoint did not return JSON: ${text}`);
  }

  const token = json.access_token ?? json.accessToken;
  if (!token) {
    throw new Error(`No access_token field in token response: ${text}`);
  }
  return token;
}

async function callTestEndpoint(token: string): Promise<{ status: number; body: string }> {
  const url = `${API_BASE}${ENDPOINT_PATH}`;
  const payload = TEST_PAYLOAD ? JSON.parse(TEST_PAYLOAD) : undefined;

  const res = await fetch(url, {
    method: payload ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  return { status: res.status, body: await res.text() };
}

async function main() {
  console.log(`Requesting access token from ${TOKEN_URL} ...`);
  const token = await getAccessToken();
  console.log('Got access token.');

  if (!API_BASE || !ENDPOINT_PATH) {
    console.log(
      '\nToken works. To test an actual API call, set OPTUM_API_BASE_URL and ' +
        'OPTUM_ENDPOINT_PATH (copy these from the OpenAPI spec you downloaded for ' +
        'Eligibility or Claim Responses and Reports in the developer portal), plus ' +
        'OPTUM_TEST_PAYLOAD using one of the predefined sandbox test values from ' +
        '"Eligibility Sandbox API Values and Test Responses".',
    );
    return;
  }

  console.log(`Calling ${API_BASE}${ENDPOINT_PATH} ...`);
  const result = await callTestEndpoint(token);
  console.log(`Response status: ${result.status}`);

  mkdirSync('var/optum_sandbox', { recursive: true });
  const outFile = `var/optum_sandbox/response_${Date.now()}.json`;
  writeFileSync(outFile, result.body);
  console.log(`Raw response saved to ${outFile}`);
  console.log(
    'Next: compare this response shape against engine/src/types.ts (EngineInput) ' +
      "to see what an ingest adapter would need to map — don't wire this into the " +
      'engine until the shape is confirmed.',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
