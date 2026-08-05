-- Preserve every CAS adjustment on an 835 service line. The legacy scalar
-- group/reason columns continue to contain the first adjustment so existing
-- reports and integrations remain compatible.
BEGIN;

ALTER TABLE remittance_line
  ADD COLUMN adjustments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT remittance_line_adjustments_array
    CHECK (jsonb_typeof(adjustments) = 'array');

-- Carry the latest adjudicated patient liability forward so supplemental ERA
-- payments can be evaluated cumulatively without losing the earlier PR amount.
ALTER TABLE claim_line
  ADD COLUMN patient_responsibility numeric(12,2)
    CHECK (patient_responsibility >= 0);

COMMIT;
