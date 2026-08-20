// ============================================================================
// 835 financial balancing — pure. Structured remittances in, findings out.
//
// The X12 835 TR3 defines three balancing rules. A file that violates them is
// either malformed or has been parsed wrongly, and in both cases every
// downstream number (variance, recovery opportunity, recovered dollars) is
// built on sand. Checking here is the cheapest guard the pipeline has.
//
//   service line   SVC02 - sum(line CAS)                       = SVC03
//   claim          CLP03 - sum(claim CAS + all line CAS)       = CLP04
//   transaction    sum(CLP04) - sum(PLB)                       = BPR02
//
// PLB amounts are positive when they reduce the payment, which is why the
// transaction rule subtracts them.
//
// Reversal claims (CLP02 = 22) carry negative amounts and balance by exactly
// the same arithmetic — they are not a special case here.
// ============================================================================

import type { Remittance835 } from './parse835.ts';

export type BalanceRule = 'service_line' | 'claim' | 'transaction' | 'patient_responsibility';

export interface BalanceFinding {
  severity: 'error' | 'warning';
  rule: BalanceRule;
  /** CLP01 of the claim involved, when the finding is claim- or line-scoped. */
  claim?: string;
  /** Procedure code of the service line involved. */
  procedureCode?: string;
  expected: number;
  actual: number;
  variance: number;
  message: string;
}

export interface BalanceResult {
  balanced: boolean;
  /** Transaction-level signed variance: (sum(CLP04) - sum(PLB)) - BPR02. */
  transactionVariance: number;
  claimPaymentTotal: number;
  providerAdjustmentTotal: number;
  reportedTotal: number | null;
  findings: BalanceFinding[];
}

export interface BalanceOptions {
  /** Absolute dollar tolerance per rule. Zero means exact. */
  tolerance?: number;
}

const r2 = (n: number): number => {
  // Normalize negative zero: a variance of -0 reads as a real (signed)
  // difference in JSON and in a numeric column, and it is not one.
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
};

function outside(variance: number, tolerance: number): boolean {
  // half a cent guards float representation; the tolerance is the operator's
  // documented allowance on top of it
  return Math.abs(variance) > tolerance + 0.005;
}

function finding(
  severity: BalanceFinding['severity'], rule: BalanceRule,
  expected: number, actual: number, message: string,
  scope: { claim?: string; procedureCode?: string } = {},
): BalanceFinding {
  return {
    severity, rule, ...scope,
    expected: r2(expected), actual: r2(actual), variance: r2(expected - actual),
    message,
  };
}

const money = (n: number): string => `$${r2(n).toFixed(2)}`;

