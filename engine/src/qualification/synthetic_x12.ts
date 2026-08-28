// ============================================================================
// Synthetic X12 generator for pre-pilot qualification.
//
// The existing benchmark (src/pilot/benchmark.ts) builds an EngineInput in
// memory, which measures detection accuracy but never touches the parser, the
// database, or the ingest transaction. Those are exactly where a first live
// deployment gets hurt, so this generator emits real 837P and 835 documents
// that go through the same code path a payer file does.
//
// Two properties matter more than volume:
//
//   1. The 835 balances per TR3. A generator that emits unbalanced remittances
//      would trip the balance policy on every file and measure the rejection
//      path instead of the pipeline. Each claim's CAS adjustments are derived
//      from the payment so that SVC02 - sum(line CAS) = SVC03,
//      CLP03 - sum(CAS) = CLP04, and sum(CLP04) - sum(PLB) = BPR02.
//
//   2. Generation is deterministic. Given the same seed the same documents come
//      out, so a load run that finds a defect can be replayed exactly, and the
//      expected findings are known without re-deriving them from the output.
// ============================================================================

/** Scenario a generated claim is built to exercise. */
export type SyntheticScenario =
  | 'clean'                 // paid at the contracted rate; nothing to find
  | 'underpaid'             // paid below the contracted allowed amount
  | 'denied_auth'           // CO-197 precertification absent
  | 'denied_bundled'        // CO-97 included in another service
  | 'denied_coding'         // CO-16 claim lacks information
  | 'denied_noncovered'     // CO-96 non-covered charge
  | 'reversal';             // a prior payment taken back (CLP02 = 22)

export interface SyntheticLine {
  procedureCode: string;
  modifiers: string[];
  chargeAmount: number;
  units: number;
  dateOfService: string;      // YYYY-MM-DD
  contractedAllowed: number;
  paidAmount: number;
  /** Adjustment group/reason/amount triples applied at the line. */
  adjustments: { group: string; reason: string; amount: number }[];
}

export interface SyntheticClaim {
  scenario: SyntheticScenario;
  claimNumber: string;
  payerClaimControlNumber: string;
  /** CLP02 claim status: 1 processed as primary, 4 denied, 22 reversal. */
  claimStatus: string;
  patient: {
    lastName: string; firstName: string; memberId: string;
    dob: string; gender: string;
  };
  diagnosisCode: string;
  authorizationNumber: string | null;
  renderingProviderNpi: string;
  renderingProviderName: string;
  lines: SyntheticLine[];
  /** Sum of line charges — CLM02 and CLP03. */
  totalCharge: number;
  /** Sum of line payments — CLP04. */
  totalPaid: number;
  /** What a correct adjudication would have paid, for scoring findings. */
  expectedPaid: number;
}

export interface SyntheticBatch {
  /** The 837P document as it would arrive from the practice's biller. */
  claimFile: string;
  /** The 835 remittance that adjudicates exactly those claims. */
  remittanceFile: string;
  claims: SyntheticClaim[];
  checkNumber: string;
  checkDate: string;          // YYYY-MM-DD
  /** BPR02 — what the payer says it sent. */
  paymentTotal: number;
  /** Provider-level adjustment (PLB) applied to this check, if any. */
  providerAdjustment: number;
}

export interface GeneratorOptions {
  /** Deterministic seed. The same seed produces byte-identical documents. */
  seed?: number;
  /** Claims per batch. One batch is one 837 file and one 835 file. */
  claimsPerBatch?: number;
  /** Service lines per claim, chosen uniformly from this inclusive range. */
  linesPerClaim?: [number, number];
  /** Relative weight of each scenario. Omitted scenarios never appear. */
  mix?: Partial<Record<SyntheticScenario, number>>;
  /** Payer name and identifier as they appear in the documents. */
  payerName?: string;
  payerIdCode?: string;
  billingProviderName?: string;
  billingProviderNpi?: string;
  /** Contracted allowed amount per procedure code, for this payer. */
  feeSchedule?: Record<string, number>;
  /** First date of service; later claims walk forward from here. */
  startDate?: string;
  /** Prefix for claim numbers, so concurrent generators cannot collide. */
  claimPrefix?: string;
  /** Apply a provider-level adjustment (PLB) to the check. */
  providerAdjustment?: number;
}

