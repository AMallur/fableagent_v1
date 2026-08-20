// ============================================================================
// 835 (Electronic Remittance Advice) parser — pure, file text in, structured
// remittance out. Covers the segments the platform needs:
//   BPR  payment amount + date          TRN  check / EFT trace number
//   N1*PR payer  N1*PE payee            CLP  claim payment info + status
//   NM1*QC patient                      SVC  service line (adjudicated +
//   DTM*232/472 dates                        originally submitted code/units)
//   CAS  adjustments (CARC + quantity)  AMT*B6 allowed amount
//   LQ/MOA remark codes (RARC)          PLB  provider-level adjustments
//
// PLB is not optional detail. Recoupments, forwarding balances, interest and
// capitation move real money that never appears on a CLP claim, and a check
// only balances as BPR02 = sum(CLP04) - sum(PLB).
// ============================================================================

import { components, el, parseX12, x12Amount, x12Date, type Segment } from './x12.ts';

export interface Adjustment835 {
  groupCode: string;   // CO / PR / OA / PI
  reasonCode: string;  // CARC, e.g. '45'
  amount: number;
  /** CAS quantity (units the adjustment applies to), when the payer sent one. */
  quantity: number | null;
}

export interface ServiceLine835 {
  /** The code that identifies OUR claim line: SVC06 when the payer re-coded,
   * otherwise SVC01. Match and price against this. */
  procedureCode: string;
  /** SVC01 — the code the payer actually adjudicated. */
  adjudicatedProcedureCode: string;
  /** True when SVC06 was present and differs from SVC01 (payer downcode/recode). */
  payerRecoded: boolean;
  /** Modifiers on the adjudicated code (SVC01). */
  modifiers: string[];
  /** Modifiers on the originally submitted code (SVC06), when present. */
  submittedModifiers: string[];
  billedAmount: number | null;
  paidAmount: number | null;
  allowedAmount: number | null;
  /** Units to match and price against: SVC07 (originally submitted) when the
   * payer reported one, otherwise SVC05. */
  units: number;
  /** SVC05 — units the payer actually paid. */
  paidUnits: number;
  /** SVC07 — units originally submitted, when the payer reported it. */
  originalUnits: number | null;
  dateOfService: string | null;
  adjustments: Adjustment835[];
  remarkCodes: string[];
}

export interface Claim835 {
  patientControlNumber: string;   // CLP01 — our claim_number_internal
  statusCode: string;             // CLP02 — 1 processed primary, 4 denied, 22 reversal
  /** CLP02 = 22: this claim reverses a previously reported payment. Its
   * amounts are negative and it must never be read as a new adjudication. */
  isReversal: boolean;
  billedAmount: number | null;    // CLP03
  paidAmount: number | null;      // CLP04
  patientResponsibility: number | null; // CLP05
  payerClaimNumber: string;       // CLP07 — payer ICN
  patient: { lastName: string; firstName: string; memberId: string };
  claimDate: string | null;       // DTM*232
  adjustments: Adjustment835[];   // claim-level CAS
  lines: ServiceLine835[];
}

/** PLB — a provider-level adjustment. Positive amounts REDUCE the payment. */
export interface ProviderAdjustment835 {
  providerNpi: string | null;     // PLB01
  fiscalPeriodEnd: string | null; // PLB02
  sequenceNumber: number;         // 1-based position within the PLB segments
  reasonCode: string;             // PLB03-1 etc.
  referenceId: string | null;     // PLB03-2 — normally the ICN being adjusted
  amount: number;
  category: ProviderAdjustmentCategory;
}

export type ProviderAdjustmentCategory =
  | 'recoupment' | 'forwarding_balance' | 'interest' | 'capitation'
  | 'refund' | 'penalty' | 'transfer' | 'other';

/**
 * PLB03-1 reason codes, from the X12 835 provider adjustment code list.
 * Anything unmapped stays 'other' — it is still stored and still balances.
 */
