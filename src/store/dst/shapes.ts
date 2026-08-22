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
 * **Known, disclosed D0 scope limit.** These read handlers answer against
 * `state`'s own currently-committed rows only — no read-your-own-
 * uncommitted-writes support within one open transaction. Nothing in D0's
 * own call surface exercises that (`writeTuple`/`deleteTuple` never read
 * `relation_tuples` back after their own insert/delete within the same
 * transaction; they only use each write's own `rowCount`), so this is a
 * real simplification, not an oversight — flagged here rather than
 * silently assumed away, and squarely D2's problem once snapshot semantics
 * are real.
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

/**
 * D0 deliberately does not model real cross-connection lock contention —
 * that is D1's own job (`docs/DST-PROPOSAL.md`'s `withAdvisoryLock`,
 * `docs/DECISIONS.md` D-092's own precedent for phasing hard invariants in
 * one at a time). This handler exists so `acquireWriteLogLock`'s own query
 * is a *recognized* shape (never silently unmatched), not so it enforces
 * anything yet — a trivially-successful no-op, matching what a lock
 * acquisition against an uncontended lock always returns in real Postgres.
 */
const advisoryLockHandler: ShapeHandler = () => ({ rows: [{}], rowCount: 1 });

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
  return ({ state, params }) => {
    const [objectNs, objectId, relation] = params as [string, string, string | undefined];
    const rows = state.relationTuples
      .filter(
        (row) =>
          row.objectNs === objectNs &&
          row.objectId === objectId &&
          (!withRelationFilter || row.relation === relation),
      )
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map(tupleRowToApiShape);
    return { rows, rowCount: rows.length };
  };
};

const listBySubjectHandler: ShapeHandler = ({ state, params }) => {
  const [subjectNs, subjectId] = params as [string, string];
  const rows = state.relationTuples
    .filter((row) => row.subjectNs === subjectNs && row.subjectId === subjectId)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map(tupleRowToApiShape);
  return { rows, rowCount: rows.length };
};

// ---------------------------------------------------------------------------
// tokens.ts's own SQL surface.
// ---------------------------------------------------------------------------

const maxTokenHandler: ShapeHandler = ({ state }) => {
  if (state.writeLog.length === 0) {
    return { rows: [{ max_token: null }], rowCount: 1 };
  }
  const max = state.writeLog.reduce((m, row) => Math.max(m, Number(row.token)), 0);
  return { rows: [{ max_token: String(max) }], rowCount: 1 };
};

// ---------------------------------------------------------------------------
// publish.ts's getLatestNamespaceConfig — the one dependency writeTuple's
// own schema validation pulls in from outside tuples.ts/tokens.ts.
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
// The registry itself.
// ---------------------------------------------------------------------------

const SHAPES = new Map<string, ShapeHandler>([
  [normalizeSql('select pg_advisory_xact_lock($1, $2)'), advisoryLockHandler],
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
