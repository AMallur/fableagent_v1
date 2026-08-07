// ============================================================================
// X12 Claim Status Category Codes (STC01-1), external code list ECL 507.
// Confirmed against the X12 standards body's own published list —
// https://x12.org/codes/claim-status-category-codes — not an Optum-specific
// document, since Optum's claim-status API reference explicitly defers to
// "X12 EDI standard code tables not fully documented here" rather than
// republishing them.
//
// Only STC01-1 (category) is modeled here, not the much larger STC01-2
// status-code list (ECL 508) — category is sufficient to answer the one
// question outbound_delivery reconciliation needs: did the clearinghouse/
// payer reject the transmission itself, as opposed to the claim being
// accepted and now pending, finalized (paid or denied), or needing more
// info. Business-adjudication outcomes (paid/denied) belong on `claim`, not
// on outbound_delivery — this classifies transmission-level acceptance.
//
// isRejection is judgment on top of the X12 text for a few codes where the
// standard's own description doesn't say "rejected" outright: A4 (Not
// Found) is treated as a rejection because a status check run shortly
// after our own submission returning "not found" almost always means an
// identifier mismatch between what we sent and what we're querying, not a
// transient indexing delay; F5 (Cannot Process) is treated as a rejection
// because a claim that finalized as unprocessable never produced a
// processable result, functionally the same as an intake rejection for our
// purposes even though X12 categorizes it under "Finalized." E1/E2 (system
// status / info holder not responding) are deliberately NOT rejections —
// those are explicitly transient per their own text.
// ============================================================================

export type ClaimStatusCategoryGroup =
  | 'acknowledgement' | 'pending' | 'finalized' | 'request_for_info'
  | 'error' | 'search' | 'supplemental' | 'unknown';

export interface ClaimStatusCategory {
  code: string;
  group: ClaimStatusCategoryGroup;
  description: string;
  /** the clearinghouse/payer rejected the transmission itself — not a business adjudication outcome */
  isRejection: boolean;
}

