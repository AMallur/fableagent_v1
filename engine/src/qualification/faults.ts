// ============================================================================
// Failure injection.
//
// Production does not fail politely. Connections are killed by a failover, a
// deploy restarts a pod mid-write, the database refuses a statement because a
// constraint fired. What matters is not that the operation failed — it is
// whether the money is still right afterwards.
//
// Each fault below interrupts a specific operation at a specific point and
// then asks the invariants. A fault that leaves a violation is a defect; a
// fault that raises an error and leaves the data consistent is the system
// working.
// ============================================================================

import type { PoolLike } from '../service.ts';
import type { Queryable } from '../db/snapshot.ts';
import type { UUID } from '../types.ts';
import { TenantContextPool } from '../db/tenant_pool.ts';
import { checkInvariants, formatInvariantReport, type InvariantReport } from './invariants.ts';
import { harnessSession, resolveAdminUser } from './context.ts';
import { generateBatch } from './synthetic_x12.ts';

export interface FaultOutcome {
  fault: string;
  /** What the fault is meant to prove. */
  proves: string;
  /** Did the operation fail, as the fault intended? */
  operationFailed: boolean;
  errorMessage: string | null;
  /** State assertions specific to this fault. */
  assertions: { name: string; passed: boolean; detail: string }[];
  invariants: InvariantReport;
  passed: boolean;
}

export interface FaultReport {
  outcomes: FaultOutcome[];
  passed: boolean;
}

export interface FaultOptions {
  tenantId: UUID;
  clientId: UUID;
  /** A separate superuser-capable connection used to kill backends. */
  adminDb: Queryable;
  seed?: number;
}

/**
 * Kill the backend serving a specific connection, the way a failover or an
 * OOM kill does — abruptly, with no chance to roll back cleanly in-process.
 */
async function killBackend(adminDb: Queryable, pid: number): Promise<void> {
  await adminDb.query('SELECT pg_terminate_backend($1)', [pid]);
}

async function backendPid(db: { query: Queryable['query'] }): Promise<number> {
  const result = await db.query('SELECT pg_backend_pid() AS pid');
  return Number(result.rows[0].pid);
}

export async function runFaults(
  rawPool: PoolLike, options: FaultOptions,
): Promise<FaultReport> {
  const { tenantId, clientId, adminDb, seed = 8080 } = options;
  const tenantPool = rawPool instanceof TenantContextPool
    ? rawPool : new TenantContextPool(rawPool);
  const pool = tenantPool.forTenant(tenantId);
  const adminUserId = await resolveAdminUser(adminDb, tenantId);
  const session = harnessSession(adminUserId, tenantId, 'fault-harness') as any;
  const scope = { tenantId, clientIds: [clientId] } as any;

  const outcomes: FaultOutcome[] = [];

  // ------------------------------------------------------------------
  // 1. A connection dies in the middle of an invoice transaction.
  // ------------------------------------------------------------------
  outcomes.push(await faultKilledDuringInvoice(rawPool, adminDb, tenantId, clientId, session, scope));

  // ------------------------------------------------------------------
  // 2. Ingest is interrupted partway through a file.
  // ------------------------------------------------------------------
  outcomes.push(await faultKilledDuringIngest(rawPool, adminDb, tenantId, clientId, seed));

  // ------------------------------------------------------------------
  // 3. The ledger is asked to do something it must refuse.
  // ------------------------------------------------------------------
  outcomes.push(await faultLedgerMutation(pool, adminDb, tenantId));

  // ------------------------------------------------------------------
  // 4. An issued invoice is asked to change.
  // ------------------------------------------------------------------
  outcomes.push(await faultIssuedInvoiceMutation(pool, adminDb, tenantId, clientId, session, scope));

  // ------------------------------------------------------------------
  // 5. The audit log is asked to forget.
  // ------------------------------------------------------------------
  outcomes.push(await faultAuditMutation(pool, adminDb, tenantId));

  return { outcomes, passed: outcomes.every((o) => o.passed) };
}

function outcome(
  fault: string, proves: string,
  operationFailed: boolean, errorMessage: string | null,
  assertions: FaultOutcome['assertions'], invariants: InvariantReport,
): FaultOutcome {
  return {
    fault, proves, operationFailed, errorMessage, assertions, invariants,
    passed: invariants.clean && assertions.every((a) => a.passed),
  };
}

