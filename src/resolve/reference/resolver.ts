/**
 * The reference resolver — Phase 3, the independent oracle Phase 5's
 * differential fuzzing checks the production resolver (Phase 4) against.
 * See `.claude/commands/build-authz-service.md` §6.2 (why this exists and
 * why it must never share code with Phase 4), §6.4 (cycle detection and
 * the depth budget as correctness requirements, not performance
 * optimizations), §5 (the rewrite-rule grammar this walks), and §6.7/Phase
 * 6 (the resolution-path evidence chain behind every `allowed: true`).
 *
 * Deliberately naive, deliberately slow: a synchronous, in-memory,
 * brute-force recursive graph search over a fully materialized tuple
 * snapshot handed in by the caller. No cache, no memoization, no query
 * planner, no index — every lookup below is a full linear scan of
 * `tuples`. Its only job is to be *obviously, checkably* correct; it is
 * verified against hand-derived examples (§9 Phase 3's exit criterion)
 * before it is trusted as an oracle for anything in Phase 5.
 *
 * **Isolation from the production resolver (Phase 4) is structural, not
 * just a promise.** Every helper below is module-private; the only things
 * this file exports besides plain, inert data-shape types are
 * `referenceCheck` and `DEFAULT_REFERENCE_MAX_DEPTH`. There is no exported
 * "walk a graph" or "evaluate a rewrite rule" utility for a future
 * SQL-backed resolver to import and quietly end up relying on the same
 * evaluation code — that would be exactly the failure mode §6.2 exists to
 * prevent: a bug shared by both resolvers passes the differential fuzz
 * harness identically and stops being catchable. This file's only
 * dependency is `src/schema/dsl/types.ts` (plain compiled-schema data
 * shapes, no logic) — not `src/store/`, not `src/config/env.ts`, not any
 * future `src/resolve/production/*`. See `docs/DECISIONS.md`.
 *
 * ---
 *
 * **Phase 6 — the resolution path (§6.7, §9 Phase 6's exit criterion).**
 * `ReferenceCheckResult.path` is populated only when `allowed` is true —
 * there is no meaningful path to a "no" (D-020's own reasoning for
 * omitting it originally). The shape is a real evidence *tree*, not a
 * flattened breadcrumb list, because a union/intersection/exclusion
 * rewrite doesn't reduce to one linear chain (D-020 flagged this
 * explicitly: "an intersection's path is really N paths, one per branch;
 * an exclusion's is a path plus a *disproof* of another path"):
 *
 * - `union` records the ONE branch that succeeded (any one suffices).
 * - `intersection` records EVERY branch's own proof (all must hold).
 * - `exclusion` records a proof of `base` AND a `DisproofStep` — a
 *   structurally symmetric NEGATIVE witness tree proving `subtract` does
 *   NOT hold, built by mirroring the exact same combinators (a
 *   `unionDisproof` needs every child disproven; an `intersectionDisproof`
 *   needs only one; a `relationDisproof` accounts for every stored tuple
 *   on that relation, either a subject mismatch or a disproven nested
 *   userset). This is what makes exclusion's path independently
 *   re-verifiable without asking a verifier to just trust "the resolver
 *   said subtract was false" — the disproof is itself a checkable
 *   artifact, walked the same way the proof is.
 * - `tupleToUserset` records, for the ONE followed tuple that worked, the
 *   object it pointed at and the proof of membership there.
 *
 * **Why this is independently re-verifiable, concretely:** every step
 * names a real `(object, relation, subject)` triple a verifier can check
 * against the ORIGINAL tuple array by simple membership (no search), and
 * every rewrite-combinator step names which schema-declared child(ren) it
 * corresponds to, checkable by walking the compiled `RewriteRule` tree
 * alongside the step (again no search — the verifier is handed exactly
 * which branch/child was used and only confirms it's consistent with the
 * schema and the tuples, never asked to discover one itself). See
 * `test/unit/resolve/reference-resolver.resolution-path.test.ts` for the
 * independent verifier that does exactly this, written from this file's
 * exported types and doc comments only.
 */
import type { CompiledSchema, RewriteRule } from '../../schema/dsl/types.js';

/** A namespaced entity reference — either the subject or the object of a check. */
export interface EntityRef {
  ns: string;
  id: string;
}

