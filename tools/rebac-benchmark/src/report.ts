import type { LatencySummary } from './stats.js';

export function markdownDepthTable(
  rows: readonly { engine: string; depth: number; summary: LatencySummary }[],
): string {
  const lines = ['| Engine | Depth | n | p50 | p95 | p99 | max |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    lines.push(
      `| ${r.engine} | ${r.depth} | ${r.summary.n} | ${r.summary.p50.toFixed(2)}ms | ` +
        `${r.summary.p95.toFixed(2)}ms | ${r.summary.p99.toFixed(2)}ms | ${r.summary.max.toFixed(2)}ms |`,
    );
  }
  return lines.join('\n');
}

export function markdownCrossValidationTable(
  rows: readonly { engine: string; note: string; expected: boolean; actual: boolean | 'ERROR' }[],
): string {
  const lines = ['| Engine | Check | Expected | Actual | Agrees? |', '|---|---|---|---|---|'];
  for (const r of rows) {
    const agrees = r.actual === r.expected ? 'yes' : 'NO';
    lines.push(`| ${r.engine} | ${r.note} | ${r.expected} | ${r.actual} | ${agrees} |`);
  }
  return lines.join('\n');
}
