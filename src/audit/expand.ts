/**
 * `expand()` — build spec §7's `authz expand <object> <relation>` and §9
 * Phase 6's exit criterion: "`expand()` returns the exact subject tree for
 * an object#relation, including tuple-to-userset members." Real production
 * code against real Postgres — the "no shared code" rule (§6.2) is
 * specifically about the two *check* resolvers never sharing a traversal
 * or rewrite-rule evaluator with each other (a shared bug would pass
 * Phase 5's differential fuzz harness identically and stop being
 * catchable); `expand()` answers a structurally different question ("who
 * is in this set," not "is this one subject in this set") and has no
 * oracle to stay independent *from* — it's fine, and in fact simplest, for
 * it to reuse the production resolver's own general SQL/traversal shape
 * (fetch real tuples, recurse per rewrite-rule node), even though nothing
 * is actually imported from `src/resolve/production/resolver.ts` (every
 * one of its helpers is module-private, so there's nothing to import
 * anyway — this file writes its own queries).
 *
 * The output mirrors the real rewrite-rule structure rather than
 * flattening to a list of ids: `union`/`intersection`/`exclusion`/
 * `tupleToUserset` nodes for a permission's own rewrite tree, and a
 * `relation` leaf (direct plain subjects plus every stored userset
 * reference, each of which recursively expands into its own subtree) for
 * wherever the tree bottoms out at an actual storable relation — exactly
 * §7's own wording, "the resolved subject tree," and the worked example
 * `user:alice -> group:eng#member -> folder:design#editor ->
 * document:readme#view` (§8) read the other direction: expanding
 * `document:readme#view` should surface `folder:design#editor` as a
 * userset member, which itself expands to reveal `group:eng#member`, which
 * itself expands to reveal `user:alice`.
 *
 * **Cycle safety (§6.4) applies here exactly as it does to a check walk.**
 * A userset tree can hit the same guaranteed-cyclic-group-nesting hazard a
 * check walk can (`group:a` nests `group:b` nests `group:a`) — expanding
 * `group:a#member` would recurse into expanding `group:b#member`, which
 * would recurse right back into expanding `group:a#member`, forever,
 * without a guard. `expandName` below carries the identical discipline
 * both resolvers already hold themselves to: a branch-local `visiting` set
 * (`(namespace, id, name)` triples, added on entry, removed via `finally`
 * right before returning — never a global "ever visited" set, so a
 * diamond-shaped DAG reached via two independent branches is never falsely
 * cut off) plus an independent `maxDepth` ceiling as a second backstop.
 * Both are verified to actually matter, not just present, by
 * `test/unit/audit/expand.integration.test.ts`'s own cyclic-termination
 * test — including the "temporarily remove the guard and confirm it
 * hangs" fail-check this project holds every termination claim to
 * (D-024/D-027/D-029).
 */
import { env } from '../config/env.js';
import type { NamespaceConfig, RewriteRule } from '../schema/dsl/types.js';
import { getLatestNamespaceConfig } from '../schema/publish.js';
import type { ConnectionSource, QueryExecutor } from '../store/query-executor.js';

/** An object or subject reference — `ns:id`. */
export interface EntityRef {
  ns: string;
  id: string;
}

export interface ExpandOptions {
  /** Overrides `env.CHECK_MAX_DEPTH` for this call only — the same independent backstop §6.4 requires of a check walk. */
  maxDepth?: number;
}

/** One stored userset-subject tuple (`object#relation@userset#usersetRelation`), expanded recursively. */
export interface UsersetMember {
  userset: EntityRef;
  relation: string;
  expansion: ExpandNode;
}

/** One tuple-to-userset hop (`object#relation` followed to `through`), with `computedUserset` expanded on `through`. */
export interface TupleToUsersetChild {
  through: EntityRef;
  expansion: ExpandNode;
}

/**
 * The subject-tree node shape. `relation` is the only leaf that actually
 * bottoms out in real tuples (a permission's rewrite tree always
 * eventually reaches one, possibly through several `computedUserset`
 * indirections — which have no node of their own, transparently expanding
 * to whatever the referenced name produces, exactly mirroring the
 * resolvers' own `computedUserset` handling). `cycleGuard`/
 * `depthLimitReached`/`undeclared` are the same three non-membership
 * outcomes both check resolvers already have a name for, surfaced here so
 * a caller rendering the tree can show *why* a branch stopped rather than
 * it silently looking like an empty, ordinary leaf.
 */