/**
 * The in-memory shape of one relation-tuple fact this resolver walks.
 * Field-for-field identical to `src/store/tuples.ts`'s `TupleKey` (same
 * names, same optionality) so a caller holding real tuple rows read from
 * the store can pass them straight in without a mapping step — but
 * deliberately *redefined* here rather than imported from `src/store/
 * tuples.ts`. This module's only import is `src/schema/dsl/types.ts`; it
 * has zero dependency on the store or on anything database-shaped, so it
 * can never be pulled into an import chain that also touches the
 * production resolver or Postgres. See `docs/DECISIONS.md`.
 */
export interface ReferenceTuple {
  objectNs: string;
  objectId: string;
  relation: string;
  subjectNs: string;
  subjectId: string;
  /** Present only for a tuple-to-userset subject ("group:eng#member"). */
  subjectRelation?: string;
}

export interface ReferenceCheckOptions {
  /**
   * An independent depth ceiling, separate from cycle detection (§6.4): a
   * very deep but acyclic chain must still terminate even though it never
   * revisits the same `(namespace, id, relation)` triple. Deliberately a
   * plain function parameter with a sensible default, never read from
   * `src/config/env.ts`'s `CHECK_MAX_DEPTH` directly — this resolver stays
   * pure and env-independent, the same discipline
   * `src/schema/dsl/compiler.ts` already holds itself to.
   */
  maxDepth?: number;
}

// ---------------------------------------------------------------------------
// Resolution-path shapes (§6.7, Phase 6) — the POSITIVE witness tree.
// ---------------------------------------------------------------------------

/** A real, stored tuple with no `subjectRelation` directly naming the queried subject. */
export interface DirectGrantStep {
  kind: 'directGrant';
  object: EntityRef;
  relation: string;
  subject: EntityRef;
}

/**
 * A real, stored tuple whose subject is itself a userset reference
 * (`object#relation@userset#usersetRelation`) — `member` is the recursive
 * proof that the queried subject belongs to `userset#usersetRelation`.
 */
export interface UsersetMembershipStep {
  kind: 'usersetMembership';
  object: EntityRef;
  relation: string;
  userset: EntityRef;
  usersetRelation: string;
  member: ResolutionStep;
}

/** One union branch (of possibly several declared) that resolved true — any one suffices. */
export interface UnionStep {
  kind: 'union';
  object: EntityRef;
  branchIndex: number;
  branch: ResolutionStep;
}

/** Every branch of an intersection resolved true — all are recorded, since all were required. */
export interface IntersectionStep {
  kind: 'intersection';
  object: EntityRef;
  branches: ResolutionStep[];
}

/** `base` holds and `subtract` is disproven — see `DisproofStep` below. */
export interface ExclusionStep {
  kind: 'exclusion';
  object: EntityRef;
  base: ResolutionStep;
  subtractDisproof: DisproofStep;
}

/** `relation` was followed to `through`, and `computedUserset` resolved true there. */
export interface TupleToUsersetStep {
  kind: 'tupleToUserset';
  object: EntityRef;
  relation: string;
  computedUserset: string;
  through: EntityRef;
  member: ResolutionStep;
}

/**
 * A `computedUserset` rewrite leaf (referencing another relation or
 * permission by name on the *same* object) has no step kind of its own —
 * it transparently delegates to whatever `resolveMembership` produced for
 * that name, exactly mirroring the resolver's own control flow (see
 * `resolveMembership`/`evalRewrite`'s `computedUserset` case below). A
 * verifier re-derives the delegation the same way, by looking the name up
 * in the schema — see this file's own top-of-file doc comment.
 */
export type ResolutionStep =
  | DirectGrantStep
  | UsersetMembershipStep
  | UnionStep
  | IntersectionStep
  | ExclusionStep
  | TupleToUsersetStep;

// ---------------------------------------------------------------------------
// Disproof shapes — the NEGATIVE witness tree, used ONLY inside an
// `ExclusionStep.subtractDisproof` (never returned as a check's own
// top-level result; there is no "path to a no" per this file's own
// top-of-file doc comment — a disproof exists solely to make an
// *allowed* exclusion's negative half independently checkable).
// ---------------------------------------------------------------------------

/** One stored tuple on the disproven `(object, relation)`, shown not to grant the queried subject. */
export type TupleDisproof =
  | { kind: 'subjectMismatch'; subject: EntityRef }
  | {
      kind: 'usersetNotMember';
      userset: EntityRef;
      usersetRelation: string;
      disproof: DisproofStep;
    };

