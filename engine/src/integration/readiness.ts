// ============================================================================
// Client/payer implementation readiness.
//
// This module is deliberately cloud-agnostic. It converts configuration and
// validation evidence into explicit capabilities, and exposes small DB helpers
// used by admin/integration surfaces. Live AWS resources and partner credentials
// are inputs to validation; they are not prerequisites for this code to exist.
// ============================================================================

import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';

export type PayerConfigStatus =
  | 'draft'
  | 'validation_pending'
  | 'validated'
  | 'active'
  | 'suspended'
  | 'retired';

export type PayerCapability = 'detection' | 'appeals' | 'electronic_submission';
export type PricingMode = 'contract' | 'medicare' | 'manual' | 'unknown';

export interface PayerReadinessFacts {
  requireActivation: boolean;
  configExists: boolean;
  status: PayerConfigStatus | null;
  detectionEnabled: boolean;
  appealsEnabled: boolean;
  electronicSubmissionEnabled: boolean;
  payerMappingValidated: boolean;
  edi835Validated: boolean;
  edi837pValidated: boolean;
  contractPricingValidated: boolean;
  appealRulesValidated: boolean;
  submissionRouteValidated: boolean;
  referenceDataValidated: boolean;
  hasActiveContract: boolean;
  pricingMode: PricingMode;
}

export interface CapabilityReadiness {
  enabled: boolean;
  blockers: string[];
  warnings: string[];
}

export interface PayerReadinessEvaluation {
  state: 'legacy_bypass' | 'not_configured' | 'draft' | 'validation' | 'ready' | 'suspended' | 'retired';
  detection: CapabilityReadiness;
  appeals: CapabilityReadiness;
  electronicSubmission: CapabilityReadiness;
  productionReady: boolean;
}

const emptyCapability = (): CapabilityReadiness => ({ enabled: false, blockers: [], warnings: [] });

/**
 * Pure readiness evaluator. Nothing here contacts AWS, a payer, or a
 * clearinghouse, so it can be exhaustively tested before integration day.
 */
export function evaluatePayerReadiness(facts: PayerReadinessFacts): PayerReadinessEvaluation {
  if (!facts.requireActivation) {
    return {
      state: 'legacy_bypass',
      detection: { enabled: true, blockers: [], warnings: ['client does not require explicit payer activation'] },
      appeals: { enabled: true, blockers: [], warnings: ['client does not require explicit payer activation'] },
      electronicSubmission: {
        enabled: facts.electronicSubmissionEnabled,
        blockers: facts.electronicSubmissionEnabled ? [] : ['electronic submission is disabled'],
        warnings: ['legacy client: validate partner route before enabling autonomous submission'],
      },
      productionReady: true,
    };
  }

  const detection = emptyCapability();
  const appeals = emptyCapability();
  const electronicSubmission = emptyCapability();

  if (!facts.configExists || facts.status == null) {
    detection.blockers.push('client/payer configuration does not exist');
    appeals.blockers.push('client/payer configuration does not exist');
    electronicSubmission.blockers.push('client/payer configuration does not exist');
    return { state: 'not_configured', detection, appeals, electronicSubmission, productionReady: false };
  }

  if (facts.status === 'suspended' || facts.status === 'retired') {
    const reason = `client/payer configuration is ${facts.status}`;
    detection.blockers.push(reason);
    appeals.blockers.push(reason);
    electronicSubmission.blockers.push(reason);
    return {
      state: facts.status,
      detection,
      appeals,
      electronicSubmission,
      productionReady: false,
    };
  }

  if (facts.status !== 'active') {
    const reason = `client/payer configuration is ${facts.status}, not active`;
    detection.blockers.push(reason);
    appeals.blockers.push(reason);
    electronicSubmission.blockers.push(reason);
  }

  if (!facts.detectionEnabled) detection.blockers.push('detection capability is disabled');
  if (!facts.payerMappingValidated) detection.blockers.push('payer mapping has not passed validation');
  if (!facts.edi835Validated) detection.blockers.push('835 ingestion has not passed validation');
  if (!facts.referenceDataValidated) detection.blockers.push('reference data has not passed validation');

  if (facts.pricingMode === 'contract') {
    if (!facts.hasActiveContract) detection.blockers.push('no active client/payer contract is configured');
    if (!facts.contractPricingValidated) detection.blockers.push('contract pricing has not passed validation');
  } else if (facts.pricingMode === 'unknown') {
    detection.blockers.push('pricing mode is not configured');
  } else if (facts.pricingMode === 'manual') {
    detection.warnings.push('pricing mode is manual; automated underpayment findings should remain shadow-only');
  } else if (!facts.contractPricingValidated) {
    // Medicare/reference pricing still needs validation against adjudicated examples.
    detection.blockers.push('pricing has not passed validation against adjudicated examples');
  }

  detection.enabled = detection.blockers.length === 0;

  if (!detection.enabled) appeals.blockers.push('detection is not production-ready');
  if (!facts.appealsEnabled) appeals.blockers.push('appeals capability is disabled');
  if (!facts.appealRulesValidated) appeals.blockers.push('appeal rules have not passed validation');
  appeals.enabled = appeals.blockers.length === 0;

  if (!appeals.enabled) electronicSubmission.blockers.push('appeals are not production-ready');
  if (!facts.electronicSubmissionEnabled) {
    electronicSubmission.blockers.push('electronic submission is disabled');
  }
  if (!facts.submissionRouteValidated) {
    electronicSubmission.blockers.push('submission route has not passed end-to-end validation');
  }
  electronicSubmission.enabled = electronicSubmission.blockers.length === 0;

  const state: PayerReadinessEvaluation['state'] = facts.status === 'active'
    ? (detection.enabled ? 'ready' : 'validation')
    : facts.status === 'draft'
      ? 'draft'
      : 'validation';

  return {
    state,
    detection,
    appeals,
    electronicSubmission,
    productionReady: detection.enabled,
  };
}

