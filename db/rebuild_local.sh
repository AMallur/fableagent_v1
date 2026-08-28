#!/usr/bin/env bash
# Rebuild a local PostgreSQL database from scratch, following the sequence in
# .github/workflows/ci.yml: bootstrap the non-superuser runtime role, migrate,
# revoke the migration-only owner memberships, then seed.
#
# The qualification harnesses mutate the seeded tenant, so they need a known
# starting state. This script provides it.
#
# NOT for any deployed environment: it drops the database. The default
# passwords below are throwaway local values for a database this script is
# willing to destroy, in the same spirit as the CI workflow's; override them
# with SUPER_PASSWORD / RUNTIME_PASSWORD if a local cluster uses others.
set -euo pipefail

DB_NAME="${DB_NAME:-rcm}"
PGHOST_LOCAL="${PGHOST_LOCAL:-localhost}"
PGPORT_LOCAL="${PGPORT_LOCAL:-5432}"
SUPER_ROLE="${SUPER_ROLE:-postgres}"
SUPER_PASSWORD="${SUPER_PASSWORD:-postgres_local_admin}"
RUNTIME_PASSWORD="${RUNTIME_PASSWORD:-rcm_local_password}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PGSSLMODE="${PGSSLMODE:-disable}"
export PGPASSWORD="${SUPER_PASSWORD}"

maintenance_url="postgres://${SUPER_ROLE}@${PGHOST_LOCAL}:${PGPORT_LOCAL}/postgres"
admin_url="postgres://${SUPER_ROLE}@${PGHOST_LOCAL}:${PGPORT_LOCAL}/${DB_NAME}"
runtime_url="postgres://rcm_runtime:${RUNTIME_PASSWORD}@${PGHOST_LOCAL}:${PGPORT_LOCAL}/${DB_NAME}"

echo "==> dropping and recreating ${DB_NAME}"
psql "$maintenance_url" -v ON_ERROR_STOP=1 -q <<SQL
DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);
DROP ROLE IF EXISTS rcm_runtime;
DROP ROLE IF EXISTS rcm_app;
DROP ROLE IF EXISTS rcm_service;
DROP ROLE IF EXISTS rcm_pretenant_lookup;
DROP ROLE IF EXISTS rcm_catalog_lookup;
CREATE DATABASE ${DB_NAME};
SQL

echo "==> bootstrapping non-superuser runtime role"
psql "$admin_url" -v ON_ERROR_STOP=1 -q <<SQL
CREATE ROLE rcm_runtime LOGIN PASSWORD '${RUNTIME_PASSWORD}';
CREATE ROLE rcm_app NOLOGIN;
CREATE ROLE rcm_service NOLOGIN BYPASSRLS;
CREATE ROLE rcm_pretenant_lookup NOLOGIN;
CREATE ROLE rcm_catalog_lookup NOLOGIN;
GRANT rcm_pretenant_lookup, rcm_catalog_lookup
  TO rcm_runtime WITH ADMIN OPTION, INHERIT FALSE;
ALTER DATABASE ${DB_NAME} OWNER TO rcm_runtime;
ALTER SCHEMA public OWNER TO rcm_runtime;
SQL

# Migrations run as rcm_runtime, which owns the database and the public schema.
# That ownership is what gives the runtime role its privileges — nothing grants
# rcm_app to it. Running them as a superuser instead leaves every table owned by
# postgres and the runtime role able to read nothing, which is how CI would look
# if this diverged from .github/workflows/ci.yml.
echo "==> running migrations as rcm_runtime"
DATABASE_URL="$runtime_url" bash "${REPO_ROOT}/db/migrate.sh" >/dev/null

echo "==> revoking migration-only owner-role memberships"
psql "$admin_url" -v ON_ERROR_STOP=1 -q <<'SQL'
REVOKE rcm_pretenant_lookup, rcm_catalog_lookup FROM rcm_runtime;
SQL

if [ "${SKIP_SEED:-}" != "1" ]; then
  echo "==> seeding demo data"
  (
    cd "${REPO_ROOT}/engine"
    DATABASE_URL="$admin_url" \
    SESSION_SECRET=local-session-secret-not-for-production \
    DATA_ENCRYPTION_KEY=local-data-key-not-for-production \
      npm run --silent seed >/dev/null
  )
fi

echo "==> ready: ${admin_url}"
