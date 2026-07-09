// ============================================================================
// 835 (Electronic Remittance Advice) parser — pure, file text in, structured
// remittance out. Covers the segments the platform needs:
//   BPR  payment amount + date          TRN  check / EFT trace number
//   N1*PR payer  N1*PE payee            CLP  claim payment info
//   NM1*QC patient                      SVC  service line
//   DTM*232/472 dates                   CAS  adjustments (CARC)
//   AMT*B6 allowed amount               LQ/MOA remark codes (RARC)
// ============================================================================

import { components, el, parseX12, x12Amount, x12Date, type Segment } from './x12.ts';

export interface Adjustment835 {
  groupCode: string;   // CO / PR / OA / PI
  reasonCode: string;  // CARC, e.g. '45'
  amount: number;
}

export interface ServiceLine835 {
  procedureCode: string;
  modifiers: string[];
  billedAmount: number | null;
  paidAmount: number | null;
  allowedAmount: number | null;
  units: number;
  dateOfService: string | null;
  adjustments: Adjustment835[];
  remarkCodes: string[];
}

export interface Claim835 {
  patientControlNumber: string;   // CLP01 — our claim_number_internal
  statusCode: string;             // CLP02 — 1 processed primary, 4 denied, ...
  billedAmount: number | null;    // CLP03
  paidAmount: number | null;      // CLP04
  patientResponsibility: number | null; // CLP05
  payerClaimNumber: string;       // CLP07 — payer ICN
  patient: { lastName: string; firstName: string; memberId: string };
  claimDate: string | null;       // DTM*232
  adjustments: Adjustment835[];   // claim-level CAS
  lines: ServiceLine835[];
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
}

function parseCas(seg: Segment): Adjustment835[] {
  // CAS*CO*45*120**97*30 — group, then repeating (reason, amount, quantity)
  const out: Adjustment835[] = [];
  const groupCode = el(seg, 1);
  for (let i = 2; i <= seg.elements.length; i += 3) {
    const reasonCode = el(seg, i);
    const amount = x12Amount(el(seg, i + 1));
    if (reasonCode && amount != null) out.push({ groupCode, reasonCode, amount });
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
      case 'CLP':
        line = null;
        claim = {
          patientControlNumber: el(seg, 1),
          statusCode: el(seg, 2),
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
        const proc = components(el(seg, 1), componentSeparator); // HC:99213:25:...
        line = {
          procedureCode: proc[1] ?? '',
          modifiers: proc.slice(2).filter(Boolean),
          billedAmount: x12Amount(el(seg, 2)),
          paidAmount: x12Amount(el(seg, 3)),
          allowedAmount: null,
          units: Number(el(seg, 5)) || 1,
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
      default:
        break;
    }
  }

  return result;
}