const PLB_CATEGORY: Record<string, ProviderAdjustmentCategory> = {
  WO: 'recoupment',          // overpayment recovery
  FB: 'forwarding_balance',  // balance carried to a future remittance
  '72': 'refund',            // authorized return
  CS: 'recoupment',          // adjustment (payer-initiated correction)
  AP: 'recoupment',          // acceleration of benefits
  E3: 'recoupment',          // withholding
  L3: 'interest',
  L6: 'interest',
  '50': 'penalty',           // late charge
  '51': 'penalty',           // interest penalty charge
  CP: 'capitation',          // corrected priced claim / capitation payment
  B2: 'refund',              // rebate
  B3: 'refund',              // recovery allowance
  IR: 'penalty',             // internal revenue withholding
  FC: 'transfer',            // fund allocation
  AM: 'other',               // applied to borrower's account
  AH: 'other',               // origination fee
  BD: 'other',               // bad debt adjustment
  BN: 'other',               // bonus
  C5: 'other',               // temporary allowance
  CR: 'other',               // capitation interest
  CT: 'capitation',          // capitation payment
  CV: 'capitation',          // capital passthru
  DM: 'other',               // direct medical education
  GO: 'other',               // graduate medical education
  HM: 'other',               // hemophilia clotting factor supplement
  IP: 'other',               // incentive premium payment
  J1: 'other',               // nonreimbursable
  L1: 'other',               // litigation center
  LE: 'other',               // levy
  LS: 'other',               // lump sum
  OA: 'other',               // organ acquisition
  OB: 'other',               // offset for affiliated providers
  PI: 'other',               // periodic interim payment
  PL: 'other',               // payment final
  RA: 'other',               // retro-activity adjustment
  RE: 'other',               // return on equity
  SL: 'other',               // student loan repayment
  TL: 'other',               // third party liability
  WU: 'other',               // unspecified recovery
};

export function providerAdjustmentCategory(reasonCode: string): ProviderAdjustmentCategory {
  return PLB_CATEGORY[reasonCode.trim().toUpperCase()] ?? 'other';
}

/** Categories whose cash the provider does not keep. */
const REDUCES_PROVIDER_CASH = new Set<ProviderAdjustmentCategory>([
  'recoupment', 'forwarding_balance', 'refund', 'penalty',
]);

export function reducesProviderCash(category: ProviderAdjustmentCategory): boolean {
  return REDUCES_PROVIDER_CASH.has(category);
}

export interface Remittance835 {
  payerName: string;
  payerIdCode: string | null;
  payeeName: string;
  payeeNpi: string | null;
  totalPaid: number | null;       // BPR02
  checkDate: string | null;       // BPR16
  traceNumber: string | null;     // TRN02 (check or EFT trace)
  claims: Claim835[];
  providerAdjustments: ProviderAdjustment835[];
}

function parseCas(seg: Segment): Adjustment835[] {
  // CAS*CO*45*120*2*97*30 — group, then repeating (reason, amount, quantity)
  const out: Adjustment835[] = [];
  const groupCode = el(seg, 1);
  for (let i = 2; i <= seg.elements.length; i += 3) {
    const reasonCode = el(seg, i);
    const amount = x12Amount(el(seg, i + 1));
    if (!reasonCode || amount == null) continue;
    out.push({ groupCode, reasonCode, amount, quantity: x12Amount(el(seg, i + 2)) });
  }
  return out;
}

/**
 * PLB*1234567890*20261231*WO:ICN-9001*125.00*L6:REF-2*-3.10
 * PLB01 provider NPI, PLB02 fiscal period end, then up to six
 * (composite reason:reference, amount) pairs.
 */
function parsePlb(
  seg: Segment, componentSeparator: string, startSequence: number,
): ProviderAdjustment835[] {
  const providerNpi = el(seg, 1) || null;
  const fiscalPeriodEnd = x12Date(el(seg, 2));
  const out: ProviderAdjustment835[] = [];
  let sequence = startSequence;
  for (let i = 3; i <= seg.elements.length; i += 2) {
    const composite = el(seg, i);
    const amount = x12Amount(el(seg, i + 1));
    if (!composite || amount == null) continue;
    const parts = components(composite, componentSeparator);
    const reasonCode = (parts[0] ?? '').trim().toUpperCase();
    if (!reasonCode) continue;
    out.push({
      providerNpi,
      fiscalPeriodEnd,
      sequenceNumber: sequence,
      reasonCode,
      referenceId: parts.slice(1).join(componentSeparator).trim() || null,
      amount,
      category: providerAdjustmentCategory(reasonCode),
    });
    sequence += 1;
  }
  return out;
}

/**
 * A production 835 file can carry several ST/SE transaction sets (one per
 * check). parse835File splits on ST*835 and parses each; parse835 keeps the
 * original single-remittance behavior (first/only transaction).
 */
export function parse835File(raw: string): Remittance835[] {
  const { segments, componentSeparator } = parseX12(raw);
  const groups: Segment[][] = [];
  let current: Segment[] | null = null;
  for (const seg of segments) {
    if (seg.id === 'ST' && el(seg, 1) === '835') {
      current = [];
      groups.push(current);
    } else if (seg.id === 'SE') {
      current = null;
    } else if (current) {
      current.push(seg);
    }
  }
  if (groups.length === 0) return [parse835Segments(segments, componentSeparator)];
  return groups.map((g) => parse835Segments(g, componentSeparator));
}

export function parse835(raw: string): Remittance835 {
  return parse835File(raw)[0];
}

