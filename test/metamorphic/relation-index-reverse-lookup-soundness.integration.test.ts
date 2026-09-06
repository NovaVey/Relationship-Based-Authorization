/**
 * The reverse-lookup accelerant for `listObjects` (D-175, `docs/REVERSE-
 * LOOKUP-PROPOSAL.md`) — the metamorphic-sweep counterpart to
 * `test/metamorphic/relation-index-soundness.integration.test.ts` (the
 * Leopard index's own forward-direction "Candidate A" sweep), same
 * question asked of `listObjects` instead of `productionCheck`: run the
 * SAME real, unmodified `listObjects` against MANY independently, randomly
 * generated (schema, tuple-graph) instances — never a single hand-built
 * fixture — comparing the accelerated call (`useRelationIndex: true`)
 * against the identically-pinned unaccelerated call (`useRelationIndex:
 * false`) on the SAME real database, and assert the two never disagree.
 *
 * **Why "production vs. itself," never a separately re-derived brute-force
 * oracle — the identical choice this file's own Leopard-forward sibling
 * makes, and for the identical reason.** `listObjects`'s own baseline
 * correctness (that it agrees with an INDEPENDENTLY computed correct
 * answer — every real tuple anywhere in `relation_tuples`, walked by hand,
 * never through `listObjects`'s own machinery) is already proven, once,
 * against a hand-built schema exercising every rewrite-rule kind, by
 * `test/unit/audit/list.integration.test.ts` — re-deriving that same
 * brute-force oracle here, per random seed, would duplicate that file's
 * own job without adding a genuinely different property. What THIS file
 * proves is narrower and different: does turning the accelerant ON ever
 * change `listObjects`'s own answer, across many random schema/graph
 * shapes it was never hand-tuned against? That is exactly the comparison
 * `relation-index-soundness.integration.test.ts`'s own Candidate A already
 * makes for `productionCheck` (accelerated vs. unaccelerated, same
 * function, same pinned snapshot) — this file is that same shape, applied
 * to `listObjects` instead.
 *
 * **The forbidden direction is asymmetric, but not the same asymmetry as
 * Candidate A's.** `listObjects`'s own soundness is structurally free
 * regardless of what the accelerant returns (every candidate it proposes
 * still passes through the real, unmodified `productionCheck` before ever
 * being reported — see `src/audit/list.ts`'s own top-of-file doc comment),
 * so an accelerated result can never contain an object the unaccelerated
 * call would have excluded. The real risk axis is completeness: the
 * accelerated candidate list silently OMITTING a real object the
 * unaccelerated full-namespace scan would have found and confirmed. So
 * this file's own core assertion compares the two calls' `objects` sets for
 * exact equality in both directions — a defensive, no-cost strengthening
 * over "subset only," since exact equality catches an unaccelerated-side
 * regression too, not just the specific completeness risk this feature
 * introduces.
 *
 * **Reuses `src/soundness/generators.ts`'s `generateFixture` unmodified**
 * — the identical fixture source `relation-index-soundness.integration
 * .test.ts` already established as sufficient for this general class of
 * sweep, per `docs/LEOPARD-INDEX-PROPOSAL.md`'s own "no new base-case
 * generator is needed." Its generated schemas never declare a wildcard
 * subject type (`grep -rn "wildcard" src/soundness/generators.ts` finds
 * nothing) — gate 5 (`docs/REVERSE-LOOKUP-PROPOSAL.md`) is therefore never
 * the reason a generated relation misses the accelerant in this file, only
 * gate 4 (a permission name, not a bare relation) ever is, and this file's
 * own per-seed filtering step (inline in the sweep below, checked directly
 * against `getLatestNamespaceConfig`) accounts for that directly rather
 * than leaving it to chance.
 *
 * **Zero interleaved writes per seed**, identical discipline and identical
 * reasoning to this file's own Leopard-forward sibling: every tuple
 * written first, sequentially; `rebuildRelationMembershipIndex` exactly
 * once, strictly after; every `listObjects` pair for that seed pinned to
 * that rebuild's own `watermarkToken`, with no further write for that seed
 * in between.
 *
 * **A dedicated final `describe` block, entirely separate from the random
 * sweep, closes the design's own disclosed non-vacuity obligation**
 * (`docs/REVERSE-LOOKUP-PROPOSAL.md`'s own test-plan: "the non-vacuity
 * control of writing one more tuple after rebuild and confirming gate 2
 * refuses to accelerate") — a real write after a real rebuild, on a small,
 * hand-built, unambiguous fixture, directly asserting
 * `fetchReverseIndexCandidates` itself reports `{hit:false}` afterward.
 * This is a positive control on the STALENESS GATE itself, independent of
 * the random sweep's own "answers never disagree" property: it proves gate
 * 2 is not a silent no-op (always passing, or always failing) by showing
 * it flips from pass to fail at the exact moment a real write moves
 * `currentToken()` past the rebuild's own watermark.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { env } from '../../src/config/env.js';
import { writeTuple, type TupleKey } from '../../src/store/tuples.js';
import { publishSchema, getLatestNamespaceConfig } from '../../src/schema/publish.js';
import { listObjects, LIST_OBJECTS_MAX_CANDIDATES, type EntityRef } from '../../src/audit/list.js';
import {
  fetchReverseIndexCandidates,
  rebuildRelationMembershipIndex,
} from '../../src/store/relation-index.js';
import { runMigrations } from '../../src/store/migrate.js';
import { generateFixture, type GeneratedTuple } from '../../src/soundness/generators.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on('error', (err) => {
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

// ---------------------------------------------------------------------------
// Shared helpers — deliberately local to this file, matching this file's own
// Leopard-forward sibling's identical "don't force accidental coupling
// between independent test files" precedent (D-022).
// ---------------------------------------------------------------------------

let uniqueCounter = 0;
const processSalt = Math.random().toString(36).slice(2, 10);
function uniqueSeed(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
}

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

async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(pool, source);
  if (!result.ok) {
    throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
  }
}

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

interface BareRelationTriple {
  subject: EntityRef;
  relation: string;
  objectNs: string;
}

const WARM_MAX_DEPTH = env.CHECK_MAX_DEPTH;

// ---------------------------------------------------------------------------
// The random sweep
// ---------------------------------------------------------------------------

describe('the reverse-lookup accelerant — an accelerated listObjects call must always agree exactly with the identically-pinned unaccelerated call, across many random schema/tuple-graph shapes', () => {
  const SEED_COUNT = 15;
  const QUERY_COUNT_PER_SEED = 24;

  it(`across ${SEED_COUNT} independently-generated random fixtures, every accelerated 'listObjects' call (useRelationIndex: true) returns EXACTLY the same object set as the identically-pinned unaccelerated call (useRelationIndex: false) on the same real database — and the sweep genuinely engages the accelerant at least once (never a silently vacuous run)`, async () => {
    let totalTriples = 0;
    let totalAcceleratedHits = 0;
    let totalDisagreements = 0;

    for (let seedIndex = 0; seedIndex < SEED_COUNT; seedIndex += 1) {
      const seed = uniqueSeed(`revlookupA${seedIndex}`);
      const fixture = generateFixture(seed, QUERY_COUNT_PER_SEED);

      await publishOk(fixture.schemaSource);
      await writeAllSequentially(seed, fixture.tuples);

      // Zero writes from here on for this seed — identical precondition to
      // this file's own Leopard-forward sibling's Candidate A sweep.
      const rebuildResult = await rebuildRelationMembershipIndex(pool);
      expect(
        rebuildResult.lockAcquired,
        `seed=${seed}: the rebuild's advisory lock was not acquired`,
      ).toBe(true);
      expect(rebuildResult.published, `seed=${seed}: the rebuild did not publish`).toBe(true);
      const pinToken = rebuildResult.watermarkToken;

      // Reduce this seed's own generated queries to the distinct (subject,
      // relation, objectNs) triples listObjects can actually be asked
      // about — see bareRelationTriples's own doc comment.
      const seen = new Set<string>();
      const triples: BareRelationTriple[] = [];
      for (const query of fixture.queries) {
        const config = await getLatestNamespaceConfig(pool, query.object.ns);
        const relation = config?.relations[query.relationOrPermission];
        if (!relation) continue; // gate 4: a permission name, or an undeclared namespace
        if (relation.subjectTypes.some((t) => t.wildcard === true)) continue; // gate 5 (never true for this generator, checked anyway)

        const key = `${query.subject.ns}:${query.subject.id}|${query.relationOrPermission}|${query.object.ns}`;
        if (seen.has(key)) continue;
        seen.add(key);
        triples.push({
          subject: { ns: query.subject.ns, id: query.subject.id },
          relation: query.relationOrPermission,
          objectNs: query.object.ns,
        });
      }

      for (const triple of triples) {
        totalTriples += 1;

        // Sequential, deliberately — both calls read the identical
        // already-committed, already-static snapshot for this seed, so
        // ordering cannot change either result (matching this file's own
        // Leopard-forward sibling's identical reasoning for its own
        // sequential pair).
        const unaccelerated = await listObjects(
          pool,
          triple.subject,
          triple.relation,
          triple.objectNs,
          {
            atToken: pinToken,
            maxDepth: WARM_MAX_DEPTH,
            useRelationIndex: false,
          },
        );
        const accelerated = await listObjects(
          pool,
          triple.subject,
          triple.relation,
          triple.objectNs,
          {
            atToken: pinToken,
            maxDepth: WARM_MAX_DEPTH,
            useRelationIndex: true,
          },
        );

        // Direct observability into whether the accelerant genuinely
        // engaged for this exact triple — listObjects's own return type
        // has no indexHit-equivalent field, so this is a parallel,
        // side-channel call purely for the non-vacuity count below, never
        // part of the correctness comparison itself.
        const candidateProbe = await fetchReverseIndexCandidates(
          pool,
          triple.subject,
          triple.relation,
          triple.objectNs,
          LIST_OBJECTS_MAX_CANDIDATES,
        );
        if (candidateProbe.hit) totalAcceleratedHits += 1;

        const unacceleratedIds = [...unaccelerated.objects.map((o) => o.id)].sort();
        const acceleratedIds = [...accelerated.objects.map((o) => o.id)].sort();

        if (
          JSON.stringify(unacceleratedIds) !== JSON.stringify(acceleratedIds) ||
          unaccelerated.truncated !== accelerated.truncated
        ) {
          totalDisagreements += 1;
        }

        expect(
          acceleratedIds,
          `seed=${seed}: triple=${JSON.stringify(triple)} — the accelerated listObjects call (useRelationIndex: true) disagreed with the identically-pinned unaccelerated call. unaccelerated=${JSON.stringify(unacceleratedIds)} accelerated=${JSON.stringify(acceleratedIds)}`,
        ).toEqual(unacceleratedIds);
        expect(
          accelerated.truncated,
          `seed=${seed}: triple=${JSON.stringify(triple)} — truncated flags disagreed between accelerated and unaccelerated calls`,
        ).toBe(unaccelerated.truncated);
      }
    }

    console.log(
      `[reverse-lookup accelerant soundness sweep] ${SEED_COUNT} seeds x up to ${QUERY_COUNT_PER_SEED} queries; ` +
        `${totalTriples} distinct (subject, relation, objectNs) triples checked, ${totalAcceleratedHits} of which ` +
        `genuinely engaged the accelerant, ${totalDisagreements} disagreement(s) found (must be 0)`,
    );

    expect(totalDisagreements).toBe(0);

    // Non-vacuity — the identical "a warm run that never actually engaged
    // the mechanism must not silently report sound" gate this file's own
    // Leopard-forward sibling applies to productionCheck's own indexHit,
    // applied here to the accelerant's own hit count instead.
    expect(
      totalAcceleratedHits,
      `the sweep engaged the reverse-lookup accelerant ZERO times across ${SEED_COUNT} seeds and ${totalTriples} triples — either a real bug in the rebuild/gate wiring, or this property never actually exercised the accelerant at all`,
    ).toBeGreaterThan(0);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// The non-vacuity control on gate 2 itself — a real write after a real
// rebuild must flip fetchReverseIndexCandidates from hit to miss. See this
// file's own top-of-file doc comment for why this is a separate, dedicated
// fixture rather than folded into the random sweep above.
// ---------------------------------------------------------------------------

describe('gate 2 is a real, live gate, not a silent no-op: a write landing strictly after the rebuild watermark flips fetchReverseIndexCandidates from a genuine hit to a genuine miss, with no intervening rebuild', () => {
  it('a-real-write-after-a-real-rebuild-moves-currenttoken-past-the-watermark-and-the-next-candidate-call-reports-hit-false', async () => {
    const docNs = uniqueSeed('gate2doc');
    await publishOk([`namespace ${docNs} {`, '  relation viewer: user', '}'].join('\n'));

    const write = await writeTuple(pool, {
      objectNs: docNs,
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    if (!write.ok) throw new Error(`fixture write failed: ${JSON.stringify(write.errors)}`);

    const rebuildResult = await rebuildRelationMembershipIndex(pool);
    expect(rebuildResult.published).toBe(true);

    // Positive control: right after the rebuild, with no intervening write,
    // gate 2 passes and this is a genuine hit — proves the flip below is
    // real, not merely "always misses regardless."
    const beforeWrite = await fetchReverseIndexCandidates(
      pool,
      { ns: 'user', id: 'alice' },
      'viewer',
      docNs,
      10,
    );
    expect(beforeWrite).toEqual({ hit: true, objectIds: ['readme'], truncated: false });

    // The real write the rebuild's own watermark has NOT observed — no
    // rebuild runs after this.
    const secondWrite = await writeTuple(pool, {
      objectNs: docNs,
      objectId: 'other',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'bob',
    });
    if (!secondWrite.ok) {
      throw new Error(`fixture second write failed: ${JSON.stringify(secondWrite.errors)}`);
    }
    expect(secondWrite.token).toBeGreaterThan(rebuildResult.watermarkToken);

    const afterWrite = await fetchReverseIndexCandidates(
      pool,
      { ns: 'user', id: 'alice' },
      'viewer',
      docNs,
      10,
    );
    expect(afterWrite).toEqual({ hit: false });

    // End-to-end confirmation: listObjects itself must still report the
    // complete, correct, live-current answer via its own fallback —
    // alice's grant, unaffected by the second write, is still found.
    const result = await listObjects(pool, { ns: 'user', id: 'alice' }, 'viewer', docNs, {
      useRelationIndex: true,
    });
    expect(result).toEqual({ objects: [{ ns: docNs, id: 'readme' }], truncated: false });
  });
});
