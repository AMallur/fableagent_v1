-- ============================================================================
-- 0007_audit_and_jobs.sql
-- Operational layer: append-only audit log (+ the generic trigger that feeds
-- it) and the background job ledger.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- AUDIT_LOG — append-only. bigint identity PK (high write volume; ordering
-- and index locality matter more than global uniqueness here).
-- created_at is the event timestamp.
-- ----------------------------------------------------------------------------
CREATE TABLE audit_log (
  log_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenant (tenant_id),
  user_id       uuid        REFERENCES app_user (user_id),  -- NULL = system job
  action        text        NOT NULL,                       -- INSERT/UPDATE/DELETE or app-level verb
  entity_type   text        NOT NULL,                       -- table / entity name
  entity_id     uuid,
  before_state  jsonb,
  after_state   jsonb,
  ip_address    inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_tenant_time ON audit_log (tenant_id, created_at DESC);
CREATE INDEX idx_audit_entity      ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_user        ON audit_log (user_id);

-- ----------------------------------------------------------------------------
-- Generic row-audit trigger.
-- Attach with:  FOR EACH ROW EXECUTE FUNCTION app.write_audit('<pk_column>')
-- Reads the acting user from app.current_user_id() and the client IP from
-- inet_client_addr(). SECURITY DEFINER so the insert succeeds regardless of
-- the caller's direct grants on audit_log.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.write_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  pk_column  text := TG_ARGV[0];
  old_row    jsonb;
  new_row    jsonb;
  row_tenant uuid;
  row_pk     uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN new_row := to_jsonb(NEW); END IF;

  row_tenant := COALESCE(new_row ->> 'tenant_id', old_row ->> 'tenant_id')::uuid;
  row_pk     := COALESCE(new_row ->> pk_column,  old_row ->> pk_column)::uuid;

  -- skip no-op updates so updated_at-only touches don't spam the log
  IF TG_OP = 'UPDATE' AND old_row = new_row THEN
    RETURN NEW;
  END IF;

  INSERT INTO audit_log
    (tenant_id, user_id, action, entity_type, entity_id,
     before_state, after_state, ip_address)
  VALUES
    (row_tenant, app.current_user_id(), TG_OP, TG_TABLE_NAME, row_pk,
     old_row, new_row, inet_client_addr());

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

-- Attach to every business-critical table. Argument = that table's PK column.
CREATE TRIGGER trg_audit_tenant         AFTER INSERT OR UPDATE OR DELETE ON tenant
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('tenant_id');
CREATE TRIGGER trg_audit_client         AFTER INSERT OR UPDATE OR DELETE ON client
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('client_id');
CREATE TRIGGER trg_audit_app_user       AFTER INSERT OR UPDATE OR DELETE ON app_user
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('user_id');
CREATE TRIGGER trg_audit_provider       AFTER INSERT OR UPDATE OR DELETE ON provider
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('provider_id');
CREATE TRIGGER trg_audit_contract       AFTER INSERT OR UPDATE OR DELETE ON contract
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('contract_id');
CREATE TRIGGER trg_audit_contract_line  AFTER INSERT OR UPDATE OR DELETE ON contract_line
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('contract_line_id');
CREATE TRIGGER trg_audit_patient        AFTER INSERT OR UPDATE OR DELETE ON patient
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('patient_id');
CREATE TRIGGER trg_audit_claim          AFTER INSERT OR UPDATE OR DELETE ON claim
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('claim_id');
CREATE TRIGGER trg_audit_claim_line     AFTER INSERT OR UPDATE OR DELETE ON claim_line
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('claim_line_id');
CREATE TRIGGER trg_audit_recovery_case  AFTER INSERT OR UPDATE OR DELETE ON recovery_case
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('case_id');
CREATE TRIGGER trg_audit_appeal_packet  AFTER INSERT OR UPDATE OR DELETE ON appeal_packet
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('packet_id');
CREATE TRIGGER trg_audit_document       AFTER INSERT OR UPDATE OR DELETE ON document
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('document_id');
CREATE TRIGGER trg_audit_payment_event  AFTER INSERT OR UPDATE OR DELETE ON payment_event
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('payment_event_id');

-- ----------------------------------------------------------------------------
-- SYSTEM_JOB — ingestion / detection / reconciliation job ledger
-- client_id NULL => tenant-wide job
-- ----------------------------------------------------------------------------
CREATE TABLE system_job (
  job_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenant (tenant_id),
  client_id          uuid,
  job_type           job_type    NOT NULL,
  status             job_status  NOT NULL DEFAULT 'queued',
  started_at         timestamptz,
  completed_at       timestamptz,
  records_processed  integer     NOT NULL DEFAULT 0,
  errors_count       integer     NOT NULL DEFAULT 0,
  log_output         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

CREATE INDEX idx_job_tenant_status ON system_job (tenant_id, status);
CREATE INDEX idx_job_type          ON system_job (tenant_id, job_type);
CREATE INDEX idx_job_created       ON system_job (created_at DESC);
-- the queue poll
CREATE INDEX idx_job_queue ON system_job (status, created_at)
  WHERE status IN ('queued', 'running');

COMMIT;
