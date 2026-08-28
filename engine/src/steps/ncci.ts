// ============================================================================
// NCCI PROCEDURE-TO-PROCEDURE EDITS
//
// A CO-97 denial says "the benefit for this service is included in the payment
// for another service". Answering that well means knowing whether CMS actually
// publishes an edit for the pair, and if so whether a modifier is allowed to
// override it. Those are four genuinely different situations and only one of
// them is "append modifier 59 and appeal":
//
//   indicator 0  the pair is never separately payable, whatever modifier is
//                appended. An unbundling appeal cannot win. Saying so is worth
//                more than a hopeful recommendation — it is a day of a
//                biller's time not spent.
//   indicator 1  a modifier may override the edit. Two sub-cases, and they are
//                opposites: if we already billed 59/XE/XP/XS/XU and the payer
//                bundled anyway, the payer ignored a valid override and the
//                appeal is strong. If we did not, the route is a corrected
//                claim with the modifier — and only where the documentation
//                supports a distinct service.
//   indicator 9  the edit does not apply (withdrawn, or never in force on this
//                date of service). The payer bundled against a rule that was
//                not in effect.
//   no edit      CMS publishes nothing for this pair. Against a payer that
//                adjudicates on NCCI that contradicts its own published
//                policy; against a payer running proprietary edits it is a
//                demand for the edit rationale under the contract.
//
// The two CMS tables disagree, and which applies is decided by the claim type:
// the practitioner table for professional claims, the outpatient-hospital
// table for facility claims.
//
// Everything here is pure. A conclusion is only drawn when the reference data
// actually covers the date of service — with no NCCI import loaded, or an
// import that postdates the service, the answer is "unknown" rather than a
// guess, because "CMS publishes no edit" and "we have not loaded the file" are
// not the same statement and must never be reported as if they were.
// ============================================================================

import type {
  ClaimInput, ClaimLineInput, EngineInput, NcciServiceSetting, RecoveryLikelihood,
} from '../types.ts';

/** The CMS "NCCI PTP-associated modifiers" list: the modifiers that may
 * override a modifier-indicator-1 edit. Global-surgery (24/57/58/78/79),
 * E/M (25/27), repeat-procedure (91), the -X{EPSU} set and 59 itself, and the
 * anatomic/laterality modifiers. Deliberately not a superset — a modifier CMS
 * does not associate with PTP edits (50 bilateral, for instance) does not
 * bypass one, and treating it as if it did would produce a confident appeal
 * recommendation that loses. */
export const NCCI_BYPASS_MODIFIERS = new Set([
  '59', 'XE', 'XP', 'XS', 'XU',
  '24', '25', '27', '57', '58', '78', '79', '91',
  'E1', 'E2', 'E3', 'E4',
  'FA', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9',
  'TA', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9',
  'LT', 'RT', 'LC', 'LD', 'LM', 'RC', 'RI',
]);

export type NcciFinding =
  | 'no_reference_data'
  | 'reference_predates_service'
  | 'no_edit_published'
  | 'never_separately_payable'
  | 'override_billed_and_ignored'
  | 'override_available'
  | 'edit_not_in_force';

export interface NcciEditInput {
  serviceSetting: NcciServiceSetting;
  /** The paid, comprehensive procedure. */
  columnOneCode: string;
  /** The bundled, denied procedure. */
  columnTwoCode: string;
  effectiveDate: string;
  deletionDate?: string | null;
  /** 0 never overridable, 1 modifier may override, 9 edit not applicable. */
  modifierIndicator: 0 | 1 | 9;
}

/** What NCCI data is loaded, so "no edit found" can be told apart from
 * "nothing to look in". */
export interface NcciDatasetInput {
  serviceSetting: NcciServiceSetting;
  version: string;
  /** The quarter the CMS file takes effect. */
  effectiveDate?: string | null;
}

export interface NcciAssessment {
  finding: NcciFinding;
  serviceSetting: NcciServiceSetting;
  /** The denied line's own code — the column-two side of the pair. */
  deniedCode: string;
  /** The paid sibling the denial bundles into, when one was identified. */
  primaryCode: string | null;
  modifierIndicator: 0 | 1 | 9 | null;
  /** Bypass modifiers we actually billed on the denied line. */
  bypassModifiersBilled: string[];
  /** True only when an unbundling appeal has a route to succeed. Indicator 0
   * is the case where it does not, and where saying so is the whole value. */
  appealSupported: boolean;
  likelihood: RecoveryLikelihood;
  /** Added to the appealability score in Step 5. */
  scoreAdjustment: number;
  recommendedAction: string;
  /** One line for the case notes and the appeal packet. */
  explanation: string;
}

