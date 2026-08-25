/**
 * The production check engine — build spec `.claude/commands/build-authz-
 * service.md` §4/§6.3/§6.4/§6.7, Phase 4/6. Backed by real Postgres via
 * hand-written SQL (no ORM — see `docs/DECISIONS.md` D-004).
 *
 * Two userset mechanisms this engine has to resolve, deliberately handled
 * by two *different* implementation strategies (not just different code —
 * a genuinely different algorithm shape, per the Phase 4 delegation):
 *
 *  1. Rewrite-rule tuple-to-userset (`TupleToUsersetRule`, e.g.
 *     `parent->view`) crosses object/namespace boundaries and its shape
 *     depends on the *compiled schema*, which varies per namespace. That
 *     can't be one static SQL query across an arbitrary schema, so this
 *     part of the walk is orchestrated here, in TypeScript, recursing once
 *     per rewrite-rule AST node (`evalRewrite`/`resolve`, mutually
 *     recursive below).
 *  2. Stored-tuple userset subjects (`relation_tuples.subject_relation` —
 *     e.g. `document:readme#editor@group:eng#member`, where `group:eng`
 *     may itself nest further groups) is answered by
 *     `sqlRelationMembershipWithWitness`, a recursive `WITH RECURSIVE`
 *     query per relation-level check. The *target* relation name can
 *     change at every hop (a group's `member` relation might point at
 *     another group's `member` relation, or in principle at some other
 *     relation entirely), but the edge shape does not — "follow every
 *     userset-subject tuple on the current (namespace, id, relation)
 *     frontier" is schema-agnostic, which is exactly what makes it
 *     expressible as one recursive CTE instead of TypeScript-orchestrated
 *     recursion.
 *
 * **Isolation from `src/resolve/reference/resolver.ts` is absolute** — see
 * build spec §6.2 and the Phase 4 delegation's own restated non-negotiable.
 * This file's only imports are `src/schema/dsl/types.ts` (plain compiled-
 * schema data), `src/schema/publish.ts` (schema lookup — store
 * infrastructure, not resolver logic), `src/store/tokens.ts` (the
 * consistency-token *mechanism*, explicitly carved out by the Phase 4
 * delegation as shared store infrastructure, not something §6.2's
 * isolation rule applies to), and `src/config/env.ts`. `EntityRef` below is
 * a field-for-field redefinition of whatever shape the reference resolver
 * uses internally for the same concept — never an import of it — matching
 * `docs/DECISIONS.md` D-022's own precedent for `src/store/tuples.ts`'s
 * `TupleKey`. Every resolution-path/disproof type below (Phase 6) is
 * likewise a *field-for-field-named* but wholly independent redeclaration
 * of the reference resolver's own equivalent shapes — same names where the
 * concept is identical (`DirectGrantStep`, `UnionStep`, ...), never an
 * import, and the one place the two shapes genuinely diverge —
 * relation-membership disproof — is deliberately shaped differently to
 * fit this resolver's own SQL-backed mechanism (see `RelationDisproof`
 * below), not forced to match the reference resolver's in-memory tree
 * shape just for symmetry.
 *
 * ---
 *
 * **Phase 6 — the resolution path and `checks.depth` (§6.7, §9 Phase 6's
 * exit criterion).** `ProductionCheckResult` now carries `path` (present
 * iff `allowed` is true) and `depth` (the actual maximum recursion depth
 * reached anywhere in this check — both the TypeScript-orchestrated
 * combinator/tuple-to-userset walk and every SQL-side recursive CTE this
 * check issued, folded into one high-water mark — never just the
 * configured ceiling). See this file's own doc comments on `WalkContext
 * .depthReached` and `sqlRelationMembershipWithWitness`'s own return
 * shape for exactly how that's tracked.
 *
 * **Why `RelationDisproof` (used only inside an `ExclusionStep`'s
 * `subtractDisproof`, when a relation-membership check needs to prove a
 * NEGATIVE) is a flat reachability certificate, not a nested tree:** the
 * reference resolver's own relation-level disproof (`resolveRelation`) is
 * built for free as a side effect of an in-memory scan that was going to
 * touch every tuple anyway. This resolver's relation-membership mechanism
 * is one recursive SQL query — reconstructing a *nested* nested nested
 * disproof tree from repeated round-trips would mean re-deriving,
 * TypeScript-side, exactly the transitive closure Postgres already
 * computed once, for no correctness benefit. Instead,
 * `sqlRelationMembershipWithWitness` asks the SAME recursive CTE to return
 * *every* frontier node it actually reached (not just whether one
 * matched), fetches every real tuple stored on each of those nodes in one
 * follow-up query, and packages the result as a flat, self-contained
 * certificate: every reached node's real tuples are listed in full (so a
 * verifier can confirm none of them is a plain match for the subject), and
 * every userset edge out of a reached node is shown to either land on
 * another node in the same certificate or be legitimately excluded by the
 * same depth/cycle rule the SQL guard itself enforces (checkable from the
 * certificate's own `depth`/`ancestorPath` fields, independent of trusting
 * this resolver's own SQL). See `test/unit/resolve/production/production-
 * resolution-path.integration.test.ts` for the independent verifier that
 * checks exactly this, against real Postgres, without importing anything
 * from this file's own SQL.
 *
 * ---
 *
 * **One check, one snapshot (full-repo audit finding #1, `docs/DECISIONS.md`
 * D-092).** Every read this file issues on behalf of one `productionCheck`
 * call — every `sqlRelationMembershipWithWitness` frontier/tuple fetch,
 * every `listTupleSubjects` call for a `tupleToUserset` hop — now runs
 * inside one `REPEATABLE READ` transaction, pinned to one connection
 * acquired once at the top of `productionCheck` and released once at the
 * bottom. Before this, every one of those reads was its own independent,
 * autocommit `pool.query()` call with no shared snapshot at all: a
 * concurrent write landing between, say, the frontier query and the
 * tuple-on-frontier query could make a resolution path cite two facts
 * (an edge and a grant) that never actually coexisted at any single real
 * point in the database's history — a phantom witness in the audit trail
 * this project's whole `resolution_path` mechanism (§6.7) exists to rule
 * out. `REPEATABLE READ` (not `SERIALIZABLE`, which this read-only walk has
 * no need of, and which would add retry-worthy serialization failures this
 * codebase has no retry logic for) gives every read in one check the exact
 * same MVCC snapshot, matching Postgres's own documented semantics for
 * "this transaction sees one consistent point in time" and matching what
 * `docs/CONSISTENCY.md` already claimed before this fix existed.
 *
 * `atToken` pinning composes with this by re-verifying the floor check
 * (`write_log` has advanced to at least `atToken`) as literally the first
 * statement of the just-opened transaction, on the same client whose
 * snapshot every later read in the check will share — see
 * `assertTokenObservedOnSnapshot`'s own doc comment for exactly why a
 * *pool*-level check beforehand isn't sufficient on its own. `getConfig`'s
 * `namespace_configs` reads run on this same pinned client too (closing a
 * gap this fix originally left open — see `productionCheck`'s own doc
 * comment for the full history and the connection-exhaustion deadlock
 * closing it also fixes).
 *
 * **`pool: ConnectionSource`/`client: QueryExecutor`, not concrete
 * `pg.Pool`/`pg.PoolClient` — DST D2 (`docs/DECISIONS.md` D-099).** The
 * same non-breaking narrowing D0/D1 already applied to `src/store/tuples
 * .ts`/`tokens.ts`/`publish.ts`/`migrate.ts`: a real `Pool`/`PoolClient`
 * still satisfies these structurally, so every real caller (`authz
 * check`, `POST /check`, `src/audit/checks.ts`) keeps working with zero
 * changes. **This narrowing is orthogonal to `docs/DECISIONS.md` D-022**,
 * which forbids the *reference* resolver (`src/resolve/reference/
 * resolver.ts`) sharing code with the *production* one — parameterizing
 * which physical driver answers this file's own storage calls touches
 * neither side of that isolation boundary: nothing here imports from or
 * shares code with `src/resolve/reference/`, and D-022's own rule was
 * never about how *this* file talks to Postgres.
 */
