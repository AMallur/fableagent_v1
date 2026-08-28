// ============================================================================
// Volume load harness.
//
// Drives the real pipeline — ingest 837, ingest 835, detect, build appeal
// packets, price an invoice — against a real database at a configurable
// volume, timing every stage and checking the financial invariants at the end.
//
// The point is not to produce a throughput number to put on a slide. It is to
// answer three questions a first deployment will otherwise answer in front of
// a customer: which stage degrades first, does anything degrade
// super-linearly, and does the money still add up afterwards.
// ============================================================================

import type { PoolLike } from '../service.ts';
import type { Queryable } from '../db/snapshot.ts';
import type { UUID } from '../types.ts';
import { TenantContextPool } from '../db/tenant_pool.ts';
import { StageTimer, formatStageTable, type StageStats } from './metrics.ts';
import { checkInvariants, formatInvariantReport, type InvariantReport } from './invariants.ts';
import { generateBatches, type GeneratorOptions } from './synthetic_x12.ts';
import { harnessSession, resolveAdminUser } from './context.ts';

export interface LoadOptions {
  tenantId: UUID;
  clientId: UUID;
  /** Number of paired 837/835 files to push through. */
  batches: number;
  /** Claims in each file. batches x claimsPerBatch is the total claim count. */
  claimsPerBatch: number;
  seed?: number;
  /** Skip appeal packet generation, which writes documents and is slow. */
  skipAppeals?: boolean;
  /** Skip invoicing, for a run that only measures the detection pipeline. */
  skipBilling?: boolean;
  /** A tenant-admin user id. Defaults to one looked up in the database. */
  adminUserId?: UUID;
  /** Months (YYYY-MM) to price. Defaults to the span the generator covers. */
  billingMonths?: string[];
  generator?: Omit<GeneratorOptions, 'seed' | 'claimsPerBatch'>;
  /** Called after each batch so a long run reports progress rather than hanging. */
  onProgress?: (completed: number, total: number, stage: string) => void;
}

export interface SlowQuery {
  calls: number;
  totalMs: number;
  meanMs: number;
  maxMs: number;
  rows: number;
  query: string;
}

export interface LoadReport {
  options: Omit<LoadOptions, 'onProgress' | 'generator'>;
  totalClaims: number;
  totalLines: number;
  wallMs: number;
  stages: StageStats[];
  invariants: InvariantReport;
  slowQueries: SlowQuery[];
  /** Row counts after the run, to confirm work actually landed. */
  counts: Record<string, number>;
  detection: { casesCreated: number; casesUpdated: number; recoveryOpportunity: number };
  errors: { stage: string; message: string }[];
}

/**
 * Reset pg_stat_statements so the slow-query list describes this run only.
 * Absent the extension the run still works; it just cannot attribute time to
 * individual statements.
 */
async function resetStatements(db: Queryable): Promise<boolean> {
  try {
    await db.query('SELECT pg_stat_statements_reset()');
    return true;
  } catch {
    return false;
  }
}

async function topStatements(db: Queryable, limit: number): Promise<SlowQuery[]> {
  try {
    const result = await db.query(
      `SELECT calls, total_exec_time, mean_exec_time, max_exec_time, rows, query
         FROM pg_stat_statements
        WHERE query NOT LIKE '%pg_stat_statements%'
        ORDER BY total_exec_time DESC
        LIMIT $1`, [limit]);
    return result.rows.map((row: any) => ({
      calls: Number(row.calls),
      totalMs: Math.round(Number(row.total_exec_time) * 100) / 100,
      meanMs: Math.round(Number(row.mean_exec_time) * 1000) / 1000,
      maxMs: Math.round(Number(row.max_exec_time) * 1000) / 1000,
      rows: Number(row.rows),
      query: String(row.query).replace(/\s+/g, ' ').slice(0, 300),
    }));
  } catch {
    return [];
  }
}

async function tableCounts(db: Queryable, tenantId: UUID): Promise<Record<string, number>> {
  const tables = ['claim', 'claim_line', 'remittance', 'remittance_line',
    'recovery_case', 'appeal_packet', 'payment_event', 'usage_event', 'invoice'];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await db.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    counts[table] = result.rows[0].n;
  }
  return counts;
}

