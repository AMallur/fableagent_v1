import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseX12, x12Date } from '../src/ingest/x12.ts';
import { parse835 } from '../src/ingest/parse835.ts';
import { parse837 } from '../src/ingest/parse837.ts';

// canonical fixed-width ISA (105 chars + terminator) — proves separator detection
const ISA = 'ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *260625*1200*^*00501*000000001*0*P*:~';

export const FIXTURE_835 = [
  ISA,
  'GS*HP*SENDER*RECEIVER*20260625*1200*1*X*005010X221A1~',
  'ST*835*0001~',
  'BPR*I*80.00*C*ACH*CCP*01*999999999*DA*123456*1512345678**01*999988880*DA*98765*20260625~',
  'TRN*1*CHK-IT-100*1512345678~',
  'N1*PR*UNITED COMMERCIAL*PI*87726~',
  'N1*PE*ALPHA ORTHO GROUP*XX*1234567890~',
  'LX*1~',
  'CLP*IT-CLM-1*1*250.00*80.00*0*12*IT-ICN-1*11*1~',
  'NM1*QC*1*DOE*JANE****MI*MEM-IT-1~',
  'DTM*232*20260601~',
  'SVC*HC:99213*250.00*80.00**1~',
  'DTM*472*20260601~',
  'CAS*CO*45*170~',
  'AMT*B6*125.00~',
  'CLP*IT-CLM-2*4*250.00*0.00*0*12*IT-ICN-2*11*1~',
  'NM1*QC*1*DOE*JANE****MI*MEM-IT-1~',
  'DTM*232*20260602~',
  'SVC*HC:99214*250.00*0.00**1~',
  'DTM*472*20260602~',
  'CAS*CO*197*250~',
  'SE*20*0001~',
  'GE*1*1~',
  'IEA*1*000000001~',
].join('\n');

export const FIXTURE_837 = [
  ISA,
  'GS*HC*SENDER*RECEIVER*20260605*1200*1*X*005010X222A1~',
  'ST*837*0001*005010X222A1~',
  'BHT*0019*00*1234*20260605*1200*CH~',
  'NM1*85*2*ALPHA ORTHO GROUP*****XX*1234567890~',
  'HL*1**20*1~',
  'HL*2*1*22*0~',
  'SBR*P*18*******CI~',
  'NM1*IL*1*DOE*JANE****MI*MEM-IT-1~',
  'DMG*D8*19800501*F~',
  'NM1*PR*2*UNITED COMMERCIAL~',
  'CLM*IT-CLM-1*250.00***11:B:1*Y*A*Y*Y~',
  'HI*ABK:M1711~',
  'NM1*82*1*SMITH*ADAM****XX*1111111111~',
  'LX*1~',
  'SV1*HC:99213*250.00*UN*1***1~',
  'DTP*472*D8*20260601~',
  'CLM*IT-CLM-2*250.00***11:B:1*Y*A*Y*Y~',
  'REF*G1*AUTH-42~',   // the auth-denied claim carries the auth number
  'HI*ABK:M2551~',
  'LX*1~',
  'SV1*HC:99214*250.00*UN*1***1~',
  'DTP*472*D8*20260602~',
  'SE*22*0001~',
  'GE*1*1~',
  'IEA*1*000000001~',
].join('\n');

describe('x12 tokenizer', () => {
  it('detects separators from the ISA envelope', () => {
    const doc = parseX12(FIXTURE_835);
    assert.equal(doc.componentSeparator, ':');
    assert.equal(doc.segments[0].id, 'ISA');
    assert.ok(doc.segments.some((s) => s.id === 'CLP'));
  });

  it('falls back to conventional separators without an ISA', () => {
    const doc = parseX12('ST*835*0001~BPR*I*80.00~');
    assert.equal(doc.segments.length, 2);
    assert.equal(doc.segments[1].elements[1], '80.00');
  });

  it('parses D8 and YYMMDD dates', () => {
    assert.equal(x12Date('20260601'), '2026-06-01');
    assert.equal(x12Date('260601'), '2026-06-01');
    assert.equal(x12Date('junk'), null);
  });
});

