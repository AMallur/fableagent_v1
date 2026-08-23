// ============================================================================
// 837P (Professional Claim) parser — pure. Covers the core loops:
//   BHT   transaction date               NM1*85 billing provider (NPI)
//   NM1*IL subscriber  DMG demographics  NM1*PR payer
//   CLM   claim (control no, charge, POS) HI diagnosis codes (ABK/ABF)
//   REF*G1 prior authorization           NM1*82 rendering provider
//   LX/SV1 service lines                 DTP*472 service date
//   SBR   payer responsibility sequence  AMT*D  claim-level COB payer paid
//   SVD   line-level COB payer paid
//
// Coordination of benefits matters because expected payer liability on a
// secondary claim is the allowed amount less patient responsibility AND less
// what the primary already paid. SBR01 in loop 2000B says where this payer
// sits in the coverage order; the 2320 loop that follows the claim carries the
// other payer's SBR plus AMT*D (what they paid), and the 2430 loop carries
// SVD02 per service line, which is the precise figure when it is supplied.
// ============================================================================

import { components, el, parseX12, x12Amount, x12Date } from './x12.ts';

export interface ServiceLine837 {
  procedureCode: string;
  modifiers: string[];
  chargeAmount: number | null;
  units: number;
  dateOfService: string | null;
  /** SVD02 — what a prior payer paid for this line (loop 2430). */
  priorPayerPaid: number | null;
}

/** SBR01 payer responsibility sequence code. */
export type PayerSequence837 = 'primary' | 'secondary' | 'tertiary' | 'unknown';

export interface Claim837 {
  patientControlNumber: string;     // CLM01 — becomes claim_number_internal
  chargeAmount: number | null;      // CLM02
  placeOfService: string | null;    // CLM05-1
  diagnosisCodes: string[];         // HI ABK/ABF
  authorizationNumber: string | null; // REF*G1
  subscriber: {
    lastName: string; firstName: string; memberId: string;
    dob: string | null; gender: string | null;
  };
  payerName: string | null;
  renderingProviderNpi: string | null;
  renderingProviderName: string | null;
  /** Where this claim's payer sits in the patient's coverage order. */
  payerSequence: PayerSequence837;
  /** AMT*D in loop 2320 — what the prior payer paid on the whole claim. */
  priorPayerPaid: number | null;
  lines: ServiceLine837[];
}

export interface ClaimFile837 {
  transactionDate: string | null;   // BHT04
  billingProviderName: string | null;
  billingProviderNpi: string | null;
  claims: Claim837[];
}

/** SBR01: P primary, S secondary, T tertiary; A-H and U are other/unknown. */
function payerSequenceFrom(code: string): PayerSequence837 {
  switch (code.trim().toUpperCase()) {
    case 'P': return 'primary';
    case 'S': return 'secondary';
    case 'T': return 'tertiary';
    case '': return 'primary';
    default: return 'unknown';
  }
}

