// ============================================================================
// Concurrency stress.
//
// Every integration suite in this repository runs one operation at a time. A
// clinic does not: several billers work cases while the nightly job ingests,
// while somebody in finance generates a bill. The failures that produce are
// invisible to a serial test — a ledger row claimed by two invoices, an
// invoice number issued twice, a detection run that double-counts a claim
// another run is still writing.
//
// This harness runs those operations against each other on purpose and then
// asks the invariants whether the money survived.
// ============================================================================

import type { PoolLike } from '../service.ts';
import type { Queryable } from '../db/snapshot.ts';
import type { UUID } from '../types.ts';
import { TenantContextPool } from '../db/tenant_pool.ts';
import { StageTimer, formatStageTable, type StageStats } from './metrics.ts';
import { checkInvariants, formatInvariantReport, type InvariantReport } from './invariants.ts';
import { generateBatches } from './synthetic_x12.ts';
import { harnessSession, resolveAdminUser } from './context.ts';

export interface ConcurrencyOptions {
  tenantId: UUID;
  clientId: UUID;
  adminUserId?: UUID;
  /** Defaults to a tenant_admin looked up in the database. */
  /** Simultaneous ingest workers. */
  ingestWorkers?: number;
  /** Files each ingest worker pushes. */
  filesPerWorker?: number;
  claimsPerFile?: number;
  /** Simultaneous detection runs. Two runs racing is the interesting case. */
  detectionWorkers?: number;
  /** Simultaneous attempts to generate an invoice for the SAME month. */
  invoiceWorkers?: number;
  /** The month every invoice worker contends over. */
  contendedMonth?: string;
  seed?: number;
}

export interface RaceOutcome {
  operation: string;
  attempts: number;
  succeeded: number;
  /** Failures that are the system correctly refusing a racing caller. */
  rejected: number;
  /** Failures that are not a recognised refusal — these are the interesting ones. */
  unexpected: { message: string; count: number }[];
}

export interface ConcurrencyReport {
  options: Required<Omit<ConcurrencyOptions, 'seed'>> & { seed: number };
  wallMs: number;
  stages: StageStats[];
  races: RaceOutcome[];
  invariants: InvariantReport;
  /** Distinct invoices that ended up holding the contended month. */
  contendedInvoices: number;
  clean: boolean;
}

/**
 * A refusal that means the platform defended itself. Anything else is a defect
 * or an unhandled error, and is reported as such rather than counted as a pass.
 */
const EXPECTED_REFUSALS = [
  /already been issued/i,
  /no longer a draft/i,
  /is already void/i,
  /could not allocate an invoice number/i,
  /was claimed by another invoice/i,
  /already exists for this period/i,
  /could not serialize/i,
  /deadlock detected/i,
  /duplicate key value violates unique constraint/i,
  /an invoice for .* already/i,
];

function classify(error: unknown): { expected: boolean; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return { expected: EXPECTED_REFUSALS.some((pattern) => pattern.test(message)), message };
}

async function race(
  operation: string, attempts: (() => Promise<unknown>)[],
): Promise<RaceOutcome> {
  const settled = await Promise.allSettled(attempts.map((attempt) => attempt()));
  const unexpected = new Map<string, number>();
  let succeeded = 0;
  let rejected = 0;

  for (const result of settled) {
    if (result.status === 'fulfilled') { succeeded += 1; continue; }
    const { expected, message } = classify(result.reason);
    if (expected) rejected += 1;
    else unexpected.set(message, (unexpected.get(message) ?? 0) + 1);
  }

  return {
    operation,
    attempts: attempts.length,
    succeeded,
    rejected,
    unexpected: [...unexpected].map(([message, count]) => ({ message, count })),
  };
}

