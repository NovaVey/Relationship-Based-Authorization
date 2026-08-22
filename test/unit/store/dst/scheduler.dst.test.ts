/**
 * DST D4's own machinery, tested directly before any earlier-phase test is
 * ported onto it (`docs/DST-PROPOSAL.md`, `docs/DECISIONS.md` D-101), plus
 * D5's own `dstSeedList` (`docs/DECISIONS.md` D-102) — the same "build
 * local confidence in new DST machinery before relying on it elsewhere"
 * discipline D3's own DB-free `frontier.dst.test.ts` already established
 * for `fetchReachableFrontierVia`. No Postgres, no Testcontainers: pure JS,
 * `dstRngFromSeed`/`dstSeedList`/`flushMicrotasks` need none, and
 * `raceUnderPause` only needs the in-memory fake connection source.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compileSchema } from '../../../../src/schema/dsl/compiler.js';
import { writeTuple, type TupleKey } from '../../../../src/store/tuples.js';
import {
  createFakeStoreState,
  createFakeConnectionSource,
  seedNamespaceConfig,
} from '../../../../src/store/dst/index.js';
import {
  dstRngFromSeed,
  dstSeedList,
  regressionCorpusSeedsFor,
  flushMicrotasks,
  raceUnderPause,
} from '../../../../src/store/dst/scheduler.js';

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

function freshSource() {
  const state = createFakeStoreState();
  seedNamespaceConfig(state, compiledDocumentNamespace());
  return { state, source: createFakeConnectionSource(state) };
}

describe('dstRngFromSeed — the one canonical seed → deterministic-RNG construction (D4, D-101)', () => {
  it('the-identical-seed-always-produces-the-identical-draw-sequence', () => {
    const rngA = dstRngFromSeed('reproducibility-check');
    const rngB = dstRngFromSeed('reproducibility-check');

    const drawsA = Array.from({ length: 20 }, () => rngA.nextIntBetween(0, 1_000_000));
    const drawsB = Array.from({ length: 20 }, () => rngB.nextIntBetween(0, 1_000_000));

    expect(drawsB).toEqual(drawsA);
  });

  it('different-seeds-produce-different-draw-sequences', () => {
    // Not a mathematical guarantee (two distinct seeds could in principle
    // hash-collide or coincidentally agree on every one of 20 draws), but
    // astronomically unlikely enough that a failure here means something
    // is actually broken (e.g. the seed argument silently being ignored),
    // matching this project's own established tolerance for this exact
    // shape of "vanishingly unlikely by chance" assertion elsewhere.
    const rngA = dstRngFromSeed('seed-one');
    const rngB = dstRngFromSeed('seed-two');

    const drawsA = Array.from({ length: 20 }, () => rngA.nextIntBetween(0, 1_000_000));
    const drawsB = Array.from({ length: 20 }, () => rngB.nextIntBetween(0, 1_000_000));

    expect(drawsB).not.toEqual(drawsA);
  });

  it('a-custom-pool-size-is-honored-a-pool-too-small-for-the-draws-attempted-throws-the-real-exhaustion-error', () => {
    const rng = dstRngFromSeed('tiny-pool', 2);
    rng.nextInt(10);
    rng.nextInt(10);
    // The pool above has exactly 2 draws — SeededRng's own real exhaustion
    // guard (src/soundness/generators.ts) fires on the 3rd, proving
    // `poolSize` genuinely reaches the underlying draw pool, not silently
    // ignored in favor of some other default. The guard's own error message
    // points a reader at `DRAW_POOL_BASE_SIZE`/`DRAW_POOL_PER_QUERY` — those
    // govern the soundness fixture generator's own private `buildRng`, not
    // `dstRngFromSeed`'s `poolSize` parameter tested here; a DST caller
    // hitting this for real should widen its own `poolSize` argument
    // instead.
    expect(() => rng.nextInt(10)).toThrow(/exhausted its deterministic draw pool/);
  });
});

describe('dstSeedList — the shared PR/nightly seed-count knob (D5, D-102)', () => {
  const ENV_KEY = 'DST_SEED_COUNT';
  const originalValue = process.env[ENV_KEY];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalValue;
    }
  });

  it('with-no-override-set-returns-exactly-defaultCount-prefixed-seeds-in-order', () => {
    delete process.env[ENV_KEY];
    expect(dstSeedList('demo', 4)).toEqual(['demo_1', 'demo_2', 'demo_3', 'demo_4']);
  });

  it('DST_SEED_COUNT-set-to-a-real-positive-integer-overrides-defaultCount-entirely', () => {
    process.env[ENV_KEY] = '25';
    expect(dstSeedList('demo', 4)).toHaveLength(25);
    expect(dstSeedList('demo', 4)[24]).toBe('demo_25');
  });

  it.each(['0', '-3', 'not-a-number', '', '3.5'])(
    'DST_SEED_COUNT=%j is not a valid positive integer, so defaultCount is used instead',
    (invalidValue) => {
      process.env[ENV_KEY] = invalidValue;
      expect(dstSeedList('demo', 4)).toHaveLength(4);
    },
  );

  it('every-produced-seed-is-a-valid-object_id-shaped-identifier-fragment-no-hyphens', () => {
    // The exact fail-check this file's own doc comment references — see
    // src/store/tuples.ts's own validateIdentifiers (`^[a-z][a-z0-9_]*$`):
    // every real DST test embeds its own seed directly into a real
    // object_id/subject_id, so a `-` here would break every one of them.
    for (const seed of dstSeedList('crash_sweep_seed', 5)) {
      expect(seed).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

/**
 * `regressionCorpusSeedsFor` — the corpus-reading half of `dstSeedList`
 * (`docs/dst-regression-corpus.json`, `docs/DECISIONS.md` D-102), tested
 * directly via `corpusPath`'s own overridable default (real, throwaway
 * temp files, never the real checked-in corpus — that file is honestly
 * meant to stay empty, not mutated by every test run). `dstSeedList`'s own
 * union of this function's output with its generated seeds was
 * live-verified once already by temporarily editing the real checked-in
 * corpus file and confirming `advisory-lock.dst.test.ts`'s own real sweep
 * genuinely grew by one case (`docs/DECISIONS.md` D-102's own writeup).
 */
