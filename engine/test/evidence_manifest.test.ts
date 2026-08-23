import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildEvidenceManifest,
  canonicalManifestDigest,
  verifyEvidenceManifest,
} from '../src/pilot/evidence_manifest.ts';

describe('pilot evidence manifest', () => {
  it('hashes and verifies an immutable evidence bundle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fable-evidence-'));
    const protocol = join(dir, 'protocol.json');
    const reviews = join(dir, 'reviews.json');
    await writeFile(protocol, '{"version":"1"}\n');
    await writeFile(reviews, '[{"finding":"A","label":"valid"}]\n');

    const manifest = await buildEvidenceManifest(
      'pilot-001', 'abc123', 'external-validation-v1', [reviews, protocol],
      '2026-08-22T00:00:00.000Z',
    );

    assert.equal(manifest.files.length, 2);
    assert.deepEqual(manifest.files.map((f) => f.name), ['protocol.json', 'reviews.json']);
    assert.match(canonicalManifestDigest(manifest), /^[a-f0-9]{64}$/);

    const verified = await verifyEvidenceManifest(manifest, [protocol, reviews]);
    assert.deepEqual(verified, { valid: true, errors: [] });
  });

  it('detects changed, missing, and unmanifested files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fable-evidence-'));
    const original = join(dir, 'reviews.json');
    const extra = join(dir, 'extra.json');
    await writeFile(original, '{"result":"original"}\n');

    const manifest = await buildEvidenceManifest(
      'pilot-002', 'def456', 'external-validation-v1', [original],
      '2026-08-22T00:00:00.000Z',
    );

    await writeFile(original, '{"result":"changed"}\n');
    await writeFile(extra, '{}\n');
    const changed = await verifyEvidenceManifest(manifest, [original, extra]);
    assert.equal(changed.valid, false);
    assert.ok(changed.errors.some((e) => e.includes('mismatch: reviews.json')));
    assert.ok(changed.errors.includes('unmanifested evidence file: extra.json'));

    const missing = await verifyEvidenceManifest(manifest, []);
    assert.deepEqual(missing, { valid: false, errors: ['missing evidence file: reviews.json'] });
  });
});
