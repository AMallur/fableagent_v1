// ============================================================================
// STEP 2 — EXPECTED REIMBURSEMENT CALCULATION
//
// For each matched claim line:
//   * find the contract for client + payer, effective at the date of service
//     (latest effective_date wins when several qualify)
//   * find the contract line by procedure code + modifier (exact modifier
//     match preferred, then a no-modifier rate)
//   * percent_of_medicare -> expected = medicare rate * percent * units
//   * fee_schedule        -> expected = contract_line.allowed_amount * units
//   * per_diem/case_rate  -> line-level allowed_amount when present, else proxy
//   * no contract         -> Medicare fee schedule as proxy, flagged no_contract
//
// Two adjustments then apply to whatever rate was found, and both exist to
// stop the engine inventing shortfalls that were never owed:
//
//   MODIFIERS change the percentage payable. A second procedure with modifier
//   51 pays 50%, a bilateral 50 pays 150%, an assistant 80 pays 16%. Pricing
//   these at 100% makes every modified line look half underpaid. Rules compose
//   multiplicatively in applyOrder — a bilateral assistant is 150% then 16%.
//
//   LESSER OF BILLED. Nearly every contract owes the lesser of billed charges
//   and the contracted rate, so a line billed below the rate was never going
//   to pay the rate. Comparing it against the rate manufactures a variance out
//   of the provider's own charge master.
//
// The payer's post-adjudication payment reduction (Medicare sequestration) is
// deliberately NOT applied here: it reduces the PAYMENT, not the allowed
// amount, so it belongs in Step 3 against expected payer liability.
// ============================================================================

import type {
  ClaimInput, ClaimLineInput, ContractInput, ContractLineInput, EngineInput,
  LinePricing, ModifierPaymentRule,
} from '../types.ts';
import { round2 } from '../config.ts';
import type { MatchedLine } from './step1_matching.ts';

function contractActiveOn(c: ContractInput, dos: string): boolean {
  return c.effectiveDate <= dos && (!c.expirationDate || c.expirationDate >= dos);
}

function findContract(
  contracts: ContractInput[], clientId: string, payerId: string, dos: string,
): ContractInput | undefined {
  const eligible = contracts
    .filter((c) => c.clientId === clientId && c.payerId === payerId && contractActiveOn(c, dos))
    .sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1));
  return eligible[0];
}

function findContractLine(
  contract: ContractInput, procedureCode: string, modifiers: string[], dos: string,
): ContractLineInput | undefined {
  const candidates = contract.lines.filter(
    (l) => l.procedureCode === procedureCode
      && (!l.effectiveDate || l.effectiveDate <= dos),
  );
  // exact modifier match beats a generic (no-modifier) rate
  const exact = candidates
    .filter((l) => l.modifier && modifiers.includes(l.modifier))
    .sort(byEffectiveDateDesc)[0];
  if (exact) return exact;
  return candidates.filter((l) => !l.modifier).sort(byEffectiveDateDesc)[0];
}

function byEffectiveDateDesc(a: ContractLineInput, b: ContractLineInput): number {
  return (a.effectiveDate ?? '') < (b.effectiveDate ?? '') ? 1 : -1;
}

function medicareRate(
  rates: Record<string, number>, procedureCode: string, modifiers: string[],
  locality: string | undefined, placeOfService: string | null | undefined,
): number | null {
  const setting = medicareServiceSetting(placeOfService);
  if (locality && setting) {
    for (const m of modifiers) {
      const detailed = rates[`${procedureCode}|${m}|${locality}|${setting}`];
      if (detailed != null) return detailed;
    }
    const genericDetailed = rates[`${procedureCode}||${locality}|${setting}`];
    if (genericDetailed != null) return genericDetailed;
  }
  // Compatibility for manually seeded/test data only. Versioned imports are
  // not exposed under these keys, so missing locality/POS fails closed.
  for (const m of modifiers) {
    const withMod = rates[`${procedureCode}|${m}`];
    if (withMod != null) return withMod;
  }
  return rates[`${procedureCode}|`] ?? null;
}

/** Pilot-safe CMS PFS setting map. POS 11 is the supported nonfacility office
 * setting; the listed facility settings are hospital/ER/ASC/SNF sites. Other
 * POS values fail closed until their payment-setting rule is configured. */
function medicareServiceSetting(pos: string | null | undefined): 'facility' | 'nonfacility' | null {
  if (pos === '11') return 'nonfacility';
  if (pos && new Set(['19', '21', '22', '23', '24', '31']).has(pos)) return 'facility';
  return null;
}

/**
 * The modifier rules that apply to this line, most specific first: a
 * tenant+payer rule beats a tenant-wide rule, which beats the shared default.
 * Only one rule per modifier survives.
 */
