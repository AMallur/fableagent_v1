import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export interface EvidenceFile {
  name: string;
  bytes: number;
  sha256: string;
}

export interface EvidenceManifest {
  schemaVersion: 1;
  bundleId: string;
  engineCommit: string;
  protocolVersion: string;
  createdAt: string;
  files: EvidenceFile[];
}

export async function buildEvidenceManifest(
  bundleId: string,
  engineCommit: string,
  protocolVersion: string,
  filePaths: string[],
  createdAt = new Date().toISOString(),
): Promise<EvidenceManifest> {
  requireText(bundleId, 'bundleId');
  requireText(engineCommit, 'engineCommit');
  requireText(protocolVersion, 'protocolVersion');
  if (filePaths.length === 0) throw new Error('filePaths must contain at least one evidence file');

  const names = new Set<string>();
  const files: EvidenceFile[] = [];
  for (const path of [...filePaths].sort()) {
    const name = basename(path);
    if (names.has(name)) throw new Error(`duplicate evidence filename: ${name}`);
    names.add(name);
    const bytes = await readFile(path);
    files.push({ name, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }

  return { schemaVersion: 1, bundleId, engineCommit, protocolVersion, createdAt, files };
}

export async function verifyEvidenceManifest(
  manifest: EvidenceManifest,
  filePaths: string[],
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  const byName = new Map(filePaths.map((path) => [basename(path), path]));

  for (const expected of manifest.files) {
    const path = byName.get(expected.name);
    if (!path) {
      errors.push(`missing evidence file: ${expected.name}`);
      continue;
    }
    const bytes = await readFile(path);
    if (bytes.byteLength !== expected.bytes) errors.push(`size mismatch: ${expected.name}`);
    if (sha256(bytes) !== expected.sha256) errors.push(`SHA-256 mismatch: ${expected.name}`);
    byName.delete(expected.name);
  }

  for (const unexpected of byName.keys()) errors.push(`unmanifested evidence file: ${unexpected}`);
  return { valid: errors.length === 0, errors };
}

export function canonicalManifestDigest(manifest: EvidenceManifest): string {
  const normalized = {
    ...manifest,
    files: [...manifest.files].sort((a, b) => a.name.localeCompare(b.name)),
  };
  return sha256(Buffer.from(JSON.stringify(normalized)));
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must be non-empty`);
}
