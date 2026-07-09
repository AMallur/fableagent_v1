// ============================================================================
// CSV remittance parser — for clients whose PM system exports payment data
// as CSV rather than 835 EDI.
//
// Expected header row (case/space/underscore-insensitive; extra columns are
// ignored):
//   claim_number        internal claim number (this OR payer_claim_number required)
//   payer_claim_number  payer ICN
//   member_id           subscriber/member ID
//   dos                 date of service (YYYY-MM-DD or MM/DD/YYYY)
//   procedure_code      CPT/HCPCS (required)
//   billed_amount, allowed_amount, paid_amount (paid required)
//   patient_responsibility, units
//   group_code, reason_code, remark_code     CARC/RARC detail
//   check_number, check_date, payer_name
// ============================================================================

export interface CsvRemitRow {
  line: number;                      // 1-based source line for error messages
  claimNumber: string | null;
  payerClaimNumber: string | null;
  memberId: string | null;
  dos: string | null;
  procedureCode: string;
  billedAmount: number | null;
  allowedAmount: number | null;
  paidAmount: number;
  patientResponsibility: number | null;
  units: number | null;
  groupCode: string | null;
  reasonCode: string | null;
  remarkCode: string | null;
  checkNumber: string | null;
  checkDate: string | null;
  payerName: string | null;
}

export interface CsvParseResult {
  rows: CsvRemitRow[];
  errors: string[];
}

const HEADER_ALIASES: Record<string, string> = {
  claimnumber: 'claimNumber', claim: 'claimNumber', claimno: 'claimNumber',
  payerclaimnumber: 'payerClaimNumber', icn: 'payerClaimNumber',
  memberid: 'memberId', subscriberid: 'memberId', insuranceid: 'memberId',
  dos: 'dos', dateofservice: 'dos', servicedate: 'dos',
  procedurecode: 'procedureCode', cpt: 'procedureCode', procedure: 'procedureCode', hcpcs: 'procedureCode',
  billedamount: 'billedAmount', billed: 'billedAmount', charge: 'billedAmount',
  allowedamount: 'allowedAmount', allowed: 'allowedAmount',
  paidamount: 'paidAmount', paid: 'paidAmount', payment: 'paidAmount',
  patientresponsibility: 'patientResponsibility', patientresp: 'patientResponsibility',
  units: 'units', quantity: 'units',
  groupcode: 'groupCode', adjustmentgroup: 'groupCode',
  reasoncode: 'reasonCode', carc: 'reasonCode', adjustmentreason: 'reasonCode', denialcode: 'reasonCode',
  remarkcode: 'remarkCode', rarc: 'remarkCode',
  checknumber: 'checkNumber', check: 'checkNumber', efttrace: 'checkNumber',
  checkdate: 'checkDate', paymentdate: 'checkDate',
  payername: 'payerName', payer: 'payerName',
};

/** RFC-4180-ish tokenizer: quoted fields, escaped quotes, CRLF tolerant */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');

function parseDate(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return null;
}

function parseMoney(v: string): number | null {
  const s = v.replace(/[$,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function parseRemittanceCsv(text: string): CsvParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { rows: [], errors: ['CSV must contain a header row and at least one data row'] };
  }

  const headers = splitCsvLine(lines[0]).map((h) => HEADER_ALIASES[normHeader(h)] ?? null);
  if (!headers.includes('procedureCode') || !headers.includes('paidAmount')) {
    return {
      rows: [],
      errors: ['CSV header must include procedure_code and paid_amount columns '
        + `(recognized: ${headers.filter(Boolean).join(', ') || 'none'})`],
    };
  }
  if (!headers.includes('claimNumber') && !headers.includes('payerClaimNumber')) {
    return { rows: [], errors: ['CSV header must include claim_number or payer_claim_number'] };
  }

  const rows: CsvRemitRow[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const get = (key: string): string => {
      const idx = headers.indexOf(key);
      return idx === -1 ? '' : (cells[idx] ?? '');
    };

    const procedureCode = get('procedureCode');
    const paid = parseMoney(get('paidAmount'));
    const claimNumber = get('claimNumber') || null;
    const payerClaimNumber = get('payerClaimNumber') || null;

    if (!procedureCode) { errors.push(`line ${i + 1}: missing procedure_code`); continue; }
    if (paid == null) { errors.push(`line ${i + 1}: missing or invalid paid_amount`); continue; }
    if (!claimNumber && !payerClaimNumber) {
      errors.push(`line ${i + 1}: needs claim_number or payer_claim_number`);
      continue;
    }

    rows.push({
      line: i + 1,
      claimNumber,
      payerClaimNumber,
      memberId: get('memberId') || null,
      dos: parseDate(get('dos')),
      procedureCode,
      billedAmount: parseMoney(get('billedAmount')),
      allowedAmount: parseMoney(get('allowedAmount')),
      paidAmount: paid,
      patientResponsibility: parseMoney(get('patientResponsibility')),
      units: parseMoney(get('units')),
      groupCode: get('groupCode').toUpperCase() || null,
      reasonCode: get('reasonCode') || null,
      remarkCode: get('remarkCode') || null,
      checkNumber: get('checkNumber') || null,
      checkDate: parseDate(get('checkDate')),
      payerName: get('payerName') || null,
    });
  }

  return { rows, errors };
}
