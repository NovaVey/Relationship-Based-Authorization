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
}

export function createFakeStoreState(): FakeStoreState {
  return {
    relationTuples: [],
    writeLog: [],
    namespaceConfigs: [],
    nextRelationTupleId: 1,
    nextToken: 1,
    nextCommitSeq: 1,
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
