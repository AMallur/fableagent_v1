// ============================================================================
// Optum submission simulation.
//
// Exercises the real client in src/integration/optum_client.ts against the
// mock payer, over real HTTP, through the failure modes a sandbox never
// produces. The point is to find integration defects before sandbox
// credentials arrive, so that the first live conversation is about certifying
// a connector that is already known to behave, rather than about discovering
// how it behaves.
//
// Every scenario states what a live submission would do if the assertion
// failed, because that is the cost being avoided.
// ============================================================================

import { startMockOptum, type MockOptum } from './mock_optum.ts';

export interface ScenarioResult {
  name: string;
  /** What a live submission would do if this were wrong. */
  matters: string;
  passed: boolean;
  detail: string;
}

export interface OptumSimulationReport {
  scenarios: ScenarioResult[];
  passed: boolean;
}

const SUBMISSION_PATH = '/medicalnetwork/professionalclaims/v3/submission';
const VALIDATION_PATH = '/medicalnetwork/professionalclaims/v3/validation';

/** A minimal but structurally real professional-claim payload. */
function samplePayload(controlNumber: string): Record<string, unknown> {
  return {
    controlNumber,
    tradingPartnerServiceId: '9496',
    submitter: { organizationName: 'ALPHA ORTHOPEDIC GROUP', contactInformation: { name: 'BILLING' } },
    receiver: { organizationName: 'MOCK PAYER' },
    subscriber: {
      memberId: '0000000001', firstName: 'ALEX', lastName: 'NGUYEN',
      dateOfBirth: '19800501', gender: 'F',
    },
    providers: [{ providerType: 'BillingProvider', npi: '1760854442',
      organizationName: 'ALPHA ORTHOPEDIC GROUP' }],
    claimInformation: {
      claimFilingCode: 'CI',
      patientControlNumber: controlNumber,
      claimChargeAmount: '250.00',
      placeOfServiceCode: '11',
      claimFrequencyCode: '7',
      healthCareCodeInformation: [{ diagnosisTypeCode: 'ABK', diagnosisCode: 'J01.90' }],
      serviceLines: [{
        serviceDate: '20260601',
        professionalService: {
          procedureIdentifier: 'HC', procedureCode: '99213',
          lineItemChargeAmount: '250.00', measurementUnit: 'UN', serviceUnitCount: '1',
        },
      }],
    },
  };
}