export type ExpandNode =
  | { kind: 'union'; object: EntityRef; children: ExpandNode[] }
  | { kind: 'intersection'; object: EntityRef; children: ExpandNode[] }
  | { kind: 'exclusion'; object: EntityRef; base: ExpandNode; subtract: ExpandNode }
  | {
      kind: 'tupleToUserset';
      object: EntityRef;
      relation: string;
      computedUserset: string;
      children: TupleToUsersetChild[];
    }
  | {
      kind: 'relation';
      object: EntityRef;
      relation: string;
      directSubjects: EntityRef[];
      usersets: UsersetMember[];
    }
  | { kind: 'cycleGuard'; object: EntityRef; name: string }
  | { kind: 'depthLimitReached'; object: EntityRef; name: string }
  | { kind: 'undeclared'; object: EntityRef; name: string };

/**
 * `schemaCache` mirrors `src/resolve/production/resolver.ts`'s own
 * identical-purpose field exactly — it exists purely to avoid re-querying
 * `namespace_configs` for a namespace this same `expand()` call has already
 * looked up (e.g. a `folder`'s `parent->view` revisiting `folder` itself at
 * every hop of a parent chain). Rebuilt fresh on every `expand()` call,
 * never shared or reused across calls, so it cannot become a
 * correctness-relevant cache (build spec §6.1). Added by full-repo audit
 * finding #5 (MEDIUM, 2026-08-16): this walk is deliberately sequential
 * (`mapSequential`, not `Promise.all` — see this file's own top-of-file
 * doc comment on why), so every extra round trip sits directly on the
 * critical path; before this fix, a 20-level nested `group:member` chain
 * issued 20 separate round trips to `namespace_configs` for the identical
 * namespace, where the production resolver's equivalent walk issues
 * exactly 1.
 *
 * `client` is the *only* connection this whole `expand()` call ever needs
 * — every read (`relation_tuples` via `fetchTuplesOn`, and, as of the
 * connection-exhaustion-deadlock fix below, `namespace_configs` via
 * `getConfig`) runs on this one pinned `REPEATABLE READ` client. A separate
 * `pool` field used to live here for `getConfig` alone, mirroring
 * `src/resolve/production/resolver.ts`'s own identical, now-closed gap —
 * see `getConfig`'s own doc comment immediately below for why that was a
 * real, production-reachable deadlock, not just a theoretical one.
 */
interface WalkContext {
  client: QueryExecutor;
  maxDepth: number;
  schemaCache: Map<string, NamespaceConfig | null>;
}

/**
 * Runs on `ctx.client`, this call's own pinned `REPEATABLE READ` connection
 * — the same connection every other read in this walk uses, not a second
 * one from the pool. This used to deliberately read through a separate
 * `ctx.pool` instead, mirroring `src/resolve/production/resolver.ts`'s own
 * identical, then-reasoned `getConfig` gap: the risk this connection's
 * `REPEATABLE READ` transaction closes for `relation_tuples` (two reads
 * observing *different* real moments in the database's history) was
 * already narrower for schema config than it looked, since
 * `WalkContext.schemaCache` (unchanged) already made the dangerous case —
 * the *same* namespace observed at two *different* published versions
 * within one call — structurally impossible even then.
 *
 * That old reasoning is no longer why this runs on `client` — it's a real,
 * production-reachable connection-exhaustion deadlock that makes a second
 * connection unsafe to need at all, not just a residual snapshot-
 * consistency nicety. Under N concurrent `expand()` (or `productionCheck`)
 * calls at or past the connection pool's own `max`, every connection gets
 * consumed by the N calls' own pinned `client` acquisitions before any of
 * them could obtain the second connection `getConfig` used to need — mutual
 * starvation, confirmed live against real Postgres, not theoretical (see
 * `src/resolve/production/resolver.ts`'s own doc comment, and
 * `docs/DECISIONS.md`, for the full history: first disclosed as a byproduct
 * of an unrelated test, D-140; independently reproduced live a second time,
 * D-142; closed here, in the same fix that closes `resolver.ts`'s identical
 * gap). One connection per `expand()` call, for its entire life, regardless
 * of how many distinct namespaces the walk touches, closes it structurally.
 */
