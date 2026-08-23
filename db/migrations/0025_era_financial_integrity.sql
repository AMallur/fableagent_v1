-- ============================================================================
-- 0025_era_financial_integrity.sql
--
-- Makes 835 remittance ingestion financially complete and self-checking:
--
--   * remittance_provider_adjustment — PLB (provider-level adjustment) detail.
--     Recoupments, forwarding balances, interest, capitation and penalties are
--     real cash movements that never appear on a CLP claim. Without them a
--     check does not balance and payer takebacks are invisible.
--   * remittance balance columns — the result of the X12 835 balancing rules
--     (service line, claim, transaction) recorded per remittance so an
--     out-of-balance file is a visible, queryable fact rather than silent
--     variance downstream.
--   * remittance_line reversal / adjudication columns — CLP02 = 22 marks a
--     reversal of a previous payment (negative cash). SVC06 carries the
--     originally submitted procedure code when the payer re-coded the line and
--     SVC07 the originally submitted units; both are required to match the
--     line back to our claim and to see downcoding and unit reduction.
--   * payment_event attribution columns — recovered dollars must be
--     attributable to a specific claim line and to the incremental cash the
--     appeal produced, net of reversals and recoupments. Contingency billing
--     and any customer audit of an invoice depend on this arithmetic.
--   * client.era_balance_policy — per-client escape hatch for a trading
--     partner whose ERA does not conform. Defaults to strict.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Per-client ERA balance enforcement policy
-- ----------------------------------------------------------------------------
-- CLIENT is owned by the narrow rcm_catalog_lookup role (migration 0019), so
-- altering it needs the same non-inheriting SET ROLE the readiness migration
-- used rather than a permanent RLS-bypass path.
SET LOCAL ROLE rcm_catalog_lookup;
ALTER TABLE client
  ADD COLUMN era_balance_policy text NOT NULL DEFAULT 'strict'
    CHECK (era_balance_policy IN ('strict', 'warn')),
  ADD COLUMN era_balance_tolerance numeric(8,2) NOT NULL DEFAULT 0.00
    CHECK (era_balance_tolerance >= 0 AND era_balance_tolerance <= 100);

COMMENT ON COLUMN client.era_balance_policy IS
  'strict: an out-of-balance 835 is rejected at ingest. warn: it loads and the '
  'imbalance is recorded on the remittance and in the job log.';
COMMENT ON COLUMN client.era_balance_tolerance IS
  'Per-check absolute dollar tolerance applied to the 835 balancing rules. '
  'Zero means exact. Raise only for a documented trading-partner rounding quirk.';
RESET ROLE;

-- ----------------------------------------------------------------------------
-- Remittance-level balancing outcome
-- ----------------------------------------------------------------------------
ALTER TABLE remittance
  ADD COLUMN balance_status text NOT NULL DEFAULT 'not_checked'
    CHECK (balance_status IN ('balanced', 'out_of_balance', 'not_checked')),
  -- Transaction-level signed variance only. A check can fail the service-line
  -- or claim rule while its total still ties out, so this is not sufficient on
  -- its own — balance_detail carries what actually failed.
  ADD COLUMN balance_variance numeric(14,2),
  ADD COLUMN balance_detail jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(balance_detail) = 'array'),
  ADD COLUMN provider_adjustment_total numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN claim_payment_total numeric(14,2);

COMMENT ON COLUMN remittance.provider_adjustment_total IS
  'Sum of PLB adjustment amounts. Positive reduces the payment (money the '
  'payer kept), matching the X12 sign convention: BPR02 = sum(CLP04) - sum(PLB).';

CREATE INDEX idx_remit_out_of_balance ON remittance (tenant_id, client_id, check_date)
  WHERE balance_status = 'out_of_balance';

-- ----------------------------------------------------------------------------
-- PLB — provider-level adjustments
-- ----------------------------------------------------------------------------
CREATE TABLE remittance_provider_adjustment (
  provider_adjustment_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid          NOT NULL,
  remittance_id           uuid          NOT NULL,
  provider_npi            text,
  fiscal_period_end       date,
  sequence_number         integer       NOT NULL,
  -- PLB03-1: WO overpayment recovery, FB forwarding balance, L6 interest,
  -- 72 authorized return, CS adjustment, AP acceleration of benefits, ...
  reason_code             text          NOT NULL,
  -- PLB03-2: the payer's reference, normally the ICN of the claim being
  -- recouped. This is the link back to the claim that lost the money.
  reference_id            text,
  -- Positive reduces the payment to the provider.
  amount                  numeric(14,2) NOT NULL,
  category                text          NOT NULL DEFAULT 'other'
    CHECK (category IN ('recoupment', 'forwarding_balance', 'interest',
                        'capitation', 'refund', 'penalty', 'transfer', 'other')),
  claim_id                uuid,
  matched_at              timestamptz,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (remittance_id, sequence_number),
  FOREIGN KEY (tenant_id, remittance_id) REFERENCES remittance (tenant_id, remittance_id),
  FOREIGN KEY (tenant_id, claim_id)      REFERENCES claim      (tenant_id, claim_id)
);