describe('regressionCorpusSeedsFor — the corpus-reading half of dstSeedList (D5, D-102)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dst-corpus-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeCorpus(entries: unknown): string {
    const corpusPath = path.join(tempDir, 'corpus.json');
    fs.writeFileSync(corpusPath, JSON.stringify({ entries }));
    return corpusPath;
  }

  it('returns-only-the-seeds-whose-own-scheduleId-matches-never-a-different-schedules-entries', () => {
    const corpusPath = writeCorpus([
      {
        seed: 'lock_race_from_corpus',
        scheduleId: 'lock_race',
        failureSummary: 'x',
        dateFound: 'x',
      },
      {
        seed: 'unrelated_seed',
        scheduleId: 'some_other_sweep',
        failureSummary: 'x',
        dateFound: 'x',
      },
    ]);

    expect(regressionCorpusSeedsFor('lock_race', corpusPath)).toEqual(['lock_race_from_corpus']);
    expect(regressionCorpusSeedsFor('some_other_sweep', corpusPath)).toEqual(['unrelated_seed']);
    expect(regressionCorpusSeedsFor('a_schedule_with_no_entries', corpusPath)).toEqual([]);
  });

  it('an-empty-entries-array-the-real-checked-in-corpus-own-current-state-returns-an-empty-list', () => {
    const corpusPath = writeCorpus([]);
    expect(regressionCorpusSeedsFor('lock_race', corpusPath)).toEqual([]);
  });

  it('a-corpus-file-with-a-non-array-entries-field-throws-loudly-rather-than-silently-degrading', () => {
    const corpusPath = path.join(tempDir, 'malformed.json');
    fs.writeFileSync(corpusPath, JSON.stringify({ entries: 'not-an-array' }));
    expect(() => regressionCorpusSeedsFor('lock_race', corpusPath)).toThrow(/malformed/);
  });

  /**
   * The exact gap an adversarial review found (`docs/DECISIONS.md` D-102):
   * a corpus seed containing a hyphen (or any character outside this
   * project's own identifier grammar) previously flowed through unchecked
   * and only failed several call frames away, inside whatever real
   * object_id/subject_id it got embedded into — a generic, root-cause-
   * obscuring assertion failure, not a clear error naming the actual
   * malformed entry. This pins down the fix: the check happens here, at
   * the source, naming the offending seed and scheduleId directly.
   */
  it('a-corpus-seed-that-does-not-match-the-real-identifier-grammar-throws-here-naming-the-entry-rather-than-failing-downstream', () => {
    const corpusPath = writeCorpus([
      { seed: 'BAD-SEED!', scheduleId: 'lock_race', failureSummary: 'x', dateFound: 'x' },
    ]);

    expect(() => regressionCorpusSeedsFor('lock_race', corpusPath)).toThrow(
      /malformed seed for scheduleId "lock_race": "BAD-SEED!"/,
    );
  });

  it('the-real-checked-in-corpus-file-itself-parses-cleanly-and-is-currently-empty', () => {
    // The one test in this file that touches the real file — read-only,
    // proving today's honest "nothing found yet" state is real, not
    // asserting anything a future entry would need this test rewritten for.
    expect(regressionCorpusSeedsFor('lock_race')).toEqual([]);
  });
});

describe('flushMicrotasks — drains the microtask queue without any real wall-clock wait (D4, D-101)', () => {
  it('a-promise-chain-queued-before-the-call-has-fully-settled-by-the-time-it-resolves', async () => {
    let resolved = false;
    // Queues several real microtask hops before actually resolving —
    // proves flushMicrotasks drains more than just one single `.then()`.
    void Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => Promise.resolve())
      .then(() => {
        resolved = true;
      });

    expect(resolved).toBe(false); // hasn't run yet — still synchronous here
    await flushMicrotasks();
    expect(resolved).toBe(true);
  });
});

