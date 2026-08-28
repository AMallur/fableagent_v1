// Disaster recovery exercise. See docs/PRE_PILOT_QUALIFICATION.md.
//
//   node scripts/run_dr_exercise.ts --tenant <uuid> --client <uuid>
//
// Takes a real backup, DESTROYS the database, restores it, and then checks
// whether the money came back — row counts, money totals, three content
// digests, the evidence-pack hash a customer can recompute, and every
// financial invariant.
//
// This drops and recreates the database named in ADMIN_DATABASE_URL. It
// refuses to run unless that database name looks like a test database or
// --i-know-this-destroys-the-database is passed, because the one thing worse
// than never testing a restore is testing it on production.
import { mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { parseArgs } from 'node:util';

const run = promisify(execFile);

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    client: { type: 'string' },
    'output-dir': { type: 'string' },
    'i-know-this-destroys-the-database': { type: 'boolean', default: false },
  },
});

if (!values.tenant || !values.client) {
  console.error('usage: run_dr_exercise.ts --tenant <uuid> --client <uuid>');
  process.exit(2);
}

const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!adminUrl) {
  console.error('ADMIN_DATABASE_URL is required: the exercise needs a role that can '
    + 'drop and create the database');
  process.exit(2);
}

const parsed = new URL(adminUrl);
const databaseName = parsed.pathname.replace(/^\//, '');
const looksDisposable = /(^|[_-])(test|ci|local|dev|rcm)$/.test(databaseName);
if (!looksDisposable && !values['i-know-this-destroys-the-database']) {
  console.error(`refusing to destroy database "${databaseName}": its name does not look `
    + 'like a disposable one. Pass --i-know-this-destroys-the-database to override.');
  process.exit(2);
}

const maintenanceUrl = new URL(adminUrl);
maintenanceUrl.pathname = '/postgres';

const outputDirectory = path.resolve(values['output-dir'] ?? 'var/qualification/dr');
const dumpPath = path.join(outputDirectory, `${databaseName}.dump`);
await mkdir(outputDirectory, { recursive: true });

const { default: pg } = await import('pg');
const { hardenPool } = await import('../src/db/connection.ts');
const { fingerprint, verifyRestore, formatRecoveryReport } =
  await import('../src/qualification/recovery.ts');

// The pack's audit section is bounded by this window. It deliberately ends
// before today so that the audit rows this exercise itself writes — exporting
// a pack is an audited action — fall outside both the before and after packs.
// Without that, the post-restore pack contains the pre-backup export and the
// two hashes can never agree, which would look like a failed restore.
const EVIDENCE_FROM = '2000-01-01';
const EVIDENCE_TO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Build the evidence pack a customer would be given, and hash it. */
async function evidenceHash(db: any): Promise<string | null> {
  try {
    const { buildEvidencePack, evidencePackHash } = await import('../src/web/statement.ts');
    const { resolveAdminUser, harnessSession } = await import('../src/qualification/context.ts');
    const userId = await resolveAdminUser(db, values.tenant!);
    const pack = await buildEvidencePack(
      db,
      harnessSession(userId, values.tenant!, 'dr-exercise') as any,
      { tenantId: values.tenant!, clientIds: [values.client!] } as any,
      values.client!,
      EVIDENCE_FROM, EVIDENCE_TO,
    );
    return evidencePackHash(pack as Record<string, unknown>);
  } catch (error) {
    console.error(`  evidence pack unavailable: ${(error as Error).message}`);
    return null;
  }
}

let report;
{
  // ---- capture the state we expect to get back ---------------------------
  const before = hardenPool(new pg.Pool({ connectionString: adminUrl }));
  console.error('==> exporting evidence, then fingerprinting the live database');
  // Evidence first, fingerprint second, and the same order after the restore:
  // the export writes an audit row, so the fingerprint has to be taken with
  // that row already present on both sides.
  const evidenceBefore = await evidenceHash(before);
  const beforePrint = await fingerprint(before as any, values.tenant);
  await before.end();

  // ---- back it up --------------------------------------------------------
  console.error('==> pg_dump');
  await rm(dumpPath, { force: true });
  const backupStart = performance.now();
  await run('pg_dump', ['--format=custom', '--file', dumpPath, adminUrl], {
    maxBuffer: 1024 * 1024 * 64,
  });
  const backupMs = Math.round(performance.now() - backupStart);
  const backupBytes = (await stat(dumpPath)).size;

  // ---- destroy it --------------------------------------------------------
  // A restore onto a database that still exists proves much less: it can be
  // satisfied by the rows that were never lost. Dropping it is the point.
  console.error(`==> DROP DATABASE ${databaseName}`);
  const maintenance = hardenPool(new pg.Pool({ connectionString: maintenanceUrl.toString() }));
  const restoreStart = performance.now();
  await maintenance.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await maintenance.query(`CREATE DATABASE ${databaseName}`);
  await maintenance.end();

  // ---- restore -----------------------------------------------------------
  console.error('==> pg_restore');
  try {
    await run('pg_restore', ['--dbname', adminUrl, '--no-owner', '--jobs', '4', dumpPath], {
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch (error) {
    // pg_restore exits non-zero on warnings as well as on failures. Whether
    // the restore actually worked is settled by the fingerprint below, not by
    // this exit code, so record it and carry on to the real check.
    console.error(`  pg_restore reported: ${(error as Error).message.split('\n')[0]}`);
  }

  const after = hardenPool(new pg.Pool({ connectionString: adminUrl }));
  const restoreMs = Math.round(performance.now() - restoreStart);
  console.error('==> verifying');
  // Fingerprint the restored database BEFORE exporting from it, so the
  // comparison is against what the backup held rather than against what
  // measuring it added.
  const afterPrint = await fingerprint(after as any, values.tenant);
  const evidenceAfter = await evidenceHash(after);
  report = await verifyRestore(
    after as any, values.tenant, beforePrint, afterPrint,
    { backupMs, restoreMs, backupBytes },
    evidenceBefore, evidenceAfter,
  );
  await after.end();
}

await Promise.all([
  writeFile(path.join(outputDirectory, 'dr.json'), `${JSON.stringify(report, null, 2)}\n`),
  writeFile(path.join(outputDirectory, 'dr.md'), `${formatRecoveryReport(report)}\n`),
]);

console.log(formatRecoveryReport(report));
if (!report.recovered) {
  console.error('\nFAILED: the restore did not reproduce the pre-failure state');
  process.exitCode = 1;
}
