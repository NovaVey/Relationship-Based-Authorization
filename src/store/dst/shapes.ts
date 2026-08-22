/**
 * The trivial, exact-match SQL-shape executor DST's fake store uses for
 * D0's SQL surface — `src/store/tuples.ts`, `src/store/tokens.ts`, and the
 * one `src/schema/publish.ts` read (`getLatestNamespaceConfig`) `writeTuple`
 * depends on. `docs/DST-PROPOSAL.md`'s own design: exact-string lookup,
 * never parsing or regex, throwing loudly on anything unrecognized rather
 * than silently returning an empty result (the proposal's own §"Two grafts"
 * — the permanent, written rule: misrecognition is strictly worse than
 * non-recognition, so this executor is exact-match-only, forever).
 *
 * A shape handler never mutates `state.relationTuples`/`writeLog`/
 * `namespaceConfigs` directly for a write — writes are always applied via
 * `bufferOp`, a closure `connection.ts`'s `COMMIT` handling invokes for
 * every pending op in a transaction, atomically, all at once. The one
 * deliberate exception is identity-value allocation
 * (`state.nextRelationTupleId`/`nextToken`) — see `state.ts`'s own doc
 * comment on those two counters for why allocation happens the moment a
 * handler runs, not deferred to commit.
 *
 * **Row-shape fidelity.** `relation_tuples.id` and `write_log.token` are
 * real Postgres `bigint` columns; `pg` returns a `bigint` to JavaScript as
 * a `string`, never auto-coerced — see `src/store/tokens.ts`'s own doc
 * comment for the real, previously-shipped bug this caused before every
 * bigint-column read in this codebase was audited and explicitly wrapped
 * in `Number(...)`. Every handler below that returns one of these columns
 * returns it as a `string`, matching real `pg` exactly — returning a
 * `number` here would silently stop exercising those `Number(...)` call
 * sites through this fake at all, understating what this store proves.
 *
 * **Known, disclosed D0 scope limit — closed by D2.** These read handlers
 * originally answered against `state`'s own currently-committed rows only,
 * with no way to express "as of an earlier, frozen point in time." D2
 * (`docs/DECISIONS.md` D-099) closes this: every read handler below now
 * takes `ctx.visibleAsOf` — `undefined` means "see everything currently
 * committed" (ordinary autocommit/`READ COMMITTED`-shaped reads, D0/D1's
 * own unchanged behavior), a real number means "only rows committed at or
 * before this `commitSeq`" (a `REPEATABLE READ` snapshot, anchored by
 * `connection.ts` at the snapshot transaction's *first* real query — see
 * that file's own doc comment). Nothing in D0/D1's own call surface ever
 * sets `visibleAsOf`, so this is purely additive: every existing handler's
 * behavior for an ordinary connection is unchanged, confirmed by D0/D1's
 * own test suites staying green untouched.
 *
 * **Read-your-own-uncommitted-writes remains out of scope, deliberately —
 * not the same gap as above.** A snapshot transaction is read-only by
 * construction (`connection.ts` throws if a write is ever attempted on
 * one), so "does a snapshot see its own not-yet-committed write" is not a
 * question that can even arise for `productionCheck`'s own use of this
 * mechanism. `writeTuple`/`deleteTuple`'s plain `BEGIN`-opened
 * write-buffering transactions still never read `relation_tuples` back
 * within their own transaction either, so this remains genuinely
 * unexercised by every real call site today, same as D0's own note said.
 */
import type { TupleKey } from '../tuples.js';
import type { FakeStoreState, RelationTupleRow } from './state.js';

export interface FakeQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

/** Applied atomically at COMMIT (or discarded on ROLLBACK/crash) — see this file's own top-of-file doc comment. */
export type PendingOp = (state: FakeStoreState, commitSeq: number) => void;

export interface ShapeContext {
  state: FakeStoreState;
  params: readonly unknown[];
  bufferOp: (op: PendingOp) => void;
  /** D2 (`docs/DECISIONS.md` D-099) — see this file's own top-of-file doc comment. `undefined` outside a snapshot transaction; a real `commitSeq` ceiling inside one. */
  visibleAsOf: number | undefined;
}

/** A committed row is visible to a read carrying `visibleAsOf` iff it committed at or before that snapshot boundary — `undefined` means "no boundary, see everything currently committed." Shared by every snapshot-aware read handler below so the rule is stated once, not re-derived per handler. */
function isVisible(commitSeq: number, visibleAsOf: number | undefined): boolean {
  return visibleAsOf === undefined || commitSeq <= visibleAsOf;
}

