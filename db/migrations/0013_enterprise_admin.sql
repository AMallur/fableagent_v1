-- ============================================================================
-- 0013_enterprise_admin.sql
-- Enterprise administration layer:
--   * tenant security policy (session timeout, MFA enforcement)
--   * user security state (lockout, password rotation, MFA secret, invites)
--   * client subscription / feature flags / BAA acknowledgment
--   * sso_config (SAML 2.0 per tenant), client_integration, onboarding_step,
--     data_export_request, invoice
--   * audit_log made immutable at the database level
--   * PHI access logging function (SECURITY DEFINER, like write_audit)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- tenant security policy
-- ----------------------------------------------------------------------------
ALTER TABLE tenant
  ADD COLUMN session_timeout_minutes integer NOT NULL DEFAULT 30
    CHECK (session_timeout_minutes BETWEEN 5 AND 720),
  ADD COLUMN enforce_mfa boolean NOT NULL DEFAULT true;   -- admin roles must use TOTP

-- ----------------------------------------------------------------------------
-- user security state
-- ----------------------------------------------------------------------------
ALTER TABLE app_user
  ADD COLUMN failed_login_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN password_changed_at timestamptz,
  ADD COLUMN mfa_secret text,                 -- AES-256-GCM encrypted at rest
  ADD COLUMN invite_token text,
  ADD COLUMN invite_expires_at timestamptz;

CREATE UNIQUE INDEX uq_app_user_invite_token ON app_user (invite_token)
  WHERE invite_token IS NOT NULL;

-- ----------------------------------------------------------------------------
-- client subscription, feature flags, BAA
-- ----------------------------------------------------------------------------
ALTER TABLE client
  ADD COLUMN subscription_status text NOT NULL DEFAULT 'trial'
    CHECK (subscription_status IN ('trial', 'active', 'suspended', 'cancelled')),
  ADD COLUMN features jsonb NOT NULL DEFAULT
    '{"detection": true, "appeals": true, "automation": true, "analytics": true}',
  ADD COLUMN baa_acknowledged_at timestamptz,
  ADD COLUMN baa_acknowledged_by uuid REFERENCES app_user (user_id);

-- per-payer review threshold override (client-level default lives on client)
ALTER TABLE client_payer_config
  ADD COLUMN review_threshold numeric(12,2);

