// ============================================================================
// TRANSACTIONS
//
// A multi-statement change that moves money has to be all-or-nothing. The
// invoicing path is the sharp case: it releases the ledger rows an invoice
// holds and then re-claims them, so a failure between those two steps would
// leave the invoice asserting totals for recoveries the ledger shows as
// unbilled — and the next run would bill them a second time.
//
// The pattern here is the one admin_api.ts already established: take a
// dedicated connection, BEGIN, re-assert the tenant GUC *inside* the
// transaction, and roll back on any throw. The GUC matters — a pooled
// connection carries no tenant context of its own, and under row-level
// security a statement without it silently sees nothing rather than failing
// loudly.
// ============================================================================

import type { UUID } from '../types.ts';
import type { Queryable } from './snapshot.ts';

/** A pool that can hand out a dedicated connection. */
export interface Connectable extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

/**
 * A connection whose backend went away emits an 'error' event. On a client
 * that is checked out of the pool nobody is listening for it — the pool's own
 * error handler only covers clients sitting idle in the pool — so Node treats
 * it as an unhandled 'error' and terminates the process.
 *
 * That is not a theoretical path: a failover, a DBA's pg_terminate_backend, an
 * idle_in_transaction_session_timeout or a dropped network connection all
 * produce it, and they produce it precisely while a transaction is open. The
 * request should fail; the server should not.
 *
 * Attaching a listener is what makes the difference between a rejected query
 * and a dead process. The event is deliberately swallowed: the in-flight query
 * rejects on its own with the same underlying error, and that rejection is the
 * one callers can act on.
 */
const ABSORBING = Symbol.for('rcm.absorbingConnectionErrors');

export function absorbConnectionErrors(conn: unknown): void {
  const emitter = conn as {
    on?: (event: string, handler: (error: unknown) => void) => void;
    [ABSORBING]?: boolean;
  };
  if (typeof emitter.on !== 'function') return;
  // Pooled clients are handed out repeatedly. Attaching on every checkout
  // accumulates a listener per checkout on the same client, which leaks and
  // trips Node's max-listeners warning after ten.
  if (emitter[ABSORBING]) return;
  emitter[ABSORBING] = true;
  emitter.on('error', () => {});
}

/** True when the object can start a transaction rather than only run queries. */
export function canTransact(db: Queryable): db is Connectable {
  return typeof (db as Connectable).connect === 'function';
}

/**
 * Run `fn` inside a transaction bound to `tenantId`.
 *
 * `SET LOCAL` (the `true` third argument to set_config) scopes the tenant to
 * this transaction, so the connection returns to the pool clean even if the
 * body throws — the failure mode that migration 0016/0017 exists to prevent.
 */
export async function withTenantTransaction<T>(
  db: Connectable, tenantId: UUID, fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const conn = await db.connect();
  absorbConnectionErrors(conn);
  try {
    await conn.query('BEGIN');
    await conn.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    const out = await fn(conn);
    await conn.query('COMMIT');
    return out;
  } catch (error) {
    await conn.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}