/** Every stored tuple on `(object, relation)` accounted for, none of them a match. */
export interface RelationDisproof {
  kind: 'relationDisproof';
  object: EntityRef;
  relation: string;
  tupleDisproofs: TupleDisproof[];
}

/** Every union branch (all of them — union needs only one to hold) individually disproven. */
export interface UnionDisproof {
  kind: 'unionDisproof';
  object: EntityRef;
  branches: DisproofStep[];
}

/** One intersection branch disproven — sufficient, since intersection needs every branch. */
export interface IntersectionDisproof {
  kind: 'intersectionDisproof';
  object: EntityRef;
  branchIndex: number;
  branch: DisproofStep;
}

/** Either the exclusion's own base is disproven, or its own subtract is proven — either denies it. */
export interface ExclusionDisproof {
  kind: 'exclusionDisproof';
  object: EntityRef;
  reason:
    | { kind: 'baseDisproven'; base: DisproofStep }
    | { kind: 'subtractProven'; subtract: ResolutionStep };
}

/** Every tuple `relation` on `object` was followed, and none of them resolved `computedUserset` true. */
export interface TupleToUsersetDisproof {
  kind: 'tupleToUsersetDisproof';
  object: EntityRef;
  relation: string;
  followed: Array<{ through: EntityRef; disproof: DisproofStep }>;
}

/**
 * The independent depth ceiling or the cycle guard cut this branch off —
 * both are, by §6.4's own stated semantics, a real, defined "no" for that
 * branch (not an "unknown"), so both are legitimate disproof leaves. A
 * verifier confirms a `cycle` claim by re-threading the SAME (object,
 * name)-keyed visiting set down the SAME path the disproof tree describes
 * (see the verification test) — it is not accepted on faith.
 */
export interface BoundReachedDisproof {
  kind: 'boundReached';
  object: EntityRef;
  name: string;
  reason: 'cycle' | 'depth';
}

/** The namespace, relation, or permission named doesn't exist — vacuously false, never an "unknown". */
export interface UndeclaredDisproof {
  kind: 'undeclared';
  object: EntityRef;
  name: string;
}

export type DisproofStep =
  | RelationDisproof
  | UnionDisproof
  | IntersectionDisproof
  | ExclusionDisproof
  | TupleToUsersetDisproof
  | BoundReachedDisproof
  | UndeclaredDisproof;

export interface ReferenceCheckResult {
  allowed: boolean;
  /** Present if and only if `allowed` is true — see this file's own top-of-file doc comment. */
  path?: ResolutionStep;
}

/**
 * Generous on purpose. Cycle detection, not this ceiling, is what's
 * expected to actually terminate a cyclic group-nesting case (§6.4) — this
 * exists purely as an independent backstop for a pathologically deep but
 * genuinely acyclic chain, which real hand-derived and fuzzed graphs in
 * this project never approach (single- or low-double-digit hop chains).
 */
export const DEFAULT_REFERENCE_MAX_DEPTH = 1000;

/**
 * Compile-time exhaustiveness check for the `RewriteRule` switch in
 * `evalRewrite` below — a missing `case` fails `tsc`, not a resolver at
 * 2am. Written locally rather than imported from `src/schema/dsl/
 * compiler.ts`'s own copy of this exact one-line idiom
 * (`assertNeverRewriteRule`): the same trivial TypeScript pattern
 * independently written twice, not shared logic — see `docs/DECISIONS.md`
 * for why even a one-line helper stays duplicated rather than extracted.
 */
function assertNeverRewriteRule(node: never): never {
  throw new Error(`reference resolver: unhandled rewrite-rule kind ${JSON.stringify(node)}`);
}

interface WalkContext {
  readonly schema: CompiledSchema;
  readonly tuples: readonly ReferenceTuple[];
  readonly subject: EntityRef;
  readonly maxDepth: number;
}

/** `{ allowed: true; proof }` or `{ allowed: false; disproof }` — the one return shape every recursive step below produces. */
type MembershipOutcome =
  { allowed: true; proof: ResolutionStep } | { allowed: false; disproof: DisproofStep };

