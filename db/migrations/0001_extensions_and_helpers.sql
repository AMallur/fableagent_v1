-- ============================================================================
-- 0001_extensions_and_helpers.sql
-- Extensions, helper schema, enum types, and shared trigger functions.
-- Target: PostgreSQL 14+
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;   -- case-insensitive emails

CREATE SCHEMA IF NOT EXISTS app;         -- helper functions live here, out of
                                         -- the way of business tables

-- ----------------------------------------------------------------------------
-- Session context
--
-- The application sets these on every connection (or per transaction with
-- SET LOCAL) after authenticating the caller:
--
--   SET app.current_tenant_id = '<tenant uuid>';
--   SET app.current_user_id   = '<user uuid>';
--
-- Row-level security policies and the audit trigger read them through the
-- functions below. A connection with no tenant set sees zero rows.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ----------------------------------------------------------------------------
-- Enumerated domains
-- ----------------------------------------------------------------------------

CREATE TYPE tenant_type AS ENUM
  ('provider_group', 'billing_company', 'health_system');

-- generic lifecycle status for tenants / clients / providers / users
CREATE TYPE record_status AS ENUM
  ('active', 'inactive', 'suspended', 'pending');

CREATE TYPE user_role AS ENUM
  ('super_admin', 'tenant_admin', 'client_admin', 'biller', 'collector', 'viewer');

CREATE TYPE payer_type AS ENUM
  ('commercial', 'medicare', 'medicaid', 'managed_medicare', 'managed_medicaid');

CREATE TYPE fee_schedule_type AS ENUM
  ('percent_of_medicare', 'fee_schedule', 'per_diem', 'case_rate');

CREATE TYPE claim_type AS ENUM
  ('professional', 'facility');

CREATE TYPE claim_status AS ENUM
  ('submitted', 'accepted', 'rejected', 'denied', 'paid', 'underpaid',
   'appealed', 'closed');

CREATE TYPE case_type AS ENUM
  ('underpayment', 'denial', 'timely_filing', 'authorization', 'duplicate',
   'bundling', 'other');

CREATE TYPE case_status AS ENUM
  ('open', 'in_progress', 'submitted', 'pending_payer', 'won', 'lost',
   'closed_no_action');

CREATE TYPE priority_level AS ENUM
  ('critical', 'high', 'medium', 'low');

CREATE TYPE case_action_type AS ENUM
  ('note', 'appeal_submitted', 'corrected_claim_submitted', 'payer_call_logged',
   'document_uploaded', 'status_changed', 'payment_received');

CREATE TYPE packet_status AS ENUM
  ('draft', 'ready', 'submitted', 'acknowledged');

CREATE TYPE appeal_type AS ENUM
  ('first_level', 'second_level', 'external_review', 'corrected_claim',
   'reopening');

CREATE TYPE submission_method AS ENUM
  ('mail', 'portal', 'fax', 'clearinghouse');

CREATE TYPE document_type AS ENUM
  ('appeal_letter', 'eob', 'medical_record', 'authorization',
   'corrected_claim', 'contract', 'fee_schedule', 'payer_policy', 'other');

CREATE TYPE document_source AS ENUM
  ('user_upload', 'system_generated', 'ingested');

CREATE TYPE job_type AS ENUM
  ('ingest_835', 'ingest_837', 'match_claims', 'run_detection', 'create_cases',
   'generate_appeals', 'reconcile_payments', 'send_alerts');

CREATE TYPE job_status AS ENUM
  ('queued', 'running', 'completed', 'failed');

COMMIT;
