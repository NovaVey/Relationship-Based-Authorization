/**
 * The production check engine — build spec `.claude/commands/build-authz-
 * service.md` §4/§6.3/§6.4, Phase 4. Backed by real Postgres via
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
 *     may itself nest further groups) is answered by `sqlRelationMembership`,
 *     a single `WITH RECURSIVE` query per relation-level check. The
 *     *target* relation name can change at every hop (a group's `member`
 *     relation might point at another group's `member` relation, or in
 *     principle at some other relation entirely), but the edge shape does
 *     not — "follow every userset-subject tuple on the current
 *     (namespace, id, relation) frontier" is schema-agnostic, which is
 *     exactly what makes it expressible as one recursive CTE instead of
 *     TypeScript-orchestrated recursion.
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
 * `TupleKey`.
 */
import type { Pool } from 'pg';

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
   * `assertTokenObserved(pool, atToken)` is called *first*, before any
   * schema lookup or graph walk — it throws if this database hasn't
   * observed that token yet, per its own documented contract. Once that
   * passes (or when no token is given at all) the walk below just reads
   * current committed Postgres state: on a single instance with
   * synchronous writes, ordinary transaction visibility already guarantees
   * a query started after a commit sees it (`src/store/tokens.ts`'s own
   * reasoning) — no extra snapshotting is built here.
   */
  atToken?: number;
  /**
   * Overrides `env.CHECK_MAX_DEPTH` for this call only. Threaded through
   * to *both* depth backstops this engine has: the TypeScript-level
   * combinator/tuple-to-userset walk (`resolve`) and the SQL-level
   * recursive CTE's own `depth` column cap (`sqlRelationMembership`) — see
   * this file's own doc comment on `sqlRelationMembership` for exactly how
   * those two independent ceilings compose. Tests use this to force a
   * budget the depth ceiling itself can't quietly absorb a missing cycle
   * guard into — the same discipline `docs/DECISIONS.md` D-024 records for
   * the reference resolver's own cyclic-case test.
   */
  maxDepth?: number;
}

export interface ProductionCheckResult {
  allowed: boolean;
}

/**
 * Per-check-call state threaded through the recursive walk. `schemaCache`
 * exists purely to avoid re-querying `namespace_configs` for a namespace
 * this same check has already looked up (e.g. `folder`'s `parent->view`
 * revisiting `folder` itself at every hop of a parent chain) — it is
 * rebuilt fresh on every `productionCheck` call, never shared or reused
 * across calls, so it cannot become a correctness-relevant cache (see
 * build spec §6.1: "there is no cached, precomputed ... permission
 * anywhere that isn't provably derivable from current tuples on demand").
 */
interface WalkContext {
  pool: Pool;
  maxDepth: number;
  schemaCache: Map<string, NamespaceConfig | null>;
}

