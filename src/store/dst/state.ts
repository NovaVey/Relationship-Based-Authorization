/**
 * The in-memory tables backing DST's fake store — DST D0
 * (`docs/DST-PROPOSAL.md`, `docs/DECISIONS.md` D-095/D-097). Deliberately a
 * plain, mutable data structure, not a class with methods: every real
 * mutation this file's own SQL-shape handlers (`shapes.ts`) perform is a
 * closure applied by `connection.ts` at commit time, so the actual write
 * path lives there, not here — this file only defines the shape of what
 * gets stored and how a fresh, empty instance is created.
 *
 * Every committed row carries `commitSeq`, the connection-teardown-ordering
 * counter `connection.ts`'s `COMMIT` handling assigns atomically — D0 does
 * not yet filter reads by it (no `productionCheck`-style `REPEATABLE READ`
 * snapshot exists until D2, per `docs/DST-PROPOSAL.md`'s own phase plan),
 * but the field exists now, populated correctly, so D2's snapshot-filtering
 * work has real data to read rather than a schema change bundled with new
 * behavior at the same time.
 */
import type { NamespaceConfig } from '../../schema/dsl/types.js';
import type { TupleKey } from '../tuples.js';
import { createLocksState, type LocksState } from './locks.js';

export interface RelationTupleRow {
  /** `pg`'s own bigint-as-string convention — see `shapes.ts`'s own row-shape-fidelity note for why this is deliberately `string`, not `number`. */
  id: string;
  objectNs: string;
  objectId: string;
  relation: string;
  subjectNs: string;
  subjectId: string;
  subjectRelation: string | null;
  createdAt: Date;
  commitSeq: number;
  /**
   * D-144 (expiring tuples) — mirrors `relation_tuples.expires_at` exactly:
   * `null` means this tuple never expires. Filtered by every snapshot-aware
   * read handler (`shapes.ts`) the same way `isVisible`/`visibleAsOf`
   * already filters by commit-order visibility, except this dimension is
   * anchored against `FakeStoreState.now` (a fake, test-controlled clock),
   * never the real wall clock — see that field's own doc comment for why.
   */
  expiresAt: Date | null;
  /**
   * Delete-tombstone visibility (`docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s
   * own "A related observation, found while reading" section, confirmed a
   * real gap and closed here). `undefined` means this row has never been
   * deleted; a real `commitSeq` means the `DELETE` that removed it committed
   * at that sequence number. **Deliberately the exact opposite of
   * `RelationMembershipIndexRow`'s own "unconditionally spliced" model** —
   * see that interface's own doc comment for why a whole-table `TRUNCATE`
   * genuinely doesn't participate in per-row MVCC, while a plain per-row
   * `DELETE` genuinely does: real Postgres's `REPEATABLE READ` gives an
   * older snapshot's own already-anchored read a guarantee that it will
   * never observe the effect of a transaction that committed after that
   * snapshot's own anchor — including a later `DELETE` of a row the
   * snapshot already considers live. `tupleInsertHandler` models this for
   * inserts by tagging a new row with the inserting commit's own
   * `commitSeq` and having every reader compare it against `visibleAsOf`;
   * this field is the identical idea applied to the *other* end of a row's
   * visible lifetime — its `xmax`, in real Postgres's own MVCC vocabulary,
   * mirroring `commitSeq`'s own role as its `xmin`. A row is visible to a
   * read carrying `visibleAsOf` iff it was inserted at-or-before that
   * boundary **and** (it was never deleted, or the delete that removed it
   * committed strictly *after* that boundary) — see `shapes.ts`'s own
   * `isTupleVisible` for the one place this exact rule is stated in code.
   * A tombstoned row is never physically spliced out of `relationTuples` —
   * see `tupleDeleteHandler`'s own doc comment (`shapes.ts`) for why that is
   * the deliberate, simplest-correct choice for this short-lived, in-memory,
   * per-test-process harness, not an oversight.
   */
  deletedAtCommitSeq?: number;
}

export interface WriteLogRow {
  /** Also deliberately `string` — see `RelationTupleRow.id`'s own note. */
  token: string;
  operation: 'write' | 'delete';
  tuple: TupleKey;
  writtenAt: Date;
  commitSeq: number;
}

export interface NamespaceConfigRow {
  namespace: string;
  version: number;
  config: NamespaceConfig;
  sourceDsl: string;
  commitSeq: number;
}

/**
 * `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "The model" section — one
 * row per `(object, relation, subject)` the Leopard index's offline rebuild
 * (`rebuildRelationMembershipIndex`, `src/store/relation-index.ts`)
 * publishes. **Deliberately reuses `tupleDeleteHandler`'s own unconditional
 * array-splice-at-commit shape, not `namespace_configs`'s own
 * generation-list-by-`commitSeq` shape** — the proposal's own doc comment
 * discloses, at length, why a generation-list model would be *wrong* here:
 * real Postgres's `TRUNCATE` swaps the underlying relfilenode rather than
 * participating in ordinary per-row MVCC visibility the way `DELETE`/an
 * `UPDATE`-versioned row does, so an older `REPEATABLE READ` snapshot whose
 * own read happens to run *after* a later rebuild's `TRUNCATE` already
 * committed must see the table as **empty**, never the prior generation —
 * exactly backwards from what a "pick the highest generation `commitSeq <=
 * visibleAsOf`" read would produce. Plain array + `isVisible`/`commitSeq`
 * gives this behavior for free: the `TRUNCATE`'s own `bufferOp`
 * unconditionally clears whatever the array currently holds (see
 * `shapes.ts`'s own truncate handler), so a reader anchored before a later
 * `TRUNCATE`'s commit finds the array already emptied by the time its own
 * statement runs, with nothing generation-aware needed to produce that.
 */
