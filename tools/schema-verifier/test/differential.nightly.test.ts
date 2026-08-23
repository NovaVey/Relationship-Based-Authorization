/**
 * §8b's nightly counterpart to `test/differential.test.ts` — build
 * spec's own words: "enumerate every type-valid tuple set up to 3
 * objects per type, evaluate every check through the real engine.
 * Verdicts must agree. This is slow and that's fine; run it nightly,
 * not on PRs."
 *
 * Same design as the PR-speed differential test (see that file's own
 * doc comment for the full rationale — independent brute-force
 * cross-check of §5's `checkInvariant` `HOLDS` verdicts specifically,
 * monotone fragment only, same architectural reason non-monotone
 * schemas are skipped: `boundedSearch` is already the "smart" answer
 * there and is self-validated by construction). The only real
 * differences: a bound of `k = 3` (this tool's own `k`, meaning up to 3
 * *fresh* instances per type on top of the goal's own given labels —
 * the build spec's own "3 objects per type" phrasing doesn't specify
 * whether that count includes the given object; this project reads it
 * generously, matching the spec's own "this is slow and that's fine"
 * framing rather than under-covering to stay fast), and a much larger
 * schema sample (150, vs. the PR test's 60) — both deliberately
 * unaffordable inside a PR-blocking budget, which is exactly why this
 * file is excluded from the default suite
 * (`vitest.config.ts`'s own `*.nightly.test.ts` exclusion) and run only
 * by `.github/workflows/schema-verifier.yml`'s own scheduled job.
 *
 * Calibration (see `docs/DECISIONS.md`): 30 schemas × 4 goals at k = 3
 * took ~58s locally, with roughly two-thirds of trials genuinely
 * cross-checked (the rest inconclusive — `MAX_BOUNDED_CANDIDATES`, or
 * skipped as non-monotone/non-HOLDS). 150 schemas keeps the full nightly
 * run to single-digit minutes while giving several hundred genuinely
 * cross-checked trials — comfortably more coverage than the PR-speed
 * test's own 216, at a bound the PR test can't afford.
 */
import { describe, expect, it } from 'vitest';

import { generateRandomSchema } from '../../../src/schema/dsl/random.js';
import { boundedSearch, generateCandidateTuples } from '../src/bounded/index.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import { checkInvariant, scanReachability } from '../src/reachability/index.js';
import { generateRandomInvariant } from '../src/testing/random-invariant.js';

/** mulberry32 — see `differential.test.ts`'s own identical helper and D-117 for why it's duplicated rather than shared. */
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

const SCHEMA_TRIALS = 150;
const INVARIANTS_PER_SCHEMA = 4;
const BRUTE_FORCE_K = 3;

// Generous per-test timeout — this file is explicitly allowed to be
// slow (build spec's own words), and the default 5s budget that caught
// the k=2 candidate-count blowup in D-118's own fail-check would
// otherwise fail this test on its own deliberate slowness.
const NIGHTLY_TEST_TIMEOUT_MS = 600_000;

describe('differential (nightly) — §5 exact search vs. §7 bounded search at k = 3, over 150 random schemas', () => {
  it(
    `across ${SCHEMA_TRIALS} random schemas × ${INVARIANTS_PER_SCHEMA} random goals at k = ${BRUTE_FORCE_K}, every monotone HOLDS from checkInvariant is never contradicted by boundedSearch`,
    async () => {
      const rng = mulberry32(20260823);
      let checked = 0;
      let inconclusive = 0;
      let skipped = 0;

      for (let s = 0; s < SCHEMA_TRIALS; s++) {
        const seed = `differential-nightly-${s}`;
        const random = generateRandomSchema(seed, {
          namespaceCount: 2,
          principalCount: 1,
          maxRelationsPerNamespace: 2,
          maxPermissionsPerNamespace: 1,
          operators: { union: true, tupleToUserset: true, intersection: false, exclusion: false },
        });
        const graph = buildSchemaGraph(random.schema);

        for (let v = 0; v < INVARIANTS_PER_SCHEMA; v++) {
          const invariant = generateRandomInvariant(random.schema, rng, `diffn_${s}_${v}`);
          const objectType = invariant.variables.find(
            (x) => x.name === invariant.goal.object,
          )!.type;
          const goalNodeId = `${objectType}#${invariant.goal.permission}`;
          const scan = scanReachability(graph, goalNodeId);

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
          const bruteForce = await boundedSearch(
            random.schema,
            invariant,
            candidates,
            BRUTE_FORCE_K,
          );

          if (bruteForce.verdict === 'UNKNOWN') {
            inconclusive++;
            continue;
          }

          expect(bruteForce.verdict).not.toBe('VIOLATED');
        }
      }

      console.log(
        `differential (nightly, k=${BRUTE_FORCE_K}): ${checked} monotone-HOLDS trials cross-checked, ${inconclusive} inconclusive (MAX_BOUNDED_CANDIDATES ceiling), ${skipped} skipped (non-monotone or non-HOLDS)`,
      );
      expect(checked).toBeGreaterThan(0);
      expect(checked - inconclusive).toBeGreaterThan(0);
    },
    NIGHTLY_TEST_TIMEOUT_MS,
  );
});
