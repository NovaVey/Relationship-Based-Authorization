/**
 * The trivial, exact-match SQL-shape executor DST's fake store uses for
 * this project's plain SQL surface — `src/store/tuples.ts`,
 * `src/store/tokens.ts`, `src/schema/publish.ts` (D0's own three files),
 * plus `src/resolve/production/resolver.ts`'s own plain reads (D2/D3).
 * `docs/DST-PROPOSAL.md`'s own design: exact-string lookup, never parsing
 * or regex, throwing loudly on anything unrecognized rather than silently
 * returning an empty result (the proposal's own §"Two grafts" — the
 * permanent, written rule: misrecognition is strictly worse than
 * non-recognition, so this executor is exact-match-only, forever).
 * `registeredShapeCount()` (below) and `test/unit/store/dst/
 * recognizer-coverage.dst.test.ts`'s own manifest (DST D5, `docs/
 * DECISIONS.md` D-102) are the structural gate proving every shape
 * registered here actually gets exercised by some real production caller.
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
import type { NamespaceConfig } from '../../schema/dsl/types.js';
import type { TupleKey } from '../tuples.js';
import type { FakeStoreState, RelationTupleRow } from './state.js';
import { fetchReachableFrontierVia } from './frontier.js';

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
// own schema validation pulls in from outside tuples.ts/tokens.ts.
// Snapshot-aware (unlike D0's original version of this handler): `getConfig`
// in both resolver.ts and expand.ts now runs this on their own pinned
// REPEATABLE READ client (closing the connection-exhaustion deadlock
// docs/DECISIONS.md documents — see resolver.ts's own doc comment for the
// full history), so `visibleAsOf` is a real number for every one of those
// calls, same as listTupleSubjectsHandler/fetchReachableFrontierHandler/
// fetchTuplesOnFrontierHandler below. Every other real caller —
// writeTuple/deleteTuple's own schema validation, publishOne's own
// version-increment lookup — still calls this on the plain, un-pinned pool,
// so `visibleAsOf` is `undefined` there exactly as before; `isVisible`'s own
// "no boundary" fallback means this change is purely additive for them,
// identical to every other handler D2 already made snapshot-aware.
// ---------------------------------------------------------------------------

const latestNamespaceConfigHandler: ShapeHandler = ({ state, params, visibleAsOf }) => {
  const [namespace] = params as [string];
  const rows = state.namespaceConfigs
    .filter((row) => row.namespace === namespace && isVisible(row.commitSeq, visibleAsOf))
    .sort((a, b) => b.version - a.version);
  const top = rows[0];
  if (!top) return { rows: [], rowCount: 0 };
  return { rows: [{ config: top.config }], rowCount: 1 };
};

// ---------------------------------------------------------------------------
// publish.ts's own publishOne — DST D5 (docs/DECISIONS.md D-102): a real
// coverage gap the recognizer-coverage gate this phase builds found before
// it ever shipped as a required check. publishSchema/publishOne are pure
// parameterized CRUD against namespace_configs, not schema DDL (unlike
// migrate.ts's own runMigrations, which is deliberately out of the fake's
// scope — see that file's own doc comment) — exactly the shape this whole
// design is built to model — but neither of publishOne's own two real
// statements (the next-version select, the row insert) was ever registered
// here, and no DST test called the real publishSchema end to end. Both
// handlers run inside publishSchema's own plain BEGIN/COMMIT transaction
// (never a Snapshot one — publishOne is a write path), so `visibleAsOf` is
// always `undefined` when either runs, matching tupleInsertHandler/
// tupleDeleteHandler's own identical precedent of not filtering write-path
// reads by snapshot visibility.
// ---------------------------------------------------------------------------

const namespaceConfigNextVersionHandler: ShapeHandler = ({ state, params }) => {
  const [namespace] = params as [string];
  const maxVersion = state.namespaceConfigs
    .filter((row) => row.namespace === namespace)
    .reduce((max, row) => Math.max(max, row.version), 0);
  return { rows: [{ next_version: maxVersion + 1 }], rowCount: 1 };
};

const namespaceConfigInsertHandler: ShapeHandler = ({ params, bufferOp }) => {
  const [namespace, versionParam, configJson, sourceDsl] = params as [
    string,
    number,
    string,
    string,
  ];
  const version = Number(versionParam);
  const config = JSON.parse(configJson) as NamespaceConfig;
  bufferOp((s, commitSeq) => {
    s.namespaceConfigs.push({ namespace, version, config, sourceDsl, commitSeq });
  });
  return { rows: [], rowCount: 1 };
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
 * `fetchReachableFrontier`'s real recursive CTE (`src/resolve/production/
 * resolver.ts`), answered by DST D3's own real, multi-level BFS
 * (`fetchReachableFrontierVia`, `src/store/dst/frontier.ts`) — see that
 * file's own top-of-file doc comment for the full fidelity argument
 * (iterative working-table semantics, per-iteration `DISTINCT ON` dedup,
 * per-row path cycle guard, the `maxDepth` boundary) and `docs/DECISIONS.md`
 * D-100 for the differential-equivalence suite that proves it against real
 * Postgres. Replaces D2's own deliberately narrower seed-row-only stopgap
 * (`docs/DECISIONS.md` D-099) — the "throw, this needs D3" guard that
 * stopgap carried is gone: this handler now genuinely answers every case,
 * not just the no-recursion-needed one.
 */
const fetchReachableFrontierHandler: ShapeHandler = ({ state, params, visibleAsOf }) => {
  const [ns, id, relation, maxDepth] = params as [string, string, string, number];
  const rows = fetchReachableFrontierVia(state, ns, id, relation, maxDepth, visibleAsOf);
  // A plain-data map, matching this file's own tupleRowToApiShape idiom —
  // `DstFrontierRow` is a nominally-declared interface, which TypeScript
  // does not treat as assignable to `Record<string, unknown>` even with
  // identical property names, so the rows are re-packaged as fresh object
  // literals rather than returned as-is.
  const apiRows = rows.map((r) => ({
    ns: r.ns,
    id: r.id,
    relation: r.relation,
    depth: r.depth,
    path: r.path,
  }));
  return { rows: apiRows, rowCount: apiRows.length };
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
    normalizeSql(`select coalesce(max(version), 0) + 1 as next_version
     from namespace_configs where namespace = $1`),
    namespaceConfigNextVersionHandler,
  ],
  [
    normalizeSql(`insert into namespace_configs (namespace, version, config, source_dsl)
     values ($1, $2, $3, $4)`),
    namespaceConfigInsertHandler,
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

/**
 * DST D5 (`docs/DECISIONS.md` D-102) — the exact size of the SQL-shape
 * registry above, for `test/unit/store/dst/recognizer-coverage.dst.test.ts`'s
 * own count tripwire: that file's own manifest exercises every registered
 * shape end to end through its real production caller and asserts this
 * count matches exactly what it expects, so a shape added here without a
 * matching manifest entry there (or a manifest entry whose shape silently
 * stopped being registered) is a loud, named CI failure, not silent drift —
 * `docs/DST-PROPOSAL.md`'s own "required, always-on recognizer-coverage
 * gate" design, applied in the direction D-099's own review already found a
 * real gap in once (`listTupleSubjects`, registered but unexercised).
 */
export function registeredShapeCount(): number {
  return SHAPES.size;
}
