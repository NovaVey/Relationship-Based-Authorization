/**
 * The Leopard index (Phase A) — `docs/LEOPARD-INDEX-PROPOSAL.md`. An
 * offline-computed, periodically-refreshed flattening of "every subject
 * transitively reachable via a userset-subject tuple chain from
 * `(object, relation)`," consulted as a fast, ALLOW-only path ahead of
 * `sqlRelationMembershipWithWitness`'s own recursive `WITH RECURSIVE` walk
 * (`src/resolve/production/resolver.ts` — "mechanism 2"). Sibling to
 * `tuples.ts`/`tokens.ts`, same conventions: hand-written SQL, `pg` bigint
 * columns coerced with `Number(...)` immediately at the read (never left as
 * the raw string `pg` hands back — see `tokens.ts`'s own doc comment for the
 * bug this coercion discipline exists to prevent).
 *
 * **This file never imports from `src/resolve/production/resolver.ts`, and
 * `resolver.ts` imports only `lookupRelationMembershipIndex` from here.**
 * `EntityRef` below is a field-for-field independent redeclaration of
 * `resolver.ts`'s own `EntityRef` shape — never an import of it — the same
 * precedent `docs/DECISIONS.md` D-022 already sets for
 * `src/store/tuples.ts`'s `TupleKey`. Importing `resolver.ts`'s type here
 * would create a `store/` → `resolve/` dependency running backwards against
 * every other dependency in this codebase (`resolve/` already depends on
 * `store/`, never the reverse) and would risk a circular import the moment
 * `resolver.ts` imports this file's own `lookupRelationMembershipIndex` —
 * TypeScript structural typing means a real `resolver.ts` `EntityRef` value
 * satisfies this file's own identically-shaped type with zero friction, so
 * nothing is lost by declaring it independently.
 *
 * **This file shares no traversal/rewrite-evaluation code with
 * `src/resolve/reference/resolver.ts` either** — the project's absolute,
 * load-bearing isolation rule between the two resolvers (build spec §6.2,
 * `docs/DECISIONS.md` D-022) is not touched by this file at all: this is a
 * *production*-side acceleration structure, consulted only from
 * `src/resolve/production/resolver.ts`, and the reference resolver is never
 * aware this file exists.
 */
import type { ConnectionSource, QueryExecutor } from './query-executor.js';

/**
 * An object or subject reference — `ns:id`. Field-for-field identical to,
 * and deliberately independent of, `src/resolve/production/resolver.ts`'s
 * own `EntityRef` — see this file's own top-of-file doc comment for why.
 */
export interface EntityRef {
  ns: string;
  id: string;
}

/**
 * Transaction-scoped advisory lock guarding `rebuildRelationMembershipIndex`
 * against two concurrent refreshes (a `serve.ts` in-process interval timer
 * racing an operator's own `authz leopard refresh`, or two operators running
 * `refresh` at once) — see `docs/LEOPARD-INDEX-PROPOSAL.md`'s own
 * "Operational surface" section.
 *
 * A fresh classid, distinct from every other advisory-lock user in this
 * codebase: `WRITE_LOG_LOCK_CLASSID` (`'wlog'`, `src/store/tuples.ts`),
 * `MIGRATIONS_LOCK_CLASSID` (`'migr'`, `src/store/migrate.ts`),
 * `CHECKS_HASH_CHAIN_LOCK_CLASSID` (`'hchn'`, `src/audit/checks.ts`), and
 * `src/schema/publish.ts`'s own `hashtext($1)`-keyed lock (a different
 * keyspace entirely — the single-bigint form, never colliding with the
 * two-int-key form the first three plus this one use, per Postgres's own
 * documented advisory-lock semantics). `classid` is the ASCII bytes of the
 * literal string `lprd` (`0x6c 70 72 64` = `0x6c707264`) — arbitrary but
 * fixed, greppable, human-legible, matching the exact `'wlog'`/`'migr'`/
 * `'hchn'` ASCII-tag convention those three constants already establish.
 * `objid` is a fixed `0`: like `WRITE_LOG_LOCK_CLASSID`, this lock
 * serializes exactly one thing globally (every refresh of the single,
 * global `relation_membership_index`), with no second dimension to key by.
 *
 * **Genuinely new in this codebase: the `_try_` form, not the blocking
 * form.** Every existing advisory lock above uses the blocking
 * `pg_advisory_xact_lock`, which waits until the lock is free. This lock
 * uses `pg_try_advisory_xact_lock` instead — it returns a boolean
 * immediately, succeeding or failing without ever waiting — because a
 * refresh that's already running should make a second, concurrent refresh
 * invocation report "skipped, already running" and return immediately, not
 * block for however long the first refresh takes (see
 * `rebuildRelationMembershipIndex`'s own doc comment). `grep -rn
 * "pg_try_advisory" src/` returned nothing before this file existed —
 * `docs/LEOPARD-INDEX-PROPOSAL.md`'s own "Operational surface" section
 * discloses this as a real, new pattern being introduced, not an existing
 * one being reused.
 *
 * Transaction-scoped (`_xact_`, not the session-scoped `pg_advisory_lock`):
 * released automatically by Postgres at this transaction's own `COMMIT`,
 * `ROLLBACK`, or the holding connection simply dying for any reason (process
 * kill, OOM) — a crashed refresh never leaves an orphaned lock for a future
 * `refresh` invocation to hang on.
 */