function modifierRulesFor(
  input: EngineInput, payerId: string, modifiers: string[],
): ModifierPaymentRule[] {
  const all = input.modifierRules ?? [];
  if (all.length === 0 || modifiers.length === 0) return [];
  const chosen: ModifierPaymentRule[] = [];
  for (const modifier of modifiers) {
    const candidates = all.filter((r) => r.modifier === modifier
      && (r.payerId == null || r.payerId === payerId));
    if (candidates.length === 0) continue;
    // specificity: payer-scoped, then tenant-scoped, then shared default
    candidates.sort((a, b) => specificity(b) - specificity(a));
    chosen.push(candidates[0]);
  }
  return chosen.sort((a, b) => a.applyOrder - b.applyOrder);
}

function specificity(rule: ModifierPaymentRule): number {
  return (rule.payerId != null ? 2 : 0) + (rule.tenantId != null ? 1 : 0);
}

function applyModifiers(
  amount: number, input: EngineInput, payerId: string, modifiers: string[],
): number {
  let value = amount;
  for (const rule of modifierRulesFor(input, payerId, modifiers)) {
    value = value * (rule.percentOfAllowed / 100);
  }
  return round2(value);
}

/** The lesser of billed charges and the contracted rate, when the contract
 * says so. Applied last, after modifiers, because the contract term is about
 * the final amount payable. */
function capAtBilled(
  amount: number, line: ClaimLineInput, contract: ContractInput | undefined,
): number {
  if (!contract || contract.applyLesserOfBilled === false) return amount;
  if (!Number.isFinite(line.billedAmount)) return amount;
  return round2(Math.min(amount, line.billedAmount));
}

export function priceClaimLine(
  input: EngineInput, claim: ClaimInput, line: ClaimLineInput,
): LinePricing {
  const contract = findContract(
    input.contracts, claim.clientId, claim.payerId, claim.dateOfServiceStart,
  );
  const units = line.units || 1;

  /** Base rate x units, then modifier percentages, then the lesser-of-billed
   * cap. Every pricing path funnels through here so no route can quietly skip
   * an adjustment. */
  const settle = (rate: number): number => capAtBilled(
    applyModifiers(round2(rate * units), input, claim.payerId, line.modifiers),
    line, contract,
  );

  if (contract) {
    const cl = findContractLine(
      contract, line.procedureCode, line.modifiers, claim.dateOfServiceStart,
    );
    if (cl) {
      if (contract.feeScheduleType === 'percent_of_medicare' && cl.percentOfMedicare != null) {
        const rate = medicareRate(input.medicareRates, line.procedureCode, line.modifiers,
          input.medicareLocalityByClient[claim.clientId], claim.placeOfService);
        if (rate != null) {
          return {
            claimId: claim.claimId, claimLineId: line.claimLineId,
            expectedAmount: settle(rate * (cl.percentOfMedicare / 100)),
            expectedSource: 'contract', contractId: contract.contractId, noContract: false,
          };
        }
        // percent contract but no Medicare reference rate: fall through to proxy
      } else if (cl.allowedAmount != null) {
        // fee_schedule, and the per_diem/case_rate fallback when a line rate exists
        return {
          claimId: claim.claimId, claimLineId: line.claimLineId,
          expectedAmount: settle(cl.allowedAmount),
          expectedSource: 'contract', contractId: contract.contractId, noContract: false,
        };
      }
    }
    // contract exists but no usable line rate: proxy-price, still flagged
    // no_contract=false (a contract IS on file; the fee schedule has a gap)
    const proxy = medicareRate(input.medicareRates, line.procedureCode, line.modifiers,
      input.medicareLocalityByClient[claim.clientId], claim.placeOfService);
    return {
      claimId: claim.claimId, claimLineId: line.claimLineId,
      expectedAmount: proxy != null ? settle(proxy) : null,
      expectedSource: proxy != null ? 'medicare_proxy' : 'none',
      contractId: contract.contractId, noContract: false,
    };
  }

  // no contract at all -> Medicare proxy, flagged no_contract
  const proxy = medicareRate(input.medicareRates, line.procedureCode, line.modifiers,
    input.medicareLocalityByClient[claim.clientId], claim.placeOfService);
  return {
    claimId: claim.claimId, claimLineId: line.claimLineId,
    // No contract, so no lesser-of term to apply — but modifier percentages
    // are a property of the fee schedule, not the contract, and still hold.
    expectedAmount: proxy != null
      ? applyModifiers(round2(proxy * units), input, claim.payerId, line.modifiers)
      : null,
    expectedSource: proxy != null ? 'medicare_proxy' : 'none',
    noContract: true,
  };
}

/** Price every distinct claim line that has a matched remit. */
export function runExpectedCalculation(
  input: EngineInput, matchedLines: MatchedLine[],
): Map<string, LinePricing> {
  const pricing = new Map<string, LinePricing>();
  for (const { claim, claimLine } of matchedLines) {
    if (pricing.has(claimLine.claimLineId)) continue;
    pricing.set(claimLine.claimLineId, priceClaimLine(input, claim, claimLine));
  }
  return pricing;
}