function parse835Segments(segments: Segment[], componentSeparator: string): Remittance835 {
  const result: Remittance835 = {
    payerName: '', payerIdCode: null, payeeName: '', payeeNpi: null,
    totalPaid: null, checkDate: null, traceNumber: null, claims: [],
    providerAdjustments: [],
  };

  let currentN1: string | null = null;
  let claim: Claim835 | null = null;
  let line: ServiceLine835 | null = null;

  for (const seg of segments) {
    switch (seg.id) {
      case 'BPR':
        result.totalPaid = x12Amount(el(seg, 2));
        result.checkDate = x12Date(el(seg, 16));
        break;
      case 'TRN':
        result.traceNumber = el(seg, 2) || null;
        break;
      case 'N1':
        currentN1 = el(seg, 1);
        if (currentN1 === 'PR') {
          result.payerName = el(seg, 2);
          if (el(seg, 4)) result.payerIdCode = el(seg, 4);
        } else if (currentN1 === 'PE') {
          result.payeeName = el(seg, 2);
          if (el(seg, 3) === 'XX') result.payeeNpi = el(seg, 4) || null;
        }
        break;
      case 'REF':
        // payer secondary ID (2U = payer identification)
        if (currentN1 === 'PR' && el(seg, 1) === '2U' && !result.payerIdCode) {
          result.payerIdCode = el(seg, 2) || null;
        }
        break;
      case 'CLP': {
        line = null;
        const statusCode = el(seg, 2);
        claim = {
          patientControlNumber: el(seg, 1),
          statusCode,
          isReversal: statusCode === '22',
          billedAmount: x12Amount(el(seg, 3)),
          paidAmount: x12Amount(el(seg, 4)),
          patientResponsibility: x12Amount(el(seg, 5)),
          payerClaimNumber: el(seg, 7),
          patient: { lastName: '', firstName: '', memberId: '' },
          claimDate: null,
          adjustments: [],
          lines: [],
        };
        result.claims.push(claim);
        break;
      }
      case 'NM1':
        if (claim && el(seg, 1) === 'QC') {
          claim.patient = {
            lastName: el(seg, 3),
            firstName: el(seg, 4),
            memberId: el(seg, 9),
          };
        }
        break;
      case 'SVC': {
        if (!claim) break;
        // SVC01 is the ADJUDICATED code; SVC06 carries the code we originally
        // submitted and is present only when the payer changed it. Our claim
        // line is identified by what we submitted, so SVC06 wins when present.
        const adjudicated = components(el(seg, 1), componentSeparator); // HC:99213:25
        const submitted = components(el(seg, 6), componentSeparator);
        const adjudicatedCode = adjudicated[1] ?? '';
        const submittedCode = submitted[1] ?? '';
        const payerRecoded = Boolean(submittedCode) && submittedCode !== adjudicatedCode;
        const paidUnits = Number(el(seg, 5)) || 1;
        const originalUnits = el(seg, 7) ? Number(el(seg, 7)) : null;
        line = {
          procedureCode: submittedCode || adjudicatedCode,
          adjudicatedProcedureCode: adjudicatedCode,
          payerRecoded,
          modifiers: adjudicated.slice(2).filter(Boolean),
          submittedModifiers: submitted.slice(2).filter(Boolean),
          billedAmount: x12Amount(el(seg, 2)),
          paidAmount: x12Amount(el(seg, 3)),
          allowedAmount: null,
          units: originalUnits != null && Number.isFinite(originalUnits) && originalUnits > 0
            ? originalUnits
            : paidUnits,
          paidUnits,
          originalUnits: originalUnits != null && Number.isFinite(originalUnits)
            ? originalUnits
            : null,
          dateOfService: null,
          adjustments: [],
          remarkCodes: [],
        };
        claim.lines.push(line);
        break;
      }
      case 'DTM': {
        const qual = el(seg, 1);
        const date = x12Date(el(seg, 2));
        if (!date) break;
        if (line && qual === '472') line.dateOfService = date;
        else if (claim && qual === '232' && !line) claim.claimDate = date;
        break;
      }
      case 'CAS': {
        const adjustments = parseCas(seg);
        if (line) line.adjustments.push(...adjustments);
        else if (claim) claim.adjustments.push(...adjustments);
        break;
      }
      case 'AMT':
        if (line && el(seg, 1) === 'B6') line.allowedAmount = x12Amount(el(seg, 2));
        break;
      case 'LQ':
        if (line && el(seg, 1) === 'HE') line.remarkCodes.push(el(seg, 2));
        break;
      case 'PLB':
        // PLB is in the summary table, after every claim.
        claim = null;
        line = null;
        result.providerAdjustments.push(
          ...parsePlb(seg, componentSeparator, result.providerAdjustments.length + 1),
        );
        break;
      default:
        break;
    }
  }

  return result;
}
