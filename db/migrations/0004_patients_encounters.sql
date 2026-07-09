-- ============================================================================
-- 0004_patients_encounters.sql
-- Clinical/demographic layer: patients and encounters (visits).
-- PHI lives here — access is tenant-isolated via RLS (0008) and every
-- change on these tables is captured by the audit trigger (0007).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- PATIENT
-- ----------------------------------------------------------------------------
CREATE TABLE patient (
  patient_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid        NOT NULL,
  client_id               uuid        NOT NULL,
  mrn                     text        NOT NULL,    -- medical record number
  first_name              text        NOT NULL,
  last_name               text        NOT NULL,
  dob                     date,
  gender                  text,
  address                 jsonb,                    -- {line1, line2, city, state, zip}
  insurance_id_primary    text,
  insurance_id_secondary  text,
  payer_id_primary        uuid REFERENCES payer (payer_id),
  payer_id_secondary      uuid REFERENCES payer (payer_id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,

  UNIQUE (tenant_id, patient_id),
  UNIQUE (client_id, patient_id),   -- composite target for encounter FK
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

CREATE UNIQUE INDEX uq_patient_mrn_live
  ON patient (client_id, mrn) WHERE deleted_at IS NULL;
CREATE INDEX idx_patient_tenant       ON patient (tenant_id);
CREATE INDEX idx_patient_client       ON patient (client_id);
CREATE INDEX idx_patient_name         ON patient (client_id, lower(last_name), lower(first_name));
CREATE INDEX idx_patient_dob          ON patient (dob);
CREATE INDEX idx_patient_ins_primary  ON patient (insurance_id_primary);
CREATE INDEX idx_patient_payer_prim   ON patient (payer_id_primary);

-- ----------------------------------------------------------------------------
-- ENCOUNTER — a visit / episode that claims are billed against
-- ----------------------------------------------------------------------------
CREATE TABLE encounter (
  encounter_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL,
  client_id              uuid        NOT NULL,
  patient_id             uuid        NOT NULL,
  provider_id            uuid        NOT NULL,
  facility_npi           text CHECK (facility_npi ~ '^[0-9]{10}$'),
  date_of_service_start  date        NOT NULL,
  date_of_service_end    date,
  place_of_service       text,                     -- CMS POS code, e.g. '11'
  encounter_type         text,
  authorization_number   text,
  referral_number        text,
  diagnosis_codes        text[]      NOT NULL DEFAULT '{}',  -- ICD-10, ordered
  status                 text        NOT NULL DEFAULT 'open',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,

  UNIQUE (tenant_id, encounter_id),
  UNIQUE (client_id, encounter_id),  -- composite target for claim FK
  FOREIGN KEY (tenant_id, client_id)  REFERENCES client   (tenant_id, client_id),
  FOREIGN KEY (client_id, patient_id) REFERENCES patient  (client_id, patient_id),
  FOREIGN KEY (client_id, provider_id) REFERENCES provider (client_id, provider_id),
  CHECK (date_of_service_end IS NULL OR date_of_service_end >= date_of_service_start)
);

CREATE INDEX idx_encounter_tenant    ON encounter (tenant_id);
CREATE INDEX idx_encounter_client    ON encounter (client_id);
CREATE INDEX idx_encounter_patient   ON encounter (patient_id);
CREATE INDEX idx_encounter_provider  ON encounter (provider_id);
CREATE INDEX idx_encounter_dos       ON encounter (client_id, date_of_service_start);
CREATE INDEX idx_encounter_auth      ON encounter (authorization_number);
CREATE INDEX idx_encounter_status    ON encounter (client_id, status);
CREATE INDEX idx_encounter_dx_gin    ON encounter USING gin (diagnosis_codes);

COMMIT;
