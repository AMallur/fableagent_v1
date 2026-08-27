-- ============================================================================
-- 0028_go_live_controls.sql
--
-- The controls a real deployment needs before it touches a customer's money.
--
--   OPERATING MODE. A recovery platform's first weeks at a clinic should not
--   submit anything to a payer or invoice anybody — it should detect, price
--   and prepare, so the provider can compare its findings against their own
--   billers before anything irreversible happens. That is how these engagements
--   are actually run, and until now the platform had no way to express it:
--   autopilot was the only switch, and it was per payer. `operating_mode` makes
--   the pilot posture a property of the client that the scheduler, the delivery
--   path and the billing path all read. NEW clients start in 'shadow'; every
--   existing client is explicitly moved to 'live' below so no running
--   deployment changes behavior.
--
--   SIGNED TERMS. Charging a contingency against somebody's recovered cash
--   without a countersigned document naming the percentage and the attribution
--   basis is not a billing feature, it is a dispute waiting to happen.
--   pricing_plan now records the agreement it implements, and an invoice
--   cannot be ISSUED under a plan that names none.
--
--   GO-LIVE RECORD. Who cleared this client for live operation, when, and
--   against which preflight result — so the answer to "who decided we could
--   start billing them" is a row rather than somebody's memory.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Client operating mode and the go-live record
-- ----------------------------------------------------------------------------
-- CLIENT is owned by the restricted pre-tenant catalog role (0019).
SET LOCAL ROLE rcm_catalog_lookup;

ALTER TABLE client
  -- 'shadow'    detect, price, prepare packets — never transmit to a payer,
  --             never issue an invoice. The pilot posture.
  -- 'live'      full operation under the configured autopilot and billing.
  ADD COLUMN operating_mode text NOT NULL DEFAULT 'shadow'
    CHECK (operating_mode IN ('shadow', 'live')),
  ADD COLUMN go_live_at timestamptz,
  ADD COLUMN go_live_approved_by uuid,
  -- The preflight result the approver was looking at. Kept as text rather than
  -- a foreign key because it is evidence of a moment, not live state.
  ADD COLUMN go_live_evidence text;

COMMENT ON COLUMN client.operating_mode IS
  'shadow: the engine detects and prepares but nothing reaches a payer and no '
  'invoice may be issued. live: normal operation. New clients start in shadow '
  'deliberately — the first weeks of an engagement are for comparing findings '
  'against the provider''s own billers, not for irreversible action.';

-- Existing clients were operating before this column existed; moving them to
-- shadow would silently stop production work.
UPDATE client SET operating_mode = 'live' WHERE deleted_at IS NULL;

RESET ROLE;

-- ----------------------------------------------------------------------------
-- Signed commercial terms behind a pricing plan
-- ----------------------------------------------------------------------------
ALTER TABLE pricing_plan
  -- The countersigned order form / amendment this plan implements.
  ADD COLUMN agreement_reference text,
  ADD COLUMN agreement_executed_on date,
  -- The attribution basis the customer actually agreed to, recorded next to
  -- the fee rather than only as a client setting somebody can change later.
  ADD COLUMN agreed_attribution_basis text
    CHECK (agreed_attribution_basis IS NULL
           OR agreed_attribution_basis IN ('incremental_net', 'gross_post_appeal'));

COMMENT ON COLUMN pricing_plan.agreement_reference IS
  'The executed order form or amendment this plan implements. An invoice '
  'cannot be issued under a plan that names none: a contingency charged '
  'against a customer''s cash has to point at a document they signed.';

-- ----------------------------------------------------------------------------
-- Go-live preflight results, kept as evidence
-- ----------------------------------------------------------------------------
CREATE TABLE go_live_check (
  go_live_check_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant (tenant_id),
  client_id        uuid NOT NULL,
  -- 'cleared' means every blocking check passed at this moment.
  cleared          boolean NOT NULL,
  blocking_failures integer NOT NULL DEFAULT 0,
  warnings          integer NOT NULL DEFAULT 0,
  -- The full check list as evaluated, so a later dispute can see exactly what
  -- was true when somebody pressed the button.
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object'),
  checked_by       uuid REFERENCES app_user (user_id),
  checked_at       timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

CREATE INDEX idx_go_live_check_client ON go_live_check (tenant_id, client_id, checked_at DESC);

ALTER TABLE go_live_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE go_live_check FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON go_live_check
  FOR ALL USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE TRIGGER trg_audit_go_live_check
  AFTER INSERT OR UPDATE OR DELETE ON go_live_check
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('go_live_check_id');

GRANT SELECT, INSERT ON go_live_check TO rcm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON go_live_check TO rcm_service;

-- ----------------------------------------------------------------------------
-- Shadow mode is enforced in the database too, not only in application code
-- ----------------------------------------------------------------------------
-- The scheduler, the web layer and the public API all read this, and a single
-- enforcement point means the rule cannot be applied in one place and forgotten
-- in another. Takes the tenant explicitly for the same reason as 0026's
-- entitlement functions: a check that denies whenever the session GUC was not
-- set would silently stop production work.
SET LOCAL ROLE rcm_catalog_lookup;

CREATE OR REPLACE FUNCTION app.client_is_live(p_tenant uuid, p_client uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT COALESCE((
    SELECT c.operating_mode = 'live'
      FROM client c
     WHERE c.tenant_id = p_tenant AND c.client_id = p_client AND c.deleted_at IS NULL
  ), false);
$$;

COMMENT ON FUNCTION app.client_is_live(uuid, uuid) IS
  'False for a client in shadow mode or one that does not exist. Callers must '
  'treat false as "prepare but do not transmit and do not bill".';

GRANT EXECUTE ON FUNCTION app.client_is_live(uuid, uuid)
  TO SESSION_USER, rcm_app, rcm_service;

RESET ROLE;

COMMIT;
