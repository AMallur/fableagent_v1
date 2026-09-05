// ============================================================================
// PAYER-OUTCOME STATISTICS (pure)
//
// The flywheel's job is to turn a pile of recorded appeal outcomes into a
// decision, and the hard part is that early on there is barely any data. Three
// wins out of three appeals is not a 100% win rate you should bet auto-pilot
// on; it is three data points. Reporting the naive rate (k/n) would make the
// system most confident exactly when it knows least, which is how a "data-
// driven" feature quietly does harm.
//
// So every estimate here is sample-size aware:
//
//   * WILSON score lower bound -- a confidence-adjusted win rate. With 3/3 it
//     sits well below 1.0; with 30/33 it sits close to the point estimate. This
//     is what ranking and auto-submit gating use, so a thin sample can never
//     outrank a proven one on noise alone.
//
//   * BETA-BINOMIAL posterior mean -- shrinks the estimate toward a supplied
//     base rate by a prior strength expressed in pseudo-observations. A cell
//     with no data reads as the base rate, not as 0% or 100%.
//
//   * COLD-START flag -- below a minimum resolved sample the cell is marked
//     insufficient and callers fall back to the deterministic default rather
//     than act on the estimate.
//
// Everything is pure and dependency-free so it is exhaustively unit-testable
// and so the same math runs identically in generation, reporting, and tests.
// ============================================================================

/** One payer/argument cell's raw recorded tallies. */
export interface OutcomeTally {
  /** appeals this payer has fully overturned (full recovery) */
  overturned: number;
  /** appeals partially paid (some recovery, not the full disputed amount) */
  partial: number;
  /** appeals upheld (the denial/underpayment stood -- no recovery) */
  upheld: number;
  /** dollars recovered across the resolved appeals in this cell, if known */
  recoveredAmount?: number;
  /** dollars disputed across the resolved appeals in this cell, if known */
  disputedAmount?: number;
}

export type ConfidenceLabel = 'insufficient' | 'low' | 'moderate' | 'high';

export interface OutcomeEstimate {
  /** overturned + partial + upheld */
  resolved: number;
  overturned: number;
  partial: number;
  upheld: number;
  /** naive "any recovery" rate: (overturned + partial) / resolved */
  pointWinRate: number;
  /** naive strict reversal rate: overturned / resolved */
  overturnRate: number;
  /** confidence-adjusted win rate (Wilson lower bound) -- the ranking key */
  adjustedWinRate: number;
  /** Wilson upper bound, for interval width / display */
  winRateUpper: number;
  /** Beta-Binomial posterior mean, shrunk toward the base rate */
  shrunkWinRate: number;
  /** expected dollars recovered per resolved appeal, if amounts were supplied */
  expectedRecoveryPerAttempt: number | null;
  /** realized recovery fraction: recovered / disputed, if amounts supplied */
  recoveryFraction: number | null;
  label: ConfidenceLabel;
  /** true when resolved < minSample -- lean on the default, not this estimate */
  coldStart: boolean;
}

