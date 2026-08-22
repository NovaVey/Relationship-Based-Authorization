/**
 * DST D4 — one seeded, reusable scheduler generalizing D0–D3's own ad hoc
 * per-test crash points and interleavings (`docs/DST-PROPOSAL.md`'s phased
 * plan, `docs/DECISIONS.md` D-101). Before this phase, two DST test files
 * each independently hand-rolled the same local seed-only PRNG
 * (`advisory-lock.dst.test.ts` and `production-check.dst.test.ts` each had
 * their own byte-identical `mulberry32` copy — the latter's own doc comment
 * called it "not yet a pattern worth the cross-file dependency (rule of
 * three)"; this phase is that third use), and `production-check.dst.test.ts`'s
 * own flagship `it.each([2, 3])` test hand-wrote the "arm a pause, start the
 * operation under test, confirm it's genuinely suspended, run something
 * concurrent, resume, observe the result" choreography in full (its own
 * seeded 6-seed sweep reused the pause/resume mechanics but — a real,
 * pre-existing gap this phase closes rather than merely relocates — never
 * actually confirmed suspension at all). Every test ported onto this module
 * keeps its own exact assertions; the *seeded draws themselves* change,
 * since `dstRngFromSeed` is a different, more heavily-audited generator than
 * the ad hoc PRNGs it replaces — see `docs/DECISIONS.md` D-101 for the full
 * "what changed vs. what stayed invariant" accounting the D4 exit criterion
 * ("the abstraction changes only how a test is driven, not what it tests")
 * actually requires.
 *
 * **Seeded randomness (`dstRngFromSeed`).** Reuses `src/soundness/
 * generators.ts`'s own `SeededRng`/`hashSeedToInt31` — exported for DST D3's
 * own reuse (`docs/DECISIONS.md` D-100) and now a second consumer — rather
 * than inventing a new PRNG, per `docs/DST-PROPOSAL.md`'s own explicit
 * instruction ("built on the same `fast-check`/`pure-rand` infrastructure
 * this project already chose"). Deliberately *not* the identical route as
 * `generators.ts`'s own private `buildRng` helper: that one sizes its draw
 * pool from a fixture's own `queryCount`, a concern specific to schema/tuple
 * fixture generation that has no analog here. It also is *not* the identical
 * route `frontier-equivalence.integration.test.ts`'s own local `buildRng`
 * (D-100) takes, even though the two recipes are now byte-identical apart
 * from `unbiased: true` below — that file is deliberately left untouched by
 * this phase (its own suite cannot be run in this sandbox; see D-100's own
 * "Revisit if D4 lands" note for the explicit deferral), so this is the
 * *second* existing copy of the recipe, promoted here as DST's own shared
 * default for new work, not a retroactive unification of the first.
 *
 * `unbiased: true` is passed to `fast-check`'s own `sample` below — a real,
 * previously-latent fidelity gap the adversarial review behind D-101 found
 * and this phase fixes for its own draw pool specifically: `sample` without
 * it draws from a *biased* sub-range for early/short pools (`fast-check`'s
 * own documented `runIdToFrequency` behavior), measured here as ~58.5%
 * true on `nextBoolean()` (vs. the intended 50%) and over a third of large-
 * range draws landing within the bottom 0.1% of the range. `generators.ts`'s
 * own private `buildRng` and `frontier-equivalence.integration.test.ts`'s
 * own copy share this identical gap and are **not** fixed by this change —
 * touching the production soundness fuzzer's own draw distribution is a
 * materially larger, separately-reviewable decision, out of this phase's own
 * scope; see `docs/DECISIONS.md` D-101's own "Revisit if" for the pointer.
 *
 * **The pause/resume race (`raceUnderPause`).** Generalizes the choreography
 * `production-check.dst.test.ts`'s own flagship test hand-wrote: arm
 * `source.armNextConnectionPause` at a chosen statement, start the operation
 * expected to suspend there ("the held op"), confirm it genuinely suspended,
 * run a second, concurrent operation while the first is still suspended,
 * resume the held op, and return its result. Confirming suspension no longer
 * guesses from a fixed microtask-flush budget the way every hand-written
 * copy of this pattern did (a soft, droppable `expect(settled).toBe(false)`
 * after a fixed number of `Promise.resolve()` hops) — the same adversarial
 * review found that guess was silently *vacuous* for `productionCheck`'s own
 * real statement sequence, which needs more microtask hops to settle than
 * the old fixed budget ever drained, meaning a completely dead pause
 * mechanism would still have passed every D-092 phantom-witness race test.
 * This function instead races the held op's own completion against
 * `armNextConnectionPause`'s own `fired` signal (`source.ts`), which
 * resolves only when the pause genuinely, verifiably triggers — no guessing,
 * no fixed budget to outgrow. **Constraint this imposes on callers, stated
 * plainly rather than left implicit:** `concurrentOp` must not depend on or
 * contend with any resource `heldOp` is holding while suspended (e.g. an
 * advisory lock `heldOp` acquired before its own pause point) — `resume()`
 * only runs after `concurrentOp` completes, by design, so that a concurrent
 * write is guaranteed to fully land before the paused op's own remaining
 * statements execute (the exact ordering the D-092 race needs); pairing it
 * with a `concurrentOp` that can only complete *after* `heldOp` resumes
 * deadlocks both, the same way two real Postgres sessions would.
 */
import { integer, sample } from 'fast-check';
import { SeededRng, hashSeedToInt31 } from '../../soundness/generators.js';
import type { FakeConnectionSource } from './source.js';

