/**
 * The single most important file in this repo. Everything else can be
 * wrong in a recoverable way; this file existing and passing is what makes
 * every other claim this project makes checkable rather than asserted.
 *
 * The predecessor suite (`test/rls/postgres.fuzz.test.ts`, before this
 * repo's identity changed — see `test/isolation/README.md`) fuzzed a single
 * function's input space against one hand-written oracle
 * (`IDENTIFIER_PATTERN`) and asserted agreement across thousands of
 * generated strings. This file does the same shape of thing one level up:
 * instead of fuzzing a string against a regex, it fuzzes a whole relation
 * graph — a random schema, a random set of tuples, a random query — against
 * a second, independent implementation of "does a path exist," and asserts
 * the real check engine agrees with it on every single one.
 *
 * **The oracle is the reference resolver** (`Phase 3` of the build spec): a
 * deliberately naive, deliberately slow, in-memory BFS over a fully
 * materialized snapshot of the tuple graph, with no caching, no query
 * planner, no recursion budget beyond the total tuple count. It exists to
 * be obviously correct, never to be fast — the same reason
 * `docs/DECISIONS.md` will record for why it is hand-written rather than
 * derived from the production resolver's own code path. A test that
 * derives its oracle from the thing it's checking proves nothing; see the
 * `test-author` subagent's rule against exactly this in
 * `.claude/commands/build-authz-service.md` §14.
 *
 * **The verdict is asymmetric, and the asymmetry is the point** (mirrors
 * §6.5 of the build spec):
 *
 * - `false_grant` — the production engine said allowed where the reference
 *   resolver, walking the same graph, found no path at all. This is a
 *   security bug. One occurrence anywhere in a run fails the check, full
 *   stop, and a `critical` namespace's false grant fails it regardless of
 *   how the rest of the run went.
 * - `false_deny` — the production engine said denied where a path exists.
 *   This is a correctness bug, worth fixing, and never a security incident.
 *   It does not block on its own.
 *
 * Conflating these two would be the same mistake the build spec's
 * statistical sibling project warns against for `no_detectable_difference`
 * vs `insufficient_data` (§5.4 there): different findings, and treating
 * them as one throws away exactly the distinction that matters most for
 * deciding what to do next.
 *
 * Every test below is `.todo()` until Phase 3 (the reference resolver) and
 * Phase 4 (the production engine) both exist — see
 * `.claude/commands/build-authz-service.md` §9. The fuzz-power test
 * (deliberately breaking the engine and confirming this suite catches it)
 * cannot be written honestly before there is an engine to break.
 */
import { describe, it } from 'vitest';

describe('differential fuzzing — production check engine vs. the naive reference resolver', () => {
  it.todo(
    'across 5,000 random (schema, tuple graph, query) triples, the production engine and the reference resolver agree on every single query — zero false_grant, reported false_deny rate stated even at zero',
  );

  it.todo(
    'every run is seeded and the seed is recorded — replaying a run with the same seed reproduces byte-identical schemas, tuples, queries, and any divergence found',
  );

  it.todo(
    'a run that finds any false_grant records the full resolution path both resolvers took, not just "disagreed" — the same "show the diff, not the score" principle the build spec\'s §5.8 names for its own sibling project\'s PR comment',
  );

  it.todo(
    'a false_grant on a namespace flagged critical fails the run even when the aggregate false_grant rate across the whole graph is otherwise zero',
  );

  it.todo(
    'a false_deny never fails the run on its own; it is reported and counted, never blocking',
  );

  it.todo(
    'random schemas exercise every rewrite-rule kind at least once per run (union, intersection, exclusion, tuple-to-userset) — a generator that only ever produces plain union schemas is testing a fraction of the surface and must be treated as a coverage gap, not silently accepted',
  );

  it.todo(
    'random tuple graphs include at least one cyclic group nesting per run, and the reference resolver itself terminates on it — the oracle has to handle the hard case too, or it is not a valid oracle for it',
  );
});

/**
 * This suite must be able to fail, and this block is where that gets
 * proven — mirrors the build spec's `test-author` subagent rule: "after a
 * test passes, verify it fails when the behavior is broken." A fuzz harness
 * that has never been observed catching a real bug is not evidence it can
 * catch one.
 */
describe('the fuzz harness has power — it catches a deliberately introduced unsoundness bug', () => {
  it.todo(
    'given a production engine with one rewrite branch deliberately skipped (an intersection rule implemented as a union), the fuzz run reports at least one false_grant within the standard 5,000-query budget — proving the harness would have caught this class of bug, not just that it currently reports zero',
  );

  it.todo(
    'given a production engine with cycle detection deliberately removed, the fuzz run either times out in a way the runner reports as its own distinct failure mode, or reports the resulting false state — it never silently passes',
  );
});