function round2Money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function parse837(raw: string): ClaimFile837 {
  const { segments, componentSeparator } = parseX12(raw);

  const result: ClaimFile837 = {
    transactionDate: null, billingProviderName: null, billingProviderNpi: null,
    claims: [],
  };

  let claim: Claim837 | null = null;
  let line: ServiceLine837 | null = null;
  // subscriber context persists across claims within the same subscriber loop
  let subscriber: Claim837['subscriber'] = {
    lastName: '', firstName: '', memberId: '', dob: null, gender: null,
  };
  let payerName: string | null = null;
  // SBR01 seen before the claim describes THIS payer's place in the coverage
  // order (loop 2000B). An SBR after the claim opens the other-payer loop
  // (2320), whose AMT*D is what that payer paid.
  let subscriberSequence: PayerSequence837 = 'primary';
  let inOtherPayerLoop = false;

  for (const seg of segments) {
    switch (seg.id) {
      case 'BHT':
        result.transactionDate = x12Date(el(seg, 4));
        break;
      case 'SBR': {
        const sequence = payerSequenceFrom(el(seg, 1));
        if (claim) {
          // loop 2320 — the OTHER payer on this claim
          inOtherPayerLoop = true;
        } else {
          subscriberSequence = sequence;
        }
        break;
      }
      case 'AMT':
        // loop 2320 AMT*D — payer paid amount from the prior payer
        if (claim && inOtherPayerLoop && el(seg, 1) === 'D') {
          claim.priorPayerPaid = round2Money(
            (claim.priorPayerPaid ?? 0) + (x12Amount(el(seg, 2)) ?? 0),
          );
        }
        break;
      case 'SVD':
        // loop 2430 — prior payer's adjudication of one service line
        if (line) {
          const paid = x12Amount(el(seg, 2));
          if (paid != null) line.priorPayerPaid = round2Money((line.priorPayerPaid ?? 0) + paid);
        }
        break;
      case 'NM1': {
        const qual = el(seg, 1);
        if (qual === '85') {
          result.billingProviderName = el(seg, 3);
          if (el(seg, 8) === 'XX') result.billingProviderNpi = el(seg, 9) || null;
        } else if (qual === 'IL') {
          subscriber = {
            lastName: el(seg, 3), firstName: el(seg, 4),
            memberId: el(seg, 9), dob: null, gender: null,
          };
        } else if (qual === 'PR') {
          payerName = el(seg, 3) || null;
        } else if (qual === '82' && claim) {
          claim.renderingProviderName = [el(seg, 4), el(seg, 3)].filter(Boolean).join(' ');
          if (el(seg, 8) === 'XX') claim.renderingProviderNpi = el(seg, 9) || null;
        }
        break;
      }
      case 'DMG':
        if (el(seg, 1) === 'D8') {
          subscriber.dob = x12Date(el(seg, 2));
          subscriber.gender = el(seg, 3) || null;
        }
        break;
      case 'CLM': {
        line = null;
        inOtherPayerLoop = false;
        const pos = components(el(seg, 5), componentSeparator);
        claim = {
          patientControlNumber: el(seg, 1),
          chargeAmount: x12Amount(el(seg, 2)),
          placeOfService: pos[0] || null,
          diagnosisCodes: [],
          authorizationNumber: null,
          subscriber: { ...subscriber },
          payerName,
          renderingProviderNpi: null,
          renderingProviderName: null,
          payerSequence: subscriberSequence,
          priorPayerPaid: null,
          lines: [],
        };
        result.claims.push(claim);
        break;
      }
      case 'HI':
        if (claim) {
          for (const raw of seg.elements) {
            const c = components(raw, componentSeparator);
            if (['ABK', 'ABF', 'BK', 'BF'].includes(c[0]) && c[1]) {
              claim.diagnosisCodes.push(c[1]);
            }
          }
        }
        break;
      case 'REF':
        if (claim && el(seg, 1) === 'G1') claim.authorizationNumber = el(seg, 2) || null;
        break;
      case 'SV1': {
        if (!claim) break;
        // Service lines end the claim-level other-payer loop.
        inOtherPayerLoop = false;
        const proc = components(el(seg, 1), componentSeparator); // HC:99213:25
        line = {
          procedureCode: proc[1] ?? '',
          modifiers: proc.slice(2).filter(Boolean),
          chargeAmount: x12Amount(el(seg, 2)),
          units: Number(el(seg, 4)) || 1,
          dateOfService: null,
          priorPayerPaid: null,
        };
        claim.lines.push(line);
        break;
      }
      case 'DTP':
        if (line && el(seg, 1) === '472') {
          // D8 single date or RD8 range (take the start)
          const v = el(seg, 3);
          line.dateOfService = x12Date(el(seg, 2) === 'RD8' ? v.split('-')[0] : v);
        }
        break;
      default:
        break;
    }
  }

  return result;
}
