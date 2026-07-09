// ============================================================================
// API documentation — generated from the endpoint descriptors below, which
// are the same source of truth the /api/v1 router announces. Served as:
//   GET /api/v1/docs          human-readable reference (public)
//   GET /api/v1/openapi.json  OpenAPI 3.0 document (public)
// ============================================================================

interface EndpointDoc {
  method: 'GET' | 'POST';
  path: string;
  summary: string;
  scope: 'read' | 'ingest';
  description: string;
  requestExample?: { contentType: string; body: string };
  responseExample: string;
  queryParams?: Array<{ name: string; description: string }>;
}

export const API_ENDPOINTS: EndpointDoc[] = [
  {
    method: 'POST', path: '/api/v1/claims/ingest', scope: 'ingest',
    summary: 'Ingest claims (837P raw X12 or structured JSON)',
    description: 'Loads claims into the platform: patients and providers are '
      + 'upserted, encounters/claims/lines created. Idempotent — claims whose '
      + 'claim number already exists are skipped. Send raw X12 with '
      + 'Content-Type: text/plain, or structured JSON with application/json.',
    requestExample: {
      contentType: 'application/json',
      body: JSON.stringify({
        billingProvider: { name: 'ALPHA ORTHO GROUP', npi: '1234567890' },
        transactionDate: '2026-07-01',
        claims: [{
          claimNumber: 'CLM-2001', chargeAmount: 250, placeOfService: '11',
          diagnosisCodes: ['M17.11'], authorizationNumber: 'AUTH-9',
          payerName: 'Unity Health Plan',
          subscriber: { firstName: 'Jane', lastName: 'Doe', memberId: 'MEM-1', dob: '1980-05-01' },
          renderingProvider: { name: 'Dr. Smith', npi: '1111111111' },
          lines: [{ procedureCode: '99213', modifiers: [], chargeAmount: 250, units: 1, dateOfService: '2026-06-20' }],
        }],
      }, null, 2),
    },
    responseExample: JSON.stringify({
      jobId: 'b0a1…', recordsProcessed: 1, skipped: 0, warnings: [],
    }, null, 2),
  },
  {
    method: 'POST', path: '/api/v1/remittances/ingest', scope: 'ingest',
    summary: 'Ingest remittances (835 raw X12 or structured JSON) — triggers matching & detection',
    description: 'Loads remittance data, then runs claim matching, expected-'
      + 'reimbursement calculation, and variance/denial detection for the '
      + 'client. The response includes both the ingest stats and the '
      + 'detection summary (cases created, recovery identified). Idempotent '
      + 'by check/EFT trace number.',
    requestExample: {
      contentType: 'application/json',
      body: JSON.stringify({
        payer: { name: 'Unity Health Plan', idCode: 'DEMO-UNI' },
        checkNumber: 'CHK-881', checkDate: '2026-07-05', totalPaid: 80,
        claims: [{
          claimNumber: 'CLM-2001', payerClaimNumber: 'ICN-77', paidAmount: 80, billedAmount: 250,
          patient: { firstName: 'Jane', lastName: 'Doe', memberId: 'MEM-1' },
          lines: [{
            procedureCode: '99213', billedAmount: 250, paidAmount: 80, allowedAmount: 125,
            dateOfService: '2026-06-20',
            adjustments: [{ groupCode: 'CO', reasonCode: '45', amount: 125 }],
          }],
        }],
      }, null, 2),
    },
    responseExample: JSON.stringify({
      jobId: 'c3d4…', recordsProcessed: 1, skipped: 0, warnings: [],
      detection: { matched: 1, unmatched: 0, casesCreated: 1, totalRecoveryOpportunity: 45 },
    }, null, 2),
  },
  {
    method: 'GET', path: '/api/v1/cases', scope: 'read',
    summary: 'List open recovery cases',
    description: 'Returns recovery cases for the authenticated client, newest '
      + 'deadline first. Defaults to open statuses.',
    queryParams: [
      { name: 'status', description: 'open | in_progress | submitted | pending_payer | won | lost | closed_no_action | all' },
      { name: 'priority', description: 'critical | high | medium | low' },
      { name: 'payerId', description: 'filter by payer UUID' },
    ],
    responseExample: JSON.stringify({
      cases: [{
        caseId: 'a1b2…', priority: 'high', status: 'open', caseType: 'underpayment',
        category: 'contractual', denialCode: 'CO-45', patientName: 'Jane Doe',
        payerName: 'Unity Health Plan', dos: '2026-06-20', procedureCode: '99213',
        amount: 45, deadline: '2026-12-22', daysOpen: 3,
      }],
    }, null, 2),
  },
  {
    method: 'GET', path: '/api/v1/cases/{case_id}', scope: 'read',
    summary: 'Full case detail',
    description: 'Case summary, patient, claim with line-level variance, '
      + 'remittance history, appeal packet status, and the case timeline.',
    responseExample: JSON.stringify({
      case: { caseId: 'a1b2…', status: 'open', recoveryOpportunity: 45 },
      patient: { name: 'Jane Doe', mrn: 'MRN-1001' },
      claim: { number: 'CLM-2001', lines: [{ procedureCode: '99213', variance: 45 }] },
      packet: { status: 'ready', appealType: 'first_level' },
      timeline: [{ actionType: 'note', by: 'System' }],
    }, null, 2),
  },
  {
    method: 'POST', path: '/api/v1/cases/{case_id}/actions', scope: 'ingest',
    summary: 'Log an action against a case from an external system',
    description: 'Appends to the case timeline. actionType: note (default), '
      + 'payer_call_logged, or status_changed (timeline entry only — it does '
      + 'not change the case status).',
    requestExample: {
      contentType: 'application/json',
      body: JSON.stringify({
        actionType: 'note', source: 'athenahealth',
        notes: 'Payer confirmed reprocessing, ETA 10 business days',
      }, null, 2),
    },
    responseExample: JSON.stringify({ ok: true, actionId: 'e5f6…' }, null, 2),
  },
  {
    method: 'GET', path: '/api/v1/reports/recovery-summary', scope: 'read',
    summary: 'Recovery summary for dashboard integration',
    description: 'Aggregate open opportunity, recoveries, deadline pressure, '
      + 'and open cases by denial category.',
    responseExample: JSON.stringify({
      openCases: 34, openRecoveryOpportunity: 6730.75, casesWon: 11,
      recoveredAllTime: 1893.20, recoveredLast30Days: 642.11, dueWithin14Days: 4,
      openByCategory: [{ category: 'authorization', count: 8, amount: 2306 }],
    }, null, 2),
  },
];