const VALID_TRANSITIONS: Record<PayerConfigStatus, PayerConfigStatus[]> = {
  draft: ['validation_pending', 'retired'],
  validation_pending: ['draft', 'validated', 'retired'],
  validated: ['validation_pending', 'active', 'retired'],
  active: ['suspended', 'retired'],
  suspended: ['validation_pending', 'active', 'retired'],
  retired: [],
};

export function assertValidPayerStatusTransition(from: PayerConfigStatus, to: PayerConfigStatus): void {
  if (from === to) return;
  if (!VALID_TRANSITIONS[from].includes(to)) {
    throw new Error(`invalid client/payer status transition: ${from} -> ${to}`);
  }
}

interface ReadinessRow {
  require_payer_activation: boolean;
  config_id: UUID | null;
  status: PayerConfigStatus | null;
  detection_enabled: boolean | null;
  appeals_enabled: boolean | null;
  electronic_submission_enabled: boolean | null;
  has_active_contract: boolean | null;
  validation_types: string[] | null;
  pricing_mode: PricingMode | null;
}

/**
 * Load one client/payer's current readiness facts. The pricing mode is stored
 * in validation_summary.pricing_mode so new pricing strategies can be added
 * without changing the schema; contract is the safe default when an active
 * contract exists, otherwise unknown.
 */
