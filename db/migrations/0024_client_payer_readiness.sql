-- ============================================================================
-- 0024_client_payer_readiness.sql
-- Versioned client/payer implementation readiness and activation gates.
--
-- Existing clients/configs remain operational for backwards compatibility.
-- Real clients created through the normal BAA-acknowledged application path
-- require explicit payer activation. Dev/demo/legacy inserts without a BAA at
-- creation remain nonblocking unless an operator explicitly enables the gate.
-- ============================================================================

BEGIN;

-- Preserve existing behavior by default. The BEFORE INSERT trigger below
-- enables activation automatically for the normal createClient() path, which
-- supplies BAA acknowledgment in the initial INSERT. This also keeps the demo
-- seed backward-compatible because it attaches its synthetic BAA afterward.
--
-- Migration 0019 deliberately transferred CLIENT ownership to the narrow
-- rcm_catalog_lookup role. The migration runtime keeps non-inheriting SET ROLE
-- membership specifically so later schema migrations can alter that table
-- without restoring a permanent RLS-bypass path.
CREATE OR REPLACE FUNCTION app.default_client_payer_activation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.baa_acknowledged_at IS NOT NULL THEN
    NEW.require_payer_activation := true;
  END IF;
  RETURN NEW;
END $$;

SET LOCAL ROLE rcm_catalog_lookup;
ALTER TABLE client
  ADD COLUMN require_payer_activation boolean NOT NULL DEFAULT false;
CREATE TRIGGER trg_client_default_payer_activation
  BEFORE INSERT ON client
  FOR EACH ROW EXECUTE FUNCTION app.default_client_payer_activation();
RESET ROLE;

-- Existing payer configurations are treated as grandfathered/active so this
-- migration does not silently stop current demo or pilot processing.
ALTER TABLE client_payer_config
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'validation_pending', 'validated', 'active', 'suspended', 'retired')),
  ADD COLUMN detection_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN appeals_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN electronic_submission_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN config_version integer NOT NULL DEFAULT 1 CHECK (config_version > 0),
  ADD COLUMN validation_summary jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(validation_summary) = 'object'),
  ADD COLUMN validated_by uuid REFERENCES app_user (user_id),
  ADD COLUMN validated_at timestamptz,
  ADD COLUMN activated_by uuid REFERENCES app_user (user_id),
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN notes text;

UPDATE client_payer_config
SET validated_at = COALESCE(validated_at, created_at),
    activated_at = COALESCE(activated_at, created_at)
WHERE status = 'active';

-- New configurations fail closed for clients that require activation. Legacy
-- clients can continue using them because the central capability function
-- bypasses these fields when require_payer_activation=false.
ALTER TABLE client_payer_config ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE client_payer_config ALTER COLUMN detection_enabled SET DEFAULT false;
ALTER TABLE client_payer_config ALTER COLUMN appeals_enabled SET DEFAULT false;

ALTER TABLE client_payer_config
  ADD CONSTRAINT cpc_validated_requires_evidence
    CHECK (status NOT IN ('validated', 'active') OR validated_at IS NOT NULL),
  ADD CONSTRAINT cpc_active_requires_activation
    CHECK (status <> 'active' OR activated_at IS NOT NULL),
  ADD CONSTRAINT cpc_electronic_submission_requires_active
    CHECK (NOT electronic_submission_enabled OR status = 'active');

CREATE INDEX idx_cpc_status
  ON client_payer_config (tenant_id, client_id, status);
CREATE INDEX idx_cpc_active_capabilities
  ON client_payer_config (client_id, payer_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX uq_cpc_full_identity
  ON client_payer_config (tenant_id, client_id, payer_id, config_id);

-- Client-specific aliases let EDI payer names/IDs map to a known payer without
-- creating duplicate payer rows. This is configuration data, not global truth.
CREATE TABLE client_payer_alias (
  alias_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  client_id     uuid        NOT NULL,
  payer_id      uuid        NOT NULL REFERENCES payer (payer_id),
  alias_type    text        NOT NULL
    CHECK (alias_type IN ('payer_id', 'name', 'trading_partner_id', 'other')),
  alias_value   text        NOT NULL CHECK (length(trim(alias_value)) > 0),
  source        text,
  verified_at   timestamptz,
  verified_by   uuid REFERENCES app_user (user_id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

CREATE UNIQUE INDEX uq_client_payer_alias_ci
  ON client_payer_alias (client_id, alias_type, lower(alias_value));
CREATE INDEX idx_client_payer_alias_lookup
  ON client_payer_alias (client_id, alias_type, lower(alias_value));
CREATE INDEX idx_client_payer_alias_payer
  ON client_payer_alias (client_id, payer_id);

-- Evidence is intentionally generic: benchmark sets, adjudicated examples,
-- contract checks, submission tests, and security/integration checks can all
-- be represented without changing schema for each implementation partner.
CREATE TABLE client_payer_validation (
  validation_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL,
  client_id        uuid        NOT NULL,
  payer_id         uuid        NOT NULL REFERENCES payer (payer_id),
  config_id        uuid        NOT NULL,
  validation_type  text        NOT NULL
    CHECK (validation_type IN (
      'edi_835', 'edi_837p', 'payer_mapping', 'contract_pricing',
      'historical_claims', 'appeal_rules', 'submission_route',
      'reference_data', 'security', 'other'
    )),
  status           text        NOT NULL
    CHECK (status IN ('pending', 'passed', 'failed', 'waived')),
  sample_size      integer CHECK (sample_size IS NULL OR sample_size >= 0),
  metrics          jsonb       NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metrics) = 'object'),
  evidence         jsonb       NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object'),
  notes            text,
  performed_by     uuid REFERENCES app_user (user_id),
  performed_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id),
  FOREIGN KEY (tenant_id, client_id, payer_id, config_id)
    REFERENCES client_payer_config (tenant_id, client_id, payer_id, config_id)
);