/**
 * Sized for this module's own draw shape, not fixture generation's — a DST
 * test typically draws a handful of scheduling decisions (a crash/pause
 * point, a boolean branch, a small pick), so this is deliberately generous
 * headroom for many such draws across one test, not a tight fit. Matches
 * `frontier-equivalence.integration.test.ts`'s own `DRAW_POOL_SIZE`
 * precedent (D-100) — see this file's own top-of-file doc comment for why
 * that file's own copy of the recipe is not itself touched by this phase.
 */
const DEFAULT_DRAW_POOL_SIZE = 4_000;

/**
 * The one canonical seed → deterministic-RNG construction for DST tests —
 * see this file's own top-of-file doc comment for why this exists instead
 * of each test file hand-rolling its own PRNG or its own copy of this exact
 * `fast-check`/`pure-rand` recipe, and for why `unbiased: true` is here.
 * The same seed always produces the same draw sequence, on any machine,
 * forever — the entire point of a seeded scheduler.
 */
export function dstRngFromSeed(seed: string, poolSize: number = DEFAULT_DRAW_POOL_SIZE): SeededRng {
  const numericSeed = hashSeedToInt31(seed);
  const pool = sample(integer({ min: 0, max: 0x7fffffff }), {
    seed: numericSeed,
    numRuns: poolSize,
    unbiased: true,
  });
  return new SeededRng(pool);
}

/**
 * Waits for up to 20 already-queued microtask hops to actually run, without
 * advancing any real clock — enough headroom for every settle path this
 * DST fake's own hand-driven raw-connection choreography needs today (a
 * deliberately bounded budget, not a claim of draining the queue until it's
 * provably empty — `raceUnderPause` below no longer depends on this bound
 * to detect a genuine pause, precisely because that bound turned out not to
 * be generous enough for every real caller; see this file's own top-of-file
 * doc comment). The in-memory-fake equivalent of a real Postgres regression
 * test's `sleep(500)` (`test/unit/store/tuple-store.integration.test.ts`),
 * but deterministic. The one canonical copy — previously duplicated
 * byte-for-byte in `advisory-lock.dst.test.ts` and
 * `production-check.dst.test.ts`, both of which still use it directly for
 * their own real-lock-contention choreography (not a pause/resume race, so
 * `raceUnderPause` doesn't apply there).
 */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

export interface RaceUnderPauseOptions<T> {
  /** The connection source `heldOp` will open its own connection against — `armNextConnectionPause` is armed on this source's *next* `.connect()` call, so `heldOp` must be the thing that opens that next connection (matches every existing call site: `productionCheck`/`writeTuple`-shaped callers each open exactly one connection per call). `concurrentOp` is never invoked until `raceUnderPause` has already confirmed the arm was consumed by a connection that genuinely paused, so it can never itself race `heldOp` for the arm. */
  source: FakeConnectionSource;
  /** After this many successful statements on the connection `heldOp` opens, its next statement genuinely suspends — see `source.ts`'s own `armNextConnectionPause` doc comment for the exact statement-counting contract. */
  pauseAfterStatements: number;
  /** The operation expected to pause mid-flight — typically a real `productionCheck`/`writeTuple`/`deleteTuple` call, or a hand-driven raw-connection statement sequence. */
  heldOp: () => Promise<T>;
  /** Runs only after `heldOp` is confirmed genuinely suspended — typically a real concurrent write on a *different* connection, racing against the frozen state `heldOp` is mid-way through observing. Must not contend with any resource `heldOp` is holding while paused — see this file's own top-of-file doc comment. */
  concurrentOp: () => Promise<void>;
}

/**
 * See this file's own top-of-file doc comment on "the pause/resume race."
 * Throws if `heldOp` settled (successfully or by rejecting) before its own
 * armed pause ever genuinely fired — see the fail-checks this ships with
 * (`scheduler.dst.test.ts`) for live demonstrations of this failure mode,
 * including the specific vacuous-microtask-budget bug the adversarial
 * review behind D-101 found and this design closes.
 */
export async function raceUnderPause<T>(opts: RaceUnderPauseOptions<T>): Promise<T> {
  const { source, pauseAfterStatements, heldOp, concurrentOp } = opts;
  const { resume, fired } = source.armNextConnectionPause(pauseAfterStatements);

  let heldOutcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  const heldPromise = heldOp().then(
    (value) => {
      heldOutcome = { ok: true, value };
      return value;
    },
    (error: unknown) => {
      heldOutcome = { ok: false, error };
      throw error;
    },
  );
  // If heldOp rejects before `fired` ever wins the race below, that
  // rejection is still surfaced (in the thrown error's own message,
  // constructed from `heldOutcome` once available) rather than left as an
  // unobserved rejection on this second reference to the same promise.
  heldPromise.catch(() => {});

  const winner = await Promise.race([
    fired.then(() => 'fired' as const),
    heldPromise.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
  ]);

  if (winner === 'settled') {
    const cause =
      heldOutcome?.ok === false
        ? `it rejected before the pause ever fired: ${
            heldOutcome.error instanceof Error
              ? heldOutcome.error.message
              : String(heldOutcome.error)
          }`
        : `either the operation's real statement sequence is shorter than pauseAfterStatements ` +
          `expects, the pause mechanism itself failed to fire, or heldOp never opened the ` +
          `connection this pause was armed on (a different connection consumed the one-shot arm ` +
          `first)`;
    throw new Error(
      `DST scheduler: raceUnderPause expected the held operation to genuinely suspend at ` +
        `pauseAfterStatements=${pauseAfterStatements}, but it settled before that ever happened — ` +
        `${cause}. A race that never actually raced proves nothing about the property under test.`,
    );
  }

  await concurrentOp();
  resume();
  return heldPromise;
}
