/**
 * Structural schema diffing — "would publishing this candidate schema
 * silently revoke access the currently-published version grants?" —
 * answered *before* `publishSchema` ever runs, by comparing two compiled
 * rewrite trees for the same namespace, never by touching Postgres or
 * running a single tuple through either resolver.
 *
 * ## What this does and does not prove
 *
 * This is a **structural** classifier, in the same spirit as
 * `src/metamorphic/monotonicity.ts`'s `classifyMonotone` (reused nowhere
 * directly — the two ask different questions, see below — but built the
 * same deliberately conservative way): it walks two `RewriteRule` ASTs and
 * looks for a small, closed set of *provable* set-containment patterns
 * (documented one by one below). If it finds one, the change is reported
 * `'widen'` — a real, structural proof that every subject the OLD rule
 * could ever grant, the NEW rule grants too, for ANY tuple graph
 * whatsoever, not just today's. If it can't find one, the change is
 * reported `'possibly-narrowing'` — this is **not** a proof that access was
 * actually lost, only an honest admission that this module could not prove
 * it wasn't. A permission can be rewritten into a logically-equivalent but
 * differently-shaped tree that this classifier cannot see through (e.g.
 * `a | b` rewritten to `b | a` — order does matter for the union-membership
 * matching below in the sense that it recurses per-child rather than
 * treating the whole thing as a truly unordered set comparison against an
 * unrelated tree shape, though same-shape reordering IS handled, see
 * `isProvableWidenOrEqual`'s own union case) — such a case would be flagged
 * `'possibly-narrowing'` even though it changes nothing real. That is the
 * intended, disclosed failure direction: **false alarms are the safe
 * failure mode here, a missed real narrowing is not** — the opposite
 * asymmetry from `classifyMonotone`'s own "never optimistic" rule would
 * still apply if this reused that machinery, but this module doesn't reuse
 * it: `classifyMonotone` answers "can any FUTURE write ever narrow this
 * permission's result," a property of one schema in isolation; this module
 * answers "does this OLD tree's result set provably fit inside this NEW
 * tree's result set, for the SAME tuple graph," a property of a *pair* of
 * schemas — genuinely different questions, so a genuinely different
 * algorithm, even though both share the same "sound in one direction,
 * incomplete in the other, disclosed explicitly" design philosophy.
 *
 * Nothing here runs a query, writes a tuple, or calls either resolver —
 * this is pure, zero-I/O AST comparison, exactly like `classifyMonotone`
 * (see that file's own top doc comment for why that matters: this module
 * imports only from `./dsl/types.js`). `src/cli/commands/schema.ts`'s
 * `diffSchemaFile` is the one caller that turns this into something a
 * human sees before a real `publishSchema` call ever runs.
 */
import type {
  CompiledPermission,
  CompiledRelation,
  CompiledSchema,
  NamespaceConfig,
  RewriteRule,
  SubjectTypeRef,
} from './dsl/types.js';

/** What happened to one relation/permission name between the old and new namespace configs. */
export type DiffStatus = 'unchanged' | 'added' | 'removed' | 'changed';

/**
 * `'widen'`: this module found a structural proof the new rule/subject-type
 * set can only ever grant a superset of what the old one granted.
 * `'possibly-narrowing'`: no such proof was found — see this file's own top
 * doc comment for why that is the safe, conservative default, not a claim
 * that access was actually lost.
 */
export type ChangeClassification = 'widen' | 'possibly-narrowing';

export type MemberKind = 'relation' | 'permission';

export interface MemberDiff {
  name: string;
  /** The member's kind in whichever config still declares it — the NEW config for `added`/`unchanged`/`changed`, the OLD config for `removed`. */
  kind: MemberKind;
  status: DiffStatus;
  /** Present only when `status === 'changed'`. */
  classification?: ChangeClassification;
  /**
   * A short, human-readable explanation — always populated for `changed`
   * and `removed` (the two statuses `authz schema diff` warns about),
   * empty for `unchanged`/`added` (nothing to explain).
   */
  reason: string;
}

export interface NamespaceDiff {
  namespace: string;
  members: MemberDiff[];
}

function lookupMember(
  config: NamespaceConfig,
  name: string,
):
  | { kind: 'relation'; relation: CompiledRelation }
  | { kind: 'permission'; permission: CompiledPermission }
  | undefined {
  const relation = config.relations[name];
  if (relation) return { kind: 'relation', relation };
  const permission = config.permissions[name];
  if (permission) return { kind: 'permission', permission };
  return undefined;
}