// The default mix approximates what a commercial payer's remittance actually
// looks like for an orthopedic practice: most lines pay correctly, and the
// tail is where the money is. It is not tuned to flatter the detector — the
// clean majority exists so that a false-positive rate means something.
const DEFAULT_MIX: Record<SyntheticScenario, number> = {
  clean: 70,
  underpaid: 12,
  denied_auth: 6,
  denied_bundled: 5,
  denied_coding: 4,
  denied_noncovered: 2,
  reversal: 1,
};

// Matches the seeded demo contracts so generated claims price against a real
// contract rather than falling through to "no rate on file".
const DEFAULT_FEE_SCHEDULE: Record<string, number> = {
  '99213': 125.00,
  '99214': 185.00,
  '99215': 245.00,
  '20610': 190.00,
  '29881': 850.00,
  '73721': 320.00,
  '97110': 45.00,
};

const DIAGNOSIS_CODES = ['M1711', 'M2551', 'M5416', 'S8391A', 'M7522', 'M79641'];
const LAST_NAMES = ['NGUYEN', 'OKAFOR', 'RIVERA', 'ANDERSSON', 'HAQUE', 'KOWALSKI',
  'MBEKI', 'FITZGERALD', 'YAMAMOTO', 'DELACRUZ'];
const FIRST_NAMES = ['ALEX', 'JORDAN', 'SAM', 'RILEY', 'CASEY', 'MORGAN',
  'AVERY', 'QUINN', 'ROWAN', 'SASHA'];

