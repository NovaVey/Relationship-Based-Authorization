/**
 * One simulated `pg.PoolClient` — the connection/transaction engine DST D0
 * builds (`docs/DST-PROPOSAL.md`): a per-connection uncommitted write
 * buffer, `BEGIN`/`COMMIT`/`ROLLBACK` handled here directly (never routed
 * through `shapes.ts`'s SQL-shape registry — these are transaction-control
 * tokens, not queries, per `docs/DST-PROPOSAL.md`'s own SQL-shape
 * inventory), and the fault classes D0/D1 themselves prove: a crash
 * injected mid-transaction (D0), and genuine cross-connection advisory-lock
 * contention (D1, `docs/DECISIONS.md` D-098).
 *
 * **Partial writes (fault class (a), `docs/DST-PROPOSAL.md`).** A
 * connection created with `crashAfterStatements: N` executes its first `N`
 * `.query()` calls normally; the `(N+1)`th throws instead of running, and
 * every query call is discarded from `state`. Once crashed, the connection
 * stays dead — **every** subsequent `.query()` call on it also throws,
 * matching real Postgres: a connection that has actually died cannot run a
 * `ROLLBACK` any more than it could run anything else. This is deliberate,
 * not an oversight, and it is exactly what surfaced the real
 * `writeTuple`/`deleteTuple`/`publishSchema` bug this same task fixed (see
 * `docs/DECISIONS.md`): a naive `catch (err) { await client.query
 * ('ROLLBACK'); throw err; }` would have thrown the *rollback's own*
 * failure instead of the original error, silently replacing it — caught by
 * this connection's own realistic "still dead" behavior, not assumed.
 *
 * **Advisory locks (D1).** The four real lock statement texts this
 * codebase issues — `tuples.ts`'s global write-log lock
 * (`pg_advisory_xact_lock($1, $2)`, two-int, xact-scoped), `publish.ts`'s
 * per-namespace lock (`pg_advisory_xact_lock(hashtext($1))`, hash,
 * xact-scoped), and `migrate.ts`'s session lock and its own explicit
 * release (`pg_advisory_lock($1, $2)` / `pg_advisory_unlock($1, $2)`,
 * two-int, session-scoped) — are matched by exact SQL text *here*, before
 * a query ever reaches `shapes.ts`'s `lookupShape`, and turned into calls
 * against `locks.ts`'s real, blocking lock engine. They live here rather
 * than as ordinary `shapes.ts` handlers because locking needs two things
 * an ordinary `ShapeHandler` doesn't have: this connection's own identity
 * (`connectionId`, so a lock can later be released "everything connection
 * 3 holds") and the ability to genuinely block — return a `Promise` that
 * doesn't settle until another connection releases the lock — which a
 * `ShapeHandler`'s synchronous `(ctx) => FakeQueryResult` signature cannot
 * express. See `locks.ts`'s own top-of-file doc comment for the queueing
 * engine itself, and this file's `LOCK_KEYS`/`acquireLockStatement` below
 * for how each of the four real texts maps onto it.
 *
 * `query()` is genuinely `async` now (D0's version deliberately wasn't —
 * see that phase's own note, superseded here): a blocked lock acquisition
 * is a real pending `Promise` that only settles when granted, so two
 * connections driven concurrently via `Promise.all([...])` actually
 * interleave at that `await`, exactly modeling one real connection
 * blocking behind another's held lock while a third, unrelated connection
 * keeps making progress.
 *
 * **Snapshot transactions (D2, `docs/DECISIONS.md` D-099).** A connection
 * that receives the exact text `resolver.ts`'s `productionCheck` issues —
 * `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` — enters a third
 * transaction mode (`TxState.Snapshot`), distinct from `Open`'s
 * write-buffering: real Postgres's `REPEATABLE READ` freezes every read in
 * the transaction at one MVCC snapshot, anchored not at `BEGIN` but at the
 * transaction's *first real query* (Postgres's own documented behavior,
 * and the exact ordering `resolver.ts`'s own `assertTokenObservedOnSnapshot`
 * doc comment relies on). This connection replicates that ordering
 * precisely: `snapshotSeq` is captured — `state.nextCommitSeq - 1`, the
 * highest `commitSeq` any row has actually committed at, at this exact
 * moment — the first time a real (non-transaction-control) statement runs
 * after entering `Snapshot` mode, never at the `BEGIN` statement itself.
 * Every read for the rest of this transaction carries that frozen
 * `visibleAsOf` value into `shapes.ts`'s handlers (see that file's own doc
 * comment for how each handler honors it) — a row committed *after*
 * `snapshotSeq` is invisible to this connection for the rest of its life,
 * even though, in real logical time, that later commit may have already
 * happened by the time this connection's *next* query actually runs.
 *
 * **Read-only enforced by construction, not just by convention.** A
 * snapshot transaction should never attempt a write — nothing in
 * `productionCheck`'s own real call surface does — but rather than leave
 * that an unstated assumption, `bufferOp` throws immediately if ever
 * invoked while `txState === Snapshot`, the same "enforce it structurally,
 * don't just document it" discipline `docs/DST-PROPOSAL.md`'s own "Two
 * grafts" section applies to the pg-backed side's snapshot-anchoring
 * order.
 *
 * **The pause mechanism (D2, test-only).** Real Postgres has no
 * controllable pause point mid-transaction — `docs/DECISIONS.md` D-092's
 * own regression test had to resort to a real `LOCK TABLE
 * namespace_configs IN ACCESS EXCLUSIVE MODE` against an *unrelated* table
 * just to manufacture one wide enough to race against deterministically.
 * The whole point of simulating at the storage seam is that this fake
 * doesn't need a trick like that: `armNextConnectionPause` (see
 * `source.ts`) arms a one-shot pause, after N successful statements on the
 * next connection opened, that genuinely suspends this connection's
 * `(N+1)`th `.query()` call — a real pending `Promise`, exactly like a
 * blocked lock acquisition — until a test calls the `resume` callback that
 * arming call returned. This gives a DST test the same deterministic
 * control over "commit a concurrent write while this check is mid-flight"
 * that D-092's real regression test needed a real-Postgres table lock to
 * fake.
 */
