// ============================================================================
// Domain types for the recovery detection engine.
//
// The engine core is a pure function over an EngineInput snapshot and returns
// an EngineResult — no I/O. The Postgres layer (src/db/) builds the snapshot
// and persists the result; tests build snapshots in memory.
// ============================================================================

export type UUID = string;
export type ISODate = string; // 'YYYY-MM-DD'

export type CaseType =
  | 'underpayment' | 'denial' | 'timely_filing' | 'authorization'
  | 'duplicate' | 'bundling' | 'other';

export type CaseStatus =
  | 'open' | 'in_progress' | 'submitted' | 'pending_payer'
  | 'won' | 'lost' | 'closed_no_action';

export type ClaimStatus =
  | 'submitted' | 'accepted' | 'rejected' | 'denied' | 'paid'
  | 'underpaid' | 'appealed' | 'closed';

export type PriorityLevel = 'critical' | 'high' | 'medium' | 'low';
export type RecoveryLikelihood = 'high' | 'medium' | 'low';

export type MatchMethod = 'payer_claim_number' | 'patient_dos_proc_amount' | 'unmatched';

export type DenialCategory =
  | 'clinical_medical_necessity' | 'authorization' | 'coding' | 'timely_filing'
  | 'duplicate' | 'coordination_of_benefits' | 'contractual'
  | 'patient_eligibility' | 'bundling';

export type ExpectedSource = 'contract' | 'medicare_proxy' | 'none';

// ---------------------------------------------------------------------------
// Input snapshot
// ---------------------------------------------------------------------------

export interface PayerInput {
  payerId: UUID;
  payerName: string;
  appealDeadlineDays?: number | null;
  timelyFilingLimitDays?: number | null;
}

export interface PatientInput {
  patientId: UUID;
  insuranceIdPrimary?: string | null;
  insuranceIdSecondary?: string | null;
}

export interface ClaimLineInput {
  claimLineId: UUID;
  lineNumber: number;
  procedureCode: string;
  modifiers: string[];                 // modifier_1..4, order preserved
  units: number;
  billedAmount: number;
  expectedAmount?: number | null;      // may already be priced
  paidAmount?: number | null;
  allowedAmount?: number | null;
  denialReasonCode?: string | null;
  lineStatus?: string | null;
}

export interface ClaimInput {
  claimId: UUID;
  clientId: UUID;
  payerId: UUID;
  patientId: UUID;
  claimNumberInternal: string;
  claimNumberPayer?: string | null;
  dateOfServiceStart: ISODate;         // denormalized from encounter
  submissionDate?: ISODate | null;
  claimStatus: ClaimStatus;
  authorizationNumber?: string | null; // denormalized from encounter
  availableDocumentTypes: string[];    // document_type values on file for this claim/client
  lines: ClaimLineInput[];
}

export interface RemitLineInput {
  remittanceLineId: UUID;
  remittanceId: UUID;
  payerId: UUID;                       // from parent remittance
  checkDate?: ISODate | null;          // from parent remittance
  payerClaimNumber?: string | null;
  patientMemberId?: string | null;
  dateOfService?: ISODate | null;
  procedureCode?: string | null;
  billedAmount?: number | null;
  allowedAmount?: number | null;
  paidAmount?: number | null;
  patientResponsibility?: number | null;
  adjustmentGroupCode?: string | null; // CO / PR / OA / PI
  adjustmentReasonCode?: string | null;// CARC, e.g. '45'
  remarkCode?: string | null;          // RARC
  claimId?: UUID | null;               // pre-linked (already matched earlier)
  claimLineId?: UUID | null;
}

export interface ContractLineInput {
  procedureCode: string;
  modifier?: string | null;
  allowedAmount?: number | null;
  percentOfMedicare?: number | null;   // e.g. 145.000 = 145% of Medicare
  effectiveDate?: ISODate | null;
}

export interface ContractInput {
  contractId: UUID;
  clientId: UUID;
  payerId: UUID;
  effectiveDate: ISODate;
  expirationDate?: ISODate | null;
  feeScheduleType: 'percent_of_medicare' | 'fee_schedule' | 'per_diem' | 'case_rate';
  lines: ContractLineInput[];
}

export interface ExistingCaseInput {
  caseId: UUID;
  claimId: UUID;
  claimLineId?: UUID | null;
  caseType: CaseType;
  status: CaseStatus;
}

/** Historical outcomes for appealability scoring. */
export interface WinRateInput {
  payerId: UUID;
  denialCategory: DenialCategory;
  won: number;
  lost: number;
}