const settingFor = (claim: ClaimInput): NcciServiceSetting =>
  (claim.claimType === 'facility' ? 'outpatient_hospital' : 'practitioner');

const inForce = (edit: NcciEditInput, dos: string): boolean =>
  edit.effectiveDate <= dos && (edit.deletionDate == null || edit.deletionDate > dos);

function bypassModifiersOn(line: ClaimLineInput): string[] {
  return (line.modifiers ?? [])
    .map((m) => String(m ?? '').trim().toUpperCase())
    .filter((m) => NCCI_BYPASS_MODIFIERS.has(m));
}


/**
 * Whether the loaded reference data can speak to this date of service. A file
 * imported for Q3 cannot be used to say "CMS published no edit" about a Q1
 * service: the edit may simply have been withdrawn in between.
 */
function coverageFor(
  datasets: NcciDatasetInput[] | undefined, setting: NcciServiceSetting, dos: string,
): 'none' | 'predates' | 'covered' {
  const forSetting = (datasets ?? []).filter((d) => d.serviceSetting === setting);
  if (forSetting.length === 0) return 'none';
  const covers = forSetting.some((d) => d.effectiveDate == null || d.effectiveDate <= dos);
  return covers ? 'covered' : 'predates';
}

/**
 * @param paidSiblingCodes procedure codes on this claim the payer actually
 *   paid — the column-one candidates. Supplied by the caller rather than
 *   re-derived here, because "paid" has to include the remittance being
 *   processed right now: one 835 normally pays one line and denies another in
 *   the same file, and reading only stored amounts made this module answer
 *   "CMS publishes no edit" for a pair CMS does in fact publish.
 */