export interface RelationMembershipIndexRow {
  objectNs: string;
  objectId: string;
  relation: string;
  subjectNs: string;
  subjectId: string;
  viaPath: string[];
  minExpiresAt: Date | null;
  commitSeq: number;
}

/**
 * `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "The model" section —
 * `relation_membership_index_state.watermark_token`, by contrast, genuinely
 * *is* a versioned-row question: an ordinary `UPDATE ... WHERE id = 1`
 * against a real single row, where ordinary Postgres MVCC *does* preserve an
 * older row version for an older snapshot — the identical
 * `NamespaceConfigRow`/`latestNamespaceConfigHandler` "pick the highest
 * version tagged by `commitSeq` within my visibility ceiling" pattern is the
 * *correct* reuse here, not a mistake to correct the way the row-table shape
 * above is. `rebuild_started_at`/`rebuild_finished_at`/`row_count` are
 * deliberately not modeled at all — see this proposal's own disclosure:
 * "never a soundness concern — no check ever reads this column; only
 * `watermark_token`... gates any ALLOW."
 */
export interface RelationMembershipIndexStateVersion {
  watermarkToken: number;
  commitSeq: number;
}

export interface FakeStoreState {
  relationTuples: RelationTupleRow[];
  writeLog: WriteLogRow[];
  namespaceConfigs: NamespaceConfigRow[];
  /**
   * The next identity-column values this store will allocate — real
   * Postgres allocates a `generated always as identity` value at
   * INSERT-statement-execution time, non-transactionally, independent of
   * whether that statement's own transaction ever commits (including when
   * an `ON CONFLICT ... DO NOTHING` clause ends up applying zero rows —
   * Postgres's own well-known identity-column-gap behavior: the sequence
   * still advances). `shapes.ts`'s insert handlers replicate this exactly:
   * these counters advance the moment a handler runs, never deferred to
   * commit time, so a crashed or rolled-back transaction's own attempted
   * insert still burns the id/token it would have used — the same gap a
   * real crashed Postgres transaction leaves behind.
   */
  nextRelationTupleId: number;
  nextToken: number;
  /** The next commit-sequence number `connection.ts`'s `COMMIT` handling will assign — see this file's own top-of-file doc comment. */
  nextCommitSeq: number;
  /** DST D1 (`docs/DECISIONS.md` D-098) — the shared advisory-lock table every connection on this state contends against. See `locks.ts`'s own top-of-file doc comment. */
  locks: LocksState;
  /**
   * D-144 (expiring tuples) — the fake's own controllable "current time,"
   * used ONLY to decide whether a tuple's `expiresAt` has passed. Defaults
   * to the epoch (`new Date(0)`), matching this file's own established "DST
   * is deterministic — no wall-clock reads" convention (see
   * `tupleInsertHandler`'s identical `createdAt: new Date(0)` precedent in
   * `shapes.ts`) — a test that never sets an `expiresAt` or never advances
   * this field is completely unaffected, since every tuple with a `null`
   * `expiresAt` is live regardless of what this holds. A test proving the
   * expiry mechanic itself advances this explicitly (`FakeConnectionSource
   * .setNow`, `source.ts`) to simulate real time passing, with zero actual
   * waiting and zero real nondeterminism — the same "construct the race,
   * don't wait for it" philosophy `armNextConnectionPause` already
   * established for concurrency, applied here to time instead.
   */
  now: Date;
  /**
   * `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "The model" section —
   * see `RelationMembershipIndexRow`'s own doc comment above for why this is
   * a plain array, unconditionally spliced by the rebuild's own `TRUNCATE`
   * handler, never a generation list.
   */
  relationMembershipIndex: RelationMembershipIndexRow[];
  /**
   * `docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`'s own "The model" section —
   * see `RelationMembershipIndexStateVersion`'s own doc comment above.
   */
  relationMembershipIndexStateVersions: RelationMembershipIndexStateVersion[];
}

export function createFakeStoreState(): FakeStoreState {
  return {
    relationTuples: [],
    writeLog: [],
    namespaceConfigs: [],
    nextRelationTupleId: 1,
    nextToken: 1,
    nextCommitSeq: 1,
    locks: createLocksState(),
    now: new Date(0),
    relationMembershipIndex: [],
    relationMembershipIndexStateVersions: [],
  };
}

/**
 * Test-only seeding: publishes `config` directly into the fake's
 * `namespace_configs` table, bypassing `publishSchema`/`publishOne`
 * entirely. Publishing itself is not part of D0's own scope
 * (`docs/DST-PROPOSAL.md`'s phase plan puts the advisory-lock work
 * `publishOne` depends on in D1) — this exists purely so a D0 test can get
 * `writeTuple`'s own schema-validation step (`getLatestNamespaceConfig`) to
 * succeed against a real, compiler-produced `NamespaceConfig`, without
 * needing the publish path's own locking machinery to exist yet. Committed
 * immediately (a fresh `commitSeq`, no pending/rollback semantics) — this
 * is fixture setup, not a simulated write a test's own assertions are
 * about.
 */
export function seedNamespaceConfig(state: FakeStoreState, config: NamespaceConfig): void {
  const existingVersions = state.namespaceConfigs
    .filter((row) => row.namespace === config.namespace)
    .map((row) => row.version);
  const version = existingVersions.length > 0 ? Math.max(...existingVersions) + 1 : 1;
  const commitSeq = state.nextCommitSeq;
  state.nextCommitSeq += 1;
  state.namespaceConfigs.push({
    namespace: config.namespace,
    version,
    config,
    sourceDsl: '',
    commitSeq,
  });
}