import type { ConnectionSource, QueryExecutor } from '../../store/query-executor.js';

import { env } from '../../config/env.js';
import type { NamespaceConfig, RewriteRule } from '../../schema/dsl/types.js';
import { getLatestNamespaceConfig } from '../../schema/publish.js';
import { assertTokenObserved } from '../../store/tokens.js';

/** An object or subject reference — `ns:id`, e.g. `document:readme`, `user:alice`. */
export interface EntityRef {
  ns: string;
  id: string;
}

export interface ProductionCheckOptions {
  /**
   * Pin the read to a consistency token (build spec §6.3). When present,
   * `assertTokenObserved(pool, atToken)` is called *first*, before this
   * call ever opens the transaction/client the walk below runs in — it
   * throws if this database hasn't observed that token yet, per its own
   * documented contract, giving a cheap, well-tested rejection for an
   * obviously too-high token before paying for a connection at all.
   *
   * That alone is *not* sufficient (full-repo audit finding #1,
   * `docs/DECISIONS.md` D-092): it only proves the token had been observed
   * by *some* connection at the moment it ran, not that the `REPEATABLE
   * READ` snapshot this check's own reads will use is anchored at or after
   * that point. `productionCheck` re-verifies the same floor check a
   * second time, as literally the first statement of the transaction it
   * then runs every other read of this check inside — see
   * `assertTokenObservedOnSnapshot`'s own doc comment for exactly why, and
   * `productionCheck`'s own doc comment for the transaction this option
   * now participates in.
   */
  atToken?: number;
  /**
   * Overrides `env.CHECK_MAX_DEPTH` for this call only. Threaded through
   * to *both* depth backstops this engine has: the TypeScript-level
   * combinator/tuple-to-userset walk (`resolve`) and the SQL-level
   * recursive CTE's own `depth` column cap
   * (`sqlRelationMembershipWithWitness`) — see this file's own doc comment
   * on that function for exactly how those two independent ceilings
   * compose. Tests use this to force a budget the depth ceiling itself
   * can't quietly absorb a missing cycle guard into — the same discipline
   * `docs/DECISIONS.md` D-024 records for the reference resolver's own
   * cyclic-case test.
   */
  maxDepth?: number;
}

// ---------------------------------------------------------------------------
// Resolution-path shapes (§6.7, Phase 6) — the POSITIVE witness tree.
// Field-for-field independent of `src/resolve/reference/resolver.ts`'s own
// shapes of the same name — see this file's own top-of-file doc comment.
// ---------------------------------------------------------------------------

export interface DirectGrantStep {
  kind: 'directGrant';
  object: EntityRef;
  relation: string;
  subject: EntityRef;
}

export interface UsersetMembershipStep {
  kind: 'usersetMembership';
  object: EntityRef;
  relation: string;
  userset: EntityRef;
  usersetRelation: string;
  member: ResolutionStep;
}

export interface UnionStep {
  kind: 'union';
  object: EntityRef;
  branchIndex: number;
  branch: ResolutionStep;
}

export interface IntersectionStep {
  kind: 'intersection';
  object: EntityRef;
  branches: ResolutionStep[];
}

export interface ExclusionStep {
  kind: 'exclusion';
  object: EntityRef;
  base: ResolutionStep;
  subtractDisproof: DisproofStep;
}

export interface TupleToUsersetStep {
  kind: 'tupleToUserset';
  object: EntityRef;
  relation: string;
  computedUserset: string;
  through: EntityRef;
  member: ResolutionStep;
}

export type ResolutionStep =
  | DirectGrantStep
  | UsersetMembershipStep
  | UnionStep
  | IntersectionStep
  | ExclusionStep
  | TupleToUsersetStep;

// ---------------------------------------------------------------------------
// Disproof shapes — the NEGATIVE witness, used only inside an
// `ExclusionStep.subtractDisproof`.
// ---------------------------------------------------------------------------

/** One frontier node's identity in the userset-subject membership graph — matches `sqlRelationMembershipWithWitness`'s own CTE columns. */
export interface RelationClosureKey {
  ns: string;
  id: string;
  relation: string;
}

export type ClosureTuple =
  | { kind: 'plain'; subject: EntityRef }
  | { kind: 'userset'; userset: EntityRef; usersetRelation: string };

/**
 * One node in a reachability certificate: every real tuple stored on it
 * (so a verifier can confirm none is a plain match), its own depth, and
 * its own root-to-here ancestor path (so a verifier can confirm any edge
 * NOT continuing into another certificate node is legitimately excluded by
 * the same depth/cycle rule the SQL recursive CTE itself enforces, per
 * this file's own top-of-file doc comment).
 */
export interface ClosureNode {
  key: RelationClosureKey;
  depth: number;
  ancestorPath: RelationClosureKey[];
  tuples: ClosureTuple[];
}

