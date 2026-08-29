# TLA+ spec notes — the Leopard-index-plus-fallback protocol

This note accompanies `docs/leopard-index.tla` and `docs/leopard-index.cfg`.
It explains what the spec models and deliberately abstracts away, discloses
plainly what could and could not actually be run in this sandbox, and gives
exact reproduction steps for someone with a real TLC.

Read `docs/leopard-index.tla`'s own header comment first — it carries the
same disclosures in the project's own dense documentary style, next to the
code they describe. This file is the longer-form version, with the actual
transcripts.

## What the spec models

The protocol shipped in `docs/DECISIONS.md` D-163 and designed in
`docs/LEOPARD-INDEX-PROPOSAL.md`: a single global watermark token
(`relation_membership_index_state.watermark_token`), published atomically
with a full index rebuild inside one Postgres transaction
(`TRUNCATE`+recursive-CTE-`INSERT`+watermark-`UPDATE`+`COMMIT`,
`rebuildRelationMembershipIndex` in `src/store/relation-index.ts`); a pinned
check's own `atToken` gating whether `lookupRelationMembershipIndex` may
trust the index (`watermark_token >= requiredFloorToken`) or must fall
through to the live path; and three families of concurrent, interleavable
actions — writes (which mint a new `write_log.token` and can add or remove
a userset edge), rebuild attempts (serialized by a `pg_try_advisory_xact_lock`
in reality, modeled the same way — at most one in flight), and pinned reads.

The property checked is Candidate C from the proposal document — "Watermark
staleness must never produce a false ALLOW," which the proposal itself calls
"the single most load-bearing property in this document" — formalized as
`IndexHitImpliesLiveTruth` (`indexRows ⊆ truthAt[indexWatermark]`) and its
read-shaped companion `ReadHitIsSound`, both in `docs/leopard-index.tla`.

## What the spec deliberately abstracts away, and why a violation here still

## means something real

**The recursive graph walk itself is not modeled.** `fetchReachableFrontier`
(`src/resolve/production/resolver.ts`, "mechanism 2") and the rebuild's own
recursive CTE (`src/store/relation-index.ts`) are both assumed correct — the
task that produced this spec explicitly frames the live path as
"assumed-correct, out of scope for your model," and this codebase's own
D-100 differential-equivalence fuzzing already carries that burden
separately. Modeling it would mean re-deriving a transitive closure from a
tuple graph inside TLA+, which buys nothing for the property under test and
would make the state space depend on graph shape rather than on the
watermark/publication mechanism this spec exists to check.

