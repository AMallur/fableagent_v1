import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { resolveDocumentStore, S3DocumentStore } from '../src/appeals/storage.ts';

describe('S3 document store', () => {
  it('writes and reads tenant-confined keys with optional KMS encryption', async () => {
    const sent: unknown[] = [];
    const client = {
      async send(command: unknown) {
        sent.push(command);
        if (command instanceof GetObjectCommand) {
          return { Body: { transformToByteArray: async () => new TextEncoder().encode('letter') } };
        }
        return {};
      },
    };
    const store = new S3DocumentStore(client, 'fable-documents', 'alias/fable-documents');

    assert.equal(await store.put('tenant/client/letter.txt', 'letter'), 'tenant/client/letter.txt');
    assert.equal(await store.get('tenant/client/letter.txt'), 'letter');

    const put = sent[0] as PutObjectCommand;
    assert.equal(put.input.Bucket, 'fable-documents');
    assert.equal(put.input.Key, 'tenant/client/letter.txt');
    assert.equal(put.input.ServerSideEncryption, 'aws:kms');
    assert.equal(put.input.SSEKMSKeyId, 'alias/fable-documents');
  });

  it('rejects path traversal before sending an S3 request', async () => {
    let calls = 0;
    const store = new S3DocumentStore({ async send() { calls += 1; return {}; } }, 'bucket');
    await assert.rejects(store.put('../outside', 'x'), /escapes store root/);
    assert.equal(calls, 0);
  });

  it('rejects ambiguous GCS and S3 configuration', async () => {
    const priorGcs = process.env.GCS_DOCUMENT_BUCKET;
    const priorS3 = process.env.AWS_DOCUMENT_BUCKET;
    process.env.GCS_DOCUMENT_BUCKET = 'gcs';
    process.env.AWS_DOCUMENT_BUCKET = 's3';
    try {
      await assert.rejects(resolveDocumentStore(), /configure exactly one document store/);
    } finally {
      if (priorGcs == null) delete process.env.GCS_DOCUMENT_BUCKET;
      else process.env.GCS_DOCUMENT_BUCKET = priorGcs;
      if (priorS3 == null) delete process.env.AWS_DOCUMENT_BUCKET;
      else process.env.AWS_DOCUMENT_BUCKET = priorS3;
    }
  });
});