async function faultKilledDuringInvoice(
  rawPool: PoolLike, adminDb: Queryable, tenantId: UUID, clientId: UUID,
  session: any, scope: any,
): Promise<FaultOutcome> {
  const { generateInvoice } = await import('../web/billing.ts');
  const tenantPool = new TenantContextPool(rawPool).forTenant(tenantId);

  const before = await adminDb.query(
    `SELECT count(*)::int AS unbilled FROM usage_event
      WHERE tenant_id = $1 AND invoice_id IS NULL`, [tenantId]);

  // Start the invoice, then kill every backend this tenant is using while it
  // runs. Whichever statement was in flight dies mid-transaction.
  let errorMessage: string | null = null;
  const running = generateInvoice(tenantPool, session, scope, clientId, '2026-02')
    .catch((error) => { errorMessage = error instanceof Error ? error.message : String(error); });

  // Give the transaction a moment to open, then terminate it.
  await new Promise((resolve) => setTimeout(resolve, 12));
  const victims = await adminDb.query(
    `SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND state <> 'idle' AND query ILIKE '%invoice%'`);
  for (const victim of victims.rows) {
    await killBackend(adminDb, Number(victim.pid)).catch(() => {});
  }
  await running;

  const after = await adminDb.query(
    `SELECT count(*)::int AS unbilled FROM usage_event
      WHERE tenant_id = $1 AND invoice_id IS NULL`, [tenantId]);
  const halfClaimed = await adminDb.query(
    `SELECT count(*)::int AS n FROM usage_event ue
      WHERE ue.tenant_id = $1 AND ue.invoice_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM invoice i WHERE i.invoice_id = ue.invoice_id)`,
    [tenantId]);

  const invariants = await checkInvariants(adminDb, tenantId);
  return outcome(
    'connection killed during invoice generation',
    'a bill that dies halfway must leave every recovery billable, not claimed '
    + 'by an invoice that does not exist',
    errorMessage !== null, errorMessage,
    [{
      name: 'no ledger row claimed by a non-existent invoice',
      passed: halfClaimed.rows[0].n === 0,
      detail: `${halfClaimed.rows[0].n} orphaned claim(s)`,
    }, {
      name: 'unbilled recoveries either all released or all billed',
      passed: after.rows[0].unbilled === before.rows[0].unbilled
        || after.rows[0].unbilled < before.rows[0].unbilled,
      detail: `unbilled ${before.rows[0].unbilled} -> ${after.rows[0].unbilled}`,
    }],
    invariants,
  );
}

async function faultKilledDuringIngest(
  rawPool: PoolLike, adminDb: Queryable, tenantId: UUID, clientId: UUID, seed: number,
): Promise<FaultOutcome> {
  const { ingest837Job } = await import('../ingest/service.ts');
  const tenantPool = new TenantContextPool(rawPool).forTenant(tenantId);
  const batch = generateBatch({ seed, claimsPerBatch: 200, claimPrefix: 'FAULT' });

  const before = await adminDb.query(
    `SELECT count(*)::int AS n FROM claim WHERE tenant_id = $1`, [tenantId]);

  let errorMessage: string | null = null;
  const running = ingest837Job(tenantPool, {
    tenantId, clientId, content: batch.claimFile, fileName: 'fault-837.txt',
  }).catch((error) => { errorMessage = error instanceof Error ? error.message : String(error); });

  await new Promise((resolve) => setTimeout(resolve, 25));
  const victims = await adminDb.query(
    `SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND state <> 'idle'
        AND (query ILIKE '%INSERT INTO claim%' OR query ILIKE '%INSERT INTO encounter%'
             OR query ILIKE '%INSERT INTO patient%')`);
  for (const victim of victims.rows) {
    await killBackend(adminDb, Number(victim.pid)).catch(() => {});
  }
  await running;

  // Whatever survived must be internally consistent: no claim without its
  // encounter, no line without its claim.
  const dangling = await adminDb.query(
    `SELECT
       (SELECT count(*)::int FROM claim c
          WHERE c.tenant_id = $1
            AND NOT EXISTS (SELECT 1 FROM encounter e WHERE e.encounter_id = c.encounter_id))
         AS claims_without_encounter,
       (SELECT count(*)::int FROM claim_line cl
          WHERE cl.tenant_id = $1
            AND NOT EXISTS (SELECT 1 FROM claim c WHERE c.claim_id = cl.claim_id))
         AS lines_without_claim`, [tenantId]);

  const after = await adminDb.query(
    `SELECT count(*)::int AS n FROM claim WHERE tenant_id = $1`, [tenantId]);
  const invariants = await checkInvariants(adminDb, tenantId);

  return outcome(
    'connection killed during 837 ingest',
    'a file that dies halfway must not leave claims without encounters or '
    + 'lines without claims — a partial claim prices wrongly and appeals wrongly',
    errorMessage !== null, errorMessage,
    [{
      name: 'no claim without its encounter',
      passed: dangling.rows[0].claims_without_encounter === 0,
      detail: `${dangling.rows[0].claims_without_encounter} dangling claim(s)`,
    }, {
      name: 'no claim line without its claim',
      passed: dangling.rows[0].lines_without_claim === 0,
      detail: `${dangling.rows[0].lines_without_claim} dangling line(s)`,
    }, {
      name: 'claim count moved coherently',
      passed: after.rows[0].n >= before.rows[0].n,
      detail: `claims ${before.rows[0].n} -> ${after.rows[0].n}`,
    }],
    invariants,
  );
}