describe('835 parser', () => {
  const era = parse835(FIXTURE_835);

  it('reads the payment envelope', () => {
    assert.equal(era.payerName, 'UNITED COMMERCIAL');
    assert.equal(era.payerIdCode, '87726');
    assert.equal(era.payeeNpi, '1234567890');
    assert.equal(era.totalPaid, 80);
    assert.equal(era.checkDate, '2026-06-25');
    assert.equal(era.traceNumber, 'CHK-IT-100');
  });

  it('reads claims with patient, ICN, and amounts', () => {
    assert.equal(era.claims.length, 2);
    const [c1, c2] = era.claims;
    assert.equal(c1.patientControlNumber, 'IT-CLM-1');
    assert.equal(c1.payerClaimNumber, 'IT-ICN-1');
    assert.equal(c1.billedAmount, 250);
    assert.equal(c1.paidAmount, 80);
    assert.equal(c1.patient.memberId, 'MEM-IT-1');
    assert.equal(c1.patient.lastName, 'DOE');
    assert.equal(c2.statusCode, '4'); // denied
    assert.equal(c2.paidAmount, 0);
  });

  it('reads service lines with CAS adjustments and allowed amounts', () => {
    const l1 = era.claims[0].lines[0];
    assert.equal(l1.procedureCode, '99213');
    assert.equal(l1.paidAmount, 80);
    assert.equal(l1.allowedAmount, 125);
    assert.equal(l1.dateOfService, '2026-06-01');
    assert.deepEqual(l1.adjustments, [{ groupCode: 'CO', reasonCode: '45', amount: 170 }]);

    const l2 = era.claims[1].lines[0];
    assert.deepEqual(l2.adjustments, [{ groupCode: 'CO', reasonCode: '197', amount: 250 }]);
  });
});

describe('837 parser', () => {
  const file = parse837(FIXTURE_837);

  it('reads the billing provider and transaction date', () => {
    assert.equal(file.billingProviderNpi, '1234567890');
    assert.equal(file.transactionDate, '2026-06-05');
  });

  it('reads claims with subscriber, diagnosis, auth, rendering provider', () => {
    assert.equal(file.claims.length, 2);
    const c1 = file.claims[0];
    assert.equal(c1.patientControlNumber, 'IT-CLM-1');
    assert.equal(c1.chargeAmount, 250);
    assert.equal(c1.placeOfService, '11');
    assert.deepEqual(c1.diagnosisCodes, ['M1711']);
    assert.equal(c1.authorizationNumber, null);
    assert.equal(c1.subscriber.memberId, 'MEM-IT-1');
    assert.equal(c1.subscriber.dob, '1980-05-01');
    assert.equal(c1.renderingProviderNpi, '1111111111');
    // subscriber context carries into the second claim in the same loop
    assert.equal(file.claims[1].subscriber.memberId, 'MEM-IT-1');
    assert.equal(file.claims[1].authorizationNumber, 'AUTH-42');
  });

  it('reads service lines with dates', () => {
    const l = file.claims[0].lines[0];
    assert.equal(l.procedureCode, '99213');
    assert.equal(l.chargeAmount, 250);
    assert.equal(l.units, 1);
    assert.equal(l.dateOfService, '2026-06-01');
  });
});

// ---------------------------------------------------------------------------
// multi-transaction 835 + CSV + preview (integration layer additions)
// ---------------------------------------------------------------------------

import { parse835File } from '../src/ingest/parse835.ts';
import { parseRemittanceCsv, splitCsvLine } from '../src/ingest/csv.ts';
import { detectFileKind, previewIngestFile } from '../src/ingest/service.ts';

export const FIXTURE_835_MULTI = [
  'ST*835*0001~',
  'BPR*I*100.00*C*ACH***01*1*DA*1*1**01*1*DA*1*20260701~',
  'TRN*1*CHK-M-1*1~',
  'N1*PR*UNITY HEALTH PLAN*PI*DEMO-UNI~',
  'CLP*M-CLM-1*1*200.00*100.00*0*12*M-ICN-1~',
  'NM1*QC*1*DOE*JANE****MI*MEM-1~',
  'SVC*HC:99213*200.00*100.00**1~',
  'DTM*472*20260620~',
  'SE*8*0001~',
  'ST*835*0002~',
  'BPR*I*0.00*C*ACH***01*1*DA*1*1**01*1*DA*1*20260702~',
  'TRN*1*CHK-M-2*1~',
  'N1*PR*MERIDIAN BLUE*PI*DEMO-MBL~',
  'CLP*M-CLM-2*4*300.00*0.00*0*12*M-ICN-2~',
  'NM1*QC*1*ROE*RIK****MI*MEM-2~',
  'SVC*HC:99214*300.00*0.00**1~',
  'CAS*CO*197*300~',
  'SE*9*0002~',
].join('\n');

