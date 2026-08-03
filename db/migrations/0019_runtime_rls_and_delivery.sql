-- Runtime hardening for real non-superuser Cloud SQL connections.
BEGIN;

-- Scheduler discovery is pre-tenant by definition. Expose only the small
-- operational catalog it needs through a SECURITY DEFINER function; never
-- grant the scheduler a general RLS bypass.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rcm_catalog_lookup') THEN
    CREATE ROLE rcm_catalog_lookup NOLOGIN;
  END IF;
END $$;
-- Idempotent across PostgreSQL versions and pre-provisioned managed roles;
-- PostgreSQL 16 may already grant the role creator ADMIN membership.
DO $$
BEGIN
  IF NOT pg_has_role(CURRENT_USER, 'rcm_catalog_lookup', 'MEMBER') THEN
    EXECUTE format(
      'GRANT rcm_catalog_lookup TO %I WITH ADMIN OPTION', CURRENT_USER
    );
  END IF;
END $$;
-- Tables live in public, so the new owner needs CREATE there during ALTER
-- OWNER. Revoke it as soon as the ownership transfers finish.
GRANT USAGE, CREATE ON SCHEMA public, app TO rcm_catalog_lookup;

ALTER TABLE tenant OWNER TO rcm_catalog_lookup;
ALTER TABLE tenant NO FORCE ROW LEVEL SECURITY;
ALTER TABLE client OWNER TO rcm_catalog_lookup;
ALTER TABLE client NO FORCE ROW LEVEL SECURITY;
REVOKE CREATE ON SCHEMA public FROM rcm_catalog_lookup;
GRANT SELECT, INSERT, UPDATE ON tenant, client TO CURRENT_USER;

CREATE OR REPLACE FUNCTION app.list_active_clients()
RETURNS TABLE (
  client_id uuid, tenant_id uuid, client_name text, timezone text,
  nightly_run_time text, ingest_folder text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT c.client_id, c.tenant_id, c.client_name, c.timezone,
         c.nightly_run_time::text, c.ingest_folder
  FROM client c JOIN tenant t ON t.tenant_id = c.tenant_id
  WHERE c.status = 'active' AND c.deleted_at IS NULL
    AND t.status = 'active' AND t.deleted_at IS NULL
$$;
ALTER FUNCTION app.list_active_clients() OWNER TO rcm_catalog_lookup;
REVOKE ALL ON FUNCTION app.list_active_clients() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_active_clients() TO CURRENT_USER, rcm_app, rcm_service;

-- SFTP authentication also starts before the tenant is known. Resolve only
-- the tenant id, then perform the credential lookup under normal RLS.
ALTER TABLE client_integration OWNER TO rcm_pretenant_lookup;
ALTER TABLE client_integration NO FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON client_integration TO CURRENT_USER;
CREATE OR REPLACE FUNCTION app.resolve_tenant_by_sftp_username(p_username text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT tenant_id FROM client_integration
  WHERE sftp_inbound_username = p_username AND sftp_inbound_enabled = true
$$;
ALTER FUNCTION app.resolve_tenant_by_sftp_username(text) OWNER TO rcm_pretenant_lookup;
REVOKE ALL ON FUNCTION app.resolve_tenant_by_sftp_username(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_tenant_by_sftp_username(text)
  TO CURRENT_USER, rcm_app, rcm_service;

-- Durable outbox leasing and bounded retries.
ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS email_outbox_status_check;
ALTER TABLE email_outbox
  ADD CONSTRAINT email_outbox_status_check
    CHECK (status IN ('queued', 'processing', 'sent', 'failed')),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN locked_at timestamptz;
CREATE INDEX idx_outbox_delivery
  ON email_outbox (next_attempt_at, created_at)
  WHERE status IN ('queued', 'processing');

-- Shared rate windows work across replicas and survive process restarts.
CREATE TABLE api_rate_window (
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  api_key_id uuid NOT NULL REFERENCES api_key (api_key_id),
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, window_start)
);
ALTER TABLE api_rate_window ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_rate_window FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_rate_window FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON api_rate_window TO CURRENT_USER, rcm_app, rcm_service;

CREATE TABLE auth_rate_window (
  source_key text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (source_key, window_start)
);
REVOKE ALL ON auth_rate_window FROM PUBLIC;
CREATE OR REPLACE FUNCTION app.check_auth_rate(p_source text, p_limit integer DEFAULT 20)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE n integer;
BEGIN
  INSERT INTO auth_rate_window (source_key, window_start, request_count)
  VALUES (p_source, date_trunc('minute', now()), 1)
  ON CONFLICT (source_key, window_start)
  DO UPDATE SET request_count = auth_rate_window.request_count + 1
  RETURNING request_count INTO n;
  DELETE FROM auth_rate_window WHERE window_start < now() - interval '1 day';
  RETURN n <= p_limit;
END $$;
REVOKE ALL ON FUNCTION app.check_auth_rate(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.check_auth_rate(text, integer) TO CURRENT_USER, rcm_app;

CREATE TABLE scheduler_lease (
  lease_key text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (tenant_id),
  client_id uuid,
  job_type text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE scheduler_lease ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduler_lease FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scheduler_lease FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON scheduler_lease TO CURRENT_USER, rcm_app, rcm_service;

CREATE UNIQUE INDEX uq_outbound_packet_sent
  ON outbound_delivery (packet_id, kind)
  WHERE packet_id IS NOT NULL AND status = 'sent';

COMMIT;
