/**
 * `replayWitness` — build spec §6: "take the materialized witness, write
 * those tuples into a scratch store, run the actual check the invariant
 * forbids, and confirm the engine returns allow." The scratch store is
 * the DST fake (`src/store/dst/`) on a fresh, empty in-memory state —
 * never real Postgres (none is available to this tool, and none should
 * be needed: the fake is the same real production check engine's own
 * storage seam, exercised the identical way DST already does). Both the
 * check engine and the write path are imported unmodified, per this
 * branch's own rule: "it imports the schema parser and the check engine;
 * it does not modify them."
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
import type { WitnessTuple } from '../reachability/types.js';
import { createLabelToIdMapper } from './label-to-id.js';
import type { Mismatch, ValidationOutcome } from './types.js';

/** Seeds every namespace `schema` declares — cheap and simple beats tracking exactly which namespaces a given witness touches, for schemas this project's own rule 0.5 calls "tens of nodes." */
function seedSchema(state: ReturnType<typeof createFakeStoreState>, schema: CompiledSchema): void {
  for (const ns of Object.values(schema.namespaces)) {
    seedNamespaceConfig(state, ns);
  }
}

/**
 * Replays `witness` against a fresh scratch store seeded from `schema`,
 * then runs the real `productionCheck` for `invariant`'s own goal.
 * `schema` is always the real, uncorrupted compiled schema — deliberately
 * independent of whatever `SchemaGraph` produced the witness, so a bug
 * in the IR (a corrupted edge, say) can never quietly validate itself:
 * the replay always checks against ground truth, never against the same
 * possibly-wrong structure that produced the claim.
 */
export async function replayWitness(
  witness: readonly WitnessTuple[],
  schema: CompiledSchema,
  invariant: Invariant,
): Promise<ValidationOutcome> {
  const state = createFakeStoreState();
  seedSchema(state, schema);
  const source = createFakeConnectionSource(state);
  // The witness's own labels (`s`, `o`, `orgB`, `obj1`, ...) are valid
  // invariant-variable names (mixed case allowed — D-115), not
  // necessarily valid tuple object/subject ids (lowercase snake_case
  // only, same IDENTIFIER_PATTERN the real store enforces). Map each
  // label to a real, valid id once, consistently, for every tuple below
  // and the final productionCheck call — never write the raw label.
  const toId = createLabelToIdMapper();

  for (const t of witness) {
    const write = await writeTuple(source, {
      objectNs: t.objectType,
      objectId: toId(t.object),
      relation: t.relation,
      subjectNs: t.subjectType,
      subjectId: toId(t.subject),
      ...(t.subjectRelation !== undefined ? { subjectRelation: t.subjectRelation } : {}),
    });
    if (!write.ok) {
      const mismatch: Mismatch = {
        kind: 'mismatch',
        witness,
        reason: `witness tuple ${t.objectType}:${t.object}#${t.relation}@${t.subjectType}:${t.subject}${
          t.subjectRelation ? `#${t.subjectRelation}` : ''
        } was rejected by the real schema: ${write.errors.map((e) => e.message).join('; ')} — the schema-graph IR the search walked disagrees with what the real, unmodified compiler actually accepts`,
      };
      return mismatch;
    }
  }

  const subjectType = invariant.variables.find((v) => v.name === invariant.goal.subject)?.type;
  const objectType = invariant.variables.find((v) => v.name === invariant.goal.object)?.type;
  if (subjectType === undefined || objectType === undefined) {
    // Unreachable for any invariant that already passed checkInvariant's
    // own goal-type validation — defensive only.
    throw new Error('replayWitness: invariant goal references a variable with no declared type');
  }

  const engineResult = await productionCheck(
    source,
    { ns: subjectType, id: toId(invariant.goal.subject) },
    { ns: objectType, id: toId(invariant.goal.object) },
    invariant.goal.permission,
  );

  if (engineResult.allowed) {
    return { kind: 'confirmed', witness, engineResult };
  }
  const mismatch: Mismatch = {
    kind: 'mismatch',
    witness,
    reason: `the search found a witness for ${invariant.goal.permission}(${invariant.goal.subject}, ${invariant.goal.object}), but the real engine denied it after every witness tuple was written successfully — the schema-graph IR and the real check engine disagree about what this schema means`,
    engineResult,
  };
  return mismatch;
}