/**
 * The one recursion "unit" every mechanism in this file funnels through:
 * "is `ctx.subject` a member of the set resolved for `name` (a relation or
 * a permission) on object `(ns, id)`?" Both userset mechanisms the
 * dispatching task calls out funnel through here — stored-tuple userset
 * subjects via `resolveRelation`'s own recursive call, rewrite-rule
 * tuple-to-userset via `evalRewrite`'s `tupleToUserset` case, and a plain
 * same-object `computedUserset` reference — so cycle detection and the
 * depth ceiling apply uniformly to all three, not just one.
 *
 * **Cycle detection:** `visiting` tracks the `(ns, id, name)` triples on
 * the *current* root-to-node path only, via strict backtracking (added on
 * entry, removed in `finally` right before returning) — never a global
 * "ever visited anywhere" set. A diamond-shaped DAG where the same
 * `(ns, id, name)` is legitimately reachable via two different,
 * non-overlapping branches is therefore never falsely flagged; only a
 * genuine cycle (the same triple appearing twice on one root-to-node path)
 * is, and it resolves denied for that branch rather than hanging, per
 * §6.4.
 */
function resolveMembership(
  ctx: WalkContext,
  ns: string,
  id: string,
  name: string,
  visiting: Set<string>,
  depth: number,
): MembershipOutcome {
  const object: EntityRef = { ns, id };

  // Independent depth backstop (§6.4) — a hard ceiling regardless of
  // whether cycle detection alone would eventually have caught this
  // branch too.
  if (depth > ctx.maxDepth) {
    return { allowed: false, disproof: { kind: 'boundReached', object, name, reason: 'depth' } };
  }

  // `\0` (not a space or `:`) joins the three parts on purpose: it can
  // never appear in a valid namespace/relation/permission identifier
  // (`IDENTIFIER_PATTERN`) or realistically in an entity id either, so two
  // different `(ns, id, name)` triples can never collide into the same key
  // by accident — a composite string key is only as safe as its delimiter.
  const key = `${ns}\0${id}\0${name}`;
  if (visiting.has(key)) {
    return { allowed: false, disproof: { kind: 'boundReached', object, name, reason: 'cycle' } };
  }
  visiting.add(key);
  try {
    const nsConfig = ctx.schema.namespaces[ns];
    if (!nsConfig) return { allowed: false, disproof: { kind: 'undeclared', object, name } };

    const relation = nsConfig.relations[name];
    if (relation) {
      return resolveRelation(ctx, ns, id, name, visiting, depth);
    }
    const permission = nsConfig.permissions[name];
    if (permission) {
      return evalRewrite(ctx, permission.rewrite, ns, id, visiting, depth);
    }
    return { allowed: false, disproof: { kind: 'undeclared', object, name } };
  } finally {
    visiting.delete(key);
  }
}

/**
 * Mechanism 2 (stored-tuple userset subjects). Scans every stored tuple
 * for `relationName` on `(ns, id)` in full — no index, no short-circuit on
 * the array itself, only on the boolean result once a match is found
 * ("brute-force," per §6.2). A tuple with no `subjectRelation` is a plain
 * grant, compared directly against `ctx.subject`'s namespace and id. A
 * tuple *with* `subjectRelation` set (e.g.
 * `document:readme#editor@group:eng#member`) is a userset subject:
 * `ctx.subject` is a member of this tuple's grant only if it resolves for
 * `subjectRelation` on the tuple's own subject treated as a *new object*
 * (`group:eng`, checking `member`) — never by comparing ids directly,
 * which is exactly the distinction the dispatching task calls out as the
 * one not to conflate with tuple-to-userset (mechanism 1, in
 * `evalRewrite`'s `tupleToUserset` case below).
 *
 * Every tuple examined that doesn't establish membership is recorded in
 * `tupleDisproofs` on the way through — not just discarded — so a caller
 * denied here (or building a disproof for a containing exclusion) gets an
 * exhaustive, independently-checkable account of every real tuple that was
 * considered, not merely "false."
 */