import type { FakeStoreState } from './state.js';
import { lookupShape, normalizeSql, type FakeQueryResult, type PendingOp } from './shapes.js';
import { acquireLock, releaseLock, releaseLocksForConnection, tryAcquireLock } from './locks.js';

export interface FakeConnection {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<FakeQueryResult<Row>>;
  release(): void;
}

export interface FakeConnectionOptions {
  /** Test-only: after this many successful `.query()` calls on this connection, the next call throws and the connection's own uncommitted buffer and locks are discarded — see this file's own top-of-file doc comment. `undefined` (the default) never crashes. */
  crashAfterStatements?: number;
  /** D2, test-only: after this many successful `.query()` calls on this connection, the `(N+1)`th call suspends until `pauseGate` resolves — see this file's own top-of-file doc comment on the pause mechanism, and `source.ts`'s `armNextConnectionPause`. `undefined` (the default) never pauses. */
  pauseAfterStatements?: number;
  /** D2, test-only: the `Promise` a paused statement `await`s before proceeding — resolved externally by the `resume` callback `armNextConnectionPause` returns. Only meaningful together with `pauseAfterStatements`. */
  pauseGate?: Promise<void>;
  /** D4 (`docs/DECISIONS.md` D-101), test-only: called synchronously the instant this connection's own pause condition genuinely fires — before `pauseGate` is ever awaited. `src/store/dst/scheduler.ts`'s `raceUnderPause` awaits this instead of guessing "probably paused by now" from a microtask-count heuristic, which a full-repo adversarial review found was silently vacuous for `productionCheck`'s own real statement sequence (it settles in more microtask hops than the old heuristic's fixed budget drained). Only meaningful together with `pauseAfterStatements`. */
  notifyPauseFired?: () => void;
  /**
   * `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "The genuinely new fault
   * class" — test-only: after this many successful `.query()` calls on this
   * connection, the next statement throws an injected error AND poisons this
   * connection — every later statement fails with `current transaction is
   * aborted, commands ignored until end of transaction block` until a
   * `ROLLBACK` (the whole transaction) or a `ROLLBACK TO SAVEPOINT LEOPARD_
   * LOOKUP` restores it. Unlike `crashAfterStatements`, the connection itself
   * survives — this models a real mid-transaction SQL error (a lock-wait
   * timeout, a deadlock) rather than the connection dying outright. See this
   * file's own top-of-file doc comment on the pause mechanism for the
   * identical "the fake needs to construct this deterministically, real
   * Postgres has no controllable equivalent" reasoning applied here to a
   * different fault shape. `undefined` (the default) never poisons.
   */
  poisonAfterStatements?: number;
}