CREATE INDEX idx_client_payer_validation_config
  ON client_payer_validation (config_id, validation_type, performed_at DESC);
CREATE INDEX idx_client_payer_validation_client
  ON client_payer_validation (client_id, payer_id, status);

-- A security-invoker view gives the application/admin UI one stable
-- compatibility matrix surface while preserving the caller's RLS scope.
CREATE VIEW client_payer_compatibility
WITH (security_invoker = true) AS
SELECT
  cpc.tenant_id,
  cpc.client_id,
  cpc.payer_id,
  p.payer_name,
  p.payer_id_code,
  cpc.config_id,
  cpc.config_version,
  cpc.status,
  cpc.detection_enabled,
  cpc.appeals_enabled,
  cpc.electronic_submission_enabled,
  cpc.min_case_threshold,
  cpc.review_threshold,
  cpc.validation_summary,
  cpc.validated_at,
  cpc.activated_at,
  EXISTS (
    SELECT 1 FROM contract ct
    WHERE ct.tenant_id = cpc.tenant_id
      AND ct.client_id = cpc.client_id
      AND ct.payer_id = cpc.payer_id
      AND ct.status = 'active'
      AND ct.deleted_at IS NULL
  ) AS has_active_contract,
  EXISTS (
    SELECT 1 FROM client_payer_validation v
    WHERE v.config_id = cpc.config_id
      AND v.validation_type = 'edi_835'
      AND v.status = 'passed'
  ) AS edi_835_validated,
  EXISTS (
    SELECT 1 FROM client_payer_validation v
    WHERE v.config_id = cpc.config_id
      AND v.validation_type IN ('contract_pricing', 'historical_claims')
      AND v.status = 'passed'
  ) AS contract_pricing_validated,
  EXISTS (
    SELECT 1 FROM client_payer_validation v
    WHERE v.config_id = cpc.config_id
      AND v.validation_type = 'submission_route'
      AND v.status = 'passed'
  ) AS submission_route_validated
FROM client_payer_config cpc
JOIN payer p ON p.payer_id = cpc.payer_id;

-- Central capability gate used by services before enabling production actions.
-- Legacy/dev/demo clients (require_payer_activation=false) preserve prior
-- behavior. SECURITY DEFINER is constrained by the tenant session setting so
-- it cannot become a cross-tenant lookup escape hatch.
CREATE OR REPLACE FUNCTION app.client_payer_capability_enabled(
  p_client uuid,
  p_payer uuid,
  p_capability text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT CASE
    WHEN NOT c.require_payer_activation THEN true
    ELSE COALESCE((
      SELECT cpc.status = 'active' AND CASE p_capability
        WHEN 'detection' THEN cpc.detection_enabled
        WHEN 'appeals' THEN cpc.appeals_enabled
        WHEN 'electronic_submission' THEN cpc.electronic_submission_enabled
        ELSE false
      END
      FROM client_payer_config cpc
      WHERE cpc.client_id = p_client
        AND cpc.payer_id = p_payer
        AND cpc.tenant_id = c.tenant_id
      LIMIT 1
    ), false)
  END
  FROM client c
  WHERE c.client_id = p_client
    AND c.tenant_id = app.current_tenant_id();
$$;

-- RLS / auditing / grants.
ALTER TABLE client_payer_alias ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_payer_alias FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_payer_alias
  FOR ALL USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE client_payer_validation ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_payer_validation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_payer_validation
  FOR ALL USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE TRIGGER trg_client_payer_alias_updated_at
  BEFORE UPDATE ON client_payer_alias
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER trg_audit_client_payer_alias
  AFTER INSERT OR UPDATE OR DELETE ON client_payer_alias
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('alias_id');
CREATE TRIGGER trg_audit_client_payer_validation
  AFTER INSERT OR UPDATE OR DELETE ON client_payer_validation
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('validation_id');
CREATE TRIGGER trg_audit_client_payer_config_readiness
  AFTER UPDATE ON client_payer_config
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('config_id');

GRANT SELECT, INSERT, UPDATE, DELETE ON client_payer_alias, client_payer_validation TO rcm_service;
GRANT SELECT, INSERT, UPDATE ON client_payer_alias, client_payer_validation TO rcm_app;
GRANT SELECT ON client_payer_compatibility TO rcm_app, rcm_service;
GRANT EXECUTE ON FUNCTION app.client_payer_capability_enabled(uuid, uuid, text) TO rcm_app, rcm_service;

COMMIT;