const CATEGORIES: ClaimStatusCategory[] = [
  { code: 'X0', group: 'supplemental', description: 'Supplemental Messages', isRejection: false },

  { code: 'A0', group: 'acknowledgement', description: 'Acknowledgement/Forwarded', isRejection: false },
  { code: 'A1', group: 'acknowledgement', description: 'Acknowledgement/Receipt', isRejection: false },
  { code: 'A2', group: 'acknowledgement', description: 'Acknowledgement/Accepted into adjudication system', isRejection: false },
  { code: 'A3', group: 'acknowledgement', description: 'Acknowledgement/Returned as unprocessable claim', isRejection: true },
  { code: 'A4', group: 'acknowledgement', description: 'Acknowledgement/Not Found', isRejection: true },
  { code: 'A5', group: 'acknowledgement', description: 'Acknowledgement/Split Claim', isRejection: false },
  { code: 'A6', group: 'acknowledgement', description: 'Acknowledgement/Rejected for Missing Information', isRejection: true },
  { code: 'A7', group: 'acknowledgement', description: 'Acknowledgement/Rejected for Invalid Information', isRejection: true },
  { code: 'A8', group: 'acknowledgement', description: 'Acknowledgement/Rejected for relational field in error', isRejection: true },

  { code: 'P0', group: 'pending', description: 'Pending: Adjudication/Details', isRejection: false },
  { code: 'P1', group: 'pending', description: 'Pending/In Process', isRejection: false },
  { code: 'P2', group: 'pending', description: 'Pending/Payer Review', isRejection: false },
  { code: 'P3', group: 'pending', description: 'Pending/Provider Requested Information', isRejection: false },
  { code: 'P4', group: 'pending', description: 'Pending/Patient Requested Information', isRejection: false },
  { code: 'P5', group: 'pending', description: 'Pending/Payer Administrative/System hold', isRejection: false },

  { code: 'F0', group: 'finalized', description: 'Finalized-The claim/encounter has completed the adjudication cycle', isRejection: false },
  { code: 'F1', group: 'finalized', description: 'Finalized/Payment-The claim/line has been paid', isRejection: false },
  { code: 'F2', group: 'finalized', description: 'Finalized/Denial-The claim/line has been denied', isRejection: false },
  { code: 'F3', group: 'finalized', description: 'Finalized/Revised-Adjudication information has been changed', isRejection: false },
  { code: 'F3F', group: 'finalized', description: 'Finalized/Forwarded-The claim/encounter processing has been completed', isRejection: false },
  { code: 'F3N', group: 'finalized', description: 'Finalized/Not Forwarded-The claim/encounter processing has been completed', isRejection: false },
  { code: 'F4', group: 'finalized', description: 'Finalized/Adjudication Complete-No payment forthcoming', isRejection: false },
  { code: 'F5', group: 'finalized', description: 'Finalized/Cannot Process', isRejection: true },

  { code: 'R0', group: 'request_for_info', description: 'Requests for additional Information/General Requests', isRejection: false },
  { code: 'R1', group: 'request_for_info', description: 'Requests for additional Information/Entity Requests', isRejection: false },
  { code: 'R3', group: 'request_for_info', description: 'Requests for additional Information/Claim/Line', isRejection: false },
  { code: 'R4', group: 'request_for_info', description: 'Requests for additional Information/Documentation', isRejection: false },
  { code: 'R5', group: 'request_for_info', description: 'Request for additional information/more specific detail', isRejection: false },
  { code: 'R6', group: 'request_for_info', description: 'Requests for additional information - Regulatory requirements', isRejection: false },
  { code: 'R7', group: 'request_for_info', description: 'Requests for additional information - Confirm care is consistent with Health Plan policy coverage', isRejection: false },
  { code: 'R8', group: 'request_for_info', description: 'Requests for additional information - Confirm care is consistent with health plan coverage exceptions', isRejection: false },
  { code: 'R9', group: 'request_for_info', description: 'Requests for additional information - Determination of medical necessity', isRejection: false },
  { code: 'R10', group: 'request_for_info', description: 'Requests for additional information - Support a filed grievance or appeal', isRejection: false },
  { code: 'R11', group: 'request_for_info', description: 'Requests for additional information - Pre-payment review of claims', isRejection: false },
  { code: 'R12', group: 'request_for_info', description: 'Requests for additional information - Clarification or justification of use for specified procedure code', isRejection: false },
  { code: 'R13', group: 'request_for_info', description: 'Requests for additional information - Original documents submitted are not readable', isRejection: false },
  { code: 'R14', group: 'request_for_info', description: 'Requests for additional information - Original documents received are not what was requested', isRejection: false },
  { code: 'R15', group: 'request_for_info', description: 'Requests for additional information - Workers Compensation coverage determination', isRejection: false },
  { code: 'R16', group: 'request_for_info', description: 'Requests for additional information - Eligibility determination', isRejection: false },
  { code: 'R17', group: 'request_for_info', description: 'Replacement of a Prior Request', isRejection: false },

  { code: 'RQ', group: 'request_for_info', description: 'General Questions (Yes/No Responses)', isRejection: false },

  { code: 'E0', group: 'error', description: 'Response not possible-error on submitted request data', isRejection: true },
  { code: 'E1', group: 'error', description: 'Response not possible-System Status', isRejection: false },
  { code: 'E2', group: 'error', description: 'Information Holder is not responding; resubmit at a later time', isRejection: false },
  { code: 'E3', group: 'error', description: 'Correction required-relational fields in error', isRejection: true },
  { code: 'E4', group: 'error', description: 'Trading partner agreement specific requirement not met: Data correction required', isRejection: true },

  { code: 'D0', group: 'search', description: 'Data Search Unsuccessful-The payer is unable to return status on the requested claim(s)', isRejection: false },
];

const BY_CODE = new Map(CATEGORIES.map((c) => [c.code, c]));

export function lookupClaimStatusCategory(code: string | undefined | null): ClaimStatusCategory | undefined {
  if (!code) return undefined;
  return BY_CODE.get(code.toUpperCase());
}
