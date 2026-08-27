// ============================================================================
// Manual trigger for the platform services. A scheduler calls the same
// service functions; this is the human path.
//
//   node src/cli.ts detect        --tenant <uuid> [--client <uuid>] [--as-of D] [--dry-run]
//   node src/cli.ts appeals       --tenant <uuid> [--client <uuid>] [--as-of D]
//   node src/cli.ts queue         --tenant <uuid> [--client <uuid>]
//   node src/cli.ts reconcile-deliveries --tenant <uuid> [--client <uuid>]
//   node src/cli.ts ingest-835    --tenant <uuid> --client <uuid> --file <path>
//   node src/cli.ts ingest-837    --tenant <uuid> --client <uuid> --file <path>
//   node src/cli.ts reference-import --kind <kind> --version <version> --file <path>
//                  --source-url <official URL> [--scope <scope>] [--service-setting <setting>]
//   node src/cli.ts create-tenant --name <name> --type <provider_group|billing_company|health_system>
//                                 --admin-email <email> [--admin-first <name>] [--admin-last <name>]
//
// DATABASE_URL selects the database (default postgres://localhost:5432/rcm_dev).
// ============================================================================

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const [command, ...rest] = process.argv.slice(2);
const COMMANDS = ['detect', 'appeals', 'queue', 'ingest-835', 'ingest-837',
  'schedule', 'nightly', 'monitor', 'reconcile', 'reconcile-deliveries', 'weekly',
  'sftp-server', 'create-tenant', 'reference-import', 'preflight'];

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
    name: { type: 'string' },
    type: { type: 'string' },
    'admin-email': { type: 'string' },
    'admin-first': { type: 'string' },
    'admin-last': { type: 'string' },
    kind: { type: 'string' },
    version: { type: 'string' },
    scope: { type: 'string' },
    'source-url': { type: 'string' },
    'effective-date': { type: 'string' },
    'service-setting': { type: 'string' },
  },
});

const NO_TENANT_REQUIRED = new Set(['schedule', 'sftp-server', 'create-tenant', 'reference-import']);
if (!values.tenant && !NO_TENANT_REQUIRED.has(command)) {
  console.error(`${command}: --tenant <uuid> is required`);
  process.exit(2);
}

const { default: pg } = await import('pg');
const { pgSslConfig } = await import('./web/db_ssl.ts');
const { readFileSync } = await import('node:fs');
const { databaseConnectionString } = await import('./db/connection.ts');
const pool = new pg.Pool({
  connectionString: databaseConnectionString(),
  ssl: pgSslConfig(readFileSync),
});
const { TenantContextPool } = await import('./db/tenant_pool.ts');
const tenantPool = new TenantContextPool(pool);
const runtimePool = values.tenant ? tenantPool.forTenant(values.tenant) : tenantPool;