function resolveRelation(
  ctx: WalkContext,
  ns: string,
  id: string,
  relationName: string,
  visiting: Set<string>,
  depth: number,
): MembershipOutcome {
  const object: EntityRef = { ns, id };
  const tupleDisproofs: TupleDisproof[] = [];

  for (const tuple of ctx.tuples) {
    if (tuple.objectNs !== ns || tuple.objectId !== id || tuple.relation !== relationName) {
      continue;
    }
    if (tuple.subjectRelation === undefined) {
      const subject: EntityRef = { ns: tuple.subjectNs, id: tuple.subjectId };
      if (subject.ns === ctx.subject.ns && subject.id === ctx.subject.id) {
        return {
          allowed: true,
          proof: { kind: 'directGrant', object, relation: relationName, subject },
        };
      }
      tupleDisproofs.push({ kind: 'subjectMismatch', subject });
      continue;
    }
    const userset: EntityRef = { ns: tuple.subjectNs, id: tuple.subjectId };
    const outcome = resolveMembership(
      ctx,
      tuple.subjectNs,
      tuple.subjectId,
      tuple.subjectRelation,
      visiting,
      depth + 1,
    );
    if (outcome.allowed) {
      return {
        allowed: true,
        proof: {
          kind: 'usersetMembership',
          object,
          relation: relationName,
          userset,
          usersetRelation: tuple.subjectRelation,
          member: outcome.proof,
        },
      };
    }
    tupleDisproofs.push({
      kind: 'usersetNotMember',
      userset,
      usersetRelation: tuple.subjectRelation,
      disproof: outcome.disproof,
    });
  }
  return {
    allowed: false,
    disproof: { kind: 'relationDisproof', object, relation: relationName, tupleDisproofs },
  };
}

/**
 * Walks one `RewriteRule` node for a permission's definition on object
 * `(ns, id)`. `union`/`intersection`/`exclusion` only combine other
 * rewrite-rule nodes over the *same* object — no new `resolveMembership`
 * recursion (and so no depth increment, no new cycle-detection key) until
 * a leaf (`computedUserset`) or a namespace-crossing leaf
 * (`tupleToUserset`) is reached. A rewrite-rule tree is a finite, static,
 * acyclic AST produced once at compile time, not data — it needs no cycle
 * guard of its own; only real tuple *data* can cycle, and that's what
 * `resolveMembership`'s `visiting` set guards against (§6.4).
 */
function evalRewrite(
  ctx: WalkContext,
  node: RewriteRule,
  ns: string,
  id: string,
  visiting: Set<string>,
  depth: number,
): MembershipOutcome {
  const object: EntityRef = { ns, id };
  switch (node.kind) {
    case 'computedUserset':
      // Transparent delegation — see this file's own doc comment on why a
      // computedUserset leaf has no step kind of its own.
      return resolveMembership(ctx, ns, id, node.name, visiting, depth + 1);

    case 'union': {
      const disproofs: DisproofStep[] = [];
      for (let i = 0; i < node.children.length; i += 1) {
        const child = node.children[i];
        if (child === undefined) continue; // unreachable given the loop bound
        const outcome = evalRewrite(ctx, child, ns, id, visiting, depth);
        if (outcome.allowed) {
          return {
            allowed: true,
            proof: { kind: 'union', object, branchIndex: i, branch: outcome.proof },
          };
        }
        disproofs.push(outcome.disproof);
      }
      return { allowed: false, disproof: { kind: 'unionDisproof', object, branches: disproofs } };
    }

    case 'intersection': {
      const proofs: ResolutionStep[] = [];
      for (let i = 0; i < node.children.length; i += 1) {
        const child = node.children[i];
        if (child === undefined) continue; // unreachable given the loop bound
        const outcome = evalRewrite(ctx, child, ns, id, visiting, depth);
        if (!outcome.allowed) {
          return {
            allowed: false,
            disproof: {
              kind: 'intersectionDisproof',
              object,
              branchIndex: i,
              branch: outcome.disproof,
            },
          };
        }
        proofs.push(outcome.proof);
      }
      return { allowed: true, proof: { kind: 'intersection', object, branches: proofs } };
    }

    case 'exclusion': {
      const base = evalRewrite(ctx, node.base, ns, id, visiting, depth);
      if (!base.allowed) {
        return {
          allowed: false,
          disproof: {
            kind: 'exclusionDisproof',
            object,
            reason: { kind: 'baseDisproven', base: base.disproof },
          },
        };
      }
      const subtract = evalRewrite(ctx, node.subtract, ns, id, visiting, depth);
      if (subtract.allowed) {
        return {
          allowed: false,
          disproof: {
            kind: 'exclusionDisproof',
            object,
            reason: { kind: 'subtractProven', subtract: subtract.proof },
          },
        };
      }
      return {
        allowed: true,
        proof: { kind: 'exclusion', object, base: base.proof, subtractDisproof: subtract.disproof },
      };
    }

    case 'tupleToUserset': {
      // Mechanism 1 (rewrite-rule tuple-to-userset). Follow every stored
      // tuple for `node.relation` on this object; for each one, recurse
      // into `node.computedUserset` on *that tuple's subject as if it
      // were a new object* — the tuple's own `subjectRelation`, if it
      // even has one, is not consulted here at all; the object being
      // recursed into is simply the tuple's subject identity
      // `(subjectNs, subjectId)`. This matches the dispatching task's own
      // worked example precisely: "for every tuple
      // folder:child#parent@X, recursively check whether the subject
      // resolves for view on X."
      const followed: Array<{ through: EntityRef; disproof: DisproofStep }> = [];
      for (const tuple of ctx.tuples) {
        if (tuple.objectNs !== ns || tuple.objectId !== id || tuple.relation !== node.relation) {
          continue;
        }
        const through: EntityRef = { ns: tuple.subjectNs, id: tuple.subjectId };
        const outcome = resolveMembership(
          ctx,
          tuple.subjectNs,
          tuple.subjectId,
          node.computedUserset,
          visiting,
          depth + 1,
        );
        if (outcome.allowed) {
          return {
            allowed: true,
            proof: {
              kind: 'tupleToUserset',
              object,
              relation: node.relation,
              computedUserset: node.computedUserset,
              through,
              member: outcome.proof,
            },
          };
        }
        followed.push({ through, disproof: outcome.disproof });
      }
      return {
        allowed: false,
        disproof: { kind: 'tupleToUsersetDisproof', object, relation: node.relation, followed },
      };
    }

    default:
      return assertNeverRewriteRule(node);
  }
}

