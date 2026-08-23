-- ============================================================================
-- 0026_pricing_cob_and_commercial_terms.sql
--
-- Three groups of change, all aimed at the same thing: a recovery figure that
-- is true, and a fee that can be charged against it.
--
--   PRICING CORRECTNESS. Expected reimbursement was computed as
--   rate x units and compared against payment, which manufactures a shortfall
--   in three very common situations:
--     * the payer reduces the PAYMENT after adjudication (Medicare
--       sequestration is 2% on every claim) — payer.payment_reduction_percent;
--     * the contract pays the LESSER of billed charges and the contracted
--       rate, so a line billed under the rate was never going to pay the rate
--       — contract.apply_lesser_of_billed;
--     * a modifier changes the percentage payable (51 multiple procedure, 50
--       bilateral, 80/AS assistant, 26/TC component split) —
--       modifier_payment_rule.
--   Left uncorrected these three fire on essentially every Medicare line and
--   every modified line, which is what makes a "systemic underpayment" anomaly
--   appear against a payer that is paying correctly.
--
--   COORDINATION OF BENEFITS. Nothing knew whether a claim was primary or
--   secondary. Expected payer liability on a secondary claim is the allowed
--   amount less patient responsibility AND less what the primary already paid;
--   without the last term every secondary claim looks massively underpaid.
--   claim.payer_sequence / prior_payer_paid and claim_line.prior_payer_paid
--   carry it.
--
--   COMMERCIAL TERMS. RCM recovery is sold on contingency, not per case, and
--   an invoice raised against recovered dollars has to survive the customer
--   auditing it against their own remittances. pricing_plan holds the agreed
--   terms, effective-dated; invoice records the arithmetic; invoice_line names
--   every payment_event in the basis; and an issued invoice becomes immutable
--   so a re-run cannot silently rewrite a bill that has already gone out.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Payment reduction applied AFTER adjudication (sequestration and equivalents)
-- ----------------------------------------------------------------------------
ALTER TABLE payer
  ADD COLUMN payment_reduction_percent numeric(6,3) NOT NULL DEFAULT 0
    CHECK (payment_reduction_percent >= 0 AND payment_reduction_percent <= 100);

COMMENT ON COLUMN payer.payment_reduction_percent IS
  'Percentage withheld from the PAYMENT after allowed amount and patient '
  'responsibility are settled — Medicare sequestration is 2.000. It reduces '
  'what the payer owes, not what the contract allows, so it is applied to '
  'expected payer liability rather than to the allowed amount.';

-- ----------------------------------------------------------------------------
-- Lesser of billed charges or the contracted rate
-- ----------------------------------------------------------------------------
ALTER TABLE contract
  ADD COLUMN apply_lesser_of_billed boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN contract.apply_lesser_of_billed IS
  'True (the near-universal contract term) means the payer owes the lesser of '
  'billed charges and the contracted rate, so a line billed below the rate can '
  'never be underpaid against that rate. Set false only for a contract that '
  'genuinely pays the schedule regardless of the charge.';

-- ----------------------------------------------------------------------------
-- Modifier payment rules — percentage payable when a modifier is present.
-- tenant_id NULL = shared default (same convention as payer); payer_id NULL =
-- applies to every payer for that tenant.
-- ----------------------------------------------------------------------------
CREATE TABLE modifier_payment_rule (
  modifier_rule_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid REFERENCES tenant (tenant_id),
  payer_id             uuid REFERENCES payer (payer_id),
  modifier             text          NOT NULL CHECK (modifier ~ '^[A-Z0-9]{2}$'),
  percent_of_allowed   numeric(6,3)  NOT NULL
    CHECK (percent_of_allowed >= 0 AND percent_of_allowed <= 1000),
  -- Lower runs first. Matters because the rules compose multiplicatively:
  -- a bilateral assistant surgery is 150% then 16%, not 166%.
  apply_order          integer       NOT NULL DEFAULT 100,
  description          text,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  deleted_at           timestamptz,

  UNIQUE (tenant_id, payer_id, modifier)
);

CREATE INDEX idx_modifier_rule_lookup
  ON modifier_payment_rule (modifier, tenant_id, payer_id)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE modifier_payment_rule IS
  'Percentage of the otherwise-allowed amount payable when a modifier is on '
  'the line. Seeded with the standard CMS percentages as shared defaults; a '
  'tenant or tenant+payer row overrides them. True multiple-procedure ranking '
  '(MPPR by RVU across the claim) is NOT modeled — modifier 51 applies its '
  'configured percentage, which is how contracts state the term.';