try {
  switch (command) {
    case 'detect': {
      const { runDetectionJob } = await import('./service.ts');
      const out = await runDetectionJob(runtimePool, {
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
      const { resolveDocumentStore } = await import('./appeals/storage.ts');
      const out = await generateAppealPackets(runtimePool, {
        tenantId: values.tenant,
        clientId: values.client,
        asOf: values['as-of'],
        store: await resolveDocumentStore(),
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
      const items = await loadSubmissionQueue(runtimePool, {
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
      const out = await run(runtimePool, {
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
      const { resolveEmailTransport } = await import('./automation/notify.ts');
      const { resolveDocumentStore } = await import('./appeals/storage.ts');
      const transport = await resolveEmailTransport();
      const store = await resolveDocumentStore();
      const handle = startScheduler(runtimePool, { transport, store });
      console.error('scheduler running — ctrl-c to stop');
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => { handle.stop(); resolve(); });
        process.on('SIGTERM', () => { handle.stop(); resolve(); });
      });
      break;
    }

    case 'sftp-server': {
      // long-running: embedded per-client SFTP drop server until killed
      const { startSftpServer } = await import('./integration/sftp_server.ts');
      const srv = await startSftpServer(runtimePool);
      console.error(`SFTP server listening on port ${srv.port} — ctrl-c to stop`);
      await new Promise<void>((resolve) => {
        const stop = () => { srv.close().then(() => resolve()); };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      });
      break;
    }

    case 'create-tenant': {
      if (!values.name || !values.type || !values['admin-email']) {
        console.error('create-tenant: --name, --type '
          + '(provider_group|billing_company|health_system), and --admin-email are required');
        process.exit(2);
      }
      const { createTenant } = await import('./web/admin_api.ts');
      const out = await createTenant(runtimePool, {
        tenantName: values.name,
        tenantType: values.type,
        adminEmail: values['admin-email'],
        adminFirstName: values['admin-first'],
        adminLastName: values['admin-last'],
      });
      console.log(JSON.stringify({ tenantId: out.tenantId, userId: out.userId }, null, 2));
      console.error(
        `\ntenant created. An invite email was queued to ${values['admin-email']} `
        + `(sends for real once SMTP is configured; otherwise check the scheduler log).\n`
        + `Invite link (expires in 7 days) in case you need to hand it over directly:\n`
        + `  https://<your-domain>/accept-invite?token=${out.inviteToken}`,
      );
      break;
    }

    case 'reference-import': {
      const allowedKinds = new Set(['medicare_pfs', 'carc', 'rarc', 'ncci_ptp']);
      if (!values.kind || !allowedKinds.has(values.kind) || !values.version
        || !values.file || !values['source-url']) {
        console.error('reference-import: --kind medicare_pfs|carc|rarc|ncci_ptp, '
          + '--version, --file, and --source-url are required');
        process.exit(2);
      }
      const serviceSetting = values['service-setting'];
      if (serviceSetting && !['practitioner', 'outpatient_hospital'].includes(serviceSetting)) {
        console.error('reference-import: --service-setting must be practitioner or outpatient_hospital');
        process.exit(2);
      }
      const { importReferenceDataset } = await import('./reference/import.ts');
      const out = await importReferenceDataset(runtimePool, {
        kind: values.kind as any, version: values.version, scope: values.scope,
        sourceUrl: values['source-url'], effectiveDate: values['effective-date'],
        serviceSetting: serviceSetting as any,
        content: await readFile(values.file, 'utf8'),
      });
      console.log(JSON.stringify(out, null, 2));
      break;
    }

    case 'nightly': {
      if (!values.client) { console.error('nightly: --client required'); process.exit(2); }
      const { runNightlyProcessing } = await import('./automation/jobs.ts');
      const { resolveDocumentStore } = await import('./appeals/storage.ts');
      const out = await runNightlyProcessing(runtimePool, {
        tenantId: values.tenant, clientId: values.client, asOf: values['as-of'],
        store: await resolveDocumentStore(),
      });
      console.log(JSON.stringify(out, null, 2));
      break;
    }

    case 'monitor': {
      const { runDeadlineMonitor } = await import('./automation/jobs.ts');
      const out = await runDeadlineMonitor(runtimePool, {
        tenantId: values.tenant, clientId: values.client, asOf: values['as-of'],
      });
      console.log(JSON.stringify(out, null, 2));
      break;
    }

    case 'reconcile': {
      const { runPaymentReconciliation } = await import('./automation/jobs.ts');
      const out = await runPaymentReconciliation(runtimePool, {
        tenantId: values.tenant, clientId: values.client,
      });
      console.log(JSON.stringify(out, null, 2));
      break;
    }

    case 'reconcile-deliveries': {
      const { runDeliveryReconciliation } = await import('./automation/jobs.ts');
      const out = await runDeliveryReconciliation(runtimePool, {
        tenantId: values.tenant, clientId: values.client,
      });
      console.log(JSON.stringify(out, null, 2));
      break;
    }

    case 'weekly': {
      if (!values.client) { console.error('weekly: --client required'); process.exit(2); }
      const { runWeeklySummary } = await import('./automation/jobs.ts');
      const out = await runWeeklySummary(runtimePool, {
        tenantId: values.tenant, clientId: values.client, asOf: values['as-of'],
      });
      console.log(JSON.stringify(out, null, 2));
      break;
    }

    case 'preflight': {
      // Exits non-zero when a blocking check fails, so a deployment pipeline
      // or a runbook step can gate on it rather than on somebody reading it.
      if (!values.client) { console.error('preflight: --client required'); process.exit(2); }
      const { assessGoLive } = await import('./integration/golive.ts');
      const report = await assessGoLive(runtimePool, values.tenant, values.client);

      if (values.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const mark = (c: { status: string; severity: string }) =>
          (c.status === 'pass' ? 'PASS' : c.severity === 'block' ? 'BLOCK' : c.severity.toUpperCase());
        console.log(`\n${report.clientName} — currently ${report.operatingMode}\n`);
        let group = '';
        for (const c of report.checks) {
          if (c.group !== group) { group = c.group; console.log(`  [${group.replace(/_/g, ' ')}]`); }
          console.log(`    ${mark(c).padEnd(5)}  ${c.title}: ${c.detail}`);
          if (c.remedy) console.log(`           → ${c.remedy}`);
        }
        console.log(
          `\n  ${report.cleared ? 'CLEARED for live operation' : 'NOT CLEARED'}`
          + ` — ${report.blockingFailures} blocking, ${report.warnings} warning(s)\n`);
      }
      if (!report.cleared) process.exit(1);
      break;
    }
  }
} finally {
  await pool.end();
}
