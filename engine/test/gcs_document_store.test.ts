// ============================================================================
// GcsDocumentStore integration test — drives real Cloud Storage API calls
// against a real bucket (not a mock). Requires Application Default
// Credentials (gcloud auth application-default login, or the environment's
// attached service account) and a bucket the caller can read/write.
//
//   TEST_GCS_BUCKET=my-test-bucket node --test test/gcs_document_store.test.ts
//
// Covers: text round-trip, binary round-trip, overwrite, not-found, and
// resolveDocumentStore() picking GCS vs. local filesystem based on env.
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const bucket = process.env.TEST_GCS_BUCKET;

describe('GcsDocumentStore', { skip: !bucket && 'TEST_GCS_BUCKET not set' }, () => {
  let store: any;
  const writtenPaths: string[] = [];

  before(async () => {
    const { GcsDocumentStore } = await import('../src/appeals/storage.ts');
    store = await GcsDocumentStore.create(bucket!);
  });

  after(async () => {
    // clean up the objects this test wrote — bucket lifecycle is managed
    // outside the test, not deleted here
    const { Storage } = await import('@google-cloud/storage');
    const b = new Storage().bucket(bucket!);
    await Promise.all(writtenPaths.map((p) => b.file(p).delete({ ignoreNotFound: true })));
  });

  it('round-trips text content', async () => {
    const p = `test/${randomBytes(8).toString('hex')}.txt`;
    writtenPaths.push(p);
    const letter = 'Dear Payer,\n\nThis is a formal appeal for claim CLM-12345.\n\nSincerely,\nProvider';
    const returned = await store.put(p, letter);
    assert.equal(returned, p);
    const read = await store.get(p);
    assert.equal(read, letter);
  });

  it('round-trips binary content (Uint8Array)', async () => {
    const p = `test/${randomBytes(8).toString('hex')}.bin`;
    writtenPaths.push(p);
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 37, 80, 68, 70]); // %PDF-ish garbage
    await store.put(p, bytes);
    const read = await store.getRaw(p);
    assert.deepEqual([...read], [...bytes]);
  });

  it('overwriting a path returns the new content on the next read', async () => {
    const p = `test/${randomBytes(8).toString('hex')}.txt`;
    writtenPaths.push(p);
    await store.put(p, 'draft version');
    await store.put(p, 'final version');
    assert.equal(await store.get(p), 'final version');
  });

  it('reading a path that was never written rejects', async () => {
    await assert.rejects(store.getRaw(`test/never-written-${randomBytes(8).toString('hex')}`));
  });
});

describe('resolveDocumentStore', () => {
  it('picks GcsDocumentStore when GCS_DOCUMENT_BUCKET is set', async () => {
    const original = process.env.GCS_DOCUMENT_BUCKET;
    process.env.GCS_DOCUMENT_BUCKET = bucket ?? 'placeholder-bucket-name';
    try {
      const { resolveDocumentStore, GcsDocumentStore } = await import('../src/appeals/storage.ts');
      const store = await resolveDocumentStore();
      assert.ok(store instanceof GcsDocumentStore);
    } finally {
      if (original === undefined) delete process.env.GCS_DOCUMENT_BUCKET;
      else process.env.GCS_DOCUMENT_BUCKET = original;
    }
  });

  it('falls back to FileSystemDocumentStore when unset', async () => {
    const original = process.env.GCS_DOCUMENT_BUCKET;
    delete process.env.GCS_DOCUMENT_BUCKET;
    try {
      const { resolveDocumentStore, FileSystemDocumentStore } = await import('../src/appeals/storage.ts');
      const store = await resolveDocumentStore();
      assert.ok(store instanceof FileSystemDocumentStore);
    } finally {
      if (original !== undefined) process.env.GCS_DOCUMENT_BUCKET = original;
    }
  });
});