export async function runConcurrency(
  rawPool: PoolLike, adminDb: Queryable, options: ConcurrencyOptions,
): Promise<ConcurrencyReport> {
  const {
    tenantId, clientId,
    ingestWorkers = 6, filesPerWorker = 3, claimsPerFile = 40,
    detectionWorkers = 3, invoiceWorkers = 5,
    contendedMonth = '2026-03', seed = 4242,
  } = options;
  const adminUserId = options.adminUserId ?? await resolveAdminUser(adminDb, tenantId);

  const timer = new StageTimer();
  const races: RaceOutcome[] = [];
  const tenantPool = rawPool instanceof TenantContextPool
    ? rawPool : new TenantContextPool(rawPool);
  const pool = tenantPool.forTenant(tenantId);

  const { ingest835Job, ingest837Job } = await import('../ingest/service.ts');
  const { runDetectionJob } = await import('../service.ts');
  const { generateInvoice, issueInvoice } = await import('../web/billing.ts');

  const session = harnessSession(adminUserId, tenantId, 'concurrency-harness') as any;
  const scope = { tenantId, clientIds: [clientId] } as any;

  const wallStart = performance.now();

  // --- concurrent ingest --------------------------------------------------
  // Each worker gets its own claim-number space, so a collision here would be
  // the platform's, not the fixture's.
  const workerBatches = Array.from({ length: ingestWorkers }, (_, worker) =>
    generateBatches(filesPerWorker, {
      seed: seed + worker * 1000,
      claimsPerBatch: claimsPerFile,
      claimPrefix: `CC${worker}`,
    }));

  races.push(await timer.time('concurrent_ingest_837', ingestWorkers * filesPerWorker, () =>
    race('concurrent ingest 837', workerBatches.flatMap((batches, worker) =>
      batches.map((batch, file) => () => ingest837Job(pool, {
        tenantId, clientId, content: batch.claimFile,
        fileName: `cc-837-w${worker}-f${file}.txt`,
      }))))));

  races.push(await timer.time('concurrent_ingest_835', ingestWorkers * filesPerWorker, () =>
    race('concurrent ingest 835', workerBatches.flatMap((batches, worker) =>
      batches.map((batch, file) => () => ingest835Job(pool, {
        tenantId, clientId, content: batch.remittanceFile,
        fileName: `cc-835-w${worker}-f${file}.txt`,
      }))))));

  // --- simultaneous detection runs ----------------------------------------
  // Two detection runs over the same unprocessed remittance lines must not
  // both create a case for the same line. The claim on match_method is what
  // has to hold.
  races.push(await timer.time('concurrent_detect', detectionWorkers, () =>
    race('concurrent detection', Array.from({ length: detectionWorkers }, () =>
      () => runDetectionJob(pool, { tenantId, clientId })))));

  // --- contended invoice generation ---------------------------------------
  // Several people pressing "generate" for the same month at once. Exactly one
  // invoice may end up holding that period's ledger rows.
  races.push(await timer.time('contended_invoice_generate', invoiceWorkers, () =>
    race('contended invoice generate', Array.from({ length: invoiceWorkers }, () =>
      () => generateInvoice(pool, session, scope, clientId, contendedMonth)))));

  const drafts = await adminDb.query(
    `SELECT invoice_id FROM invoice
      WHERE tenant_id = $1 AND client_id = $2
        AND period_start = $3 AND status <> 'void'`,
    [tenantId, clientId, `${contendedMonth}-01`]);

  // --- contended issue ----------------------------------------------------
  // Issuing the same draft from several sessions must produce one issued
  // invoice with one number, not several.
  if (drafts.rows.length > 0) {
    const invoiceId = drafts.rows[0].invoice_id;
    races.push(await timer.time('contended_invoice_issue', invoiceWorkers, () =>
      race('contended invoice issue', Array.from({ length: invoiceWorkers }, () =>
        () => issueInvoice(pool, session, scope, invoiceId)))));
  }

  const wallMs = Math.round(performance.now() - wallStart);
  const invariants = await checkInvariants(adminDb, tenantId);

  const unexpectedFailures = races.reduce((sum, r) => sum + r.unexpected.length, 0);

  return {
    options: {
      tenantId, clientId, adminUserId, ingestWorkers, filesPerWorker, claimsPerFile,
      detectionWorkers, invoiceWorkers, contendedMonth, seed,
    },
    wallMs,
    stages: timer.report(),
    races,
    invariants,
    contendedInvoices: drafts.rows.length,
    clean: invariants.clean && unexpectedFailures === 0 && drafts.rows.length <= 1,
  };
}

export function formatConcurrencyReport(report: ConcurrencyReport): string {
  const lines: string[] = ['# Concurrency run', ''];
  lines.push(`${report.options.ingestWorkers} ingest workers, `
    + `${report.options.detectionWorkers} detection runs, `
    + `${report.options.invoiceWorkers} invoice writers contending over `
    + `${report.options.contendedMonth}, in ${(report.wallMs / 1000).toFixed(1)}s`);
  lines.push('');
  lines.push('## Stage timings');
  lines.push('');
  lines.push(formatStageTable(report.stages));
  lines.push('');
  lines.push('## Races');
  lines.push('');
  lines.push('| operation | attempts | succeeded | refused | unexpected |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const outcome of report.races) {
    lines.push(`| ${outcome.operation} | ${outcome.attempts} | ${outcome.succeeded} `
      + `| ${outcome.rejected} | ${outcome.unexpected.length} |`);
  }
  const unexpected = report.races.flatMap((r) =>
    r.unexpected.map((u) => ({ operation: r.operation, ...u })));
  if (unexpected.length > 0) {
    lines.push('');
    lines.push('### Failures that are not a recognised refusal');
    lines.push('');
    for (const failure of unexpected) {
      lines.push(`- **${failure.operation}** x${failure.count}: ${failure.message}`);
    }
  }
  lines.push('');
  lines.push(`Invoices holding ${report.options.contendedMonth}: `
    + `${report.contendedInvoices} (more than one means the period was billed twice)`);
  lines.push('');
  lines.push('## Invariants');
  lines.push('');
  lines.push(formatInvariantReport(report.invariants));
  return lines.join('\n');
}