-- ----------------------------------------------------------------------------
-- SSO / SAML 2.0 per tenant
-- ----------------------------------------------------------------------------
CREATE TABLE sso_config (
  sso_config_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL UNIQUE REFERENCES tenant (tenant_id),
  enabled              boolean     NOT NULL DEFAULT false,
  idp_entity_id        text,
  idp_sso_url          text,
  idp_certificate      text,                   -- x509 PEM (public)
  group_attribute      text        NOT NULL DEFAULT 'groups',
  group_role_mappings  jsonb       NOT NULL DEFAULT '[]',  -- [{group, role}]
  default_role         text        NOT NULL DEFAULT 'viewer',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- client integration settings (SFTP drop, clearinghouse, PM/EHR)
-- ----------------------------------------------------------------------------
CREATE TABLE client_integration (
  integration_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid        NOT NULL,
  client_id                uuid        NOT NULL UNIQUE,
  sftp_host                text,
  sftp_port                integer     NOT NULL DEFAULT 22,
  sftp_username            text,
  sftp_password_encrypted  text,               -- AES-256-GCM, never plaintext
  sftp_path                text,
  clearinghouse_name       text,
  clearinghouse_status     text NOT NULL DEFAULT 'not_configured'
    CHECK (clearinghouse_status IN ('not_configured', 'configured', 'tested')),
  pm_system                text,
  pm_status                text NOT NULL DEFAULT 'not_connected'
    CHECK (pm_status IN ('not_connected', 'configured', 'connected')),
  last_tested_at           timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

-- ----------------------------------------------------------------------------
-- onboarding checklist
-- ----------------------------------------------------------------------------
CREATE TABLE onboarding_step (
  step_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  client_id     uuid        NOT NULL,
  step_number   integer     NOT NULL,
  step_key      text        NOT NULL,
  label         text        NOT NULL,
  completed_at  timestamptz,
  completed_by  uuid REFERENCES app_user (user_id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (client_id, step_key),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

-- ----------------------------------------------------------------------------
-- data export approval workflow
-- ----------------------------------------------------------------------------
CREATE TABLE data_export_request (
  export_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenant (tenant_id),
  requested_by  uuid        NOT NULL REFERENCES app_user (user_id),
  export_type   text        NOT NULL CHECK (export_type IN ('cases', 'audit_trail', 'phi_access')),
  params        jsonb       NOT NULL DEFAULT '{}',
  status        text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'downloaded')),
  approved_by   uuid REFERENCES app_user (user_id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_export_tenant ON data_export_request (tenant_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- invoices (usage-based, generated per client per month)
-- ----------------------------------------------------------------------------
CREATE TABLE invoice (
  invoice_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL,
  client_id         uuid        NOT NULL,
  period_start      date        NOT NULL,
  period_end        date        NOT NULL,
  plan              text        NOT NULL,
  claims_processed  integer     NOT NULL DEFAULT 0,
  cases_created     integer     NOT NULL DEFAULT 0,
  amount_recovered  numeric(14,2) NOT NULL DEFAULT 0,
  amount_due        numeric(12,2) NOT NULL DEFAULT 0,
  status            text        NOT NULL DEFAULT 'issued'
    CHECK (status IN ('draft', 'issued', 'paid')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (client_id, period_start),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

-- ----------------------------------------------------------------------------
-- audit_log immutability — enforced in the database, not just by grants.
-- Even the table owner cannot UPDATE or DELETE (superuser DDL excepted, which
-- is a database-administration boundary, not an application role).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.block_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END $$;

CREATE TRIGGER trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.block_audit_mutation();

REVOKE UPDATE, DELETE ON audit_log FROM rcm_service;

-- ----------------------------------------------------------------------------
-- PHI access logging — SECURITY DEFINER so the app role (which has no direct
-- INSERT on audit_log, preventing forgery) can still record PHI reads.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.log_phi_access(
  p_tenant uuid, p_user uuid, p_patient uuid, p_context text, p_ip inet
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
BEGIN
  INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id,
                         after_state, ip_address)
  VALUES (p_tenant, p_user, 'phi_accessed', 'patient', p_patient,
          jsonb_build_object('context', p_context), p_ip);
END $$;

-- generic security-event logging (login failures, lockouts, MFA events, …)
CREATE OR REPLACE FUNCTION app.log_security_event(
  p_tenant uuid, p_user uuid, p_action text, p_detail jsonb, p_ip inet
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
BEGIN
  INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id,
                         after_state, ip_address)
  VALUES (p_tenant, p_user, p_action, 'app_user', p_user, p_detail, p_ip);
END $$;

-- ----------------------------------------------------------------------------
-- RLS, updated_at, grants for the new tables
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sso_config', 'client_integration', 'onboarding_step',
                           'data_export_request', 'invoice']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
       USING (tenant_id = app.current_tenant_id())
       WITH CHECK (tenant_id = app.current_tenant_id())', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()', t, t);
  END LOOP;
END $$;

CREATE TRIGGER trg_audit_sso_config
  AFTER INSERT OR UPDATE OR DELETE ON sso_config
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('sso_config_id');
CREATE TRIGGER trg_audit_client_integration
  AFTER INSERT OR UPDATE OR DELETE ON client_integration
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('integration_id');

GRANT SELECT, INSERT, UPDATE ON sso_config, client_integration, onboarding_step,
  data_export_request, invoice TO rcm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sso_config, client_integration,
  onboarding_step, data_export_request, invoice TO rcm_service;
GRANT EXECUTE ON FUNCTION app.log_phi_access TO rcm_app, rcm_service;
GRANT EXECUTE ON FUNCTION app.log_security_event TO rcm_app, rcm_service;

COMMIT;