/**
 * The one exported entry point. Given a compiled schema (the whole
 * multi-namespace `CompiledSchema`, not one namespace alone — a
 * tuple-to-userset rule crosses namespace boundaries, so anything less
 * would make that mechanism unwalkable), a fully materialized array of
 * relation-tuple facts, a subject, an object, and a relation-or-permission
 * name, determines whether `subject` is included in the resolved set for
 * that name on `object` — brute-force, in-memory, no I/O, no caching.
 *
 * Never throws. An undeclared namespace, an undeclared relation or
 * permission name, an object with zero tuples of any kind, and a cyclic
 * tuple graph all resolve `{ allowed: false }` — never an exception, never
 * a hang, never an "unknown" result (§9 Phase 3's own non-negotiable).
 *
 * `path` is present if and only if `allowed` is true — see this file's own
 * top-of-file doc comment for the shape and why it's independently
 * re-verifiable rather than a dump of internal recursion state.
 */
export function referenceCheck(
  schema: CompiledSchema,
  tuples: readonly ReferenceTuple[],
  subject: EntityRef,
  object: EntityRef,
  relationOrPermission: string,
  options: ReferenceCheckOptions = {},
): ReferenceCheckResult {
  const maxDepth = options.maxDepth ?? DEFAULT_REFERENCE_MAX_DEPTH;
  // Full-repo audit finding #6 (MEDIUM, `docs/DECISIONS.md` D-092), the
  // same bug class D-074 already found and fixed once for
  // `assertTokenObserved`: `depth > maxDepth` (below, in `resolveMembership`)
  // is `x > NaN`, which is always `false` in JavaScript — an
  // `options.maxDepth: NaN` would silently disable the depth ceiling
  // entirely, leaving branch-local cycle detection (which, by design per
  // D-021, does not fire on a genuinely acyclic-but-deep chain) as the only
  // termination guard, contradicting this file's own documented contract
  // just above ("Never throws ... never an exception, never a hang").
  // Rejected here, synchronously, before any recursion starts — matching
  // `assertTokenObserved`'s own established convention for this exact
  // class of defensive boundary check (a plain `Error`, not `TypeError`:
  // this project has no other use of the built-in error subclasses
  // anywhere in `src/`, so a bare `Error` — like every other thrown error
  // in this file and its production-resolver counterpart — is the better
  // match for "this project's own established error-throwing convention,"
  // not the literal class name a full-repo audit finding happened to
  // suggest).
  if (!Number.isFinite(maxDepth) || maxDepth < 0) {
    throw new Error(
      `referenceCheck: maxDepth must be a non-negative finite number, got ${String(options.maxDepth)}`,
    );
  }
  const ctx: WalkContext = { schema, tuples, subject, maxDepth };
  const outcome = resolveMembership(ctx, object.ns, object.id, relationOrPermission, new Set(), 0);
  return outcome.allowed ? { allowed: true, path: outcome.proof } : { allowed: false };
}
