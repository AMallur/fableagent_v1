import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRuntimeReadiness } from '../src/integration/runtime_readiness.ts';

test('development can start without live cloud resources', () => {
  const report = inspectRuntimeReadiness({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://example',
  });
  assert.equal(report.production, false);
  assert.equal(report.readyForApplicationStart, true);
  assert.equal(report.readyForPhiStorage, false);
});

test('production PHI readiness requires durable storage and secrets', () => {
  const report = inspectRuntimeReadiness({
    NODE_ENV: 'production',
    DB_HOST: 'db.internal',
    DB_NAME: 'fableagent',
    DB_USER: 'fable_runtime',
    DB_PASSWORD: 'not-a-real-secret',
    SESSION_SECRET: 'session-secret',
    DATA_ENCRYPTION_KEY: 'encryption-key',
    AWS_DOCUMENT_BUCKET: 'documents',
    AWS_DOCUMENT_KMS_KEY_ID: 'alias/fableagent-phi',
    AWS_REGION: 'us-east-1',
  });
  assert.equal(report.readyForApplicationStart, true);
  assert.equal(report.readyForPhiStorage, true);
  assert.equal(report.readyForEmailDelivery, false);
  assert.equal(report.readyForOptumSubmission, false);
});

test('production refuses ambiguous dual document-store configuration', () => {
  const report = inspectRuntimeReadiness({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://example',
    SESSION_SECRET: 'session-secret',
    DATA_ENCRYPTION_KEY: 'encryption-key',
    AWS_DOCUMENT_BUCKET: 'documents',
    AWS_DOCUMENT_KMS_KEY_ID: 'key',
    GCS_DOCUMENT_BUCKET: 'other-documents',
  });
  assert.equal(report.readyForPhiStorage, false);
  assert.ok(report.items.some((item) => item.key === 'durable_document_store' && !item.ready));
});

test('Optum remains separately gated behind credentials and explicit live flag', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://example',
    SESSION_SECRET: 'session-secret',
    DATA_ENCRYPTION_KEY: 'encryption-key',
    AWS_DOCUMENT_BUCKET: 'documents',
    AWS_DOCUMENT_KMS_KEY_ID: 'key',
    AWS_REGION: 'us-east-1',
    OPTUM_CLIENT_ID: 'id',
    OPTUM_CLIENT_SECRET: 'secret',
  };
  assert.equal(inspectRuntimeReadiness(base).readyForOptumSubmission, false);
  assert.equal(inspectRuntimeReadiness({ ...base, OPTUM_ALLOW_LIVE_SUBMISSION: '1' }).readyForOptumSubmission, true);
});
