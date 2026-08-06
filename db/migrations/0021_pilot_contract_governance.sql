-- Commercial pilot contract governance. Only validated, explicitly activated
-- structured contract rules may drive recovery findings. Existing contracts
-- are preserved as active for backwards compatibility; all newly created
-- contracts are inserted as drafts by the application.
BEGIN;

ALTER TABLE contract
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'retired', 'rejected')),
  ADD COLUMN validation_report jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(validation_report) = 'array'),
  ADD COLUMN source_sha256 text CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN approved_by uuid REFERENCES app_user (user_id),
  ADD COLUMN approved_at timestamptz;

UPDATE contract SET approved_at = created_at WHERE status = 'active';
ALTER TABLE contract ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE contract ADD CONSTRAINT contract_activation_approval
  CHECK (status <> 'active' OR approved_at IS NOT NULL);

CREATE INDEX idx_contract_active_dates
  ON contract (client_id, payer_id, effective_date, expiration_date)
  WHERE status = 'active' AND deleted_at IS NULL;

COMMIT;