export const RELATION_INDEX_REFRESH_LOCK_CLASSID = 0x6c707264; // ASCII 'lprd' — see doc comment above.
export const RELATION_INDEX_REFRESH_LOCK_OBJID = 0;

/**
 * A new, separately-defined query text sharing only the anchoring
 * *discipline* with `resolver.ts`'s `assertTokenObservedOnSnapshot` — not
 * its literal SQL text. **Corrected here, not the same as first drafted**
 * (`docs/LEOPARD-INDEX-PROPOSAL.md`, "The rebuild," step 1): the real
 * `ANCHOR_QUERY_TEXT` constant (`resolver.ts`) is
 * `'select max(token) as max_token from write_log'` — a different string
 * (no `coalesce`, a different column alias) — and it is a module-private
 * `const`, never `export`ed, so it cannot be imported here without widening
 * `resolver.ts`'s own export surface, an undisclosed change the proposal's
 * "`sqlRelationMembershipWithWitness` is never modified — not one line"
 * framing does not cover. This file takes the proposal's own first honest
 * choice — a separate query, `coalesce`d against an empty `write_log`
 * explicitly rather than importing and handling a `null` — accepting the
 * small, deliberate duplication rather than widening that export surface.
 */
const REBUILD_WATERMARK_QUERY_TEXT = 'select coalesce(max(token), 0) as watermark from write_log';

