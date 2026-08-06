import { optionalSecret, requireSecret } from '../security/secrets.ts';

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