describe('835 multi-transaction files', () => {
  it('splits one file into one remittance per ST/SE set', () => {
    const remits = parse835File(FIXTURE_835_MULTI);
    assert.equal(remits.length, 2);
    assert.equal(remits[0].traceNumber, 'CHK-M-1');
    assert.equal(remits[0].payerName, 'UNITY HEALTH PLAN');
    assert.equal(remits[0].claims[0].payerClaimNumber, 'M-ICN-1');
    assert.equal(remits[1].traceNumber, 'CHK-M-2');
    assert.equal(remits[1].payerName, 'MERIDIAN BLUE');
    assert.deepEqual(remits[1].claims[0].lines[0].adjustments,
      [{ groupCode: 'CO', reasonCode: '197', amount: 300 }]);
  });

  it('single-transaction files still parse as one', () => {
    assert.equal(parse835File(FIXTURE_835).length, 1);
  });
});

describe('CSV remittance parser', () => {
  const CSV = [
    'Claim Number,Payer Claim Number,Member ID,DOS,Procedure Code,Billed Amount,Allowed Amount,Paid Amount,Group Code,Reason Code,Check Number,Check Date,Payer Name',
    'CLM-9001,ICN-9001,MEM-1,06/20/2026,99213,"250.00",125.00,80.00,CO,45,CHK-CSV-1,2026-07-01,Unity Health Plan',
    'CLM-9002,ICN-9002,MEM-2,2026-06-21,99214,300,,0,CO,197,CHK-CSV-1,2026-07-01,Unity Health Plan',
  ].join('\n');

  it('tokenizes quoted fields and escaped quotes', () => {
    assert.deepEqual(splitCsvLine('a,"b,c","d""x"'), ['a', 'b,c', 'd"x']);
  });

  it('parses rows with header aliases, US dates, and money formats', () => {
    const out = parseRemittanceCsv(CSV);
    assert.equal(out.errors.length, 0);
    assert.equal(out.rows.length, 2);
    const [r1, r2] = out.rows;
    assert.equal(r1.claimNumber, 'CLM-9001');
    assert.equal(r1.dos, '2026-06-20');           // US date normalized
    assert.equal(r1.billedAmount, 250);           // quoted money
    assert.equal(r1.paidAmount, 80);
    assert.equal(r1.reasonCode, '45');
    assert.equal(r2.paidAmount, 0);
    assert.equal(r2.allowedAmount, null);
  });

  it('rejects files without required columns; reports bad rows by line', () => {
    assert.match(parseRemittanceCsv('a,b\n1,2').errors[0], /procedure_code/);
    const partial = parseRemittanceCsv(
      'claim_number,procedure_code,paid_amount\nCLM-1,99213,50\nCLM-2,,25\n');
    assert.equal(partial.rows.length, 1);
    assert.match(partial.errors[0], /line 3/);
  });
});

describe('file kind detection + preview', () => {
  it('detects by extension and by content', () => {
    assert.equal(detectFileKind('x.835', ''), '835');
    assert.equal(detectFileKind('x.era', ''), '835');
    assert.equal(detectFileKind('x.837', ''), '837');
    assert.equal(detectFileKind('x.csv', ''), 'csv');
    assert.equal(detectFileKind('drop.dat', FIXTURE_835), '835');
    assert.equal(detectFileKind('drop.dat', FIXTURE_837), '837');
    assert.equal(detectFileKind('drop.dat', 'claim_number,paid\nA,1'), 'csv');
  });

  it('previews an 835 without writing anything', () => {
    const p = previewIngestFile('preview.835', FIXTURE_835_MULTI);
    assert.equal(p.kind, '835');
    assert.equal(p.ok, true);
    assert.equal(p.summary.transactions, 2);
    assert.equal(p.summary.claims, 2);
    assert.deepEqual(p.summary.payers, ['UNITY HEALTH PLAN', 'MERIDIAN BLUE']);
    assert.equal(p.summary.totalPaid, 100);
    assert.ok(p.summary.sample.length === 2);
  });

  it('previews garbage as a readable error, not a crash', () => {
    const p = previewIngestFile('junk.bin', 'not edi at all');
    assert.equal(p.ok, false);
    assert.ok(p.errors.length >= 1);
  });
});
