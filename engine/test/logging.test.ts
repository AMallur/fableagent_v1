import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeSafeLogEvent,
  redactForLog,
  sanitizeError,
  serializeSafeLogEvent,
} from '../src/security/logging.ts';

test('redacts direct PHI and secret-bearing fields', () => {
  const redacted = redactForLog({
    tenantId: 'tenant-1',
    payerName: 'Aetna',
    patient_name: 'Jane Doe',
    member_id: 'ABC123',
    nested: {
      authorization_number: 'AUTH-42',
      password: 'secret',
    },
  }) as Record<string, any>;

  assert.equal(redacted.tenantId, 'tenant-1');
  assert.equal(redacted.payerName, 'Aetna');
  assert.equal(redacted.patient_name, '[REDACTED]');
  assert.equal(redacted.member_id, '[REDACTED]');
  assert.equal(redacted.nested.authorization_number, '[REDACTED]');
  assert.equal(redacted.nested.password, '[REDACTED]');
});

test('raw X12 is replaced by a non-reversible short fingerprint', () => {
  const raw = 'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       ~NM1*QC*1*DOE*JANE~~~~~';
  const redacted = redactForLog({ body: raw }) as Record<string, string>;
  assert.match(redacted.body, /^\[REDACTED_X12 sha256:[0-9a-f]{12}\]$/);
  assert.ok(!redacted.body.includes('DOE'));
});

test('large arbitrary strings are hashed and truncated rather than emitted', () => {
  const text = 'x'.repeat(5000);
  const redacted = redactForLog({ detail: text }) as Record<string, string>;
  assert.match(redacted.detail, /^\[TRUNCATED sha256:[0-9a-f]{12} length:5000\]$/);
});

test('structured event serialization preserves operational identifiers', () => {
  const event = makeSafeLogEvent('error', 'ingest failed', {
    tenantId: 't1', clientId: 'c1', jobId: 'j1', patient: 'Jane Doe',
  }, new Date('2026-08-07T20:00:00Z'));
  const serialized = serializeSafeLogEvent(event);
  assert.match(serialized, /"tenantId":"t1"/);
  assert.match(serialized, /"jobId":"j1"/);
  assert.ok(!serialized.includes('Jane Doe'));
});

test('error sanitization never echoes X12 payloads', () => {
  const error = new Error('ISA*00*          *00*          *ZZ*SENDER~CLP*123*1*100*80');
  const out = sanitizeError(error);
  assert.match(String(out.message), /^\[REDACTED_X12 sha256:/);
  assert.ok(!JSON.stringify(out).includes('CLP*123'));
});