-- Shared defaults, from the CMS physician fee schedule payment policies. A
-- tenant whose contract differs overrides the row rather than editing these.
INSERT INTO modifier_payment_rule (tenant_id, payer_id, modifier, percent_of_allowed, apply_order, description) VALUES
  (NULL, NULL, '50', 150.000, 10, 'Bilateral procedure'),
  (NULL, NULL, '51', 50.000,  20, 'Multiple procedure — subsequent procedure'),
  (NULL, NULL, '52', 50.000,  20, 'Reduced services'),
  (NULL, NULL, '53', 50.000,  20, 'Discontinued procedure'),
  (NULL, NULL, '62', 62.500,  30, 'Two surgeons (co-surgery), each'),
  (NULL, NULL, '80', 16.000,  40, 'Assistant surgeon'),
  (NULL, NULL, '81', 16.000,  40, 'Minimum assistant surgeon'),
  (NULL, NULL, '82', 16.000,  40, 'Assistant surgeon, no qualified resident'),
  (NULL, NULL, 'AS', 13.600,  40, 'Assistant at surgery by NP/PA (85% of 16%)'),
  (NULL, NULL, '78', 70.000,  50, 'Return to OR for related procedure'),
  (NULL, NULL, '55', 20.000,  50, 'Postoperative management only'),
  (NULL, NULL, '56', 10.000,  50, 'Preoperative management only'),
  (NULL, NULL, '54', 70.000,  50, 'Surgical care only');

-- ----------------------------------------------------------------------------
-- Coordination of benefits
-- ----------------------------------------------------------------------------
ALTER TABLE claim
  ADD COLUMN payer_sequence text NOT NULL DEFAULT 'primary'
    CHECK (payer_sequence IN ('primary', 'secondary', 'tertiary', 'unknown')),
  ADD COLUMN prior_payer_paid numeric(12,2)
    CHECK (prior_payer_paid IS NULL OR prior_payer_paid >= 0);

ALTER TABLE claim_line
  ADD COLUMN prior_payer_paid numeric(12,2)
    CHECK (prior_payer_paid IS NULL OR prior_payer_paid >= 0);

COMMENT ON COLUMN claim.payer_sequence IS
  '837 SBR01 payer responsibility sequence. On a secondary or tertiary claim '
  'the expected payer liability is allowed less patient responsibility less '
  'what the prior payer already paid.';
COMMENT ON COLUMN claim.prior_payer_paid IS
  'Claim-level COB amount (837 loop 2320 AMT*D). Line-level detail, when the '
  'payer supplied it (SVD02), lives on claim_line.prior_payer_paid.';

CREATE INDEX idx_claim_secondary ON claim (tenant_id, client_id)
  WHERE payer_sequence <> 'primary' AND deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- Commercial terms