describe('raceUnderPause — the shared pause/resume race choreography (D4, D-101)', () => {
  it('a-genuinely-suspended-held-op-resumes-only-after-concurrentOp-runs-and-resume-is-called-internally', async () => {
    const { source } = freshSource();
    const tuple: TupleKey = {
      objectNs: 'document',
      objectId: 'racy',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    };
    let concurrentOpRan = false;

    // writeTuple's own real statement sequence is BEGIN(1) → lock(2) →
    // insert(3) → insertWriteLog(4) → COMMIT(5) — pausing after 2 statements
    // suspends it between acquiring the lock and inserting the tuple.
    const result = await raceUnderPause({
      source,
      pauseAfterStatements: 2,
      heldOp: () => writeTuple(source, tuple),
      concurrentOp: async () => {
        concurrentOpRan = true;
        await Promise.resolve();
      },
    });

    expect(concurrentOpRan).toBe(true);
    expect(result).toEqual({ ok: true, token: 1, created: true });
  });

  /**
   * Fail-check surfaced as a real, permanent test rather than only a
   * manual live check (this project's own established discipline — see
   * `docs/DECISIONS.md` D-099/D-100 for the same live-fail-check pattern
   * applied to D2/D3's own new mechanisms): `pauseAfterStatements` set past
   * the held op's own real statement count means the pause condition
   * (`connection.ts`'s own `statementsExecuted === pauseAfterStatements`)
   * never fires, so the held op's own `fired` signal never resolves and it
   * runs straight through to completion — exactly the "a race that never
   * actually raced" failure mode this function's own structural throw
   * exists to catch, now detected by racing the held op's own completion
   * against a real fired-or-not signal rather than guessing from a fixed
   * microtask budget (`docs/DECISIONS.md` D-101).
   */
  it('throws-its-own-structural-error-when-the-held-op-was-never-actually-suspended', async () => {
    const { source } = freshSource();
    const tuple: TupleKey = {
      objectNs: 'document',
      objectId: 'never-paused',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    };

    await expect(
      raceUnderPause({
        source,
        pauseAfterStatements: 999, // writeTuple only ever issues 5 statements
        heldOp: () => writeTuple(source, tuple),
        concurrentOp: async () => {
          throw new Error('unreachable: raceUnderPause must throw before this ever runs');
        },
      }),
    ).rejects.toThrow(/expected the held operation to genuinely suspend/);
  });

  it('propagates-a-real-rejection-from-heldOp-after-a-genuine-pause-rather-than-swallowing-it', async () => {
    const { source } = freshSource();

    // Statement 3 (an unrecognized query, deliberately) only ever runs
    // *after* the armed pause suspends and `raceUnderPause`'s own internal
    // `resume()` call (fired once `concurrentOp` below finishes) lets it
    // through — proving the rejection genuinely happens after a real pause,
    // not before the pause ever had a chance to fire.
    await expect(
      raceUnderPause({
        source,
        pauseAfterStatements: 2,
        heldOp: async () => {
          const conn = await source.connect();
          await conn.query('BEGIN'); // statement 1
          await conn.query('select max(token) as max_token from write_log'); // statement 2 — pause fires before statement 3
          await conn.query('this is not a real recognized statement'); // statement 3, post-resume — throws for real
        },
        concurrentOp: async () => {
          await Promise.resolve();
        },
      }),
    ).rejects.toThrow(/no shape registered/);
  });

  /**
   * The exact bug an adversarial review found in this function's first
   * draft (`docs/DECISIONS.md` D-101): the original design confirmed
   * suspension by flushing a *fixed* 20-hop microtask budget and checking
   * whether the held op had already settled — a guess, not a fact. A held
   * op that genuinely never reaches its own armed pause point but takes
   * *more* than 20 microtask hops to settle anyway (unrelated to any
   * pause) would out-live that fixed budget, reporting "still suspended"
   * when it was really just slow — the original design verified this
   * live against `productionCheck`'s own real statement sequence (25
   * hops) and found exactly this false negative. This test pins the fix
   * down permanently: a held op that takes 30 microtask hops before
   * resolving, on a connection that never opens at all (so the armed
   * pause can never fire), must still be correctly reported as "never
   * genuinely suspended" — proving the current `fired`-signal design has
   * no fixed-budget blind spot the old flushMicrotasks-based one did.
   */
  it('a-held-op-that-outlives-the-old-fixed-microtask-budget-without-ever-genuinely-pausing-is-still-caught', async () => {
    const { source } = freshSource();

    await expect(
      raceUnderPause({
        source,
        pauseAfterStatements: 0,
        heldOp: async () => {
          // 30 real microtask hops — deliberately more than the old fixed
          // 20-hop flushMicrotasks budget this design used to guess with —
          // and never once calls source.connect(), so the armed pause can
          // never fire no matter how long this takes to settle.
          let value = 0;
          for (let i = 0; i < 30; i += 1) {
            value = await Promise.resolve(value + 1);
          }
          return value;
        },
        concurrentOp: async () => {
          throw new Error('unreachable: raceUnderPause must throw before this ever runs');
        },
      }),
    ).rejects.toThrow(/expected the held operation to genuinely suspend/);
  });
});
