-- ============================================================================
-- 0002_tenancy_and_users.sql
-- Core tenancy chain: tenant -> client, plus users.
--
-- Conventions used from here on:
--   * UUID primary keys via gen_random_uuid().
--   * Every tenant-scoped table carries a denormalized tenant_id NOT NULL so
--     row-level security is a single-column check (no joins in policies).
--   * Parents expose UNIQUE (tenant_id, <pk>) so children can declare
--     composite foreign keys — the database itself makes a cross-tenant
--     reference impossible, not just the application layer.
--   * Soft delete via deleted_at; unique business keys are partial indexes
--     scoped to live rows so a deleted record's key can be reused.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- TENANT — top of the hierarchy (provider group, billing company, health system)
-- ----------------------------------------------------------------------------
CREATE TABLE tenant (
  tenant_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_name        text          NOT NULL,
  tenant_type        tenant_type   NOT NULL,
  subscription_tier  text          NOT NULL DEFAULT 'standard',
  status             record_status NOT NULL DEFAULT 'active',
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE UNIQUE INDEX uq_tenant_name_live
  ON tenant (lower(tenant_name)) WHERE deleted_at IS NULL;
CREATE INDEX idx_tenant_status ON tenant (status);

-- ----------------------------------------------------------------------------
-- CLIENT — billable entity under a tenant (a billing company has many;
-- a provider group is typically its own single client)
-- ----------------------------------------------------------------------------
CREATE TABLE client (
  client_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid          NOT NULL REFERENCES tenant (tenant_id),
  client_name              text          NOT NULL,
  tax_id                   text,                                   -- TIN
  npi_group                text CHECK (npi_group ~ '^[0-9]{10}$'),
  specialty                text,
  state                    char(2),
  contract_effective_date  date,
  status                   record_status NOT NULL DEFAULT 'active',
  created_at               timestamptz   NOT NULL DEFAULT now(),
  updated_at               timestamptz   NOT NULL DEFAULT now(),
  deleted_at               timestamptz,

  -- composite target for children's tenant-consistency FKs
  UNIQUE (tenant_id, client_id)
);

CREATE INDEX idx_client_tenant        ON client (tenant_id);
CREATE INDEX idx_client_tenant_status ON client (tenant_id, status);
CREATE INDEX idx_client_tax_id        ON client (tax_id);
CREATE INDEX idx_client_npi_group     ON client (npi_group);
CREATE UNIQUE INDEX uq_client_name_live
  ON client (tenant_id, lower(client_name)) WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- APP_USER — "user" is a reserved word in PostgreSQL, hence app_user.
-- client_id NULL  => tenant-wide user (tenant_admin, biller across clients)
-- client_id set   => scoped to a single client
-- ----------------------------------------------------------------------------
CREATE TABLE app_user (
  user_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid          NOT NULL REFERENCES tenant (tenant_id),
  client_id    uuid,
  email        citext        NOT NULL,
  first_name   text,
  last_name    text,
  role         user_role     NOT NULL DEFAULT 'viewer',
  status       record_status NOT NULL DEFAULT 'active',
  last_login   timestamptz,
  mfa_enabled  boolean       NOT NULL DEFAULT false,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  deleted_at   timestamptz,

  UNIQUE (tenant_id, user_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

CREATE UNIQUE INDEX uq_app_user_email_live
  ON app_user (tenant_id, email) WHERE deleted_at IS NULL;
CREATE INDEX idx_app_user_tenant ON app_user (tenant_id);
CREATE INDEX idx_app_user_client ON app_user (client_id);
CREATE INDEX idx_app_user_role   ON app_user (tenant_id, role);

COMMIT;
