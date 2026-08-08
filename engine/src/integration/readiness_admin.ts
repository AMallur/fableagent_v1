// ============================================================================
// Operator-side client/payer implementation writes.
//
// These functions are the code-ready onboarding surface for admin APIs, CLI
// tools, or implementation automation. They never talk to AWS or a payer;
// they persist configuration/evidence and enforce the same activation rules
// the runtime services consume.
// ============================================================================

import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';
import {
  assertValidPayerStatusTransition,
  evaluatePayerReadiness,
  loadPayerReadiness,
  type PayerConfigStatus,
  type PricingMode,
} from './readiness.ts';

export type ValidationType =
  | 'edi_835' | 'edi_837p' | 'payer_mapping' | 'contract_pricing'
  | 'historical_claims' | 'appeal_rules' | 'submission_route'
  | 'reference_data' | 'security' | 'other';

export type ValidationStatus = 'pending' | 'passed' | 'failed' | 'waived';
export type PayerAliasType = 'payer_id' | 'name' | 'trading_partner_id' | 'other';

export interface ConfigurePayerProfileInput {
  tenantId: UUID;
  clientId: UUID;
  payerId: UUID;
  pricingMode: PricingMode;
  autopilotEnabled?: boolean;
  minCaseThreshold?: number | null;
  reviewThreshold?: number | null;
  notes?: string | null;
}

export async function configurePayerProfile(
  db: Queryable, input: ConfigurePayerProfileInput,
): Promise<{ configId: UUID; status: PayerConfigStatus; configVersion: number }> {
  const result = await db.query(
    `INSERT INTO client_payer_config
       (tenant_id, client_id, payer_id, autopilot_enabled, min_case_threshold,
        review_threshold, validation_summary, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (client_id, payer_id) DO UPDATE SET
       autopilot_enabled = EXCLUDED.autopilot_enabled,
       min_case_threshold = EXCLUDED.min_case_threshold,
       review_threshold = EXCLUDED.review_threshold,
       validation_summary = client_payer_config.validation_summary || EXCLUDED.validation_summary,
       notes = COALESCE(EXCLUDED.notes, client_payer_config.notes),
       config_version = client_payer_config.config_version + 1,
       updated_at = now()
     RETURNING config_id, status, config_version`,
    [input.tenantId, input.clientId, input.payerId,
     input.autopilotEnabled ?? false,
     input.minCaseThreshold ?? null,
     input.reviewThreshold ?? null,
     JSON.stringify({ pricing_mode: input.pricingMode }),
     input.notes ?? null],
  );
  const row = result.rows[0];
  return { configId: row.config_id, status: row.status, configVersion: Number(row.config_version) };
}

export async function upsertPayerAlias(
  db: Queryable,
  input: {
    tenantId: UUID; clientId: UUID; payerId: UUID;
    aliasType: PayerAliasType; aliasValue: string; source?: string | null;
    verifiedBy?: UUID | null; verified?: boolean;
  },
): Promise<UUID> {
  const value = input.aliasValue.trim();
  if (!value) throw new Error('payer alias value is required');
  const result = await db.query(
    `INSERT INTO client_payer_alias
       (tenant_id, client_id, payer_id, alias_type, alias_value, source,
        verified_at, verified_by)
     VALUES ($1,$2,$3,$4,$5,$6,
             CASE WHEN $7 THEN now() ELSE NULL END,$8)
     ON CONFLICT (client_id, alias_type, lower(alias_value)) DO UPDATE SET
       payer_id = EXCLUDED.payer_id,
       source = COALESCE(EXCLUDED.source, client_payer_alias.source),
       verified_at = CASE WHEN $7 THEN now() ELSE client_payer_alias.verified_at END,
       verified_by = CASE WHEN $7 THEN $8 ELSE client_payer_alias.verified_by END,
       updated_at = now()
     RETURNING alias_id`,
    [input.tenantId, input.clientId, input.payerId, input.aliasType, value,
     input.source ?? null, input.verified ?? false, input.verifiedBy ?? null],
  );
  return result.rows[0].alias_id;
}

export async function recordPayerValidation(
  db: Queryable,
  input: {
    tenantId: UUID; clientId: UUID; payerId: UUID; configId: UUID;
    validationType: ValidationType; status: ValidationStatus;
    sampleSize?: number | null; metrics?: Record<string, unknown>;
    evidence?: Record<string, unknown>; notes?: string | null; performedBy?: UUID | null;
  },
): Promise<UUID> {
  if (input.sampleSize != null && (!Number.isInteger(input.sampleSize) || input.sampleSize < 0)) {
    throw new Error('validation sampleSize must be a non-negative integer');
  }
  const result = await db.query(
    `INSERT INTO client_payer_validation
       (tenant_id, client_id, payer_id, config_id, validation_type, status,
        sample_size, metrics, evidence, notes, performed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING validation_id`,
    [input.tenantId, input.clientId, input.payerId, input.configId,
     input.validationType, input.status, input.sampleSize ?? null,
     JSON.stringify(input.metrics ?? {}), JSON.stringify(input.evidence ?? {}),
     input.notes ?? null, input.performedBy ?? null],
  );
  return result.rows[0].validation_id;
}

