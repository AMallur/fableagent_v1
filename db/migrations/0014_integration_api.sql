-- ============================================================================
-- 0014_integration_api.sql
-- Integration & ingestion layer:
--   * api_key — per-client keys for the public /api/v1 (hash stored, never
--     the key; scopes + per-minute rate limit)
--   * api_request_log — every API call (method, path, status, latency, IP)
--   * outbound_delivery — abstracted outbound connector attempts
--     (clearinghouse / payer portal / PM write-back)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- API keys. Format handed to the client: rcm_<prefix>_<secret>; only
-- sha256(full key) is stored. Prefix is kept for display ("rcm_ab12cd34…").
-- ----------------------------------------------------------------------------
CREATE TABLE api_key (
  api_key_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL,
  client_id              uuid        NOT NULL,
  name                   text        NOT NULL,
  key_prefix             text        NOT NULL,
  key_hash               text        NOT NULL UNIQUE,
  scopes                 text[]      NOT NULL DEFAULT '{read,ingest}',
  rate_limit_per_minute  integer     NOT NULL DEFAULT 120
    CHECK (rate_limit_per_minute BETWEEN 1 AND 10000),
  last_used_at           timestamptz,
  revoked_at             timestamptz,
  created_by             uuid REFERENCES app_user (user_id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

CREATE INDEX idx_api_key_client ON api_key (client_id);

CREATE TRIGGER trg_audit_api_key
  AFTER INSERT OR UPDATE OR DELETE ON api_key
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('api_key_id');

-- ----------------------------------------------------------------------------
-- API request log — append-only, high volume (bigint identity)
-- ----------------------------------------------------------------------------
CREATE TABLE api_request_log (
  request_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid        NOT NULL,
  api_key_id   uuid REFERENCES api_key (api_key_id),
  method       text        NOT NULL,
  path         text        NOT NULL,
  status       integer     NOT NULL,
  duration_ms  integer,
  ip_address   inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_log_key ON api_request_log (api_key_id, created_at DESC);
CREATE INDEX idx_api_log_tenant ON api_request_log (tenant_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- Outbound connector deliveries (Phase-2 hooks). A connector implementation
-- transitions queued -> sent/failed; the stub connectors record
-- 'not_configured' so every submission attempt is visible now.
-- ----------------------------------------------------------------------------
CREATE TABLE outbound_delivery (
  delivery_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  client_id    uuid        NOT NULL,
  case_id      uuid REFERENCES recovery_case (case_id),
  packet_id    uuid REFERENCES appeal_packet (packet_id),
  connector    text        NOT NULL,        -- waystar | availity | change_healthcare | payer_portal | pm_writeback
  kind         text        NOT NULL CHECK (kind IN ('clearinghouse', 'payer_portal', 'pm_writeback')),
  status       text        NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'failed', 'not_configured')),
  detail       jsonb       NOT NULL DEFAULT '{}',
  attempts     integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

CREATE INDEX idx_outbound_tenant ON outbound_delivery (tenant_id, created_at DESC);
CREATE INDEX idx_outbound_queue ON outbound_delivery (status) WHERE status = 'queued';

-- ----------------------------------------------------------------------------
-- RLS, updated_at, grants
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_key', 'api_request_log', 'outbound_delivery']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
       USING (tenant_id = app.current_tenant_id())
       WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END $$;

CREATE TRIGGER trg_api_key_updated_at BEFORE UPDATE ON api_key
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER trg_outbound_delivery_updated_at BEFORE UPDATE ON outbound_delivery
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

GRANT SELECT, INSERT, UPDATE ON api_key, api_request_log, outbound_delivery TO rcm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_key, api_request_log, outbound_delivery TO rcm_service;

COMMIT;
