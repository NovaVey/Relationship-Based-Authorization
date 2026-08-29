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
import type {
  FakeStoreState,
  RelationTupleRow,
  RelationMembershipIndexStateVersion,
} from './state.js';
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
  /** D-144 (expiring tuples) — the instant every expiry filter below compares a tuple's own `expiresAt` against. Always a concrete `Date` (never `undefined` the way `visibleAsOf` can be "no boundary") — see `connection.ts`'s own doc comment on `snapshotNow` for how this is anchored inside a snapshot transaction. */
  now: Date;
}

/** A committed row is visible to a read carrying `visibleAsOf` iff it committed at or before that snapshot boundary — `undefined` means "no boundary, see everything currently committed." Shared by every snapshot-aware read handler below so the rule is stated once, not re-derived per handler. */
function isVisible(commitSeq: number, visibleAsOf: number | undefined): boolean {
  return visibleAsOf === undefined || commitSeq <= visibleAsOf;
}

/** D-144 (expiring tuples) — a tuple with a `null` `expiresAt` never expires; one with a real `expiresAt` is live only up to (exclusive of) that instant, mirroring the real SQL predicate `expires_at is null or expires_at > now()` exactly. Shared by every expiry-aware read handler below, the same "state the rule once" discipline `isVisible` already established for commit-order visibility. */
function isTupleLive(expiresAt: Date | null, now: Date): boolean {
  return expiresAt === null || expiresAt.getTime() > now.getTime();
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
    // D-144 — added for row-shape fidelity with the real `listTuplesByObject`/
    // `listTuplesBySubject` selects once those queries add this column too;
    // the corresponding registered SQL keys below are reconciled against
    // the real, shipped tuples.ts SQL text separately.
    expires_at: row.expiresAt,
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
  // D-144 (expiring tuples) — a 7th, optional param appended after
  // subjectRelation, mirroring tuples.ts's own real insert column order
  // exactly; reconciled once that file's final SQL text is known.
  const [objectNs, objectId, relation, subjectNs, subjectId, subjectRelationParam, expiresAtParam] =
    params as [string, string, string, string, string, string | null, Date | null | undefined];
  const subjectRelation = subjectRelationParam ?? null;
  const expiresAt = expiresAtParam ?? null;
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
      expiresAt,
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

// Full-repo audit finding #11 (2026-08-29) — writeTuple's own new
// follow-up SELECT, run only on the `created: false` (conflict) path, to
// surface whether the existing row that caused the conflict is actually
// expired. A plain-write-path read, same as tupleInsertHandler/
// tupleDeleteHandler immediately above/below — never visibleAsOf-filtered,
// for the identical reason those two aren't (writeTuple's own plain
// BEGIN/COMMIT transaction, never a snapshot one; see this file's own
// top-of-file doc comment on `namespaceConfigNextVersionHandler`'s
// identical precedent).
const existingExpiresAtHandler: ShapeHandler = ({ state, params }) => {
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
  const existing = state.relationTuples.find((row) => relationTupleKey(row) === key);
  if (!existing) return { rows: [], rowCount: 0 };
  return { rows: [{ expires_at: existing.expiresAt }], rowCount: 1 };
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

const listTupleSubjectsHandler: ShapeHandler = ({ state, params, visibleAsOf, now }) => {
  const [objectNs, objectId, relation] = params as [string, string, string];
  const rows = state.relationTuples
    .filter(
      (row) =>
        row.objectNs === objectNs &&
        row.objectId === objectId &&
        row.relation === relation &&
        isVisible(row.commitSeq, visibleAsOf) &&
        isTupleLive(row.expiresAt, now), // D-144
    )
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((row) => ({
      subject_ns: row.subjectNs,
      subject_id: row.subjectId,
      expires_at: row.expiresAt, // D-144 — matches the real query's own added column
    }));
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
const fetchReachableFrontierHandler: ShapeHandler = ({ state, params, visibleAsOf, now }) => {
  const [ns, id, relation, maxDepth] = params as [string, string, string, number];
  // D-144 — `now` excludes an expired edge from traversal exactly like the
  // real recursive CTE's own added `where` clause; see `fetchReachableFrontierVia`'s
  // own doc comment.
  const rows = fetchReachableFrontierVia(state, ns, id, relation, maxDepth, visibleAsOf, now);
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
const fetchTuplesOnFrontierHandler: ShapeHandler = ({ state, params, visibleAsOf, now }) => {
  const [nsArr, idArr, relArr] = params as [string[], string[], string[]];
  const frontierKeys = new Set<string>();
  for (let i = 0; i < nsArr.length; i += 1) {
    frontierKeys.add(`${nsArr[i]}:${idArr[i]}#${relArr[i]}`);
  }
  const rows = state.relationTuples
    .filter(
      (row) =>
        frontierKeys.has(`${row.objectNs}:${row.objectId}#${row.relation}`) &&
        isVisible(row.commitSeq, visibleAsOf) &&
        isTupleLive(row.expiresAt, now), // D-144
    )
    .map((row) => ({
      object_ns: row.objectNs,
      object_id: row.objectId,
      relation: row.relation,
      subject_ns: row.subjectNs,
      subject_id: row.subjectId,
      subject_relation: row.subjectRelation,
      expires_at: row.expiresAt, // D-144 — matches the real query's own added column
    }));
  return { rows, rowCount: rows.length };
};

// ---------------------------------------------------------------------------
// relation-index.ts's own SQL surface — `docs/DST-LEOPARD-EVOLUTION-
// PROPOSAL.md`'s own "New shape handlers" section. `rebuildRelationMembership
// Index` always runs on its own dedicated connection, opened with the second,
// *writable* `REPEATABLE READ` `BEGIN` text (`connection.ts`'s own
// `snapshotReadOnly: false` mode) — every read below still honors
// `visibleAsOf`/`isVisible` exactly like every other D2 snapshot-aware
// handler, since that anchoring discipline was never specific to
// read-only-ness in the first place (`connection.ts`'s own top-of-file doc
// comment). `lookupRelationMembershipIndex`'s own two reads, by contrast,
// always run on `productionCheck`'s existing `REPEATABLE READ READ ONLY`
// client, so `visibleAsOf` is a real number for every genuine call to those
// two — never `undefined` in practice, but each still honors `isVisible`'s
// own "no boundary" fallback for the identical reason resolver.ts's own
// three handlers already do.
// ---------------------------------------------------------------------------

/** `ns:id#relation` — the identical `via_path`/`FrontierRow.path` string encoding `frontier.ts`'s own (private) `identityKey` already builds; duplicated here as its own tiny, single-purpose helper rather than exporting that one, matching this project's own established "a plain-data shape/format shared across a module boundary that isn't itself resolver-isolation-sensitive is fine to independently redeclare" precedent (`docs/DECISIONS.md` D-022) — this is a one-line string format, not traversal or rewrite-evaluation logic, so nothing about the reference/production resolver isolation rule is implicated by having two copies of it. */
function membershipIdentityKey(ns: string, id: string, relation: string): string {
  return `${ns}:${id}#${relation}`;
}

/**
 * Parses one `path` element (`ns:id#relation`) back into its parts —
 * unambiguous for the identical reason `resolver.ts`'s own private
 * `parseFrontierKeyString` already documents: every namespace/id/relation is
 * restricted to `[a-z][a-z0-9_]*` (`IDENTIFIER_PATTERN`), which never
 * contains `:` or `#`. A separate, independent copy for the identical
 * "duplication over a backwards/risky import" reasoning as
 * `membershipIdentityKey` above — this file has no dependency on
 * `resolver.ts` at all, and creating one purely to reuse a four-line parser
 * would be exactly the kind of undisclosed coupling `relation-index.ts`'s own
 * top-of-file doc comment already refuses for the identical reason
 * (`store/` must never depend on `resolve/`).
 */
function parseMembershipIdentityKey(raw: string): { ns: string; id: string; relation: string } {
  const hashIndex = raw.indexOf('#');
  const colonIndex = raw.indexOf(':');
  if (hashIndex < 0 || colonIndex < 0 || colonIndex >= hashIndex) {
    throw new Error(`DST fake store: malformed frontier identity key ${JSON.stringify(raw)}`);
  }
  return {
    ns: raw.slice(0, colonIndex),
    id: raw.slice(colonIndex + 1, hashIndex),
    relation: raw.slice(hashIndex + 1),
  };
}

/** Postgres's own `least(...)` semantics: ignores `NULL` operands, returns `NULL` only when every operand is `NULL` — mirrors the real rebuild SQL's own `least(m.min_expires_at, rt.expires_at)` threading exactly (`relation-index.ts`'s own doc comment, step 3). */
function leastIgnoringNull(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

/**
 * The running minimum `expires_at` across every USERSET edge on `path`
 * (root through the second-to-last node) — the in-memory equivalent of the
 * real recursive CTE's own `least(m.min_expires_at, rt.expires_at)`
 * threaded through `membership`'s own recursion (`relation-index.ts`'s doc
 * comment, step 3). `fetchReachableFrontierVia`'s own `DstFrontierRow` never
 * carries this value itself (it only tracks `path`, sufficient for its own
 * proven reachability-equivalence contract, D-100) — this walks `path` back
 * against `state.relationTuples` to recover each edge's own tuple and read
 * its `expiresAt`, honoring the identical `visibleAsOf`/`now` this whole
 * transaction is already anchored to.
 */
function pathMinExpiresAt(
  state: FakeStoreState,
  path: readonly string[],
  visibleAsOf: number | undefined,
  now: Date,
): Date | null {
  let min: Date | null = null;
  for (let i = 0; i + 1 < path.length; i += 1) {
    const object = parseMembershipIdentityKey(path[i] as string);
    const subject = parseMembershipIdentityKey(path[i + 1] as string);
    const edge = state.relationTuples.find(
      (t) =>
        t.objectNs === object.ns &&
        t.objectId === object.id &&
        t.relation === object.relation &&
        t.subjectNs === subject.ns &&
        t.subjectId === subject.id &&
        t.subjectRelation === subject.relation &&
        isVisible(t.commitSeq, visibleAsOf) &&
        isTupleLive(t.expiresAt, now),
    );
    if (edge) min = leastIgnoringNull(min, edge.expiresAt);
  }
  return min;
}

/**
 * `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "Reusing
 * `fetchReachableFrontierVia`, not reimplementing traversal a second time" —
 * see that section's own full reasoning for why this calls the already
 * D-100-proven traversal once per distinct root rather than a from-scratch
 * second closure algorithm. **No depth ceiling, deliberately** — matching
 * the real rebuild's own documented choice (`relation-index.ts`, step 3:
 * "Phase A is ALLOW-only, so an under-populated root from any cause,
 * including a depth cap, can only produce a safe `{hit:false}` miss
 * downstream, never a false hit"). `Number.MAX_SAFE_INTEGER` is a bound in
 * name only — `fetchReachableFrontierVia`'s own real, per-row cycle guard
 * (property 3, that file's own doc comment) is what actually terminates this
 * on a cyclic tuple graph, for the identical reason every real resolver's
 * cycle detection is the actual termination mechanism and a depth ceiling is
 * only ever a second, independent backstop (never the other way around).
 */
const REBUILD_NO_DEPTH_CEILING = Number.MAX_SAFE_INTEGER;

interface RebuildCandidateRow {
  objectNs: string;
  objectId: string;
  relation: string;
  subjectNs: string;
  subjectId: string;
  viaPath: string[];
  minExpiresAt: Date | null;
}

/**
 * The batched `WITH RECURSIVE roots(...) ... INSERT INTO
 * relation_membership_index SELECT DISTINCT ON (...) ...`'s own in-memory
 * equivalent — see this file's own section doc comment and the design
 * proposal's "Reusing `fetchReachableFrontierVia`" section for the full
 * argument. Per real root (every distinct `(object_ns, object_id, relation)`
 * among currently-visible `relation_tuples`, matching the real `roots` CTE's
 * own `select distinct object_ns, object_id, relation from relation_tuples`
 * with no expiry filter on the roots themselves — expiry only ever gates
 * edges/terminal grants, never which objects count as roots at all):
 * `fetchReachableFrontierVia`'s own BFS output, scanned in its own
 * (shortest-path-first) `allRows` order, produces one `(root, subject)`
 * candidate per real plain tuple (`subjectRelation === null`) found at any
 * reached node — the terminal grant `relation-index.ts`'s own `candidate_rows`
 * CTE joins in. "Shortest wins" for a converging-paths collision falls out
 * for free from scanning in that same shortest-first order and keeping only
 * the first candidate recorded per subject, per root — the identical
 * argument the design proposal's own text makes for why no separate
 * tie-break logic is needed here.
 */
function computeRebuildCandidates(
  state: FakeStoreState,
  visibleAsOf: number | undefined,
  now: Date,
): RebuildCandidateRow[] {
  const roots = new Map<string, { ns: string; id: string; relation: string }>();
  for (const row of state.relationTuples) {
    if (!isVisible(row.commitSeq, visibleAsOf)) continue;
    const key = membershipIdentityKey(row.objectNs, row.objectId, row.relation);
    if (!roots.has(key)) {
      roots.set(key, { ns: row.objectNs, id: row.objectId, relation: row.relation });
    }
  }

  const results: RebuildCandidateRow[] = [];
  for (const root of roots.values()) {
    const frontierRows = fetchReachableFrontierVia(
      state,
      root.ns,
      root.id,
      root.relation,
      REBUILD_NO_DEPTH_CEILING,
      visibleAsOf,
      now,
    );
    // "Shortest wins": frontierRows is scanned in fetchReachableFrontierVia's
    // own breadth-first allRows order, so the first candidate recorded per
    // subject below is, by construction, the shortest real one — see this
    // function's own doc comment.
    const bestBySubject = new Map<string, RebuildCandidateRow>();
    for (const frontierRow of frontierRows) {
      const plainGrants = state.relationTuples.filter(
        (t) =>
          t.objectNs === frontierRow.ns &&
          t.objectId === frontierRow.id &&
          t.relation === frontierRow.relation &&
          t.subjectRelation === null &&
          isVisible(t.commitSeq, visibleAsOf) &&
          isTupleLive(t.expiresAt, now),
      );
      for (const grant of plainGrants) {
        const subjectKey = `${grant.subjectNs}:${grant.subjectId}`;
        if (bestBySubject.has(subjectKey)) continue; // shortest already recorded
        const pathMin = pathMinExpiresAt(state, frontierRow.path, visibleAsOf, now);
        bestBySubject.set(subjectKey, {
          objectNs: root.ns,
          objectId: root.id,
          relation: root.relation,
          subjectNs: grant.subjectNs,
          subjectId: grant.subjectId,
          viaPath: frontierRow.path,
          minExpiresAt: leastIgnoringNull(pathMin, grant.expiresAt),
        });
      }
    }
    results.push(...bestBySubject.values());
  }
  return results;
}

/**
 * `REBUILD_WATERMARK_QUERY_TEXT` (`relation-index.ts`) — a deliberate small
 * duplication of `maxTokenHandler`'s own logic, never a reuse of it: the
 * literal text and result shape both genuinely differ (`{watermark: string}`
 * defaulting to `'0'` via `coalesce`, vs. `{max_token: string | null}`),
 * matching `relation-index.ts`'s own doc comment disclosing this exact
 * duplication as deliberate (never an import of `resolver.ts`'s private
 * `ANCHOR_QUERY_TEXT`).
 */
const rebuildWatermarkHandler: ShapeHandler = ({ state, visibleAsOf }) => {
  const visible = state.writeLog.filter((row) => isVisible(row.commitSeq, visibleAsOf));
  const max = visible.reduce((m, row) => Math.max(m, Number(row.token)), 0);
  return { rows: [{ watermark: String(max) }], rowCount: 1 };
};

/** `truncate relation_membership_index` — the unconditional-splice `bufferOp`, exactly `tupleDeleteHandler`'s own established pattern applied to the whole table at once rather than one matching row — see `RelationMembershipIndexRow`'s own doc comment (`state.ts`) for why this exact "unconditionally gone for everyone" behavior is what makes this table's own visibility model correct for `TRUNCATE` specifically. */
const truncateRelationMembershipIndexHandler: ShapeHandler = ({ bufferOp }) => {
  bufferOp((s) => {
    s.relationMembershipIndex = [];
  });
  return { rows: [], rowCount: 0 };
};

/**
 * The batched `WITH RECURSIVE roots(...) ... INSERT INTO
 * relation_membership_index ...` — computed synchronously at statement time
 * (the same "read now, defer only the write" convention every other
 * read-driven write handler in this file already follows, e.g.
 * `tupleInsertHandler`'s own identity allocation), then buffered so the
 * actual rows only land in `state.relationMembershipIndex` atomically at this
 * transaction's own `COMMIT`, tagged with that commit's `commitSeq` — see
 * `computeRebuildCandidates`'s own doc comment for the traversal itself.
 */
const rebuildRelationMembershipIndexInsertHandler: ShapeHandler = ({
  state,
  bufferOp,
  visibleAsOf,
  now,
}) => {
  const candidates = computeRebuildCandidates(state, visibleAsOf, now);
  bufferOp((s, commitSeq) => {
    for (const c of candidates) {
      s.relationMembershipIndex.push({
        objectNs: c.objectNs,
        objectId: c.objectId,
        relation: c.relation,
        subjectNs: c.subjectNs,
        subjectId: c.subjectId,
        viaPath: c.viaPath,
        minExpiresAt: c.minExpiresAt,
        commitSeq,
      });
    }
  });
  return { rows: [], rowCount: candidates.length };
};

/**
 * `update relation_membership_index_state set rebuild_started_at =
 * clock_timestamp() where id = 1` — deliberately inert: `rebuild_started_at`
 * is one of the three columns `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own
 * "The model" section discloses as deliberately not modeled ("never a
 * soundness concern... DST's whole purpose is proving soundness properties
 * under adversarial scheduling, not operational-metadata fidelity"). Still a
 * required registry entry — `shapes.ts`'s "throw loudly on anything
 * unrecognized" discipline means an unregistered statement is a hard
 * failure, not a silent skip — but this handler does nothing beyond
 * returning a plausible `rowCount`.
 */
const rebuildStartedAtNoOpHandler: ShapeHandler = () => ({ rows: [], rowCount: 1 });

/**
 * `update relation_membership_index_state set watermark_token = $1,
 * rebuild_finished_at = clock_timestamp(), row_count = $2 where id = 1` —
 * `rebuild_finished_at`/`row_count` discarded (see this file's own doc
 * comment above on deliberately-unmodeled columns); `watermark_token` is the
 * one column every soundness-relevant read (`relationMembershipIndexWatermark
 * ReadHandler`, below) actually gates on, so it's the only one buffered, as a
 * new `RelationMembershipIndexStateVersion` tagged with this transaction's
 * own eventual `commitSeq` — the identical "append a new version, never
 * mutate one in place" shape `namespaceConfigInsertHandler`'s own
 * `NamespaceConfigRow` already establishes for the identical
 * "an older `REPEATABLE READ` snapshot must keep seeing the old version"
 * reason (`RelationMembershipIndexStateVersion`'s own doc comment, `state.ts`).
 */
const rebuildWatermarkUpdateHandler: ShapeHandler = ({ params, bufferOp }) => {
  const [watermarkTokenParam] = params as [number, number];
  const watermarkToken = Number(watermarkTokenParam);
  bufferOp((s, commitSeq) => {
    s.relationMembershipIndexStateVersions.push({ watermarkToken, commitSeq });
  });
  return { rows: [], rowCount: 1 };
};

/**
 * `lookupRelationMembershipIndex`'s own first `select watermark_token from
 * relation_membership_index_state where id = 1` — Candidate C's own
 * watermark-floor gate. Picks the highest `RelationMembershipIndexStateVersion`
 * with `commitSeq <= visibleAsOf`, defaulting to watermark `0` when none
 * exists yet (an index that has never been rebuilt) — the identical
 * "highest version within my own visibility ceiling" rule
 * `latestNamespaceConfigHandler` already established for `namespace_configs`,
 * reused here because `RelationMembershipIndexStateVersion` deliberately
 * reuses that exact same versioned-row model (see its own doc comment,
 * `state.ts`).
 */
const relationMembershipIndexWatermarkReadHandler: ShapeHandler = ({ state, visibleAsOf }) => {
  const visible = state.relationMembershipIndexStateVersions.filter((v) =>
    isVisible(v.commitSeq, visibleAsOf),
  );
  const top = visible.reduce<RelationMembershipIndexStateVersion | undefined>(
    (best, v) => (best === undefined || v.commitSeq > best.commitSeq ? v : best),
    undefined,
  );
  const watermarkToken = top?.watermarkToken ?? 0;
  return { rows: [{ watermark_token: String(watermarkToken) }], rowCount: 1 };
};

/**
 * `lookupRelationMembershipIndex`'s own second `select via_path,
 * min_expires_at from relation_membership_index where ...` — filtered by
 * `isVisible` (the identical `commitSeq`/`visibleAsOf` discipline every
 * other snapshot-aware read handler in this file already uses) **and**
 * `isTupleLive(minExpiresAt, now)` in the same query, mirroring the real
 * SQL's own single-query `(min_expires_at is null or min_expires_at >
 * now())` predicate exactly (Candidate G) — reusing the exact existing
 * `isTupleLive` helper `listTupleSubjectsHandler`/`fetchTuplesOnFrontierHandler`
 * already use for the identical liveness predicate, never a second
 * implementation of that comparison.
 */
const relationMembershipIndexRowReadHandler: ShapeHandler = ({
  state,
  params,
  visibleAsOf,
  now,
}) => {
  const [objectNs, objectId, relation, subjectNs, subjectId] = params as [
    string,
    string,
    string,
    string,
    string,
  ];
  const row = state.relationMembershipIndex.find(
    (r) =>
      r.objectNs === objectNs &&
      r.objectId === objectId &&
      r.relation === relation &&
      r.subjectNs === subjectNs &&
      r.subjectId === subjectId &&
      isVisible(r.commitSeq, visibleAsOf) &&
      isTupleLive(r.minExpiresAt, now),
  );
  if (!row) return { rows: [], rowCount: 0 };
  return { rows: [{ via_path: row.viaPath, min_expires_at: row.minExpiresAt }], rowCount: 1 };
};

// ---------------------------------------------------------------------------
// The registry itself.
// ---------------------------------------------------------------------------

const SHAPES = new Map<string, ShapeHandler>([
  [
    // D-144 — `expires_at` appended as a 7th column/param; see
    // src/store/tuples.ts's own writeTuple insert statement, which this
    // key must match exactly (normalizeSql collapses whitespace only, not
    // column order or text).
    normalizeSql(`insert into relation_tuples
         (object_ns, object_id, relation, subject_ns, subject_id, subject_relation, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7)
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
    // Full-repo audit finding #11 (2026-08-29) — must match tuples.ts's own
    // new follow-up select exactly; see existingExpiresAtHandler above.
    normalizeSql(`select expires_at from relation_tuples
         where object_ns = $1 and object_id = $2 and relation = $3
           and subject_ns = $4 and subject_id = $5
           and coalesce(subject_relation, '') = coalesce($6, '')`),
    existingExpiresAtHandler,
  ],
  [
    // D-144 — `expires_at` appended to the select list; must match
    // src/store/tuples.ts's own listTuplesByObject exactly.
    normalizeSql(`select id, object_ns, object_id, relation, subject_ns, subject_id, subject_relation, created_at, expires_at
     from relation_tuples where object_ns = $1 and object_id = $2
     order by id`),
    listByObjectHandler(false),
  ],
  [
    normalizeSql(`select id, object_ns, object_id, relation, subject_ns, subject_id, subject_relation, created_at, expires_at
     from relation_tuples where object_ns = $1 and object_id = $2 and relation = $3
     order by id`),
    listByObjectHandler(true),
  ],
  [
    // D-144 — `expires_at` appended; must match listTuplesBySubject exactly.
    normalizeSql(`select id, object_ns, object_id, relation, subject_ns, subject_id, subject_relation, created_at, expires_at
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
    // D-144 — expires_at added to the select list and a liveness filter
    // added to the where clause; must match resolver.ts's listTupleSubjects
    // exactly.
    normalizeSql(`select subject_ns, subject_id, expires_at
     from relation_tuples
     where object_ns = $1 and object_id = $2 and relation = $3
       and (expires_at is null or expires_at > now())`),
    listTupleSubjectsHandler,
  ],
  [
    // D-144 — a liveness filter added to the recursive term's where clause
    // (no new column here — see fetchReachableFrontier's own doc comment
    // for why); must match resolver.ts's fetchReachableFrontier exactly.
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
         and (rt.expires_at is null or rt.expires_at > now())
         and m.depth < $4
         and not (
           (rt.subject_ns || ':' || rt.subject_id || '#' || rt.subject_relation) = any (m.path)
         )
     )
     select ns, id, relation, depth, path from membership`),
    fetchReachableFrontierHandler,
  ],
  [
    // D-144 — expires_at added to the select list and a liveness filter
    // added as a where clause; must match resolver.ts's
    // fetchTuplesOnFrontier exactly.
    normalizeSql(`select rt.object_ns, rt.object_id, rt.relation, rt.subject_ns, rt.subject_id, rt.subject_relation, rt.expires_at
     from relation_tuples rt
     join (
       select unnest($1::text[]) as ns, unnest($2::text[]) as id, unnest($3::text[]) as relation
     ) as frontier
       on rt.object_ns = frontier.ns and rt.object_id = frontier.id and rt.relation = frontier.relation
     where rt.expires_at is null or rt.expires_at > now()`),
    fetchTuplesOnFrontierHandler,
  ],
  [
    // relation-index.ts's own REBUILD_WATERMARK_QUERY_TEXT — must match that
    // constant exactly (a deliberate small duplication of maxTokenHandler's
    // own query, not a reuse of it — see rebuildWatermarkHandler's own doc
    // comment).
    normalizeSql('select coalesce(max(token), 0) as watermark from write_log'),
    rebuildWatermarkHandler,
  ],
  [normalizeSql('truncate relation_membership_index'), truncateRelationMembershipIndexHandler],
  [
    // relation-index.ts's own batched WITH RECURSIVE ... INSERT INTO
    // relation_membership_index ... — must match that literal exactly.
    normalizeSql(`with recursive roots(root_ns, root_id, root_relation) as (
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
       order by root_ns, root_id, root_relation, subject_ns, subject_id, array_length(via_path, 1) asc`),
    rebuildRelationMembershipIndexInsertHandler,
  ],
  [
    normalizeSql(
      'update relation_membership_index_state set rebuild_started_at = clock_timestamp() where id = 1',
    ),
    rebuildStartedAtNoOpHandler,
  ],
  [
    // relation-index.ts's own final watermark-publish UPDATE — must match
    // that literal exactly.
    normalizeSql(`update relation_membership_index_state
       set watermark_token = $1, rebuild_finished_at = clock_timestamp(), row_count = $2
       where id = 1`),
    rebuildWatermarkUpdateHandler,
  ],
  [
    normalizeSql(`select watermark_token from relation_membership_index_state where id = 1`),
    relationMembershipIndexWatermarkReadHandler,
  ],
  [
    // lookupRelationMembershipIndex's own second select — must match that
    // literal exactly.
    normalizeSql(`select via_path, min_expires_at from relation_membership_index
      where object_ns = $1 and object_id = $2 and relation = $3
        and subject_ns = $4 and subject_id = $5
        and (min_expires_at is null or min_expires_at > now())`),
    relationMembershipIndexRowReadHandler,
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
