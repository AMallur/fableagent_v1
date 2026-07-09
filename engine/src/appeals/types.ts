// ============================================================================
// Domain types for the appeal automation module. AppealCaseContext is the
// pure-side contract: the DB loader (context.ts) produces it, and the letter
// generator / corrected-claim generator / assembly rules consume it without
// touching the database — same pattern as the detection engine.
// ============================================================================

import type { PriorityLevel, UUID } from '../types.ts';

export type LetterCategory =
  | 'medical_necessity' | 'authorization' | 'bundling' | 'underpayment'
  | 'timely_filing' | 'duplicate' | 'coding' | 'general';

export type SubmissionMethod = 'mail' | 'portal' | 'fax' | 'clearinghouse';
export type AppealType =
  | 'first_level' | 'second_level' | 'external_review' | 'corrected_claim' | 'reopening';
export type PacketStatus = 'draft' | 'ready' | 'submitted' | 'acknowledged';

export interface Address {
  line1?: string; line2?: string; city?: string; state?: string; zip?: string;
}

export interface AppealClaimLine {
  claimLineId: UUID;
  lineNumber: number;
  procedureCode: string;
  modifiers: string[];
  units: number;
  billedAmount: number;
  expectedAmount: number | null;
  paidAmount: number | null;
  denialReasonCode: string | null;
}

export interface AppealRemitLine {
  procedureCode: string | null;
  billedAmount: number | null;
  allowedAmount: number | null;
  paidAmount: number | null;
  adjustmentGroupCode: string | null;
  adjustmentReasonCode: string | null;
  checkDate: string | null;
  checkNumber: string | null;
}

export interface AppealContractLine {
  procedureCode: string;
  modifier: string | null;
  allowedAmount: number | null;
  percentOfMedicare: number | null;
}

export interface ExistingDocument {
  documentId: UUID;
  documentType: string;
  fileName: string;
}

export interface AppealCaseContext {
  // case
  caseId: UUID;
  caseType: string;
  denialCategory: string | null;
  denialReasonCode: string | null;
  priorityLevel: PriorityLevel;
  recoveryOpportunity: number;
  expectedAmount: number | null;
  paidAmount: number | null;
  confidenceScore: number | null;      // 0..1
  deadlineDate: string | null;
  claimLineId: UUID | null;
  // client / provider (letterhead)
  clientId: UUID;
  clientName: string;
  clientAddress: Address | null;
  clientNpiGroup: string | null;
  providerName: string;
  providerNpi: string | null;
  // payer
  payerId: UUID;
  payerName: string;
  appealAddress: string | null;
  portalUrl: string | null;
  // patient
  patientFirstName: string;
  patientLastName: string;
  patientDob: string | null;
  patientMrn: string;
  // claim
  claimId: UUID;
  claimNumberInternal: string;
  claimNumberPayer: string | null;
  dateOfService: string;
  submissionDate: string | null;
  authorizationNumber: string | null;
  claimLines: AppealClaimLine[];
  remitLines: AppealRemitLine[];
  // contract (for underpayment letters)
  contract: {
    feeScheduleType: string;
    effectiveDate: string;
    lines: AppealContractLine[];
  } | null;
  // assembly inputs
  existingDocuments: ExistingDocument[];
  autopilotEnabled: boolean;
  priorCategoryCaseCount: number;      // payer+category history (any outcome)
  priorPacketCount: number;            // packets already on this case
  clientReviewThreshold: number | null;
  existingDraftPacketId: UUID | null;  // refresh instead of create
  asOf: string;
}

/** A document the packet needs: either an existing DOCUMENT row or content to generate. */
export type PlannedDocument =
  | { kind: 'existing'; documentId: UUID; documentType: string; fileName: string }
  | { kind: 'generate'; documentType: string; fileName: string; content: string };

export interface DocumentPlan {
  documents: PlannedDocument[];        // excludes the letter itself
  missingDocumentTypes: string[];
  packetStatus: PacketStatus;          // ready | draft
  appealType: AppealType;
  submissionMethod: SubmissionMethod;
  autoSubmit: boolean;
  needsReview: boolean;
  needsReviewReasons: string[];
}

export interface CorrectionResult {
  claimLineId: UUID | null;
  originalFields: Record<string, unknown>;
  correctedFields: Record<string, unknown>;
  reason: string;
  confidenceScore: number;             // 0-100 per spec
  needsManualReview: boolean;          // confidence < 85
}
