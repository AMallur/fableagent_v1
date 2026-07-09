-- ============================================================================
-- 0009_detection_engine_support.sql
-- Columns and reference tables required by the claims processing / recovery
-- detection engine (engine/):
--   * matching hints + match outcome on remittance_line (an 835 line must
--     carry its own identifying data so it can be matched after ingest)
--   * expected-amount provenance on claim_line (contract vs medicare proxy)
--   * appealability scoring fields on recovery_case
--   * medicare_fee_schedule — global reference rates (proxy pricing)
--   * client_payer_config — autopilot mode per client+payer
--   * per-client recovery alert threshold
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- remittance_line: matching inputs + result
-- ----------------------------------------------------------------------------
ALTER TABLE remittance_line
  ADD COLUMN payer_claim_number  text,   -- 835 CLP07 (payer ICN)
  ADD COLUMN patient_member_id   text,   -- subscriber/member ID from the 835
  ADD COLUMN date_of_service     date,
  ADD COLUMN match_method        text
    CHECK (match_method IN ('payer_claim_number', 'patient_dos_proc_amount',
                            'manual', 'unmatched')),
  ADD COLUMN matched_at          timestamptz;

CREATE INDEX idx_remit_line_payer_claim_no
  ON remittance_line (payer_claim_number);
-- the manual-review queue: processed but unmatched
CREATE INDEX idx_remit_line_review_queue
  ON remittance_line (tenant_id) WHERE match_method = 'unmatched';
-- the engine's work queue: never processed
CREATE INDEX idx_remit_line_unprocessed
  ON remittance_line (tenant_id, remittance_id) WHERE match_method IS NULL;

-- ----------------------------------------------------------------------------
-- claim_line: where did expected_amount come from?
-- ----------------------------------------------------------------------------
ALTER TABLE claim_line
  ADD COLUMN expected_source text
    CHECK (expected_source IN ('contract', 'medicare_proxy', 'none'));

-- ----------------------------------------------------------------------------
-- recovery_case: classification + scoring outputs
-- ----------------------------------------------------------------------------
ALTER TABLE recovery_case
  ADD COLUMN recovery_likelihood  text
    CHECK (recovery_likelihood IN ('high', 'medium', 'low')),
  ADD COLUMN recommended_action   text,
  ADD COLUMN appealability_score  integer
    CHECK (appealability_score BETWEEN 0 AND 100),
  ADD COLUMN auto_action          boolean NOT NULL DEFAULT false,
  ADD COLUMN expired              boolean NOT NULL DEFAULT false;

CREATE INDEX idx_case_auto_action ON recovery_case (tenant_id, auto_action)
  WHERE auto_action AND deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- medicare_fee_schedule — global reference data (no tenant_id, no RLS),
-- used as proxy pricing when a client has no contract for a payer.
-- ----------------------------------------------------------------------------
CREATE TABLE medicare_fee_schedule (
  medicare_rate_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procedure_code    text          NOT NULL,
  modifier          text,
  rate              numeric(12,2) NOT NULL CHECK (rate >= 0),
  effective_year    integer       NOT NULL,
  locality          text,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_medicare_rate
  ON medicare_fee_schedule (procedure_code, COALESCE(modifier, ''),
                            effective_year, COALESCE(locality, ''));
CREATE INDEX idx_medicare_rate_code ON medicare_fee_schedule (procedure_code);

CREATE TRIGGER trg_medicare_fee_schedule_updated_at
  BEFORE UPDATE ON medicare_fee_schedule
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ----------------------------------------------------------------------------
-- client_payer_config — per client+payer engine behavior (autopilot mode,
-- optional per-payer case threshold override)
-- ----------------------------------------------------------------------------
CREATE TABLE client_payer_config (
  config_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL,
  client_id           uuid        NOT NULL,
  payer_id            uuid        NOT NULL REFERENCES payer (payer_id),
  autopilot_enabled   boolean     NOT NULL DEFAULT false,
  min_case_threshold  numeric(12,2),      -- NULL = engine default
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (client_id, payer_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

CREATE INDEX idx_cpc_tenant ON client_payer_config (tenant_id);
CREATE INDEX idx_cpc_client ON client_payer_config (client_id);

CREATE TRIGGER trg_client_payer_config_updated_at
  BEFORE UPDATE ON client_payer_config
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE client_payer_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_payer_config FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_payer_config
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- ----------------------------------------------------------------------------
-- client: notify the client admin when a run identifies more than this
-- ----------------------------------------------------------------------------
ALTER TABLE client
  ADD COLUMN recovery_alert_threshold numeric(12,2);

-- ----------------------------------------------------------------------------
-- grants for the new tables (0008's blanket grants predate them)
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON medicare_fee_schedule, client_payer_config TO rcm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON medicare_fee_schedule, client_payer_config TO rcm_service;

COMMIT;
