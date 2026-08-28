// ============================================================================
// A mock Optum / Change Healthcare endpoint, over real HTTP.
//
// The Optum connector has never spoken to anything but a sandbox, and the
// sandbox is a well-behaved happy path: it does not rate-limit, it does not
// fail over mid-request, it does not return HTML from a load balancer, and it
// does not expire a token early. Those are the things that break a first live
// submission, and none of them can be found by reading the code.
//
// This server is deliberately hostile on demand. It speaks real HTTP so the
// client's own fetch, headers, retry timing and JSON handling are exercised —
// a stubbed fetchImpl would test the test.
// ============================================================================

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockBehaviour =
  | { kind: 'accept' }
  /** Respond with a status the client should treat as permanent. */
  | { kind: 'reject'; status: number; body?: unknown }
  /** Fail `times` times with `status`, then accept. */
  | { kind: 'flaky'; times: number; status: number }
  /** Return a body that is not JSON at all, as a proxy or WAF would. */
  | { kind: 'garbage'; status?: number; body?: string }
  /** Accept, but only after `delayMs` — for timeout behaviour. */
  | { kind: 'slow'; delayMs: number }
  /** Close the socket without responding, as a failover does. */
  | { kind: 'hangup' };

export interface RecordedRequest {
  path: string;
  method: string;
  headers: Record<string, string | undefined>;
  body: unknown;
  receivedAt: number;
}

export interface MockOptumOptions {
  /** How the claims endpoints behave. Defaults to accepting. */
  behaviour?: MockBehaviour;
  /** How the token endpoint behaves. */
  tokenBehaviour?: MockBehaviour;
  /** Seconds the issued token claims to live. */
  tokenTtlSeconds?: number;
  /** Reject any request whose bearer token is not the most recent one issued. */
  enforceTokenFreshness?: boolean;
}

export interface MockOptum {
  url: string;
  tokenUrl: string;
  requests: RecordedRequest[];
  /** Requests to the claims endpoints only. */
  claimRequests(): RecordedRequest[];
  tokenRequests(): RecordedRequest[];
  /** Tokens this server has issued, oldest first. */
  issuedTokens: string[];
  setBehaviour(behaviour: MockBehaviour): void;
  setTokenBehaviour(behaviour: MockBehaviour): void;
  reset(): void;
  close(): Promise<void>;
}

export async function startMockOptum(options: MockOptumOptions = {}): Promise<MockOptum> {
  let behaviour: MockBehaviour = options.behaviour ?? { kind: 'accept' };
  let tokenBehaviour: MockBehaviour = options.tokenBehaviour ?? { kind: 'accept' };
  const tokenTtlSeconds = options.tokenTtlSeconds ?? 3600;
  const requests: RecordedRequest[] = [];
  const issuedTokens: string[] = [];
  // Per-path failure counters, so 'flaky' means "this endpoint failed n times"
  // rather than "the server failed n times in total".
  const failureCounts = new Map<string, number>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = (req.url ?? '').split('?')[0];
      const isToken = path.includes('/token');

      let parsed: unknown = raw;
      if (raw.startsWith('{')) { try { parsed = JSON.parse(raw); } catch { /* keep raw */ } }
      else if (raw.includes('=')) parsed = Object.fromEntries(new URLSearchParams(raw));

      requests.push({
        path, method: req.method ?? 'GET',
        headers: req.headers as Record<string, string | undefined>,
        body: parsed, receivedAt: Date.now(),
      });

      const active = isToken ? tokenBehaviour : behaviour;
      const respond = () => {
        if (isToken) return respondToken(res, active);
        return respondClaims(res, active, path);
      };

      if (active.kind === 'slow') {
        setTimeout(() => {
          if (isToken) respondToken(res, { kind: 'accept' });
          else respondClaims(res, { kind: 'accept' }, path);
        }, active.delayMs);
        return;
      }
      if (active.kind === 'hangup') { req.socket.destroy(); return; }
      respond();
    });
  });

  function respondToken(res: Parameters<Parameters<typeof createServer>[0]>[1], active: MockBehaviour) {
    if (active.kind === 'reject') {
      res.writeHead(active.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(active.body ?? { error: 'invalid_client' }));
      return;
    }
    if (active.kind === 'garbage') {
      res.writeHead(active.status ?? 200, { 'content-type': 'text/html' });
      res.end(active.body ?? '<html><body>Service Unavailable</body></html>');
      return;
    }
    if (active.kind === 'flaky') {
      const seen = failureCounts.get('token') ?? 0;
      if (seen < active.times) {
        failureCounts.set('token', seen + 1);
        res.writeHead(active.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'temporarily_unavailable' }));
        return;
      }
    }
    const token = `mock-token-${issuedTokens.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
    issuedTokens.push(token);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: token, expires_in: tokenTtlSeconds, token_type: 'Bearer' }));
  }

  function respondClaims(
    res: Parameters<Parameters<typeof createServer>[0]>[1],
    active: MockBehaviour, path: string,
  ) {
    if (options.enforceTokenFreshness) {
      const last = requests[requests.length - 1];
      const auth = String(last?.headers.authorization ?? '');
      const current = issuedTokens[issuedTokens.length - 1];
      if (!current || auth !== `Bearer ${current}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'token expired or unknown' }));
        return;
      }
    }
    if (active.kind === 'reject') {
      res.writeHead(active.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(active.body ?? {
        status: 'REJECTED',
        errors: [{ field: 'claimInformation', description: 'mock rejection' }],
      }));
      return;
    }
    if (active.kind === 'garbage') {
      res.writeHead(active.status ?? 200, { 'content-type': 'text/html' });
      res.end(active.body ?? '<html><head><title>502 Bad Gateway</title></head></html>');
      return;
    }
    if (active.kind === 'flaky') {
      const seen = failureCounts.get(path) ?? 0;
      if (seen < active.times) {
        failureCounts.set(path, seen + 1);
        res.writeHead(active.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream busy' }));
        return;
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'SUCCESS',
      controlNumber: `MOCK${String(requests.length).padStart(6, '0')}`,
      tradingPartnerServiceId: 'MOCKPAYER',
    }));
  }

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    tokenUrl: `${url}/apip/auth/v2/token`,
    requests,
    issuedTokens,
    claimRequests: () => requests.filter((r) => !r.path.includes('/token')),
    tokenRequests: () => requests.filter((r) => r.path.includes('/token')),
    setBehaviour: (next) => { behaviour = next; failureCounts.clear(); },
    setTokenBehaviour: (next) => { tokenBehaviour = next; failureCounts.clear(); },
    reset: () => {
      requests.length = 0;
      issuedTokens.length = 0;
      failureCounts.clear();
    },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}
