-- ============================================================================
-- 0027_usage_ledger_ncci_and_attribution_policy.sql
--
-- Three changes, each closing a gap between "the platform computed a number"
-- and "the number can be defended to somebody else".
--
--   NCCI PROCEDURE-TO-PROCEDURE EDITS. A CO-97 bundling denial was always
--   answered with "verify NCCI edits; appeal with modifier 59 documentation",
--   which is advice, not an answer. CMS publishes the actual edit pairs and,
--   for each one, whether a modifier may override it at all. With that data
--   loaded the platform can say which of four very different situations this
--   is: an edit that can never be bypassed (indicator 0 — appealing wastes the
--   biller's day), an edit we already billed a bypass modifier against and the
--   payer ignored (a strong appeal), an edit that needs the modifier and the
--   documentation to support it, or no CMS edit at all — the payer applied a
--   proprietary bundling rule, which is a contract argument rather than a
--   coding one. The reference table has existed since 0022 and nothing read
--   it; what is added here is the configuration that makes reading it correct.
--
--   USAGE LEDGER. Invoices were computed from payment_event at generation
--   time. payment_event is a live operational table — reconciliation revises
--   it, a clawback lands on it, an operator corrects a match — so the basis of
--   an invoice that has already gone out could move underneath it. Freezing
--   the invoice figures (0026) stopped the bill changing, but not the
--   underlying evidence. usage_event is the append-only record of billable
--   facts: written once with the amount as it stood, never amended, and the
--   only permitted mutation is being claimed by an invoice or released when
--   that invoice is voided. An issued bill can therefore be reconstructed from
--   the ledger years later and reconciled against the customer's own
--   remittances.
--
--   ATTRIBUTION POLICY. Which post-appeal dollars count as recovery is a
--   commercial term, not an engineering constant: some contracts credit the
--   incremental net movement, some credit gross payment after submission,
--   some cap the window in which payment counts as caused by the appeal, and
--   some forbid a robot reversing a credited recovery at all. Those four were
--   hardcoded. They are now per-client configuration with the previous
--   behavior as the default, so an existing client's numbers do not move.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- NCCI: how to read the edit tables for this payer and this client
-- ----------------------------------------------------------------------------

-- Most payers adopt the CMS NCCI PTP tables. Some commercial payers run their
-- own bundling logic. The distinction changes what the absence of a CMS edit
-- means: against an NCCI payer it is evidence the denial has no basis; against
-- a payer that never claimed to follow NCCI it is a reason to demand the edit
-- rationale in writing, which is a weaker (but still real) position.
ALTER TABLE payer
  ADD COLUMN bundling_edit_source text NOT NULL DEFAULT 'ncci'
    CHECK (bundling_edit_source IN ('ncci', 'proprietary'));

COMMENT ON COLUMN payer.bundling_edit_source IS
  'Which bundling edits this payer adjudicates against. ''ncci'' means the CMS '
  'PTP tables apply, so a bundling denial with no matching edit contradicts the '
  'payer''s own published policy. ''proprietary'' means the payer uses its own '
  'edits and the absence of a CMS edit is an argument to request the rationale '
  'rather than a contradiction.';

-- CMS publishes two PTP tables and they disagree. Which one applies is decided
-- by claim.claim_type — the practitioner table for professional claims, the
-- outpatient-hospital table for facility claims — so it needs no configuration.
--
-- What does need a client's decision is what to DO with an indicator-0 edit:
-- a pair CMS says can never be unbundled by any modifier. 'advisory' keeps
-- opening the case and says plainly that the appeal is not winnable on
-- unbundling grounds, which is the existing behavior. 'suppress_unappealable'
-- stops opening it at all. That changes case counts, worklists and per-case
-- fees, so it is opt-in rather than something the platform decides for them.
-- CLIENT is owned by the restricted pre-tenant catalog role (0019), so this
-- runs as that role rather than opening a permanent RLS-bypass path.
SET LOCAL ROLE rcm_catalog_lookup;

ALTER TABLE client
  ADD COLUMN ncci_bundling_policy text NOT NULL DEFAULT 'advisory'
    CHECK (ncci_bundling_policy IN ('advisory', 'suppress_unappealable')),

  -- ------------------------------------------------------------------------
  -- Attribution policy
  -- ------------------------------------------------------------------------

  -- 'incremental_net' credits the movement in cash since the appeal went
  -- out, net of reversals and recoupments — the defensible default, and what
  -- every existing client is already being measured on.
  -- 'gross_post_appeal' credits every dollar paid after submission. It is
  -- the more generous reading and some contracts are written that way; it is
  -- opt-in precisely because it over-credits a reissued claim.
  ADD COLUMN attribution_basis text NOT NULL DEFAULT 'incremental_net'
    CHECK (attribution_basis IN ('incremental_net', 'gross_post_appeal')),

  -- Payment landing a year after an appeal is rarely that appeal's doing.
  -- NULL keeps the current behavior: no window, every later dollar counts.
  ADD COLUMN attribution_window_days integer
    CHECK (attribution_window_days IS NULL OR attribution_window_days > 0),

  -- Movement below this is noise (a rounding correction, an interest
  -- payment) and is not worth opening a billable event for.
  ADD COLUMN attribution_min_amount numeric(12,2) NOT NULL DEFAULT 0
    CHECK (attribution_min_amount >= 0),

  -- Remittance detail the payer never resolved to a service line carries a
  -- claim and nothing more. Including it risks crediting a sibling line's
  -- payment; excluding it loses real recoveries. Default true preserves
  -- current behavior, and either way the amount is reported separately.
  ADD COLUMN attribution_include_unallocated boolean NOT NULL DEFAULT true,

  -- 'auto' reverses previously credited recovery when the payer takes cash
  -- back. 'flag_only' records and escalates the takeback but leaves the
  -- credited figure alone for a human to decide — which some contracts
  -- require, because the reversal moves an invoice.
  ADD COLUMN clawback_policy text NOT NULL DEFAULT 'auto'
    CHECK (clawback_policy IN ('auto', 'flag_only'));

RESET ROLE;

-- ----------------------------------------------------------------------------
-- Usage ledger: the append-only record behind every invoice
-- ----------------------------------------------------------------------------
CREATE TABLE usage_event (
  usage_event_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant (tenant_id),
  client_id         uuid NOT NULL,

  -- 'recovery_attributed' is cash credited to an appeal; 'recovery_clawed_back'
  -- is cash the payer took back afterwards and carries a negative amount, so
  -- the ledger sums to the billable position without any row being amended.
  event_type        text NOT NULL
    CHECK (event_type IN ('recovery_attributed', 'recovery_clawed_back')),

  -- The date the fact happened, which is what decides the billing period.
  -- recorded_at is when the ledger learned about it; they differ on a backfill
  -- and the difference is exactly what an auditor asks about.
  occurred_at       date        NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),

  -- Frozen at append time. Never recomputed, never adjusted: a correction is
  -- a new row, and that is the entire point of this table.
  amount            numeric(14,2) NOT NULL,

  case_id           uuid,
  claim_id          uuid,
  claim_line_id     uuid,
  payment_event_id  uuid REFERENCES payment_event (payment_event_id),

  attribution_basis text,
  attribution_scope text,
  -- Everything needed to re-derive the amount without the operational tables:
  -- gross, unallocated, reversals, recoupments, claim and payer identity.
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object'),

  -- Claimed by an invoice. The only column on this table that may ever change,
  -- and only NULL -> invoice (billed) or invoice -> NULL (that invoice voided).
  invoice_id        uuid REFERENCES invoice (invoice_id) ON DELETE SET NULL,

  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

-- One ledger row per payment_event, forever. This is what makes the sync
-- idempotent: re-running it can only fail to insert, never double-count.
CREATE UNIQUE INDEX uq_usage_event_payment_event
  ON usage_event (payment_event_id) WHERE payment_event_id IS NOT NULL;
CREATE INDEX idx_usage_event_billing
  ON usage_event (tenant_id, client_id, occurred_at) WHERE invoice_id IS NULL;
CREATE INDEX idx_usage_event_invoice ON usage_event (invoice_id)
  WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_usage_event_case ON usage_event (case_id);

COMMENT ON TABLE usage_event IS
  'Append-only ledger of billable facts. Rows are written once with the figures '
  'as they stood and are never amended; a correction is a further row. Invoices '
  'are built from this table rather than from payment_event, so a bill that has '
  'gone out can still be reconstructed after the operational data has moved on.';

CREATE OR REPLACE FUNCTION app.protect_usage_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Same escape as the invoice table: the application may never delete
    -- billing history, but an administrator tearing a tenant down (the demo
    -- reseed, a customer termination) says so explicitly.
    IF current_setting('app.allow_invoice_purge', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION
        'usage_event % is billing history and cannot be deleted',
        OLD.usage_event_id;
    END IF;
    RETURN OLD;
  END IF;

  -- A ledger row moves from unbilled to billed, and back only by the invoice
  -- being voided. Re-pointing it straight at a second invoice would bill the
  -- same recovery twice with nothing in the record to show it happened.
  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     AND OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS NOT NULL THEN
    RAISE EXCEPTION
      'usage_event % is already billed on invoice %; void that invoice before rebilling',
      OLD.usage_event_id, OLD.invoice_id;
  END IF;

  -- Everything else is frozen. Comparing the whole row with invoice_id removed
  -- isolates that one column without enumerating the rest, so a column added
  -- to this table later is protected by default rather than by somebody
  -- remembering to extend a list here.
  IF (to_jsonb(OLD) - 'invoice_id') IS DISTINCT FROM (to_jsonb(NEW) - 'invoice_id') THEN
    RAISE EXCEPTION
      'usage_event % is append-only: only invoice_id may change, and a correction is a new row',
      OLD.usage_event_id;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_protect_usage_event
  BEFORE UPDATE OR DELETE ON usage_event
  FOR EACH ROW EXECUTE FUNCTION app.protect_usage_event();

ALTER TABLE usage_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_event
  FOR ALL USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE TRIGGER trg_audit_usage_event
  AFTER INSERT OR UPDATE OR DELETE ON usage_event
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('usage_event_id');

-- invoice_line names the ledger row it charged for, so the invoice, the ledger
-- and the payment event form one chain a customer can walk.
ALTER TABLE invoice_line
  ADD COLUMN usage_event_id uuid REFERENCES usage_event (usage_event_id);
CREATE UNIQUE INDEX uq_invoice_line_usage_event
  ON invoice_line (usage_event_id) WHERE usage_event_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON usage_event TO rcm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_event TO rcm_service;

COMMIT;
