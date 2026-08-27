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
