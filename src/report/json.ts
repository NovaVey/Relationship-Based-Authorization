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

/**
 * The JSON sibling of `renderSoundnessInfrastructureFailureMarkdown`
 * (`src/report/markdown.ts`) — rendered when `runSoundnessFuzz` throws, or a
 * precondition like `DATABASE_URL` was never set, before any
 * `SoundnessRunResult` ever exists. No caller in this repository consumes
 * `--format json` today — only `.github/workflows/soundness.yml`'s
 * `--format markdown` capture is load-bearing (`src/cli/commands/soundness
 * .ts`'s own top-of-file doc comment) — but that same doc comment claims
 * "stdout is the report and nothing else" for `json` exactly as it does for
 * `markdown`, and leaving `json` silently empty on an infrastructure
 * failure would be the same category of dishonesty this file's markdown
 * sibling exists to close, just for a consumer this repo doesn't have yet.
 *
 * **Deliberately not `SoundnessJsonReport` with zeroed-out fields.** A
 * `SoundnessJsonReport` promises a `verdict`, a `falseGrantCount`, a
 * `falseDenyCount` — all computed from a real completed run. None of that
 * exists here: `runSoundnessFuzz` never got far enough to compute any of
 * it. Reusing that shape with `falseGrantCount: 0`/`verdict: 'sound'` (or
 * any other placeholder) would make an infrastructure failure
 * indistinguishable, byte-for-byte, from a genuine clean pass to any
 * consumer checking `report.verdict === 'sound'` — exactly the silent
 * miscategorization this project's own asymmetric-verdict discipline (§6.5,
 * `docs/DECISIONS.md` D-006) exists to prevent. `status:
 * 'infrastructure_failure'` is an honestly different, self-describing shape
 * with no `verdict` field to misread: a consumer has to handle it as its
 * own case, not accidentally fall through an existing `verdict` check.
 */
export interface SoundnessInfrastructureFailureJson {
  status: 'infrastructure_failure';
  message: string;
}

/** `SoundnessInfrastructureFailureJson` serialized — same `pretty` contract as `renderSoundnessJsonString`. */
export function renderSoundnessInfrastructureFailureJsonString(
  message: string,
  pretty = true,
): string {
  const report: SoundnessInfrastructureFailureJson = { status: 'infrastructure_failure', message };
  return JSON.stringify(report, null, pretty ? 2 : undefined);
}

/**
 * The JSON sibling of `renderSoundnessFixtureFailureMarkdown`
 * (`src/report/markdown.ts`) — rendered when `runSoundnessFuzz` throws
 * specifically a `SoundnessFixtureError` (`src/soundness/runner.ts`): the
 * *generated fuzz fixture itself* was invalid (a schema compile, a schema
 * publish, or a generated tuple write rejected) before a single query was
 * ever checked. Closes full-repo audit finding #12 (MEDIUM, 2026-08-16) at
 * the JSON layer — see `SoundnessInfrastructureFailureJson` immediately
 * above and that finding's own writeup in `renderSoundnessFixtureFailureMarkdown`'s
 * doc comment for the full context: this is a distinct failure mode from an
 * unreachable database, a generator/validation bug rather than an
 * infrastructure one, and reusing `status: 'infrastructure_failure'` for it
 * would misdirect a consumer at exactly the wrong fix.
 *
 * **Deliberately not `SoundnessJsonReport` with zeroed-out fields**, for
 * the same reason `SoundnessInfrastructureFailureJson` above isn't — see
 * that interface's own doc comment; the reasoning is identical here, just
 * for a different thrown-error case.
 */
export interface SoundnessFixtureFailureJson {
  status: 'fixture_failure';
  message: string;
}

/** `SoundnessFixtureFailureJson` serialized — same `pretty` contract as `renderSoundnessJsonString`. */
export function renderSoundnessFixtureFailureJsonString(message: string, pretty = true): string {
  const report: SoundnessFixtureFailureJson = { status: 'fixture_failure', message };
  return JSON.stringify(report, null, pretty ? 2 : undefined);
}