async function getConfig(ctx: WalkContext, ns: string): Promise<NamespaceConfig | null> {
  const cached = ctx.schemaCache.get(ns);
  if (cached !== undefined) return cached;
  const config = await getLatestNamespaceConfig(ctx.client, ns);
  const resolved = config ?? null;
  ctx.schemaCache.set(ns, resolved);
  return resolved;
}

function nameKey(object: EntityRef, name: string): string {
  return `${object.ns}\0${object.id}\0${name}`;
}

/** Sequential, not `Promise.all` — required for the shared mutable `visiting` set below to stay correct (matches the production resolver's own established discipline; see this file's own top-of-file doc comment on why). */
async function mapSequential<T, U>(items: readonly T[], fn: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  for (const item of items) {
    results.push(await fn(item));
  }
  return results;
}

interface RelationTupleRow {
  subject_ns: string;
  subject_id: string;
  subject_relation: string | null;
}

/**
 * D-144 (expiring tuples): `and (expires_at is null or expires_at > now())`
 * excludes an expired tuple exactly as if it had already been deleted —
 * `expand()`'s own resolved subject tree must agree with `authz check`'s
 * own answer about which tuples are currently live, or the two would
 * silently disagree about a fact this project's whole audit-trail pitch
 * depends on being consistent (an expired grant still shown in `expand`'s
 * tree while `check` correctly denies it would be exactly that kind of
 * silent, undetected divergence). Real Postgres's `now()` is fixed at this
 * walk's own `REPEATABLE READ` transaction start (see this file's own
 * top-of-file doc comment on the transaction every read here runs inside),
 * matching `src/resolve/production/resolver.ts`'s identical reasoning.
 */
async function fetchTuplesOn(
  client: QueryExecutor,
  object: EntityRef,
  relation: string,
): Promise<RelationTupleRow[]> {
  const { rows } = await client.query<RelationTupleRow>(
    `select subject_ns, subject_id, subject_relation
     from relation_tuples
     where object_ns = $1 and object_id = $2 and relation = $3
       and (expires_at is null or expires_at > now())`,
    [object.ns, object.id, relation],
  );
  return rows;
}

/**
 * The one recursion unit every mechanism funnels through — "expand the
 * subject tree for `name` (a relation or a permission) on `object`" —
 * exactly mirroring `resolveMembership`/`resolve`'s role in the two check
 * resolvers, including the branch-local cycle guard and depth ceiling.
 */
async function expandName(
  ctx: WalkContext,
  object: EntityRef,
  name: string,
  visiting: Set<string>,
  depth: number,
): Promise<ExpandNode> {
  if (depth > ctx.maxDepth) {
    return { kind: 'depthLimitReached', object, name };
  }
  const key = nameKey(object, name);
  if (visiting.has(key)) {
    return { kind: 'cycleGuard', object, name };
  }
  visiting.add(key);
  try {
    const config = await getConfig(ctx, object.ns);
    if (!config) return { kind: 'undeclared', object, name };

    const relation = config.relations[name];
    if (relation) {
      return await expandRelation(ctx, object, name, visiting, depth);
    }
    const permission = config.permissions[name];
    if (permission) {
      return await expandRewrite(ctx, permission.rewrite, object, visiting, depth);
    }
    return { kind: 'undeclared', object, name };
  } finally {
    visiting.delete(key);
  }
}

/** Every real subject of `(object, relation)` — direct grants and userset references — the storable-relation leaf. */
async function expandRelation(
  ctx: WalkContext,
  object: EntityRef,
  relation: string,
  visiting: Set<string>,
  depth: number,
): Promise<ExpandNode> {
  const rows = await fetchTuplesOn(ctx.client, object, relation);
  const directSubjects: EntityRef[] = [];
  const usersetRows = rows.filter(
    (row): row is RelationTupleRow & { subject_relation: string } => row.subject_relation !== null,
  );
  for (const row of rows) {
    if (row.subject_relation === null) {
      directSubjects.push({ ns: row.subject_ns, id: row.subject_id });
    }
  }
  const usersets = await mapSequential(usersetRows, async (row) => {
    const userset: EntityRef = { ns: row.subject_ns, id: row.subject_id };
    const expansion = await expandName(ctx, userset, row.subject_relation, visiting, depth + 1);
    return { userset, relation: row.subject_relation, expansion };
  });
  return { kind: 'relation', object, relation, directSubjects, usersets };
}