function subjectTypeKey(ref: SubjectTypeRef): string {
  // `relation` is only present for a userset subject type — matching
  // `undefined` vs. absent-key ambiguity is never a concern here since
  // `SubjectTypeRef` is always freshly read off a compiled config, never
  // round-tripped through anything that could inject an explicit
  // `undefined` (see `types.ts`'s own "no `undefined` values embedded in
  // objects" contract).
  return ref.relation === undefined ? ref.namespace : `${ref.namespace}#${ref.relation}`;
}

function subjectTypeSet(types: SubjectTypeRef[]): Set<string> {
  return new Set(types.map(subjectTypeKey));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function isSuperset(superSet: Set<string>, subSet: Set<string>): boolean {
  for (const item of subSet) if (!superSet.has(item)) return false;
  return true;
}

/**
 * Deep structural equality over a `RewriteRule` AST — deliberately
 * hand-written recursion rather than `JSON.stringify` comparison: object
 * key *insertion order* is incidental to how the compiler happens to build
 * each node, never a property this module should treat as meaningful, and
 * relying on `JSON.stringify` would silently start reporting two
 * identically-shaped trees as "changed" the moment the compiler's own
 * construction order shifted for unrelated reasons.
 */
function deepEqualRewriteRule(a: RewriteRule, b: RewriteRule): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'computedUserset':
      return b.kind === 'computedUserset' && a.name === b.name;
    case 'tupleToUserset':
      return (
        b.kind === 'tupleToUserset' &&
        a.relation === b.relation &&
        a.computedUserset === b.computedUserset
      );
    case 'exclusion':
      return (
        b.kind === 'exclusion' &&
        deepEqualRewriteRule(a.base, b.base) &&
        deepEqualRewriteRule(a.subtract, b.subtract)
      );
    case 'union':
    case 'intersection': {
      if (b.kind !== a.kind) return false;
      if (a.children.length !== b.children.length) return false;
      return a.children.every((child, i) => deepEqualRewriteRule(child, b.children[i]!));
    }
  }
}

/**
 * The core proof search: does every subject `old` could ever grant, for
 * ANY tuple graph, also get granted by `new`? Returns `true` only when one
 * of a small, closed set of structural patterns proves it — see each `if`
 * block below for the specific set-algebra argument it encodes. Returns
 * `false` (never a guess) the moment none of them apply; the caller treats
 * `false` as "possibly narrowing," not "proven narrowing" — see this
 * file's own top doc comment.
 *
 * Every rule here is independently sound (each is a real theorem about set
 * containment under the four rewrite-rule combinators, argued in its own
 * comment below) and they are tried in combination, not as a single
 * decision tree — falling through one rule to try the next costs nothing
 * and only ever makes this MORE complete, never less sound, since each
 * `if` only ever returns `true` on its own genuine proof.
 */
