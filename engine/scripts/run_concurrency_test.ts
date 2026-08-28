// Pre-pilot concurrency stress. See docs/PRE_PILOT_QUALIFICATION.md.
//
//   node scripts/run_concurrency_test.ts --tenant <uuid> --client <uuid> \
//     [--ingest-workers 6] [--invoice-workers 5] [--month 2026-03]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    client: { type: 'string' },
    'ingest-workers': { type: 'string', default: '6' },
    'files-per-worker': { type: 'string', default: '3' },
    'claims-per-file': { type: 'string', default: '40' },
    'detection-workers': { type: 'string', default: '3' },
    'invoice-workers': { type: 'string', default: '5' },
    month: { type: 'string', default: '2026-03' },
    seed: { type: 'string', default: '4242' },
    'output-dir': { type: 'string' },
  },
});

if (!values.tenant || !values.client) {
  console.error('usage: run_concurrency_test.ts --tenant <uuid> --client <uuid> [options]');
  process.exit(2);
}

const { default: pg } = await import('pg');
const { pgSslConfig } = await import('../src/web/db_ssl.ts');
const { databaseConnectionString, hardenPool } = await import('../src/db/connection.ts');
const { TenantContextPool } = await import('../src/db/tenant_pool.ts');
const { runConcurrency, formatConcurrencyReport } =
  await import('../src/qualification/concurrency.ts');

const ssl = pgSslConfig(readFileSync);
// The pool must be wide enough for every worker to hold a connection at once,
// or the harness measures pool starvation instead of database contention.
const pool = hardenPool(new pg.Pool({ connectionString: databaseConnectionString(), ssl, max: 40 }));
const adminPool = hardenPool(new pg.Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? databaseConnectionString(), ssl, max: 4,
}));

const outputDirectory = path.resolve(
  values['output-dir'] ?? 'var/qualification/concurrency');

try {
  const report = await runConcurrency(new TenantContextPool(pool), adminPool as any, {
    tenantId: values.tenant,
    clientId: values.client,
    ingestWorkers: Number(values['ingest-workers']),
    filesPerWorker: Number(values['files-per-worker']),
    claimsPerFile: Number(values['claims-per-file']),
    detectionWorkers: Number(values['detection-workers']),
    invoiceWorkers: Number(values['invoice-workers']),
    contendedMonth: values.month,
    seed: Number(values.seed),
  });

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, 'concurrency.json'),
      `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(outputDirectory, 'concurrency.md'),
      `${formatConcurrencyReport(report)}\n`),
  ]);

  console.log(formatConcurrencyReport(report));
  if (!report.clean) {
    console.error('\nFAILED: concurrency produced an unexpected failure or violated an invariant');
    process.exitCode = 1;
  }
} finally {
  await pool.end();
  await adminPool.end();
}
