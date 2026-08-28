import { optionalSecret, requireSecret } from '../security/secrets.ts';
import { absorbConnectionErrors } from './tx.ts';

/**
 * Resolve either a conventional DATABASE_URL or discrete database fields.
 * Discrete fields let ECS inject an RDS-managed password without constructing
 * and storing a second URL secret. URL encoding is always applied here.
 */
export function databaseConnectionString(): string {
  const url = optionalSecret('DATABASE_URL');
  if (url) return url;

  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const password = optionalSecret('DB_PASSWORD');
  const name = process.env.DB_NAME;
  if (host && user && password && name) {
    const port = process.env.DB_PORT || '5432';
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}`
      + `@${host}:${port}/${encodeURIComponent(name)}`;
  }
  return requireSecret('DATABASE_URL', { devFallback: 'postgres://localhost:5432/rcm_dev' });
}


/**
 * Make a pg pool survive its connections dying.
 *
 * Two separate exposures, and the second is the one that takes a server down:
 *
 *   - a client sitting idle IN the pool loses its backend. pg re-emits that on
 *     the pool, so `pool.on('error')` covers it. Without a listener the process
 *     dies here too, which is the documented reason that handler exists.
 *
 *   - a client CHECKED OUT of the pool loses its backend. pg emits 'error' on
 *     the client, and the pool's handler is not consulted. Every consumer is
 *     therefore individually responsible for listening, and any one that
 *     forgets turns a failover into an uncaught exception that ends the
 *     process rather than the request.
 *
 * Hooking connect() here removes that responsibility from every call site, so
 * a new one cannot reintroduce the exposure by omission.
 */
export function hardenPool<T extends {
  on(event: string, handler: (error: unknown) => void): unknown;
  connect(...args: unknown[]): unknown;
}>(pool: T): T {
  pool.on('error', () => {});
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;

  // pool.query() checks a connection out through this same method, passing a
  // callback rather than awaiting a promise. A wrapper that only handles the
  // promise form silently swallows that callback and every pool.query() hangs
  // forever, so both calling conventions have to survive.
  (pool as { connect: (...args: unknown[]) => unknown }).connect = (...args: unknown[]) => {
    const callback = args[0];
    if (typeof callback === 'function') {
      return connect((error: unknown, client: unknown, release: unknown) => {
        if (client) absorbConnectionErrors(client);
        (callback as (e: unknown, c: unknown, r: unknown) => void)(error, client, release);
      });
    }
    return (connect() as Promise<unknown>).then((client) => {
      absorbConnectionErrors(client);
      return client;
    });
  };
  return pool;
}