/** See this file's own top-of-file doc comment for why this is a flat certificate, not a nested tree. */
export interface RelationDisproof {
  kind: 'relationDisproof';
  object: EntityRef;
  relation: string;
  maxDepth: number;
  nodes: ClosureNode[];
}

export interface UnionDisproof {
  kind: 'unionDisproof';
  object: EntityRef;
  branches: DisproofStep[];
}

export interface IntersectionDisproof {
  kind: 'intersectionDisproof';
  object: EntityRef;
  branchIndex: number;
  branch: DisproofStep;
}

export interface ExclusionDisproof {
  kind: 'exclusionDisproof';
  object: EntityRef;
  reason:
    | { kind: 'baseDisproven'; base: DisproofStep }
    | { kind: 'subtractProven'; subtract: ResolutionStep };
}

export interface TupleToUsersetDisproof {
  kind: 'tupleToUsersetDisproof';
  object: EntityRef;
  relation: string;
  followed: Array<{ through: EntityRef; disproof: DisproofStep }>;
}

export interface BoundReachedDisproof {
  kind: 'boundReached';
  object: EntityRef;
  name: string;
  reason: 'cycle' | 'depth';
}

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

export interface ProductionCheckResult {
  allowed: boolean;
  /** Present if and only if `allowed` is true. */
  path?: ResolutionStep;
  /** The actual maximum recursion depth reached anywhere in this check — see this file's own top-of-file doc comment. */
  depth: number;
}

/** `{ allowed: true; proof }` or `{ allowed: false; disproof }` — the one return shape every recursive step below produces. */
type ProductionOutcome =
  { allowed: true; proof: ResolutionStep } | { allowed: false; disproof: DisproofStep };

/**
 * Per-check-call state threaded through the recursive walk. `schemaCache`
 * exists purely to avoid re-querying `namespace_configs` for a namespace
 * this same check has already looked up (e.g. `folder`'s `parent->view`
 * revisiting `folder` itself at every hop of a parent chain) — it is
 * rebuilt fresh on every `productionCheck` call, never shared or reused
 * across calls, so it cannot become a correctness-relevant cache (see
 * build spec §6.1: "there is no cached, precomputed ... permission
 * anywhere that isn't provably derivable from current tuples on demand").
 *
 * `depthReached` is a single mutable high-water mark for the whole check —
 * both the TypeScript-level `depth` counter (updated at every `resolve`
 * entry) and every SQL-level recursive CTE's own reached depth (folded in
 * right after each `sqlRelationMembershipWithWitness` call returns) — so
 * `productionCheck`'s returned `depth` reflects the deepest point *either*
 * mechanism actually reached, not just whichever one happened to run last.
 *
 * `client` is the *only* connection this whole check ever needs — every
 * read (`relation_tuples`/`write_log` via `sqlRelationMembershipWithWitness`/
 * `listTupleSubjects`, and, as of this fix, `namespace_configs` via
 * `getConfig` below too) runs on this one pinned `REPEATABLE READ` client.
 * A separate `pool` field used to live here for `getConfig` alone — see
 * `productionCheck`'s own doc comment for why that was a real,
 * production-reachable connection-exhaustion deadlock, not just a
 * theoretical one, and why removing it (one connection per check, never
 * two) is the fix, not a workaround.
 */
interface WalkContext {
  client: QueryExecutor;
  maxDepth: number;
  schemaCache: Map<string, NamespaceConfig | null>;
  depthReached: { value: number };
}

async function getConfig(ctx: WalkContext, ns: string): Promise<NamespaceConfig | null> {
  const cached = ctx.schemaCache.get(ns);
  if (cached !== undefined) return cached;
  const config = await getLatestNamespaceConfig(ctx.client, ns);
  const resolved = config ?? null;
  ctx.schemaCache.set(ns, resolved);
  return resolved;
}

/**
 * Branch-local cycle-detection key: `(namespace, id, relation-or-
 * permission-name)`, joined with `:`/`#` — separators that can never
 * appear in a real identifier (`IDENTIFIER_PATTERN` in
 * `src/schema/dsl/types.ts` only allows `[a-z][a-z0-9_]*`), so this can
 * never collide by accident.
 */
function entityNameKey(object: EntityRef, name: string): string {
  return `${object.ns}:${object.id}#${name}`;
}

/**
 * The single recursion unit both userset mechanisms funnel through:
 * "is `subject` related to `object` via `name` (a relation or a
 * permission)?" Cycle detection and the depth ceiling both live here, at
 * the one place every re-entry into a name (whether same-object
 * permission indirection or a cross-object hop via tuple-to-userset)
 * passes through — mirroring, independently, the same shape of guarantee
 * §6.4 requires of the reference resolver, not shared code with it.
 *
 * - `depth` counts "how many times has this walk re-entered a name" —
 *   incremented once per recursive descent into a permission's rewrite
 *   tree (see the `permission` branch below); `union`/`intersection`/
 *   `exclusion` combinator nodes do not bump it themselves (`evalRewrite`
 *   just forwards the depth it was given to each child) — a schema
 *   author's choice of how many `|`/`&`/`-` operators to chain is a
 *   static, compiler-verified-acyclic AST shape (see
 *   `src/schema/dsl/compiler.ts`'s `checkCircularPermissions`), not the
 *   *data*-driven recursion this ceiling exists to bound.
 * - `visited` is the current root-to-node path's set of
 *   `entityNameKey`s, added on entry and removed via `finally` right
 *   before this call returns — a hit means the current branch has looped
 *   back to a name it's already in the middle of resolving, which can
 *   only happen via tuple-data-driven recursion (tuple-to-userset
 *   crossing back to an ancestor object, or a same-object permission
 *   re-entered — the compiler already forbids a *static* permission
 *   cycle, so in practice this guards the tuple-to-userset case). Because
 *   this whole walk is strictly sequential (every `for` loop below
 *   `await`s one child before starting the next — never `Promise.all`),
 *   one mutable `Set` shared across sibling branches is safe: a sibling
 *   only ever sees the keys still on the *current* path, since each
 *   completed branch removes its own entries before the next sibling
 *   starts.
 * - When `name` is a storable **relation**, the entire remaining question
 *   — direct grant or arbitrarily-nested userset membership — is handed
 *   off whole to `sqlRelationMembershipWithWitness`, which is self-
 *   contained and cycle-safe on its own (its own path-array-based cycle
 *   guard, its own depth cap). This function's own `visited`/`depth`
 *   bookkeeping still applies to the *entry* into that relation check, but
 *   the recursion inside the userset-subject graph never comes back
 *   through this function — it's a different (SQL-level) recursion
 *   entirely.
 */