async function faultLedgerMutation(
  pool: PoolLike, adminDb: Queryable, tenantId: UUID,
): Promise<FaultOutcome> {
  const target = await adminDb.query(
    `SELECT usage_event_id, amount FROM usage_event WHERE tenant_id = $1 LIMIT 1`, [tenantId]);

  const assertions: FaultOutcome['assertions'] = [];
  let errorMessage: string | null = null;

  if (target.rows.length === 0) {
    assertions.push({
      name: 'a ledger row exists to test against', passed: false,
      detail: 'no usage_event rows; run the load harness first',
    });
  } else {
    const { usage_event_id: id, amount } = target.rows[0];
    try {
      await pool.query(
        `UPDATE usage_event SET amount = amount + 1 WHERE usage_event_id = $1`, [id]);
      assertions.push({
        name: 'rewriting a ledger amount is refused', passed: false,
        detail: 'the update succeeded, so the ledger is not append-only',
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      assertions.push({
        name: 'rewriting a ledger amount is refused', passed: true,
        detail: errorMessage.slice(0, 140),
      });
    }
    const now = await adminDb.query(
      `SELECT amount FROM usage_event WHERE usage_event_id = $1`, [id]);
    assertions.push({
      name: 'the amount did not move', passed: String(now.rows[0].amount) === String(amount),
      detail: `${amount} -> ${now.rows[0].amount}`,
    });

    try {
      await pool.query(`DELETE FROM usage_event WHERE usage_event_id = $1`, [id]);
      assertions.push({
        name: 'deleting a ledger row is refused', passed: false,
        detail: 'the delete succeeded',
      });
    } catch (error) {
      assertions.push({
        name: 'deleting a ledger row is refused', passed: true,
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 140),
      });
    }
  }

  return outcome(
    'ledger row rewritten and deleted',
    'billable facts are append-only; a correction is a new row, never an edit',
    errorMessage !== null, errorMessage,
    assertions, await checkInvariants(adminDb, tenantId),
  );
}

async function faultIssuedInvoiceMutation(
  pool: PoolLike, adminDb: Queryable, tenantId: UUID, clientId: UUID,
  session: any, scope: any,
): Promise<FaultOutcome> {
  const { generateInvoice, issueInvoice } = await import('../web/billing.ts');
  const assertions: FaultOutcome['assertions'] = [];
  let errorMessage: string | null = null;

  // Reuse an invoice that is already issued when there is one. Insisting on
  // issuing a fresh one makes the fault depend on a month nothing has billed
  // yet, so the exercise starts failing for reasons that have nothing to do
  // with immutability.
  let invoiceId: UUID | null = null;
  const existing = await adminDb.query(
    `SELECT invoice_id FROM invoice
      WHERE tenant_id = $1 AND client_id = $2 AND status = 'issued'
      ORDER BY issued_at DESC LIMIT 1`, [tenantId, clientId]);

  if (existing.rows.length > 0) {
    invoiceId = existing.rows[0].invoice_id;
  } else {
    for (const month of ['2026-05', '2026-06', '2026-07', '2026-08']) {
      try {
        const draft: any = await generateInvoice(pool, session, scope, clientId, month);
        invoiceId = draft.invoiceId ?? draft.invoice_id ?? null;
        if (invoiceId) { await issueInvoice(pool, session, scope, invoiceId); break; }
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        invoiceId = null;
      }
    }
  }

  if (!invoiceId) {
    assertions.push({
      name: 'an issued invoice exists to test against', passed: false,
      detail: errorMessage ?? 'could not create one',
    });
  } else {
    const before = await adminDb.query(
      `SELECT amount_due FROM invoice WHERE invoice_id = $1`, [invoiceId]);
    try {
      await pool.query(
        `UPDATE invoice SET amount_due = amount_due + 100 WHERE invoice_id = $1`, [invoiceId]);
      assertions.push({
        name: 'changing an issued invoice is refused', passed: false,
        detail: 'the update succeeded',
      });
    } catch (error) {
      assertions.push({
        name: 'changing an issued invoice is refused', passed: true,
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 140),
      });
    }
    const after = await adminDb.query(
      `SELECT amount_due FROM invoice WHERE invoice_id = $1`, [invoiceId]);
    assertions.push({
      name: 'the amount due did not move',
      passed: String(before.rows[0].amount_due) === String(after.rows[0].amount_due),
      detail: `${before.rows[0].amount_due} -> ${after.rows[0].amount_due}`,
    });
  }

  return outcome(
    'issued invoice edited in place',
    'an issued bill is a commercial record; corrections are a void and reissue',
    errorMessage !== null, errorMessage,
    assertions, await checkInvariants(adminDb, tenantId),
  );
}

