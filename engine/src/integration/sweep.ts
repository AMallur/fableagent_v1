// ============================================================================
// SFTP-drop folder sweep (METHOD 1).
//
// Each client gets a drop folder (client.ingest_folder, provisioned as
// var/ingest/<client_id> when unset). The scheduler sweeps every tick:
//   * new 835/837/CSV files are detected by extension/content and ingested
//   * success -> file moves to processed/<date>-<name>
//   * failure -> file moves to errors/<name> with errors/<name>.log holding
//     the parse/load error; the failed system_job row carries it too
//
// The SFTP server itself (sshd/proftpd chrooted to the drop folder, or a
// managed transfer service) is deployment infrastructure — this module owns
// everything from "file appears in the folder" onward.
// ============================================================================

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { UUID } from '../types.ts';
import type { PoolLike } from '../service.ts';
import { detectFileKind, ingestFileByKind } from '../ingest/service.ts';
import { TenantContextPool } from '../db/tenant_pool.ts';

const INGESTIBLE = /\.(835|837|era|csv)$/i;

export interface SweepFileOutcome {
  fileName: string;
  status: 'ingested' | 'failed';
  records?: number;
  error?: string;
}

export interface SweepResult {
  clientId: UUID;
  folder: string;
  files: SweepFileOutcome[];
}

/** default drop folder when the client has none configured */
export function defaultIngestFolder(clientId: UUID): string {
  return path.join(process.cwd(), 'var', 'ingest', clientId);
}

export async function provisionIngestFolder(
  pool: PoolLike, tenantId: UUID, clientId: UUID,
): Promise<string> {
  const row = await pool.query(
    `SELECT ingest_folder FROM client WHERE client_id = $1 AND tenant_id = $2`,
    [clientId, tenantId]);
  const folder = row.rows[0]?.ingest_folder ?? defaultIngestFolder(clientId);
  await mkdir(path.join(folder, 'processed'), { recursive: true });
  await mkdir(path.join(folder, 'errors'), { recursive: true });
  if (!row.rows[0]?.ingest_folder) {
    await pool.query(
      `UPDATE client SET ingest_folder = $3 WHERE client_id = $1 AND tenant_id = $2`,
      [clientId, tenantId, folder]);
  }
  return folder;
}

export async function sweepClientFolder(
  pool: PoolLike, args: { tenantId: UUID; clientId: UUID },
): Promise<SweepResult> {
  const folder = await provisionIngestFolder(pool, args.tenantId, args.clientId);
  const outcomes: SweepFileOutcome[] = [];
  const stamp = new Date().toISOString().slice(0, 10);

  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !INGESTIBLE.test(entry.name)) continue;
    const full = path.join(folder, entry.name);
    const claimed = path.join(folder, `.processing-${randomUUID()}-${entry.name}`);
    try {
      await rename(full, claimed); // atomic claim; another worker cannot process it
      const content = await readFile(claimed, 'utf8');
      if (detectFileKind(entry.name, content) === 'unknown') {
        throw new Error('unrecognized file content — expected 835, 837, or CSV');
      }
      const out = await ingestFileByKind(pool, {
        tenantId: args.tenantId, clientId: args.clientId, content, fileName: entry.name,
      });
      await rename(claimed, path.join(folder, 'processed', `${stamp}-${randomUUID()}-${entry.name}`));
      outcomes.push({ fileName: entry.name, status: 'ingested', records: out.recordsProcessed });
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      await rename(claimed, path.join(folder, 'errors', `${randomUUID()}-${entry.name}`)).catch(() => {});
      await writeFile(
        path.join(folder, 'errors', `${entry.name}.log`),
        `file: ${entry.name}\nfailed at: ${new Date().toISOString()}\n\n${message}\n`,
      ).catch(() => {});
      outcomes.push({
        fileName: entry.name, status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { clientId: args.clientId, folder, files: outcomes };
}

/** sweep every active client; one client's failure never blocks the rest */
export async function sweepAllFolders(
  pool: PoolLike, log: (msg: string) => void = () => {},
): Promise<SweepResult[]> {
  const scoped = pool instanceof TenantContextPool ? pool : new TenantContextPool(pool);
  const clients = await scoped.query(
    `SELECT client_id, tenant_id, client_name FROM app.list_active_clients()`);
  const results: SweepResult[] = [];
  for (const c of clients.rows) {
    try {
      const result = await scoped.runAsTenant(c.tenant_id, () => sweepClientFolder(scoped, {
        tenantId: c.tenant_id, clientId: c.client_id,
      }));
      if (result.files.length > 0) {
        log(`ingest sweep ${c.client_name}: `
          + result.files.map((f) => `${f.fileName}=${f.status}`).join(', '));
      }
      results.push(result);
    } catch (err) {
      log(`ingest sweep ERROR ${c.client_name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return results;
}