async function getConfig(ctx: WalkContext, ns: string): Promise<NamespaceConfig | null> {
  const cached = ctx.schemaCache.get(ns);
  if (cached !== undefined) return cached;
  const config = await getLatestNamespaceConfig(ctx.pool, ns);
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
 *   off whole to `sqlRelationMembership`, which is self-contained and
 *   cycle-safe on its own (its own path-array-based cycle guard, its own
 *   depth cap). This function's own `visited`/`depth` bookkeeping still
 *   applies to the *entry* into that relation check, but the recursion
 *   inside the userset-subject graph never comes back through this
 *   function — it's a different (SQL-level) recursion entirely.
 */
async function resolve(
  ctx: WalkContext,
  subject: EntityRef,
  object: EntityRef,
  name: string,
  visited: Set<string>,
  depth: number,
): Promise<boolean> {
  if (depth >= ctx.maxDepth) return false;

  const key = entityNameKey(object, name);
  if (visited.has(key)) return false;
  visited.add(key);
  try {
    const config = await getConfig(ctx, object.ns);
    if (!config) return false;

    const relation = config.relations[name];
    if (relation) {
      return await sqlRelationMembership(ctx.pool, object, name, subject, ctx.maxDepth);
    }

    const permission = config.permissions[name];
    if (permission) {
      return await evalRewrite(ctx, permission.rewrite, subject, object, visited, depth + 1);
    }

    // Undeclared relation/permission name — fail closed, never throw.
    return false;
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
): Promise<boolean> {
  switch (rule.kind) {
    case 'computedUserset': {
      return resolve(ctx, subject, object, rule.name, visited, depth);
    }
    case 'union': {
      for (const child of rule.children) {
        if (await evalRewrite(ctx, child, subject, object, visited, depth)) return true;
      }
      return false;
    }
    case 'intersection': {
      for (const child of rule.children) {
        if (!(await evalRewrite(ctx, child, subject, object, visited, depth))) return false;
      }
      return true;
    }
    case 'exclusion': {
      const inBase = await evalRewrite(ctx, rule.base, subject, object, visited, depth);
      if (!inBase) return false;
      const inSubtract = await evalRewrite(ctx, rule.subtract, subject, object, visited, depth);
      return !inSubtract;
    }
    case 'tupleToUserset': {
      const subjects = await listTupleSubjects(ctx.pool, object, rule.relation);
      for (const newObject of subjects) {
        if (await resolve(ctx, subject, newObject, rule.computedUserset, visited, depth)) {
          return true;
        }
      }
      return false;
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
 */
async function listTupleSubjects(
  pool: Pool,
  object: EntityRef,
  relation: string,
): Promise<EntityRef[]> {
  const { rows } = await pool.query<TupleSubjectRow>(
    `select subject_ns, subject_id
     from relation_tuples
     where object_ns = $1 and object_id = $2 and relation = $3`,
    [object.ns, object.id, relation],
  );
  return rows.map((row) => ({ ns: row.subject_ns, id: row.subject_id }));
}

interface MembershipRow {
  allowed: boolean;
}

/**
 * Answers "is `subject` a transitive member of the set granted by
 * `relation` on `object`?" in one `WITH RECURSIVE` query — mechanism #2
 * from this file's own top-of-file doc comment, and the one place "hand-
 * written SQL including recursive CTEs" (`docs/DECISIONS.md` D-004) is
 * meant to actually show up.
 *
 * The graph being walked: start at the frontier node
 * `(object.ns, object.id, relation)`. Every `relation_tuples` row on that
 * exact `(object_ns, object_id, relation)` triple is either a **plain**
 * subject (`subject_relation IS NULL` — a terminal member) or a
 * **userset** subject (`subject_relation IS NOT NULL` — "members of
 * `subject_ns:subject_id#subject_relation` are members of this frontier
 * node too," which becomes a *new* frontier node to expand). `subject` is
 * a match the moment it appears as a plain subject on *any* frontier node
 * reached this way, including the starting node itself (a direct grant is
 * just the depth-0 case of the same query).
 *
 * **Cycle safety — read this as the answer to "how was this actually
 * verified," not just "how it's written":** Postgres's `WITH RECURSIVE`
 * does not terminate on its own against a cyclic graph (`group:a` nesting
 * `group:b` nesting `group:a` back) — it will keep re-deriving rows
 * forever, a real hung query, not a fast "no." Two independent guards,
 * both required, matching the build spec's own framing of this as "the
 * single most likely place for a real bug":
 *
 *  1. `path` — a `text[]` column carrying every frontier-node key
 *     (`ns:id#relation`) visited *on this specific recursive branch* so
 *     far, seeded with the starting node. The recursive term's `WHERE`
 *     clause excludes a row the instant its next-hop key is already
 *     `= ANY(path)`, so a branch can never revisit a node it's already
 *     mid-expanding — the standard "track the path, exclude on repeat"
 *     idiom, not `SEARCH ... CYCLE` (an equally valid alternative not
 *     used here, no functional difference for this query shape).
 *  2. `depth` — a plain integer counter, `< $6` (the caller's `maxDepth`)
 *     in the recursive term's own `WHERE` clause — an independent
 *     backstop for a genuinely deep-but-acyclic chain, same reasoning
 *     `resolve`'s own TypeScript-level depth counter applies one level up.
 *
 * This function was run against a real, seeded two-group cycle
 * (`group:a`↔`group:b`, see this phase's verification report) with a
 * real elapsed-time measurement before being trusted — not reasoned about
 * by inspection. See the Phase 4 report for the actual numbers.
 *
 * `maxDepth` here is the *same* top-level budget `productionCheck` was
 * given (`env.CHECK_MAX_DEPTH` by default), not `maxDepth` minus whatever
 * TypeScript-level depth has already been spent reaching this call — each
 * relation-level SQL call gets its own fresh `maxDepth`-sized budget for
 * *its own* userset-nesting depth. The composition is still a genuine,
 * finite bound on total work (both layers are bounded, so their product
 * is bounded), just not a single shared counter — see the Phase 4 report's
 * design-decision notes for why a shared counter was rejected (SQL can't
 * see the caller's TypeScript-side recursion state without smuggling it
 * through as another parameter, and the two recursions operate over
 * genuinely different graphs — tuple-to-userset object hops vs.
 * userset-subject relation hops — so bounding them independently is not a
 * looser guarantee, just a differently-shaped one).
 */
async function sqlRelationMembership(
  pool: Pool,
  object: EntityRef,
  relation: string,
  subject: EntityRef,
  maxDepth: number,
): Promise<boolean> {
  const { rows } = await pool.query<MembershipRow>(
    `with recursive membership(ns, id, relation, depth, path) as (
       select
         $1::text as ns,
         $2::text as id,
         $3::text as relation,
         0 as depth,
         array[$1::text || ':' || $2::text || '#' || $3::text] as path
       union all
       select
         rt.subject_ns,
         rt.subject_id,
         rt.subject_relation,
         m.depth + 1,
         m.path || (rt.subject_ns || ':' || rt.subject_id || '#' || rt.subject_relation)
       from relation_tuples rt
       join membership m
         on rt.object_ns = m.ns and rt.object_id = m.id and rt.relation = m.relation
       where rt.subject_relation is not null
         and m.depth < $6
         and not (
           (rt.subject_ns || ':' || rt.subject_id || '#' || rt.subject_relation) = any (m.path)
         )
     )
     select exists (
       select 1
       from membership m
       join relation_tuples rt
         on rt.object_ns = m.ns and rt.object_id = m.id and rt.relation = m.relation
       where rt.subject_relation is null
         and rt.subject_ns = $4
         and rt.subject_id = $5
     ) as allowed`,
    [object.ns, object.id, relation, subject.ns, subject.id, maxDepth],
  );
  return rows[0]?.allowed ?? false;
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
 */
export async function productionCheck(
  pool: Pool,
  subject: EntityRef,
  object: EntityRef,
  relationOrPermission: string,
  options?: ProductionCheckOptions,
): Promise<ProductionCheckResult> {
  const atToken = options?.atToken;
  if (atToken !== undefined) {
    await assertTokenObserved(pool, atToken);
  }

  const maxDepth = options?.maxDepth ?? env.CHECK_MAX_DEPTH;
  const ctx: WalkContext = { pool, maxDepth, schemaCache: new Map() };
  const allowed = await resolve(ctx, subject, object, relationOrPermission, new Set(), 0);
  return { allowed };
}