function isProvableWidenOrEqual(oldRule: RewriteRule, newRule: RewriteRule): boolean {
  if (deepEqualRewriteRule(oldRule, newRule)) return true;

  // An exclusion's result is ALWAYS a subset of its own `base`, regardless
  // of what `subtract` is (subtracting can only ever remove members, never
  // add them) — so if `new` provably contains `old.base`, it necessarily
  // also contains `old` (`base - subtract`), no matter what `new` itself
  // looks like. This is what proves "an exclusion losing its subtract
  // side": `old = base - subtract`, `new = base` reduces to
  // `isProvableWidenOrEqual(base, base)`, true by the equality check above.
  if (oldRule.kind === 'exclusion' && isProvableWidenOrEqual(oldRule.base, newRule)) return true;

  // Both sides are exclusions: `new` provably widens `old` if `new`'s own
  // base provably widens `old`'s base AND `old`'s subtract provably widens
  // (or equals) `new`'s subtract — i.e. the base only grew (or stayed the
  // same) and the exclusion only shrank (or stayed the same). Both
  // directions are needed: growing the base without shrinking (or holding)
  // the subtract could still lose a subject the old subtract never
  // excluded but the new one now does.
  if (oldRule.kind === 'exclusion' && newRule.kind === 'exclusion') {
    if (
      isProvableWidenOrEqual(oldRule.base, newRule.base) &&
      isProvableWidenOrEqual(newRule.subtract, oldRule.subtract)
    ) {
      return true;
    }
  }

  // Union: flatten one level of union nesting on each side (a bare,
  // non-union rule is treated as its own singleton "union of one"). `old`
  // is provably contained in `new` if EVERY old branch is provably
  // contained in SOME new branch — extra branches on the `new` side (a
  // union "gaining a new branch") only ever add, never take away, so they
  // never need a match of their own. This is the general form of "a union
  // gaining a new branch."
  if (oldRule.kind === 'union' || newRule.kind === 'union') {
    const oldMembers = oldRule.kind === 'union' ? oldRule.children : [oldRule];
    const newMembers = newRule.kind === 'union' ? newRule.children : [newRule];
    if (oldMembers.every((om) => newMembers.some((nm) => isProvableWidenOrEqual(om, nm)))) {
      return true;
    }
  }

  // Intersection: `old` (an AND of its own children) is provably contained
  // in ANY intersection of a SUBSET of those same children (each optionally
  // itself widened) — dropping a required conjunct can only relax the
  // requirement, never tighten it. `new`'s own children (or `new` itself,
  // treated as a singleton AND) must each be covered by some `old` child;
  // `new` is free to use fewer of `old`'s original conjuncts, never more.
  if (oldRule.kind === 'intersection') {
    const oldChildren = oldRule.children;
    const newChildren = newRule.kind === 'intersection' ? newRule.children : [newRule];
    if (newChildren.every((nc) => oldChildren.some((oc) => isProvableWidenOrEqual(oc, nc)))) {
      return true;
    }
  }

  return false;
}

function relationDiff(oldRelation: CompiledRelation, newRelation: CompiledRelation): MemberDiff {
  const oldTypes = subjectTypeSet(oldRelation.subjectTypes);
  const newTypes = subjectTypeSet(newRelation.subjectTypes);
  if (setsEqual(oldTypes, newTypes)) {
    return { name: oldRelation.name, kind: 'relation', status: 'unchanged', reason: '' };
  }
  // Adding a subject type only ever expands what a FUTURE tuple write may
  // target — it changes nothing about any tuple already written, so it can
  // never affect what an existing check against this relation returns.
  // Removing one closes off future writes of that type going forward, but
  // — disclosed honestly, not hidden — this project's resolver never
  // re-validates a stored tuple's subject type against the currently
  // published schema at check time (`subjectTypes` is a write-time gate
  // only, per `src/schema/dsl/types.ts`'s own doc comment on
  // `SubjectTypeRef`), so removing a subject type does NOT retroactively
  // revoke any already-granted check the way a permission's rewrite-rule
  // change can. It is still classified `possibly-narrowing` here — a
  // conservative choice about future write intent, not a claim about
  // currently-resolvable access — rather than silently treated as safe.
  const classification: ChangeClassification = isSuperset(newTypes, oldTypes)
    ? 'widen'
    : 'possibly-narrowing';
  const reason =
    classification === 'widen'
      ? 'gained at least one new allowed subject type; every previously-allowed type is still allowed'
      : 'lost at least one previously-allowed subject type — future writes of that type will be rejected (this does not retroactively affect already-written tuples, since subject types are validated only at write time, never at check time)';
  return { name: oldRelation.name, kind: 'relation', status: 'changed', classification, reason };
}

function permissionDiff(
  oldPermission: CompiledPermission,
  newPermission: CompiledPermission,
): MemberDiff {
  if (deepEqualRewriteRule(oldPermission.rewrite, newPermission.rewrite)) {
    return { name: oldPermission.name, kind: 'permission', status: 'unchanged', reason: '' };
  }
  const classification: ChangeClassification = isProvableWidenOrEqual(
    oldPermission.rewrite,
    newPermission.rewrite,
  )
    ? 'widen'
    : 'possibly-narrowing';
  const reason =
    classification === 'widen'
      ? 'the new rewrite rule is structurally proven to grant a superset of what the old one granted'
      : "the new rewrite rule could not be proven to grant a superset of the old one — this may or may not actually remove access; see diff.ts's own top doc comment for what this classifier can and cannot prove";
  return {
    name: oldPermission.name,
    kind: 'permission',
    status: 'changed',
    classification,
    reason,
  };
}

