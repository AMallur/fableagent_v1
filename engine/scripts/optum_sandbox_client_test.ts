// ============================================================================
// Real end-to-end test of the production Optum connector — NOT the throwaway
// explorer in optum_sandbox_explore.ts, which hand-rolls its own fetch/OAuth
// and never touches src/integration/optum_client.ts or optum_mapping.ts.
//
// This script builds a ClaimSubmissionBundle from Optum's own predefined
// sandbox canned test values (see "Sandbox Predefined Fields and Values" in
// developer.optum.com, and docs/PRE_PILOT_QUALIFICATION.md for the values
// used), runs it through buildProfessionalClaimSubmission, and submits it via
// submitProfessionalClaim — the exact two functions
// src/integration/connectors.ts calls for a real client/claim. That is what
// makes this a test of the connector rather than of an ad hoc payload.
//
// contactInformation.name is overridden to a canned value after the mapper
// builds it: the mapper reuses client.clientName for both organizationName
// and the contact name, but Optum's sandbox validates the contact name
// against its own separate canned list. That constraint is sandbox-only —
// production contactInformation.name should be a client's real contact,
// not a payer-imposed canned value — so the override belongs here, not in
// optum_mapping.ts.
//
// Uses the client's default sandbox token/API URLs, so only credentials are
// required:
//   OPTUM_CLIENT_ID=... OPTUM_CLIENT_SECRET=... node scripts/optum_sandbox_client_test.ts
// ============================================================================

import { submitProfessionalClaim } from '../src/integration/optum_client.ts';
import { buildProfessionalClaimSubmission } from '../src/integration/optum_mapping.ts';
import type { ClaimSubmissionBundle } from '../src/integration/optum_mapping.ts';

const cannedAddress = { line1: '123 address1', city: 'city1', state: 'wa', zip: '981010000' };

const bundle: ClaimSubmissionBundle = {
  claim: { claimNumberInternal: '00000', billedAmount: 250 },
  encounter: {
    dateOfServiceStart: '2026-06-01',
    placeOfService: '11',
    diagnosisCodes: ['J01.90'],
  },
  patient: {
    firstName: 'johnone',
    lastName: 'doeone',
    dob: '1980-01-01',
    gender: 'M',
    address: cannedAddress,
    insuranceIdPrimary: '0000000001',
  },
  provider: { npiIndividual: '1760854442', name: 'happy doctors group' },
  client: {
    clientName: 'happy doctors group',
    taxId: '123456789',
    npiGroup: '1760854442',
    address: cannedAddress,
  },
  payer: { payerName: 'extra healthy insurance', payerIdCode: '9496' },
  lines: [
    { lineNumber: 1, procedureCode: '99213', modifiers: [], units: 1, billedAmount: 250 },
  ],
};

const payload = buildProfessionalClaimSubmission(bundle, {
  controlNumber: '000000002', claimFrequencyCode: '1',
});

// Sandbox-only override — see module header.
const cannedContactName = 'johnone doeone';
(payload.submitter as Record<string, unknown>).contactInformation = {
  name: cannedContactName, phoneNumber: '0000000000',
};
(payload.billing as Record<string, unknown>).contactInformation = {
  name: cannedContactName, phoneNumber: '0000000000',
};

console.log('Submitting via the real connector (optum_client.ts submitProfessionalClaim, '
  + 'payload from optum_mapping.ts buildProfessionalClaimSubmission) ...');
const result = await submitProfessionalClaim(
  '/medicalnetwork/professionalclaims/v3/submission', payload,
  { traceId: 'sandbox-client-test-1' },
);
console.log(`status=${result.status} ok=${result.ok} attempts=${result.attempts}`);
console.log(JSON.stringify(result.body, null, 2));
if (!result.ok) process.exitCode = 1;