CREATE INDEX idx_plb_tenant      ON remittance_provider_adjustment (tenant_id);
CREATE INDEX idx_plb_remittance  ON remittance_provider_adjustment (remittance_id);
CREATE INDEX idx_plb_reference   ON remittance_provider_adjustment (tenant_id, reference_id);
CREATE INDEX idx_plb_claim       ON remittance_provider_adjustment (claim_id)
  WHERE claim_id IS NOT NULL;
CREATE INDEX idx_plb_unmatched   ON remittance_provider_adjustment (tenant_id, remittance_id)
  WHERE claim_id IS NULL;

-- ----------------------------------------------------------------------------
-- Reversal and adjudication detail on the service line
-- ----------------------------------------------------------------------------
ALTER TABLE remittance_line
  -- CLP02 claim status: 1 processed primary, 4 denied, 22 reversal of a
  -- previous payment, ...
  ADD COLUMN claim_status_code text,
  ADD COLUMN is_reversal boolean NOT NULL DEFAULT false,
  -- SVC01 when the payer adjudicated a different code than we submitted.
  ADD COLUMN adjudicated_procedure_code text,
  -- SVC05 paid units vs SVC07 originally submitted units.
  ADD COLUMN paid_units numeric(9,3),
  ADD COLUMN original_units numeric(9,3),
  ADD COLUMN payer_recoded boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN remittance_line.procedure_code IS
  'The procedure code that identifies OUR claim line: SVC06 (originally '
  'submitted) when the payer re-coded, otherwise SVC01.';
COMMENT ON COLUMN remittance_line.adjudicated_procedure_code IS
  'SVC01 — the code the payer actually adjudicated. Differs from '
  'procedure_code only when payer_recoded is true.';

CREATE INDEX idx_remit_line_reversal ON remittance_line (tenant_id, claim_id)
  WHERE is_reversal;
CREATE INDEX idx_remit_line_recoded ON remittance_line (tenant_id, claim_id)
  WHERE payer_recoded;

-- ----------------------------------------------------------------------------
-- Recovery attribution — what an invoice line can be defended with
-- ----------------------------------------------------------------------------
ALTER TABLE payment_event
  ADD COLUMN claim_line_id uuid,
  ADD COLUMN attribution_basis text NOT NULL DEFAULT 'incremental_net'
    CHECK (attribution_basis IN ('incremental_net', 'gross_post_appeal', 'manual')),
  -- Which scope the cash was attributed on. 'claim_line' is the accurate one
  -- and is used whenever the case names a line; 'claim' is the fallback for a
  -- case with no line, and for remittance detail the payer never resolved to
  -- a line (a header-only ERA row).
  ADD COLUMN attribution_scope text NOT NULL DEFAULT 'claim_line'
    CHECK (attribution_scope IN ('claim_line', 'claim')),
  -- Post-appeal cash on the claim that no service line could be resolved to.
  -- It is attributed for want of anything better; a nonzero value here is the
  -- part of an invoice line a customer is most likely to question.
  ADD COLUMN unallocated_paid numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN pre_appeal_paid numeric(14,2),
  ADD COLUMN gross_post_appeal_paid numeric(14,2),
  ADD COLUMN reversals_netted numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN recoupments_netted numeric(14,2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT payment_event_claim_line_fk
    FOREIGN KEY (tenant_id, claim_line_id) REFERENCES claim_line (tenant_id, claim_line_id);

-- A payer clawing money back after an appeal is a distinct workflow event, not
-- a generic note. PostgreSQL allows adding an enum value inside a transaction
-- as long as it is not used in the same transaction, which it is not here.
ALTER TYPE case_action_type ADD VALUE IF NOT EXISTS 'payment_recouped';

COMMENT ON COLUMN payment_event.attribution_basis IS
  'incremental_net: post-appeal cash on the attributed line, net of reversals '
  'and PLB recoupments, minus what was already credited. This is the only '
  'basis the automatic reconciler produces.';

CREATE INDEX idx_payment_event_claim_line ON payment_event (claim_line_id)
  WHERE claim_line_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- RLS, updated_at, auditing, grants
-- ----------------------------------------------------------------------------
ALTER TABLE remittance_provider_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE remittance_provider_adjustment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON remittance_provider_adjustment
  FOR ALL USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE TRIGGER trg_remittance_provider_adjustment_updated_at
  BEFORE UPDATE ON remittance_provider_adjustment
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TRIGGER trg_audit_remittance_provider_adjustment
  AFTER INSERT OR UPDATE OR DELETE ON remittance_provider_adjustment
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('provider_adjustment_id');

GRANT SELECT, INSERT, UPDATE ON remittance_provider_adjustment TO rcm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON remittance_provider_adjustment TO rcm_service;

COMMIT;
