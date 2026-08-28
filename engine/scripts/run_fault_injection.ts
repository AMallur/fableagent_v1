// Pre-pilot failure injection. See docs/PRE_PILOT_QUALIFICATION.md.
//
//   node scripts/run_fault_injection.ts --tenant <uuid> --client <uuid>
//
// Needs ADMIN_DATABASE_URL to hold a role that may call
// pg_terminate_backend(); killing a backend is the point of the exercise.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    client: { type: 'string' },
    seed: { type: 'string', default: '8080' },
    'output-dir': { type: 'string' },
  },
});

if (!values.tenant || !values.client) {
  console.error('usage: run_fault_injection.ts --tenant <uuid> --client <uuid>');
  process.exit(2);
}

const { default: pg } = await import('pg');
const { pgSslConfig } = await import('../src/web/db_ssl.ts');
const { databaseConnectionString, hardenPool } = await import('../src/db/connection.ts');
const { TenantContextPool } = await import('../src/db/tenant_pool.ts');
const { runFaults, formatFaultReport } = await import('../src/qualification/faults.ts');

const ssl = pgSslConfig(readFileSync);
const pool = hardenPool(new pg.Pool({ connectionString: databaseConnectionString(), ssl, max: 10 }));
const adminPool = hardenPool(new pg.Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? databaseConnectionString(), ssl, max: 4,
}));

const outputDirectory = path.resolve(values['output-dir'] ?? 'var/qualification/faults');

try {
  const report = await runFaults(new TenantContextPool(pool), {
    tenantId: values.tenant,
    clientId: values.client,
    adminDb: adminPool as any,
    seed: Number(values.seed),
  });

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, 'faults.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(outputDirectory, 'faults.md'), `${formatFaultReport(report)}\n`),
  ]);

  console.log(formatFaultReport(report));
  if (!report.passed) {
    console.error('\nFAILED: an injected fault left the data inconsistent');
    process.exitCode = 1;
  }
} finally {
  await pool.end().catch(() => {});
  await adminPool.end().catch(() => {});
}