/**
 * Diffs one namespace between two compiled schemas — the namespace both
 * `oldSchema` and `newSchema` are required to declare (a schema wrapping a
 * single historical `NamespaceConfig`, `{ namespaces: { [namespace]:
 * config } }`, satisfies this just as well as a full multi-namespace
 * `CompiledSchema` — see `src/cli/commands/schema.ts`'s `diffSchemaFile`
 * for exactly that construction). Every relation/permission name declared
 * on either side is reported exactly once: `'added'`/`'removed'` when only
 * one side declares it, `'unchanged'`/`'changed'` when both do. A name
 * that switches KIND between versions (a relation in one config, a
 * permission of the same name in the other — never possible within one
 * schema by construction, per `NamespaceConfig`'s own doc comment, but
 * nothing stops it across two independently-compiled schemas) is reported
 * `'changed'`/`'possibly-narrowing'` unconditionally — there is no sound
 * containment argument between a stored relation and a computed
 * permission's rewrite tree, so this module never attempts one.
 *
 * Throws if `namespace` is not declared in `oldSchema` or `newSchema` —
 * matching `classifyMonotone`'s own convention (`src/metamorphic
 * /monotonicity.ts`): a caller asking to diff a namespace neither schema
 * has is a malformed call, not a legitimate "nothing to report" answer.
 * `src/cli/commands/schema.ts` handles "this namespace has never been
 * published before" (no old config to construct an `oldSchema` from at
 * all) as its own, separate, non-error case *before* ever calling this
 * function — that is a real, expected first-publish scenario, not the
 * mismatched-input case this function's own `throw` guards against.
 */
export function diffNamespace(
  oldSchema: CompiledSchema,
  newSchema: CompiledSchema,
  namespace: string,
): NamespaceDiff {
  const oldConfig = oldSchema.namespaces[namespace];
  if (!oldConfig) {
    throw new Error(`diffNamespace: namespace '${namespace}' is not declared in the old schema`);
  }
  const newConfig = newSchema.namespaces[namespace];
  if (!newConfig) {
    throw new Error(`diffNamespace: namespace '${namespace}' is not declared in the new schema`);
  }

  const names = new Set<string>([
    ...Object.keys(oldConfig.relations),
    ...Object.keys(oldConfig.permissions),
    ...Object.keys(newConfig.relations),
    ...Object.keys(newConfig.permissions),
  ]);

  const members: MemberDiff[] = [];
  for (const name of [...names].sort()) {
    const oldMember = lookupMember(oldConfig, name);
    const newMember = lookupMember(newConfig, name);

    if (!oldMember && newMember) {
      members.push({ name, kind: newMember.kind, status: 'added', reason: '' });
      continue;
    }
    if (oldMember && !newMember) {
      members.push({
        name,
        kind: oldMember.kind,
        status: 'removed',
        reason: `this ${oldMember.kind} no longer exists in the new schema`,
      });
      continue;
    }
    if (!oldMember || !newMember) {
      // Unreachable: `names` is built from the union of both configs'
      // keys, so every name has at least one of `oldMember`/`newMember`
      // populated — this satisfies the type checker's own narrowing rather
      // than asserting something the two branches above haven't already
      // established.
      continue;
    }

    if (oldMember.kind !== newMember.kind) {
      members.push({
        name,
        kind: newMember.kind,
        status: 'changed',
        classification: 'possibly-narrowing',
        reason: `changed from a ${oldMember.kind} to a ${newMember.kind} — no sound containment argument applies across a kind change`,
      });
      continue;
    }

    if (oldMember.kind === 'relation' && newMember.kind === 'relation') {
      members.push(relationDiff(oldMember.relation, newMember.relation));
      continue;
    }
    if (oldMember.kind === 'permission' && newMember.kind === 'permission') {
      members.push(permissionDiff(oldMember.permission, newMember.permission));
    }
  }

  return { namespace, members };
}

/**
 * The subset of a `NamespaceDiff` an `authz schema diff` caller should
 * actually warn about: every `'removed'` member (unconditionally — a
 * relation or permission that no longer exists at all is never a provable
 * widen) plus every `'changed'` member this module could not prove is a
 * widen. Pulled out as its own function so `src/cli/commands/schema.ts`
 * doesn't re-implement this filter, and so this file's own unit tests can
 * assert on it directly rather than only on the raw `members` array.
 */
export function narrowingWarnings(diff: NamespaceDiff): MemberDiff[] {
  return diff.members.filter(
    (member) => member.status === 'removed' || member.classification === 'possibly-narrowing',
  );
}