async function withEnv<T>(
  env: Record<string, string | undefined>, work: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await work();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function runOptumSimulation(): Promise<OptumSimulationReport> {
  const mock = await startMockOptum();
  const scenarios: ScenarioResult[] = [];

  const client = await import('../integration/optum_client.ts');
  const record = (
    name: string, matters: string, passed: boolean, detail: string,
  ) => { scenarios.push({ name, matters, passed, detail }); };

  const env = {
    OPTUM_CLIENT_ID: 'mock-client-id',
    OPTUM_CLIENT_SECRET: 'mock-client-secret',
    OPTUM_TOKEN_URL: mock.tokenUrl,
    OPTUM_API_BASE_URL: mock.url,
  };

  await withEnv(env, async () => {
    // --- 1. a clean submission -------------------------------------------
    mock.reset(); client.__resetOptumTokenCacheForTests();
    mock.setBehaviour({ kind: 'accept' });
    {
      const result = await client.submitProfessionalClaim(
        SUBMISSION_PATH, samplePayload('SIM-0001'), { traceId: 'trace-0001' });
      record('a clean submission is accepted',
        'nothing else in the connector matters if the happy path does not work',
        result.ok && result.status === 200 && result.attempts === 1,
        `ok=${result.ok} status=${result.status} attempts=${result.attempts}`);

      const sent = mock.claimRequests()[0];
      record('the trace id is sent as x-chng-trace-id',
        'without it Optum cannot correlate a retried attempt with the original, '
        + 'so a retry after a timeout can be adjudicated as a second claim',
        sent?.headers['x-chng-trace-id'] === 'trace-0001',
        `header=${sent?.headers['x-chng-trace-id']}`);

      record('the bearer token is attached',
        'an unauthenticated submission is rejected and counts against the rate limit',
        String(sent?.headers.authorization ?? '').startsWith('Bearer mock-token-'),
        `authorization=${String(sent?.headers.authorization).slice(0, 24)}...`);
    }

    // --- 2. the token is fetched once and reused --------------------------
    {
      const before = mock.tokenRequests().length;
      await client.submitProfessionalClaim(SUBMISSION_PATH, samplePayload('SIM-0002'));
      await client.submitProfessionalClaim(VALIDATION_PATH, samplePayload('SIM-0003'));
      const after = mock.tokenRequests().length;
      record('the access token is cached across submissions',
        'a token request per claim triples the call volume and will hit the '
        + 'auth rate limit on a normal day’s batch',
        after === before,
        `token requests before=${before} after=${after}`);
    }

    // --- 3. a 4xx rejection is permanent ----------------------------------
    mock.reset(); client.__resetOptumTokenCacheForTests();
    mock.setBehaviour({ kind: 'reject', status: 400 });
    {
      const result = await client.submitProfessionalClaim(
        SUBMISSION_PATH, samplePayload('SIM-0004'));
      record('a 400 is returned immediately, not retried',
        'retrying a content rejection cannot succeed, and three copies of a '
        + 'bad claim is three rejections against the rate limit',
        !result.ok && result.status === 400 && result.attempts === 1
          && mock.claimRequests().length === 1,
        `attempts=${result.attempts} requests=${mock.claimRequests().length}`);
    }

    // --- 4. a duplicate-claim rejection is surfaced, not swallowed --------
    mock.reset(); client.__resetOptumTokenCacheForTests();
    mock.setBehaviour({ kind: 'reject', status: 409, body: { status: 'DUPLICATE' } });
    {
      const result = await client.submitProfessionalClaim(
        SUBMISSION_PATH, samplePayload('SIM-0005'));
      record('a 409 duplicate is reported as a failure with its body intact',
        'a duplicate has to reach the operator: it usually means the previous '
        + 'attempt did land, and re-sending is how one appeal becomes two claims',
        !result.ok && result.status === 409
          && JSON.stringify(result.body).includes('DUPLICATE'),
        `status=${result.status} body=${JSON.stringify(result.body)}`);
    }

    // --- 5. transient 503 is retried and then succeeds --------------------
    mock.reset(); client.__resetOptumTokenCacheForTests();
    mock.setBehaviour({ kind: 'flaky', times: 2, status: 503 });
    {
      const started = Date.now();
      const result = await client.submitProfessionalClaim(
        SUBMISSION_PATH, samplePayload('SIM-0006'), { maxAttempts: 4 });
      const elapsed = Date.now() - started;
      record('two 503s are retried and the third attempt succeeds',
        'a clearinghouse restart during a nightly batch must not lose the '
        + 'appeals in flight',
        result.ok && result.attempts === 3,
        `ok=${result.ok} attempts=${result.attempts} elapsed=${elapsed}ms`);
      record('the retries back off rather than hammering',
        'an immediate retry loop turns a brief outage into a rate-limit ban',
        elapsed >= 1400,
        `elapsed=${elapsed}ms across 2 backoffs (expect >= 500ms + 1000ms)`);
    }

    // --- 6. 429 is treated as transient -----------------------------------
    mock.reset(); client.__resetOptumTokenCacheForTests();
    mock.setBehaviour({ kind: 'flaky', times: 1, status: 429 });
    {
      const result = await client.submitProfessionalClaim(
        SUBMISSION_PATH, samplePayload('SIM-0007'), { maxAttempts: 3 });
      record('a 429 is retried rather than failed',
        'rate limiting is normal at volume; treating it as permanent would '
        + 'silently drop appeals on the busiest days',
        result.ok && result.attempts === 2,
        `ok=${result.ok} attempts=${result.attempts}`);
    }

    // --- 7. exhausted retries throw rather than reporting success ---------
    mock.reset(); client.__resetOptumTokenCacheForTests();
    mock.setBehaviour({ kind: 'reject', status: 503 });
    {
      let threw = false;
      let message = '';
      try {
        await client.submitProfessionalClaim(
          SUBMISSION_PATH, samplePayload('SIM-0008'), { maxAttempts: 2 });
      } catch (error) { threw = true; message = (error as Error).message; }
      record('a sustained outage throws after the retry budget',
        'returning ok on an unsent claim would mark the appeal submitted and '
        + 'stop anyone from ever sending it',
        threw, threw ? message.slice(0, 90) : 'it returned instead of throwing');
    }

    // --- 8. non-JSON from a proxy does not crash --------------------------
    mock.reset(); client.__resetOptumTokenCacheForTests();
    mock.setBehaviour({ kind: 'garbage', status: 200 });
    {
      let crashed = false;
      let detail = '';
      try {
        const result = await client.submitProfessionalClaim(
          SUBMISSION_PATH, samplePayload('SIM-0009'));
        detail = `ok=${result.ok} body is ${typeof result.body}`;
      } catch (error) { crashed = true; detail = (error as Error).message.slice(0, 90); }
      record('an HTML error page is handled as a body, not a parse crash',
        'a load balancer or WAF in front of the payer returns HTML, and a '
        + 'JSON.parse that throws there takes down the submission worker',
        !crashed, detail);
    }

    // --- 9. a dropped connection is retried -------------------------------
    mock.reset(); client.__resetOptumTokenCacheForTests();
    mock.setBehaviour({ kind: 'hangup' });
    {
      let threw = false;
      let detail = '';
      try {
        await client.submitProfessionalClaim(
          SUBMISSION_PATH, samplePayload('SIM-0010'), { maxAttempts: 2 });
      } catch (error) { threw = true; detail = (error as Error).message.slice(0, 90); }
      record('a dropped connection is retried and then reported',
        'a failover mid-request must not be recorded as a successful submission',
        threw && mock.claimRequests().length >= 2,
        `threw=${threw} attempts seen by server=${mock.claimRequests().length} ${detail}`);
    }

    // --- 10. bad credentials are permanent --------------------------------
    mock.reset(); client.__resetOptumTokenCacheForTests();
    mock.setTokenBehaviour({ kind: 'reject', status: 401 });
    {
      let threw = false;
      let isAuthError = false;
      try {
        await client.submitProfessionalClaim(
          SUBMISSION_PATH, samplePayload('SIM-0011'), { maxAttempts: 3 });
      } catch (error) {
        threw = true;
        isAuthError = error instanceof client.OptumAuthError;
      }
      record('rejected credentials throw immediately and are not retried',
        'retrying a bad secret can trip a lockout on the account every batch '
        + 'runs, turning a config mistake into an outage',
        threw && isAuthError && mock.tokenRequests().length === 1,
        `authError=${isAuthError} tokenRequests=${mock.tokenRequests().length}`);
      mock.setTokenBehaviour({ kind: 'accept' });
    }

    // --- 11. a token endpoint returning HTML is an auth error -------------
    mock.reset(); client.__resetOptumTokenCacheForTests();
    mock.setTokenBehaviour({ kind: 'garbage', status: 200 });
    {
      let isAuthError = false;
      let detail = '';
      try {
        await client.submitProfessionalClaim(SUBMISSION_PATH, samplePayload('SIM-0012'));
      } catch (error) {
        isAuthError = error instanceof client.OptumAuthError;
        detail = (error as Error).message.slice(0, 80);
      }
      record('a non-JSON token response is a clear auth error',
        'this is what a misconfigured token URL actually looks like, and the '
        + 'error has to name the cause or an outage becomes an afternoon',
        isAuthError, `authError=${isAuthError} ${detail}`);
      mock.setTokenBehaviour({ kind: 'accept' });
    }

    // --- 12. a stale cached token is not silently reused forever ----------
    // The client caches until 60s before expiry. A token that lives 61s is
    // therefore refreshed almost immediately, which is how a short-lived
    // production token behaves and a long-lived sandbox one never does.
    mock.reset(); client.__resetOptumTokenCacheForTests();
    {
      const shortLived = await startMockOptum({ tokenTtlSeconds: 30 });
      await withEnv({
        OPTUM_TOKEN_URL: shortLived.tokenUrl, OPTUM_API_BASE_URL: shortLived.url,
      }, async () => {
        client.__resetOptumTokenCacheForTests();
        await client.submitProfessionalClaim(SUBMISSION_PATH, samplePayload('SIM-0013'));
        await client.submitProfessionalClaim(SUBMISSION_PATH, samplePayload('SIM-0014'));
        record('a token that expires sooner than the cache window is re-fetched',
          'production tokens are short; caching one past its life sends every '
          + 'submission with a dead bearer and every one comes back 401',
          shortLived.tokenRequests().length === 2,
          `token requests=${shortLived.tokenRequests().length} for 2 submissions`);
      });
      await shortLived.close();
    }

    // --- 13. the payload reaches the payer unaltered -----------------------
    mock.reset(); client.__resetOptumTokenCacheForTests();
    mock.setBehaviour({ kind: 'accept' });
    {
      const payload = samplePayload('SIM-0015');
      await client.submitProfessionalClaim(SUBMISSION_PATH, payload);
      const received = mock.claimRequests()[0]?.body as Record<string, any>;
      const claim = received?.claimInformation;
      record('the claim arrives with its identifying fields intact',
        'a control number or charge amount lost in transit is an appeal the '
        + 'payer cannot match to anything',
        claim?.patientControlNumber === 'SIM-0015'
          && claim?.claimChargeAmount === '250.00'
          && received?.subscriber?.memberId === 'MEM-000001'
          && claim?.serviceLines?.[0]?.professionalService?.procedureCode === '99213',
        `controlNumber=${claim?.patientControlNumber} charge=${claim?.claimChargeAmount} `
        + `member=${received?.subscriber?.memberId}`);
    }

    // --- 14. claim status uses the documented path ------------------------
    mock.reset(); client.__resetOptumTokenCacheForTests();
    {
      await client.checkClaimStatus({ controlNumber: 'SIM-0015' }, { traceId: 'status-1' });
      const sent = mock.claimRequests()[0];
      record('a status check posts to the claim status endpoint',
        'acknowledgement reconciliation is what turns "we sent it" into "they '
        + 'have it", and it is a production-readiness gate',
        sent?.path === client.CLAIM_STATUS_PATH,
        `path=${sent?.path}`);
    }
  });

  await mock.close();
  return { scenarios, passed: scenarios.every((s) => s.passed) };
}

export function formatOptumSimulationReport(report: OptumSimulationReport): string {
  const lines: string[] = ['# Optum submission simulation', ''];
  lines.push('The real connector driven over HTTP against a payer that '
    + 'misbehaves on purpose. No sandbox credentials are involved.');
  lines.push('');
  lines.push('| | scenario | evidence |');
  lines.push('|---|---|---|');
  for (const scenario of report.scenarios) {
    lines.push(`| ${scenario.passed ? 'PASS' : '**FAIL**'} | ${scenario.name} `
      + `| ${scenario.detail} |`);
  }
  const failures = report.scenarios.filter((s) => !s.passed);
  if (failures.length > 0) {
    lines.push('');
    lines.push('## What each failure would cost live');
    lines.push('');
    for (const failure of failures) {
      lines.push(`- **${failure.name}** — ${failure.matters}`);
    }
  }
  lines.push('');
  lines.push(`${report.scenarios.filter((s) => s.passed).length} of `
    + `${report.scenarios.length} scenarios passed.`);
  return lines.join('\n');
}
