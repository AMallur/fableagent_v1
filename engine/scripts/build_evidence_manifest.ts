import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  buildEvidenceManifest,
  canonicalManifestDigest,
} from '../src/pilot/evidence_manifest.ts';

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const bundleId = arg('--bundle-id');
const engineCommit = arg('--engine-commit');
const protocolVersion = arg('--protocol-version');
const output = arg('--output') ?? 'evidence-manifest.json';
const separator = process.argv.indexOf('--files');
const filePaths = separator >= 0 ? process.argv.slice(separator + 1) : [];

if (!bundleId || !engineCommit || !protocolVersion || filePaths.length === 0) {
  console.error(
    'Usage: node scripts/build_evidence_manifest.ts '
      + '--bundle-id <id> --engine-commit <sha> --protocol-version <version> '
      + '[--output evidence-manifest.json] --files <file> [file ...]',
  );
  process.exit(2);
}

const manifest = await buildEvidenceManifest(
  bundleId,
  engineCommit,
  protocolVersion,
  filePaths.map(resolve),
);
const manifestSha256 = canonicalManifestDigest(manifest);
await writeFile(resolve(output), `${JSON.stringify({ manifestSha256, manifest }, null, 2)}\n`);
console.log(`Evidence manifest written: ${resolve(output)}`);
console.log(`Manifest SHA-256: ${manifestSha256}`);
