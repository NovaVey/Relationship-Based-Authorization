/**
 * DST D1's own exit criterion (`docs/DST-PROPOSAL.md`, `docs/DECISIONS.md`
 * D-098): the D-083 reordering regression, generalized across seeds, plus a
 * session-lock-crash test proving a session-scoped lock auto-releases when
 * its holding connection dies. No Postgres, no Testcontainers — every test
 * below runs against the in-memory fake and `locks.ts`'s real, blocking
 * lock engine, the same "simulate at the storage seam" boundary D0 already
 * established (`docs/DECISIONS.md` D-095).
 *
 * Seeded draws below go through `src/store/dst/scheduler.ts`'s
 * `dstRngFromSeed` (DST D4, `docs/DECISIONS.md` D-101) — previously a
 * small, local `mulberry32` PRNG lived in this file, explicitly documented
 * as not yet worth sharing ("rule of three"); D4 is that third use
 * (`production-check.dst.test.ts` carried an identical copy), so both are
 * now retired in favor of the one shared implementation.
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../../src/schema/dsl/compiler.js';
import {
  writeTuple,
  deleteTuple,
  WRITE_LOG_LOCK_CLASSID,
  WRITE_LOG_LOCK_OBJID,
  type TupleKey,
} from '../../../../src/store/tuples.js';
import { currentToken } from '../../../../src/store/tokens.js';
import { MIGRATIONS_LOCK_CLASSID, MIGRATIONS_LOCK_OBJID } from '../../../../src/store/migrate.js';
import {
  createFakeStoreState,
  createFakeConnectionSource,
  seedNamespaceConfig,
  type FakeConnectionSource,
} from '../../../../src/store/dst/index.js';
import { dstRngFromSeed, flushMicrotasks } from '../../../../src/store/dst/scheduler.js';

const SCHEMA_SOURCE = ['namespace document {', '  relation viewer: user', '}'].join('\n');

function compiledDocumentNamespace() {
  const compiled = compileSchema(SCHEMA_SOURCE);
  if (!compiled.ok) {
    throw new Error(`fixture schema failed to compile: ${JSON.stringify(compiled.errors)}`);
  }
  const namespace = compiled.schema.namespaces.document;
  if (!namespace) throw new Error('fixture schema did not produce a document namespace');
  return namespace;
}

function freshSource(): {
  state: ReturnType<typeof createFakeStoreState>;
  source: FakeConnectionSource;
} {
  const state = createFakeStoreState();
  seedNamespaceConfig(state, compiledDocumentNamespace());
  return { state, source: createFakeConnectionSource(state) };
}

/**
 * Mirrors `writeTuple`'s own real statement sequence by hand, on a raw fake
 * connection: `BEGIN` → acquire the *real* global write-log lock
 * (`WRITE_LOG_LOCK_CLASSID`/`OBJID`, imported from `src/store/tuples.ts`
 * for exactly this purpose — see that export's own doc comment) → insert
 * the tuple → insert the write-log row `RETURNING token` — deliberately
 * leaving the transaction open, uncommitted, exactly the "slow to commit"
 * half of the D-083 race. Matches `test/unit/store/tuple-store.integration
 * .test.ts`'s own raw-`pg.Client` mirroring of the identical sequence
 * against real Postgres.
 */