export type ShapeHandler = (ctx: ShapeContext) => FakeQueryResult;

/** Collapses a template literal's real source indentation to single spaces before comparison — the only normalization this executor does; see this file's own top-of-file doc comment on why it's exact-match, never fuzzy, past that. */
export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function relationTupleKey(
  row: Pick<
    RelationTupleRow,
    'objectNs' | 'objectId' | 'relation' | 'subjectNs' | 'subjectId' | 'subjectRelation'
  >,
): string {
  return [
    row.objectNs,
    row.objectId,
    row.relation,
    row.subjectNs,
    row.subjectId,
    row.subjectRelation ?? '',
  ].join(' ');
}

function tupleRowToApiShape(row: RelationTupleRow): Record<string, unknown> {
  return {
    id: row.id,
    object_ns: row.objectNs,
    object_id: row.objectId,
    relation: row.relation,
    subject_ns: row.subjectNs,
    subject_id: row.subjectId,
    subject_relation: row.subjectRelation,
    created_at: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// tuples.ts's own SQL surface — the write-log advisory lock, the tuple
// insert/delete, both list queries, the write-log insert.
// ---------------------------------------------------------------------------

// D0 modeled `pg_advisory_xact_lock($1, $2)` as an always-succeeding no-op
// here (`docs/DECISIONS.md` D-097) — D1 (D-098) replaces that stopgap with
// a real lock engine (`locks.ts`) that genuinely blocks a second
// contending connection. Locking needs per-connection identity and a
// queue `bufferOp`'s synchronous, connection-agnostic handler signature
// below can't express, so all four real advisory-lock SQL texts are now
// special-cased directly in `connection.ts`, *before* a query ever reaches
// `lookupShape` — never registered here.

const tupleInsertHandler: ShapeHandler = ({ state, params, bufferOp }) => {
  const [objectNs, objectId, relation, subjectNs, subjectId, subjectRelationParam] = params as [
    string,
    string,
    string,
    string,
    string,
    string | null,
  ];
  const subjectRelation = subjectRelationParam ?? null;
  const key = relationTupleKey({
    objectNs,
    objectId,
    relation,
    subjectNs,
    subjectId,
    subjectRelation,
  });

  // Identity allocation happens now, unconditionally — see this file's own
  // top-of-file doc comment and state.ts's own note on why an
  // ON-CONFLICT-DO-NOTHING insert still burns an id in real Postgres.
  const id = state.nextRelationTupleId;
  state.nextRelationTupleId += 1;

  const alreadyExists = state.relationTuples.some((row) => relationTupleKey(row) === key);
  if (alreadyExists) {
    return { rows: [], rowCount: 0 };
  }

  bufferOp((s, commitSeq) => {
    // Re-check at commit time, not just at statement time — a concurrent
    // transaction could commit the identical tuple in between (D1/D4's own
    // concern once real interleaving exists; harmless to guard here now).
    if (s.relationTuples.some((row) => relationTupleKey(row) === key)) return;
    s.relationTuples.push({
      id: String(id),
      objectNs,
      objectId,
      relation,
      subjectNs,
      subjectId,
      subjectRelation,
      createdAt: new Date(0), // DST is deterministic — no wall-clock reads; see docs/DST-PROPOSAL.md's own nondeterminism-sources note.
      commitSeq,
    });
  });
  return { rows: [], rowCount: 1 };
};

const tupleDeleteHandler: ShapeHandler = ({ state, params, bufferOp }) => {
  const [objectNs, objectId, relation, subjectNs, subjectId, subjectRelationParam] = params as [
    string,
    string,
    string,
    string,
    string,
    string | null,
  ];
  const subjectRelation = subjectRelationParam ?? null;
  const key = relationTupleKey({
    objectNs,
    objectId,
    relation,
    subjectNs,
    subjectId,
    subjectRelation,
  });

  // rowCount reflects "does a matching committed row exist right now" —
  // matching a real Postgres DELETE's own rowCount, computed at statement
  // time against the then-current visible state, not deferred to commit.
  // deleteTuple's own `deleted: (rowCount ?? 0) > 0` depends on this being
  // accurate, not a placeholder.
  const matches = state.relationTuples.some((row) => relationTupleKey(row) === key);

  bufferOp((s) => {
    s.relationTuples = s.relationTuples.filter((row) => relationTupleKey(row) !== key);
  });

  return { rows: [], rowCount: matches ? 1 : 0 };
};

const writeLogInsertHandler: ShapeHandler = ({ state, params, bufferOp }) => {
  const [operation, tupleJson] = params as [string, string];
  const tuple = JSON.parse(tupleJson) as TupleKey;

  // See this file's own top-of-file doc comment and state.ts's own note:
  // allocated now, unconditionally, never deferred to commit.
  const token = state.nextToken;
  state.nextToken += 1;

  bufferOp((s, commitSeq) => {
    s.writeLog.push({
      token: String(token),
      operation: operation as 'write' | 'delete',
      tuple,
      writtenAt: new Date(0),
      commitSeq,
    });
  });
  return { rows: [{ token: String(token) }], rowCount: 1 };
};

const listByObjectHandler = (withRelationFilter: boolean): ShapeHandler => {
  return ({ state, params, visibleAsOf }) => {
    const [objectNs, objectId, relation] = params as [string, string, string | undefined];
    const rows = state.relationTuples
      .filter(
        (row) =>
          row.objectNs === objectNs &&
          row.objectId === objectId &&
          (!withRelationFilter || row.relation === relation) &&
          isVisible(row.commitSeq, visibleAsOf),
      )
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map(tupleRowToApiShape);
    return { rows, rowCount: rows.length };
  };
};

const listBySubjectHandler: ShapeHandler = ({ state, params, visibleAsOf }) => {
  const [subjectNs, subjectId] = params as [string, string];
  const rows = state.relationTuples
    .filter(
      (row) =>
        row.subjectNs === subjectNs &&
        row.subjectId === subjectId &&
        isVisible(row.commitSeq, visibleAsOf),
    )
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map(tupleRowToApiShape);
  return { rows, rowCount: rows.length };
};

// ---------------------------------------------------------------------------
// tokens.ts's own SQL surface. Also reused, unmodified, by
// resolver.ts's assertTokenObservedOnSnapshot (D2) — same exact query
// text, so no second registry entry is needed; see this handler's own
// visibleAsOf argument for why that reuse is correct even though the two
// callers run in very different transaction contexts.
// ---------------------------------------------------------------------------

const maxTokenHandler: ShapeHandler = ({ state, visibleAsOf }) => {
  const visible = state.writeLog.filter((row) => isVisible(row.commitSeq, visibleAsOf));
  if (visible.length === 0) {
    return { rows: [{ max_token: null }], rowCount: 1 };
  }
  const max = visible.reduce((m, row) => Math.max(m, Number(row.token)), 0);
  return { rows: [{ max_token: String(max) }], rowCount: 1 };
};

// ---------------------------------------------------------------------------
// publish.ts's getLatestNamespaceConfig — the one dependency writeTuple's
// own schema validation pulls in from outside tuples.ts/tokens.ts. Never
// snapshot-filtered: resolver.ts's own getConfig deliberately runs this on
// the plain, un-pinned connection, outside productionCheck's REPEATABLE
// READ transaction (docs/DECISIONS.md D-092's own disclosed scope note) —
// so `visibleAsOf` is always `undefined` for every real call to this
// handler, and it is not threaded through here at all, matching that.
// ---------------------------------------------------------------------------

const latestNamespaceConfigHandler: ShapeHandler = ({ state, params }) => {
  const [namespace] = params as [string];
  const rows = state.namespaceConfigs
    .filter((row) => row.namespace === namespace)
    .sort((a, b) => b.version - a.version);
  const top = rows[0];
  if (!top) return { rows: [], rowCount: 0 };
  return { rows: [{ config: top.config }], rowCount: 1 };
};

// ---------------------------------------------------------------------------
// resolver.ts's own SQL surface (D2, docs/DECISIONS.md D-099) —
// listTupleSubjects (the tuple-to-userset hop), fetchReachableFrontier
// (the recursive-membership frontier query), fetchTuplesOnFrontier (the
// batched unnest join). All three always run on productionCheck's own
// REPEATABLE READ client, so `visibleAsOf` is always a real number for
// every genuine call to these three — never `undefined` in practice, but
// each still honors `isVisible`'s own "no boundary" fallback for honesty
// and reuse elsewhere.
// ---------------------------------------------------------------------------

const listTupleSubjectsHandler: ShapeHandler = ({ state, params, visibleAsOf }) => {
  const [objectNs, objectId, relation] = params as [string, string, string];
  const rows = state.relationTuples
    .filter(
      (row) =>
        row.objectNs === objectNs &&
        row.objectId === objectId &&
        row.relation === relation &&
        isVisible(row.commitSeq, visibleAsOf),
    )
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((row) => ({ subject_ns: row.subjectNs, subject_id: row.subjectId }));
  return { rows, rowCount: rows.length };
};

/**
 * D2's own deliberately narrow implementation of `fetchReachableFrontier`'s
 * real recursive CTE (`src/resolve/production/resolver.ts`) — see
 * `docs/DST-PROPOSAL.md`'s phased plan: the real, multi-level
 * userset-subject BFS, proven equivalent to Postgres by a committed
 * differential-fuzz corpus, is D3's own named deliverable
 * (`fetchReachableFrontierVia`), not D2's. This handler answers correctly
 * for exactly the part of the real query's semantics that needs no
 * recursion at all — the seed row (`depth: 0`, the starting
 * `(object, relation)` itself), always present in the real CTE's own
 * `UNION ALL` regardless of whether any recursion ever happens — and
 * **throws**, rather than silently returning an incomplete frontier, the
 * moment this `(object, relation)` actually has a real, snapshot-visible
 * userset-subject edge (`subjectRelation !== null`) that real recursion
 * *could actually reach* — see this handler's own `maxDepth` handling
 * immediately below for what "could actually reach" means precisely. Per
 * this file's own top-of-file doc comment and `docs/DST-PROPOSAL.md`'s
 * "Two grafts" section: a wrong (silently incomplete) answer is strictly
 * worse than a loud, named failure — this is that same discipline applied
 * to a *semantic* gap, not just an unrecognized SQL string.
 *
 * **`maxDepth` (`$4` in the real query) genuinely matters here, not just
 * for realism.** The real recursive term is gated by `m.depth < $4`; at
 * the seed row's own `depth = 0`, that guard is `0 < $4`, which is
 * `false` whenever `$4 <= 0` — meaning real Postgres's own recursion
 * *structurally cannot fire*, regardless of what userset-subject tuples
 * exist, the instant a caller's remaining depth budget hits zero (a real,
 * reachable case: `productionCheck(..., { maxDepth: 0 })`, or an ordinary
 * permission-indirection chain that happens to bottom out exactly at
 * `env.CHECK_MAX_DEPTH`). In that case the seed-only row this handler
 * always computes already **is** the true, complete answer real Postgres
 * would return too — throwing anyway would be a false positive, exactly
 * the "misrecognizes a case it could actually answer" failure this file's
 * whole exact-match discipline exists to avoid, just at the semantic layer
 * instead of the SQL-text layer. So the throw below only fires when a
 * userset edge exists *and* real recursion could have reached it
 * (`maxDepth > 0`) — caught live during D2's own adversarial review
 * (`docs/DECISIONS.md` D-099), not assumed correct from the first draft.
 *
 * This is enough to reproduce D-092's own flagship phantom-witness
 * scenario faithfully: that bug's real counterexample is specifically
 * about a *plain* grant tuple (no userset nesting) becoming visible to
 * `fetchTuplesOnFrontier`'s read but not `fetchReachableFrontier`'s
 * earlier one (or vice versa) — a plain grant is exactly what
 * `fetchTuplesOnFrontier` reads off the seed row this handler always
 * returns; no multi-level recursion is needed to reproduce or close that
 * specific race. See `docs/DECISIONS.md` D-099 for the full reasoning.
 */
const fetchReachableFrontierHandler: ShapeHandler = ({ state, params, visibleAsOf }) => {
  const [ns, id, relation, maxDepth] = params as [string, string, string, number];
  const hasReachableUsersetEdge =
    maxDepth > 0 &&
    state.relationTuples.some(
      (row) =>
        row.objectNs === ns &&
        row.objectId === id &&
        row.relation === relation &&
        row.subjectRelation !== null &&
        isVisible(row.commitSeq, visibleAsOf),
    );
  if (hasReachableUsersetEdge) {
    throw new Error(
      `DST fake store: fetchReachableFrontier's D2 seed-only handler cannot answer ` +
        `(${ns}:${id}#${relation}) — a real, snapshot-visible userset-subject edge exists on ` +
        `it, and multi-level frontier recursion is D3's own job (docs/DST-PROPOSAL.md's phased ` +
        `plan), not yet implemented here. See this handler's own doc comment.`,
    );
  }
  const seedRow = { ns, id, relation, depth: 0, path: [`${ns}:${id}#${relation}`] };
  return { rows: [seedRow], rowCount: 1 };
};

/** Real Postgres's `unnest($1::text[]), unnest($2::text[]), unnest($3::text[])` join is positional — one join row per array index. Mirrors that exactly rather than, say, a cross product. */
const fetchTuplesOnFrontierHandler: ShapeHandler = ({ state, params, visibleAsOf }) => {
  const [nsArr, idArr, relArr] = params as [string[], string[], string[]];
  const frontierKeys = new Set<string>();
  for (let i = 0; i < nsArr.length; i += 1) {
    frontierKeys.add(`${nsArr[i]}:${idArr[i]}#${relArr[i]}`);
  }
  const rows = state.relationTuples
    .filter(
      (row) =>
        frontierKeys.has(`${row.objectNs}:${row.objectId}#${row.relation}`) &&
        isVisible(row.commitSeq, visibleAsOf),
    )
    .map((row) => ({
      object_ns: row.objectNs,
      object_id: row.objectId,
      relation: row.relation,
      subject_ns: row.subjectNs,
      subject_id: row.subjectId,
      subject_relation: row.subjectRelation,
    }));
  return { rows, rowCount: rows.length };
};

// ---------------------------------------------------------------------------
// The registry itself.
// ---------------------------------------------------------------------------

const SHAPES = new Map<string, ShapeHandler>([
  [
    normalizeSql(`insert into relation_tuples
         (object_ns, object_id, relation, subject_ns, subject_id, subject_relation)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (object_ns, object_id, relation, subject_ns, subject_id, coalesce(subject_relation, ''))
       do nothing`),
    tupleInsertHandler,
  ],
  [
    normalizeSql(`delete from relation_tuples
       where object_ns = $1 and object_id = $2 and relation = $3
         and subject_ns = $4 and subject_id = $5
         and coalesce(subject_relation, '') = coalesce($6, '')`),
    tupleDeleteHandler,
  ],
  [
    normalizeSql(`insert into write_log (operation, tuple) values ($1, $2) returning token`),
    writeLogInsertHandler,
  ],
  [
    normalizeSql(`select id, object_ns, object_id, relation, subject_ns, subject_id, subject_relation, created_at
     from relation_tuples where object_ns = $1 and object_id = $2
     order by id`),
    listByObjectHandler(false),
  ],
  [
    normalizeSql(`select id, object_ns, object_id, relation, subject_ns, subject_id, subject_relation, created_at
     from relation_tuples where object_ns = $1 and object_id = $2 and relation = $3
     order by id`),
    listByObjectHandler(true),
  ],
  [
    normalizeSql(`select id, object_ns, object_id, relation, subject_ns, subject_id, subject_relation, created_at
     from relation_tuples where subject_ns = $1 and subject_id = $2
     order by id`),
    listBySubjectHandler,
  ],
  [normalizeSql('select max(token) as max_token from write_log'), maxTokenHandler],
  [
    normalizeSql(`select config from namespace_configs
     where namespace = $1
     order by version desc
     limit 1`),
    latestNamespaceConfigHandler,
  ],
  [
    normalizeSql(`select subject_ns, subject_id
     from relation_tuples
     where object_ns = $1 and object_id = $2 and relation = $3`),
    listTupleSubjectsHandler,
  ],
  [
    normalizeSql(`with recursive membership(ns, id, relation, depth, path) as (
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
     select ns, id, relation, depth, path from membership`),
    fetchReachableFrontierHandler,
  ],
  [
    normalizeSql(`select rt.object_ns, rt.object_id, rt.relation, rt.subject_ns, rt.subject_id, rt.subject_relation
     from relation_tuples rt
     join (
       select unnest($1::text[]) as ns, unnest($2::text[]) as id, unnest($3::text[]) as relation
     ) as frontier
       on rt.object_ns = frontier.ns and rt.object_id = frontier.id and rt.relation = frontier.relation`),
    fetchTuplesOnFrontierHandler,
  ],
]);

/**
 * Throws on anything unrecognized, per this file's own top-of-file doc
 * comment — a wrong (fuzzy-matched) result is strictly worse than a loud
 * failure naming the exact offending SQL text.
 */
export function lookupShape(sql: string): ShapeHandler {
  const key = normalizeSql(sql);
  const handler = SHAPES.get(key);
  if (!handler) {
    throw new Error(`DST fake store: no shape registered for query: ${JSON.stringify(key)}`);
  }
  return handler;
}
