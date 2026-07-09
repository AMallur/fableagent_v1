// ============================================================================
// STEP 7 — AGGREGATE AND SUMMARIZE
//
//   * totals: cases created, recovery opportunity identified
//   * breakdowns by category, payer, priority
//   * anomaly flag: a payer paying below contract across (nearly) all claims
//   * per-client alert when total recovery exceeds the client's threshold
// ============================================================================

import type {
  AlertNotification, Anomaly, CaseOutput, EngineInput, MatchResult, RunSummary,
  SkippedCase,
} from '../types.ts';
import { moneyGt, round2 } from '../config.ts';
import type { VarianceFlag } from './step3_variance.ts';

const ANOMALY_MIN_LINES = 5;
const ANOMALY_UNDERPAID_SHARE = 0.8;

function bump(
  map: Record<string, { count: number; amount: number }>, key: string, amount: number,
): void {
  if (!map[key]) map[key] = { count: 0, amount: 0 };
  map[key].count += 1;
  map[key].amount = round2(map[key].amount + amount);
}

export function summarize(
  input: EngineInput,
  args: {
    matches: MatchResult[];
    unmatched: MatchResult[];
    created: CaseOutput[];
    updated: CaseOutput[];
    skipped: SkippedCase[];
    /** all variance flags (case-worthy or not) — anomaly detection needs the full picture */
    varianceFlags: VarianceFlag[];
    /** contract-priced lines that were checked, per payer (denominator) */
    pricedLinesByPayer: Map<string, number>;
  },
): RunSummary {
  const { created, updated } = args;
  const allCases = [...created, ...updated];

  const byCategory: RunSummary['byCategory'] = {};
  const byPayer: RunSummary['byPayer'] = {};
  const byPriority: RunSummary['byPriority'] = {};
  let total = 0;

  for (const c of allCases) {
    total = round2(total + c.recoveryOpportunity);
    bump(byCategory, c.denialCategory ?? c.caseType, c.recoveryOpportunity);
    bump(byPriority, c.priorityLevel, c.recoveryOpportunity);
    const payer = input.payers.find((p) => p.payerId === c.payerId);
    if (!byPayer[c.payerId]) {
      byPayer[c.payerId] = { payerName: payer?.payerName ?? c.payerId, count: 0, amount: 0 };
    }
    byPayer[c.payerId].count += 1;
    byPayer[c.payerId].amount = round2(byPayer[c.payerId].amount + c.recoveryOpportunity);
  }

  // anomaly: payer paying below contract across all (>=80% of) checked lines
  const anomalies: Anomaly[] = [];
  const underpaidByPayer = new Map<string, { lines: number; variance: number }>();
  for (const f of args.varianceFlags) {
    if (f.pricing.noContract || !moneyGt(f.variance, 0)) continue;
    const payerId = f.matched.claim.payerId;
    const agg = underpaidByPayer.get(payerId) ?? { lines: 0, variance: 0 };
    agg.lines += 1;
    agg.variance = round2(agg.variance + f.variance);
    underpaidByPayer.set(payerId, agg);
  }
  for (const [payerId, agg] of underpaidByPayer) {
    const checked = args.pricedLinesByPayer.get(payerId) ?? 0;
    if (checked >= ANOMALY_MIN_LINES && agg.lines / checked >= ANOMALY_UNDERPAID_SHARE) {
      const payer = input.payers.find((p) => p.payerId === payerId);
      anomalies.push({
        type: 'systemic_underpayment',
        payerId,
        payerName: payer?.payerName ?? payerId,
        detail: `${agg.lines} of ${checked} contract-priced lines paid below the contracted rate `
          + `(total variance $${agg.variance.toFixed(2)}) — possible fee schedule misload on the payer side`,
        linesChecked: checked,
        linesUnderpaid: agg.lines,
        totalVariance: agg.variance,
      });
    }
  }

  // per-client alert when identified recovery exceeds the client's threshold
  const alerts: AlertNotification[] = [];
  const totalByClient = new Map<string, number>();
  for (const c of allCases) {
    totalByClient.set(c.clientId, round2((totalByClient.get(c.clientId) ?? 0) + c.recoveryOpportunity));
  }
  for (const [clientId, amount] of totalByClient) {
    const threshold = input.clientAlertThresholds[clientId];
    if (threshold != null && amount >= threshold) {
      alerts.push({
        clientId,
        threshold,
        totalRecoveryOpportunity: amount,
        message: `Detection run identified $${amount.toFixed(2)} in recovery opportunity `
          + `(alert threshold $${threshold.toFixed(2)})`,
      });
    }
  }

  return {
    remitLinesProcessed: input.remitLines.length,
    matched: args.matches.length,
    unmatched: args.unmatched.length,
    casesCreated: created.length,
    casesUpdated: updated.length,
    casesSkipped: args.skipped.length,
    totalRecoveryOpportunity: total,
    byCategory, byPayer, byPriority,
    anomalies, alerts,
  };
}
