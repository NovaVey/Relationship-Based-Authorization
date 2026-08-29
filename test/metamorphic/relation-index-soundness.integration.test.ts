/**
 * The Leopard-index Phase A "third comparison arm" (`docs/LEOPARD-INDEX-
 * PROPOSAL.md`, "Test plan — the third comparison arm") — Candidate A's own
 * general sweep: **"An index-hit ALLOW must replay on the live CTE."** For
 * any query where the index-accelerated production engine (`useRelationIndex:
 * true`) returns `allowed: true`, the byte-identical, unmodified live CTE
 * (`useRelationIndex: false`), pinned to the IDENTICAL snapshot (`atToken :=`
 * the rebuild's own `watermarkToken`), must ALSO return `allowed: true`. The
 * forbidden direction is `false -> true` (the accelerated call grants
 * something the live call denies) — an `index_false_grant` in
 * `src/soundness/classify-index.ts`'s own vocabulary, and, per that file's
 * own doc comment, a real security bug that must be zero, ever, never merely
 * a rare-but-tolerated rate.
 *
 * This file plays the identical role, for this bug shape, that
 * `test/metamorphic/exclusion-subtract-unprovable-cut.integration.test.ts`
 * plays for D-158's: run the SAME real, unmodified production engine against
 * MANY independently, randomly-generated (schema, tuple-graph) instances —
 * never a single hand-built fixture — and assert the property holds across
 * all of them. Per `docs/LEOPARD-INDEX-PROPOSAL.md`'s own "No new base-case
 * generator is needed" — `src/soundness/generators.ts`'s existing
 * `generateFixture` already guarantees every shape mechanism 2 cares about
 * (the self-referential group cycle, D-021; the deep hierarchy chain, D-070;
 * the exclusion-cutoff deep chain, D-159/D-161) on every single seed, so this
 * file reuses it unmodified rather than building a bespoke generator, exactly
 * as the proposal's own test plan directs.
 *
 * **Why this is a "production vs. itself" comparison, never a call into the
 * reference resolver.** `src/soundness/runner.ts`'s own doc comment states
 * the reasoning precisely: "the question 'did the index change what this
 * call returns' is a different question from 'does production agree with the
 * independent oracle.'" This file only ever calls `productionCheck` — twice
 * per query, `useRelationIndex: false` then `useRelationIndex: true`, both
 * pinned to the identical `atToken` — never `referenceCheck`. `runner.ts`'s
 * own `SoundnessRunOptions.relationIndex: 'warm'` mode does exactly this
 * two-call comparison inside its own (unexported) `checkAllQueries` — this
 * file cannot import that function directly (it is module-private, by
 * design, per `docs/LEOPARD-INDEX-PROPOSAL.md`'s own file-by-file plan), so
 * it re-derives the identical two-call shape directly against
 * `productionCheck`, the same way `exclusion-subtract-unprovable-cut
 * .integration.test.ts` calls `productionCheck` directly rather than going
 * through `runSoundnessFuzz`/`checkAllQueries` at all — this gives per-query
 * visibility into `ProductionCheckResult.indexHit` (needed for this file's
 * own non-vacuity check, below) that `runSoundnessFuzz`'s own aggregate
 * `SoundnessRunResult.indexQueriesHit` counter does not expose per-fixture.
 *
 * **Zero interleaved writes (Candidate A's own stated precondition,
 * `docs/LEOPARD-INDEX-PROPOSAL.md`).** For each seed: every tuple is written
 * FIRST, sequentially; `rebuildRelationMembershipIndex` runs exactly once,
 * strictly after; every check for that seed runs strictly after that, with
 * no further write in between. `atToken` for every check is pinned to
 * exactly that rebuild's own returned `watermarkToken` — "pinned to the
 * rebuild's own watermark" and "pinned to this file's own anchor" are the
 * same value, never two numbers that merely happen to agree (the identical
 * discipline `runner.ts`'s own `'warm'` mode doc comment states for
 * `pinToken`). Different seeds ARE processed sequentially against the same
 * shared database (this repo's own established convention — every generated
 * namespace name is seed-salted, `generators.ts`'s own top-of-file doc
 * comment, so two seeds' own tuple graphs can never collide), so a LATER
 * seed's own writes land in `relation_tuples` after an EARLIER seed's own
 * checks already finished — never inside an earlier seed's own
 * write-then-check window, which is all "zero interleaved writes" actually
 * requires.
 *
 * **Deliberately does not exercise expiring tuples.** `generators.ts` marks
 * roughly a fifth of its own randomly-generated tuples with an
 * `expiryKind` (`'expired' | 'valid'`) that only `src/soundness/runner.ts`
 * ever turns into a real timestamp (D-153) — this file writes every
 * generated tuple as a plain, never-expiring tuple instead, ignoring
 * `expiryKind` entirely. That is a deliberate, disclosed narrowing, not an
 * oversight: Candidate G (the index's own expiry-liveness gate) is a
 * SEPARATE, independently-fail-checked property
 * (`docs/LEOPARD-INDEX-PROPOSAL.md`'s own test-plan table routes it to
 * `test/unit/store/relation-index.integration.test.ts`, not this file), and
 * this file's own job is breadth across MANY random schema/graph shapes for
 * Candidate A specifically, not depth on any one interaction.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { env } from '../../src/config/env.js';
import { writeTuple, type TupleKey } from '../../src/store/tuples.js';
import { publishSchema } from '../../src/schema/publish.js';
import { productionCheck } from '../../src/resolve/production/resolver.js';
import { rebuildRelationMembershipIndex } from '../../src/store/relation-index.js';
import { runMigrations } from '../../src/store/migrate.js';
import { generateFixture, type GeneratedTuple } from '../../src/soundness/generators.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on('error', (err) => {
    // pg's own documented contract — see the identical comment in every
    // sibling *.integration.test.ts file in this repo.
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

// ---------------------------------------------------------------------------
// Shared helpers — deliberately small and local to this file (see
// `exclusion-subtract-unprovable-cut.integration.test.ts`'s own identical
// "don't force accidental coupling between independent test files" note,
// itself citing `docs/DECISIONS.md` D-022's general reasoning, applied to
// test helpers here).
// ---------------------------------------------------------------------------

let uniqueCounter = 0;
const processSalt = Math.random().toString(36).slice(2, 10);
/** A fresh seed string, unique across this and sibling test files/workers/runs. */
function uniqueSeed(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
}

