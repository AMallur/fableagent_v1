#!/usr/bin/env bash
# Apply all migrations in order against $DATABASE_URL (or a local default).
# Idempotency is tracked in schema_migrations; already-applied files are skipped.
set -euo pipefail

DB_URL="${DATABASE_URL:-postgres://localhost:5432/rcm_dev}"
DIR="$(cd "$(dirname "$0")/migrations" && pwd)"

# the DB behind DB_URL may not be ready to accept connections yet — a local
# `db` container declares service_healthy before migrate starts, but a
# proxy in front of a remote instance (e.g. the Cloud SQL Auth Proxy) takes
# a few seconds to establish its tunnel and can't be health-checked the same
# way, so retry here instead of failing on the first connection attempt.
for i in $(seq 1 30); do
  if pg_isready -d "$DB_URL" -q; then break; fi
  if [ "$i" -eq 30 ]; then
    echo "database not reachable after 30 attempts, giving up" >&2
    exit 1
  fi
  echo "waiting for database to accept connections... ($i/30)"
  sleep 2
done

psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS schema_migrations (
     filename   text PRIMARY KEY,
     applied_at timestamptz NOT NULL DEFAULT now()
   );"

for f in "$DIR"/*.sql; do
  name="$(basename "$f")"
  applied=$(psql "$DB_URL" -tA -c \
    "SELECT 1 FROM schema_migrations WHERE filename = '$name'")
  if [ "$applied" = "1" ]; then
    echo "skip  $name"
    continue
  fi
  echo "apply $name"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$f"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c \
    "INSERT INTO schema_migrations (filename) VALUES ('$name')"
done

echo "done"