const enum TxState {
  Idle = 'idle',
  Open = 'open',
  /** D2 — a `REPEATABLE READ READ ONLY` snapshot transaction; see this file's own top-of-file doc comment. */
  Snapshot = 'snapshot',
}

// The four real lock statement texts this codebase issues, matched by
// exact SQL text — see this file's own top-of-file doc comment. Kept
// distinct from shapes.ts's SHAPES registry deliberately: these need
// connection identity and genuine blocking, neither of which an ordinary
// ShapeHandler has access to.
const XACT_TWOINT_LOCK = normalizeSql('select pg_advisory_xact_lock($1, $2)');
const XACT_HASH_LOCK = normalizeSql('select pg_advisory_xact_lock(hashtext($1))');
const SESSION_LOCK = normalizeSql('select pg_advisory_lock($1, $2)');
const SESSION_UNLOCK = normalizeSql('select pg_advisory_unlock($1, $2)');
/**
 * `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "New lock primitive" —
 * `relation-index.ts`'s `rebuildRelationMembershipIndex`'s own advisory-lock
 * text, the first non-blocking (`_try_`) form this codebase issues. Kept
 * alongside the four blocking forms above for the identical reason: needs
 * connection identity, resolved synchronously here rather than as an
 * ordinary `ShapeHandler` (though unlike the blocking four, `tryAcquireLock`
 * itself never returns a `Promise` at all — see `locks.ts`'s own doc
 * comment).
 */
const TRY_ADVISORY_XACT_LOCK = normalizeSql('select pg_try_advisory_xact_lock($1, $2) as locked');
/** The exact literal text `resolver.ts`'s `productionCheck` issues to open its snapshot transaction — see this file's own top-of-file doc comment on `TxState.Snapshot`. */
const SNAPSHOT_BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
/**
 * `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "New transaction mode" —
 * the exact literal text `relation-index.ts`'s `rebuildRelationMembershipIndex`
 * issues to open its own `REPEATABLE READ` transaction: identical anchoring
 * behavior to `SNAPSHOT_BEGIN` above, but **writable** — see `snapshotReadOnly`
 * below and `bufferOp`'s own updated guard.
 */
const REBUILD_BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ';
/**
 * `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "The genuinely new fault
 * class" — the three exact literals `resolve()`'s relation branch
 * (`src/resolve/production/resolver.ts`) issues around its Leopard-index
 * lookup, matched case-insensitively (after `.toUpperCase()`) alongside
 * `BEGIN`/`COMMIT`/`ROLLBACK` above, exactly as those already are — never a
 * general savepoint-name-parsing engine (see the design proposal's own
 * "Considered and deferred" for why: this codebase issues exactly one
 * savepoint name today).
 */
const SAVEPOINT_LEOPARD_LOOKUP = 'SAVEPOINT LEOPARD_LOOKUP';
const RELEASE_SAVEPOINT_LEOPARD_LOOKUP = 'RELEASE SAVEPOINT LEOPARD_LOOKUP';
const ROLLBACK_TO_SAVEPOINT_LEOPARD_LOOKUP = 'ROLLBACK TO SAVEPOINT LEOPARD_LOOKUP';