/**
 * Rebuilds the entire `relation_membership_index` from scratch, inside one
 * `BEGIN ISOLATION LEVEL REPEATABLE READ` transaction on its own dedicated
 * connection, held for the whole rebuild's life — **not** `READ ONLY` (the
 * distinction `productionCheck`'s own `BEGIN ISOLATION LEVEL REPEATABLE
 * READ READ ONLY` makes, for the opposite reason): this transaction writes
 * its own output. See `docs/LEOPARD-INDEX-PROPOSAL.md`'s own "The rebuild"
 * section for the full reasoning; this doc comment states only what this
 * implementation actually does, in order.
 *
 * 0. Guarded by `RELATION_INDEX_REFRESH_LOCK_CLASSID`/`_OBJID` via
 *    `pg_try_advisory_xact_lock` — never blocks. If a refresh is already in
 *    flight (the lock is held by another session), this returns immediately
 *    with `{ watermarkToken: 0, rowCount: 0, published: false }` and does no
 *    other work at all — not even the watermark read below. **Judgment
 *    call, not specified by the proposal:** the proposal's own numbered
 *    step list ("The rebuild," steps 1-6) never says where the lock
 *    acquisition sits relative to "the first statement" it names (the
 *    watermark read); this implementation places the lock check first,
 *    before any other work, because "do no work" (this function's own
 *    contract, and the CLI's documented "skipped — a refresh is already
 *    running" no-op) reads most naturally as including the watermark read
 *    too, not just the expensive recursive closure.
 * 1. Reads the watermark: `REBUILD_WATERMARK_QUERY_TEXT` — see that
 *    constant's own doc comment for why this is a deliberately separate
 *    query text, never an import of `resolver.ts`'s private
 *    `ANCHOR_QUERY_TEXT`.
 * 2. `TRUNCATE relation_membership_index`.
 * 3. One recursive CTE, batched over every `(object_ns, object_id,
 *    relation)` that appears anywhere in `relation_tuples` as a root
 *    (`roots`), computing the full transitive userset-subject closure
 *    (`membership`) with the identical cycle guard
 *    (`not (edge = any(path))`) and identical live-expiry filter
 *    (`rt.expires_at is null or rt.expires_at > now()`)
 *    `fetchReachableFrontier` (`resolver.ts`) uses, generalized from a
 *    per-iteration `distinct on (reached identity)` dedup to a per-iteration
 *    `distinct on (root, reached identity)` dedup — the same D-092 fix,
 *    applied per-root. **No depth ceiling**, deliberately (see the
 *    proposal's own "No depth ceiling on this recursion" section) — Phase
 *    A is ALLOW-only, so an under-populated root from any cause, including
 *    a depth cap, can only produce a safe `{hit:false}` miss downstream,
 *    never a false hit (Candidate D). `membership` also threads a running
 *    `min_expires_at` (the minimum non-null `expires_at` of every edge
 *    tuple on the path so far, via `least(...)`, which Postgres defines to
 *    ignore `NULL` operands and return `NULL` only when every operand is
 *    `NULL`) — **a judgment call the proposal's own prose leaves implicit**:
 *    the proposal states the schema's own `min_expires_at` column comment
 *    ("null iff no tuple on `via_path` carries `expires_at`") but never
 *    spells out the recursive-CTE arithmetic that has to produce that value
 *    across an arbitrarily long path; threading a running `least(...)`
 *    through the recursion, combined with the terminal plain-grant tuple's
 *    own `expires_at` in `candidate_rows` below, is the direct, literal
 *    reading of that column comment.
 * 4. For every closure row whose reached `(ns, id, relation)` carries a
 *    real plain tuple (`subject_relation is null`), a candidate `(root,
 *    subject)` row is produced (`candidate_rows`) with `via_path` set to
 *    exactly the closure row's own `path`, unmodified — **never** the
 *    root's path with a "leaf hop" appended (the proposal's own disclosed,
 *    corrected first-draft bug: `reconstructProof(path, subject)` takes the
 *    subject as a wholly separate argument and never encodes it into the
 *    path array; an appended leaf hop would throw inside
 *    `parseFrontierKeyString`'s strict format check or silently produce a
 *    structurally wrong proof tree).
 * 5. The corrected `INSERT ... SELECT DISTINCT ON (...) ... ORDER BY ...
 *    array_length(via_path, 1) asc` — verbatim shape from the proposal's own
 *    corrected SQL block — resolves primary-key collisions from converging
 *    paths (two different frontier nodes under the same root both granting
 *    the identical subject) by keeping the *shortest* real candidate
 *    deterministically, with `via_path` and `min_expires_at` bound
 *    atomically to that one winning row. Deliberately **not** a `GROUP BY`
 *    with independently-aggregated `via_path`/`min_expires_at` — see the
 *    proposal's own reasoning for why that would silently decouple a stored
 *    path from the expiry that's supposed to gate it.
 * 0.5. `UPDATE relation_membership_index_state SET rebuild_started_at =
 *    clock_timestamp() where id = 1`, immediately after the lock is
 *    acquired and before any other work. **A second gap found and fixed
 *    while implementing, beyond the proposal's own disclosed ones:** the
 *    proposal's own step 5 never mentions `rebuild_started_at` at all,
 *    even though migration 0010's schema declares the column — an
 *    undisclosed gap in the proposal's own schema/procedure pairing,
 *    closed here rather than left as a column that silently stays `NULL`
 *    forever. Deliberately `clock_timestamp()`, not `now()` — see the
 *    next note for why.
 * 6. `UPDATE relation_membership_index_state SET watermark_token = <step 1's
 *    value>, rebuild_finished_at = clock_timestamp(), row_count = <the
 *    INSERT's own row count> where id = 1`. **A third, more subtle gap
 *    found and fixed while implementing: `now()` would have been wrong
 *    here, not merely a style choice.** Postgres freezes `now()` (and
 *    `current_timestamp`/`transaction_timestamp()`) to this transaction's
 *    own *start* instant — confirmed live via a `pg_sleep(2)` bracketed by
 *    two `now()` reads inside one transaction, both identical down to the
 *    microsecond, while `clock_timestamp()` correctly advanced by the
 *    real ~2 seconds. A rebuild transaction can run for the "seconds to
 *    minutes" the proposal's own WAL/vacuum-bloat-risk section already
 *    describes, so stamping `rebuild_finished_at = now()` would silently
 *    record *when this attempt began*, not when it actually finished —
 *    `authz leopard status`'s staleness figure would over-report by
 *    exactly the rebuild's own duration. Never a soundness concern (no
 *    check ever reads this column; only `watermark_token`, compared
 *    against a real `atToken`, gates any ALLOW), but a real, previously-
 *    undisclosed correctness bug in this purely-operational metadata,
 *    fixed here. Note the asymmetry with the recursive closure above,
 *    which correctly keeps plain `now()` for its own `expires_at > now()`
 *    filter — that usage *wants* one instant frozen for the whole
 *    transaction (this project's own established "one `now()` per
 *    transaction" expiry-consistency discipline, `docs/CONSISTENCY.md`);
 *    only these two purely-informational timestamps want the real,
 *    unfrozen wall-clock moment instead.
 *
 * Because both `rebuild_started_at` and `rebuild_finished_at` are written
 * inside the same transaction that also does all the real work, an
 * external reader can never observe one without the other — both become
 * visible to any other session at the identical instant, this rebuild's
 * own `COMMIT`. This column pair is therefore a **completed-rebuild
 * duration metric** (`rebuild_finished_at - rebuild_started_at`, read
 * only after the fact), not a live "a rebuild is currently in progress"
 * signal — detecting an in-flight rebuild would need a different
 * mechanism entirely (e.g. attempting the same advisory lock from a
 * separate session), out of scope here and not claimed.
 * 7. `COMMIT` — or, when `opts.dryRun` is `true`, `ROLLBACK` instead,
 *    leaving the previous, still-valid watermark and rows completely
 *    untouched (matching `authz soundness run --dry-run`'s own "prove the
 *    claim, leave no trace" contract). `published` reports whether this
 *    call's own computation is now durably visible to any other reader:
 *    `true` only on a real `COMMIT`, `false` on `dryRun` and on the
 *    lock-not-acquired early return alike — **a judgment call**: the
 *    proposal names `published: false` explicitly only for the
 *    lock-contention case; extending the same meaning ("not now visible to
 *    a reader") to the dry-run case is the literal reading of `published`
 *    as a field name, not a restatement of `dryRun` itself.
 *
 * `lockAcquired` (a fourth field, not named anywhere in the proposal)
 * disambiguates *why* `published` is `false`: `lockAcquired: false` means
 * this call did no work at all because a concurrent refresh was already
 * running; `lockAcquired: true` (with `published: false`) means this call
 * did the real work but chose not to commit it, purely because
 * `opts.dryRun` was set. Without this field, a caller cannot tell "skipped
 * — already running" apart from "ran a dry run against a genuinely empty
 * database" — both would otherwise report the identical
 * `{watermarkToken:0, rowCount:0, published:false}` triple. This is a real
 * ambiguity the CLI phase surfaced when it tried to render the exact
 * "skipped — a refresh is already running" message the proposal's own
 * "Operational surface" section specifies; closed here with a dedicated
 * signal rather than left as a heuristic the CLI would otherwise have to
 * guess at.
 */