export async function loadPayerReadiness(
  db: Queryable,
  args: { tenantId: UUID; clientId: UUID; payerId: UUID },
): Promise<PayerReadinessFacts> {
  const result = await db.query(
    `SELECT c.require_payer_activation,
            cpc.config_id, cpc.status, cpc.detection_enabled, cpc.appeals_enabled,
            cpc.electronic_submission_enabled,
            COALESCE(cpc.validation_summary->>'pricing_mode',
                     CASE WHEN compat.has_active_contract THEN 'contract' ELSE 'unknown' END) AS pricing_mode,
            COALESCE(compat.has_active_contract, false) AS has_active_contract,
            COALESCE((
              SELECT array_agg(DISTINCT v.validation_type)
              FROM client_payer_validation v
              WHERE v.tenant_id = $1 AND v.client_id = $2 AND v.payer_id = $3
                AND v.status = 'passed'
            ), '{}') AS validation_types
     FROM client c
     LEFT JOIN client_payer_config cpc
       ON cpc.tenant_id = c.tenant_id AND cpc.client_id = c.client_id AND cpc.payer_id = $3
     LEFT JOIN client_payer_compatibility compat
       ON compat.config_id = cpc.config_id
     WHERE c.tenant_id = $1 AND c.client_id = $2`,
    [args.tenantId, args.clientId, args.payerId],
  );

  const row = result.rows[0] as ReadinessRow | undefined;
  if (!row) throw new Error('client not found for payer readiness check');
  const validations = new Set(row.validation_types ?? []);

  return {
    requireActivation: row.require_payer_activation,
    configExists: row.config_id != null,
    status: row.status,
    detectionEnabled: Boolean(row.detection_enabled),
    appealsEnabled: Boolean(row.appeals_enabled),
    electronicSubmissionEnabled: Boolean(row.electronic_submission_enabled),
    payerMappingValidated: validations.has('payer_mapping'),
    edi835Validated: validations.has('edi_835'),
    edi837pValidated: validations.has('edi_837p'),
    contractPricingValidated: validations.has('contract_pricing') || validations.has('historical_claims'),
    appealRulesValidated: validations.has('appeal_rules'),
    submissionRouteValidated: validations.has('submission_route'),
    referenceDataValidated: validations.has('reference_data'),
    hasActiveContract: Boolean(row.has_active_contract),
    pricingMode: row.pricing_mode ?? 'unknown',
  };
}

export async function assertPayerCapability(
  db: Queryable,
  args: { tenantId: UUID; clientId: UUID; payerId: UUID; capability: PayerCapability },
): Promise<PayerReadinessEvaluation> {
  const evaluation = evaluatePayerReadiness(await loadPayerReadiness(db, args));
  const cap = args.capability === 'detection'
    ? evaluation.detection
    : args.capability === 'appeals'
      ? evaluation.appeals
      : evaluation.electronicSubmission;
  if (!cap.enabled) {
    throw new Error(
      `${args.capability} is not enabled for this client/payer: ${cap.blockers.join('; ')}`,
    );
  }
  return evaluation;
}

export interface CompatibilityRow {
  payerId: UUID;
  payerName: string;
  payerIdCode: string | null;
  configId: UUID;
  configVersion: number;
  status: PayerConfigStatus;
  detectionEnabled: boolean;
  appealsEnabled: boolean;
  electronicSubmissionEnabled: boolean;
  hasActiveContract: boolean;
  edi835Validated: boolean;
  contractPricingValidated: boolean;
  submissionRouteValidated: boolean;
}

export async function listClientPayerCompatibility(
  db: Queryable,
  args: { tenantId: UUID; clientId: UUID },
): Promise<CompatibilityRow[]> {
  const rows = await db.query(
    `SELECT payer_id, payer_name, payer_id_code, config_id, config_version, status,
            detection_enabled, appeals_enabled, electronic_submission_enabled,
            has_active_contract, edi_835_validated, contract_pricing_validated,
            submission_route_validated
     FROM client_payer_compatibility
     WHERE tenant_id = $1 AND client_id = $2
     ORDER BY lower(payer_name)`,
    [args.tenantId, args.clientId],
  );
  return rows.rows.map((r) => ({
    payerId: r.payer_id,
    payerName: r.payer_name,
    payerIdCode: r.payer_id_code,
    configId: r.config_id,
    configVersion: Number(r.config_version),
    status: r.status,
    detectionEnabled: r.detection_enabled,
    appealsEnabled: r.appeals_enabled,
    electronicSubmissionEnabled: r.electronic_submission_enabled,
    hasActiveContract: r.has_active_contract,
    edi835Validated: r.edi_835_validated,
    contractPricingValidated: r.contract_pricing_validated,
    submissionRouteValidated: r.submission_route_validated,
  }));
}