async function beginAndHoldWriteLogLock(
  conn: { query: FakeConnectionSource['query'] },
  tuple: TupleKey,
  operation: 'write' | 'delete',
): Promise<number> {
  await conn.query('BEGIN');
  await conn.query('select pg_advisory_xact_lock($1, $2)', [
    WRITE_LOG_LOCK_CLASSID,
    WRITE_LOG_LOCK_OBJID,
  ]);
  if (operation === 'write') {
    await conn.query(
      `insert into relation_tuples
         (object_ns, object_id, relation, subject_ns, subject_id, subject_relation)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (object_ns, object_id, relation, subject_ns, subject_id, coalesce(subject_relation, ''))
       do nothing`,
      [
        tuple.objectNs,
        tuple.objectId,
        tuple.relation,
        tuple.subjectNs,
        tuple.subjectId,
        tuple.subjectRelation ?? null,
      ],
    );
  } else {
    await conn.query(
      `delete from relation_tuples
       where object_ns = $1 and object_id = $2 and relation = $3
         and subject_ns = $4 and subject_id = $5
         and coalesce(subject_relation, '') = coalesce($6, '')`,
      [
        tuple.objectNs,
        tuple.objectId,
        tuple.relation,
        tuple.subjectNs,
        tuple.subjectId,
        tuple.subjectRelation ?? null,
      ],
    );
  }
  const { rows } = await conn.query<{ token: string }>(
    `insert into write_log (operation, tuple) values ($1, $2) returning token`,
    [operation, JSON.stringify(tuple)],
  );
  const token = Number(rows[0]?.token);
  expect(Number.isInteger(token)).toBe(true);
  return token;
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

describe('the global write-log lock genuinely serializes writeTuple/deleteTuple across connections — the D-083 regression, generalized across seeds (D-098)', () => {
  it.each(SEEDS)(
    "seed=%i: every bystander writeTuple/deleteTuple call genuinely blocks behind the held lock, and every bystander token exceeds the holder's",
    async (seed) => {
      const rng = dstRngFromSeed(`lock-race-${seed}`);
      const { state, source } = freshSource();
      const bystanderCount = rng.nextIntBetween(2, 4);

      // Pre-seed one tuple per potential delete-bystander so a delete has
      // something real to act on — committed uncontended, before the race.
      const bystanderTuples: TupleKey[] = [];
      const bystanderOps: Array<'write' | 'delete'> = [];
      for (let i = 0; i < bystanderCount; i += 1) {
        const tuple: TupleKey = {
          objectNs: 'document',
          objectId: `bystander_${seed}_${i}`,
          relation: 'viewer',
          subjectNs: 'user',
          subjectId: `user_${seed}_${i}`,
        };
        bystanderTuples.push(tuple);
        const op = rng.nextBoolean() ? 'write' : 'delete';
        bystanderOps.push(op);
        if (op === 'delete') {
          const seedResult = await writeTuple(source, tuple);
          expect(seedResult.ok).toBe(true);
        }
      }

      // The holder: a raw connection that acquires the real global lock and
      // holds its transaction open, uncommitted — the "slow to commit" half
      // of the race, exactly like the real Postgres regression test's own
      // `clientA`.
      const holderConn = await source.connect();
      const holderTuple: TupleKey = {
        objectNs: 'document',
        objectId: `holder_${seed}`,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: `holder_user_${seed}`,
      };
      const holderOp: 'write' | 'delete' = rng.nextBoolean() ? 'write' : 'delete';
      if (holderOp === 'delete') {
        const seedResult = await writeTuple(source, holderTuple);
        expect(seedResult.ok).toBe(true);
      }
      const holderToken = await beginAndHoldWriteLogLock(holderConn, holderTuple, holderOp);

      // Concurrently, real writeTuple/deleteTuple calls for unrelated
      // objects — every one of them must contend on the identical global
      // lock, per tuples.ts's own doc comment on why this lock cannot be
      // scoped any narrower.
      let settledCount = 0;
      const bystanderPromises = bystanderTuples.map((tuple, i) => {
        const call =
          bystanderOps[i] === 'write' ? writeTuple(source, tuple) : deleteTuple(source, tuple);
        return call.then(
          (r) => {
            settledCount += 1;
            return r;
          },
          (e: unknown) => {
            settledCount += 1;
            throw e;
          },
        );
      });

      // None of them can have settled yet — the holder hasn't committed.
      await flushMicrotasks();
      expect(settledCount).toBe(0);

      // Only now does the holder commit — every bystander was genuinely
      // waiting on this, not racing ahead.
      await holderConn.query('COMMIT');

      const bystanderResults = await Promise.all(bystanderPromises);
      expect(settledCount).toBe(bystanderCount);

      for (const result of bystanderResults) {
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        // The actual invariant under test: a bystander could not even
        // allocate its own token until the holder released the lock by
        // committing — so every bystander token strictly exceeds it.
        expect(result.token).toBeGreaterThan(holderToken);
      }

      // No write lost, none double-applied, none double-counted: exactly
      // one write_log row per raced operation (holder + every bystander)
      // *plus* one per delete's own pre-race seed write (a delete needs a
      // real row to remove, so seeding it is itself a write_log-producing
      // write — accounted for here, not assumed away), and current token
      // reflects the highest one actually issued.
      const seedWriteCount =
        bystanderOps.filter((op) => op === 'delete').length + (holderOp === 'delete' ? 1 : 0);
      expect(state.writeLog).toHaveLength(1 + bystanderCount + seedWriteCount);
      const allTokens = [holderToken, ...bystanderResults.flatMap((r) => (r.ok ? [r.token] : []))];
      expect(new Set(allTokens).size).toBe(allTokens.length); // every token unique
      expect(await currentToken(source)).toBe(Math.max(...allTokens));
    },
  );
});

describe("publish.ts's namespace-hash lock genuinely scopes to one namespace — a concurrent acquire for a *different* namespace never blocks (D-098)", () => {
  it('a-second-acquire-for-the-same-namespace-blocks-but-a-concurrent-acquire-for-a-different-namespace-does-not', async () => {
    const { source } = freshSource();
    const holderConn = await source.connect();
    const sameNsConn = await source.connect();
    const otherNsConn = await source.connect();

    await holderConn.query('BEGIN');
    await holderConn.query('select pg_advisory_xact_lock(hashtext($1))', ['documents']);

    let sameNsSettled = false;
    const sameNsPromise = sameNsConn
      .query('BEGIN')
      .then(() => sameNsConn.query('select pg_advisory_xact_lock(hashtext($1))', ['documents']))
      .then(() => {
        sameNsSettled = true;
      });

    let otherNsSettled = false;
    const otherNsPromise = otherNsConn
      .query('BEGIN')
      .then(() => otherNsConn.query('select pg_advisory_xact_lock(hashtext($1))', ['images']))
      .then(() => {
        otherNsSettled = true;
      });

    // A different namespace's lock is a genuinely different key — no
    // contention, resolves immediately regardless of the "documents" hold.
    await otherNsPromise;
    expect(otherNsSettled).toBe(true);

    // The *same* namespace's lock is the identical key — must still be
    // blocked.
    await flushMicrotasks();
    expect(sameNsSettled).toBe(false);

    await holderConn.query('COMMIT');
    await sameNsPromise;
    expect(sameNsSettled).toBe(true);
  });
});

describe("migrate.ts's session-scoped migrations lock — survives COMMIT, and auto-releases only on explicit unlock or connection death (D-098)", () => {
  it('the-lock-survives-an-unrelated-commit-on-the-holding-connection-and-only-releases-on-an-explicit-unlock', async () => {
    const { source } = freshSource();
    const holderConn = await source.connect();
    const waiterConn = await source.connect();

    await holderConn.query('select pg_advisory_lock($1, $2)', [
      MIGRATIONS_LOCK_CLASSID,
      MIGRATIONS_LOCK_OBJID,
    ]);
    // An ordinary, unrelated BEGIN/COMMIT on the *same* connection — proves
    // session scope really is independent of transaction boundaries, not
    // just untested. migrate.ts's own real lockClient never does this
    // (its pg_advisory_lock call is a bare autocommit statement, matching
    // real usage), but a fake that silently released this lock at any
    // COMMIT on the holding connection would be a real fidelity gap.
    await holderConn.query('BEGIN');
    await holderConn.query('COMMIT');

    let waiterSettled = false;
    const waiterPromise = waiterConn
      .query('select pg_advisory_lock($1, $2)', [MIGRATIONS_LOCK_CLASSID, MIGRATIONS_LOCK_OBJID])
      .then(() => {
        waiterSettled = true;
      });

    await flushMicrotasks();
    expect(waiterSettled).toBe(false);

    const unlockResult = await holderConn.query<{ pg_advisory_unlock: boolean }>(
      'select pg_advisory_unlock($1, $2)',
      [MIGRATIONS_LOCK_CLASSID, MIGRATIONS_LOCK_OBJID],
    );
    expect(unlockResult.rows[0]?.pg_advisory_unlock).toBe(true);

    await waiterPromise;
    expect(waiterSettled).toBe(true);
  });

  it('control-an-unlock-call-from-a-connection-that-never-held-the-lock-returns-false-rather-than-throwing-matching-real-postgres', async () => {
    const { source } = freshSource();
    const strangerConn = await source.connect();

    const result = await strangerConn.query<{ pg_advisory_unlock: boolean }>(
      'select pg_advisory_unlock($1, $2)',
      [MIGRATIONS_LOCK_CLASSID, MIGRATIONS_LOCK_OBJID],
    );

    expect(result.rows[0]?.pg_advisory_unlock).toBe(false);
  });

  /**
   * D1's own exit criterion, verbatim (`docs/DST-PROPOSAL.md`): "a
   * session-lock-crash test proving the lock auto-releases when the
   * holding connection dies." A crashed connection stays dead — see
   * `connection.ts`'s own top-of-file doc comment — so this deliberately
   * issues a second, throwaway statement on the holder purely to trigger
   * the already-armed crash; its own SQL text is irrelevant, since the
   * crash check runs before any statement is even parsed.
   */
  it('a-session-lock-genuinely-auto-releases-when-its-holding-connection-crashes-letting-a-blocked-waiter-through', async () => {
    const { source } = freshSource();
    source.armNextConnectionCrash(1);
    const holderConn = await source.connect();
    // Statement 1 — succeeds, acquires the lock.
    await holderConn.query('select pg_advisory_lock($1, $2)', [
      MIGRATIONS_LOCK_CLASSID,
      MIGRATIONS_LOCK_OBJID,
    ]);

    const waiterConn = await source.connect();
    let waiterSettled = false;
    const waiterPromise = waiterConn
      .query('select pg_advisory_lock($1, $2)', [MIGRATIONS_LOCK_CLASSID, MIGRATIONS_LOCK_OBJID])
      .then(() => {
        waiterSettled = true;
      });

    await flushMicrotasks();
    expect(waiterSettled).toBe(false);

    // Statement 2 on the holder — the armed crash fires here.
    await expect(holderConn.query('select 1')).rejects.toThrow(/simulated crash/);

    // The crashed connection's death released the session lock it held —
    // the previously-blocked waiter is now granted.
    await waiterPromise;
    expect(waiterSettled).toBe(true);
  });
});
