import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildClaimStatusCheck, buildProfessionalClaimSubmission } from '../src/integration/optum_mapping.ts';
import type { ClaimSubmissionBundle } from '../src/integration/optum_mapping.ts';

function sampleBundle(overrides: Partial<ClaimSubmissionBundle> = {}): ClaimSubmissionBundle {
  return {
    claim: { claimNumberInternal: 'INT-12345', billedAmount: 250.5 },
    encounter: {
      dateOfServiceStart: '2026-01-15',
      placeOfService: '11',
      diagnosisCodes: ['R51', 'M54.5'],
    },
    patient: {
      firstName: 'Jane', lastName: 'Doe', dob: '1980-01-02', gender: 'f',
      address: { line1: '123 Main St', city: 'Nashville', state: 'tn', zip: '372030000' },
      insuranceIdPrimary: 'MEM0001',
    },
    provider: { npiIndividual: '1234567890', name: 'Dr. Smith' },
    client: {
      clientName: 'Happy Doctors Group', taxId: '123456789', npiGroup: '1760854442',
      address: { line1: '456 Practice Way', city: 'Nashville', state: 'tn', zip: '372030000' },
    },
    payer: { payerName: 'Extra Healthy Insurance', payerIdCode: '9496' },
    lines: [
      { lineNumber: 1, procedureCode: 'E0570', modifiers: ['25'], units: 1, billedAmount: 250.5 },
    ],
    ...overrides,
  };
}

describe('buildProfessionalClaimSubmission', () => {
  it('maps every required ClaimSubmissionRequest field from the bundle', () => {
    const req = buildProfessionalClaimSubmission(sampleBundle(), { controlNumber: '000000001' });
    assert.equal(req.controlNumber, '000000001');
    assert.equal(req.tradingPartnerServiceId, '9496');

    const subscriber = req.subscriber as Record<string, unknown>;
    assert.equal(subscriber.memberId, 'MEM0001');
    assert.equal(subscriber.firstName, 'Jane');
    assert.equal(subscriber.gender, 'F');
    assert.equal(subscriber.dateOfBirth, '19800102');

    const billing = req.billing as Record<string, unknown>;
    assert.equal(billing.npi, '1760854442'); // prefers group NPI over individual
    assert.equal(billing.employerId, '123456789');
    const billingAddress = billing.address as Record<string, unknown>;
    assert.equal(billingAddress.address1, '456 Practice Way');
    assert.equal(billingAddress.postalCode, '372030000');

    const claimInfo = req.claimInformation as Record<string, unknown>;
    assert.equal(claimInfo.patientControlNumber, 'INT-12345');
    assert.equal(claimInfo.claimChargeAmount, '250.50');
    assert.equal(claimInfo.claimFrequencyCode, '7'); // default: corrected-claim resubmission

    const diagnoses = claimInfo.healthCareCodeInformation as Array<Record<string, unknown>>;
    assert.equal(diagnoses.length, 2);
    assert.equal(diagnoses[0].diagnosisTypeCode, 'ABK'); // principal
    assert.equal(diagnoses[1].diagnosisTypeCode, 'ABF'); // subsequent

    const lines = claimInfo.serviceLines as Array<Record<string, unknown>>;
    assert.equal(lines.length, 1);
    const svc = lines[0].professionalService as Record<string, unknown>;
    assert.equal(svc.procedureCode, 'E0570');
    assert.deepEqual(svc.procedureModifiers, ['25']);
    assert.equal(svc.lineItemChargeAmount, '250.50');
  });

  it('falls back to the individual provider NPI when there is no group NPI', () => {
    const req = buildProfessionalClaimSubmission(
      sampleBundle({ client: { clientName: 'Solo Practice', taxId: null, npiGroup: null, address: null } }),
      { controlNumber: '1' },
    );
    assert.equal((req.billing as Record<string, unknown>).npi, '1234567890');
  });

  it('defaults unknown genders to U rather than guessing', () => {
    const req = buildProfessionalClaimSubmission(
      sampleBundle({ patient: { ...sampleBundle().patient, gender: 'nonbinary' } }),
      { controlNumber: '1' },
    );
    assert.equal((req.subscriber as Record<string, unknown>).gender, 'U');
  });

  it('guesses a payer-name-based filing code, defaulting to commercial insurance', () => {
    const medicare = buildProfessionalClaimSubmission(
      sampleBundle({ payer: { payerName: 'Medicare Part B', payerIdCode: '1' } }),
      { controlNumber: '1' },
    );
    assert.equal((medicare.claimInformation as Record<string, unknown>).claimFilingCode, 'MB');

    const unknown = buildProfessionalClaimSubmission(sampleBundle(), { controlNumber: '1' });
    assert.equal((unknown.claimInformation as Record<string, unknown>).claimFilingCode, 'CI');
  });

  it('respects an explicit claimFrequencyCode override (e.g. original submission)', () => {
    const req = buildProfessionalClaimSubmission(sampleBundle(), { controlNumber: '1', claimFrequencyCode: '1' });
    assert.equal((req.claimInformation as Record<string, unknown>).claimFrequencyCode, '1');
  });

  it('refuses to build a claim with zero service lines', () => {
    assert.throws(() => buildProfessionalClaimSubmission(sampleBundle({ lines: [] }), { controlNumber: '1' }));
  });

  it('refuses to build a claim with zero diagnosis codes', () => {
    assert.throws(() => buildProfessionalClaimSubmission(
      sampleBundle({ encounter: { ...sampleBundle().encounter, diagnosisCodes: [] } }),
      { controlNumber: '1' },
    ));
  });
});

describe('buildClaimStatusCheck', () => {
  it('extracts status-check identifiers from a previously-built submission', () => {
    const submission = buildProfessionalClaimSubmission(sampleBundle(), { controlNumber: '000000002' });
    const check = buildClaimStatusCheck(submission, { controlNumber: '000000002' });

    assert.equal(check.controlNumber, '000000002');
    assert.equal(check.tradingPartnerServiceId, '9496');
    assert.deepEqual(check.providers, [{ providerType: 'BillingProvider', npi: '1760854442', taxId: '123456789' }]);

    const subscriber = check.subscriber as Record<string, unknown>;
    assert.equal(subscriber.memberId, 'MEM0001');
    assert.equal(subscriber.dateOfBirth, '19800102');

    assert.equal((check.encounter as Record<string, unknown>).beginningDateOfService, '20260115');
  });
});