export function coreValidationBlockers(
  facts: Awaited<ReturnType<typeof loadPayerReadiness>>,
): string[] {
  const blockers: string[] = [];
  if (!facts.payerMappingValidated) blockers.push('payer_mapping validation has not passed');
  if (!facts.edi835Validated) blockers.push('edi_835 validation has not passed');
  if (!facts.referenceDataValidated) blockers.push('reference_data validation has not passed');
  if (!facts.contractPricingValidated) blockers.push('pricing/historical validation has not passed');
  if (facts.pricingMode === 'unknown') blockers.push('pricing mode is not configured');
  if (facts.pricingMode === 'contract' && !facts.hasActiveContract) {
    blockers.push('active approved contract is missing');
  }
  return blockers;
}

/**
 * Transition a payer profile through its lifecycle. For `validated`, the core
 * detection evidence must already pass. For `active`, the requested runtime
 * capabilities are evaluated exactly as the runtime will evaluate them.
 */
export async function transitionPayerProfile(
  db: Queryable,
  input: {
    tenantId: UUID; clientId: UUID; payerId: UUID; to: PayerConfigStatus;
    operatorId?: UUID | null;
    enableDetection?: boolean;
    enableAppeals?: boolean;
    enableElectronicSubmission?: boolean;
  },
): Promise<{ status: PayerConfigStatus; evaluation: ReturnType<typeof evaluatePayerReadiness> }> {
  const current = await db.query(
    `SELECT config_id, status FROM client_payer_config
     WHERE tenant_id = $1 AND client_id = $2 AND payer_id = $3`,
    [input.tenantId, input.clientId, input.payerId],
  );
  if (!current.rows[0]) throw new Error('client/payer configuration does not exist');
  const from = current.rows[0].status as PayerConfigStatus;
  assertValidPayerStatusTransition(from, input.to);

  const facts = await loadPayerReadiness(db, input);
  if (input.to === 'validated') {
    const blockers = coreValidationBlockers(facts);
    if (blockers.length) throw new Error(`payer profile cannot be validated: ${blockers.join('; ')}`);
  }

  const enableDetection = input.enableDetection ?? (input.to === 'active');
  const enableAppeals = input.enableAppeals ?? false;
  const enableElectronicSubmission = input.enableElectronicSubmission ?? false;

  const proposed = {
    ...facts,
    status: input.to,
    detectionEnabled: enableDetection,
    appealsEnabled: enableAppeals,
    electronicSubmissionEnabled: enableElectronicSubmission,
  };
  const evaluation = evaluatePayerReadiness(proposed);

  if (input.to === 'active') {
    if (enableDetection && !evaluation.detection.enabled) {
      throw new Error(`payer profile cannot enable detection: ${evaluation.detection.blockers.join('; ')}`);
    }
    if (enableAppeals && !evaluation.appeals.enabled) {
      throw new Error(`payer profile cannot enable appeals: ${evaluation.appeals.blockers.join('; ')}`);
    }
    if (enableElectronicSubmission && !evaluation.electronicSubmission.enabled) {
      throw new Error(
        `payer profile cannot enable electronic submission: ${evaluation.electronicSubmission.blockers.join('; ')}`,
      );
    }
  }

  await db.query(
    `UPDATE client_payer_config
     SET status = $4,
         detection_enabled = $5,
         appeals_enabled = $6,
         electronic_submission_enabled = $7,
         validated_at = CASE WHEN $4 IN ('validated','active')
                             THEN COALESCE(validated_at, now()) ELSE validated_at END,
         validated_by = CASE WHEN $4 IN ('validated','active')
                             THEN COALESCE(validated_by, $8) ELSE validated_by END,
         activated_at = CASE WHEN $4 = 'active' THEN now() ELSE activated_at END,
         activated_by = CASE WHEN $4 = 'active' THEN $8 ELSE activated_by END,
         config_version = config_version + 1,
         updated_at = now()
     WHERE tenant_id = $1 AND client_id = $2 AND payer_id = $3`,
    [input.tenantId, input.clientId, input.payerId, input.to,
     enableDetection, enableAppeals, enableElectronicSubmission, input.operatorId ?? null],
  );

  return { status: input.to, evaluation };
}

export async function setClientPayerActivationRequirement(
  db: Queryable,
  input: { tenantId: UUID; clientId: UUID; required: boolean },
): Promise<void> {
  const result = await db.query(
    `UPDATE client SET require_payer_activation = $3, updated_at = now()
     WHERE tenant_id = $1 AND client_id = $2 RETURNING client_id`,
    [input.tenantId, input.clientId, input.required],
  );
  if (!result.rows[0]) throw new Error('client not found');
}
