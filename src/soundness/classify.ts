/**
 * The asymmetric verdict — §6.5 and `docs/DECISIONS.md` D-006. This file
 * has exactly two jobs: classify one query's disagreement between the two
 * resolvers (`classifyResult`), and turn a whole run's aggregate counts
 * into one of the three `soundness_runs.verdict` values (`computeVerdict`).
 * Neither function touches Postgres, either resolver, or the generator —
 * pure functions over plain booleans/counts, so the asymmetry itself
 * (§6.5's table) is trivially auditable in one small file.
 *
 * **`false_grant` vs `false_deny` is never collapsed into one "mismatch"
 * count** (D-006) — see `DivergenceKind` below. A `false_grant` on ANY
 * namespace always fails the run; `critical` is tracked per-divergence
 * purely as *reporting* metadata (which false grants were on a namespace
 * this run's generator flagged as especially sensitive — see
 * `generators.ts`'s own doc comment on why `critical` is fuzz-harness
 * metadata, not a DSL feature) — it is never a second, looser pass/fail
 * gate. `docs/DECISIONS.md` D-006 already settled that this project never
 * uses an aggregate-rate threshold for `false_grant`: any single one, on
 * any namespace, fails the run, full stop.
 */

export type DivergenceKind = 'false_grant' | 'false_deny';

export interface ClassifyInput {
  /** The reference resolver's (oracle) verdict for this query. */
  referenceAllowed: boolean;
  /** The production resolver's verdict for the same query. */
  productionAllowed: boolean;
  /** The namespace of the query's *object* — critical-namespace status is a property of what's being protected, not who's asking. */
  objectNamespace: string;
  criticalNamespaces: ReadonlySet<string>;
}

export interface DivergenceClassification {
  kind: DivergenceKind;
  critical: boolean;
}

/**
 * `null` means agreement — no divergence to report. Otherwise, exactly the
 * two classes §6.5's table names:
 *
 * - production allowed, reference found no path -> `false_grant` (security
 *   bug, always blocking, see `computeVerdict`)
 * - production denied, reference found a path -> `false_deny` (correctness
 *   bug, reported and counted, never blocking on its own)
 *
 * Agreement on `false` (both deny) and agreement on `true` (both allow)
 * are both explicitly *not* divergences — this function's first check is
 * the equality test, not "did production allow." A resolver that always
 * says `false` would score zero `false_grant`s here trivially; that's
 * exactly why `false_deny` exists as its own tracked, reported count
 * (§9 Phase 5's exit criteria: "false_deny rate reported even at zero") —
 * a soundness report that only ever showed `false_grant` would have no way
 * to distinguish "this engine is sound" from "this engine denies
 * everything," and `classify.ts` alone cannot fix that; `runner.ts` is
 * responsible for reporting `falseDenyCount` unconditionally, not folding
 * it away as a footnote only shown when non-zero.
 */
export function classifyResult(input: ClassifyInput): DivergenceClassification | null {
  const { referenceAllowed, productionAllowed, objectNamespace, criticalNamespaces } = input;
  if (referenceAllowed === productionAllowed) {
    return null;
  }
  const critical = criticalNamespaces.has(objectNamespace);
  if (productionAllowed && !referenceAllowed) {
    return { kind: 'false_grant', critical };
  }
  return { kind: 'false_deny', critical };
}

export type SoundnessVerdict = 'sound' | 'unsound' | 'insufficient_coverage';

export interface VerdictInput {
  falseGrantCount: number;
  /** `generators.ts`'s `CoverageReport.ok` — every rewrite-rule kind present AND a cycle present. */
  coverageOk: boolean;
}

/**
 * `false_grant_count > 0` -> `unsound`, unconditionally — no threshold, no
 * exception for a namespace that happens not to be flagged `critical`
 * (D-006's own "any single false_grant... always fails the run, full
 * stop, no exceptions, no threshold"). This check runs *before* the
 * coverage check deliberately: a real, generated-data false_grant is an
 * actionable security finding and must never be masked by (or reported as
 * merely) a coverage self-check failure, even if both happen to be true of
 * the same run. `insufficient_coverage` only fires when nothing already
 * disqualified the run on its own, harder-to-ignore grounds — see
 * `docs/DECISIONS.md`.
 */
export function computeVerdict(input: VerdictInput): SoundnessVerdict {
  if (input.falseGrantCount > 0) {
    return 'unsound';
  }
  if (!input.coverageOk) {
    return 'insufficient_coverage';
  }
  return 'sound';
}
