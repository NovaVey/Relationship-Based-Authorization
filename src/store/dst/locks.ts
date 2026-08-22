/**
 * The advisory-lock engine backing DST D1 (`docs/DST-PROPOSAL.md`'s
 * `withAdvisoryLock`, `docs/DECISIONS.md` D-098) — a real, Promise-based
 * mutex with a FIFO wait queue, shared across every `FakeConnectionImpl`
 * that operates on the same `FakeStoreState`. This file knows nothing
 * about SQL: `connection.ts` is the only place that recognizes the four
 * real lock statement texts (`pg_advisory_xact_lock($1,$2)`,
 * `pg_advisory_xact_lock(hashtext($1))`, `pg_advisory_lock($1,$2)`,
 * `pg_advisory_unlock($1,$2)`) and turns them into calls against the
 * plain key/connection/scope primitives below — the same separation D0
 * already draws between `shapes.ts` (SQL recognition) and `state.ts`
 * (storage), applied here to locking instead.
 *
 * **Why this is a real queue, not a boolean flag.** A boolean "is it
 * held" can express mutual exclusion but not *blocking* — the property
 * this project's own D-083 regression test exists to prove
 * (`test/unit/store/tuple-store.integration.test.ts`'s
 * "a-writeTuple-call-genuinely-blocks-behind-an-earlier-uncommitted-
 * transaction..."): a second caller's own `await` must genuinely stall,
 * for as long as the first holder keeps the lock, and resume only once
 * it's actually granted — not spin, not silently reorder, not resolve
 * early. `acquireLock` below returns a `Promise` that only settles when
 * `grant()` is invoked, which happens exactly once, exactly when the key
 * becomes this waiter's turn — nothing here polls or races on a timer.
 * Because JS's own `await` always defers to a microtask even for an
 * already-resolved promise, driving two connections concurrently via
 * `Promise.all([a(), b()])` interleaves them at every `await` boundary
 * for free — sufficient for D1's genuine-concurrency testing without a
 * seeded scheduler (that's D4's job, per `docs/DST-PROPOSAL.md`'s own
 * phased plan).
 *
 * **Two lifetime models, one engine.** `scope: 'xact'` locks are released
 * by `connection.ts`'s `COMMIT`/`ROLLBACK` handling (a blanket "release
 * every xact-scoped lock this connection holds," mirroring the fact that
 * Postgres releases *every* transaction-scoped advisory lock a session
 * holds at that transaction's end, not just one). `scope: 'session'`
 * locks are released only by an explicit matching `pg_advisory_unlock`
 * call (`releaseLock`) or by the holding connection dying outright
 * (`releaseLocksForConnection(..., 'all')`, `connection.ts`'s own crash
 * path) — never by that connection's `COMMIT`/`ROLLBACK`, and never by
 * `.release()` back to a pool, matching real Postgres's own documented
 * behavior (`src/store/migrate.ts`'s own doc comment on
 * `MIGRATIONS_LOCK_CLASSID`) that a session-scoped advisory lock survives
 * a `PoolClient.release()` and is tied to the underlying session, not the
 * pool checkout.
 *
 * **Keys are opaque strings, not replicated Postgres hash values.**
 * `publish.ts`'s real lock text is `pg_advisory_xact_lock(hashtext($1))`
 * — a genuine Postgres hash of the namespace string. This engine does not
 * reimplement `hashtext()`; a lock key here only needs the property a
 * hash also provides for this purpose (the same input always maps to the
 * same key, different inputs "almost certainly" map to different keys),
 * and using the literal namespace string as the key gives that property
 * exactly, with zero collision risk instead of merely low risk. See
 * `connection.ts`'s own key-building helpers for how each of the four
 * real lock forms is mapped to a key here.
 */

export type LockScope = 'xact' | 'session';

interface HeldLock {
  connectionId: number;
  scope: LockScope;
}

interface Waiter {
  connectionId: number;
  grant: () => void;
}

export interface LocksState {
  /** Lock key → whoever currently holds it. Absent = free. */
  held: Map<string, HeldLock>;
  /** Lock key → FIFO queue of everyone waiting for it, in arrival order. */
  waiters: Map<string, Waiter[]>;
}

export function createLocksState(): LocksState {
  return { held: new Map(), waiters: new Map() };
}

/**
 * Acquires `key` for `connectionId` at `scope`. Resolves immediately if
 * the key is free; otherwise resolves only once every earlier
 * holder/waiter has released it and this waiter is granted, in strict
 * arrival order (FIFO) — a reasonable, documented-enough approximation of
 * Postgres's own advisory-lock queueing for this project's purposes;
 * nothing here depends on Postgres's exact fairness guarantees, only on
 * "a blocked waiter eventually gets the lock once it's free," which FIFO
 * guarantees.
 */
export function acquireLock(
  locks: LocksState,
  key: string,
  connectionId: number,
  scope: LockScope,
): Promise<void> {
  const current = locks.held.get(key);
  if (!current) {
    locks.held.set(key, { connectionId, scope });
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const queue = locks.waiters.get(key) ?? [];
    queue.push({
      connectionId,
      grant: () => {
        locks.held.set(key, { connectionId, scope });
        resolve();
      },
    });
    locks.waiters.set(key, queue);
  });
}

/** Pops and grants the next waiter for `key`, if any — called after every release, whether via explicit unlock, COMMIT/ROLLBACK, or connection death. */
function grantNext(locks: LocksState, key: string): void {
  const queue = locks.waiters.get(key);
  if (!queue || queue.length === 0) return;
  const next = queue.shift();
  if (queue.length === 0) locks.waiters.delete(key);
  next?.grant();
}

/**
 * Releases every lock `connectionId` currently holds matching `scope`
 * (`'all'` releases both scopes at once) — `connection.ts`'s
 * `COMMIT`/`ROLLBACK` handling calls this with `'xact'`; its crash path
 * calls it with `'all'`, modeling a genuinely dead backend releasing
 * everything it held, session-scoped included.
 *
 * Snapshots the keys to release before mutating `locks.held`: releasing
 * one key can synchronously grant it to a queued waiter (`grantNext`),
 * which re-inserts that key into `held` — iterating and deleting from the
 * *same* live `Map` in one pass would risk revisiting that just-reinserted
 * entry, since `Map` iteration order reflects insertion order and a
 * delete-then-set within one iteration moves an entry to the end. Snapshot
 * first, then mutate — no such risk.
 */
export function releaseLocksForConnection(
  locks: LocksState,
  connectionId: number,
  scope: LockScope | 'all',
): void {
  const keysToRelease: string[] = [];
  for (const [key, holder] of locks.held) {
    if (holder.connectionId !== connectionId) continue;
    if (scope !== 'all' && holder.scope !== scope) continue;
    keysToRelease.push(key);
  }
  for (const key of keysToRelease) {
    locks.held.delete(key);
    grantNext(locks, key);
  }
}

/**
 * Explicit `pg_advisory_unlock($1, $2)` — releases exactly one
 * session-scoped lock, only if `connectionId` is the one actually holding
 * it. Returns whether a lock was actually released, matching real
 * Postgres's own `pg_advisory_unlock` return value (`false`, not an
 * error, if the caller doesn't hold it) — `connection.ts` surfaces this
 * as the query result's own row, exactly as a real `pg` client would see
 * it.
 */
export function releaseLock(locks: LocksState, key: string, connectionId: number): boolean {
  const holder = locks.held.get(key);
  if (!holder || holder.connectionId !== connectionId) return false;
  locks.held.delete(key);
  grantNext(locks, key);
  return true;
}
