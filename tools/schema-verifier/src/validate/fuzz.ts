/**
 * `fuzzHolds` — the other direction of build spec §6's differential test:
 * "verifier says HOLDS → fuzz N random type-valid tuple sets against the
 * engine, none may allow. (empirical completeness — not a proof, but it
 * catches a whole class of modeling error)." Deliberately small and
 * self-contained rather than reaching for `src/soundness/generators.ts`'s
 * own fuzz machinery — that generator is purpose-built for Phase 5's
 * fixed-shape fixtures and query-count-scaled draw pools; this only ever
 * needs a handful of type-valid tuples per trial against one already-
 * fixed schema and one already-fixed goal, a much narrower job (the same
 * "read first, found not reusable, write something smaller" call D-114
 * made for `src/schema/dsl/random.ts` — see docs/DECISIONS.md).
 */
import { productionCheck } from '../../../../src/resolve/production/resolver.js';
import type { CompiledSchema } from '../../../../src/schema/dsl/types.js';
import {
  createFakeConnectionSource,
  createFakeStoreState,
} from '../../../../src/store/dst/index.js';
import { seedNamespaceConfig } from '../../../../src/store/dst/index.js';
import { writeTuple } from '../../../../src/store/tuples.js';
import type { Invariant } from '../invariants/types.js';
import type { WitnessTuple } from '../reachability/types.js';
import { createLabelToIdMapper, type LabelToId } from './label-to-id.js';
import type { ValidationOutcome } from './types.js';

export interface FuzzHoldsOptions {
  /** How many independent random tuple sets to try. Default 25 — this project's own schemas are "tens of nodes" (rule 0.5), not a scale that needs thousands of trials to search meaningfully. */
  readonly trials?: number;
  /** How many tuples per trial. Default 5. */
  readonly tuplesPerTrial?: number;
  /** Seeded for reproducibility, matching this project's convention everywhere else random data is generated — never `Math.random()` unseeded. */
  readonly seed?: number;
}

/** A tiny, self-contained seeded PRNG (mulberry32) — deliberately not imported from `src/soundness/generators.ts` or `src/schema/dsl/random.ts`, for the same reason those two don't share one either: each is a four-line function, and importing across a tool boundary for four lines is a worse trade than the small, explicit duplication. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

/** Builds a small id pool per namespace: the invariant's own goal subject/object ids (so relations have a real chance to connect them, not just decoys), plus a couple of random extras per namespace actually declared in the schema. `toId` normalizes every id the same way `replayWitness` does — the goal's own labels (mixed case allowed, D-115) are otherwise not guaranteed valid tuple ids. */
function buildIdPools(
  rng: () => number,
  schema: CompiledSchema,
  invariant: Invariant,
  toId: LabelToId,
): Map<string, string[]> {
  const subjectType = invariant.variables.find((v) => v.name === invariant.goal.subject)!.type;
  const objectType = invariant.variables.find((v) => v.name === invariant.goal.object)!.type;
  const pools = new Map<string, string[]>();
  for (const ns of Object.keys(schema.namespaces)) {
    const ids: string[] = [];
    if (ns === subjectType) ids.push(toId(invariant.goal.subject));
    if (ns === objectType) ids.push(toId(invariant.goal.object));
    for (let i = 0; i < 2; i++) {
      ids.push(toId(`fuzz${Math.floor(rng() * 1000)}`));
    }
    pools.set(ns, ids);
  }
  return pools;
}

/** Every `(namespace, relation)` this schema declares, flattened for random selection. */
function allRelations(schema: CompiledSchema): Array<{ namespace: string; relation: string }> {
  const out: Array<{ namespace: string; relation: string }> = [];
  for (const ns of Object.values(schema.namespaces)) {
    for (const relationName of Object.keys(ns.relations)) {
      out.push({ namespace: ns.namespace, relation: relationName });
    }
  }
  return out;
}

export async function fuzzHolds(
  schema: CompiledSchema,
  invariant: Invariant,
  options?: FuzzHoldsOptions,
): Promise<ValidationOutcome> {
  const trials = options?.trials ?? 25;
  const tuplesPerTrial = options?.tuplesPerTrial ?? 5;
  const rng = mulberry32(options?.seed ?? 1);
  const relations = allRelations(schema);
  if (relations.length === 0) {
    return { kind: 'empirically-clean', sampled: 0 };
  }

  for (let trial = 0; trial < trials; trial++) {
    const state = createFakeStoreState();
    for (const ns of Object.values(schema.namespaces)) seedNamespaceConfig(state, ns);
    const source = createFakeConnectionSource(state);
    const toId = createLabelToIdMapper();
    const pools = buildIdPools(rng, schema, invariant, toId);
    const tuples: WitnessTuple[] = [];

    for (let i = 0; i < tuplesPerTrial; i++) {
      const { namespace, relation } = pick(rng, relations);
      const relationDef = schema.namespaces[namespace]!.relations[relation]!;
      const subjectTypeEntry = pick(rng, relationDef.subjectTypes);
      const objectId = pick(rng, pools.get(namespace) ?? [`fuzz${Math.floor(rng() * 1000)}`]);
      const subjectId = pick(
        rng,
        pools.get(subjectTypeEntry.namespace) ?? [`fuzz${Math.floor(rng() * 1000)}`],
      );
      const tuple: WitnessTuple = {
        objectType: namespace,
        object: objectId,
        relation,
        subjectType: subjectTypeEntry.namespace,
        subject: subjectId,
        ...(subjectTypeEntry.relation !== undefined
          ? { subjectRelation: subjectTypeEntry.relation }
          : {}),
      };
      const write = await writeTuple(source, {
        objectNs: tuple.objectType,
        objectId: tuple.object,
        relation: tuple.relation,
        subjectNs: tuple.subjectType,
        subjectId: tuple.subject,
        ...(tuple.subjectRelation !== undefined ? { subjectRelation: tuple.subjectRelation } : {}),
      });
      // A schema drawn from its own real subjectTypes should always be
      // writable; a rejection here would mean this generator itself has
      // a bug, not that the trial is invalid — skip the tuple rather than
      // crash the fuzz run over it.
      if (write.ok) tuples.push(tuple);
    }

    const subjectType = invariant.variables.find((v) => v.name === invariant.goal.subject)!.type;
    const objectType = invariant.variables.find((v) => v.name === invariant.goal.object)!.type;
    const engineResult = await productionCheck(
      source,
      { ns: subjectType, id: toId(invariant.goal.subject) },
      { ns: objectType, id: toId(invariant.goal.object) },
      invariant.goal.permission,
    );
    if (engineResult.allowed) {
      return { kind: 'empirical-counterexample', tuples, engineResult };
    }
  }

  return { kind: 'empirically-clean', sampled: trials };
}
