#!/usr/bin/env bash
# ============================================================================
# Provisions a Cloud SQL for PostgreSQL instance with HA (regional,
# synchronous standby + automatic failover) and automated backups with
# point-in-time recovery, plus the rcm database and application user.
#
# This is real, continuously-billed infrastructure the moment it's created —
# read the flags below before running. Roughly $100-300+/month depending on
# INSTANCE_TIER; REGIONAL availability roughly doubles compute cost over a
# single ZONAL instance since it runs a live standby.
#
#   PROJECT_ID=my-project INSTANCE_NAME=rcm-db bash db/provision_cloudsql.sh
#
# After it finishes, point DATABASE_URL at the instance through the Cloud SQL
# Auth Proxy — see docker-compose.cloudsql.yml, which does this automatically.
# Direct-IP connection without the proxy is possible but not recommended:
# you'd be managing SSL cert rotation yourself instead of letting the proxy
# (IAM-authenticated, auto-rotating short-lived certs) handle it.
#
# Teardown:
#   gcloud sql instances delete "$INSTANCE_NAME" --project="$PROJECT_ID"
# ============================================================================
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
INSTANCE_NAME="${INSTANCE_NAME:-rcm-db}"
REGION="${REGION:-us-central1}"
INSTANCE_TIER="${INSTANCE_TIER:-db-custom-1-3840}"   # 1 vCPU / 3.75GB — smallest reasonable for real HA testing
# --edition below is ENTERPRISE, which unlocks db-custom-N-M tiers like the
# default above. If your org's default edition is ENTERPRISE_PLUS, that
# edition only accepts the larger db-perf-optimized-N-* tiers (16GB+ RAM,
# meaningfully more expensive) — pass INSTANCE_TIER=db-perf-optimized-N-2
# and change --edition below to ENTERPRISE_PLUS if you want that instead.
DB_NAME="${DB_NAME:-rcm}"
DB_USER="${DB_USER:-rcm}"
DB_PASSWORD="${DB_PASSWORD:?set DB_PASSWORD — e.g. \$(openssl rand -hex 24)}"
POSTGRES_VERSION="${POSTGRES_VERSION:-POSTGRES_16}"

echo "Enabling Cloud SQL Admin API..."
gcloud services enable sqladmin.googleapis.com --project="$PROJECT_ID"

echo "Creating instance $INSTANCE_NAME (this takes several minutes)..."
gcloud sql instances create "$INSTANCE_NAME" \
  --project="$PROJECT_ID" \
  --database-version="$POSTGRES_VERSION" \
  --region="$REGION" \
  --edition=ENTERPRISE \
  --tier="$INSTANCE_TIER" \
  --availability-type=REGIONAL \
  --storage-type=SSD \
  --storage-size=20GB \
  --storage-auto-increase \
  --backup-start-time=03:00 \
  --enable-point-in-time-recovery \
  --retained-backups-count=14 \
  --require-ssl \
  --database-flags=cloudsql.iam_authentication=off

echo "Creating database $DB_NAME..."
gcloud sql databases create "$DB_NAME" \
  --project="$PROJECT_ID" --instance="$INSTANCE_NAME"

echo "Creating user $DB_USER..."
gcloud sql users create "$DB_USER" \
  --project="$PROJECT_ID" --instance="$INSTANCE_NAME" --password="$DB_PASSWORD"

CONNECTION_NAME=$(gcloud sql instances describe "$INSTANCE_NAME" \
  --project="$PROJECT_ID" --format="value(connectionName)")

cat <<EOF

Done. Instance connection name (put this in .env):

  CLOUDSQL_INSTANCE_CONNECTION_NAME=$CONNECTION_NAME
  CLOUDSQL_PASSWORD=$DB_PASSWORD

Run against it via the Cloud SQL Auth Proxy topology:

  docker compose -f docker-compose.cloudsql.yml up -d

Verify HA + backups actually took:

  gcloud sql instances describe $INSTANCE_NAME --project=$PROJECT_ID \\
    --format="yaml(settings.availabilityType,settings.backupConfiguration)"

Teardown (this is a real, continuously-billed resource until you do this):

  gcloud sql instances delete $INSTANCE_NAME --project=$PROJECT_ID
EOF