Instead, "is `subject` reachable from `root` as of write-log token `T`" is
modeled as `truthAt[T]` — an **abstract, opaque relation that `Write`
updates directly** (an edge appears or disappears at the token the write
mints), never recomputed from a lower-level tuple graph. This is the "real
modeling decision" the task asked for, made explicit rather than smuggled
in silently: `truthAt` is not a simplification of the real closure
computation, it is a _stand-in oracle_ standing for "whatever the live path
would correctly say," reused at every reachable model state. A violation of
`IndexHitImpliesLiveTruth` in this model is a real bug in the
**watermark/publication mechanism** regardless of what `truthAt`'s internal
representation is — the invariant only ever inspects `indexRows`,
`indexWatermark`, and `truthAt` at the _same_ token, and never assumes
anything about how `truthAt` itself is computed. That is precisely why a
violation here would correspond to a real class of bug (a torn or
out-of-order publish letting a stale row escape past a bumped watermark),
and precisely why a clean result does **not** by itself prove the real
Postgres code is correct: this spec never inspects a single line of the
recursive CTE, the `DISTINCT ON ... ORDER BY array_length(via_path,1) asc`
collision resolution, or the cycle guard. Those are separate correctness
questions with their own separate evidence (D-100's differential fuzzing,
D-092/D-159's live fail-checks) that this spec does not re-litigate and
does not substitute for. What this spec _does_ rule out, at the level of
abstraction it operates at, is a whole _class_ of concurrency/atomicity bug
in the publication mechanism itself — the class Candidate C exists to name
— independent of whether the underlying graph algorithm is right.

**Not modeled, named rather than silently dropped**, because each is a
separate, orthogonal soundness axis from watermark staleness and each
already has its own dedicated, disclosed, live fail-check in this
codebase's real test suite:

- **Candidate F** (the caller's own `maxDepth` gate on a stored `via_path`'s
  length) — would need path lengths threaded through every edge; orthogonal
  to whether the watermark/rows pair is internally consistent.
  `test/unit/store/dst/relation-index-watermark.dst.test.ts`'s own suite
  fail-checks this directly against real code (`docs/DECISIONS.md` D-163).
- **Candidate G** (the live `min_expires_at` re-check against Postgres's own
  `now()`) — would need a clock and per-edge expiry, again orthogonal to
  the publication-atomicity question. Same test file, same live fail-check
  discipline.
- **Candidate D** (root completeness) — Phase-B-only, does not exist in
  shipped code; not modeled because there is nothing shipped to model.
- The "a schema republish could invalidate the index" candidate — reviewed
  and dismissed in the proposal itself (the closure is schema-independent);
  not modeled here either, for the same reason it needed no property in the
  proposal.

**Rebuild internals collapsed into fewer TLA+ actions than the real code has
SQL statements**, disclosed and justified in the module's own "WHY STEPS
0/0.5/1 COLLAPSE" comment: the lock acquisition, the `rebuild_started_at`
write, and the watermark read are three sequential real statements that are
_jointly_ externally invisible (none of them changes `indexWatermark` or
`indexRows`), so collapsing them into one TLA+ action (`RebuildStart`)
changes nothing about which interleavings a concurrent reader or writer can
observe. The one place this spec refuses to collapse anything is exactly
the one place atomicity is the entire point: watermark publication and rows
publication are `RebuildCommit`'s single, indivisible TLA+ transition in the
real design, and are split into two separate actions
(`RebuildPublishWatermarkEarly` / `RebuildPublishRowsLate`) only in the
named, separate `NextWeakened`/`SpecWeakened` variant that exists
specifically to be wrong.

## Update, 2026-08-29 — the real TLC run now exists

Everything below this point, up through "What remains genuinely open," is
the **original, unedited account** from when this spec was first written:
GitHub Releases were confirmed blocked, and every result was from
`tla-checker`, labeled throughout as an unofficial substitute. That
disclosure is left intact as the historical record — it was true when
written, and rewriting it after the fact would erase a real, honestly-made
constraint.

On a later date (2026-08-29, same day as the DST-evolution/benchmark-harness
work in `docs/DECISIONS.md` D-165/D-166), a routine re-check of
`https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar`
succeeded (`HTTP 200`, a real 2.27MB jar) — this sandbox's network policy
evidently no longer blocks this specific GitHub Releases asset (or never
did, and the earlier block was scoped elsewhere; this was not investigated
further, since the outcome that matters — a genuine `tla2tools.jar` now
runs here — was confirmed directly rather than theorized about). The real,
official TLC (version "2.19 of 08 August 2024") was run against the exact,
unmodified `docs/leopard-index.tla`/`docs/leopard-index.cfg` shipped in this
repo — no changes to either file were needed beyond a local filename
rename (`leopard-index.tla` → `leopard_index.tla`, TLC requires the file
name to match the module name `leopard_index`; the shipped file name is
unaffected, this is purely a local invocation detail, not a spec change).

```
$ java -cp tla2tools.jar tlc2.TLC -config leopard_index.cfg leopard_index.tla
TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)
Running breadth-first search Model-Checking with fp 125 ... 1 worker on 4 cores
Finished computing initial states: 1 distinct state generated
Model checking completed. No error has been found.
  Estimates of the probability that TLC did not check all reachable states
  because two distinct states had the same fingerprint:
  calculated (optimistic):  val = 9.8E-9
  based on the actual fingerprints:  val = 1.2E-9
1863365 states generated, 103052 distinct states found, 0 states left on queue.
The depth of the complete state graph search is 13.
Finished in 06s
```

**103,052 distinct states — an exact match** to the number `tla-checker`
reported below, on the real, official model checker, with `0 states left on
queue` (i.e. genuinely exhaustive, not a cap-hit). This is the strongest
form of confirmation available: two independent implementations (one
official and mature, one unofficial and ~1-month-old) enumerating the
identical state count for the identical spec.

The weakened variant (`SpecWeakened`, same repo files, `SPECIFICATION` line
changed in a local copy of the `.cfg` exactly per the reproduction steps
below) was then run the same way:

```
$ java -cp tla2tools.jar tlc2.TLC -config leopard_index_weakened.cfg leopard_index.tla
...
Error: Invariant IndexHitImpliesLiveTruth is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate> ...
...
State 10: <RebuildPublishWatermarkEarly ...>
/\ currentToken = 2
/\ truthAt = (0 :> {} @@ 1 :> {<<"eng", "alice">>} @@ 2 :> {} @@ 3 :> {})
/\ pendingRows = {}
/\ indexRows = {<<"eng", "alice">>}
/\ indexWatermark = 2
/\ rebuildPhase = "WatermarkPublishedRowsPending"
/\ pendingWatermark = 2

750690 states generated, 58158 distinct states found, 17239 states left on queue.
The depth of the complete state graph search is 10.
Finished in 02s
```

A real, confirmed violation: at state 10, `indexWatermark = 2` and
`indexRows = {(eng,alice)}`, but `truthAt[2] = {}` — the exact same bug
shape `tla-checker` found (ending in `rebuildPhase =
"WatermarkPublishedRowsPending"`, the split-publish phase that cannot exist
under the real, atomic `Spec`), at a slightly different but comparably-sized
state count (58,158 vs. `tla-checker`'s 57,120 — expected, since real TLC's
search order and `tla-checker`'s differ, so they need not explore states in
the same sequence before hitting the first violation; both fully confirm
the same qualitative counterexample). Re-running the real design's own
`Spec` again immediately afterward (same command as the clean run above)
reproduced the identical clean 103,052-state result — the atomic design was
not affected by having just run the weakened one.

**This closes the one gap explicitly named in "What remains genuinely open"
below as unresolved**: a real TLC run of this exact spec now exists, run by
this session, with transcripts reproduced above in full. Every other
disclosed limitation in this document (the recursive CTE / `DISTINCT ON`
collision resolution / `SAVEPOINT` fix are out of this spec's scope;
`MaxToken = 4` was not explored under this run either, since the point was
confirming the existing bound's result on the real tool, not extending it —
raising the bound remains open exactly as described below) stands
unchanged.

## Environment constraint — disclosed plainly, not worked around (original, historical account)

**The real TLC model checker (`tla2tools.jar`) could not be obtained or run
in this sandbox.** What was actually tried, in order, before concluding
that:

1. `which java && java -version` — Java 21 (OpenJDK 21.0.10) is installed
   and works.
2. `find / -iname "*tla2tools*"` and `find / -iname "*.jar" | grep -i tla`
   across `/`, specifically including `/usr`, `/opt`, `/root`, and this
   repo — no cached copy of the jar, or any TLA+-related jar, anywhere on
   disk.
3. `apt list --installed | grep -i tla` and `apt-cache search tla` — no
   `tlaplus`-adjacent package (the only hits are unrelated packages whose
   names happen to contain the substring "tla", e.g. `matlab-*`,
   `gitlab-*`, `aladin`, `librostlab*` — nothing is TLA+).
4. `pip index versions tlaplus` / `pip download tlaplus` — no matching
   distribution.
5. `npm view tlaplus` — 404, does not exist.
6. `curl` to `github.com`, `api.github.com`, and
   `objects.githubusercontent.com` (the only real distribution channel for
   `tla2tools.jar` — it ships via GitHub Releases on `tlaplus/tlaplus`,
   nowhere else) — all confirmed blocked by this sandbox's network policy,
   per the task's own stated constraint.

**One real, non-trivial hit, evaluated and used with its limitations fully
disclosed:** `npm view tla-checker` surfaces a package (`tla-checker`,
backing project `tla-rs` on GitHub, by a single maintainer, first published
about a month before this spec was written). Its own README states plainly:
_"A TLA+ model checker and interactive exploration tool written in Rust
[...] It's a lightweight alternative to the official TLC model checker for
specs that fit its supported subset."_ **This is not the official TLC.** It
is a young, single-maintainer, third-party reimplementation of unknown
fidelity, explicitly self-described as covering only a subset of real
TLA+. It was used anyway, as a genuine, best-effort, clearly-labeled
**supplementary** empirical check — not as a substitute for the real
verification this deliverable's hard constraint says to disclose the
absence of, and every result attributed to it below is captioned as such.

### What was actually run, and what it actually reported

Two smoke tests confirmed the tool is a real, functioning explicit-state
checker (not a stub): a trivial counter spec correctly reported a deadlock
at its own natural terminal state, and, with a tightened `TypeOK`, correctly
reported an invariant violation with a genuine counterexample trace.

Then, against the **actual, final, shipped** `docs/leopard-index.tla` /
`docs/leopard-index.cfg`:

```
$ node run.js leopard-index.tla leopard-index.cfg 5000000 500 no-deadlock
elapsed_ms=24946
{
  "success": true,
  "error_type": null,
  "error_message": null,
  "states_explored": 103052,
  ...
}
```

`states_explored` (103,052) is well under the 5,000,000-state cap passed in,
and the run terminated with `success: true` rather than by hitting that
cap — i.e. this is a report of **exhaustive** exploration of the reachable
state space at the bounds in `docs/leopard-index.cfg`
(`Roots = {"eng","platform"}`, `Subjects = {"alice","bob"}`, `MaxToken = 3`):
`TypeOK`, `IndexHitImpliesLiveTruth`, and `ReadHitIsSound` all hold at every
one of those 103,052 reachable states, under the real, atomic `Spec`. This
is a genuine, reproduced result from a real (if non-canonical) tool
actually run in this sandbox — not a fabricated "no error found" claim.

### The counterexample — the actual point of this exercise

Copying `docs/leopard-index.cfg` with only `SPECIFICATION Spec` changed to
`SPECIFICATION SpecWeakened` (exactly the reproduction steps named in the
`.tla` module's own "HOW TO REPRODUCE" comment) and re-running against the
same module:

```
$ node run.js leopard-index.tla leopard-index-weakened.cfg 5000000 500 no-deadlock
elapsed_ms=13605
{
  "success": false,
  "error_type": "InvariantViolation",
  "error_message": "Invariant 1 violated",
  "states_explored": 57120,
  "trace": [ ...10 states... ]
}
```

`Invariant 1` is `IndexHitImpliesLiveTruth` (0-indexed after `TypeOK`). The
real trace, summarized (full JSON trace text is reproducible by re-running
the command above against the files in this repo):

| State | What happens                                                                                                             | `indexWatermark` | `indexRows`               | `truthAt[indexWatermark]`                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- | ------------------------- | ----------------------------------------- |
| 1     | `Write(Add, eng, alice)` at token 1                                                                                      | 0                | {}                        | —                                         |
| 2     | `RebuildStart` (gen. 1): `pendingWatermark := 1`                                                                         | 0                | {}                        | —                                         |
| 3     | `Write(Remove, eng, alice)` at token 2 — **the revocation**                                                              | 0                | {}                        | —                                         |
| 4     | `RebuildComputeRows` (gen. 1): `pendingRows := truthAt[1] = {(eng,alice)}`                                               | 0                | {}                        | —                                         |
| 5–6   | gen. 1 publishes (watermark early, then rows)                                                                            | 1                | {(eng,alice)}             | `truthAt[1] = {(eng,alice)}` ✓ consistent |
| 7     | `RebuildStart` (gen. 2): `pendingWatermark := 2`                                                                         | 1                | {(eng,alice)}             | —                                         |
| 8     | `RebuildComputeRows` (gen. 2): `pendingRows := truthAt[2] = {}` (correctly empty — the revocation is visible by token 2) | 1                | {(eng,alice)}             | —                                         |
| **9** | **`RebuildPublishWatermarkEarly` (gen. 2): watermark bumped to 2 — rows NOT yet replaced**                               | **2**            | **{(eng,alice)} — stale** | **`truthAt[2] = {}`**                     |

At state 9, `indexRows ⊆ truthAt[indexWatermark]` is
`{(eng,alice)} ⊆ {}` — false. **A `PinnedRead` with any floor `t ≤ 2` for
`(eng, alice)` fired in exactly this state would return `hit = TRUE`** (the
gate `indexWatermark(2) ≥ t` passes, and the stale row is still present) —
a genuine false ALLOW for a subject who was revoked by the very token the
index now claims to be fresh through. This is exactly, and only, the
interleaving that the real design's single-transaction
`TRUNCATE`+`INSERT`+`UPDATE`+`COMMIT` forecloses by construction: state 9
has no counterpart in the real system, because `RebuildCommit` publishes
`indexWatermark` and `indexRows` in one indivisible step, so a reader can
never observe the new watermark without also observing the new rows.

**The atomic design (`Spec`) was re-confirmed clean at the same bounds
after this** — the state-9 shape is reachable _only_ via
`RebuildPublishWatermarkEarly`/`RebuildPublishRowsLate`, which do not exist
in `Next`/`Spec`, only in `NextWeakened`/`SpecWeakened`.

### A false positive this spec itself produced, and the fix — disclosed

### rather than smoothed over

An earlier draft's `ReadHitIsSound` compared a recorded read's `hit` flag
against `truthAt[indexWatermark]` using `indexWatermark`'s **current** value
at invariant-check time, rather than the watermark the read actually
observed when it fired. Running that draft against the **correct, atomic**
`Spec` produced a spurious violation: a `PinnedRead` correctly hit a
perfectly sound, freshly-committed index row; a _later_, unrelated second
rebuild generation then committed (advancing `indexWatermark` further); and
the invariant, re-evaluated at that later state using the _now-advanced_
`indexWatermark`, wrongly compared the old read's witness against a newer
generation's `truthAt` slot that had no reason to still contain it.

This was a bug in this spec's own formalization, not evidence of a real
protocol flaw — diagnosed by tracing the reported counterexample against
the real design's own atomicity argument (which already guarantees
`IndexHitImpliesLiveTruth`, the primary state invariant, cannot fail here)
and confirming the failure was specific to the read-shaped companion
invariant's stale comparison. Fixed by adding `watermarkSeen` to `lastRead`,
frozen at the moment the read fires (`PinnedRead`'s own definition in
`docs/leopard-index.tla`), and comparing against
`truthAt[lastRead.watermarkSeen]` instead. Re-running after the fix
produced the clean, exhaustive 103,052-state result reported above. This is
recorded here rather than silently corrected, matching this project's own
"disclosed inline at the point of correction" discipline
(`docs/LEOPARD-INDEX-PROPOSAL.md`'s own framing) — including for a spec
artifact, not only for shipped application code.

### What was not achieved, and why

A `MaxToken = 4` run (same `Roots`/`Subjects`) against the correct `Spec`
did not complete within a 300-second budget in this sandbox and was
terminated; `MaxToken = 3` (the bound actually shipped in
`docs/leopard-index.cfg`) is the largest bound this session confirmed
tractable with this tool. This is a real, disclosed data point about
`tla-checker`'s own performance in this sandbox (a WASM-hosted,
single-threaded, ~month-old explicit-state search), not a claim about what
the real TLC could do — the official TLC is a mature, JIT-compiled,
multi-threaded Java implementation that would very likely handle
`MaxToken = 4` or considerably larger comfortably; this was simply not
verified, and is not claimed.

## Reproduction steps for a real TLC

```
java -cp tla2tools.jar tlc2.TLC -config docs/leopard-index.cfg docs/leopard-index.tla
```

- `tla2tools.jar` — download from a GitHub Release of `tlaplus/tlaplus`
  (`https://github.com/tlaplus/tlaplus/releases`, the `tla2tools.jar`
  asset). Any recent release works; nothing in this spec uses a newer
  language feature than plain TLA+ with `Naturals`/`FiniteSets`.
- Expected runtime characteristics: at the bounds actually shipped
  (`|Roots| = |Subjects| = 2`, `MaxToken = 3`, ~103k reachable states under
  the correct `Spec`), real TLC should complete in low single-digit seconds
  on ordinary hardware — this bound was chosen specifically to be a "small
  model" in the TLA+ sense (Newcombe et al.'s own "small model hypothesis":
  a bug that depends on interleaving shape, not on scale, shows up at small
  bounds or not at all), not because larger bounds were expected to be
  intractable for a real checker.
