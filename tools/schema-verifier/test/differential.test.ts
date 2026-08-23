/**
 * §8b — build spec's own words (`src/schema/dsl/random.ts`'s header
 * comment quotes them verbatim): "on small random schemas from §2b, run
 * the verifier against a deliberately dumb exhaustive checker." §7's
 * `boundedSearch` already *is* that deliberately dumb exhaustive checker
 * (`bounded/search.ts`'s own doc comment already calls it that, citing
 * this same phrase). This file is what turns it into an independent
 * oracle rather than just §7's own fallback path: it runs on the
 * *monotone* fragment too, specifically to catch the one verdict nothing
 * else in this project checks against a second, independent
 * implementation — §5's `checkInvariant` reporting `HOLDS`.
 *
 * Why `HOLDS` specifically, not `VIOLATED`: every `VIOLATED` §5 produces
 * is already independently confirmed against the real engine on every
 * real run, via §6's `replayWitness` (inside `checkAndValidate`). A
 * `HOLDS` verdict gets only empirical sampling (`fuzzHolds` — a handful
 * of random trials, real but not exhaustive). This file adds the missing
 * check: for every monotone-fragment invariant where §5 says `HOLDS`, an
 * independent, exhaustive-up-to-k brute-force search (the same machinery
 * §7 already built for a different purpose) must never find a
 * counterexample either. A single disagreement here — brute force finds
 * `VIOLATED` where §5 said `HOLDS` — would be exactly "the failure mode
 * that makes a verifier actively dangerous" (§5's own doc comment),
 * caught live rather than assumed away.
 *
 * Random schemas are generated with intersection/exclusion switched off
 * (`operators`) so every trial actually lands in the monotone fragment
 * this test exists to cross-check — a schema that happened to route to
 * §7 instead would just be a skipped, wasted trial, since §7's own
 * verdicts are already self-validated by construction (no second oracle
 * needed there).
 */
import { describe, expect, it } from 'vitest';

import { generateRandomSchema } from '../../../src/schema/dsl/random.js';
import { boundedSearch, generateCandidateTuples } from '../src/bounded/index.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import { checkInvariant, scanReachability } from '../src/reachability/index.js';
import { generateRandomInvariant } from '../src/testing/random-invariant.js';

/** mulberry32 — the same tiny, self-contained seeded PRNG `fuzz.ts` already uses; duplicated rather than imported, for the reason D-117 already gives for not sharing one across this tool's own sibling modules. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCHEMA_TRIALS = 60;
const INVARIANTS_PER_SCHEMA = 4;
const BRUTE_FORCE_K = 1;

describe('differential — §5 exact search vs. §7 bounded search as an independent brute-force oracle', () => {
  it(`across ${SCHEMA_TRIALS} random schemas × ${INVARIANTS_PER_SCHEMA} random goals, every monotone HOLDS from checkInvariant is never contradicted by boundedSearch`, async () => {
    const rng = mulberry32(20260823);
    let checked = 0;
    let inconclusive = 0; // boundedSearch hit MAX_BOUNDED_CANDIDATES — not a disagreement, just no answer at this k
    let skipped = 0; // non-monotone schema, or checkInvariant itself didn't say HOLDS — nothing to cross-check

    for (let s = 0; s < SCHEMA_TRIALS; s++) {
      const seed = `differential-${s}`;
      const random = generateRandomSchema(seed, {
        namespaceCount: 2,
        principalCount: 1,
        maxRelationsPerNamespace: 2,
        maxPermissionsPerNamespace: 1,
        operators: { union: true, tupleToUserset: true, intersection: false, exclusion: false },
      });
      const graph = buildSchemaGraph(random.schema);

      for (let v = 0; v < INVARIANTS_PER_SCHEMA; v++) {
        const invariant = generateRandomInvariant(random.schema, rng, `diff_${s}_${v}`);
        const objectType = invariant.variables.find((x) => x.name === invariant.goal.object)!.type;
        const goalNodeId = `${objectType}#${invariant.goal.permission}`;
        const scan = scanReachability(graph, goalNodeId);

        // Should never actually happen with intersection/exclusion
        // switched off above — kept as a defensive, documented guard
        // rather than an assumption this test silently relies on.
        if (scan.fragment !== 'monotone') {
          skipped++;
          continue;
        }

        const result = checkInvariant(graph, random.schema, invariant);
        if (result.verdict !== 'HOLDS') {
          skipped++;
          continue;
        }

        checked++;
        const candidates = generateCandidateTuples(
          random.schema,
          scan.relations,
          invariant,
          BRUTE_FORCE_K,
        );
        const bruteForce = await boundedSearch(random.schema, invariant, candidates, BRUTE_FORCE_K);

        if (bruteForce.verdict === 'UNKNOWN') {
          inconclusive++;
          continue;
        }

        // The one real assertion this whole file exists to make: an
        // independent, exhaustive brute-force search must never
        // contradict §5's own exact-search HOLDS.
        expect(bruteForce.verdict).not.toBe('VIOLATED');
      }
    }

    // Disclose coverage rather than let a silently-all-skipped run pass
    // trivially — a real check needs `checked` meaningfully larger than
    // `inconclusive` on every run of this suite (no silent caps: §7's
    // own build spec discipline, restated here for this file's own
    // ceiling).
    console.log(
      `differential: ${checked} monotone-HOLDS trials cross-checked, ${inconclusive} inconclusive (MAX_BOUNDED_CANDIDATES ceiling), ${skipped} skipped (non-monotone or non-HOLDS)`,
    );
    expect(checked).toBeGreaterThan(0);
    expect(checked - inconclusive).toBeGreaterThan(0);
  });
});