export interface ClientPayerConfigInput {
  clientId: UUID;
  payerId: UUID;
  autopilotEnabled: boolean;
  minCaseThreshold?: number | null;
}

export interface EngineConfig {
  /** deterministic "today" for deadline math */
  asOf: ISODate;
  minCaseThreshold: number;          // default 25
  varianceDollarTrigger: number;     // default 25
  variancePercentTrigger: number;    // default 0.05
  defaultAppealDeadlineDays: number; // when payer has none; default 90
  criticalDeadlineDays: number;      // 14
  criticalAmount: number;            // 5000
  highDeadlineDays: number;          // 30
  highAmount: number;                // 1000
  mediumDeadlineDays: number;        // 60
}

export interface EngineInput {
  tenantId: UUID;
  config: EngineConfig;
  payers: PayerInput[];
  patients: PatientInput[];
  claims: ClaimInput[];
  remitLines: RemitLineInput[];
  contracts: ContractInput[];
  /** key: `${procedureCode}|${modifier ?? ''}` (falls back to `${code}|`) */
  medicareRates: Record<string, number>;
  existingCases: ExistingCaseInput[];
  winRates: WinRateInput[];
  clientPayerConfigs: ClientPayerConfigInput[];
  /** per-client alert threshold; key = clientId */
  clientAlertThresholds: Record<UUID, number>;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface MatchResult {
  remittanceLineId: UUID;
  method: MatchMethod;
  claimId?: UUID;
  claimLineId?: UUID;
}

export interface LinePricing {
  claimId: UUID;
  claimLineId: UUID;
  expectedAmount: number | null;
  expectedSource: ExpectedSource;
  contractId?: UUID;
  noContract: boolean;
}

export interface ClaimStatusUpdate {
  claimId: UUID;
  fromStatus: ClaimStatus;
  toStatus: ClaimStatus;
}

export interface ClaimLineUpdate {
  claimLineId: UUID;
  claimId: UUID;
  paidAmount?: number | null;
  allowedAmount?: number | null;
  expectedAmount?: number | null;
  expectedSource?: ExpectedSource;
  denialReasonCode?: string | null;
  denialReasonDescription?: string | null;
  lineStatus?: string | null;
}

export interface CaseOutput {
  /** set when this run updates an existing open case instead of creating one */
  existingCaseId?: UUID;
  clientId: UUID;
  claimId: UUID;
  claimLineId: UUID | null;
  payerId: UUID;
  caseType: CaseType;
  denialReasonCode: string | null;
  denialCategory: DenialCategory | null;
  expectedAmount: number | null;
  paidAmount: number | null;
  recoveryOpportunity: number;
  confidenceScore: number;            // 0..1
  appealabilityScore: number;         // 0..100
  recoveryLikelihood: RecoveryLikelihood;
  recommendedAction: string;
  priorityLevel: PriorityLevel;
  deadlineDate: ISODate | null;
  expired: boolean;
  autoAction: boolean;
}

export interface SkippedCase {
  claimId: UUID;
  claimLineId: UUID | null;
  caseType: CaseType;
  reason: 'below_threshold' | 'no_recovery_amount';
  recoveryOpportunity: number;
}

export interface Anomaly {
  type: 'systemic_underpayment';
  payerId: UUID;
  payerName: string;
  detail: string;
  linesChecked: number;
  linesUnderpaid: number;
  totalVariance: number;
}

export interface AlertNotification {
  clientId: UUID;
  threshold: number;
  totalRecoveryOpportunity: number;
  message: string;
}

export interface RunSummary {
  remitLinesProcessed: number;
  matched: number;
  unmatched: number;
  casesCreated: number;
  casesUpdated: number;
  casesSkipped: number;
  totalRecoveryOpportunity: number;
  byCategory: Record<string, { count: number; amount: number }>;
  byPayer: Record<string, { payerName: string; count: number; amount: number }>;
  byPriority: Record<string, { count: number; amount: number }>;
  anomalies: Anomaly[];
  alerts: AlertNotification[];
}

export interface EngineResult {
  matches: MatchResult[];
  unmatchedRemitLines: MatchResult[];
  claimLineUpdates: ClaimLineUpdate[];
  claimStatusUpdates: ClaimStatusUpdate[];
  pricing: LinePricing[];
  casesCreated: CaseOutput[];
  casesUpdated: CaseOutput[];
  skipped: SkippedCase[];
  summary: RunSummary;
}