-- ----------------------------------------------------------------------------
CREATE TABLE pricing_plan (
  pricing_plan_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid          NOT NULL REFERENCES tenant (tenant_id),
  -- NULL applies to every client under the tenant; a client row overrides it.
  client_id            uuid,
  plan_name            text          NOT NULL,
  effective_date       date          NOT NULL,
  expiration_date      date,
  -- Fixed monthly platform fee.
  base_fee             numeric(12,2) NOT NULL DEFAULT 0 CHECK (base_fee >= 0),
  -- Per recovery case opened in the period.
  per_case_fee         numeric(12,2) NOT NULL DEFAULT 0 CHECK (per_case_fee >= 0),
  -- The way this work is actually sold: a share of what was recovered.
  contingency_percent  numeric(6,3)  NOT NULL DEFAULT 0
    CHECK (contingency_percent >= 0 AND contingency_percent <= 100),
  minimum_fee          numeric(12,2) NOT NULL DEFAULT 0 CHECK (minimum_fee >= 0),
  maximum_fee          numeric(12,2) CHECK (maximum_fee IS NULL OR maximum_fee >= 0),
  -- Which recoveries the contingency is charged on. 'verified' bills only
  -- recovery a person confirmed; 'attributed' also bills the reconciler's own
  -- incremental_net attribution. Neither ever bills a manual estimate.
  contingency_basis    text          NOT NULL DEFAULT 'attributed'
    CHECK (contingency_basis IN ('attributed', 'verified')),
  notes                text,
  created_by           uuid REFERENCES app_user (user_id),
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  deleted_at           timestamptz,

  CHECK (expiration_date IS NULL OR expiration_date >= effective_date),
  CHECK (maximum_fee IS NULL OR maximum_fee >= minimum_fee),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

CREATE INDEX idx_pricing_plan_lookup
  ON pricing_plan (tenant_id, client_id, effective_date DESC)
  WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- Invoice: the arithmetic, the basis, and immutability once issued
-- ----------------------------------------------------------------------------
ALTER TABLE invoice
  ADD COLUMN invoice_number       text,
  ADD COLUMN pricing_plan_id      uuid REFERENCES pricing_plan (pricing_plan_id),
  ADD COLUMN base_fee             numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN case_fee_total       numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN contingency_percent  numeric(6,3)  NOT NULL DEFAULT 0,
  ADD COLUMN contingency_fee      numeric(12,2) NOT NULL DEFAULT 0,
  -- The recovery the contingency was actually charged on. Distinct from
  -- amount_recovered, which is every dollar that landed in the period:
  -- reversed and recouped money is in one and not the other.
  ADD COLUMN attributed_recovery  numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN minimum_applied      boolean       NOT NULL DEFAULT false,
  ADD COLUMN maximum_applied      boolean       NOT NULL DEFAULT false,
  ADD COLUMN issued_at            timestamptz,
  ADD COLUMN voided_at            timestamptz,
  ADD COLUMN voided_reason        text,
  ADD COLUMN credit_note_for      uuid REFERENCES invoice (invoice_id);

ALTER TABLE invoice DROP CONSTRAINT IF EXISTS invoice_status_check;
ALTER TABLE invoice ADD CONSTRAINT invoice_status_check
  CHECK (status IN ('draft', 'issued', 'paid', 'void'));

CREATE UNIQUE INDEX uq_invoice_number ON invoice (tenant_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

-- One LIVE invoice per client per period. A voided invoice is a dead record
-- kept for the audit trail, so it must not block the corrected one that
-- replaces it — which the original blanket UNIQUE(client_id, period_start) did.
ALTER TABLE invoice DROP CONSTRAINT IF EXISTS invoice_client_id_period_start_key;
CREATE UNIQUE INDEX uq_invoice_live_period ON invoice (client_id, period_start)
  WHERE status <> 'void';

-- One row per recovery the invoice is charging for, so a customer disputing a
-- bill can be answered claim by claim from their own remittances.
CREATE TABLE invoice_line (
  invoice_line_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid          NOT NULL,
  invoice_id        uuid          NOT NULL REFERENCES invoice (invoice_id) ON DELETE CASCADE,
  payment_event_id  uuid,
  case_id           uuid,
  claim_id          uuid,
  claim_number      text,
  payer_name        text,
  payment_date      date,
  amount_recovered  numeric(14,2) NOT NULL,
  contingency_percent numeric(6,3) NOT NULL DEFAULT 0,
  fee               numeric(12,2) NOT NULL DEFAULT 0,
  attribution_basis text,
  created_at        timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (invoice_id, payment_event_id)
);

CREATE INDEX idx_invoice_line_invoice ON invoice_line (invoice_id);
CREATE INDEX idx_invoice_line_tenant  ON invoice_line (tenant_id);
-- A recovery may only be billed once, ever.
CREATE UNIQUE INDEX uq_invoice_line_payment_event
  ON invoice_line (payment_event_id) WHERE payment_event_id IS NOT NULL;

-- An issued invoice is a bill that has left the building. It may be paid or
-- voided; it may not be silently recalculated by the next monthly run.
CREATE OR REPLACE FUNCTION app.protect_issued_invoice() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Deleting a bill that has gone out destroys the record of what was
    -- charged, so the application can never do it. Tearing a whole tenant down
    -- (the demo reseed, a customer termination) is a different act performed by
    -- an administrator, and says so explicitly by setting app.allow_invoice_purge.
    IF OLD.status <> 'draft'
       AND current_setting('app.allow_invoice_purge', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION
        'invoice % has been issued and cannot be deleted; void it instead',
        OLD.invoice_id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Past draft, only the status/payment/void fields may move, and only
  -- forwards: issued -> paid, issued -> void, paid -> void.
  IF NEW.status NOT IN ('paid', 'void') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'invoice % is % and cannot return to %',
      OLD.invoice_id, OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'void' AND NEW.status <> 'void' THEN
    RAISE EXCEPTION 'invoice % is void and cannot be reopened', OLD.invoice_id;
  END IF;
  IF NEW.amount_due IS DISTINCT FROM OLD.amount_due
     OR NEW.attributed_recovery IS DISTINCT FROM OLD.attributed_recovery
     OR NEW.contingency_fee IS DISTINCT FROM OLD.contingency_fee
     OR NEW.base_fee IS DISTINCT FROM OLD.base_fee
     OR NEW.case_fee_total IS DISTINCT FROM OLD.case_fee_total
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number THEN
    RAISE EXCEPTION
      'invoice % has been issued: correct it with a credit note, not by editing it',
      OLD.invoice_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_invoice_immutable_once_issued
  BEFORE UPDATE OR DELETE ON invoice
  FOR EACH ROW EXECUTE FUNCTION app.protect_issued_invoice();

-- ----------------------------------------------------------------------------
-- Subscription and feature enforcement.
--
-- client.subscription_status and client.features were stored and toggled in
-- the admin UI and then read by almost nothing: a suspended or cancelled
-- client kept full web access and the scheduler kept running their nightly
-- processing, and every client got every feature regardless of plan. These two
-- functions are the enforcement point, used by the scheduler, the web session
-- layer and the public API alike so the rule cannot be applied in one place
-- and forgotten in another.
-- ----------------------------------------------------------------------------

-- Both functions take the tenant explicitly rather than reading the session
-- GUC. Relying on the GUC would make them return NULL — and so deny — in any
-- context that had not set it, which is the worst possible failure mode for an
-- entitlement check: features would silently switch themselves off. The tenant
-- argument keeps cross-tenant probing closed without that fragility, and CLIENT
-- is owned by rcm_catalog_lookup, so these run as that role to read it.
SET LOCAL ROLE rcm_catalog_lookup;

-- Processing stops for a suspended or cancelled client. Trial and active both
-- process: a trial that could not be run would not be a trial.
CREATE OR REPLACE FUNCTION app.client_processing_enabled(p_tenant uuid, p_client uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT COALESCE((
    SELECT c.status = 'active'
       AND c.deleted_at IS NULL
       AND c.subscription_status IN ('trial', 'active')
    FROM client c
    WHERE c.client_id = p_client AND c.tenant_id = p_tenant
  ), false)
$$;
REVOKE ALL ON FUNCTION app.client_processing_enabled(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.client_processing_enabled(uuid, uuid)
  TO SESSION_USER, rcm_app, rcm_service;

-- A feature the client's plan does not include is off. An unknown feature name
-- and an unknown client both fail closed.
CREATE OR REPLACE FUNCTION app.client_feature_enabled(
  p_tenant uuid, p_client uuid, p_feature text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT COALESCE((
    SELECT (c.features -> p_feature)::boolean
    FROM client c
    WHERE c.client_id = p_client AND c.tenant_id = p_tenant
  ), false)
$$;
REVOKE ALL ON FUNCTION app.client_feature_enabled(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.client_feature_enabled(uuid, uuid, text)
  TO SESSION_USER, rcm_app, rcm_service;
RESET ROLE;

-- The scheduler's client list now honours the subscription and carries the
-- feature flags, so a nightly run can skip the steps a plan does not include.
-- The function is owned by the narrow rcm_catalog_lookup role (migration
-- 0019), so replacing it has to happen as that role — the same non-inheriting
-- SET ROLE 0019 and 0024 use, rather than a permanent RLS-bypass path.
-- Adding features to the result changes the return type, so the old function
-- has to go first; both statements run as the owner.
SET LOCAL ROLE rcm_catalog_lookup;
DROP FUNCTION IF EXISTS app.list_active_clients();
CREATE FUNCTION app.list_active_clients()
RETURNS TABLE (
  client_id uuid, tenant_id uuid, client_name text, timezone text,
  nightly_run_time text, ingest_folder text, features jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT c.client_id, c.tenant_id, c.client_name, c.timezone,
         c.nightly_run_time::text, c.ingest_folder, c.features
  FROM client c JOIN tenant t ON t.tenant_id = c.tenant_id
  WHERE c.status = 'active' AND c.deleted_at IS NULL
    AND t.status = 'active' AND t.deleted_at IS NULL
    AND c.subscription_status IN ('trial', 'active')
$$;
REVOKE ALL ON FUNCTION app.list_active_clients() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_active_clients() TO SESSION_USER, rcm_app, rcm_service;
RESET ROLE;

-- ----------------------------------------------------------------------------
-- RLS, updated_at, auditing, grants
-- ----------------------------------------------------------------------------
ALTER TABLE pricing_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_plan FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pricing_plan
  FOR ALL USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE invoice_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_line
  FOR ALL USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Shared defaults are readable by everyone; only your own rows are writable,
-- the same split the payer table uses.
ALTER TABLE modifier_payment_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifier_payment_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY modifier_rule_read ON modifier_payment_rule
  FOR SELECT USING (tenant_id IS NULL OR tenant_id = app.current_tenant_id());
CREATE POLICY modifier_rule_insert ON modifier_payment_rule
  FOR INSERT WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY modifier_rule_update ON modifier_payment_rule
  FOR UPDATE USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE TRIGGER trg_pricing_plan_updated_at BEFORE UPDATE ON pricing_plan
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER trg_modifier_payment_rule_updated_at BEFORE UPDATE ON modifier_payment_rule
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TRIGGER trg_audit_pricing_plan
  AFTER INSERT OR UPDATE OR DELETE ON pricing_plan
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('pricing_plan_id');
CREATE TRIGGER trg_audit_modifier_payment_rule
  AFTER INSERT OR UPDATE OR DELETE ON modifier_payment_rule
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('modifier_rule_id');

GRANT SELECT, INSERT, UPDATE ON pricing_plan, invoice_line, modifier_payment_rule TO rcm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON pricing_plan, invoice_line, modifier_payment_rule TO rcm_service;

COMMIT;
