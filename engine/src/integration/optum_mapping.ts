// ============================================================================
// Maps this engine's claim/encounter/patient/provider rows into Optum's
// professional-claims ClaimSubmissionRequest JSON shape (confirmed against
// developer.optum.com/eligibilityandclaims — see the OpenAPI spec for
// "Medical Network Professional Claims V3").
//
// SCOPE AND KNOWN GAPS (read before treating this as fully certified):
//   - Single primary payer only. No coordination-of-benefits / secondary
//     payer support — subscriber.paymentResponsibilityLevelCode is always
//     'P'. otherSubscriberInformation is never populated.
//   - claim_line has no per-line diagnosis-pointer column, so every service
//     line's compositeDiagnosisCodePointers points at diagnosis 1. A claim
//     with line-specific diagnosis pointers will be mapped incorrectly.
//   - claimFilingCode is a best-effort guess from the payer name; there is
//     no per-payer filing-code reference table yet, so it defaults to 'CI'
//     (Commercial Insurance) whenever the guess doesn't match.
//   - submitter/billing contactInformation.phoneNumber has no real source
//     column and is a placeholder — client_integration would need a real
//     contact-phone field before this goes live.
//   - claimFrequencyCode defaults to '7' (replacement of prior claim)
//     because this connector is wired to appeal-packet dispatch, i.e.
//     corrected-claim resubmission, not original 837P submission.
// ============================================================================

import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';

export interface ClaimSubmissionBundle {
  claim: {
    claimNumberInternal: string;
    billedAmount: number;
  };
  encounter: {
    dateOfServiceStart: string; // YYYY-MM-DD
    placeOfService: string | null;
    diagnosisCodes: string[];
  };
  patient: {
    firstName: string;
    lastName: string;
    dob: string | null; // YYYY-MM-DD
    gender: string | null;
    address: { line1?: string; line2?: string; city?: string; state?: string; zip?: string } | null;
    insuranceIdPrimary: string | null;
  };
  provider: { npiIndividual: string | null; name: string };
  client: { clientName: string; taxId: string | null; npiGroup: string | null };
  payer: { payerName: string; payerIdCode: string | null };
  lines: Array<{
    lineNumber: number;
    procedureCode: string;
    modifiers: string[];
    units: number;
    billedAmount: number;
  }>;
}

export async function loadClaimSubmissionBundle(
  db: Queryable, args: { tenantId: UUID; claimId: UUID },
): Promise<ClaimSubmissionBundle | null> {
  const head = await db.query(
    `SELECT c.claim_number_internal, c.billed_amount,
            e.date_of_service_start, e.place_of_service, e.diagnosis_codes,
            p.first_name AS patient_first_name, p.last_name AS patient_last_name,
            p.dob AS patient_dob, p.gender AS patient_gender, p.address AS patient_address,
            p.insurance_id_primary,
            pr.npi_individual AS provider_npi, pr.name AS provider_name,
            cl.client_name, cl.tax_id, cl.npi_group,
            py.payer_name, py.payer_id_code
     FROM claim c
     JOIN encounter e ON e.encounter_id = c.encounter_id
     JOIN patient  p  ON p.patient_id   = e.patient_id
     JOIN provider pr ON pr.provider_id = e.provider_id
     JOIN client   cl ON cl.client_id   = c.client_id
     JOIN payer    py ON py.payer_id    = c.payer_id
     WHERE c.claim_id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL`,
    [args.claimId, args.tenantId]);
  const h = head.rows[0];
  if (!h) return null;

  const lines = await db.query(
    `SELECT line_number, procedure_code, modifier_1, modifier_2, modifier_3, modifier_4,
            units, billed_amount
     FROM claim_line
     WHERE claim_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
     ORDER BY line_number`,
    [args.claimId, args.tenantId]);

  return {
    claim: {
      claimNumberInternal: h.claim_number_internal,
      billedAmount: Number(h.billed_amount),
    },
    encounter: {
      dateOfServiceStart: String(h.date_of_service_start),
      placeOfService: h.place_of_service,
      diagnosisCodes: h.diagnosis_codes ?? [],
    },
    patient: {
      firstName: h.patient_first_name,
      lastName: h.patient_last_name,
      dob: h.patient_dob ? String(h.patient_dob) : null,
      gender: h.patient_gender,
      address: h.patient_address ?? null,
      insuranceIdPrimary: h.insurance_id_primary,
    },
    provider: { npiIndividual: h.provider_npi, name: h.provider_name },
    client: { clientName: h.client_name, taxId: h.tax_id, npiGroup: h.npi_group },
    payer: { payerName: h.payer_name, payerIdCode: h.payer_id_code },
    lines: lines.rows.map((r) => ({
      lineNumber: r.line_number,
      procedureCode: r.procedure_code,
      modifiers: [r.modifier_1, r.modifier_2, r.modifier_3, r.modifier_4].filter(Boolean),
      units: Number(r.units),
      billedAmount: Number(r.billed_amount),
    })),
  };
}

const FILING_CODE_GUESS: Array<[RegExp, string]> = [
  [/medicare/i, 'MB'],
  [/medicaid/i, 'MC'],
  [/blue cross|blue shield/i, 'BL'],
  [/tricare|champus/i, 'CH'],
  [/workers.? comp/i, 'WC'],
];

function guessFilingCode(payerName: string): string {
  return FILING_CODE_GUESS.find(([re]) => re.test(payerName))?.[1] ?? 'CI';
}

