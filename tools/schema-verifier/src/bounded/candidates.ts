/**
 * Candidate-tuple generation for §7's bounded search: "fix a bound k on
 * the number of objects per type, enumerate type-valid tuple sets up to
 * that bound." Every candidate is drawn straight from a real relation's
 * own declared `subjectTypes` — never generate-and-filter — so every
 * candidate this produces is legal by construction, the same discipline
 * `src/schema/dsl/random.ts` (D-114) and `../validate/fuzz.ts` (D-117)
 * both already follow.
 */
import type { CompiledSchema } from '../../../../src/schema/dsl/types.js';
import type { Invariant, NotRelationEqualsConstraint } from '../invariants/types.js';
import type { NodeId } from '../ir/types.js';
import type { WitnessTuple } from '../reachability/types.js';

function splitNodeId(nodeId: NodeId): { namespace: string; name: string } {
  const hashIndex = nodeId.indexOf('#');
  return { namespace: nodeId.slice(0, hashIndex), name: nodeId.slice(hashIndex + 1) };
}

/**
 * Every namespace a candidate tuple could possibly need a pool for: every
 * declared namespace (`Object.keys(schema.namespaces)`, the *object* side
 * of any candidate), plus every subject-type namespace any reachable
 * relation actually declares. The two are not the same set — a type used
 * only as a subject (e.g. `relation editor: user` with no `namespace user
 * { ... }` of its own, exactly `fixtures/schemas/non-monotone.authz`'s
 * shape) never appears in `schema.namespaces` at all, so relying on that
 * alone silently produced an empty subject pool and, with it, zero
 * candidates — caught by `test/bounded.test.ts`'s own intersection fixture
 * coming back `HOLDS` when it plainly shouldn't have.
 */
function collectPoolNamespaces(
  schema: CompiledSchema,
  reachableRelations: readonly NodeId[],
): Set<string> {
  const namespaces = new Set<string>(Object.keys(schema.namespaces));
  for (const relationNodeId of reachableRelations) {
    const { namespace, name } = splitNodeId(relationNodeId);
    namespaces.add(namespace);
    const relation = schema.namespaces[namespace]?.relations[name];
    if (!relation) continue;
    for (const st of relation.subjectTypes) namespaces.add(st.namespace);
  }
  return namespaces;
}

/**
 * `k` fresh instances per namespace, plus the invariant's own goal
 * subject/object where their type matches — those two are given, not
 * part of the bound (§5's own search treats them the same way: the
 * search introduces *fresh* variables, never re-derives the goal's own
 * endpoints).
 */
function buildInstancePools(
  schema: CompiledSchema,
  reachableRelations: readonly NodeId[],
  invariant: Invariant,
  k: number,
): Map<string, string[]> {
  const subjectType = invariant.variables.find((v) => v.name === invariant.goal.subject)!.type;
  const objectType = invariant.variables.find((v) => v.name === invariant.goal.object)!.type;
  const namespaces = collectPoolNamespaces(schema, reachableRelations);
  namespaces.add(subjectType);
  namespaces.add(objectType);
  const pools = new Map<string, string[]>();
  for (const namespace of namespaces) {
    const given: string[] = [];
    if (namespace === subjectType) given.push(invariant.goal.subject);
    if (namespace === objectType && namespace !== subjectType) given.push(invariant.goal.object);
    const pool = [...given];
    for (let i = 0; i < k; i++) pool.push(`${namespace}_${i}`);
    pools.set(namespace, pool);
  }
  return pools;
}

/**
 * The invariant's own `relationEquals` constraints (`tenant(o) = orgB`),
 * turned into tuples that are *given* — always written, in every subset
 * the bounded search tries, never left to the enumeration to include or
 * omit. Without this, an invariant's constraints would be silently
 * ignored by §7's fallback even though §5's exact search honors them —
 * a real gap this closes rather than ships quietly incomplete.
 * `distinct(...)` constraints are not enforced here: every candidate
 * instance label the pools generate is already a distinct symbol by
 * construction, so nothing in a bounded search's own enumeration could
 * violate one — there is no separate check needed.
 */
export function generateGivenTuples(invariant: Invariant): WitnessTuple[] {
  const typeOf = (name: string): string => invariant.variables.find((v) => v.name === name)!.type;
  return invariant.constraints
    .filter((c) => c.kind === 'relationEquals')
    .map((c) => ({
      objectType: typeOf(c.subject),
      object: c.subject,
      relation: c.relation,
      subjectType: typeOf(c.value),
      subject: c.value,
    }));
}

/**
 * Every type-valid tuple `reachableRelations` (§7's fragment scan) could
 * legally hold, over instance pools bounded by `k`. Deduplicated — a
 * self-referential namespace (subject type equal to object type) could
 * otherwise generate the identical tuple twice.
 */
export function generateCandidateTuples(
  schema: CompiledSchema,
  reachableRelations: readonly NodeId[],
  invariant: Invariant,
  k: number,
): WitnessTuple[] {
  const pools = buildInstancePools(schema, reachableRelations, invariant, k);
  const seen = new Set<string>();
  const candidates: WitnessTuple[] = [];
  // `notRelationEquals`'s bounded-search-side enforcement (docs/DECISIONS.md
  // D-131): a candidate this enumeration would otherwise try is dropped
  // when it's exactly the `(relation, subject, value)` triple an
  // invariant's own `not <relation>(<var>) = <var>` constraint excludes.
  // `c.subject`/`c.value` are invariant variable names, which only ever
  // coincide with a candidate's `object`/`subject` label when that
  // variable IS the goal subject or object (`buildInstancePools` never
  // seeds any other declared variable's name into a pool) — for every
  // other declared variable this filter is a harmless no-op, matching
  // nothing, exactly like the exact search's own site-1-only scope.
  const notRelationEquals: NotRelationEqualsConstraint[] = invariant.constraints.filter(
    (c): c is NotRelationEqualsConstraint => c.kind === 'notRelationEquals',
  );

  for (const relationNodeId of reachableRelations) {
    const { namespace, name } = splitNodeId(relationNodeId);
    const relation = schema.namespaces[namespace]?.relations[name];
    if (!relation) continue; // unreachable for a real CompiledSchema — defensive only
    for (const objectId of pools.get(namespace) ?? []) {
      for (const st of relation.subjectTypes) {
        for (const subjectId of pools.get(st.namespace) ?? []) {
          // Bare-principal only (`st.relation === undefined`) — a
          // userset-subject candidate sharing the same object/relation/
          // subject labels is a structurally different tuple
          // (`NotRelationEqualsConstraint` has no userset-subject form
          // to exclude) and must never be filtered here.
          if (
            st.relation === undefined &&
            notRelationEquals.some(
              (c) => c.relation === name && c.subject === objectId && c.value === subjectId,
            )
          ) {
            continue;
          }
          const tuple: WitnessTuple = {
            objectType: namespace,
            object: objectId,
            relation: name,
            subjectType: st.namespace,
            subject: subjectId,
            ...(st.relation !== undefined ? { subjectRelation: st.relation } : {}),
          };
          const key = `${tuple.objectType}:${tuple.object}#${tuple.relation}@${tuple.subjectType}:${tuple.subject}#${tuple.subjectRelation ?? ''}`;
          if (!seen.has(key)) {
            seen.add(key);
            candidates.push(tuple);
          }
        }
      }
    }
  }
  return candidates;
}