export function evaluateNcci(
  input: EngineInput, claim: ClaimInput, line: ClaimLineInput,
  paidSiblingCodes: string[] = [],
): NcciAssessment {
  const setting = settingFor(claim);
  const deniedCode = line.procedureCode;
  const bypass = bypassModifiersOn(line);
  const dos = claim.dateOfServiceStart;
  const base = {
    serviceSetting: setting, deniedCode, bypassModifiersBilled: bypass,
  };

  const coverage = coverageFor(input.ncciDatasets, setting, dos);
  if (coverage !== 'covered') {
    const why = coverage === 'none'
      ? `no CMS NCCI ${setting} table is loaded`
      : `the loaded CMS NCCI ${setting} table takes effect after ${dos}`;
    return {
      ...base,
      finding: coverage === 'none' ? 'no_reference_data' : 'reference_predates_service',
      primaryCode: null, modifierIndicator: null,
      appealSupported: false, likelihood: 'medium', scoreAdjustment: 0,
      recommendedAction:
        'Verify the NCCI edit for this pair manually before appealing; if the service '
        + 'was distinct, appeal with modifier 59/XU documentation',
      explanation:
        `Bundling denial could not be checked against CMS edits because ${why}. `
        + 'Import the quarterly PTP file to have this answered automatically.',
    };
  }

  const siblings = [...new Set(paidSiblingCodes)];
  const candidates = (input.ncciEdits ?? []).filter(
    (e) => e.serviceSetting === setting
      && e.columnTwoCode === deniedCode
      && siblings.includes(e.columnOneCode),
  );
  const live = candidates.filter((e) => inForce(e, dos));

  if (live.length === 0) {
    // An edit exists for the pair but not on this date of service — a
    // different statement from CMS never having published one, and a better
    // appeal, because the payer applied a rule that was not in force.
    const withdrawn = candidates[0];
    if (withdrawn) {
      return {
        ...base,
        finding: 'edit_not_in_force',
        primaryCode: withdrawn.columnOneCode,
        modifierIndicator: withdrawn.modifierIndicator,
        appealSupported: true, likelihood: 'high', scoreAdjustment: 15,
        recommendedAction:
          `Appeal: the NCCI edit ${withdrawn.columnOneCode}/${deniedCode} was not in force on ${dos}`,
        explanation:
          `CMS edit ${withdrawn.columnOneCode}/${deniedCode} `
          + `(effective ${withdrawn.effectiveDate}`
          + `${withdrawn.deletionDate ? `, deleted ${withdrawn.deletionDate}` : ''}) `
          + `did not apply to a service on ${dos}, so the bundling has no NCCI basis.`,
      };
    }

    const payer = input.payers.find((p) => p.payerId === claim.payerId);
    const proprietary = payer?.bundlingEditSource === 'proprietary';
    return {
      ...base,
      finding: 'no_edit_published',
      primaryCode: siblings[0] ?? null,
      modifierIndicator: null,
      appealSupported: true,
      likelihood: proprietary ? 'medium' : 'high',
      scoreAdjustment: proprietary ? 5 : 15,
      recommendedAction: proprietary
        ? 'Appeal and demand the written edit rationale: CMS publishes no NCCI edit '
          + 'for this pair, and the contract governs any proprietary edit'
        : 'Appeal: CMS publishes no NCCI edit bundling these procedures',
      explanation: proprietary
        ? `No CMS NCCI ${setting} edit bundles ${deniedCode} into `
          + `${siblings.length ? siblings.join('/') : 'any paid line on this claim'}. `
          + `${payer?.payerName ?? 'This payer'} adjudicates on proprietary edits, so `
          + 'the appeal should require the edit and its contractual basis in writing.'
        : `No CMS NCCI ${setting} edit bundles ${deniedCode} into `
          + `${siblings.length ? siblings.join('/') : 'any paid line on this claim'}, `
          + 'so the denial contradicts the edit tables the payer adjudicates against.',
    };
  }

  // The most restrictive live edit governs: if any pair says never payable,
  // that is the answer regardless of a laxer edit against another sibling.
  const strictest = live.reduce((a, b) => (indicatorRank(a) <= indicatorRank(b) ? a : b));
  const primaryCode = strictest.columnOneCode;

  if (strictest.modifierIndicator === 0) {
    return {
      ...base,
      finding: 'never_separately_payable',
      primaryCode, modifierIndicator: 0,
      appealSupported: false, likelihood: 'low', scoreAdjustment: -35,
      recommendedAction:
        `Do not appeal for unbundling: NCCI edit ${primaryCode}/${deniedCode} carries `
        + 'modifier indicator 0 and no modifier can override it. Review whether the '
        + 'procedure was coded correctly instead',
      explanation:
        `CMS NCCI edit ${primaryCode}/${deniedCode} (effective ${strictest.effectiveDate}) `
        + 'has modifier indicator 0: the pair is never separately payable and appending '
        + '59/XU would be inappropriate. The bundling is correct.',
    };
  }

  if (strictest.modifierIndicator === 9) {
    return {
      ...base,
      finding: 'edit_not_in_force',
      primaryCode, modifierIndicator: 9,
      appealSupported: true, likelihood: 'high', scoreAdjustment: 15,
      recommendedAction:
        `Appeal: NCCI edit ${primaryCode}/${deniedCode} carries modifier indicator 9 `
        + '(edit not applicable)',
      explanation:
        `CMS records modifier indicator 9 for ${primaryCode}/${deniedCode}, meaning the `
        + 'edit does not apply. There is no NCCI basis for bundling these procedures.',
    };
  }

  if (bypass.length > 0) {
    return {
      ...base,
      finding: 'override_billed_and_ignored',
      primaryCode, modifierIndicator: 1,
      appealSupported: true, likelihood: 'high', scoreAdjustment: 20,
      recommendedAction:
        `Appeal: modifier ${bypass.join('/')} was billed and NCCI edit `
        + `${primaryCode}/${deniedCode} permits it to override the bundle`,
      explanation:
        `CMS NCCI edit ${primaryCode}/${deniedCode} has modifier indicator 1, and the `
        + `claim was submitted with ${bypass.join('/')}. The payer bundled despite a valid `
        + 'override, so the appeal turns on the documentation supporting the distinct service.',
    };
  }

  return {
    ...base,
    finding: 'override_available',
    primaryCode, modifierIndicator: 1,
    appealSupported: true, likelihood: 'medium', scoreAdjustment: 0,
    recommendedAction:
      `NCCI edit ${primaryCode}/${deniedCode} permits a modifier override: if the `
      + 'documentation supports a separate and distinct service, submit a corrected '
      + 'claim with modifier 59/XU (or appeal with the operative note)',
    explanation:
      `CMS NCCI edit ${primaryCode}/${deniedCode} has modifier indicator 1 and no bypass `
      + 'modifier was billed. The edit was applied correctly on what was submitted; '
      + 'recovery depends on the record showing a distinct service.',
  };
}

/** 0 (never payable) is the most restrictive, then 1, then 9. */
function indicatorRank(e: NcciEditInput): number {
  return e.modifierIndicator === 0 ? 0 : e.modifierIndicator === 1 ? 1 : 2;
}

/** Procedure codes a run needs edits for — used to keep the snapshot query
 * bounded rather than loading the whole CMS table (millions of pairs). */
export function proceduresNeedingNcci(claims: ClaimInput[]): string[] {
  const codes = new Set<string>();
  for (const c of claims) for (const l of c.lines) if (l.procedureCode) codes.add(l.procedureCode);
  return [...codes];
}
