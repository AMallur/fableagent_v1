#!/usr/bin/env bash
# One-shot RDS bootstrap + migration entrypoint for the AWS migration task.
# The administrator password is used only to create/prepare the non-superuser
# runtime login. All migrations then run as that runtime login, matching CI.
set -euo pipefail

: "${DB_HOST:?DB_HOST is required}"
: "${DB_NAME:?DB_NAME is required}"
: "${DB_ADMIN_USER:?DB_ADMIN_USER is required}"
: "${DB_ADMIN_PASSWORD:?DB_ADMIN_PASSWORD is required}"
: "${DB_RUNTIME_USER:?DB_RUNTIME_USER is required}"
: "${DB_RUNTIME_PASSWORD:?DB_RUNTIME_PASSWORD is required}"

if ! [[ "$DB_RUNTIME_USER" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "DB_RUNTIME_USER must be a lowercase PostgreSQL identifier" >&2
  exit 2
fi

export PGHOST="$DB_HOST" PGPORT="${DB_PORT:-5432}" PGDATABASE="$DB_NAME" PGSSLMODE="${PGSSLMODE:-verify-full}"
export PGUSER="$DB_ADMIN_USER" PGPASSWORD="$DB_ADMIN_PASSWORD"

for i in $(seq 1 30); do
  if pg_isready -q; then break; fi
  if [ "$i" -eq 30 ]; then echo "RDS not reachable after 30 attempts" >&2; exit 1; fi
  sleep 2
done

psql -v ON_ERROR_STOP=1 -v runtime_user="$DB_RUNTIME_USER" \
  -v runtime_password="$DB_RUNTIME_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'runtime_user', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'runtime_user') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', :'runtime_user', :'runtime_password') \gexec

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rcm_app') THEN CREATE ROLE rcm_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rcm_service') THEN CREATE ROLE rcm_service NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rcm_pretenant_lookup') THEN CREATE ROLE rcm_pretenant_lookup NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rcm_catalog_lookup') THEN CREATE ROLE rcm_catalog_lookup NOLOGIN; END IF;
END $$;

SELECT format('GRANT rcm_pretenant_lookup, rcm_catalog_lookup TO %I WITH ADMIN OPTION, INHERIT FALSE', :'runtime_user') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', current_database(), :'runtime_user') \gexec
SELECT format('ALTER SCHEMA public OWNER TO %I', :'runtime_user') \gexec
SQL

export PGUSER="$DB_RUNTIME_USER" PGPASSWORD="$DB_RUNTIME_PASSWORD"
unset DATABASE_URL DATABASE_URL_FILE
export DATABASE_URL="postgres://${DB_RUNTIME_USER}@${DB_HOST}:${PGPORT}/${DB_NAME}"
bash /db/migrate.sh

export PGUSER="$DB_ADMIN_USER" PGPASSWORD="$DB_ADMIN_PASSWORD"
psql -v ON_ERROR_STOP=1 -v runtime_user="$DB_RUNTIME_USER" <<'SQL'
SELECT format('REVOKE rcm_pretenant_lookup, rcm_catalog_lookup FROM %I', :'runtime_user') \gexec
SQL