/** `GeneratedTuple` -> `TupleKey`, deliberately dropping `expiryKind` — see this file's own top-of-file doc comment on why expiry is out of scope here. */
function toTupleKey(t: GeneratedTuple): TupleKey {
  return {
    objectNs: t.objectNs,
    objectId: t.objectId,
    relation: t.relation,
    subjectNs: t.subjectNs,
    subjectId: t.subjectId,
    ...(t.subjectRelation !== undefined ? { subjectRelation: t.subjectRelation } : {}),
  };
}

/** Publishes `source` and fails the test (with the real errors) if it doesn't compile/publish. */
async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(pool, source);
  if (!result.ok) {
    throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
  }
}

/** Writes every tuple in `tuples`, SEQUENTIALLY (never `Promise.all`) — matching every sibling `*.integration.test.ts` file's own established discipline, required so "every tuple written before the rebuild starts" is a real happens-before guarantee, not a race. */
async function writeAllSequentially(
  seed: string,
  tuples: readonly GeneratedTuple[],
): Promise<void> {
  for (const t of tuples) {
    const result = await writeTuple(pool, toTupleKey(t));
    if (!result.ok) {
      throw new Error(
        `seed=${seed}: fixture tuple failed to write: ${JSON.stringify(toTupleKey(t))}: ${JSON.stringify(result.errors)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Candidate A — the general sweep
// ---------------------------------------------------------------------------

describe('Leopard index Candidate A — an index-accelerated ALLOW must always replay on the live CTE pinned to the same rebuild watermark, across many random schema/tuple-graph shapes', () => {
  const SEED_COUNT = 15;
  const QUERY_COUNT_PER_SEED = 24;

  it(`across ${SEED_COUNT} independently-generated random fixtures, zero index-accelerated 'productionCheck' call ever reports ALLOWED when the identically-pinned, unaccelerated call on the SAME snapshot reports DENIED (a live index_false_grant), and the sweep genuinely engages the index at least once (never a silently vacuous 'warm' run)`, async () => {
    let totalChecks = 0;
    let totalIndexHits = 0;
    let totalIndexFalseGrants = 0;

    for (let seedIndex = 0; seedIndex < SEED_COUNT; seedIndex += 1) {
      const seed = uniqueSeed(`leopardA${seedIndex}`);
      const fixture = generateFixture(seed, QUERY_COUNT_PER_SEED);

      await publishOk(fixture.schemaSource);
      await writeAllSequentially(seed, fixture.tuples);

      // Zero writes from here on, for this seed — Candidate A's own stated
      // precondition (`docs/LEOPARD-INDEX-PROPOSAL.md`). The rebuild's own
      // returned `watermarkToken` IS this seed's pin — never an
      // independently-computed anchor that merely happens to agree.
      const rebuildResult = await rebuildRelationMembershipIndex(pool);
      expect(
        rebuildResult.lockAcquired,
        `seed=${seed}: the rebuild's advisory lock was not acquired — cannot proceed with this seed`,
      ).toBe(true);
      expect(rebuildResult.published, `seed=${seed}: the rebuild did not publish`).toBe(true);
      const pinToken = rebuildResult.watermarkToken;

      for (const query of fixture.queries) {
        totalChecks += 1;

        // Sequential, deliberately — both calls read the identical
        // already-committed, already-static snapshot, so ordering cannot
        // change either result (`runner.ts`'s own `'warm'`-mode doc comment
        // states the identical reasoning for why this is never
        // `Promise.all`).
        const liveResult = await productionCheck(
          pool,
          { ns: query.subject.ns, id: query.subject.id },
          { ns: query.object.ns, id: query.object.id },
          query.relationOrPermission,
          { atToken: pinToken, maxDepth: env.CHECK_MAX_DEPTH, useRelationIndex: false },
        );
        const indexResult = await productionCheck(
          pool,
          { ns: query.subject.ns, id: query.subject.id },
          { ns: query.object.ns, id: query.object.id },
          query.relationOrPermission,
          { atToken: pinToken, maxDepth: env.CHECK_MAX_DEPTH, useRelationIndex: true },
        );

        if (indexResult.indexHit === true) totalIndexHits += 1;

        // *** Candidate A's own core assertion — the forbidden direction is
        // `false -> true` (unaccelerated denies, accelerated grants), never
        // the reverse. *** Counted separately from the `expect` below so the
        // final summary log always reports the true count even though the
        // first violation throws.
        if (!liveResult.allowed && indexResult.allowed) {
          totalIndexFalseGrants += 1;
        }
        if (!liveResult.allowed) {
          expect(
            indexResult.allowed,
            `seed=${seed}: query ${JSON.stringify(query)} — the index-accelerated call resolved ALLOWED while the identically-pinned (atToken=${pinToken}), unaccelerated live-CTE call resolved DENIED. This is an index_false_grant (src/soundness/classify-index.ts) — Candidate A (docs/LEOPARD-INDEX-PROPOSAL.md) requires this to be zero, ever, never merely rare.`,
          ).toBe(false);
        }
      }
    }

    console.log(
      `[Leopard index Candidate A] ${SEED_COUNT} seeds x up to ${QUERY_COUNT_PER_SEED} queries; ` +
        `${totalChecks} paired checks, ${totalIndexHits} of which actually hit the index at least once ` +
        `in their own walk, ${totalIndexFalseGrants} index_false_grant(s) found (must be 0)`,
    );

    expect(totalIndexFalseGrants).toBe(0);

    // Non-vacuity — mirrors `runner.ts`'s own `'warm'`-mode
    // `indexQueriesHit > 0` gate (docs/LEOPARD-INDEX-PROPOSAL.md's own
    // disclosed "a 'warm' run that happens to hit the index zero times must
    // not silently report sound" fix) at this file's own, per-fixture
    // granularity: if this sweep somehow never actually consulted-and-hit
    // the index across every one of these ${SEED_COUNT} independently
    // randomly-generated fixtures, this property was never really
    // exercised at all, no matter how many times the loop above ran.
    expect(
      totalIndexHits,
      `Candidate A's own sweep hit the index ZERO times across ${SEED_COUNT} seeds and ${totalChecks} paired checks — either a real bug in the rebuild/lookup wiring, or this property never actually exercised the index at all`,
    ).toBeGreaterThan(0);
  }, 600_000);
});
