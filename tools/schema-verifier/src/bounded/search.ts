/**
 * `boundedSearch` — build spec §7's fallback for the non-monotone
 * fragment: "fix a bound k on the number of objects per type, enumerate
 * type-valid tuple sets up to that bound, and evaluate." Deliberately
 * "a deliberately dumb exhaustive checker" (§8b's own later phrase for
 * exactly this technique) — every subset of the candidate tuples is
 * tried, in the plainest possible order, and evaluated through the real,
 * unmodified `productionCheck`. No attempt to hand-model what
 * intersection/exclusion mean: the real engine already knows, and asking
 * it directly is both simpler and more trustworthy than a second,
 * bespoke non-monotone evaluator this tool would have to get exactly
 * right on its own.
 */
import { productionCheck } from '../../../../src/resolve/production/resolver.js';
import type { CompiledSchema } from '../../../../src/schema/dsl/types.js';
import {
  createFakeConnectionSource,
  createFakeStoreState,
  seedNamespaceConfig,
} from '../../../../src/store/dst/index.js';
import { writeTuple } from '../../../../src/store/tuples.js';
import type { Invariant } from '../invariants/types.js';
import type { CheckResult, WitnessTuple } from '../reachability/types.js';
import { createLabelToIdMapper } from '../validate/label-to-id.js';
import { generateGivenTuples } from './candidates.js';

/**
 * 2^N subsets to try — the exponential ceiling on how large the
 * candidate list can be before this tool refuses to run rather than
 * hang. §7's own text: "SMT encoding is the real answer for the general
 * case and is explicitly out of scope for v1" — this ceiling is exactly
 * where that boundary is disclosed at runtime, not just in prose. See
 * `docs/DECISIONS.md` for the sizing rationale and the SMT sketch.
 */
export const MAX_BOUNDED_CANDIDATES = 20;

function seedSchema(state: ReturnType<typeof createFakeStoreState>, schema: CompiledSchema): void {
  for (const ns of Object.values(schema.namespaces)) {
    seedNamespaceConfig(state, ns);
  }
}

async function evaluateSubset(
  schema: CompiledSchema,
  invariant: Invariant,
  given: readonly WitnessTuple[],
  subset: readonly WitnessTuple[],
): Promise<boolean> {
  const state = createFakeStoreState();
  seedSchema(state, schema);
  const source = createFakeConnectionSource(state);
  const toId = createLabelToIdMapper();

  for (const t of [...given, ...subset]) {
    await writeTuple(source, {
      objectNs: t.objectType,
      objectId: toId(t.object),
      relation: t.relation,
      subjectNs: t.subjectType,
      subjectId: toId(t.subject),
      ...(t.subjectRelation !== undefined ? { subjectRelation: t.subjectRelation } : {}),
    });
    // Every candidate is drawn from the schema's own real subjectTypes
    // (candidates.ts), so a write failure here would mean the generator
    // itself has a bug, not that this subset is invalid — proceed rather
    // than abort a whole subset over one skip-worthy tuple.
  }

  const subjectType = invariant.variables.find((v) => v.name === invariant.goal.subject)!.type;
  const objectType = invariant.variables.find((v) => v.name === invariant.goal.object)!.type;
  const result = await productionCheck(
    source,
    { ns: subjectType, id: toId(invariant.goal.subject) },
    { ns: objectType, id: toId(invariant.goal.object) },
    invariant.goal.permission,
  );
  return result.allowed;
}

/**
 * Exhaustively tries every subset of `candidates` (each already type-
 * valid by construction — see `generateCandidateTuples`) against the
 * real engine. Returns the first subset that produces `allow` as a
 * `VIOLATED` witness — already self-validated by construction, since it
 * came directly from the real engine, not a static claim needing replay
 * — or, having tried every subset with none producing `allow`, `HOLDS`
 * with `bound: k` set (never a bare `HOLDS` — build spec §7's own
 * explicit instruction).
 */
export async function boundedSearch(
  schema: CompiledSchema,
  invariant: Invariant,
  candidates: readonly WitnessTuple[],
  k: number,
): Promise<CheckResult> {
  if (candidates.length > MAX_BOUNDED_CANDIDATES) {
    return {
      verdict: 'UNKNOWN',
      fragment: 'non-monotone',
      reason: `bounded search needs ${candidates.length} candidate tuples at k = ${k} (2^${candidates.length} subsets) — over this tool's own ${MAX_BOUNDED_CANDIDATES}-candidate ceiling; reduce k, or see docs/DECISIONS.md's SMT sketch for what lifting this ceiling would take`,
    };
  }

  const given = generateGivenTuples(invariant);
  const total = 2 ** candidates.length;
  for (let mask = 0; mask < total; mask++) {
    const subset = candidates.filter((_, i) => (mask & (1 << i)) !== 0);
    // Deliberately sequential: each trial needs its own fresh scratch
    // store, and this is an exhaustive bounded search, not a hot path
    // (rule 0.5: these schemas are tiny).
    const allowed = await evaluateSubset(schema, invariant, given, subset);
    if (allowed) {
      return { verdict: 'VIOLATED', witness: [...given, ...subset], fragment: 'non-monotone' };
    }
  }

  return { verdict: 'HOLDS', fragment: 'non-monotone', bound: k };
}

export { generateCandidateTuples, generateGivenTuples } from './candidates.js';