/**
 * Builds this engine's own opaque lock key for the two-integer
 * `(classid, objid)` form — `tuples.ts`'s write-log lock and
 * `migrate.ts`'s migrations lock each use a distinct `classid`
 * (`WRITE_LOG_LOCK_CLASSID`/`MIGRATIONS_LOCK_CLASSID`), so this key is
 * already unique per real call site without needing anything cleverer.
 */
function twoIntLockKey(params: readonly unknown[]): string {
  const [classid, objid] = params as [number, number];
  return `twoint:${classid}:${objid}`;
}

/** Builds this engine's own opaque lock key for `publish.ts`'s `hashtext($1)` form — see `locks.ts`'s own top-of-file doc comment for why the literal namespace string, not a replicated Postgres hash, is the key. */
function hashLockKey(params: readonly unknown[]): string {
  const [namespace] = params as [string];
  return `hash:${namespace}`;
}

export class FakeConnectionImpl implements FakeConnection {
  private txState: TxState = TxState.Idle;
  private pending: PendingOp[] = [];
  private dead = false;
  private statementsExecuted = 0;
  // D2 — see this file's own top-of-file doc comment on TxState.Snapshot.
  // `snapshotSeq` is only meaningful once `snapshotAnchored` is true;
  // both reset to their initial values on COMMIT/ROLLBACK.
  private snapshotSeq: number | undefined;
  private snapshotAnchored = false;
  // D-144 (expiring tuples) — captured at the exact same anchor point as
  // `snapshotSeq` (this connection's first real query after entering
  // Snapshot mode), for the identical reason: real Postgres's `now()` is
  // fixed at a REPEATABLE READ transaction's own start, not re-evaluated
  // per statement, so every expiry check inside one check's transaction
  // must agree on one instant, exactly like every read already agrees on
  // one `visibleAsOf` commit-order boundary. `undefined` until anchored,
  // reset alongside `snapshotSeq` on COMMIT/ROLLBACK/a fresh SNAPSHOT_BEGIN.
  private snapshotNow: Date | undefined;
  /**
   * `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "New transaction mode" —
   * `true` for `SNAPSHOT_BEGIN` (`resolver.ts`'s `productionCheck`, read-only
   * by construction), `false` for `REBUILD_BEGIN`
   * (`rebuildRelationMembershipIndex`, which writes its own output). Only
   * meaningful while `txState === TxState.Snapshot` — the anchoring behavior
   * itself (freeze `visibleAsOf`/`now` at the first real query) is identical
   * either way and was never specific to read-only-ness in the first place;
   * this one boolean is the sole difference `bufferOp` below consults.
   */
  private snapshotReadOnly = true;
  // D2, test-only — see this file's own top-of-file doc comment on the
  // pause mechanism. One-shot: consumed the first time the threshold is
  // reached, never fires again on this same connection.
  private pauseConsumed = false;
  /**
   * `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "The genuinely new fault
   * class" — `true` once `poisonAfterStatements` has fired on this
   * connection, cleared only by a `ROLLBACK` (the whole transaction) or a
   * `ROLLBACK TO SAVEPOINT LEOPARD_LOOKUP` (back to the open savepoint) —
   * see this file's own top-of-file doc comment and `query()`'s own poisoned
   * check, immediately after the `dead` check.
   */
  private poisoned = false;
  /**
   * One-shot latch for `poisonAfterStatements`, deliberately separate from
   * `poisoned` itself — see this class's own `poisoned` doc comment:
   * `poisoned` is cleared by a `ROLLBACK`/`ROLLBACK TO SAVEPOINT LEOPARD_
   * LOOKUP` (by design, so the connection can recover and keep being used),
   * but `this.statementsExecuted` never goes back down, so a naive "arm
   * fires once `statementsExecuted >= threshold` and `!poisoned`" check
   * would silently re-fire on the very next statement after a successful
   * recovery — poisoning `RELEASE SAVEPOINT LEOPARD_LOOKUP` itself right
   * after `ROLLBACK TO SAVEPOINT LEOPARD_LOOKUP` legitimately un-poisoned
   * the connection. Found live while authoring D8's own test (a `RELEASE
   * SAVEPOINT` inside `resolve()`'s own `catch` block failing with a SECOND
   * poisoned-connection error, immediately after a successful recovery),
   * fixed with this dedicated latch — the same one-shot pattern
   * `pauseConsumed` above already establishes for the identical class of
   * "must fire exactly once, ever, on this connection" requirement.
   */
  private poisonConsumed = false;
  /**
   * The length of `this.pending` at the moment `SAVEPOINT LEOPARD_LOOKUP`
   * last ran on this connection, `undefined` when no savepoint is currently
   * open — a single slot, not a stack, since this codebase never nests two
   * savepoints (a second `SAVEPOINT LEOPARD_LOOKUP` while one is already
   * open throws loudly below, the same "this needs redesign" signal an
   * unexpected shape already gets elsewhere). `ROLLBACK TO SAVEPOINT
   * LEOPARD_LOOKUP` truncates `this.pending` back to exactly this length,
   * discarding only the ops buffered since the savepoint — matching real
   * Postgres's own `ROLLBACK TO SAVEPOINT` semantics precisely.
   */
  private pendingLengthAtSavepoint: number | undefined;

