// Pre-pilot load run. See docs/PRE_PILOT_QUALIFICATION.md.
//
//   node scripts/run_load_test.ts --tenant <uuid> --client <uuid> \
//     [--batches 20] [--claims-per-batch 100] [--seed 1] [--skip-appeals]
//
// DATABASE_URL drives the pipeline; ADMIN_DATABASE_URL (falling back to
// DATABASE_URL) is used for the invariant checks and pg_stat_statements, which
// need to see across tenants and into the statistics views.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    client: { type: 'string' },
    batches: { type: 'string', default: '20' },
    'claims-per-batch': { type: 'string', default: '100' },
    seed: { type: 'string', default: '1' },
    'skip-appeals': { type: 'boolean', default: false },
    'skip-billing': { type: 'boolean', default: false },
    'output-dir': { type: 'string' },
  },
});

if (!values.tenant || !values.client) {
  console.error('usage: run_load_test.ts --tenant <uuid> --client <uuid> '
    + '[--batches N] [--claims-per-batch N] [--seed N] [--skip-appeals] [--skip-billing]');
  process.exit(2);
}

const { default: pg } = await import('pg');
const { pgSslConfig } = await import('../src/web/db_ssl.ts');
const { databaseConnectionString, hardenPool } = await import('../src/db/connection.ts');
const { TenantContextPool } = await import('../src/db/tenant_pool.ts');
const { runLoad, formatLoadReport } = await import('../src/qualification/load.ts');

const ssl = pgSslConfig(readFileSync);
const pool = hardenPool(new pg.Pool({ connectionString: databaseConnectionString(), ssl, max: 10 }));
const adminPool = hardenPool(new pg.Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? databaseConnectionString(),
  ssl, max: 4,
}));

const outputDirectory = path.resolve(
  values['output-dir'] ?? process.env.LOAD_OUTPUT_DIR ?? 'var/qualification/load');

try {
  const report = await runLoad(new TenantContextPool(pool), adminPool as any, {
    tenantId: values.tenant,
    clientId: values.client,
    batches: Number(values.batches),
    claimsPerBatch: Number(values['claims-per-batch']),
    seed: Number(values.seed),
    skipAppeals: values['skip-appeals'],
    skipBilling: values['skip-billing'],
    onProgress: (done, total, stage) => {
      if (done === total || done % 10 === 0) {
        process.stderr.write(`  ${stage}: ${done}/${total}\n`);
      }
    },
  });

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, 'load.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(outputDirectory, 'load.md'), `${formatLoadReport(report)}\n`),
  ]);

  console.log(formatLoadReport(report));

  // A load run that corrupted the money is a failure however fast it was.
  if (!report.invariants.clean) {
    console.error('\nFAILED: a critical invariant was violated');
    process.exitCode = 1;
  } else if (report.errors.length > 0) {
    console.error(`\nFAILED: ${report.errors.length} stage(s) errored`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
  await adminPool.end();
}
