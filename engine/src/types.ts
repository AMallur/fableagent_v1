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

/** Where a claim sits in the patient's coverage order (837 SBR01). */
export type PayerSequence = 'primary' | 'secondary' | 'tertiary' | 'unknown';

// ---------------------------------------------------------------------------
// Input snapshot
// ---------------------------------------------------------------------------

export interface PayerInput {
  payerId: UUID;
  payerName: string;
  appealDeadlineDays?: number | null;
  timelyFilingLimitDays?: number | null;
  /** Percentage withheld from the payment after adjudication — Medicare
   * sequestration is 2. It reduces what the payer owes, not what the contract
   * allows, so it applies to expected payer liability rather than to the
   * allowed amount. */
  paymentReductionPercent?: number | null;
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
  patientResponsibility?: number | null;
  denialReasonCode?: string | null;
  lineStatus?: string | null;
  /** Line-level COB amount (837 loop 2430 SVD02) — what the prior payer paid
   * for this specific service line. Preferred over the claim-level total. */
  priorPayerPaid?: number | null;
}

export interface ClaimInput {
  claimId: UUID;
  clientId: UUID;
  payerId: UUID;
  patientId: UUID;
  claimNumberInternal: string;
  claimNumberPayer?: string | null;
  dateOfServiceStart: ISODate;         // denormalized from encounter
  placeOfService?: string | null;
  submissionDate?: ISODate | null;
  claimStatus: ClaimStatus;
  authorizationNumber?: string | null; // denormalized from encounter
  availableDocumentTypes: string[];    // document_type values on file for this claim/client
  /** 837 SBR01. On a secondary or tertiary claim this payer owes the allowed
   * amount less patient responsibility AND less what the prior payer paid. */
  payerSequence?: PayerSequence;
  /** Claim-level COB amount (837 loop 2320 AMT*D). */
  priorPayerPaid?: number | null;
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
  /** All CAS adjustments on the service line. Legacy scalar fields below
   * remain populated with the first adjustment for compatibility. */
  adjustments?: RemitAdjustmentInput[];
  adjustmentGroupCode?: string | null; // CO / PR / OA / PI
  adjustmentReasonCode?: string | null;// CARC, e.g. '45'
  remarkCode?: string | null;          // RARC
  /** CLP02 claim status: 1 processed primary, 4 denied, 22 reversal, ... */
  claimStatusCode?: string | null;
  /** CLP02 = 22 — reverses a previously reported payment. Its amounts are
   * negative, they net against prior cash, and they must never be read as a
   * fresh adjudication or turned into a recovery case. */
  isReversal?: boolean;
  /** SVC01 — the code the payer adjudicated, when it differs from the code we
   * submitted (which stays in procedureCode so matching still works). */
  adjudicatedProcedureCode?: string | null;
  payerRecoded?: boolean;
  /** SVC05 — units the payer paid. */
  paidUnits?: number | null;
  /** SVC07 — units originally submitted, when the payer reported them. */
  originalUnits?: number | null;
  claimId?: UUID | null;               // pre-linked (already matched earlier)
  claimLineId?: UUID | null;
  /** True when this exact remittance line was processed in an earlier run.
   * Reprocessing may refresh a case, but must never add its cash twice. */
  previouslyProcessed?: boolean;
}

export interface RemitAdjustmentInput {
  groupCode: string;
  reasonCode: string;
  amount: number;
  quantity?: number | null;
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
  /** The near-universal contract term: the payer owes the lesser of billed
   * charges and the contracted rate. A line billed below the rate therefore
   * cannot be underpaid against that rate. */
  applyLesserOfBilled?: boolean;
  lines: ContractLineInput[];
}

/**
 * Percentage of the otherwise-allowed amount payable when a modifier is on the
 * line (51 multiple procedure, 50 bilateral, 80/AS assistant, and so on).
 * Rules compose multiplicatively in applyOrder, because a bilateral assistant
 * surgery pays 150% and then 16% of that, not 166%.
 */
export interface ModifierPaymentRule {
  modifier: string;
  percentOfAllowed: number;
  applyOrder: number;
  /** null = every payer for this tenant. */
  payerId?: UUID | null;
  /** null = the shared default, overridden by any tenant-specific rule. */
  tenantId?: UUID | null;
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
  /** Modifier payment rules in effect: shared defaults plus tenant overrides. */
  modifierRules?: ModifierPaymentRule[];
  /** Imported key: `${code}|${modifier}|${locality}|${facility|nonfacility}`.
   * Legacy/test fixtures may provide `${code}|${modifier}`. */
  medicareRates: Record<string, number>;
  /** Explicit CMS locality per client; never inferred from address text. */
  medicareLocalityByClient: Record<UUID, string>;
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
  patientResponsibility?: number | null;
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
  type: 'systemic_underpayment' | 'payment_reversed';
  payerId: UUID;
  payerName: string;
  detail: string;
  /** systemic_underpayment only */
  linesChecked?: number;
  linesUnderpaid?: number;
  totalVariance?: number;
  /** payment_reversed only */
  reversedLines?: number;
  reversedAmount?: number;
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
  /** Payer reversals seen in this run. Reversals take cash back, so they are
   * reported explicitly rather than being absorbed into the paid totals. */
  reversals: {
    lines: number;
    /** Total reversed cash as a positive number. */
    amount: number;
    claimLineIds: UUID[];
  };
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
