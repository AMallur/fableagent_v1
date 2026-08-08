// ============================================================================
// PHI-safe structured logging helpers.
//
// The application should log internal correlation identifiers and operational
// metadata, not raw claims/remittances or patient/member data. These helpers
// provide one centrally-testable redaction policy for CloudWatch/stdout and
// for operational error summaries persisted to system_job.log_output.
// ============================================================================

import { createHash } from 'node:crypto';

const SENSITIVE_KEY = /(?:^|_)(?:
  patient|patient_name|first_name|last_name|middle_name|name|dob|birth|gender|sex|
  member|member_id|subscriber|subscriber_id|insurance_id|mrn|ssn|address|street|
  city|zip|postal|phone|email|diagnosis|icd|raw_?835|raw_?837|x12|edi|payload|
  authorization_number|auth_number|claim_request|claim_response|document_body|
  password|secret|token|api_key|access_key|private_key|credential
)(?:$|_)/ix;

const ALLOWLIST_KEY = new Set([
  'tenant_id', 'tenantId', 'client_id', 'clientId', 'payer_id', 'payerId',
  'case_id', 'caseId', 'claim_id', 'claimId', 'claim_line_id', 'claimLineId',
  'job_id', 'jobId', 'packet_id', 'packetId', 'delivery_id', 'deliveryId',
  'file_id', 'fileId', 'correlation_id', 'correlationId', 'trace_id', 'traceId',
  'status', 'kind', 'type', 'operation', 'attempts', 'count', 'duration_ms',
  'http_status', 'httpStatus', 'error_code', 'errorCode', 'service', 'component',
  'environment', 'version', 'timestamp', 'level', 'message',
]);

export interface SafeLogEvent {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function looksLikeX12(value: string): boolean {
  const head = value.trimStart().slice(0, 64);
  return head.startsWith('ISA') || /(?:^|[~\n\r])\s*(?:CLP|NM1|SVC|SV1|DMG|N3|N4)\*/.test(value);
}

function redactString(value: string, key?: string): string {
  if (key && !ALLOWLIST_KEY.has(key) && SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (looksLikeX12(value)) return `[REDACTED_X12 sha256:${shortHash(value)}]`;
  if (value.length > 4096) return `[TRUNCATED sha256:${shortHash(value)} length:${value.length}]`;
  return value;
}

/** Deep-redact an arbitrary JSON-like value without mutating the input. */
export function redactForLog(value: unknown, key?: string, depth = 0): unknown {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactString(value, key);
  if (typeof value === 'bigint') return value.toString();
  if (depth >= 8) return '[MAX_DEPTH]';

  if (value instanceof Error) return sanitizeError(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buf = Buffer.from(value);
    return `[BINARY sha256:${createHash('sha256').update(buf).digest('hex').slice(0, 12)} length:${buf.length}]`;
  }
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, 50);
    const out = value.slice(0, limit).map((item) => redactForLog(item, key, depth + 1));
    if (value.length > limit) out.push(`[${value.length - limit} MORE ITEMS]`);
    return out;
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (!ALLOWLIST_KEY.has(childKey) && SENSITIVE_KEY.test(childKey)) {
        output[childKey] = '[REDACTED]';
      } else {
        output[childKey] = redactForLog(childValue, childKey, depth + 1);
      }
    }
    return output;
  }
  return String(value);
}

export function sanitizeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { name: 'Error', message: redactString(String(error)) };
  }

  // Stack traces are useful for code location, but parser/library errors can
  // echo input. Redact X12-looking lines and cap the stack size.
  const stack = (error.stack ?? '')
    .split('\n')
    .slice(0, 20)
    .map((line) => looksLikeX12(line) ? '[REDACTED_X12_STACK_LINE]' : line.slice(0, 1000))
    .join('\n');

  return {
    name: error.name,
    message: redactString(error.message).slice(0, 2000),
    ...(stack ? { stack } : {}),
  };
}

export function makeSafeLogEvent(
  level: SafeLogEvent['level'],
  message: string,
  context?: Record<string, unknown>,
  now = new Date(),
): SafeLogEvent {
  return {
    timestamp: now.toISOString(),
    level,
    message: redactString(message).slice(0, 2000),
    ...(context ? { context: redactForLog(context) as Record<string, unknown> } : {}),
  };
}

/** JSON line suitable for stdout/CloudWatch ingestion. */
export function serializeSafeLogEvent(event: SafeLogEvent): string {
  return JSON.stringify(redactForLog(event));
}