/**
 * mulberry32 — a small deterministic PRNG. Math.random cannot be seeded, and a
 * load run that cannot be replayed cannot be used to reproduce a defect it
 * found.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function fmt(value: number): string {
  return money(value).toFixed(2);
}

/** YYYY-MM-DD to the YYYYMMDD form X12 date elements use. */
function x12Day(iso: string): string {
  return iso.replaceAll('-', '');
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function weightedScenario(
  rng: () => number, mix: Record<SyntheticScenario, number>,
): SyntheticScenario {
  const entries = Object.entries(mix).filter(([, weight]) => weight > 0) as [SyntheticScenario, number][];
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let threshold = rng() * total;
  for (const [scenario, weight] of entries) {
    threshold -= weight;
    if (threshold <= 0) return scenario;
  }
  return entries[entries.length - 1][0];
}

/**
 * Build one service line and the adjudication that goes with it. The
 * adjustments are derived from the payment rather than chosen independently,
 * which is what keeps the remittance balanced.
 */
function buildLine(
  rng: () => number,
  scenario: SyntheticScenario,
  feeSchedule: Record<string, number>,
  dateOfService: string,
  isFirstLine: boolean,
): SyntheticLine {
  const codes = Object.keys(feeSchedule);
  const procedureCode = pick(rng, codes);
  const contractedAllowed = feeSchedule[procedureCode];
  // Practices bill well above contract; the contractual write-off is the
  // difference, and is not a finding.
  const chargeAmount = money(contractedAllowed * (1.8 + rng() * 0.9));
  const contractual = money(chargeAmount - contractedAllowed);

  const adjustments: SyntheticLine['adjustments'] = [];
  let paidAmount = 0;

  switch (scenario) {
    case 'clean': {
      paidAmount = contractedAllowed;
      adjustments.push({ group: 'CO', reason: '45', amount: contractual });
      break;
    }
    case 'underpaid': {
      // A real underpayment is a wrong allowed amount, not a wrong write-off:
      // the payer takes a larger CO-45 than the contract permits.
      const shortfall = money(contractedAllowed * (0.08 + rng() * 0.22));
      paidAmount = money(contractedAllowed - shortfall);
      adjustments.push({ group: 'CO', reason: '45', amount: money(chargeAmount - paidAmount) });
      break;
    }
    case 'denied_auth': {
      adjustments.push({ group: 'CO', reason: '197', amount: chargeAmount });
      break;
    }
    case 'denied_bundled': {
      // Bundling only reclassifies when a sibling line on the same claim paid,
      // so the first line pays and the second is the bundled denial.
      if (isFirstLine) {
        paidAmount = contractedAllowed;
        adjustments.push({ group: 'CO', reason: '45', amount: contractual });
      } else {
        adjustments.push({ group: 'CO', reason: '97', amount: chargeAmount });
      }
      break;
    }
    case 'denied_coding': {
      adjustments.push({ group: 'CO', reason: '16', amount: chargeAmount });
      break;
    }
    case 'denied_noncovered': {
      adjustments.push({ group: 'CO', reason: '96', amount: chargeAmount });
      break;
    }
    case 'reversal': {
      // A reversal mirrors the original adjudication with every amount negated
      // — charge included. Negating only the payment leaves
      // charge - adjustments != payment and the file fails TR3 balancing, which
      // is how a real payer's reversal would be rejected too.
      paidAmount = money(-contractedAllowed);
      adjustments.push({ group: 'CO', reason: '45', amount: money(-contractual) });
      break;
    }
  }

  const signedCharge = scenario === 'reversal' ? money(-chargeAmount) : chargeAmount;

  return {
    procedureCode,
    modifiers: [],
    chargeAmount: signedCharge,
    units: 1,
    dateOfService,
    contractedAllowed,
    paidAmount: money(paidAmount),
    adjustments,
  };
}

/** Generate one paired 837/835 batch. */
export function generateBatch(options: GeneratorOptions = {}): SyntheticBatch {
  const rng = seededRandom(options.seed ?? 1);
  const claimsPerBatch = options.claimsPerBatch ?? 25;
  const [minLines, maxLines] = options.linesPerClaim ?? [1, 3];
  const mix = { ...DEFAULT_MIX, ...options.mix } as Record<SyntheticScenario, number>;
  const feeSchedule = options.feeSchedule ?? DEFAULT_FEE_SCHEDULE;
  const payerName = options.payerName ?? 'MERIDIAN BLUE';
  const payerIdCode = options.payerIdCode ?? 'DEMO-MBL';
  const billingProviderName = options.billingProviderName ?? 'ALPHA ORTHOPEDIC GROUP';
  const billingProviderNpi = options.billingProviderNpi ?? '1234567890';
  const startDate = options.startDate ?? '2026-01-05';
  const claimPrefix = options.claimPrefix ?? 'SYN';
  const providerAdjustment = options.providerAdjustment ?? 0;

  const claims: SyntheticClaim[] = [];

  for (let index = 0; index < claimsPerBatch; index += 1) {
    const scenario = weightedScenario(rng, mix);
    // Bundling needs at least two lines to have a sibling to bundle into.
    const wanted = minLines + Math.floor(rng() * (maxLines - minLines + 1));
    const lineCount = scenario === 'denied_bundled' ? Math.max(2, wanted) : wanted;
    const dateOfService = addDays(startDate, Math.floor(rng() * 45));

    const lines: SyntheticLine[] = [];
    for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
      lines.push(buildLine(rng, scenario, feeSchedule, dateOfService, lineIndex === 0));
    }

    const totalCharge = money(lines.reduce((sum, line) => sum + line.chargeAmount, 0));
    const totalPaid = money(lines.reduce((sum, line) => sum + line.paidAmount, 0));
    const expectedPaid = money(lines.reduce((sum, line) => {
      // What a correct adjudication owed: the contracted rate on anything that
      // should have paid. Denials that are genuinely correct owe nothing.
      if (scenario === 'denied_noncovered' || scenario === 'denied_coding') return sum;
      if (scenario === 'reversal') return sum + line.paidAmount;
      return sum + line.contractedAllowed;
    }, 0));

    const sequence = String(index + 1).padStart(6, '0');
    claims.push({
      scenario,
      claimNumber: `${claimPrefix}-CLM-${sequence}`,
      payerClaimControlNumber: `${claimPrefix}-ICN-${sequence}`,
      claimStatus: scenario === 'reversal' ? '22' : (totalPaid > 0 ? '1' : '4'),
      patient: {
        lastName: pick(rng, LAST_NAMES),
        firstName: pick(rng, FIRST_NAMES),
        memberId: `${claimPrefix}MEM${sequence}`,
        dob: addDays('1955-01-01', Math.floor(rng() * 20000)),
        gender: rng() < 0.5 ? 'F' : 'M',
      },
      diagnosisCode: pick(rng, DIAGNOSIS_CODES),
      authorizationNumber: scenario === 'denied_auth' ? `AUTH-${sequence}` : null,
      renderingProviderNpi: '1111111111',
      renderingProviderName: 'SMITH',
      lines,
      totalCharge,
      totalPaid,
      expectedPaid,
    });
  }

  const paymentTotal = money(
    claims.reduce((sum, claim) => sum + claim.totalPaid, 0) - providerAdjustment,
  );
  const checkDate = addDays(startDate, 60);
  const checkNumber = `${claimPrefix}-CHK-${String(options.seed ?? 1).padStart(6, '0')}`;

  return {
    claimFile: render837(claims, { billingProviderName, billingProviderNpi, payerName, startDate }),
    remittanceFile: render835(claims, {
      payerName, payerIdCode, billingProviderName, billingProviderNpi,
      checkNumber, checkDate, paymentTotal, providerAdjustment,
    }),
    claims,
    checkNumber,
    checkDate,
    paymentTotal,
    providerAdjustment,
  };
}