export const ERROR_CODES: Array<{ code: number; meaning: string }> = [
  { code: 400, meaning: 'Malformed request — the error field explains which field failed validation' },
  { code: 401, meaning: 'Missing, invalid, or revoked API key' },
  { code: 403, meaning: 'API key lacks the required scope (read vs ingest)' },
  { code: 404, meaning: 'Resource not found (or belongs to another client — indistinguishable by design)' },
  { code: 429, meaning: 'Rate limit exceeded — Retry-After header carries the wait in seconds' },
  { code: 500, meaning: 'Internal error — the request is logged; contact support with the timestamp' },
];

// ---------------------------------------------------------------------------

export function buildOpenApi(baseUrl: string): object {
  const paths: Record<string, any> = {};
  for (const e of API_ENDPOINTS) {
    const p = e.path.replace('{case_id}', '{caseId}');
    paths[p] = paths[p] ?? {};
    paths[p][e.method.toLowerCase()] = {
      summary: e.summary,
      description: e.description,
      security: [{ apiKey: [] }],
      parameters: [
        ...(p.includes('{caseId}') ? [{
          name: 'caseId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' },
        }] : []),
        ...(e.queryParams ?? []).map((q) => ({
          name: q.name, in: 'query', required: false,
          schema: { type: 'string' }, description: q.description,
        })),
      ],
      ...(e.requestExample ? {
        requestBody: {
          content: {
            [e.requestExample.contentType]: { example: JSON.parse(safeJson(e.requestExample.body)) },
            ...(e.path.includes('ingest') ? { 'text/plain': { example: 'ISA*00*…~ST*835*0001~…' } } : {}),
          },
        },
      } : {}),
      responses: {
        200: { description: 'OK', content: { 'application/json': { example: JSON.parse(safeJson(e.responseExample)) } } },
        ...Object.fromEntries(ERROR_CODES.map((c) => [c.code, { description: c.meaning }])),
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'RCM Recovery Platform API',
      version: '1.0.0',
      description: 'Ingest claims and remittances, read recovery cases, and '
        + 'integrate recovery data into PM/EHR systems.',
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http', scheme: 'bearer', bearerFormat: 'rcm_<prefix>_<secret>',
          description: 'Per-client API key, sent as "Authorization: Bearer rcm_…" or "X-Api-Key: rcm_…". '
            + 'Keys are created in Client Administration → Integration and shown once.',
        },
      },
    },
    paths,
  };
}