export async function rebuildRelationMembershipIndex(
  pool: ConnectionSource,
  opts?: { dryRun?: boolean },
): Promise<{
  watermarkToken: number;
  rowCount: number;
  published: boolean;
  lockAcquired: boolean;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');

    const { rows: lockRows } = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_xact_lock($1, $2) as locked',
      [RELATION_INDEX_REFRESH_LOCK_CLASSID, RELATION_INDEX_REFRESH_LOCK_OBJID],
    );
    if (lockRows[0]?.locked !== true) {
      // A refresh is already in flight elsewhere — never block waiting for
      // it (pg_try_advisory_xact_lock never blocks by design). Do no other
      // work at all.
      await client.query('ROLLBACK');
      return { watermarkToken: 0, rowCount: 0, published: false, lockAcquired: false };
    }

    // clock_timestamp(), not now() — see this function's own doc comment
    // (step 0.5) for why now() would silently record this transaction's
    // start instant instead of the real moment work began.
    await client.query(
      'update relation_membership_index_state set rebuild_started_at = clock_timestamp() where id = 1',
    );

    const { rows: watermarkRows } = await client.query<{ watermark: string }>(
      REBUILD_WATERMARK_QUERY_TEXT,
    );
    const watermarkToken = Number(watermarkRows[0]?.watermark ?? 0);

    await client.query('truncate relation_membership_index');

    // Steps 3-5 of this function's own doc comment: the recursive closure,
    // the per-(root, subject) candidate rows, and the corrected
    // DISTINCT-ON-shortest-path INSERT, all in one statement — a `WITH
    // RECURSIVE ... INSERT INTO ... SELECT ...` is valid Postgres (the
    // `WITH` clause can precede an INSERT exactly as it can a SELECT).
    const insertResult = await client.query(
      `with recursive roots(root_ns, root_id, root_relation) as (
         select distinct object_ns, object_id, relation from relation_tuples
       ),
       membership(root_ns, root_id, root_relation, ns, id, relation, depth, path, min_expires_at) as (
         select
           r.root_ns, r.root_id, r.root_relation,
           r.root_ns, r.root_id, r.root_relation,
           0 as depth,
           array[r.root_ns || ':' || r.root_id || '#' || r.root_relation] as path,
           null::timestamptz as min_expires_at
         from roots r
         union all
         select distinct on (m.root_ns, m.root_id, m.root_relation, rt.subject_ns, rt.subject_id, rt.subject_relation)
           m.root_ns, m.root_id, m.root_relation,
           rt.subject_ns, rt.subject_id, rt.subject_relation,
           m.depth + 1,
           m.path || (rt.subject_ns || ':' || rt.subject_id || '#' || rt.subject_relation),
           least(m.min_expires_at, rt.expires_at)
         from relation_tuples rt
         join membership m
           on rt.object_ns = m.ns and rt.object_id = m.id and rt.relation = m.relation
         where rt.subject_relation is not null
           and (rt.expires_at is null or rt.expires_at > now())
           and not (
             (rt.subject_ns || ':' || rt.subject_id || '#' || rt.subject_relation) = any (m.path)
           )
       ),
       candidate_rows as (
         select
           m.root_ns, m.root_id, m.root_relation,
           rt.subject_ns, rt.subject_id,
           m.path as via_path,
           least(m.min_expires_at, rt.expires_at) as min_expires_at
         from membership m
         join relation_tuples rt
           on rt.object_ns = m.ns and rt.object_id = m.id and rt.relation = m.relation
         where rt.subject_relation is null
           and (rt.expires_at is null or rt.expires_at > now())
       )
       insert into relation_membership_index (object_ns, object_id, relation, subject_ns, subject_id, via_path, min_expires_at)
       select distinct on (root_ns, root_id, root_relation, subject_ns, subject_id)
         root_ns, root_id, root_relation, subject_ns, subject_id, via_path, min_expires_at
       from candidate_rows
       order by root_ns, root_id, root_relation, subject_ns, subject_id, array_length(via_path, 1) asc`,
    );
    const rowCount = insertResult.rowCount ?? 0;

    await client.query(
      `update relation_membership_index_state
       set watermark_token = $1, rebuild_finished_at = clock_timestamp(), row_count = $2
       where id = 1`,
      [watermarkToken, rowCount],
    );

    if (opts?.dryRun) {
      await client.query('ROLLBACK');
      return { watermarkToken, rowCount, published: false, lockAcquired: true };
    }
    await client.query('COMMIT');
    return { watermarkToken, rowCount, published: true, lockAcquired: true };
  } catch (err) {
    // The ROLLBACK call's own failure must never replace `err` — the same
    // "cleanup's own outcome must never overwrite the thing that actually
    // matters" discipline `src/store/tuples.ts`'s `writeTuple`/`deleteTuple`
    // and `src/store/migrate.ts`'s `runMigrations` already apply to their
    // own cleanup paths.
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

/** A proven, real, offline-computed positive witness — straight into `reconstructProof`, unmodified. See `docs/LEOPARD-INDEX-PROPOSAL.md`'s own "The lookup" section. */
export interface RelationIndexHit {
  hit: true;
  allowed: true;
  certain: true;
  /** `via_path` — same `ns:id#relation`-string-array shape `FrontierRow.path` uses. */
  path: string[];
  /** `min_expires_at` was non-null (and still live, per this function's own SQL — see the doc comment below). */
  touchedExpiringTuple: boolean;
}

/** A miss, for any reason at all — staleness, no matching row, or a stored path longer than the caller's own `maxDepth` — always falls through to the unmodified, byte-identical `sqlRelationMembershipWithWitness`. */
export type RelationIndexLookup = RelationIndexHit | { hit: false };

/**
 * The index-served fast path for one relation-membership check — exactly
 * `docs/LEOPARD-INDEX-PROPOSAL.md`'s own "The lookup" corrected code block.
 * Takes `client` (the caller's existing `ctx.client`, a `QueryExecutor`) —
 * **never** a second pool connection; this function opens nothing of its
 * own.
 *
 * Two point lookups, both gated by freshness/coverage before ever being
 * trusted:
 *
 * 1. `relation_membership_index_state.watermark_token` must be `>=
 *    requiredFloorToken` (the caller's own pinned `atToken`, threaded via
 *    `ctx.relationIndexFloor`) — otherwise `{hit:false}`, unconditionally.
 *    A never-built index (`watermark_token` still at its `0` default) fails
 *    this the same way any other real staleness does, by construction, with
 *    no special-cased empty-index branch needed.
 * 2. The matching `relation_membership_index` row (if any) must satisfy
 *    `min_expires_at is null or min_expires_at > now()` **as one single
 *    predicate in the same query that reads the row** — this is the fix for
 *    the most severe bug the proposal's own adversarial review found in an
 *    earlier draft of this exact function: hardcoding
 *    `touchedExpiringTuple: false` regardless of `min_expires_at` would
 *    quietly defeat `src/audit/checks.ts`'s own `performCheck` cache-safety
 *    gate (`docs/CONSISTENCY.md`'s D-144 discipline), letting an
 *    index-served ALLOW whose only real path passed through a still-live-
 *    but-expiring tuple be wrongly cached past that tuple's real expiry.
 *    `row.min_expires_at !== null` below is sound only *because* the row
 *    already survived that liveness predicate in this same query, reading
 *    the same instant of Postgres's own transaction-pinned `now()` — never
 *    split into two separate queries that could observe two different
 *    instants.
 *
 * Then the depth-coverage gate (Candidate F): a stored `via_path` longer
 * than the caller's own `maxDepth` silently overriding that caller's
 * explicit, narrower budget would be a new, independent unsoundness axis
 * (perfectly fresh, perfectly correct-as-of-now, and still a false grant
 * relative to what the caller actually asked for) — `row.via_path.length -
 * 1 > maxDepth` (path length minus one hop-count, since a path of N nodes
 * is N-1 hops) falls back rather than ever asserting a length-mismatch
 * DENY, since the stored path is real but not necessarily the *shortest*
 * real one the live CTE might still find within budget.
 */
export async function lookupRelationMembershipIndex(
  client: QueryExecutor,
  object: EntityRef,
  relation: string,
  subject: EntityRef,
  maxDepth: number,
  requiredFloorToken: number,
): Promise<RelationIndexLookup> {
  const { rows: state } = await client.query<{ watermark_token: string }>(
    `select watermark_token from relation_membership_index_state where id = 1`,
  );
  if (Number(state[0]?.watermark_token ?? 0) < requiredFloorToken) return { hit: false };

  const { rows } = await client.query<{ via_path: string[]; min_expires_at: Date | null }>(
    `select via_path, min_expires_at from relation_membership_index
      where object_ns = $1 and object_id = $2 and relation = $3
        and subject_ns = $4 and subject_id = $5
        and (min_expires_at is null or min_expires_at > now())`,
    [object.ns, object.id, relation, subject.ns, subject.id],
  );
  const row = rows[0];
  if (!row) return { hit: false };
  if (row.via_path.length - 1 > maxDepth) return { hit: false }; // the CALLER's own depth budget
  return {
    hit: true,
    allowed: true,
    certain: true,
    path: row.via_path,
    touchedExpiringTuple: row.min_expires_at !== null,
  };
}
