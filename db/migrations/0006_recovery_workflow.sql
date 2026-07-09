-- ============================================================================
-- 0006_recovery_workflow.sql
-- The recovery workflow: cases, actions, appeal packets, documents, and
-- recovered-payment events.
--
-- Design note: the spec's APPEAL_PACKET.document_ids array is modeled as a
-- join table (appeal_packet_document) because PostgreSQL cannot enforce
-- foreign keys on array elements — and enforced FKs were a hard requirement.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- RECOVERY_CASE — one underpayment/denial worth working.
-- claim_line_id NULL => header-level case; set => line-level case.
-- ----------------------------------------------------------------------------
CREATE TABLE recovery_case (
  case_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid           NOT NULL,
  client_id             uuid           NOT NULL,
  claim_id              uuid           NOT NULL,
  claim_line_id         uuid,
  case_type             case_type      NOT NULL,
  denial_reason_code    text,
  denial_category       text,
  expected_amount       numeric(12,2),
  paid_amount           numeric(12,2),
  recovery_opportunity  numeric(12,2),
  confidence_score      numeric(5,4) CHECK (confidence_score BETWEEN 0 AND 1),
  priority_level        priority_level NOT NULL DEFAULT 'medium',
  status                case_status    NOT NULL DEFAULT 'open',
  deadline_date         date,
  assigned_to_user_id   uuid REFERENCES app_user (user_id),
  auto_created          boolean        NOT NULL DEFAULT false,
  created_at            timestamptz    NOT NULL DEFAULT now(),
  updated_at            timestamptz    NOT NULL DEFAULT now(),
  deleted_at            timestamptz,

  UNIQUE (tenant_id, case_id),
  FOREIGN KEY (tenant_id, client_id)     REFERENCES client     (tenant_id, client_id),
  FOREIGN KEY (client_id, claim_id)      REFERENCES claim      (client_id, claim_id),
  FOREIGN KEY (tenant_id, claim_line_id) REFERENCES claim_line (tenant_id, claim_line_id)
);

CREATE INDEX idx_case_tenant        ON recovery_case (tenant_id);
CREATE INDEX idx_case_client        ON recovery_case (client_id);
CREATE INDEX idx_case_claim         ON recovery_case (claim_id);
CREATE INDEX idx_case_claim_line    ON recovery_case (claim_line_id);
CREATE INDEX idx_case_assigned      ON recovery_case (assigned_to_user_id);
CREATE INDEX idx_case_type          ON recovery_case (tenant_id, case_type);
CREATE INDEX idx_case_denial_code   ON recovery_case (denial_reason_code);
-- worklist queries: open cases by priority, and looming deadlines
CREATE INDEX idx_case_worklist ON recovery_case (tenant_id, status, priority_level)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_case_deadline ON recovery_case (tenant_id, deadline_date)
  WHERE status IN ('open', 'in_progress', 'submitted', 'pending_payer')
    AND deleted_at IS NULL;
-- prevent duplicate auto-created cases for the same claim line & type
CREATE UNIQUE INDEX uq_case_per_line_live
  ON recovery_case (claim_id, COALESCE(claim_line_id, '00000000-0000-0000-0000-000000000000'::uuid), case_type)
  WHERE deleted_at IS NULL AND status NOT IN ('won', 'lost', 'closed_no_action');

-- ----------------------------------------------------------------------------
-- DOCUMENT — files in object storage; case_id NULL for client-level docs
-- (contracts, fee schedules, payer policies)
-- ----------------------------------------------------------------------------
CREATE TABLE document (
  document_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid            NOT NULL,
  client_id      uuid            NOT NULL,
  case_id        uuid,
  document_type  document_type   NOT NULL DEFAULT 'other',
  file_name      text            NOT NULL,
  storage_path   text            NOT NULL,
  uploaded_at    timestamptz     NOT NULL DEFAULT now(),
  uploaded_by    uuid REFERENCES app_user (user_id),
  source         document_source NOT NULL DEFAULT 'user_upload',
  created_at     timestamptz     NOT NULL DEFAULT now(),
  updated_at     timestamptz     NOT NULL DEFAULT now(),
  deleted_at     timestamptz,

  UNIQUE (tenant_id, document_id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client        (tenant_id, client_id),
  FOREIGN KEY (tenant_id, case_id)   REFERENCES recovery_case (tenant_id, case_id)
);

CREATE INDEX idx_document_tenant ON document (tenant_id);
CREATE INDEX idx_document_client ON document (client_id);
CREATE INDEX idx_document_case   ON document (case_id);
CREATE INDEX idx_document_type   ON document (tenant_id, document_type);

-- contract.fee_schedule_document_id was declared in 0003 before document existed
ALTER TABLE contract
  ADD CONSTRAINT fk_contract_fee_schedule_document
  FOREIGN KEY (fee_schedule_document_id) REFERENCES document (document_id);

-- ----------------------------------------------------------------------------
-- CASE_ACTION — activity history on a case (human or system)
-- ----------------------------------------------------------------------------
CREATE TABLE case_action (
  action_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid             NOT NULL,
  case_id               uuid             NOT NULL,
  action_type           case_action_type NOT NULL,
  performed_by_user_id  uuid REFERENCES app_user (user_id),
  performed_by_system   boolean          NOT NULL DEFAULT false,
  action_date           timestamptz      NOT NULL DEFAULT now(),
  notes                 text,
  related_document_id   uuid,
  created_at            timestamptz      NOT NULL DEFAULT now(),
  updated_at            timestamptz      NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, case_id)             REFERENCES recovery_case (tenant_id, case_id),
  FOREIGN KEY (tenant_id, related_document_id) REFERENCES document      (tenant_id, document_id),
  -- every action is attributable to a human or to the system
  CHECK (performed_by_user_id IS NOT NULL OR performed_by_system)
);