function safeJson(s: string): string {
  try { JSON.parse(s); return s; } catch { return JSON.stringify(s); }
}

// ---------------------------------------------------------------------------

const escHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

export function docsHtml(baseUrl: string): string {
  const sections = API_ENDPOINTS.map((e) => `
<div class="ep">
  <h2><span class="m ${e.method.toLowerCase()}">${e.method}</span> <code>${e.path}</code></h2>
  <p><b>${escHtml(e.summary)}</b> <span class="scope">scope: ${e.scope}</span></p>
  <p>${escHtml(e.description)}</p>
  ${e.queryParams ? `<h4>Query parameters</h4><ul>${e.queryParams.map((q) =>
    `<li><code>${q.name}</code> — ${escHtml(q.description)}</li>`).join('')}</ul>` : ''}
  ${e.requestExample ? `<h4>Example request</h4>
<pre>curl -X ${e.method} ${baseUrl}${e.path.replace('{case_id}', '&lt;case-uuid&gt;')} \\
  -H "Authorization: Bearer rcm_YOUR_KEY" \\
  -H "Content-Type: ${e.requestExample.contentType}" \\
  -d '${escHtml(e.requestExample.body)}'</pre>` : `<h4>Example request</h4>
<pre>curl ${baseUrl}${e.path.replace('{case_id}', '&lt;case-uuid&gt;')} \\
  -H "Authorization: Bearer rcm_YOUR_KEY"</pre>`}
  <h4>Example response</h4>
<pre>${escHtml(e.responseExample)}</pre>
</div>`).join('\n');

  return `<!doctype html><html><head><meta charset="utf-8">
<title>RCM Recovery Platform — API Reference</title>
<style>
body { font: 15px/1.55 -apple-system, 'Segoe UI', sans-serif; color: #1a2233;
       max-width: 880px; margin: 0 auto; padding: 32px 20px 80px; }
h1 { font-size: 26px; } h2 { font-size: 17px; margin: 36px 0 6px; }
h4 { margin: 14px 0 4px; font-size: 13px; text-transform: uppercase; color: #66718a; }
code { background: #eef2f8; padding: 1px 6px; border-radius: 5px; font-size: 13.5px; }
pre { background: #142743; color: #dbe6f5; padding: 14px; border-radius: 9px;
      overflow-x: auto; font-size: 12.5px; line-height: 1.5; }
.m { display: inline-block; padding: 2px 9px; border-radius: 6px; color: #fff;
     font-size: 12.5px; font-weight: 700; vertical-align: 2px; }
.m.get { background: #1e8449; } .m.post { background: #1f4e8c; }
.scope { color: #66718a; font-size: 12.5px; margin-left: 8px; }
.ep { border-bottom: 1px solid #e3e8f0; padding-bottom: 20px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
td, th { border-bottom: 1px solid #e3e8f0; padding: 7px 10px; text-align: left; }
.note { background: #fef5e7; border-left: 4px solid #b9770e; padding: 10px 14px; border-radius: 6px; }
</style></head><body>
<h1>RCM Recovery Platform — API Reference</h1>
<p>REST API for PM/EHR direct connections: ingest claims and remittances,
read recovery cases, and pull recovery metrics into your own dashboards.
Machine-readable spec: <a href="/api/v1/openapi.json">OpenAPI 3.0 JSON</a>.</p>

<h2>Authentication</h2>
<p>Every request needs a per-client API key, created in
<i>Client Administration → Integration → API keys</i> (shown once at creation).
Send it either way:</p>
<pre>Authorization: Bearer rcm_ab12cd34_&lt;secret&gt;
X-Api-Key: rcm_ab12cd34_&lt;secret&gt;</pre>
<p>Keys are scoped (<code>read</code>, <code>ingest</code>) and rate limited
per minute (default 120; configurable per key). Every call is logged with
method, path, status, latency, and source IP. Data isolation is identical to
the UI: a key sees exactly one client's data.</p>

<div class="note"><b>Rate limits.</b> Exceeding the per-key limit returns
<code>429</code> with a <code>Retry-After</code> header (seconds).</div>

${sections}

<h2>Error codes</h2>
<table><tr><th>Code</th><th>Meaning</th></tr>
${ERROR_CODES.map((c) => `<tr><td><code>${c.code}</code></td><td>${escHtml(c.meaning)}</td></tr>`).join('')}
</table>
<p>All error responses share one shape: <code>{"error": "human-readable message"}</code>.</p>
</body></html>`;
}
