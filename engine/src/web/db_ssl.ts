// ============================================================================
// Postgres connection SSL policy, shared by every process entry point
// (web server, CLI, scheduler, seed script) so they all make the same
// decision rather than three slightly-different copies drifting apart.
//
//   PGSSLMODE=disable   -> no TLS (local dev / same-network docker-compose)
//   PGSSLROOTCERT=<path>-> TLS with the connection verified against that CA
//   otherwise, in production -> TLS required but unverified (encrypts the
//     wire even without a supplied CA bundle; logs a warning nudging toward
//     providing PGSSLROOTCERT for full verification)
//   otherwise (dev, no explicit mode) -> no TLS, matching a plain local
//     Postgres with nothing configured
// ============================================================================

export interface PgSslConfig {
  rejectUnauthorized: boolean;
  ca?: string;
}

export function pgSslConfig(
  readFile: (path: string, encoding: 'utf8') => string,
): PgSslConfig | undefined {
  if (process.env.PGSSLMODE === 'disable') return undefined;

  const caPath = process.env.PGSSLROOTCERT;
  if (caPath) {
    return { rejectUnauthorized: true, ca: readFile(caPath, 'utf8') };
  }

  if (process.env.NODE_ENV === 'production' || process.env.PGSSLMODE === 'require') {
    console.warn(
      'connecting to Postgres over TLS without PGSSLROOTCERT set — the '
      + 'connection is encrypted but the server certificate is not verified. '
      + 'Set PGSSLROOTCERT to your provider\'s CA bundle for full verification.',
    );
    return { rejectUnauthorized: false };
  }

  return undefined;
}