export async function runLoad(
  rawPool: PoolLike, adminDb: Queryable, options: LoadOptions,
): Promise<LoadReport> {
  const {
    tenantId, clientId, batches, claimsPerBatch,
    seed = 1, skipAppeals = false, skipBilling = false, onProgress,
    billingMonths = ['2026-01', '2026-02', '2026-03'],
  } = options;
  const adminUserId = options.adminUserId ?? await resolveAdminUser(adminDb, tenantId);

  const timer = new StageTimer();
  const errors: LoadReport['errors'] = [];
  const tenantPool = rawPool instanceof TenantContextPool
    ? rawPool : new TenantContextPool(rawPool);
  const pool = tenantPool.forTenant(tenantId);

  const generated = await timer.time('generate', batches * claimsPerBatch, async () =>
    generateBatches(batches, { ...options.generator, seed, claimsPerBatch }));

  const totalClaims = generated.reduce((sum, batch) => sum + batch.claims.length, 0);
  const totalLines = generated.reduce(
    (sum, batch) => sum + batch.claims.reduce((n, claim) => n + claim.lines.length, 0), 0);

  const hasStatements = await resetStatements(adminDb);
  const wallStart = performance.now();

  const { ingest835Job, ingest837Job } = await import('../ingest/service.ts');

  // --- ingest -------------------------------------------------------------
  // 837 first for every batch, then 835 for every batch. Loading all the
  // claims before any remittance is what a real month looks like, and it is
  // also the harder case for matching: the 835 arrives against a claim table
  // that is already large.
  for (const [index, batch] of generated.entries()) {
    await runStage(timer, errors, 'ingest_837', batch.claims.length, async () => {
      await ingest837Job(pool, {
        tenantId, clientId, content: batch.claimFile,
        fileName: `synthetic-837-${index}.txt`,
      });
    });
    onProgress?.(index + 1, generated.length, 'ingest_837');
  }

  for (const [index, batch] of generated.entries()) {
    await runStage(timer, errors, 'ingest_835', batch.claims.length, async () => {
      await ingest835Job(pool, {
        tenantId, clientId, content: batch.remittanceFile,
        fileName: `synthetic-835-${index}.txt`,
      });
    });
    onProgress?.(index + 1, generated.length, 'ingest_835');
  }

  // --- detect -------------------------------------------------------------
  const { runDetectionJob } = await import('../service.ts');
  let detection = { casesCreated: 0, casesUpdated: 0, recoveryOpportunity: 0 };
  await runStage(timer, errors, 'detect', totalLines, async () => {
    const out = await runDetectionJob(pool, { tenantId, clientId });
    detection = {
      casesCreated: out.result.summary.casesCreated,
      casesUpdated: out.result.summary.casesUpdated,
      recoveryOpportunity: out.result.summary.totalRecoveryOpportunity,
    };
  });
  onProgress?.(1, 1, 'detect');

  // --- appeals ------------------------------------------------------------
  if (!skipAppeals) {
    const { generateAppealPackets } = await import('../appeals/service.ts');
    const { resolveDocumentStore } = await import('../appeals/storage.ts');
    const store = await resolveDocumentStore();
    await runStage(timer, errors, 'appeals', detection.casesCreated, async () => {
      await generateAppealPackets(pool, { tenantId, clientId, store });
    });
    onProgress?.(1, 1, 'appeals');
  }

  // --- billing ------------------------------------------------------------
  if (!skipBilling) {
    const { previewInvoice } = await import('../web/billing.ts');
    // The billing surface is an HTTP handler, so it takes a session and a
    // scope rather than raw ids. Pricing a month is the read-heavy half of
    // invoicing and the part that scales with the ledger, which is what this
    // stage is here to measure.
    const session = harnessSession(adminUserId, tenantId, 'load-harness') as any;
    const scope = { tenantId, clientIds: [clientId] } as any;
    for (const month of billingMonths) {
      await runStage(timer, errors, 'invoice_preview', 1, async () => {
        await previewInvoice(pool, session, scope, clientId, month);
      });
    }
    onProgress?.(1, 1, 'invoice_preview');
  }

  const wallMs = Math.round(performance.now() - wallStart);

  const [invariants, slowQueries, counts] = await Promise.all([
    checkInvariants(adminDb, tenantId),
    hasStatements ? topStatements(adminDb, 15) : Promise.resolve([]),
    tableCounts(adminDb, tenantId),
  ]);

  return {
    options: {
      tenantId, clientId, batches, claimsPerBatch, seed,
      skipAppeals, skipBilling, adminUserId, billingMonths,
    },
    totalClaims, totalLines, wallMs,
    stages: timer.report(),
    invariants, slowQueries, counts, detection, errors,
  };
}

/**
 * Run one stage, recording a failure rather than aborting the run. A load test
 * that stops at the first error measures nothing beyond that point, and the
 * interesting failures are often downstream of a survivable one.
 */
async function runStage(
  timer: StageTimer, errors: LoadReport['errors'],
  stage: string, units: number, work: () => Promise<void>,
): Promise<void> {
  try {
    await timer.time(stage, units, work);
  } catch (error) {
    errors.push({ stage, message: error instanceof Error ? error.message : String(error) });
  }
}

export function formatLoadReport(report: LoadReport): string {
  const lines: string[] = [];
  lines.push('# Load run');
  lines.push('');
  lines.push(`${report.totalClaims} claims / ${report.totalLines} service lines across `
    + `${report.options.batches} file pair(s) in ${(report.wallMs / 1000).toFixed(1)}s`);
  lines.push('');
  lines.push('## Stage timings');
  lines.push('');
  lines.push(formatStageTable(report.stages));
  lines.push('');
  lines.push('## Detection');
  lines.push('');
  lines.push(`cases created ${report.detection.casesCreated}, updated `
    + `${report.detection.casesUpdated}, recovery opportunity `
    + `$${report.detection.recoveryOpportunity.toFixed(2)}`);
  lines.push('');
  lines.push('## Rows after the run');
  lines.push('');
  lines.push(Object.entries(report.counts).map(([k, v]) => `${k}=${v}`).join('  '));
  lines.push('');
  lines.push('## Invariants');
  lines.push('');
  lines.push(formatInvariantReport(report.invariants));

  if (report.errors.length > 0) {
    lines.push('');
    lines.push('## Stage failures');
    lines.push('');
    for (const error of report.errors) lines.push(`- ${error.stage}: ${error.message}`);
  }

  if (report.slowQueries.length > 0) {
    lines.push('');
    lines.push('## Where the database spent its time');
    lines.push('');
    lines.push('| total ms | calls | mean ms | max ms | query |');
    lines.push('|---:|---:|---:|---:|---|');
    for (const query of report.slowQueries) {
      lines.push(`| ${query.totalMs.toFixed(0)} | ${query.calls} | ${query.meanMs.toFixed(2)} `
        + `| ${query.maxMs.toFixed(1)} | \`${query.query.slice(0, 160)}\` |`);
    }
  }

  return lines.join('\n');
}
