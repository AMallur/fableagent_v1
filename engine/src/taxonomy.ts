// ============================================================================
// Denial code taxonomy (Step 4).
//
// Codes are normalized to GROUP-CODE form ('CO-45'). An entry defines the
// category, the case type it produces, a base recovery likelihood, the
// recommended first action, and the document types that strengthen an appeal
// (used by appealability scoring).
//
// requiresVariance: contractual adjustment codes (CO-45, CO-131) appear on
// virtually every remit as the normal contractual write-off. They only become
// a denial case when the line was actually paid below the contracted/expected
// amount — otherwise every clean claim would generate a case.
// ============================================================================

import type { CaseType, DenialCategory, RecoveryLikelihood } from './types.ts';

export interface TaxonomyEntry {
  category: DenialCategory;
  caseType: CaseType;
  baseLikelihood: RecoveryLikelihood;
  recommendedAction: string;
  /** document_type values that support this appeal */
  supportingDocuments: string[];
  requiresVariance?: boolean;
}

export const DENIAL_TAXONOMY: Record<string, TaxonomyEntry> = {
  // -- CLINICAL / MEDICAL NECESSITY ------------------------------------------
  'CO-50': {
    category: 'clinical_medical_necessity', caseType: 'denial',
    baseLikelihood: 'medium',
    recommendedAction: 'Submit first-level appeal with medical records and letter of medical necessity',
    supportingDocuments: ['medical_record'],
  },
  'CO-167': {
    category: 'clinical_medical_necessity', caseType: 'denial',
    baseLikelihood: 'medium',
    recommendedAction: 'Review diagnosis coding; appeal with documentation supporting covered diagnosis or correct and resubmit',
    supportingDocuments: ['medical_record'],
  },
  'CO-57': {
    category: 'clinical_medical_necessity', caseType: 'denial',
    baseLikelihood: 'medium',
    recommendedAction: 'Submit medical necessity appeal with clinical documentation for the service',
    supportingDocuments: ['medical_record'],
  },

  // -- AUTHORIZATION -----------------------------------------------------------
  'CO-15': {
    category: 'authorization', caseType: 'authorization',
    baseLikelihood: 'medium',
    recommendedAction: 'Locate authorization number and appeal; if none exists, request retro-authorization',
    supportingDocuments: ['authorization'],
  },
  'CO-197': {
    category: 'authorization', caseType: 'authorization',
    baseLikelihood: 'medium',
    recommendedAction: 'Verify precertification on file; appeal with auth number or pursue retro-authorization',
    supportingDocuments: ['authorization'],
  },
  'PI-15': {
    category: 'authorization', caseType: 'authorization',
    baseLikelihood: 'medium',
    recommendedAction: 'Locate authorization number and appeal; if none exists, request retro-authorization',
    supportingDocuments: ['authorization'],
  },

  // -- CODING -------------------------------------------------------------------
  'CO-4': {
    category: 'coding', caseType: 'denial',
    baseLikelihood: 'high',
    recommendedAction: 'Add required modifier and submit corrected claim',
    supportingDocuments: ['medical_record'],
  },
  'CO-5': {
    category: 'coding', caseType: 'denial',
    baseLikelihood: 'high',
    recommendedAction: 'Review procedure/modifier combination and submit corrected claim',
    supportingDocuments: ['medical_record'],
  },
  'CO-6': {
    category: 'coding', caseType: 'denial',
    baseLikelihood: 'high',
    recommendedAction: 'Append appropriate modifier and submit corrected claim',
    supportingDocuments: ['medical_record'],
  },
  'CO-97': {
    // reclassified to bundling by classifyDenial() when a sibling line on the
    // same claim was paid (payment "included in primary procedure" context)
    category: 'coding', caseType: 'denial',
    baseLikelihood: 'medium',
    recommendedAction: 'Verify NCCI edits; if separately payable, appeal with modifier 59/XU documentation',
    supportingDocuments: ['medical_record'],
  },
  'CO-B7': {
    category: 'coding', caseType: 'denial',
    baseLikelihood: 'low',
    recommendedAction: 'Verify provider certification/enrollment for this procedure; correct billing provider or appeal',
    supportingDocuments: [],
  },

  // -- TIMELY FILING -------------------------------------------------------------
  'CO-29': {
    category: 'timely_filing', caseType: 'timely_filing',
    baseLikelihood: 'medium',
    recommendedAction: 'Appeal with proof of timely filing (clearinghouse acceptance report / original submission record)',
    supportingDocuments: ['eob', 'other'],
  },
  'CO-26': {
    category: 'timely_filing', caseType: 'timely_filing',
    baseLikelihood: 'low',
    recommendedAction: 'Verify coverage effective dates; bill correct payer for date of service',
    supportingDocuments: ['eob'],
  },

  // -- DUPLICATE ------------------------------------------------------------------
  'CO-18': {
    category: 'duplicate', caseType: 'duplicate',
    baseLikelihood: 'medium',
    recommendedAction: 'Confirm whether a true duplicate; if distinct service, appeal with documentation of separate services',
    supportingDocuments: ['medical_record'],
  },

  // -- COORDINATION OF BENEFITS ----------------------------------------------------
  'CO-22': {
    category: 'coordination_of_benefits', caseType: 'denial',
    baseLikelihood: 'medium',
    recommendedAction: 'Verify primary payer; update COB information and resubmit to correct payer',
    supportingDocuments: ['eob'],
  },
  'OA-23': {
    category: 'coordination_of_benefits', caseType: 'denial',
    baseLikelihood: 'medium',
    recommendedAction: 'Reconcile primary payer payment; bill secondary with primary EOB attached',
    supportingDocuments: ['eob'],
  },

  // -- CONTRACTUAL ------------------------------------------------------------------
  'CO-45': {
    category: 'contractual', caseType: 'underpayment',
    baseLikelihood: 'high',
    recommendedAction: 'Compare payment to contracted rate; submit underpayment dispute with contract/fee schedule excerpt',
    supportingDocuments: ['contract', 'fee_schedule'],
    requiresVariance: true,
  },
  'CO-131': {
    category: 'contractual', caseType: 'underpayment',
    baseLikelihood: 'medium',
    recommendedAction: 'Verify negotiated discount terms against contract; dispute if discount misapplied',
    supportingDocuments: ['contract'],
    requiresVariance: true,
  },

  // -- PATIENT ELIGIBILITY --------------------------------------------------------------
  'CO-27': {
    category: 'patient_eligibility', caseType: 'denial',
    baseLikelihood: 'low',
    recommendedAction: 'Verify coverage termination date; bill subsequent coverage or patient',
    supportingDocuments: ['eob'],
  },
  'CO-31': {
    category: 'patient_eligibility', caseType: 'denial',
    baseLikelihood: 'low',
    recommendedAction: 'Verify member ID and demographics; correct and resubmit',
    supportingDocuments: [],
  },
};

