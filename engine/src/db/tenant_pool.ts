import { AsyncLocalStorage } from 'node:async_hooks';
import type { Queryable } from './snapshot.ts';
import type { PoolLike } from '../service.ts';
import type { UUID } from '../types.ts';
import { absorbConnectionErrors } from './tx.ts';

type Releasable = Queryable & { release(): void };

/**
 * Adds fail-closed tenant scoping to a pg-compatible pool.
 *
 * Every query made inside runAsTenant() receives its own transaction and a
 * transaction-local RLS setting. Code that explicitly checks out a connection
 * gets a session setting which is always reset before that connection is
 * returned to the underlying pool.
 */
export class TenantContextPool implements PoolLike {
  private readonly context = new AsyncLocalStorage<UUID>();
  private readonly raw: PoolLike;

  constructor(raw: PoolLike) { this.raw = raw; }

  runAsTenant<T>(tenantId: UUID, work: () => Promise<T>): Promise<T> {
    return this.context.run(tenantId, work);
  }

  currentTenantId(): UUID | undefined {
    return this.context.getStore();
  }

  /** A PoolLike facade permanently bound to one tenant (CLI/service use). */
  forTenant(tenantId: UUID): PoolLike {
    return {
      query: (query, params) => this.runAsTenant(tenantId, () => this.query(query, params)),
      connect: () => this.runAsTenant(tenantId, () => this.connect()),
    };
  }

  async query(text: string, params?: unknown[]): Promise<{ rows: any[] }> {
    const tenantId = this.context.getStore();
    if (!tenantId) return this.raw.query(text, params);

    const client = await this.raw.connect();
    // A checked-out client whose backend dies emits 'error' with no listener,
    // which ends the process rather than the request. See absorbConnectionErrors.
    absorbConnectionErrors(client);
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      const result = await client.query(text, params);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async connect(): Promise<Releasable> {
    const client = await this.raw.connect();
    absorbConnectionErrors(client);
    const tenantId = this.context.getStore();
    if (!tenantId) return client;

    try {
      await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenantId]);
    } catch (err) {
      client.release();
      throw err;
    }

    let released = false;
    return {
      query: (text, params) => client.query(text, params),
      release: () => {
        if (released) return;
        released = true;
        // Do not return the connection to the pool until the session GUC is
        // cleared. This prevents one tenant's context leaking into another.
        void client.query('RESET app.current_tenant_id')
          .then(() => client.release())
          .catch((err) => (client as any).release(err));
      },
    };
  }
}

/** Reset a session-scoped RLS setting before releasing a raw pool client. */
export async function releaseTenantConnection(client: Releasable): Promise<void> {
  try {
    await client.query('RESET app.current_tenant_id');
    client.release();
  } catch (err) {
    (client as any).release(err);
  }
}