  constructor(
    private readonly state: FakeStoreState,
    private readonly connectionId: number,
    private readonly options: FakeConnectionOptions = {},
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<FakeQueryResult<Row>> {
    if (this.dead) {
      throw new Error(
        'DST fake connection: query issued on a connection that has already crashed — ' +
          'matches a real dead Postgres connection, which cannot run anything either, ' +
          'including ROLLBACK',
      );
    }
    // `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "The genuinely new
    // fault class" — a poisoned connection rejects everything except a
    // whole-transaction ROLLBACK or a ROLLBACK TO SAVEPOINT LEOPARD_LOOKUP,
    // matching real Postgres's own "current transaction is aborted" behavior
    // exactly, including that RELEASE SAVEPOINT LEOPARD_LOOKUP itself fails
    // the same way (real Postgres does not let you release a savepoint out
    // from under a poisoned transaction, only roll back to one) — see this
    // file's own top-of-file doc comment.
    if (this.poisoned) {
      const poisonedCheckText = sql.trim().toUpperCase();
      if (
        poisonedCheckText !== 'ROLLBACK' &&
        poisonedCheckText !== ROLLBACK_TO_SAVEPOINT_LEOPARD_LOOKUP
      ) {
        throw new Error(
          'current transaction is aborted, commands ignored until end of transaction block',
        );
      }
    }
    if (
      this.options.crashAfterStatements !== undefined &&
      this.statementsExecuted >= this.options.crashAfterStatements
    ) {
      this.dead = true;
      this.pending = [];
      // A genuinely dead backend releases everything it held, both
      // xact-scoped (its own now-discarded transaction) and session-scoped
      // — the D1 exit criterion this line exists for ("a session-lock-crash
      // test: the lock auto-releases when the holding connection dies",
      // `docs/DST-PROPOSAL.md`). Ordinary `.release()` back to a pool does
      // *not* reach this path and releases nothing — see `release()` below.
      releaseLocksForConnection(this.state.locks, this.connectionId, 'all');
      throw new Error(
        'DST fake connection: simulated crash — connection terminated mid-statement, ' +
          "this transaction's own uncommitted buffer was discarded",
      );
    }
    if (
      !this.poisonConsumed &&
      this.options.poisonAfterStatements !== undefined &&
      this.statementsExecuted >= this.options.poisonAfterStatements
    ) {
      // Unlike the crash branch above, the connection survives and
      // `this.pending` is left completely untouched — a real poisoned
      // transaction's own earlier, successfully-buffered writes are still
      // there, waiting for either a ROLLBACK (discarding all of it) or a
      // ROLLBACK TO SAVEPOINT LEOPARD_LOOKUP (discarding only what was
      // buffered since the savepoint) — see this file's own top-of-file doc
      // comment and `pendingLengthAtSavepoint`'s own doc comment.
      this.poisonConsumed = true;
      this.poisoned = true;
      throw new Error(
        'DST fake connection: simulated statement failure — this connection is now poisoned ' +
          '(current transaction is aborted, commands ignored until end of transaction block), ' +
          'matching a real mid-transaction SQL error (a lock-wait timeout, a deadlock) that ' +
          'leaves the connection alive but the transaction unusable until ROLLBACK or ROLLBACK ' +
          'TO SAVEPOINT LEOPARD_LOOKUP',
      );
    }
    if (
      !this.pauseConsumed &&
      this.options.pauseAfterStatements !== undefined &&
      this.statementsExecuted === this.options.pauseAfterStatements &&
      this.options.pauseGate
    ) {
      this.pauseConsumed = true;
      this.options.notifyPauseFired?.();
      await this.options.pauseGate;
    }
    this.statementsExecuted += 1;

    const normalized = sql.trim().toUpperCase();
    if (normalized === 'BEGIN') {
      this.txState = TxState.Open;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === SNAPSHOT_BEGIN) {
      this.txState = TxState.Snapshot;
      this.snapshotReadOnly = true;
      this.snapshotAnchored = false;
      this.snapshotSeq = undefined;
      this.snapshotNow = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === REBUILD_BEGIN) {
      // Identical anchoring behavior to SNAPSHOT_BEGIN above — the only
      // difference is `snapshotReadOnly`, which `bufferOp` below consults;
      // see this file's own top-of-file doc comment on `snapshotReadOnly`.
      this.txState = TxState.Snapshot;
      this.snapshotReadOnly = false;
      this.snapshotAnchored = false;
      this.snapshotSeq = undefined;
      this.snapshotNow = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === 'COMMIT') {
      const commitSeq = this.state.nextCommitSeq;
      this.state.nextCommitSeq += 1;
      for (const op of this.pending) op(this.state, commitSeq);
      this.pending = [];
      this.txState = TxState.Idle;
      this.snapshotAnchored = false;
      this.snapshotSeq = undefined;
      this.snapshotNow = undefined;
      this.poisoned = false;
      this.pendingLengthAtSavepoint = undefined;
      // Postgres releases every transaction-scoped advisory lock this
      // session holds at COMMIT, unconditionally — not just ones acquired
      // in exactly this statement sequence. Session-scoped locks (the
      // migrations lock) are untouched here — see locks.ts's own doc
      // comment on the two lifetime models.
      releaseLocksForConnection(this.state.locks, this.connectionId, 'xact');
      return { rows: [], rowCount: 0 };
    }
    if (normalized === 'ROLLBACK') {
      this.pending = [];
      this.txState = TxState.Idle;
      this.snapshotAnchored = false;
      this.snapshotSeq = undefined;
      this.snapshotNow = undefined;
      // A whole-transaction ROLLBACK restores a poisoned connection too —
      // see this file's own top-of-file doc comment on the poisoning fault
      // class.
      this.poisoned = false;
      this.pendingLengthAtSavepoint = undefined;
      // Postgres releases xact-scoped advisory locks on ROLLBACK exactly
      // as it does on COMMIT — see the COMMIT branch's own comment above.
      releaseLocksForConnection(this.state.locks, this.connectionId, 'xact');
      return { rows: [], rowCount: 0 };
    }
    if (normalized === SAVEPOINT_LEOPARD_LOOKUP) {
      if (this.pendingLengthAtSavepoint !== undefined) {
        // This codebase issues exactly one savepoint name today — a second,
        // nested SAVEPOINT LEOPARD_LOOKUP on the same connection before the
        // first is released/rolled back is the same "this needs redesign"
        // signal an unrecognized shape already gets elsewhere, not a
        // silently-supported stack — see `pendingLengthAtSavepoint`'s own
        // doc comment.
        throw new Error(
          'DST fake connection: SAVEPOINT LEOPARD_LOOKUP issued while a savepoint is already ' +
            'open on this connection — this codebase never nests two savepoints',
        );
      }
      this.pendingLengthAtSavepoint = this.pending.length;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === RELEASE_SAVEPOINT_LEOPARD_LOOKUP) {
      if (this.pendingLengthAtSavepoint === undefined) {
        throw new Error(
          'DST fake connection: RELEASE SAVEPOINT LEOPARD_LOOKUP issued with no open ' +
            'SAVEPOINT LEOPARD_LOOKUP on this connection',
        );
      }
      this.pendingLengthAtSavepoint = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === ROLLBACK_TO_SAVEPOINT_LEOPARD_LOOKUP) {
      if (this.pendingLengthAtSavepoint === undefined) {
        throw new Error(
          'DST fake connection: ROLLBACK TO SAVEPOINT LEOPARD_LOOKUP issued with no open ' +
            'SAVEPOINT LEOPARD_LOOKUP on this connection',
        );
      }
      // Discards exactly the ops buffered since the savepoint, restoring
      // everything before it — matching real Postgres's own ROLLBACK TO
      // SAVEPOINT semantics precisely (see this file's own top-of-file doc
      // comment). The savepoint itself remains open afterward, exactly like
      // real Postgres (a subsequent RELEASE SAVEPOINT LEOPARD_LOOKUP is
      // still valid, and is exactly what `resolve()`'s own catch block does
      // immediately after this).
      this.pending.length = this.pendingLengthAtSavepoint;
      this.poisoned = false;
      return { rows: [], rowCount: 0 };
    }

    // D2 — REPEATABLE READ's snapshot anchors at the transaction's first
    // *real* query, never at BEGIN itself (see this file's own top-of-file
    // doc comment). This is that anchor point: the first non-transaction-
    // control statement reached while in Snapshot mode. D-144 (expiring
    // tuples) — `snapshotNow` is captured here too, in the same statement,
    // for the identical reason `snapshotSeq` already is: see this class's
    // own `snapshotNow` field doc comment.
    if (this.txState === TxState.Snapshot && !this.snapshotAnchored) {
      this.snapshotSeq = this.state.nextCommitSeq - 1;
      this.snapshotNow = this.state.now;
      this.snapshotAnchored = true;
    }
    const visibleAsOf = this.txState === TxState.Snapshot ? this.snapshotSeq : undefined;
    // D-144 — outside a snapshot transaction, "now" is just the fake's
    // current clock directly (mirroring `visibleAsOf`'s own "no boundary"
    // fallback conceptually, though `now` always has a concrete value,
    // never `undefined` — every expiry filter needs a real instant to
    // compare against, unlike a commit-order ceiling which can genuinely be
    // absent).
    const now =
      this.txState === TxState.Snapshot && this.snapshotNow ? this.snapshotNow : this.state.now;

    const key = normalizeSql(sql);

    if (key === XACT_TWOINT_LOCK || key === XACT_HASH_LOCK) {
      const lockKey = key === XACT_TWOINT_LOCK ? twoIntLockKey(params) : hashLockKey(params);
      await acquireLock(this.state.locks, lockKey, this.connectionId, 'xact');
      if (this.txState === TxState.Idle) {
        // Real Postgres ties pg_advisory_xact_lock to the *current*
        // transaction, including the implicit, single-statement one a bare
        // autocommit query runs inside — that implicit transaction commits
        // the instant this statement finishes, so the lock is released
        // right back, immediately. Not exercised by any real call site in
        // this codebase today (tuples.ts/publish.ts always acquire this
        // lock as the first statement after an explicit BEGIN), but a
        // fake that silently held the lock forever in this case would be a
        // real, if currently latent, fidelity gap.
        releaseLock(this.state.locks, lockKey, this.connectionId);
      }
      return { rows: [{}], rowCount: 1 } as FakeQueryResult<Row>;
    }

    if (key === SESSION_LOCK) {
      const lockKey = twoIntLockKey(params);
      await acquireLock(this.state.locks, lockKey, this.connectionId, 'session');
      return { rows: [{}], rowCount: 1 } as FakeQueryResult<Row>;
    }

    if (key === SESSION_UNLOCK) {
      const lockKey = twoIntLockKey(params);
      const released = releaseLock(this.state.locks, lockKey, this.connectionId);
      // Matches real Postgres's own pg_advisory_unlock: returns false, does
      // not throw, if this connection doesn't actually hold the lock.
      return { rows: [{ pg_advisory_unlock: released }], rowCount: 1 } as FakeQueryResult<Row>;
    }

    if (key === TRY_ADVISORY_XACT_LOCK) {
      // No queueing, no `await` — the entire point of the `_try_` form is
      // that it never waits (see `locks.ts`'s own `tryAcquireLock` doc
      // comment and this file's own top-of-file doc comment on the new lock
      // primitive). Released the same way every other xact-scoped lock is:
      // `connection.ts`'s own COMMIT/ROLLBACK handling above.
      const lockKey = twoIntLockKey(params);
      const locked = tryAcquireLock(this.state.locks, lockKey, this.connectionId, 'xact');
      return { rows: [{ locked }], rowCount: 1 } as FakeQueryResult<Row>;
    }

    const handler = lookupShape(sql);
    const bufferOp = (op: PendingOp): void => {
      if (this.txState === TxState.Snapshot && this.snapshotReadOnly) {
        // Read-only, enforced by construction, not just left as an
        // unstated assumption — see this file's own top-of-file doc
        // comment. Nothing in productionCheck's real call surface ever
        // reaches here; this exists to fail loudly if that ever changes.
        // A REBUILD_BEGIN-opened Snapshot transaction (`snapshotReadOnly ===
        // false`) never reaches this branch at all — see
        // `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "New transaction
        // mode" and this class's own `snapshotReadOnly` doc comment.
        throw new Error(
          'DST fake connection: a write was attempted inside a REPEATABLE READ READ ONLY ' +
            'snapshot transaction — real Postgres would reject this too',
        );
      }
      if (this.txState === TxState.Open) {
        this.pending.push(op);
        return;
      }
      // Autocommit — a bare query outside any BEGIN/COMMIT commits its own
      // effect immediately, matching real Postgres's own per-statement
      // implicit transaction. Not exercised by writeTuple/deleteTuple
      // (they always run inside an explicit transaction) but kept correct
      // for any future caller that issues a write outside one.
      const commitSeq = this.state.nextCommitSeq;
      this.state.nextCommitSeq += 1;
      op(this.state, commitSeq);
    };
    // The generic `Row` here is a caller-side type assertion, not a
    // runtime-verified shape — matches the real `pg` driver's own
    // `.query<Row>(...)` exactly: it doesn't validate the requested
    // generic against what actually came back either.
    return handler({
      state: this.state,
      params,
      bufferOp,
      visibleAsOf,
      now,
    }) as FakeQueryResult<Row>;
  }

  release(): void {
    // Nothing to release in-memory beyond what COMMIT/ROLLBACK/crash
    // already did — deliberately does *not* touch this.state.locks:
    // matches pg.PoolClient's own contract exactly (returns the connection
    // to the pool; a session-scoped advisory lock survives that and stays
    // held until an explicit unlock or the underlying session actually
    // ending — see migrate.ts's own doc comment on MIGRATIONS_LOCK_CLASSID
    // and locks.ts's own top-of-file note).
  }
}
