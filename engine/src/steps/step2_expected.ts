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
// ============================================================================

import type {
  ClaimInput, ClaimLineInput, ContractInput, ContractLineInput, EngineInput,
  LinePricing,
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
): number | null {
  for (const m of modifiers) {
    const withMod = rates[`${procedureCode}|${m}`];
    if (withMod != null) return withMod;
  }
  return rates[`${procedureCode}|`] ?? null;
}

export function priceClaimLine(
  input: EngineInput, claim: ClaimInput, line: ClaimLineInput,
): LinePricing {
  const contract = findContract(
    input.contracts, claim.clientId, claim.payerId, claim.dateOfServiceStart,
  );
  const units = line.units || 1;

  if (contract) {
    const cl = findContractLine(
      contract, line.procedureCode, line.modifiers, claim.dateOfServiceStart,
    );
    if (cl) {
      if (contract.feeScheduleType === 'percent_of_medicare' && cl.percentOfMedicare != null) {
        const rate = medicareRate(input.medicareRates, line.procedureCode, line.modifiers);
        if (rate != null) {
          return {
            claimId: claim.claimId, claimLineId: line.claimLineId,
            expectedAmount: round2(rate * (cl.percentOfMedicare / 100) * units),
            expectedSource: 'contract', contractId: contract.contractId, noContract: false,
          };
        }
        // percent contract but no Medicare reference rate: fall through to proxy
      } else if (cl.allowedAmount != null) {
        // fee_schedule, and the per_diem/case_rate fallback when a line rate exists
        return {
          claimId: claim.claimId, claimLineId: line.claimLineId,
          expectedAmount: round2(cl.allowedAmount * units),
          expectedSource: 'contract', contractId: contract.contractId, noContract: false,
        };
      }
    }
    // contract exists but no usable line rate: proxy-price, still flagged
    // no_contract=false (a contract IS on file; the fee schedule has a gap)
    const proxy = medicareRate(input.medicareRates, line.procedureCode, line.modifiers);
    return {
      claimId: claim.claimId, claimLineId: line.claimLineId,
      expectedAmount: proxy != null ? round2(proxy * units) : null,
      expectedSource: proxy != null ? 'medicare_proxy' : 'none',
      contractId: contract.contractId, noContract: false,
    };
  }

  // no contract at all -> Medicare proxy, flagged no_contract
  const proxy = medicareRate(input.medicareRates, line.procedureCode, line.modifiers);
  return {
    claimId: claim.claimId, claimLineId: line.claimLineId,
    expectedAmount: proxy != null ? round2(proxy * units) : null,
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
