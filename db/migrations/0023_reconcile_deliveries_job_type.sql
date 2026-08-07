-- Adds the job_type value for the outbound-delivery acknowledgement
-- reconciliation job (reconcileChangeHealthcareDelivery, run per-delivery
-- by runDeliveryReconciliation) — the "reconcile acknowledgements" gate in
-- docs/PRODUCTION_READINESS.md gate 4.
--
-- migrate.sh wraps every migration in one transaction (psql -1). PostgreSQL
-- allows ALTER TYPE ... ADD VALUE inside a transaction, but the new value
-- cannot be used by another statement in that same transaction — this
-- migration only adds the value and does nothing else, so that's fine.
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'reconcile_deliveries';
