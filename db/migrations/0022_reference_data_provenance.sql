-- Versioned provenance for external reference data. Source files are imported
-- through strict canonical CSV schemas; every accepted row points back to the
-- exact version and SHA-256 digest that produced it.
BEGIN;

CREATE TABLE reference_dataset (
  dataset_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_kind    text NOT NULL CHECK (dataset_kind IN
    ('medicare_pfs', 'carc', 'rarc', 'ncci_ptp')),
  version         text NOT NULL,
  scope           text NOT NULL DEFAULT 'global',
  source_url      text NOT NULL CHECK (source_url ~ '^https://'),
  effective_date date,
  source_sha256   text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  row_count       integer NOT NULL CHECK (row_count >= 0),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  imported_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_kind, version, scope)
);

-- CMS PFS rates are locality-specific. A client must be mapped explicitly;
-- the engine does not infer a locality from a ZIP code without the current
-- CMS ZIP-to-locality crosswalk.
ALTER TABLE client ADD COLUMN medicare_locality text;

ALTER TABLE medicare_fee_schedule
  ADD COLUMN service_setting text NOT NULL DEFAULT 'nonfacility'
    CHECK (service_setting IN ('facility', 'nonfacility')),
  ADD COLUMN dataset_id uuid REFERENCES reference_dataset (dataset_id);

DROP INDEX uq_medicare_rate;
CREATE UNIQUE INDEX uq_medicare_rate_legacy
  ON medicare_fee_schedule (procedure_code, COALESCE(modifier, ''),
                            effective_year, COALESCE(locality, ''), service_setting)
  WHERE dataset_id IS NULL;
CREATE UNIQUE INDEX uq_medicare_rate_dataset
  ON medicare_fee_schedule (dataset_id, procedure_code, COALESCE(modifier, ''),
                            COALESCE(locality, ''), service_setting)
  WHERE dataset_id IS NOT NULL;

CREATE TABLE remittance_code_reference (
  code_reference_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id        uuid NOT NULL REFERENCES reference_dataset (dataset_id) ON DELETE CASCADE,
  code_kind         text NOT NULL CHECK (code_kind IN ('carc', 'rarc')),
  code              text NOT NULL,
  description       text NOT NULL,
  start_date        date,
  last_modified     date,
  stop_date         date,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  UNIQUE (dataset_id, code)
);
CREATE INDEX idx_remittance_code_lookup ON remittance_code_reference (code_kind, code);

CREATE TABLE ncci_ptp_edit (
  ncci_edit_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id          uuid NOT NULL REFERENCES reference_dataset (dataset_id) ON DELETE CASCADE,
  service_setting     text NOT NULL CHECK (service_setting IN ('practitioner', 'outpatient_hospital')),
  column_one_code     text NOT NULL CHECK (column_one_code ~ '^[A-Z0-9]{5}$'),
  column_two_code     text NOT NULL CHECK (column_two_code ~ '^[A-Z0-9]{5}$'),
  effective_date      date NOT NULL,
  deletion_date       date,
  modifier_indicator  smallint NOT NULL CHECK (modifier_indicator IN (0, 1, 9)),
  CHECK (deletion_date IS NULL OR deletion_date >= effective_date),
  UNIQUE (dataset_id, column_one_code, column_two_code, effective_date)
);
CREATE INDEX idx_ncci_ptp_lookup
  ON ncci_ptp_edit (service_setting, column_one_code, column_two_code, effective_date);

GRANT SELECT ON reference_dataset, remittance_code_reference, ncci_ptp_edit
  TO CURRENT_USER, rcm_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON reference_dataset, remittance_code_reference, ncci_ptp_edit
  TO CURRENT_USER, rcm_service;

COMMIT;