/** Balance one 835 transaction set (one check / EFT). */
export function balance835(era: Remittance835, options: BalanceOptions = {}): BalanceResult {
  const tolerance = Math.max(0, options.tolerance ?? 0);
  const findings: BalanceFinding[] = [];

  let claimPaymentTotal = 0;

  for (const claim of era.claims) {
    const claimLabel = claim.patientControlNumber || claim.payerClaimNumber || '(unidentified)';
    const claimPaid = claim.paidAmount ?? 0;
    claimPaymentTotal += claimPaid;

    let lineAdjustmentTotal = 0;

    for (const line of claim.lines) {
      const lineAdjustments = line.adjustments.reduce((s, a) => s + a.amount, 0);
      lineAdjustmentTotal += lineAdjustments;

      // A payer may omit SVC02 on some lines; without a submitted charge there
      // is nothing to balance against and silence is correct.
      if (line.billedAmount == null) continue;
      const expectedPaid = line.billedAmount - lineAdjustments;
      const actualPaid = line.paidAmount ?? 0;
      if (outside(expectedPaid - actualPaid, tolerance)) {
        findings.push(finding(
          'error', 'service_line', expectedPaid, actualPaid,
          `service line ${line.procedureCode || '(no code)'} on claim ${claimLabel}: `
          + `charge ${money(line.billedAmount)} less adjustments ${money(lineAdjustments)} `
          + `is ${money(expectedPaid)}, but the payer reported ${money(actualPaid)} paid`,
          { claim: claimLabel, procedureCode: line.procedureCode || undefined },
        ));
      }
    }

    const claimAdjustments = claim.adjustments.reduce((s, a) => s + a.amount, 0);
    const totalAdjustments = claimAdjustments + lineAdjustmentTotal;

    if (claim.billedAmount != null) {
      const expectedPaid = claim.billedAmount - totalAdjustments;
      if (outside(expectedPaid - claimPaid, tolerance)) {
        findings.push(finding(
          'error', 'claim', expectedPaid, claimPaid,
          `claim ${claimLabel}: charge ${money(claim.billedAmount)} less adjustments `
          + `${money(totalAdjustments)} is ${money(expectedPaid)}, but the payer reported `
          + `${money(claimPaid)} paid`,
          { claim: claimLabel },
        ));
      }
    }

    // CLP05 should be the sum of the PR-group adjustments. Payers vary in how
    // they report this and it never moves provider cash, so it is a warning:
    // it tells the operator that patient liability could not be trusted for
    // this claim, which is exactly when variance detection should fail closed.
    if (claim.patientResponsibility != null) {
      const prTotal = [...claim.adjustments, ...claim.lines.flatMap((l) => l.adjustments)]
        .filter((a) => a.groupCode.toUpperCase() === 'PR')
        .reduce((s, a) => s + a.amount, 0);
      if (outside(prTotal - claim.patientResponsibility, tolerance)) {
        findings.push(finding(
          'warning', 'patient_responsibility', prTotal, claim.patientResponsibility,
          `claim ${claimLabel}: PR adjustments total ${money(prTotal)} but CLP05 reports `
          + `${money(claim.patientResponsibility)} patient responsibility`,
          { claim: claimLabel },
        ));
      }
    }
  }

  const providerAdjustmentTotal = era.providerAdjustments.reduce((s, p) => s + p.amount, 0);
  const expectedTotal = claimPaymentTotal - providerAdjustmentTotal;
  const reportedTotal = era.totalPaid;
  const transactionVariance = reportedTotal == null ? 0 : expectedTotal - reportedTotal;

  if (reportedTotal == null) {
    findings.push(finding(
      'error', 'transaction', expectedTotal, 0,
      'transaction has no BPR02 payment amount to balance against',
    ));
  } else if (outside(transactionVariance, tolerance)) {
    findings.push(finding(
      'error', 'transaction', expectedTotal, reportedTotal,
      `check ${era.traceNumber ?? '(no trace number)'}: claim payments `
      + `${money(claimPaymentTotal)} less provider-level adjustments `
      + `${money(providerAdjustmentTotal)} is ${money(expectedTotal)}, but BPR02 reports `
      + `${money(reportedTotal)}`,
    ));
  }

  return {
    balanced: !findings.some((f) => f.severity === 'error'),
    transactionVariance: r2(transactionVariance),
    claimPaymentTotal: r2(claimPaymentTotal),
    providerAdjustmentTotal: r2(providerAdjustmentTotal),
    reportedTotal: reportedTotal == null ? null : r2(reportedTotal),
    findings,
  };
}

export interface FileBalanceResult {
  balanced: boolean;
  transactions: BalanceResult[];
  errors: BalanceFinding[];
  warnings: BalanceFinding[];
}

/** Balance every transaction set in a parsed 835 file. */
export function balance835File(
  remits: Remittance835[], options: BalanceOptions = {},
): FileBalanceResult {
  const transactions = remits.map((era) => balance835(era, options));
  const all = transactions.flatMap((t) => t.findings);
  return {
    balanced: transactions.every((t) => t.balanced),
    transactions,
    errors: all.filter((f) => f.severity === 'error'),
    warnings: all.filter((f) => f.severity === 'warning'),
  };
}