/** builds a ClaimSubmissionRequest body — see module header for known gaps */
export function buildProfessionalClaimSubmission(
  bundle: ClaimSubmissionBundle,
  opts: { controlNumber: string; claimFrequencyCode?: '1' | '7' | '8' },
): Record<string, unknown> {
  if (bundle.lines.length === 0) throw new Error('cannot build a claim submission with zero service lines');
  if (bundle.encounter.diagnosisCodes.length === 0) {
    throw new Error('cannot build a claim submission with zero diagnosis codes');
  }

  const genderUpper = bundle.patient.gender?.toUpperCase();
  const genderCode = genderUpper === 'M' || genderUpper === 'F' ? genderUpper : 'U';
  const serviceDate = bundle.encounter.dateOfServiceStart.replaceAll('-', '');
  const npi = bundle.client.npiGroup ?? bundle.provider.npiIndividual ?? undefined;

  return {
    controlNumber: opts.controlNumber,
    tradingPartnerServiceId: bundle.payer.payerIdCode ?? undefined,
    usageIndicator: 'T', // flip to 'P' only once OPTUM_ALLOW_LIVE_SUBMISSION is genuinely enabled for production
    submitter: {
      organizationName: bundle.client.clientName,
      contactInformation: { name: bundle.client.clientName, phoneNumber: '0000000000' },
    },
    receiver: { organizationName: bundle.payer.payerName },
    subscriber: {
      memberId: bundle.patient.insuranceIdPrimary ?? undefined,
      paymentResponsibilityLevelCode: 'P',
      firstName: bundle.patient.firstName,
      lastName: bundle.patient.lastName,
      gender: genderCode,
      dateOfBirth: bundle.patient.dob ? bundle.patient.dob.replaceAll('-', '') : undefined,
      address: bundle.patient.address ? {
        address1: bundle.patient.address.line1,
        address2: bundle.patient.address.line2,
        city: bundle.patient.address.city,
        state: bundle.patient.address.state,
        postalCode: bundle.patient.address.zip,
      } : undefined,
    },
    billing: {
      providerType: 'BillingProvider',
      npi,
      employerId: bundle.client.taxId ?? undefined,
      organizationName: bundle.client.clientName,
      contactInformation: { name: bundle.client.clientName, phoneNumber: '0000000000' },
    },
    claimInformation: {
      claimFilingCode: guessFilingCode(bundle.payer.payerName),
      patientControlNumber: bundle.claim.claimNumberInternal,
      claimChargeAmount: bundle.claim.billedAmount.toFixed(2),
      placeOfServiceCode: bundle.encounter.placeOfService ?? '11',
      claimFrequencyCode: opts.claimFrequencyCode ?? '7',
      signatureIndicator: 'Y',
      planParticipationCode: 'A',
      benefitsAssignmentCertificationIndicator: 'Y',
      releaseInformationCode: 'Y',
      healthCareCodeInformation: bundle.encounter.diagnosisCodes.map((code, i) => ({
        diagnosisTypeCode: i === 0 ? 'ABK' : 'ABF',
        diagnosisCode: code,
      })),
      serviceLines: bundle.lines.map((line) => ({
        serviceDate,
        professionalService: {
          procedureIdentifier: 'HC',
          procedureCode: line.procedureCode,
          ...(line.modifiers.length ? { procedureModifiers: line.modifiers } : {}),
          lineItemChargeAmount: line.billedAmount.toFixed(2),
          measurementUnit: 'UN',
          serviceUnitCount: String(line.units),
          compositeDiagnosisCodePointers: { diagnosisCodePointers: ['1'] },
        },
      })),
    },
  };
}

/**
 * Builds a claim-status check request (POST /medicalnetwork/claimstatus/v2/)
 * from a previously-submitted ClaimSubmissionRequest, so reconciliation can
 * re-derive the identifiers a status check needs without re-querying the
 * claim tables — just the record of what was actually sent.
 *
 * Field mapping confirmed against
 * developer.optum.com/eligibilityandclaims/reference/claimstatus:
 * controlNumber, tradingPartnerServiceId, providers[].npi,
 * subscriber.memberId, encounter.beginningDateOfService.
 *
 * providers[0].taxId is required too — confirmed by a live sandbox 400
 * ("Billing provider requires either etin or taxId", field
 * providers[0].validBillingProvider) the first time this was tried without
 * it. Sourced from the submission's billing.employerId, the same TIN this
 * connector already sends on the original ClaimSubmissionRequest.
 */
export function buildClaimStatusCheck(
  claimRequest: Record<string, unknown>, opts: { controlNumber: string },
): Record<string, unknown> {
  const subscriber = claimRequest.subscriber as Record<string, unknown> | undefined;
  const billing = claimRequest.billing as Record<string, unknown> | undefined;
  const claimInformation = claimRequest.claimInformation as Record<string, unknown> | undefined;
  const serviceLines = (claimInformation?.serviceLines as Array<Record<string, unknown>> | undefined) ?? [];
  const beginningDateOfService = serviceLines[0]?.serviceDate as string | undefined;

  return {
    controlNumber: opts.controlNumber,
    tradingPartnerServiceId: claimRequest.tradingPartnerServiceId,
    providers: [{ providerType: 'BillingProvider', npi: billing?.npi, taxId: billing?.employerId }],
    subscriber: {
      memberId: subscriber?.memberId,
      firstName: subscriber?.firstName,
      lastName: subscriber?.lastName,
      dateOfBirth: subscriber?.dateOfBirth,
    },
    encounter: { beginningDateOfService },
  };
}
