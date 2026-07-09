import type { EngineConfig } from './types.ts';

export const DEFAULT_CONFIG: Omit<EngineConfig, 'asOf'> = {
  minCaseThreshold: 25,
  varianceDollarTrigger: 25,
  variancePercentTrigger: 0.05,
  defaultAppealDeadlineDays: 90,
  criticalDeadlineDays: 14,
  criticalAmount: 5000,
  highDeadlineDays: 30,
  highAmount: 1000,
  mediumDeadlineDays: 60,
};

export function makeConfig(asOf: string, overrides: Partial<EngineConfig> = {}): EngineConfig {
  return { ...DEFAULT_CONFIG, asOf, ...overrides };
}

/** Round to cents. All money comparisons go through an epsilon. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export const MONEY_EPSILON = 0.005;

export function moneyGt(a: number, b: number): boolean {
  return a - b > MONEY_EPSILON;
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  return Math.round((b - a) / 86_400_000);
}
