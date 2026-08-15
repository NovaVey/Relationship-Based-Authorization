/**
 * Machine-readable rendering of a `soundness_runs` row — the JSON sibling
 * of `src/report/markdown.ts`. Pure, no I/O. Unlike the markdown renderer,
 * this file never flattens a resolution path into arrow-chain text: every
 * `referencePath`/`productionPath` is passed through verbatim as the real
 * evidence tree the resolver produced (`src/resolve/reference/resolver.ts`
 * / `src/resolve/production/resolver.ts`'s own exported shapes), so a
 * downstream tool can walk or independently re-verify it exactly the way
 * `test/unit/resolve/*.resolution-path*.test.ts` already do — re-deriving
 * that from a rendered string would throw away the one thing that makes a
 * `false_grant` finding checkable rather than merely asserted (§6.2).
 *
 * **Field order carries the same asymmetry `markdown.ts` renders visually**
 * (build spec §8: "visual and rhetorical weight must match actual risk").
 * JSON key order is preserved by `JSON.stringify` for string keys, and this
 * file relies on that deliberately: `falseGrantCount`/
 * `criticalNamespaceFalseGrants`/`falseGrants` are constructed before
 * `falseDenyCount`/`falseDenies` in every object literal below, not
 * alphabetically and not in `SoundnessRunResult`'s own declared field
 * order — the dangerous finding is first and most prominent here exactly as
 * it is in the rendered markdown, never buried by a generic "alphabetize
 * every field" formatter.
 */
import type { SoundnessRunResult, DivergenceRecord } from '../soundness/runner.js';
import { renderHeadline } from './markdown.js';

export interface SoundnessJsonDivergence {
  kind: DivergenceRecord['kind'];
  /** `false_grant` is always `'blocking'`, `false_deny` is always `'non_blocking'` — see `docs/DECISIONS.md` D-006; never derived from a threshold. */
  severity: 'blocking' | 'non_blocking';
  critical: boolean;
  query: DivergenceRecord['query'];
  expected: boolean;
  actual: boolean;
  /** Present iff `expected` is true — the real chain the reference oracle found. */
  referencePath?: DivergenceRecord['referencePath'];
  /** Present iff `actual` is true — for a `false_grant`, this IS the bogus chain; never rendered as if it were evidence of a legitimate grant. */
  productionPath?: DivergenceRecord['productionPath'];
}

export interface SoundnessJsonReport {
  /** The exact sentence `markdown.ts`'s own H2 line renders — verdict, both counts, query budget, seed, all in one string. */
  headline: string;
  verdict: SoundnessRunResult['verdict'];
  falseGrantCount: number;
  criticalNamespaceFalseGrants: number;
  falseGrants: SoundnessJsonDivergence[];
  falseDenyCount: number;
  falseDenies: SoundnessJsonDivergence[];
  queryCount: number;
  seed: string;
  id: string;
  namespaceCount: number;
  tupleCount: number;
}

function buildJsonDivergence(d: DivergenceRecord): SoundnessJsonDivergence {
  return {
    kind: d.kind,
    severity: d.kind === 'false_grant' ? 'blocking' : 'non_blocking',
    critical: d.critical,
    query: d.query,
    expected: d.expected,
    actual: d.actual,
    ...(d.referencePath !== undefined ? { referencePath: d.referencePath } : {}),
    ...(d.productionPath !== undefined ? { productionPath: d.productionPath } : {}),
  };
}

/**
 * Builds the structured report object — no serialization here, so a caller
 * (an API route, a test) can inspect/assert on it directly without
 * round-tripping through `JSON.parse(JSON.stringify(...))`.
 */
export function renderSoundnessJson(result: SoundnessRunResult): SoundnessJsonReport {
  const falseGrants = result.divergences
    .filter((d) => d.kind === 'false_grant')
    .map(buildJsonDivergence);
  const falseDenies = result.divergences
    .filter((d) => d.kind === 'false_deny')
    .map(buildJsonDivergence);

  return {
    headline: renderHeadline(result),
    verdict: result.verdict,
    falseGrantCount: result.falseGrantCount,
    criticalNamespaceFalseGrants: result.criticalNamespaceFalseGrants,
    falseGrants,
    falseDenyCount: result.falseDenyCount,
    falseDenies,
    queryCount: result.queryCount,
    seed: result.graphSeed,
    id: result.id,
    namespaceCount: result.namespaceCount,
    tupleCount: result.tupleCount,
  };
}

/** `renderSoundnessJson` serialized — `pretty` (default `true`) uses two-space indentation; `false` for a single-line machine-to-machine payload. */
export function renderSoundnessJsonString(result: SoundnessRunResult, pretty = true): string {
  return JSON.stringify(renderSoundnessJson(result), null, pretty ? 2 : undefined);
}
