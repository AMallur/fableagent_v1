-- ============================================================================
-- 0010_appeals_and_ingest.sql
-- Schema support for the appeal automation module (engine/src/appeals) and
-- the 835/837 ingest jobs (engine/src/ingest):
--   * appeal_packet: letter link, auto-submit / needs-review routing,
--     missing-document tracking
--   * corrected_claim — original vs corrected fields for coding corrections
--   * client: billing address (letter header) + appeal review threshold
--   * document: uploaded_at index for date-range retrieval
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- appeal_packet: generation + routing outputs
-- ----------------------------------------------------------------------------
ALTER TABLE appeal_packet
  ADD COLUMN letter_document_id     uuid REFERENCES document (document_id),
  ADD COLUMN auto_submit            boolean NOT NULL DEFAULT false,
  ADD COLUMN needs_review           boolean NOT NULL DEFAULT false,
  ADD COLUMN needs_review_reasons   text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN missing_document_types text[]  NOT NULL DEFAULT '{}';

-- the submission queue: ready packets by priority/deadline (join to case)
CREATE INDEX idx_packet_ready_queue ON appeal_packet (tenant_id)
  WHERE packet_status = 'ready' AND deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- corrected_claim — generated corrections for coding denials (CO-4/5/6).
-- original/corrected field sets are JSONB snapshots; the claim itself is not
-- mutated until a human (or autopilot) approves submission.
-- ----------------------------------------------------------------------------
CREATE TABLE corrected_claim (
  corrected_claim_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL,
  case_id              uuid        NOT NULL,
  claim_id             uuid        NOT NULL,
  claim_line_id        uuid,
  original_fields      jsonb       NOT NULL,
  corrected_fields     jsonb       NOT NULL,
  correction_reason    text        NOT NULL,
  confidence_score     integer     NOT NULL CHECK (confidence_score BETWEEN 0 AND 100),
  needs_manual_review  boolean     NOT NULL DEFAULT false,
  status               text        NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'approved', 'rejected', 'submitted')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,

  UNIQUE (tenant_id, corrected_claim_id),
  FOREIGN KEY (tenant_id, case_id)       REFERENCES recovery_case (tenant_id, case_id),
  FOREIGN KEY (tenant_id, claim_id)      REFERENCES claim         (tenant_id, claim_id),
  FOREIGN KEY (tenant_id, claim_line_id) REFERENCES claim_line    (tenant_id, claim_line_id)
);

CREATE INDEX idx_corrected_claim_tenant ON corrected_claim (tenant_id);
CREATE INDEX idx_corrected_claim_case   ON corrected_claim (case_id);
CREATE INDEX idx_corrected_claim_review ON corrected_claim (tenant_id, needs_manual_review)
  WHERE needs_manual_review AND status = 'draft' AND deleted_at IS NULL;

CREATE TRIGGER trg_corrected_claim_updated_at
  BEFORE UPDATE ON corrected_claim
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TRIGGER trg_audit_corrected_claim
  AFTER INSERT OR UPDATE OR DELETE ON corrected_claim
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('corrected_claim_id');

ALTER TABLE corrected_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE corrected_claim FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON corrected_claim
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON corrected_claim TO rcm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON corrected_claim TO rcm_service;

-- ----------------------------------------------------------------------------
-- client: letterhead address + review threshold for high-value appeals
-- ----------------------------------------------------------------------------
ALTER TABLE client
  ADD COLUMN address jsonb,                      -- {line1, line2, city, state, zip}
  ADD COLUMN appeal_review_threshold numeric(12,2);

-- ----------------------------------------------------------------------------
-- document retrieval by date range (case/client indexes already exist)
-- ----------------------------------------------------------------------------
CREATE INDEX idx_document_uploaded_at ON document (tenant_id, uploaded_at);

COMMIT;