/** Exhaustiveness guard — independently written, matching this project's own established per-module convention (see `docs/DECISIONS.md` D-022). */
function assertNeverRewriteRule(node: never): never {
  throw new Error(`expand: unhandled rewrite-rule kind ${JSON.stringify(node)}`);
}

async function expandRewrite(
  ctx: WalkContext,
  rule: RewriteRule,
  object: EntityRef,
  visiting: Set<string>,
  depth: number,
): Promise<ExpandNode> {
  switch (rule.kind) {
    case 'computedUserset':
      // Transparent delegation, exactly mirroring the resolvers' own
      // `computedUserset` handling — no node of its own; the returned
      // node IS whatever `rule.name` expands to.
      return expandName(ctx, object, rule.name, visiting, depth + 1);
    case 'union': {
      const children = await mapSequential(rule.children, (child) =>
        expandRewrite(ctx, child, object, visiting, depth),
      );
      return { kind: 'union', object, children };
    }
    case 'intersection': {
      const children = await mapSequential(rule.children, (child) =>
        expandRewrite(ctx, child, object, visiting, depth),
      );
      return { kind: 'intersection', object, children };
    }
    case 'exclusion': {
      const base = await expandRewrite(ctx, rule.base, object, visiting, depth);
      const subtract = await expandRewrite(ctx, rule.subtract, object, visiting, depth);
      return { kind: 'exclusion', object, base, subtract };
    }
    case 'tupleToUserset': {
      const rows = await fetchTuplesOn(ctx.client, object, rule.relation);
      const children = await mapSequential(rows, async (row) => {
        const through: EntityRef = { ns: row.subject_ns, id: row.subject_id };
        const expansion = await expandName(ctx, through, rule.computedUserset, visiting, depth + 1);
        return { through, expansion };
      });
      return {
        kind: 'tupleToUserset',
        object,
        relation: rule.relation,
        computedUserset: rule.computedUserset,
        children,
      };
    }
    default:
      return assertNeverRewriteRule(rule);
  }
}

/**
 * The one exported entry point. Returns the exact subject tree for
 * `relationOrPermission` on `object` — never throws for an ordinary "no
 * schema"/"no such relation" case (mirrors both check resolvers' own
 * fail-closed discipline: those surface as `{ kind: 'undeclared' }` nodes,
 * not exceptions); a genuinely unreachable database still throws, same as
 * `productionCheck`.
 *
 * **One walk, one snapshot (second full-repo audit, finding #3; D-107).**
 * Every `relation_tuples` read this walk issues now runs inside one
 * `REPEATABLE READ` transaction, pinned to one connection acquired once
 * here and released once at the bottom — exactly
 * `src/resolve/production/resolver.ts`'s own D-092 fix, applied to the
 * identical risk here: before this, every `fetchTuplesOn` call was its
 * own independent, autocommit `pool.query()`, so a concurrent write
 * landing between two of them (a deep tree issues dozens) could make the
 * returned subject tree show members that never coexisted at any single
 * real moment in the database's history — misleading for this project's
 * own documented use of `authz expand` as a pre-change access-review
 * gate. `pool: Pool` accepted here structurally satisfies
 * `ConnectionSource` (D0's non-breaking narrowing, `docs/DECISIONS.md`),
 * so no caller changes.
 */
export async function expand(
  pool: ConnectionSource,
  object: EntityRef,
  relationOrPermission: string,
  options: ExpandOptions = {},
): Promise<ExpandNode> {
  const maxDepth = options.maxDepth ?? env.CHECK_MAX_DEPTH;
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const ctx: WalkContext = { client, maxDepth, schemaCache: new Map() };
    const result = await expandName(ctx, object, relationOrPermission, new Set(), 0);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // The ROLLBACK call's own failure must never replace `err` — the same
    // bug class D-106 just fixed in resolver.ts's own identical catch
    // block; guarded here from the start rather than shipped unguarded
    // and found later.
    try {
      await client.query('ROLLBACK');
    } catch {
      // Swallowed deliberately — see comment above.
    }
    throw err;
  } finally {
    client.release();
  }
}
