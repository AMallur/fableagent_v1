// ============================================================================
// Latency and throughput accounting shared by every qualification harness.
//
// A load result that reports only a mean hides the tail, and the tail is what
// times out a request or blows a nightly window. Every stage therefore keeps
// its full sample and reports percentiles.
// ============================================================================

export interface StageStats {
  stage: string;
  samples: number;
  totalMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
  /** Units of work the stage handled, when it reports one (claims, lines). */
  units: number;
  /** Units per second, computed on wall time actually spent in the stage. */
  unitsPerSecond: number;
  errors: number;
}

export class StageTimer {
  private readonly durations = new Map<string, number[]>();
  private readonly units = new Map<string, number>();
  private readonly errors = new Map<string, number>();

  /** Time one execution of a stage, recording failures without swallowing them. */
  async time<T>(stage: string, unitCount: number, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      const result = await work();
      this.record(stage, performance.now() - started, unitCount);
      return result;
    } catch (error) {
      this.record(stage, performance.now() - started, unitCount);
      this.errors.set(stage, (this.errors.get(stage) ?? 0) + 1);
      throw error;
    }
  }

  record(stage: string, durationMs: number, unitCount = 0): void {
    const samples = this.durations.get(stage);
    if (samples) samples.push(durationMs);
    else this.durations.set(stage, [durationMs]);
    this.units.set(stage, (this.units.get(stage) ?? 0) + unitCount);
  }

  countError(stage: string): void {
    this.errors.set(stage, (this.errors.get(stage) ?? 0) + 1);
  }

  stages(): string[] {
    return [...this.durations.keys()];
  }

  stats(stage: string): StageStats {
    const samples = [...(this.durations.get(stage) ?? [])].sort((a, b) => a - b);
    const totalMs = samples.reduce((sum, value) => sum + value, 0);
    const units = this.units.get(stage) ?? 0;
    return {
      stage,
      samples: samples.length,
      totalMs: round(totalMs),
      minMs: round(samples[0] ?? 0),
      p50Ms: round(percentile(samples, 0.50)),
      p95Ms: round(percentile(samples, 0.95)),
      p99Ms: round(percentile(samples, 0.99)),
      maxMs: round(samples[samples.length - 1] ?? 0),
      meanMs: round(samples.length ? totalMs / samples.length : 0),
      units,
      unitsPerSecond: totalMs > 0 ? round((units / totalMs) * 1000) : 0,
      errors: this.errors.get(stage) ?? 0,
    };
  }

  report(): StageStats[] {
    return this.stages().map((stage) => this.stats(stage));
  }
}

/**
 * Nearest-rank percentile. With a handful of samples an interpolating
 * percentile invents a number no run actually produced; nearest-rank always
 * reports a latency that was really observed.
 */
export function percentile(sortedSamples: number[], fraction: number): number {
  if (sortedSamples.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedSamples.length);
  return sortedSamples[Math.min(Math.max(rank, 1), sortedSamples.length) - 1];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function formatStageTable(stats: StageStats[]): string {
  const header = '| stage | n | units | p50 ms | p95 ms | p99 ms | max ms | units/s | errors |';
  const divider = '|---|---:|---:|---:|---:|---:|---:|---:|---:|';
  const rows = stats.map((s) => `| ${s.stage} | ${s.samples} | ${s.units} | `
    + `${s.p50Ms.toFixed(1)} | ${s.p95Ms.toFixed(1)} | ${s.p99Ms.toFixed(1)} | `
    + `${s.maxMs.toFixed(1)} | ${s.unitsPerSecond.toFixed(1)} | ${s.errors} |`);
  return [header, divider, ...rows].join('\n');
}