function isaSegment(day: string): string {
  return 'ISA*00*          *00*          *ZZ*SYNTHSENDER    *ZZ*SYNTHRECEIVER  '
    + `*${day.slice(2)}*1200*^*00501*000000001*0*T*:~`;
}

function render837(
  claims: SyntheticClaim[],
  ctx: { billingProviderName: string; billingProviderNpi: string; payerName: string; startDate: string },
): string {
  const day = x12Day(ctx.startDate);
  const segments: string[] = [
    isaSegment(day),
    `GS*HC*SYNTHSENDER*SYNTHRECEIVER*${day}*1200*1*X*005010X222A1~`,
    'ST*837*0001*005010X222A1~',
    `BHT*0019*00*SYNTH*${day}*1200*CH~`,
    `NM1*85*2*${ctx.billingProviderName}*****XX*${ctx.billingProviderNpi}~`,
    'HL*1**20*1~',
  ];

  claims.forEach((claim, index) => {
    segments.push(`HL*${index + 2}*1*22*0~`);
    segments.push('SBR*P*18*******CI~');
    segments.push(
      `NM1*IL*1*${claim.patient.lastName}*${claim.patient.firstName}****MI*${claim.patient.memberId}~`,
    );
    segments.push(`DMG*D8*${x12Day(claim.patient.dob)}*${claim.patient.gender}~`);
    segments.push(`NM1*PR*2*${ctx.payerName}~`);
    segments.push(`CLM*${claim.claimNumber}*${fmt(claim.totalCharge)}***11:B:1*Y*A*Y*Y~`);
    segments.push(`HI*ABK:${claim.diagnosisCode}~`);
    if (claim.authorizationNumber) segments.push(`REF*G1*${claim.authorizationNumber}~`);
    segments.push(
      `NM1*82*1*${claim.renderingProviderName}*ADAM****XX*${claim.renderingProviderNpi}~`,
    );
    claim.lines.forEach((line, lineIndex) => {
      const procedure = line.modifiers.length
        ? `HC:${line.procedureCode}:${line.modifiers.join(':')}`
        : `HC:${line.procedureCode}`;
      segments.push(`LX*${lineIndex + 1}~`);
      segments.push(`SV1*${procedure}*${fmt(line.chargeAmount)}*UN*${line.units}***1~`);
      segments.push(`DTP*472*D8*${x12Day(line.dateOfService)}~`);
    });
  });

  segments.push(`SE*${segments.length}*0001~`, 'GE*1*1~', 'IEA*1*000000001~');
  return segments.join('\n');
}