/**
 * Normalize a CARC into taxonomy key form.
 *   normalizeDenialCode('45', 'CO')  -> 'CO-45'
 *   normalizeDenialCode('CO45')      -> 'CO-45'
 *   normalizeDenialCode('CO-45')     -> 'CO-45'
 */
export function normalizeDenialCode(
  code: string | null | undefined,
  groupCode?: string | null,
): string | null {
  if (!code) return null;
  const c = code.trim().toUpperCase();
  if (/^[A-Z]{2}-/.test(c)) return c;
  const m = c.match(/^([A-Z]{2})[- ]?(\w+)$/);
  if (m && ['CO', 'PR', 'OA', 'PI', 'CR'].includes(m[1])) return `${m[1]}-${m[2]}`;
  if (groupCode) return `${groupCode.trim().toUpperCase()}-${c}`;
  return c;
}

export interface DenialClassification extends TaxonomyEntry {
  code: string;
  known: boolean;
}

/**
 * Classify a normalized denial code. CO-97 flips from coding to bundling when
 * another line on the same claim was paid — the "included in the payment for
 * the primary procedure" context the spec calls out.
 */
export function classifyDenial(
  normalizedCode: string,
  context: { siblingLinePaid?: boolean } = {},
): DenialClassification {
  const entry = DENIAL_TAXONOMY[normalizedCode];
  if (!entry) {
    return {
      code: normalizedCode,
      known: false,
      category: 'coding',
      caseType: 'other',
      baseLikelihood: 'low',
      recommendedAction: `Unmapped denial code ${normalizedCode}: review remittance and classify manually`,
      supportingDocuments: [],
    };
  }
  if (normalizedCode === 'CO-97' && context.siblingLinePaid) {
    return {
      ...entry,
      code: normalizedCode,
      known: true,
      category: 'bundling',
      caseType: 'bundling',
      recommendedAction: 'NCCI bundling edit: review for separately identifiable service; appeal with modifier 59/XU documentation if unbundling is supported',
    };
  }
  return { ...entry, code: normalizedCode, known: true };
}
