-- ============================================================================
-- 0003_payers_providers_contracts.sql
-- Reference data: payers (shared or tenant-scoped), providers, and the
-- payer contracts + fee schedule lines used by underpayment detection.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- PAYER
-- tenant_id NULL     => shared master record visible to every tenant
-- tenant_id NOT NULL => tenant-specific payer (or override with a custom
--                       appeal address / filing limits)
-- ----------------------------------------------------------------------------
CREATE TABLE payer (
  payer_id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid REFERENCES tenant (tenant_id),
  payer_name                text        NOT NULL,
  payer_type                payer_type  NOT NULL,
  payer_id_code             text,                       -- electronic payer ID
  state                     char(2),
  portal_url                text,
  appeal_address            text,
  timely_filing_limit_days  integer CHECK (timely_filing_limit_days > 0),
  appeal_deadline_days      integer CHECK (appeal_deadline_days > 0),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz
);

CREATE INDEX idx_payer_tenant  ON payer (tenant_id);
CREATE INDEX idx_payer_id_code ON payer (payer_id_code);
CREATE INDEX idx_payer_type    ON payer (payer_type);
CREATE INDEX idx_payer_name    ON payer (lower(payer_name));

-- ----------------------------------------------------------------------------
-- PROVIDER — rendering/billing providers under a client
-- ----------------------------------------------------------------------------
CREATE TABLE provider (
  provider_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid          NOT NULL,
  client_id       uuid          NOT NULL,
  npi_individual  text CHECK (npi_individual ~ '^[0-9]{10}$'),
  name            text          NOT NULL,
  specialty       text,
  taxonomy_code   text,
  status          record_status NOT NULL DEFAULT 'active',
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  deleted_at      timestamptz,

  UNIQUE (tenant_id, provider_id),
  UNIQUE (client_id, provider_id),   -- composite target for encounter FK
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

CREATE UNIQUE INDEX uq_provider_npi_live
  ON provider (client_id, npi_individual) WHERE deleted_at IS NULL;
CREATE INDEX idx_provider_tenant ON provider (tenant_id);
CREATE INDEX idx_provider_client ON provider (client_id);
CREATE INDEX idx_provider_status ON provider (client_id, status);

-- ----------------------------------------------------------------------------
-- CONTRACT — a client's agreement with a payer
-- fee_schedule_document_id references document(); the FK is added in
-- migration 0006 after the document table exists.
-- ----------------------------------------------------------------------------
CREATE TABLE contract (
  contract_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid              NOT NULL,
  client_id                 uuid              NOT NULL,
  payer_id                  uuid              NOT NULL REFERENCES payer (payer_id),
  effective_date            date              NOT NULL,
  expiration_date           date,
  fee_schedule_type         fee_schedule_type NOT NULL,
  fee_schedule_document_id  uuid,
  notes                     text,
  created_at                timestamptz       NOT NULL DEFAULT now(),
  updated_at                timestamptz       NOT NULL DEFAULT now(),
  deleted_at                timestamptz,

  UNIQUE (tenant_id, contract_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id),
  CHECK (expiration_date IS NULL OR expiration_date >= effective_date)
);

CREATE INDEX idx_contract_tenant ON contract (tenant_id);
CREATE INDEX idx_contract_client ON contract (client_id);
CREATE INDEX idx_contract_payer  ON contract (payer_id);
CREATE INDEX idx_contract_dates  ON contract (client_id, effective_date, expiration_date);

-- ----------------------------------------------------------------------------
-- CONTRACT_LINE — negotiated rate per procedure code (the "expected amount"
-- source of truth for underpayment detection)
-- ----------------------------------------------------------------------------
CREATE TABLE contract_line (
  contract_line_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL,
  contract_id          uuid        NOT NULL,
  procedure_code       text        NOT NULL,       -- CPT / HCPCS
  modifier             text,
  allowed_amount       numeric(12,2) CHECK (allowed_amount >= 0),
  percent_of_medicare  numeric(7,3)  CHECK (percent_of_medicare > 0),
  effective_date       date,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,

  FOREIGN KEY (tenant_id, contract_id) REFERENCES contract (tenant_id, contract_id),
  -- a line must define a rate one way or the other
  CHECK (allowed_amount IS NOT NULL OR percent_of_medicare IS NOT NULL)
);

-- one live rate per contract/code/modifier/effective date
CREATE UNIQUE INDEX uq_contract_line_rate_live
  ON contract_line (contract_id, procedure_code,
                    COALESCE(modifier, ''), COALESCE(effective_date, '0001-01-01'))
  WHERE deleted_at IS NULL;
CREATE INDEX idx_contract_line_tenant   ON contract_line (tenant_id);
CREATE INDEX idx_contract_line_contract ON contract_line (contract_id);
CREATE INDEX idx_contract_line_code     ON contract_line (procedure_code);

COMMIT;
