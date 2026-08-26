/**
 * `checkAndValidate` — the single entry point build spec §6 describes:
 * "self-validation runs automatically on every VIOLATED result." Also
 * where §7's fragment detection lives.
 *
 * Routing (docs/DECISIONS.md, the entry adding `search.ts`'s
 * intersection/exclusion short-circuits): `checkInvariant` (§5) now
 * always runs first, regardless of `scan.fragment` — its own
 * AND-infeasibility and exclusion-reduction short-circuits can decide
 * some cases outright even when the schema, as reachable from the goal,
 * genuinely contains intersection/exclusion (`scan.fragment ===
 * 'non-monotone'`). Only when `checkInvariant` itself returns `UNKNOWN`
 * *and* the schema is structurally non-monotone does this fall back to
 * §7's bounded search — for a structurally monotone schema,
 * `checkInvariant` can only return `UNKNOWN` from one of its own
 * upfront invariant-validation checks (never from meeting an
 * intersection/exclusion edge, since `scanReachability` already proved
 * none exists reachable from the goal), so routing there would be
 * pointless work, not a real fallback — behaviorally identical to this
 * function's own pre-existing routing for every schema with zero
 * intersection/exclusion edges anywhere. A decisive `checkInvariant`
 * verdict — whether from the original pure-monotone search or from a
 * short-circuit on a structurally non-monotone schema — gets exactly
 * the same §6 replay/fuzz self-validation either way; bounded search
 * needs none, since every verdict it returns already came from the real
 * engine directly, not a static claim needing replay.
 */
import type { CompiledSchema } from '../../../../src/schema/dsl/types.js';
import { generateCandidateTuples, boundedSearch } from '../bounded/index.js';
import type { Invariant } from '../invariants/types.js';
import { checkInvariant, scanReachability } from '../reachability/index.js';
import type { CheckResult } from '../reachability/types.js';
import type { SchemaGraph } from '../ir/types.js';
import { trySmtTier } from '../smt/index.js';
import { fuzzHolds, type FuzzHoldsOptions } from './fuzz.js';
import { replayWitness } from './replay.js';
import type { ValidationOutcome } from './types.js';

// New tier (`../smt/index.ts`) — not part of the build spec's own five
// phases; see `docs/DECISIONS.md` for the SMT sketch this closes part of.
// Tried after `checkInvariant` and its short-circuits leave `UNKNOWN` on a
// structurally non-monotone schema, before falling back to bounded search.
// Applies only to a non-recursive goal (the sketch's own named obstacle)
// and only ever returns a decisive verdict once its own reconstructed
// witness has been independently confirmed against the real engine, for
// `VIOLATED` — see that module's own header comment for the exact three
// outcomes. `undefined` from it means "this tier does not apply," and
// `checkAndValidate` falls through to bounded search exactly as it did
// before this tier existed — the bounded-search branch itself is
// untouched.

export interface CheckAndValidateOptions {
  readonly fuzz?: FuzzHoldsOptions;
  /** The bound k for §7's bounded search — only consulted when the schema (as reachable from the goal) falls into the non-monotone fragment. Default 1: see docs/DECISIONS.md D-118 for why this tool's own default differs from the build spec's own illustrative k = 3 — candidate-count growth is quadratic per reachable relation (k objects per type on both the object and subject side), so even two reachable relations of the same type pair puts k = 3 at hundreds of thousands of subsets. Callers may still pass a higher k for a schema small enough to afford it; `MAX_BOUNDED_CANDIDATES` refuses to run rather than hang regardless of what's requested. */
  readonly bound?: number;
}

export interface CheckAndValidateResult {
  readonly result: CheckResult;
  readonly validation: ValidationOutcome;
}

function namedNodeId(namespace: string, name: string): string {
  return `${namespace}#${name}`;
}

export async function checkAndValidate(
  graph: SchemaGraph,
  schema: CompiledSchema,
  invariant: Invariant,
  options?: CheckAndValidateOptions,
): Promise<CheckAndValidateResult> {
  const goalObjectType = invariant.variables.find((v) => v.name === invariant.goal.object)!.type;
  const goalNodeId = namedNodeId(goalObjectType, invariant.goal.permission);
  const scan = scanReachability(graph, goalNodeId);
  const exact = checkInvariant(graph, schema, invariant);

  if (exact.verdict !== 'UNKNOWN' || scan.fragment === 'monotone') {
    const result: CheckResult = {
      ...exact,
      fragment: scan.fragment,
      ...(exact.verdict !== 'UNKNOWN' ? { proof: 'exact' as const } : {}),
    };

    if (result.verdict === 'VIOLATED') {
      const validation = await replayWitness(result.witness!, schema, invariant);
      return { result, validation };
    }
    if (result.verdict === 'HOLDS') {
      const validation = await fuzzHolds(schema, invariant, options?.fuzz);
      return { result, validation };
    }
    return { result, validation: { kind: 'not-applicable' } };
  }

  // scan.fragment === 'non-monotone' and checkInvariant itself couldn't
  // decide — the exact search genuinely reached an intersection/exclusion
  // edge neither short-circuit above could resolve. Try the new SMT tier
  // next (non-recursive goals only, self-validated internally before it
  // ever returns a decisive verdict — see `../smt/index.ts`); only if it
  // doesn't apply does this fall back to §7's bounded search, unchanged.
  const smt = await trySmtTier(graph, schema, invariant, options?.fuzz);
  if (smt !== undefined) return smt;

  const k = options?.bound ?? 1;
  const candidates = generateCandidateTuples(schema, scan.relations, invariant, k);
  const result = await boundedSearch(schema, invariant, candidates, k);
  // Every verdict boundedSearch returns already came from the real
  // engine directly — there is nothing left to replay or fuzz.
  return { result, validation: { kind: 'not-applicable' } };
}