function render835(
  claims: SyntheticClaim[],
  ctx: {
    payerName: string; payerIdCode: string;
    billingProviderName: string; billingProviderNpi: string;
    checkNumber: string; checkDate: string;
    paymentTotal: number; providerAdjustment: number;
  },
): string {
  const day = x12Day(ctx.checkDate);
  const segments: string[] = [
    isaSegment(day),
    `GS*HP*SYNTHSENDER*SYNTHRECEIVER*${day}*1200*1*X*005010X221A1~`,
    'ST*835*0001~',
    `BPR*I*${fmt(ctx.paymentTotal)}*C*ACH*CCP*01*999999999*DA*123456*1512345678`
      + `**01*999988880*DA*98765*${day}~`,
    `TRN*1*${ctx.checkNumber}*1512345678~`,
    `N1*PR*${ctx.payerName}*PI*${ctx.payerIdCode}~`,
    `N1*PE*${ctx.billingProviderName}*XX*${ctx.billingProviderNpi}~`,
    'LX*1~',
  ];

  for (const claim of claims) {
    segments.push(
      `CLP*${claim.claimNumber}*${claim.claimStatus}*${fmt(claim.totalCharge)}`
      + `*${fmt(claim.totalPaid)}*0*12*${claim.payerClaimControlNumber}*11*1~`,
    );
    segments.push(
      `NM1*QC*1*${claim.patient.lastName}*${claim.patient.firstName}****MI*${claim.patient.memberId}~`,
    );
    segments.push(`DTM*232*${x12Day(claim.lines[0].dateOfService)}~`);
    for (const line of claim.lines) {
      const procedure = line.modifiers.length
        ? `HC:${line.procedureCode}:${line.modifiers.join(':')}`
        : `HC:${line.procedureCode}`;
      segments.push(
        `SVC*${procedure}*${fmt(line.chargeAmount)}*${fmt(line.paidAmount)}**${line.units}~`,
      );
      segments.push(`DTM*472*${x12Day(line.dateOfService)}~`);
      for (const adjustment of line.adjustments) {
        segments.push(`CAS*${adjustment.group}*${adjustment.reason}*${fmt(adjustment.amount)}~`);
      }
    }
  }

  if (ctx.providerAdjustment !== 0) {
    // PLB amounts carry the opposite sign convention to the check: a positive
    // PLB reduces what the payer sends.
    segments.push(
      `PLB*${ctx.billingProviderNpi}*${day.slice(0, 4)}1231*WO:SYNTH*${fmt(ctx.providerAdjustment)}~`,
    );
  }

  segments.push(`SE*${segments.length}*0001~`, 'GE*1*1~', 'IEA*1*000000001~');
  return segments.join('\n');
}

/**
 * Generate `batchCount` batches whose claim numbers cannot collide, so several
 * can be ingested concurrently or sequentially into the same client.
 */
export function generateBatches(
  batchCount: number, options: GeneratorOptions = {},
): SyntheticBatch[] {
  const batches: SyntheticBatch[] = [];
  const baseSeed = options.seed ?? 1;
  const basePrefix = options.claimPrefix ?? 'SYN';
  for (let index = 0; index < batchCount; index += 1) {
    batches.push(generateBatch({
      ...options,
      seed: baseSeed + index,
      // The seed has to reach the claim number, not just the content. Without
      // it two runs at different seeds emit the same claim numbers, so the
      // second run updates the first run's claims instead of adding to them —
      // which silently turns a scaling sweep into a no-op.
      claimPrefix: `${basePrefix}${baseSeed.toString(36)}X${index}`,
      startDate: options.startDate ?? '2026-01-05',
    }));
  }
  return batches;
}
