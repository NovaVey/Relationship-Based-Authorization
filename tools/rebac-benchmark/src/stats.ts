/**
 * Percentile/summary helpers — the same `sort then index` percentile
 * definition `scripts/benchmark-check-depth.ts` already uses in this
 * repo's own root, reused verbatim rather than reimplemented so a number
 * this tool reports and a number that script reports mean the same thing
 * if ever placed side by side.
 */
export function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return NaN;
  const idx = Math.min(sortedAscending.length - 1, Math.floor(sortedAscending.length * p));
  return sortedAscending[idx]!;
}

export interface LatencySummary {
  readonly n: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

export function summarize(latenciesMs: number[]): LatencySummary {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? NaN,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? NaN,
    mean: sorted.length > 0 ? sum / sorted.length : NaN,
  };
}
