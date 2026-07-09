-- ============================================================================
-- 0005_claims_remittances.sql
-- Financial transaction layer: claims (837 side) and remittances (835 side).
-- remittance_line carries the CARC/RARC adjustment detail that drives
-- denial and underpayment detection.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- CLAIM
-- ----------------------------------------------------------------------------
CREATE TABLE claim (
  claim_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid          NOT NULL,
  client_id               uuid          NOT NULL,
  encounter_id            uuid          NOT NULL,
  payer_id                uuid          NOT NULL REFERENCES payer (payer_id),
  claim_type              claim_type    NOT NULL,
  claim_number_internal   text          NOT NULL,
  claim_number_payer      text,                       -- payer ICN/DCN
  submission_date         date,
  resubmission_date       date,
  billed_amount           numeric(12,2) NOT NULL DEFAULT 0,
  expected_amount         numeric(12,2),              -- from contract repricing
  paid_amount             numeric(12,2),
  adjustment_amount       numeric(12,2),
  patient_responsibility  numeric(12,2),
  claim_status            claim_status  NOT NULL DEFAULT 'submitted',
  filing_indicator        text,                       -- 837 SBR09 / claim filing code
  raw_837_reference       text,                       -- pointer into raw EDI store
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now(),
  deleted_at              timestamptz,

  UNIQUE (tenant_id, claim_id),
  UNIQUE (client_id, claim_id),      -- composite target for recovery_case FK
  FOREIGN KEY (tenant_id, client_id)   REFERENCES client    (tenant_id, client_id),
  FOREIGN KEY (client_id, encounter_id) REFERENCES encounter (client_id, encounter_id)
);

CREATE UNIQUE INDEX uq_claim_internal_number_live
  ON claim (client_id, claim_number_internal) WHERE deleted_at IS NULL;
CREATE INDEX idx_claim_tenant        ON claim (tenant_id);
CREATE INDEX idx_claim_client        ON claim (client_id);
CREATE INDEX idx_claim_encounter     ON claim (encounter_id);
CREATE INDEX idx_claim_payer         ON claim (payer_id);
CREATE INDEX idx_claim_status        ON claim (client_id, claim_status);
CREATE INDEX idx_claim_payer_number  ON claim (claim_number_payer);
CREATE INDEX idx_claim_submission    ON claim (client_id, submission_date);
-- detection sweep: claims worth reviewing, cheapest via partial index
CREATE INDEX idx_claim_open_recovery ON claim (tenant_id, claim_status)
  WHERE claim_status IN ('denied', 'underpaid', 'rejected') AND deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- CLAIM_LINE
-- ----------------------------------------------------------------------------
CREATE TABLE claim_line (
  claim_line_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid          NOT NULL,
  claim_id                  uuid          NOT NULL,
  line_number               integer       NOT NULL CHECK (line_number > 0),
  procedure_code            text          NOT NULL,
  modifier_1                text,
  modifier_2                text,
  modifier_3                text,
  modifier_4                text,
  revenue_code              text,                     -- facility claims
  units                     numeric(9,3)  NOT NULL DEFAULT 1,
  billed_amount             numeric(12,2) NOT NULL DEFAULT 0,
  expected_amount           numeric(12,2),
  allowed_amount            numeric(12,2),
  paid_amount               numeric(12,2),
  adjustment_code_1         text,
  adjustment_code_2         text,
  adjustment_reason_1       text,
  adjustment_reason_2       text,
  line_status               text,
  denial_reason_code        text,                     -- CARC
  denial_reason_description text,
  created_at                timestamptz   NOT NULL DEFAULT now(),
  updated_at                timestamptz   NOT NULL DEFAULT now(),
  deleted_at                timestamptz,

  UNIQUE (claim_id, line_number),
  UNIQUE (tenant_id, claim_line_id),  -- composite target for downstream FKs
  FOREIGN KEY (tenant_id, claim_id) REFERENCES claim (tenant_id, claim_id)
);

CREATE INDEX idx_claim_line_tenant  ON claim_line (tenant_id);
CREATE INDEX idx_claim_line_claim   ON claim_line (claim_id);
CREATE INDEX idx_claim_line_code    ON claim_line (procedure_code);
CREATE INDEX idx_claim_line_denial  ON claim_line (denial_reason_code)
  WHERE denial_reason_code IS NOT NULL;
CREATE INDEX idx_claim_line_status  ON claim_line (line_status);

-- ----------------------------------------------------------------------------
-- REMITTANCE — one 835 check/EFT from a payer.
-- Ingested financial record: no soft delete, treated as immutable after load.
-- ----------------------------------------------------------------------------
CREATE TABLE remittance (
  remittance_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid          NOT NULL,
  client_id          uuid          NOT NULL,
  payer_id           uuid          NOT NULL REFERENCES payer (payer_id),
  check_date         date,
  check_number       text,
  eft_trace_number   text,
  total_paid         numeric(14,2),
  raw_835_reference  text,
  processed_at       timestamptz,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, remittance_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

CREATE INDEX idx_remit_tenant     ON remittance (tenant_id);
CREATE INDEX idx_remit_client     ON remittance (client_id);
CREATE INDEX idx_remit_payer      ON remittance (payer_id);
CREATE INDEX idx_remit_check_no   ON remittance (check_number);
CREATE INDEX idx_remit_eft_trace  ON remittance (eft_trace_number);
CREATE INDEX idx_remit_check_date ON remittance (client_id, check_date);

-- ----------------------------------------------------------------------------
-- REMITTANCE_LINE — 835 service-line payment detail.
-- claim_id / claim_line_id are NULLABLE: matching to our claims happens in a
-- separate job after ingest, and some lines (e.g. PLB) never match a line.
-- ----------------------------------------------------------------------------
CREATE TABLE remittance_line (
  remittance_line_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid          NOT NULL,
  remittance_id           uuid          NOT NULL,
  claim_id                uuid,
  claim_line_id           uuid,
  procedure_code          text,
  billed_amount           numeric(12,2),
  allowed_amount          numeric(12,2),
  paid_amount             numeric(12,2),
  patient_responsibility  numeric(12,2),
  adjustment_group_code   text,          -- CO / PR / OA / PI
  adjustment_reason_code  text,          -- CARC
  remark_code             text,          -- RARC
  quantity                numeric(9,3),
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, remittance_id) REFERENCES remittance (tenant_id, remittance_id),
  FOREIGN KEY (tenant_id, claim_id)      REFERENCES claim      (tenant_id, claim_id),
  FOREIGN KEY (tenant_id, claim_line_id) REFERENCES claim_line (tenant_id, claim_line_id)
);

CREATE INDEX idx_remit_line_tenant     ON remittance_line (tenant_id);
CREATE INDEX idx_remit_line_remittance ON remittance_line (remittance_id);
CREATE INDEX idx_remit_line_claim      ON remittance_line (claim_id);
CREATE INDEX idx_remit_line_claim_line ON remittance_line (claim_line_id);
CREATE INDEX idx_remit_line_carc       ON remittance_line (adjustment_reason_code);
-- unmatched lines awaiting the match_claims job
CREATE INDEX idx_remit_line_unmatched  ON remittance_line (tenant_id, remittance_id)
  WHERE claim_id IS NULL;

COMMIT;