CREATE INDEX idx_action_tenant ON case_action (tenant_id);
CREATE INDEX idx_action_case   ON case_action (case_id, action_date);
CREATE INDEX idx_action_user   ON case_action (performed_by_user_id);
CREATE INDEX idx_action_type   ON case_action (tenant_id, action_type);

-- ----------------------------------------------------------------------------
-- APPEAL_PACKET
-- ----------------------------------------------------------------------------
CREATE TABLE appeal_packet (
  packet_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid          NOT NULL,
  case_id                 uuid          NOT NULL,
  created_by              uuid REFERENCES app_user (user_id),
  packet_status           packet_status NOT NULL DEFAULT 'draft',
  appeal_type             appeal_type   NOT NULL,
  submission_method       submission_method,
  submitted_at            timestamptz,
  payer_reference_number  text,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now(),
  deleted_at              timestamptz,

  UNIQUE (tenant_id, packet_id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES recovery_case (tenant_id, case_id)
);

CREATE INDEX idx_packet_tenant    ON appeal_packet (tenant_id);
CREATE INDEX idx_packet_case      ON appeal_packet (case_id);
CREATE INDEX idx_packet_status    ON appeal_packet (tenant_id, packet_status);
CREATE INDEX idx_packet_payer_ref ON appeal_packet (payer_reference_number);

-- join table replacing the document_ids array (enforceable FKs)
CREATE TABLE appeal_packet_document (
  packet_id    uuid    NOT NULL,
  document_id  uuid    NOT NULL,
  tenant_id    uuid    NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (packet_id, document_id),
  FOREIGN KEY (tenant_id, packet_id)   REFERENCES appeal_packet (tenant_id, packet_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES document      (tenant_id, document_id)
);

CREATE INDEX idx_packet_doc_tenant   ON appeal_packet_document (tenant_id);
CREATE INDEX idx_packet_doc_document ON appeal_packet_document (document_id);

-- ----------------------------------------------------------------------------
-- PAYMENT_EVENT — recovered dollars attributed to a case
-- ----------------------------------------------------------------------------
CREATE TABLE payment_event (
  payment_event_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid          NOT NULL,
  case_id                uuid          NOT NULL,
  remittance_id          uuid,
  claim_id               uuid          NOT NULL,
  amount_recovered       numeric(12,2) NOT NULL,
  payment_date           date          NOT NULL,
  matched_automatically  boolean       NOT NULL DEFAULT false,
  verified_by_user_id    uuid REFERENCES app_user (user_id),
  notes                  text,
  created_at             timestamptz   NOT NULL DEFAULT now(),
  updated_at             timestamptz   NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, case_id)       REFERENCES recovery_case (tenant_id, case_id),
  FOREIGN KEY (tenant_id, remittance_id) REFERENCES remittance    (tenant_id, remittance_id),
  FOREIGN KEY (tenant_id, claim_id)      REFERENCES claim         (tenant_id, claim_id)
);

CREATE INDEX idx_payment_event_tenant     ON payment_event (tenant_id);
CREATE INDEX idx_payment_event_case       ON payment_event (case_id);
CREATE INDEX idx_payment_event_claim      ON payment_event (claim_id);
CREATE INDEX idx_payment_event_remittance ON payment_event (remittance_id);
CREATE INDEX idx_payment_event_date       ON payment_event (tenant_id, payment_date);

COMMIT;