- To also reproduce the counterexample: copy `docs/leopard-index.cfg`,
  change only `SPECIFICATION Spec` to `SPECIFICATION SpecWeakened`, and
  rerun the same command against the copy. Expect
  `Error: Invariant IndexHitImpliesLiveTruth is violated.` with a trace
  ending in a state with `rebuildPhase = "WatermarkPublishedRowsPending"`,
  matching the shape reported above (this session's own `tla-checker`
  transcript is reproduced in full above for direct comparison).
- To push bounds further (e.g. `MaxToken = 5`, a third root, or 3-way
  interleavings of two concurrent rebuild attempts racing each other more
  deeply): raise the relevant `CONSTANTS` line in a copy of the `.cfg`; the
  model's cardinality is governed entirely by
  `|Roots| × |Subjects| × (MaxToken+1)` for `truthAt`'s size, so growth is
  linear-ish in each bound individually, not combinatorial across all
  three at once, and TLC's own state-graph memoization means repeated
  rebuild cycles add no new dimension (see `docs/leopard-index.tla`'s own
  "no separate max-rebuild-attempts bound" comment for the full argument).

## What remains genuinely open

- ~~No real TLC run of this spec exists anywhere.~~ **Resolved, 2026-08-29
  — see the "Update" section near the top of this file.** A real, official
  TLC run now exists for both `Spec` (clean, 103,052 states, exact match to
  `tla-checker`) and `SpecWeakened` (violated, 58,158 states, identical
  counterexample shape). This bullet is struck through rather than deleted
  so the original disclosure's own history stays visible.
- **This spec proves the protocol _design_ is not unsound at the
  abstraction level it operates at — it does not prove the real Postgres
  code is correct.** The recursive CTE, the `DISTINCT ON` collision
  resolution, the `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` transaction-poisoning
  fix (D-163's third live-found bug), and the advisory-lock try-lock
  semantics are all real, separate pieces of machinery this spec treats as
  given rather than re-verifies. Their own correctness evidence lives in
  `docs/DECISIONS.md` D-163's own account and the real-Postgres test suite
  it describes (`relation-index.integration.test.ts`,
  `relation-index-concurrent-rebuild.integration.test.ts`, and others) —
  not in this file.
- **Larger bounds were not explored.** `MaxToken = 4` timed out under
  `tla-checker` in this sandbox; whether a real TLC would surface anything
  new at larger bounds (it should not, per the small-model-hypothesis
  argument above, since the counterexample shape does not depend on scale)
  was not independently confirmed.
- **Candidates F, G, and D remain unmodeled**, for the reasons given above
  — genuinely separate work, not something this spec's clean result says
  anything about one way or the other.
