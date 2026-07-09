// ============================================================================
// Manual trigger for the platform services. A scheduler calls the same
// service functions; this is the human path.
//
//   node src/cli.ts detect     --tenant <uuid> [--client <uuid>] [--as-of D] [--dry-run]
//   node src/cli.ts appeals    --tenant <uuid> [--client <uuid>] [--as-of D]
//   node src/cli.ts queue      --tenant <uuid> [--client <uuid>]
//   node src/cli.ts ingest-835 --tenant <uuid> --client <uuid> --file <path>
//   node src/cli.ts ingest-837 --tenant <uuid> --client <uuid> --file <path>
//
// DATABASE_URL selects the database (default postgres://localhost:5432/rcm_dev).
// ============================================================================

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const [command, ...rest] = process.argv.slice(2);
const COMMANDS = ['detect', 'appeals', 'queue', 'ingest-835', 'ingest-837',
  'schedule', 'nightly', 'monitor', 'reconcile', 'weekly'];

if (!command || !COMMANDS.includes(command)) {
  console.error(`usage: node src/cli.ts <${COMMANDS.join('|')}> --tenant <uuid> [options]`);
  process.exit(2);
}

const { values } = parseArgs({
  args: rest,
  options: {
    tenant: { type: 'string' },
    client: { type: 'string' },
    'as-of': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    file: { type: 'string' },
  },
});

if (!values.tenant && command !== 'schedule') {
  console.error(`${command}: --tenant <uuid> is required`);
  process.exit(2);
}

const { default: pg } = await import('pg');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/rcm_dev',
});

try {
  switch (command) {
    case 'detect': {
      const { runDetectionJob } = await import('./service.ts');
      const out = await runDetectionJob(pool, {
        tenantId: values.tenant,
        clientId: values.client,
        asOf: values['as-of'],
        dryRun: values['dry-run'],
      });
      const s = out.result.summary;
      console.log(JSON.stringify({ jobId: out.jobId, dryRun: out.dryRun, summary: s }, null, 2));
      console.error(
        `\n${out.dryRun ? '[dry run] ' : ''}processed ${s.remitLinesProcessed} remit lines: `
        + `${s.matched} matched, ${s.unmatched} unmatched | `
        + `${s.casesCreated} cases created, ${s.casesUpdated} updated, ${s.casesSkipped} skipped | `
        + `$${s.totalRecoveryOpportunity.toFixed(2)} recovery opportunity`,
      );
      break;
    }

    case 'appeals': {
      const { generateAppealPackets } = await import('./appeals/service.ts');
      const out = await generateAppealPackets(pool, {
        tenantId: values.tenant,
        clientId: values.client,
        asOf: values['as-of'],
      });
      console.log(JSON.stringify({ jobId: out.jobId, summary: out.summary, packets: out.packets }, null, 2));
      const s = out.summary;
      console.error(
        `\n${s.casesProcessed} cases processed | ${s.packetsCreated} packets created, `
        + `${s.packetsRefreshed} refreshed | ${s.ready} ready, ${s.draft} draft | `
        + `${s.autoSubmit} auto-submit, ${s.needsReview} need review | `
        + `${s.correctionsCreated} corrected claims`,
      );
      break;
    }

    case 'queue': {
      const { loadSubmissionQueue } = await import('./appeals/queue.ts');
      const items = await loadSubmissionQueue(pool, {
        tenantId: values.tenant, clientId: values.client,
      });
      console.log(JSON.stringify(items, null, 2));
      console.error(`\n${items.length} packet(s) ready for submission`);
      break;
    }

    case 'ingest-835':
    case 'ingest-837': {
      if (!values.client || !values.file) {
        console.error(`${command}: --client <uuid> and --file <path> are required`);
        process.exit(2);
      }
      const content = await readFile(values.file, 'utf8');
      const { ingest835Job, ingest837Job } = await import('./ingest/service.ts');
      const run = command === 'ingest-835' ? ingest835Job : ingest837Job;
      const out = await run(pool, {
        tenantId: values.tenant,
        clientId: values.client,
        content,
        fileName: path.basename(values.file),
      });
      console.log(JSON.stringify(out, null, 2));
      console.error(
        `\n${out.recordsProcessed} record(s) loaded, ${out.skipped} skipped`
        + (out.warnings.length ? ` | warnings: ${out.warnings.join(' | ')}` : ''),
      );
      break;
    }

    case 'schedule': {
      // long-running: tick once a minute until killed
      const { startScheduler } = await import('./automation/scheduler.ts');
      const handle = startScheduler(pool);
      console.error('scheduler running — ctrl-c to stop');
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => { handle.stop(); resolve(); });
        process.on('SIGTERM', () => { handle.stop(); resolve(); });
      });
      break;
    }

    case 'nightly': {
      if (!values.client) { console.error('nightly: --client required'); process.exit(2); }
      const { runNightlyProcessing } = await import('./automation/jobs.ts');
      const out = await runNightlyProcessing(pool, {
        tenantId: values.tenant, clientId: values.client, asOf: values['as-of'],
      });
      console.log(JSON.stringify(out, null, 2));
      break;
    }

    case 'monitor': {
      const { runDeadlineMonitor } = await import('./automation/jobs.ts');
      const out = await runDeadlineMonitor(pool, {
        tenantId: values.tenant, clientId: values.client, asOf: values['as-of'],
      });
      console.log(JSON.stringify(out, null, 2));
      break;
    }

    case 'reconcile': {
      const { runPaymentReconciliation } = await import('./automation/jobs.ts');
      const out = await runPaymentReconciliation(pool, {
        tenantId: values.tenant, clientId: values.client,
      });
      console.log(JSON.stringify(out, null, 2));
      break;
    }

    case 'weekly': {
      if (!values.client) { console.error('weekly: --client required'); process.exit(2); }
      const { runWeeklySummary } = await import('./automation/jobs.ts');
      const out = await runWeeklySummary(pool, {
        tenantId: values.tenant, clientId: values.client, asOf: values['as-of'],
      });
      console.log(JSON.stringify(out, null, 2));
      break;
    }
  }
} finally {
  await pool.end();
}