export interface EstimateOptions {
  /**
   * Base rate the posterior shrinks toward when data is thin. Should be the
   * broader observed win rate (e.g. the payer's overall rate, or the global
   * rate) so an unseen cell reads as "typical", not as 0 or 1. Default 0.5.
   */
  baseRate?: number;
  /**
   * Prior strength in pseudo-observations. Higher = more shrinkage toward the
   * base rate for small samples. Default 5: a handful of real outcomes starts
   * to dominate, which is the right speed for this domain.
   */
  priorStrength?: number;
  /** z for the Wilson interval. Default 1.96 (95%). */
  z?: number;
  /** below this many resolved appeals the cell is cold-start. Default 8. */
  minSample?: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Wilson score interval for a binomial proportion. Returns the base rate as the
 * center with a full [0,1] interval when there are no trials, so a data-free
 * cell degrades to "we don't know" rather than a spurious 0%.
 */
export function wilsonInterval(
  successes: number, trials: number, z = 1.96,
): { center: number; lower: number; upper: number } {
  if (trials <= 0) return { center: 0, lower: 0, upper: 1 };
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const margin = (z / denom) * Math.sqrt(p * (1 - p) / trials + z2 / (4 * trials * trials));
  return { center, lower: clamp01(center - margin), upper: clamp01(center + margin) };
}

/**
 * Beta-Binomial posterior mean with a prior expressed as (baseRate, strength).
 * alpha = baseRate * strength, beta = (1 - baseRate) * strength.
 * With zero data this is exactly baseRate; each real outcome pulls it toward
 * the observed rate at a pace set by strength.
 */
export function shrinkToPrior(
  successes: number, trials: number, baseRate: number, priorStrength: number,
): number {
  const r = clamp01(baseRate);
  const m = Math.max(0, priorStrength);
  const alpha = r * m;
  return clamp01((successes + alpha) / (trials + m));
}

function labelFor(resolved: number, intervalWidth: number, minSample: number): ConfidenceLabel {
  if (resolved < minSample) return 'insufficient';
  // width of the 95% Wilson interval as the confidence proxy: a tight interval
  // on a real sample is "high", a still-wide one is "low".
  if (intervalWidth <= 0.20) return 'high';
  if (intervalWidth <= 0.35) return 'moderate';
  return 'low';
}

/** Turn one cell's tallies into a full sample-size-aware estimate. */
export function estimate(tally: OutcomeTally, options: EstimateOptions = {}): OutcomeEstimate {
  const {
    baseRate = 0.5, priorStrength = 5, z = 1.96, minSample = 8,
  } = options;

  const overturned = Math.max(0, tally.overturned | 0);
  const partial = Math.max(0, tally.partial | 0);
  const upheld = Math.max(0, tally.upheld | 0);
  const resolved = overturned + partial + upheld;

  // "success" for the win-rate binomial = any recovery (overturned or partial).
  // Partial counts as a full success here because from a "was it worth
  // appealing" standpoint any recovery beats an upheld denial; dollar nuance is
  // carried separately by expectedRecoveryPerAttempt.
  const successes = overturned + partial;

  const wilson = wilsonInterval(successes, resolved, z);
  const pointWinRate = resolved > 0 ? successes / resolved : 0;
  const overturnRate = resolved > 0 ? overturned / resolved : 0;
  const shrunk = shrinkToPrior(successes, resolved, baseRate, priorStrength);

  const hasAmounts = tally.recoveredAmount != null;
  const recovered = tally.recoveredAmount ?? 0;
  const disputed = tally.disputedAmount ?? 0;

  return {
    resolved,
    overturned,
    partial,
    upheld,
    pointWinRate: round4(pointWinRate),
    overturnRate: round4(overturnRate),
    adjustedWinRate: round4(resolved > 0 ? wilson.lower : shrunk),
    winRateUpper: round4(resolved > 0 ? wilson.upper : 1),
    shrunkWinRate: round4(shrunk),
    expectedRecoveryPerAttempt: hasAmounts && resolved > 0 ? round2(recovered / resolved) : null,
    recoveryFraction: hasAmounts && disputed > 0 ? round4(recovered / disputed) : null,
    label: labelFor(resolved, wilson.upper - wilson.lower, minSample),
    coldStart: resolved < minSample,
  };
}

// ---------------------------------------------------------------------------
// ranking / recommendation
// ---------------------------------------------------------------------------

export interface RankedOption<T> {
  key: T;
  estimate: OutcomeEstimate;
}

/**
 * Order options best-first. Cold-start cells always sort last (we won't rank on
 * data we don't have), then by confidence-adjusted win rate, then by expected
 * recovery per attempt as a dollar tiebreak.
 */
export function rankOptions<T>(options: RankedOption<T>[]): RankedOption<T>[] {
  return [...options].sort((a, b) => {
    if (a.estimate.coldStart !== b.estimate.coldStart) return a.estimate.coldStart ? 1 : -1;
    if (b.estimate.adjustedWinRate !== a.estimate.adjustedWinRate) {
      return b.estimate.adjustedWinRate - a.estimate.adjustedWinRate;
    }
    const av = a.estimate.expectedRecoveryPerAttempt ?? 0;
    const bv = b.estimate.expectedRecoveryPerAttempt ?? 0;
    return bv - av;
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
