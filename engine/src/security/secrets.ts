// ============================================================================
// Secret resolution: reads a named secret from the environment or from a
// mounted file (the `${NAME}_FILE` convention used by Docker secrets,
// Kubernetes secret volumes, and most secrets managers' sidecar/CSI
// injectors — this is deliberately vendor-agnostic; Vault, AWS Secrets
// Manager, etc. all support handing the app a file path or an env var).
//
// In production (NODE_ENV=production) a missing required secret throws at
// process startup, not on the first request that happens to need it — a
// misconfigured deploy should fail loudly at `docker run` / `node main.ts`,
// not silently serve traffic with a guessable default.
//
// In development/test, a fixed fallback is used so `npm test` and local dev
// keep working with zero setup. That fallback is intentionally recognizable
// (not a real secret shape) so it can never be mistaken for a production
// value if accidentally deployed — the isProduction() check is what
// actually prevents that, not the fallback's obscurity.
// ============================================================================

import { readFileSync } from 'node:fs';

export const isProduction = (): boolean => process.env.NODE_ENV === 'production';

export interface RequireSecretOptions {
  /** used only outside production; must stay obviously non-production-shaped */
  devFallback: string;
}

export function requireSecret(name: string, opts: RequireSecretOptions): string {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    try {
      const value = readFileSync(filePath, 'utf8').trim();
      if (value) return value;
    } catch (err) {
      throw new Error(
        `${name}_FILE was set to "${filePath}" but could not be read: `
        + `${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;

  if (isProduction()) {
    throw new Error(
      `${name} is required in production and was not found (checked env var `
      + `${name} and file path in ${name}_FILE). Refusing to start with a `
      + `default secret — set one via your secrets manager before deploying.`,
    );
  }
  return opts.devFallback;
}