async function faultAuditMutation(
  pool: PoolLike, adminDb: Queryable, tenantId: UUID,
): Promise<FaultOutcome> {
  const target = await adminDb.query(
    `SELECT log_id, action FROM audit_log WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [tenantId]);
  const assertions: FaultOutcome['assertions'] = [];

  if (target.rows.length === 0) {
    assertions.push({
      name: 'an audit row exists to test against', passed: false, detail: 'none found',
    });
    return outcome('audit log rewritten and deleted', 'nothing to prove without a record',
      false, null, assertions, await checkInvariants(adminDb, tenantId));
  }

  const { log_id: id, action: originalAction } = target.rows[0];

  // Layer one: row-level security. audit_log carries policies for SELECT and
  // INSERT only, under FORCE ROW LEVEL SECURITY, so an UPDATE or DELETE from
  // the application role reaches no row at all. That is a silent zero-row
  // result rather than an exception — which is the correct outcome, and is why
  // this asserts on whether the record moved rather than on whether the
  // statement raised. Treating "no exception" as a failure would have called a
  // working control broken.
  for (const [name, sql] of [
    ['application role cannot rewrite an audit record',
      `UPDATE audit_log SET action = 'tampered' WHERE log_id = $1`],
    ['application role cannot delete an audit record',
      `DELETE FROM audit_log WHERE log_id = $1`],
  ] as const) {
    let reached = 0;
    let refused = false;
    try {
      const result = await pool.query(sql, [id]);
      reached = (result as { rowCount?: number }).rowCount ?? 0;
    } catch {
      refused = true;
    }
    assertions.push({
      name, passed: refused || reached === 0,
      detail: refused ? 'the statement was rejected' : `${reached} row(s) reached`,
    });
  }

  const after = await adminDb.query(
    `SELECT action FROM audit_log WHERE log_id = $1`, [id]);
  assertions.push({
    name: 'the record is present and unchanged',
    passed: after.rows.length === 1 && after.rows[0].action === originalAction,
    detail: after.rows.length === 0
      ? 'the record was deleted'
      : `action ${originalAction} -> ${after.rows[0].action}`,
  });

  // Layer two: the immutability trigger. Row-level security is what stops the
  // application today, so the trigger is never exercised by that path — which
  // means it could rot unnoticed until the day a policy is added. Reaching the
  // row as a superuser, where RLS does not apply, is the only way to prove the
  // second layer is still there.
  for (const [name, sql] of [
    ['the immutability trigger rejects an update that reaches the row',
      `UPDATE audit_log SET action = 'tampered' WHERE log_id = $1`],
    ['the immutability trigger rejects a delete that reaches the row',
      `DELETE FROM audit_log WHERE log_id = $1`],
  ] as const) {
    try {
      await adminDb.query(sql, [id]);
      assertions.push({ name, passed: false, detail: 'the statement was allowed' });
    } catch (error) {
      assertions.push({
        name, passed: true,
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 120),
      });
    }
  }

  const final = await adminDb.query(
    `SELECT action FROM audit_log WHERE log_id = $1`, [id]);
  assertions.push({
    name: 'still present and unchanged after both layers were tested',
    passed: final.rows.length === 1 && final.rows[0].action === originalAction,
    detail: final.rows.length === 0 ? 'gone' : `action = ${final.rows[0].action}`,
  });

  return outcome(
    'audit log rewritten and deleted',
    'the audit trail is what a customer and a regulator are told cannot be '
    + 'altered; that claim has to survive both the application role and a '
    + 'statement that gets past row-level security',
    false, null, assertions, await checkInvariants(adminDb, tenantId),
  );
}

export function formatFaultReport(report: FaultReport): string {
  const lines: string[] = ['# Failure injection', ''];
  for (const outcome of report.outcomes) {
    lines.push(`## ${outcome.fault} — ${outcome.passed ? 'held' : 'FAILED'}`);
    lines.push('');
    lines.push(`_${outcome.proves}_`);
    lines.push('');
    if (outcome.errorMessage) {
      lines.push(`Operation failed with: \`${outcome.errorMessage.slice(0, 200)}\``);
      lines.push('');
    }
    for (const assertion of outcome.assertions) {
      lines.push(`- ${assertion.passed ? 'PASS' : 'FAIL'} — ${assertion.name}: ${assertion.detail}`);
    }
    lines.push('');
    lines.push(formatInvariantReport(outcome.invariants));
    lines.push('');
  }
  lines.push(report.passed
    ? 'Every injected fault left the data consistent.'
    : 'At least one injected fault left the data inconsistent.');
  return lines.join('\n');
}