async function resolve(
  ctx: WalkContext,
  subject: EntityRef,
  object: EntityRef,
  name: string,
  visited: Set<string>,
  depth: number,
): Promise<ProductionOutcome> {
  ctx.depthReached.value = Math.max(ctx.depthReached.value, depth);
  if (depth > ctx.maxDepth) {
    return { allowed: false, disproof: { kind: 'boundReached', object, name, reason: 'depth' } };
  }

  const key = entityNameKey(object, name);
  if (visited.has(key)) {
    return { allowed: false, disproof: { kind: 'boundReached', object, name, reason: 'cycle' } };
  }
  visited.add(key);
  try {
    const config = await getConfig(ctx, object.ns);
    if (!config) return { allowed: false, disproof: { kind: 'undeclared', object, name } };

    const relation = config.relations[name];
    if (relation) {
      const remainingDepth = Math.max(0, ctx.maxDepth - depth);
      const sqlOutcome = await sqlRelationMembershipWithWitness(
        ctx.client,
        object,
        name,
        subject,
        remainingDepth,
      );
      ctx.depthReached.value = Math.max(ctx.depthReached.value, sqlOutcome.depthReached);
      return sqlOutcome.allowed
        ? { allowed: true, proof: sqlOutcome.proof }
        : { allowed: false, disproof: sqlOutcome.disproof };
    }

    const permission = config.permissions[name];
    if (permission) {
      return await evalRewrite(ctx, permission.rewrite, subject, object, visited, depth + 1);
    }

    // Undeclared relation/permission name — fail closed, never throw.
    return { allowed: false, disproof: { kind: 'undeclared', object, name } };
  } finally {
    visited.delete(key);
  }
}

/** Exhaustiveness guard — independently duplicated, not imported from
 * `src/schema/dsl/compiler.ts`'s identical pattern, per the same reasoning
 * `docs/DECISIONS.md` D-022 records for the reference resolver. */
function assertNeverRewriteRule(node: never): never {
  throw new Error(`unreachable rewrite-rule kind: ${JSON.stringify(node)}`);
}

