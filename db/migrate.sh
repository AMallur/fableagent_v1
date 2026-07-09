#!/usr/bin/env bash
# Apply all migrations in order against $DATABASE_URL (or a local default).
# Idempotency is tracked in schema_migrations; already-applied files are skipped.
set -euo pipefail

DB_URL="${DATABASE_URL:-postgres://localhost:5432/rcm_dev}"
DIR="$(cd "$(dirname "$0")/migrations" && pwd)"

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