async function evalRewrite(
  ctx: WalkContext,
  rule: RewriteRule,
  subject: EntityRef,
  object: EntityRef,
  visited: Set<string>,
  depth: number,
): Promise<ProductionOutcome> {
  switch (rule.kind) {
    case 'computedUserset': {
      return resolve(ctx, subject, object, rule.name, visited, depth);
    }
    case 'union': {
      const disproofs: DisproofStep[] = [];
      for (let i = 0; i < rule.children.length; i += 1) {
        const child = rule.children[i];
        if (child === undefined) continue; // unreachable given the loop bound
        const outcome = await evalRewrite(ctx, child, subject, object, visited, depth);
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
      for (let i = 0; i < rule.children.length; i += 1) {
        const child = rule.children[i];
        if (child === undefined) continue; // unreachable given the loop bound
        const outcome = await evalRewrite(ctx, child, subject, object, visited, depth);
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
      const base = await evalRewrite(ctx, rule.base, subject, object, visited, depth);
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
      const subtract = await evalRewrite(ctx, rule.subtract, subject, object, visited, depth);
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
      const subjects = await listTupleSubjects(ctx.client, object, rule.relation);
      const followed: Array<{ through: EntityRef; disproof: DisproofStep }> = [];
      for (const newObject of subjects) {
        const outcome = await resolve(
          ctx,
          subject,
          newObject,
          rule.computedUserset,
          visited,
          depth,
        );
        if (outcome.allowed) {
          return {
            allowed: true,
            proof: {
              kind: 'tupleToUserset',
              object,
              relation: rule.relation,
              computedUserset: rule.computedUserset,
              through: newObject,
              member: outcome.proof,
            },
          };
        }
        followed.push({ through: newObject, disproof: outcome.disproof });
      }
      return {
        allowed: false,
        disproof: { kind: 'tupleToUsersetDisproof', object, relation: rule.relation, followed },
      };
    }
    default:
      return assertNeverRewriteRule(rule);
  }
}

interface TupleSubjectRow {
  subject_ns: string;
  subject_id: string;
}

/**
 * Every stored subject of `(object, relation)`, treating each tuple's
 * subject as a new object reference — the tuple-to-userset hop itself
 * ("follow `parent`, then recurse `view` on whatever it points to"). Per
 * `src/schema/dsl/types.ts`'s own contract, `relation` here always names an
 * actual storable relation (the compiler rejects a `tupleToUserset` whose
 * `relation` names a permission), so no schema check is needed before this
 * query — only whether `object`'s namespace declares it at all, which
 * `resolve` already established by the time `evalRewrite` reaches this
 * branch (the *followed* relation's own row may not even exist on this
 * object if there are simply no tuples for it, which is not an error —
 * zero rows here just means zero branches to recurse into, i.e. this
 * `tupleToUserset` rule contributes nothing, same as any other empty
 * union branch).
 *
 * Deliberately ignores `subject_relation` on the followed-relation tuples
 * themselves — tuple-to-userset's own semantics only care about *where the
 * edge points* (the tuple's `subject_ns`/`subject_id`), never about
 * whether that pointer happens to also be a userset reference; membership
 * *within* whatever it points to is a separate question, resolved by
 * recursing `computedUserset` on the new object.
 *
 * Takes `client` (this check's own `REPEATABLE READ`-pinned connection),
 * never `pool` — full-repo audit finding #1, `docs/DECISIONS.md` D-092.
 * This is exactly the kind of `relation_tuples` read that fix exists for:
 * without it, a `tupleToUserset` hop's own subject list could be read from
 * a different real moment in the database's history than the frontier
 * queries `sqlRelationMembershipWithWitness` issues later in the very same
 * check.
 */
async function listTupleSubjects(
  client: QueryExecutor,
  object: EntityRef,
  relation: string,
): Promise<EntityRef[]> {
  const { rows } = await client.query<TupleSubjectRow>(
    `select subject_ns, subject_id
     from relation_tuples
     where object_ns = $1 and object_id = $2 and relation = $3`,
    [object.ns, object.id, relation],
  );
  return rows.map((row) => ({ ns: row.subject_ns, id: row.subject_id }));
}

// ---------------------------------------------------------------------------
// Mechanism 2 — relation-membership, with the full positive/negative
// witness reconstruction (Phase 6). See this file's own top-of-file doc
// comment for why the disproof shape is a flat certificate.
// ---------------------------------------------------------------------------

/**
 * Exported (not module-private, despite `sqlRelationMembershipWithWitness`
 * being this shape's only in-file consumer) for exactly one reason,
 * matching `src/store/tuples.ts`'s own `WRITE_LOG_LOCK_CLASSID` precedent:
 * DST D3's own differential-equivalence suite (`docs/DECISIONS.md` D-100)
 * needs to call the *real* `fetchReachableFrontier` directly against real
 * Postgres and compare its output row-for-row against the in-memory
 * `fetchReachableFrontierVia` — exporting the real function and its real
 * row shape means that suite exercises the actual production query, not a
 * hand-copied SQL string that could silently drift out of sync with this
 * file on a future edit.
 */
export interface FrontierRow {
  ns: string;
  id: string;
  relation: string;
  depth: number;
  path: string[];
}

/**
 * Every frontier node reached while transitively following userset-subject
 * tuples from `(object, relation)` — the *entire* recursive CTE's own
 * output, not just whether a match exists. Cycle safety is identical to
 * the boolean-only query this replaces (see `docs/DECISIONS.md` D-026):
 * the `path` column excludes a row the instant its own key would repeat
 * one already on that branch, and `depth < maxDepth` is an independent
 * backstop. The seed row (`depth = 0`, the starting `(object, relation)`
 * itself) is always present, even with zero recursion.
 *
 * Takes `client` (this check's own `REPEATABLE READ`-pinned connection),
 * never `pool` — full-repo audit finding #1, `docs/DECISIONS.md` D-092. See
 * `productionCheck`'s own doc comment for the transaction this runs inside.
 *
 * **Per-iteration dedup (full-repo audit finding #2, `docs/DECISIONS.md`
 * D-092).** The recursive term's `select` is `distinct on (subject_ns,
 * subject_id, subject_relation)`, not a plain `select` — Postgres allows
 * `DISTINCT ON` directly in a recursive term (confirmed against real
 * Postgres 16; only `ORDER BY`/`LIMIT`/`OFFSET`/aggregates/window
 * functions are rejected there, and this doesn't need any of those to
 * still be correct — see the paragraph below). Without it, a node reached
 * via K different upstream paths in one iteration has *all* of its
 * outgoing edges independently re-expanded K times in the next iteration —
 * ordinary `WITH RECURSIVE` semantics, and exactly what a "diamond of
 * diamonds" reconvergent group hierarchy (expected per D-021, and the
 * normal shape of a real nested-group tree) produces: `b^d` rows for only
 * `b*d` distinct nodes. Confirmed directly against real Postgres before
 * this fix landed: a 12-level, branching-3 chain of reconvergent diamonds
 * (well within the default `CHECK_MAX_DEPTH` of 25) never returned within
 * a 20-second timeout on the unfixed query; the identical query, with only
 * this `distinct on` added, returns in under 100ms. See
 * `cross-resolver-agreement.integration.test.ts`'s own
 * "a subject_relation-based ... reconvergent diamond" test for the
 * committed regression/performance guard.
 *
 * **Why this can't silently drop real reachability (the thing to be most
 * careful about here, per the finding's own instruction).** `DISTINCT ON`
 * only collapses *duplicate, same-iteration* rows for one identity down to
 * one representative row — it never prevents a *genuinely new* identity
 * from being discovered. The concern worth naming explicitly: could
 * collapsing to one representative path for a node cause its cycle guard
 * (`not (... = any(m.path))`) to block a child identity that a *different*
 * (discarded) duplicate's path wouldn't have blocked? No — any identity
 * that could ever appear in a chosen representative's own `path` array
 * must, by construction, have already been added to the frontier as its
 * *own* row at an earlier (or the same) iteration — appearing in someone's
 * ancestor list is only possible by having been discovered first. So that
 * identity's own children were already (or will still be) explored via its
 * own frontier entry, independent of whatever a *different* node's
 * dedup-selected representative does later. This was additionally verified
 * empirically, not just argued: a throwaway differential fuzz script (not
 * committed — the reasoning above and this file's own regression test are
 * the durable artifacts) generated 3,000 random cyclic/reconvergent graphs
 * (6–25 nodes, out-degree 0–5) and compared the *set* of reachable
 * `(ns,id,relation)` identities returned by this query with and without the
 * `distinct on` — zero mismatches. Note this dedups *within* one
 * iteration only, not globally across every iteration a node could ever
 * reappear at (a true global "visited" set isn't expressible in a
 * standard-conforming Postgres recursive CTE without violating its "the
 * recursive table may be referenced only once" restriction); a node
 * rediscovered at a much later, unrelated depth can still appear more than
 * once in this function's raw output, which `dedupeFrontier` immediately
 * below already existed to collapse for correctness (not performance)
 * before this fix, and still does.
 *
 * **`depth`/`ancestorPath` note:** because `DISTINCT ON` (with no `ORDER
 * BY` — Postgres rejects `ORDER BY` in a recursive term outright) picks an
 * unspecified representative among same-iteration duplicates, the specific
 * `depth`/`path` kept for a node that had multiple same-iteration parents
 * is real (a genuine root-to-node walk through real tuples — never
 * fabricated) but not guaranteed to be the *shortest* available one. This
 * is a deliberate, disclosed trade of a small amount of diagnostic
 * precision (`checks.depth`'s high-water mark, §6.7) for eliminating the
 * exponential blowup — it does not affect `allowed`/`denied` correctness,
 * per the reachability argument above.
 *
 * Exported — see `FrontierRow`'s own doc comment for why (DST D3's
 * differential-equivalence suite, `docs/DECISIONS.md` D-100, calls this
 * real function directly against a real Postgres testcontainer).
 */
export async function fetchReachableFrontier(
  client: QueryExecutor,
  object: EntityRef,
  relation: string,
  maxDepth: number,
): Promise<FrontierRow[]> {
  const { rows } = await client.query<FrontierRow>(
    `with recursive membership(ns, id, relation, depth, path) as (
       select
         $1::text as ns,
         $2::text as id,
         $3::text as relation,
         0 as depth,
         array[$1::text || ':' || $2::text || '#' || $3::text] as path
       union all
       select distinct on (rt.subject_ns, rt.subject_id, rt.subject_relation)
         rt.subject_ns,
         rt.subject_id,
         rt.subject_relation,
         m.depth + 1,
         m.path || (rt.subject_ns || ':' || rt.subject_id || '#' || rt.subject_relation)
       from relation_tuples rt
       join membership m
         on rt.object_ns = m.ns and rt.object_id = m.id and rt.relation = m.relation
       where rt.subject_relation is not null
         and m.depth < $4
         and not (
           (rt.subject_ns || ':' || rt.subject_id || '#' || rt.subject_relation) = any (m.path)
         )
     )
     select ns, id, relation, depth, path from membership`,
    [object.ns, object.id, relation, maxDepth],
  );
  return rows;
}

function frontierKeyStr(row: Pick<FrontierRow, 'ns' | 'id' | 'relation'>): string {
  return `${row.ns}:${row.id}#${row.relation}`;
}

/** Dedupes reached frontier rows by identity, keeping the minimum-depth occurrence of each (deterministic, arbitrary tie-break otherwise). Exported alongside `FrontierRow`/`fetchReachableFrontier` — see `FrontierRow`'s own doc comment for why (DST D3's differential-equivalence suite applies this identical dedup to both the real and in-memory frontier outputs before comparing them). */
export function dedupeFrontier(rows: readonly FrontierRow[]): Map<string, FrontierRow> {
  const byKey = new Map<string, FrontierRow>();
  for (const row of rows) {
    const key = frontierKeyStr(row);
    const existing = byKey.get(key);
    if (!existing || row.depth < existing.depth) byKey.set(key, row);
  }
  return byKey;
}

interface FrontierTupleRow {
  object_ns: string;
  object_id: string;
  relation: string;
  subject_ns: string;
  subject_id: string;
  subject_relation: string | null;
}

/**
 * Every real `relation_tuples` row stored on any of `frontier`'s nodes, in
 * one query. Takes `client` (this check's own `REPEATABLE READ`-pinned
 * connection), never `pool` — the exact query pair (this one, and the
 * `fetchReachableFrontier` call that produced `frontier`) full-repo audit
 * finding #1's concrete counterexample was about: without a shared
 * snapshot, a userset edge this function's caller already saw could be
 * deleted, and its target independently (re)granted, between these two
 * queries — see `docs/DECISIONS.md` D-092 and `productionCheck`'s own doc
 * comment for the transaction this now runs inside.
 */
async function fetchTuplesOnFrontier(
  client: QueryExecutor,
  frontier: ReadonlyMap<string, FrontierRow>,
): Promise<FrontierTupleRow[]> {
  if (frontier.size === 0) return [];
  const nsArr: string[] = [];
  const idArr: string[] = [];
  const relArr: string[] = [];
  for (const row of frontier.values()) {
    nsArr.push(row.ns);
    idArr.push(row.id);
    relArr.push(row.relation);
  }
  const { rows } = await client.query<FrontierTupleRow>(
    `select rt.object_ns, rt.object_id, rt.relation, rt.subject_ns, rt.subject_id, rt.subject_relation
     from relation_tuples rt
     join (
       select unnest($1::text[]) as ns, unnest($2::text[]) as id, unnest($3::text[]) as relation
     ) as frontier
       on rt.object_ns = frontier.ns and rt.object_id = frontier.id and rt.relation = frontier.relation`,
    [nsArr, idArr, relArr],
  );
  return rows;
}

function groupTuplesByFrontierKey(
  tupleRows: readonly FrontierTupleRow[],
): Map<string, FrontierTupleRow[]> {
  const byKey = new Map<string, FrontierTupleRow[]>();
  for (const row of tupleRows) {
    const key = frontierKeyStr({ ns: row.object_ns, id: row.object_id, relation: row.relation });
    const existing = byKey.get(key);
    if (existing) {
      existing.push(row);
    } else {
      byKey.set(key, [row]);
    }
  }
  return byKey;
}

/**
 * Parses one `path` element (`ns:id#relation`) back into its parts.
 * Unambiguous: every namespace/id/relation is restricted to
 * `[a-z][a-z0-9_]*` (`IDENTIFIER_PATTERN`), which never contains `:` or
 * `#`, so splitting on the first occurrence of each is always correct.
 */
function parseFrontierKeyString(raw: string): RelationClosureKey {
  const hashIndex = raw.indexOf('#');
  const colonIndex = raw.indexOf(':');
  if (hashIndex < 0 || colonIndex < 0 || colonIndex >= hashIndex) {
    throw new Error(`sqlRelationMembershipWithWitness: malformed frontier key '${raw}'`);
  }
  return {
    ns: raw.slice(0, colonIndex),
    id: raw.slice(colonIndex + 1, hashIndex),
    relation: raw.slice(hashIndex + 1),
  };
}

/** Reconstructs a positive proof from a winning frontier row's own `path` — a plain linear walk, not a search. */
function reconstructProof(path: readonly string[], plainSubject: EntityRef): ResolutionStep {
  const nodes = path.map(parseFrontierKeyString);
  const lastIndex = nodes.length - 1;
  const last = nodes[lastIndex];
  if (!last)
    throw new Error('sqlRelationMembershipWithWitness: empty path on a winning frontier row');

  let current: ResolutionStep = {
    kind: 'directGrant',
    object: { ns: last.ns, id: last.id },
    relation: last.relation,
    subject: plainSubject,
  };
  for (let i = lastIndex - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    const child = nodes[i + 1];
    if (!node || !child)
      throw new Error('sqlRelationMembershipWithWitness: inconsistent path reconstruction');
    current = {
      kind: 'usersetMembership',
      object: { ns: node.ns, id: node.id },
      relation: node.relation,
      userset: { ns: child.ns, id: child.id },
      usersetRelation: child.relation,
      member: current,
    };
  }
  return current;
}

function closureTupleFromRow(row: FrontierTupleRow): ClosureTuple {
  return row.subject_relation === null
    ? { kind: 'plain', subject: { ns: row.subject_ns, id: row.subject_id } }
    : {
        kind: 'userset',
        userset: { ns: row.subject_ns, id: row.subject_id },
        usersetRelation: row.subject_relation,
      };
}

function buildRelationDisproof(
  object: EntityRef,
  relation: string,
  maxDepth: number,
  frontier: ReadonlyMap<string, FrontierRow>,
  tuplesByFrontierKey: ReadonlyMap<string, FrontierTupleRow[]>,
): RelationDisproof {
  const nodes: ClosureNode[] = [...frontier.values()]
    .sort((a, b) => a.depth - b.depth)
    .map((row) => ({
      key: { ns: row.ns, id: row.id, relation: row.relation },
      depth: row.depth,
      ancestorPath: row.path.map(parseFrontierKeyString),
      tuples: (tuplesByFrontierKey.get(frontierKeyStr(row)) ?? []).map(closureTupleFromRow),
    }));
  return { kind: 'relationDisproof', object, relation, maxDepth, nodes };
}

/** Same shape as `ProductionOutcome`, plus the deepest frontier depth this specific call's own recursive CTE reached (0 if it never recursed at all). */
type SqlRelationOutcome =
  | { allowed: true; proof: ResolutionStep; depthReached: number }
  | { allowed: false; disproof: DisproofStep; depthReached: number };

/**
 * Answers "is `subject` a transitive member of the set granted by
 * `relation` on `object`?" — mechanism #2 from this file's own top-of-file
 * doc comment — and, unlike the boolean-only query it replaces, always
 * also reconstructs the full positive or negative witness (Phase 6, §6.7):
 * a `directGrant`/`usersetMembership` chain reconstructed from the winning
 * frontier row's own `path` when `allowed`, or a `RelationDisproof`
 * reachability certificate covering every node this call's own recursion
 * actually reached, when not. See this file's own top-of-file doc comment
 * for why the disproof is a flat certificate rather than a nested tree,
 * and `docs/DECISIONS.md` D-026 for the two independent cycle-safety
 * mechanisms this function still relies on unchanged (the SQL `path`-array
 * guard, and the `depth < maxDepth` backstop) — nothing about adding
 * witness reconstruction changes either guarantee, since both live inside
 * `fetchReachableFrontier`'s own recursive CTE, untouched.
 *
 * Takes `client` (this check's own `REPEATABLE READ`-pinned connection),
 * never `pool` — full-repo audit finding #1, `docs/DECISIONS.md` D-092.
 * The frontier fetch and the tuple-on-frontier fetch immediately below are
 * exactly the query *pair* that finding's own concrete counterexample
 * describes: without a shared snapshot between them, a userset edge the
 * first query observed could be deleted — and its target independently
 * (re)granted — before the second query runs, stitching a resolution path
 * together from two facts that never coexisted at any single real point in
 * the database's history. See `productionCheck`'s own doc comment for the
 * transaction this now runs inside.
 */
async function sqlRelationMembershipWithWitness(
  client: QueryExecutor,
  object: EntityRef,
  relation: string,
  subject: EntityRef,
  maxDepth: number,
): Promise<SqlRelationOutcome> {
  const frontierRows = await fetchReachableFrontier(client, object, relation, maxDepth);
  const frontier = dedupeFrontier(frontierRows);
  const depthReached = frontierRows.reduce((max, row) => Math.max(max, row.depth), 0);

  const tupleRows = await fetchTuplesOnFrontier(client, frontier);
  const tuplesByFrontierKey = groupTuplesByFrontierKey(tupleRows);

  const orderedFrontier = [...frontier.values()].sort((a, b) => a.depth - b.depth);
  for (const row of orderedFrontier) {
    const tuples = tuplesByFrontierKey.get(frontierKeyStr(row)) ?? [];
    const match = tuples.some(
      (t) =>
        t.subject_relation === null && t.subject_ns === subject.ns && t.subject_id === subject.id,
    );
    if (match) {
      return { allowed: true, proof: reconstructProof(row.path, subject), depthReached };
    }
  }

  return {
    allowed: false,
    disproof: buildRelationDisproof(object, relation, maxDepth, frontier, tuplesByFrontierKey),
    depthReached,
  };
}

/**
 * Re-verifies, as literally the first statement of the `REPEATABLE READ`
 * transaction `productionCheck` is about to run every other read of this
 * check inside, that *this transaction's own snapshot* has already
 * observed `token` — full-repo audit finding #1, `docs/DECISIONS.md`
 * D-092.
 *
 * Still **not** a call to `src/store/tokens.ts`'s `assertTokenObserved`
 * (also still not imported for that reason), but the *reason* has changed
 * since this function was first written — worth stating precisely rather
 * than leaving stale reasoning in place (`docs/DECISIONS.md` D-092's own
 * "Revisit if" flagged exactly this: "if `assertTokenObserved`... [is]
 * ever widened to a smaller structural type... `assertTokenObservedOnSnapshot`
 * ... should be deleted and replaced with a direct call"). That widening
 * happened in D0 (`src/store/tokens.ts`'s `assertTokenObserved` now takes
 * `QueryExecutor`, satisfied by both `Pool` and this function's own
 * `client` parameter) — so the original *structural* barrier is gone, and
 * `assertTokenObserved(client, atToken)` would type-check today. This
 * function is kept separate anyway, by deliberate choice now rather than
 * by type-system necessity: its own error message names *this check's own
 * transaction snapshot* specifically (see the thrown message below),
 * distinguishing a rare, expected-possible snapshot-anchoring race from
 * the pool-level pre-check `productionCheck` already ran moments earlier —
 * collapsing the two would silently lose that distinction for anyone
 * debugging why the second check failed when the first one just passed.
 * `productionCheck` still calls the real, unchanged `assertTokenObserved
 * (pool, atToken)` first — before ever opening this transaction — for its
 * already-tested malformed-token validation (`NaN`, negative, non-integer)
 * and its documented external error contract; by the time this function
 * runs, `token` is already known to be a valid non-negative integer, so
 * this only re-checks *observation*, against this connection's own
 * snapshot rather than trusting the earlier, different-connection check's
 * result to still describe whatever snapshot this transaction happens to
 * end up with.
 *
 * Why re-check at all, given `write_log` only ever grows and a single
 * Postgres instance with synchronous commits guarantees a later snapshot
 * sees everything an earlier one did: because a *fixed* snapshot's
 * guarantee is only as good as knowing precisely when it was taken, and
 * `REPEATABLE READ`'s snapshot is taken at this transaction's *first
 * query* (per Postgres's own documented semantics), not at `BEGIN` —
 * running this query first is what makes that anchor point provably no
 * earlier than "write_log has reached `token`," rather than relying on an
 * argument about connection-pool timing holding forever. This mirrors this
 * project's own established discipline for this exact class of property —
 * "a real, testable assertion rather than an assumption" — `docs/
 * CONSISTENCY.md`'s own words for `assertTokenObserved` itself.
 */
async function assertTokenObservedOnSnapshot(client: QueryExecutor, token: number): Promise<void> {
  const { rows } = await client.query<{ max_token: string | null }>(
    'select max(token) as max_token from write_log',
  );
  const raw = rows[0]?.max_token;
  const observed = raw === null || raw === undefined ? null : Number(raw);
  if (observed === null || token > observed) {
    throw new Error(
      `consistency token ${token} has not been observed by this check's own transaction ` +
        `snapshot (highest token visible to this snapshot: ${observed ?? 'none — no writes yet'})`,
    );
  }
}

/**
 * The production check engine's entry point. Fails closed
 * (`{ allowed: false }`, never a throw) for every legitimate "no" —
 * no published schema for `object.ns`, an undeclared relation/permission
 * name, zero tuples anywhere in the path, the depth budget exhausted, a
 * cycle. A genuinely unreachable/erroring database throws instead — the
 * opposite of a "no" answer, and deliberately distinguishable from one
 * (see build spec §7's exit-code table: infrastructure failure, exit 3,
 * is not the same outcome as a real denial, exit 0). This matches
 * `src/store/tuples.ts`'s own established pattern (an unreachable pool
 * makes `writeTuple`/reads throw, never silently return an empty/false
 * result) — nothing in this function or the ones it calls catches or
 * swallows a `pg` connection error; it propagates as-is.
 *
 * **One check, one transaction (full-repo audit finding #1,
 * `docs/DECISIONS.md` D-092).** Every `relation_tuples`/`write_log` read
 * this whole check performs — across however many `resolve`/`evalRewrite`
 * recursions and `sqlRelationMembershipWithWitness`/`listTupleSubjects`
 * calls a union/intersection/exclusion/tupleToUserset tree needs — runs on
 * one connection acquired here, inside one `REPEATABLE READ` transaction
 * opened here and committed (or rolled back) here. `REPEATABLE READ`, not
 * `SERIALIZABLE`: this transaction only ever reads, so it needs Postgres's
 * snapshot-isolation guarantee (one consistent point in time for every read
 * in it), not `SERIALIZABLE`'s additional write-conflict detection, which
 * would add serialization-failure retries this codebase has no retry logic
 * for, for no benefit a read-only transaction could ever collect on.
 *
 * **`getConfig`'s `namespace_configs` lookups now run on this same pinned
 * client too (`docs/DECISIONS.md`, the entry closing D-140's own "Revisit
 * if") — previously a disclosed, deliberate gap; now closed, for a reason
 * stronger than the residual snapshot-consistency argument that originally
 * justified leaving it open.** The original scoping reasoning still holds
 * as a description of what closing this gap additionally buys: `getConfig`
 * used to run on the plain `pool`, a second, independent connection outside
 * this transaction, and `WalkContext.schemaCache` already made the
 * dangerous case (the *same* namespace observed at two *different*
 * published versions within one check) structurally impossible even then
 * — what was left open was only the strictly weaker property that two
 * *different* namespaces touched by the same check could each be read as
 * of a very slightly different moment if a schema publish (rare,
 * admin-gated) landed mid-check. That's a real, if narrow, correctness
 * improvement this fix closes as a side effect, but it is not why this
 * changed.
 *
 * **The actual reason: needing a *second* pool connection per check was a
 * real, production-reachable connection-exhaustion deadlock, confirmed
 * live, not theoretical.** Under N concurrent `productionCheck` calls where
 * N is at or past the connection pool's own `max`, every connection gets
 * consumed by the N calls' own pinned `client` acquisitions before any of
 * them can obtain the *second* connection `getConfig` used to need —
 * mutual starvation, not contention that resolves once a connection frees
 * up (nothing releases until `getConfig` itself succeeds, and nothing lets
 * `getConfig` succeed). First disclosed as a byproduct of an unrelated test
 * (`docs/DECISIONS.md` D-140: 40 concurrent `productionCheck` calls
 * deadlocked for real against local Postgres, confirmed directly via
 * `pg_stat_activity`), then independently reproduced live a second time
 * (D-142: a deliberately shrunk connection pool hung outright under 10
 * concurrent checks, killed after a 2-minute timeout, not a flake). A
 * check now only ever needs exactly one connection, for its entire life,
 * no matter how many distinct namespaces the walk touches — the deadlock
 * is closed structurally, not merely made numerically less likely by
 * documenting or enforcing `MAX_CONCURRENCY < pool.max` (the alternative,
 * weaker fix D-140's own "Revisit if" also named).
 *
 * `src/audit/expand.ts`'s `expand()` had the identical `pool`/`client`
 * split for the identical reason, sharing this exact deadlock risk under
 * concurrent `/expand` traffic — fixed the same way, in the same change.
 */
export async function productionCheck(
  pool: ConnectionSource,
  subject: EntityRef,
  object: EntityRef,
  relationOrPermission: string,
  options?: ProductionCheckOptions,
): Promise<ProductionCheckResult> {
  const atToken = options?.atToken;
  if (atToken !== undefined) {
    // Cheap, well-tested rejection of an obviously malformed or
    // impossibly-high token before this call ever opens a connection for
    // the real check below — see assertTokenObservedOnSnapshot's own doc
    // comment for why this alone is not sufficient.
    await assertTokenObserved(pool, atToken);
  }

  const maxDepth = options?.maxDepth ?? env.CHECK_MAX_DEPTH;
  const depthReached = { value: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (atToken !== undefined) {
      await assertTokenObservedOnSnapshot(client, atToken);
    }
    const ctx: WalkContext = { client, maxDepth, schemaCache: new Map(), depthReached };
    const outcome = await resolve(ctx, subject, object, relationOrPermission, new Set(), 0);
    await client.query('COMMIT');
    return outcome.allowed
      ? { allowed: true, path: outcome.proof, depth: depthReached.value }
      : { allowed: false, depth: depthReached.value };
  } catch (err) {
    // The ROLLBACK call's own failure must never replace `err` — the exact
    // bug class found and fixed via DST crash-injection work in
    // src/store/tuples.ts, src/schema/publish.ts, and src/store/migrate.ts
    // (docs/DECISIONS.md D-097/D-098), missed here until the second
    // full-repo audit (D-106): a connection that died mid-check can't run
    // a ROLLBACK any more than it could run anything else, so a naive
    // `await client.query('ROLLBACK')` here would throw a second, different
    // error that silently masks the real one this catch block is already
    // propagating — an operator would see "connection terminated" instead
    // of whatever actually made the check fail, at exactly the moment the
    // real cause matters most.
    try {
      await client.query('ROLLBACK');
    } catch {
      // Swallowed deliberately — see comment above. Postgres releases the
      // connection (and anything it held) on its own once it's actually
      // gone; there is nothing left to clean up here that matters more
      // than `err` reaching the caller unchanged.
    }
    throw err;
  } finally {
    client.release();
  }
}
