# The full proof, build, and review history

This is the chronological account of every proof mechanism, review, and
hardening pass built on top of the core result the
**[README](../README.md)** states up front: differential fuzzing found
0 false_grant/0 false_deny across 5,000 random queries. It used to live
directly on the README's own front page, growing one narrated entry at a
time as each new proof shipped, until the page itself became a chronicle
of _how_ this project got here rather than a description of what it _is_
today. It moved here so the README can stay focused on capability, model,
and the soundness claim, while this document keeps every entry exactly as
written — nothing here is summarized or condensed relative to what the
README used to say verbatim.

Read top to bottom for the real order events happened in: each proof
mechanism was added because the ones before it left a specific, named gap
the next one exists to close, and several sections below found and fixed
real bugs building the proof itself, not just describing one. `docs/
DECISIONS.md` is the underlying decision log every section below cites by
number (`D-NNN`) for the complete reasoning and fail-check record; this
document is the narrative connecting those entries into one continuous
account.

## Also proven: the write path survives a crash mid-transaction, and every advisory lock actually blocks

Differential fuzzing (the README's own soundness result) proves the
**check engine** never grants a permission no real path supports. A
second, complementary effort — deterministic simulation testing (DST) —
proves the **write path** itself stays correct under faults an ordinary
integration test can't reach on demand: a connection dying mid-transaction,
two writers genuinely racing for the same advisory lock. It runs against
an in-memory fake at the storage seam, never inside real Postgres —
Postgres isn't crash-injectable or byte-for-byte replayable from outside
its own process the way this project's own code is, and claiming otherwise
would be the kind of overclaim this project's soundness language already
refuses to make (see **[`docs/DST-PROPOSAL.md`](DST-PROPOSAL.md)**'s full
design and `docs/DECISIONS.md` D-095 for why). Six phases have landed so
far:

- **D0** — a crash injected between the tuple-row insert and its
  write-log insert leaves neither behind. Building faithful crash
  injection exposed a real, previously-undiscovered bug live: a naive
  rollback-on-error handler with no inner try/catch silently replaced the
  real failure with the rollback's own whenever a genuinely dead
  connection couldn't run `ROLLBACK` either (D-097).
- **D1** — a real, Promise-based advisory-lock engine (a FIFO wait queue,
  not a boolean flag or polling) generalizes the D-083 write-log-lock
  regression test across seeds, and proves a session-scoped lock
  (`migrate.ts`'s migrations lock) genuinely auto-releases when its
  holding connection dies (D-098).
- **D2** — `REPEATABLE READ` snapshot isolation, anchored at a
  transaction's first real query exactly like real Postgres, wired
  through the real, unmodified `productionCheck` engine. Reproduces the
  project's own previously-fixed D-092 "phantom witness" regression (a
  check citing two facts that never coexisted at one real database
  moment) deterministically — no real Postgres `LOCK TABLE` trick needed,
  the fake's own `armNextConnectionPause` gets the identical controlled
  race for free — and proves it stays closed across seeded interleavings
  (D-099).
- **D3** — a real, multi-level recursive-frontier BFS
  (`fetchReachableFrontierVia`), replacing D2's own seed-row-only stopgap,
  replicates real Postgres's `WITH RECURSIVE`/`DISTINCT ON` semantics
  exactly: iterative working-table rounds, per-iteration (never global)
  dedup, and a per-row (never global) cycle guard. Proven equivalent to the
  real recursive CTE by a seeded differential sweep — 300 random cyclic,
  reconvergent userset graphs run against both a real Postgres
  testcontainer and the in-memory BFS, comparing the reached-identity set
  and each identity's own minimum depth (never the raw, per-implementation
  max depth — a real, adversarial-review-caught distinction; see D-100) —
  plus a direct replay of D-092's own hardest known case (a 12-level,
  branching-3 reconvergent-diamond chain) (D-100).
- **D4** — one seeded, reusable scheduler (`dstRngFromSeed`/`raceUnderPause`)
  replaces D0-D3's own ad hoc per-test PRNGs and hand-rolled pause
  choreography. An adversarial review found the replacement's own
  "confirm it's genuinely suspended" check was silently vacuous for
  `productionCheck` — a fixed microtask-flush budget that settled _before_
  a real pause could ever be confirmed, so a completely dead pause
  mechanism still passed all 8 D-092 race tests. Fixed with a real fired
  signal from the connection layer instead of a guess, live-verified by
  replaying the exact break: the same no-op pause now fails all 8 tests as
  it should. Same review also caught a real, measurable RNG bias
  (`fast-check`'s `sample` without `unbiased: true`, ~58.5% vs. the
  intended 50% on a boolean draw) — fixed for this module's own pool,
  flagged as an open, separately-scoped finding for the two other copies
  this project's soundness fuzzer still carries (D-101).
- **D5** — real CI wiring: a PR job comments pass/fail on every pull
  request, a nightly job sweeps 2,000 seeds per test file instead of a
  handful, and both run the _identical_ test logic — one shared
  `DST_SEED_COUNT`-driven knob (`dstSeedList`), never a separate,
  harder-to-trust nightly-only code path. Landing it surfaced and closed a
  real, previously-unnoticed gap: `publishSchema`'s own two real SQL
  statements were never registered against the fake and no DST test ever
  called it end to end — fixed, plus a structural recognizer-coverage gate
  (a manifest + a shape-count tripwire) so a future shape can't go
  unregistered the same way silently. A regression corpus
  (`docs/dst-regression-corpus.json`) replays every future seed-found bug
  on every PR forever; it ships empty today, honestly, since every bug
  found through D-101 was found by a fail-check or an adversarial review,
  never by seed exploration turning up a surprise. An adversarial review of
  this phase's own new work found and fixed a real gap of its own: corpus
  seeds were never checked against this project's identifier grammar
  before being used, so a malformed entry would have failed downstream
  with a confusing, unrelated-looking error instead of a clear one
  pointing at the actual bad entry (D-102).

`npx vitest run test/unit/store/dst/` runs the DB-free half of it — no
Postgres, no Docker, identical result every time. D3's own
differential-equivalence proof against real Postgres lives alongside the
other `*.integration.test.ts` suites (`npm run test:integration`) since,
unlike the rest of DST, it genuinely needs a real database to check itself
against. `.github/workflows/dst.yml` runs the DB-free suite on every PR and
nightly at a much larger seed count — see D5/D-102 above.

## A third proof: the static schema verifier

The two proofs above are existential: differential fuzzing (README) samples
random `(schema, tuple graph, query)` triples and confirms the check engine
agrees with an independent oracle on each one; DST (previous section)
confirms the write path survives specific injected faults. Neither says
anything about a tuple set neither has happened to try yet.
`tools/schema-verifier/` asks a universal question instead — for a _given
schema_, is there any possible tuple set at all that could ever produce an
unsafe grant — and answers it once, structurally, rather than by sampling.

For the **monotone** fragment (union and tuple-to-userset only — no
intersection, no exclusion), the answer is a genuine proof: a small-model
property means an exhaustive search over the schema graph is enough to
say `HOLDS` with certainty, or produce a concrete counterexample. Outside
that fragment, it falls back to a **bounded** search (`HOLDS up to k = N`,
never bare `HOLDS`) — honest about the difference, never silently
promoted. Every `VIOLATED` verdict is self-validated before it's ever
reported: the witness tuples are written to a real scratch store and
checked through the actual, unmodified production engine, so a
counterexample is never just a static tool's opinion. Full worked example,
the invariant language, and the CLI's own exit-code table:
[`tools/schema-verifier/README.md`](../tools/schema-verifier/README.md).

It's wired into this repo's own CI as a required status check
(`.github/workflows/schema-verifier.yml`) — every PR proves
`org#view = member - banned` still holds against `schema/example.authz`,
this repo's own real, live schema, not a demo fixture. And it's been run
against twelve real, published schemas this project didn't write (five
OpenFGA `sample-stores`, seven SpiceDB — six `authzed/examples`, one
`authzed/docs`): **originally**
nine came back `VIOLATED` and three `HOLDS`, with eight of those nine
sharing one root cause — the invariant language had no way to state a
_negative_ precondition, so any goal reachable via a directly-grantable
relation was trivially escapable. Closing that gap for two of the nine (a
new `notRelationEquals` primitive, D-131) moved the count to
**7 `VIOLATED`, 5 `HOLDS`** for a time — one of those five later moved
back to `VIOLATED` once a newer exact SMT tier (D-151) started deciding
its goal instead of an earlier, non-exhaustive bounded search (D-176),
moving it to **8 `VIOLATED`, 4 `HOLDS`**. A second, stronger primitive
closed the remaining six violations sharing that same root cause —
`never <namespace>#<relation>(<var>)`, "this relation can never be
satisfied via any object, anywhere" (not just one already-known fact),
namespace-qualified by design after an adversarially-found unsoundness
(two unrelated namespaces can share a relation name; a bare-name match
would silently conflate them) made that qualifier a correctness
requirement, not a style choice — bringing the real, current, and now
permanently regression-tested count to **2 `VIOLATED`, 10 `HOLDS`**. The
remaining two (`openfga-expenses`, `spicedb-userdefined-roles`) are each a
distinct escape shape neither primitive was designed to reach. The
survey's own biggest result was never any one schema — it's this finding
about the invariant language itself, and the fact that closing it was a
real, tracked story with two purpose-built primitives, not a static
snapshot. Full table and reasoning: [`docs/FINDINGS.md`](FINDINGS.md).
An OpenFGA front end (D-178) and a SpiceDB front end (D-179) now both
translate a real model into this project's own DSL automatically, each
verified against the real upstream source for every survey entry in its
own ecosystem — including, on the SpiceDB side, a real precedence
inversion (SpiceDB's own `+` binds tighter than `&`/`-`, the opposite of
this DSL's own grammar) handled correctly with no special-casing at all,
since the same printer built for OpenFGA already parenthesizes from tree
shape alone.

`docs/DECISIONS.md` D-114 through D-131 (and, for the second closing
primitive above, D-182) has the complete build history — the small-model
property and exactly where it stops applying, the SMT encoding sketch for
the general case, why the verifier imports this repo's own parser and
engine rather than reimplementing either, the ten-item
definition-of-done checklist confirmed against the real, shipped result
rather than assumed (D-114–D-126), and three further real fixes that
landed after that checklist first closed: a confirmed false `HOLDS` in
the monotone-fragment exact prover (D-129), exact decisions for some
intersection/exclusion cases (D-130), and the `notRelationEquals`
primitive above (D-131). Tag `schema-verifier-v1-complete` marks the
commit where the original ten-item checklist closed; the verifier's own
soundness and expressiveness kept improving past that tag, disclosed here
rather than left for the tag to imply otherwise. The nightly k=3
differential test the verifier's own test suite always had was only
actually wired into a scheduled CI job later (D-134). The SMT encoding
sketch above stopped being just a sketch (D-151): a real `z3-solver`-backed
tier now decides the **non-recursive** fragment exactly — one uninterpreted
sort per namespace, one predicate per relation, satisfiability asked
directly, every `SAT` result replayed through the real engine before ever
being trusted, recursion detected and declined rather than risked. Track
real, current status in [`PROGRESS.md`](../PROGRESS.md).

## A fourth proof: metamorphic and mutation testing — plus a real deadlock found, reproduced, and fixed

The three proofs so far — differential fuzzing (README), DST, and the
static schema verifier (both above) — all check things this project
already knew to check for. A **live-verification doc audit** asked a
different question instead — does anything already written down still
match reality — by having 7 parallel review agents actually execute every
documented command and count every claimed number against live ground
truth, rather than re-reading prose and comparing it to code by
inspection. It found real, confirmed drift: `docs/DST-PROPOSAL.md` still
opened "A proposal, not yet built" while the entire design it describes
had shipped weeks earlier as D-097 through D-102; two other docs both
claimed the third-party schema survey's OpenFGA/SpiceDB split was "six and
six," when the real split, confirmed by reading every source file's own
header, is five and seven. Both fixed, along with six more confirmed
findings — see `docs/DECISIONS.md` D-139.

That audit was the first of four requested in sequence. The next three are
genuinely new ways of checking the engine itself, not the docs describing
it:

- **Metamorphic/invariant testing** (`test/metamorphic/`, D-140) checks
  algebraic properties — idempotence, write-order commutativity,
  monotonicity — directly against the real, unmodified production engine,
  needing no second implementation to compare against. This closes a blind
  spot differential fuzzing (README's own soundness result) structurally
  cannot reach: a bug the production engine and the independent reference
  resolver both share, from a common misreading of the same spec sentence,
  would still agree with itself and pass every differential run forever.
  All 7 originally-proposed properties turned out flawed on adversarial
  review before a line of implementation code was written — one property's
  own "backward" half was proven **false** by a constructed
  counterexample, not just softened. What shipped: 5 new files, 69 new
  tests, zero existing files modified, including
  `src/metamorphic/monotonicity.ts`'s classifier — sound but deliberately
  incomplete: a genuinely-monotone cyclic permission gets conservatively
  misclassified `false`, since the alternative risks the opposite,
  actually-dangerous direction — a real soundness bug in the classifier
  itself.

- **Mutation testing** of the four files carrying this project's actual
  soundness/audit guarantees — `resolver.ts`, `tuples.ts`, `publish.ts`,
  `checks.ts` — hand-curated and live-executed, the same discipline
  `tools/schema-verifier` already established at D-119, not a mechanical
  operator-flipping framework. Of 21 hand-chosen candidates, 5 were real,
  previously **100%-uncovered** coverage gaps, each closed with a new,
  fail-checked test (D-141). Two: narrowing `evalRewrite`'s
  `tupleToUserset` case to try only the first stored subject a followed
  relation returns — nothing in the schema stops a `parent`-style relation
  from carrying more than one tuple on an object, and no fixture anywhere
  had ever written two; and dropping the relation predicate from
  `fetchReachableFrontier`'s recursive CTE join, letting a userset tuple
  stored under one relation leak into a _different_
  relation's transitive frontier on the same object. Both mutations passed
  all 792 fast tests and every real-Postgres fixture that existed at the
  time — a concrete input sequence reaching a wrong `allowed` answer today,
  in shipped code, that nothing caught.

- **A real concurrent load test**
  (`test/unit/api/concurrent-load.integration.test.ts`, D-142) fires
  genuine OS-level HTTP concurrency — a real `app.listen()` socket, Node's
  `fetch`, `Promise.all` — at a real, listening server, distinct from DST's
  deterministic single-process fault injection (previous section). 30 real
  concurrent `DELETE /tuples` calls against the 20/minute rate limit:
  exactly 20 succeed, exactly 10 return `429`, nothing hangs or
  double-counts. A second test races a real revocation against a burst of
  concurrent `/check` calls to confirm the D-135 cache epoch fence holds
  under genuine, non-deterministic timing, not just DST's controlled
  pauses.

The metamorphic tests above also **found a real production bug as a
byproduct — then it was reproduced live a second time, then fixed.** An
early draft of one property test ran two query batches concurrently — 40
concurrent `productionCheck` calls via `Promise.all` — and deadlocked for
real against local Postgres: every connection was consumed by checks' own
pinned `REPEATABLE READ` clients before any of them could obtain the
_second_, separate connection `getConfig`'s `namespace_configs` lookup
needed — a genuine structural hazard inside `productionCheck`/`expand()`
themselves, disclosed but not fixed at the time (D-140). Building the
concurrent load test above independently reproduced the identical hang live
a second time while deliberately shrinking the connection pool to force
more real scheduling variance: `pool.max: 4` with 10 concurrent checks hung
outright, killed after a 2-minute timeout, not a flake (D-142). D-143 then
fixed it for good: `getConfig` now shares its check's own pinned connection
instead of opening a second one, closing the hazard for every caller of
`productionCheck`/`expand()` permanently, not just the one call path that
happened to surface it. Decisively verified live, not just reasoned through
— the exact hanging scenario went from a **2+ minute hang to 35ms**, all 10
checks correctly `allowed: true`.

Not everything this batch touched closed cleanly. The concurrent-load
test's own epoch-fence race has still never actually been caught live, even
after the deadlock fix made it safe to retry under a smaller, more
contended pool — real timing on a fast, jitter-free sandbox never lands
inside the microsecond-scale window DST constructs on demand. That property
is proven the deterministic way instead, by D-135's own unit test and by
D-141's mutation pass; the load test is documented as complementary
evidence that nothing crashes or is silently wrong under real traffic, not
a substitute for either. Full account of all five:
[`docs/DECISIONS.md`](DECISIONS.md) D-139 through D-143.

## A scope decision, two proof extensions, a tamper-evident audit log, and a schema safety net

The four proofs above (README's soundness result, plus DST, the static
schema verifier, and metamorphic/mutation testing, all in this document)
cover the check engine, the write path, a schema's abstract safety, and —
via metamorphic/mutation testing — blind spots none of the others can
reach. A feature-ideation pass raised about 28 further ideas; most turned
out to be "just build it," but one needed a real, explicit decision before
any code could touch it.

**D-144 — caveats, reopened narrowly, not drifted into.** D-114 named
caveats (SpiceDB-style attribute conditions on a relation) explicitly out
of scope for v1, and explicitly invited a future, dated decision to
reopen it if a real need ever surfaced — never a silent drift. One did:
time-boxed contractor/reviewer access, which today can only be expressed
by an external cron job deleting tuples out-of-band — exactly the
"authorization logic scattered outside the system of record" failure the
README opens by naming. **What's now in scope:** a closed-form time-window
check on a tuple (an `expires_at` comparison against the current clock,
provable the same way `atToken`'s floor comparison already is). **What
stays out, unchanged:** a general attribute/context-evaluation engine
(CEL/Rego/Cedar-style) — the README's own "What this is not" section
still holds that line. This entry was a decision only, with no code — the
narrow form itself, expiring/time-boxed tuples, shipped separately
afterward (see below).

**D-171 — wildcard subjects, reopened for the same reason, closed with code
this time.** D-114 also named wildcard subjects (`user:*`, "any
authenticated user can view this") out of scope, for the identical reason:
no analog anywhere in the frozen grammar. A relation now opts in explicitly
(`relation viewer: user | user:*`) — never implied by declaring the plain
`user` type alongside it. The soundness argument holds by construction: both
resolvers already funnel every rewrite mechanism through exactly one
subject-comparison site each, so the wildcard fix touches only that one site
in each, and an exclusion's `base`/`subtract` can never disagree about what
counts as a match — the same symmetry that keeps a D-158-class bug from
recurring. `listUsers` needed a real fix, not just a type widening: its
combinators now track wildcard coverage per subject namespace, and refuse
outright (never approximate) the one genuinely co-finite shape a
wildcard-minus-concrete-exceptions subtraction produces. Two new permanent
metamorphic properties, run against the real production and reference
engines, are the mandatory gate this shipped behind — full account:
[`docs/DECISIONS.md`](DECISIONS.md) D-171.

Five further items shipped, built in parallel as independent, isolated
pieces of work:

- **Schema-parser crash-safety fuzzing** found a real, previously-
  undiscovered bug: a flat, unparenthesized exclusion (`-`) chain has no
  depth ceiling at all — unlike `|`/`&` (already flattened) or `(`
  nesting, exclusion isn't associative and is therefore never flattened.
  A ~5,000-term chain, well inside `POST /schema/compile`'s real
  request-body cap, threw a raw, unhandled `RangeError`. Fixed by
  charging exclusion links against the same nesting-depth ceiling `(`
  nesting already uses; confirmed live by reverting the fix and watching
  the fuzz suite reproduce the exact crash (D-146).
- **The exclusion anti-monotonicity property** (D-140's Property 5)
  generalized beyond its one hand-verified shape to arbitrary,
  randomly-generated exclusion trees, via a new `findFlippableExclusion`
  extension of the monotonicity classifier's own AST walk — re-verified
  live by weakening the resolver's real exclusion evaluation and
  confirming both the original and the new property fail for exactly the
  predicted reason (D-147).
- **The `checks` audit trail is now hash-chained** — tamper-evidence for
  the one table this project's entire "every allow can show its work"
  pitch depends on being trustworthy. Every insert now runs inside its
  own advisory-locked transaction, chaining each row's hash to the true
  previous row. `authz audit verify` walks the chain and reports either
  every row intact or the exact first broken link. Live fail-check:
  tamper with one already-committed row via a raw SQL `UPDATE`, confirm
  that exact row is named, not just "something is wrong somewhere"
  (D-148).
- **`authz schema diff <file>` and `authz schema rollback <namespace>
<version>`** catch a publish that would silently revoke access before
  it ships, reusing the same structural reasoning the monotonicity
  classifier established — proven end to end against a real narrowing
  publish that genuinely does revoke a real grant, and a rollback that
  genuinely restores it, plus a negative test confirming a pure-widening
  publish never triggers a false warning (D-149).
- **A startup `PG_POOL_MAX`/`MAX_CONCURRENCY` guard** — `authz doctor`
  now warns when `MAX_CONCURRENCY >= PG_POOL_MAX`, a numeric relationship
  D-140 disclosed but left invisible and unconfigurable; soft, not a hard
  failure, since D-143 already closed the actual deadlock this
  relationship used to be able to cause (D-145).

Two real problems surfaced building this batch in parallel, disclosed
rather than smoothed over. Two of five parallel agents (each in its own
isolated git worktree) returned corrupted structured output for some
files — a literal placeholder string for three files, a natural-language
description in place of two others — despite each agent's own summary
describing genuinely thorough, correct work throughout. Caught by
independently re-running the type checker across the combined result
before trusting any of it, not by assuming five clean individual reports
meant a clean whole. Separately, two agents (D-148 and D-149) each
independently modified the same shared file, `src/cli/index.ts`, in their
own worktrees; applying both file sets in sequence let the second silently
drop the first's CLI wiring with no error anywhere — caught only by
checking the merged file's real content directly, then fixed by hand and
reconfirmed with real, un-mocked CLI invocations of both command groups.
Full account of the corrupted-output problem: [`PROGRESS.md`](../PROGRESS.md)'s
D-145–D-149 batch entry. Full account of the shared-file collision, and
every decision above: [`docs/DECISIONS.md`](DECISIONS.md) D-144
through D-149.

## Expiring tuples: D-144's own caveat, built

A tuple can now optionally carry a validity window — `authz tuple write ...
--expires-at 2026-09-01T00:00:00Z` (CLI) or `expiresAt` (API body) — the
closed form D-144 scoped in above, not a general attribute engine. Once
that instant passes, the tuple is treated as though it had been deleted:
both resolvers stop granting through it independently (D-022's isolation
preserved), `authz expand`'s own resolved tree agrees, and — the one place
this needed care beyond "just filter by a timestamp" — the opt-in
check-result cache never serves a stale `ALLOW` past a real expiry, since
an expiry produces no write for the cache's own invalidation to react to.
Proven, not assumed: a new deterministic simulation-testing fault shows an
expiry crossing mid-check is invisible to a `REPEATABLE READ` snapshot
already anchored before it — the identical composition already proven for
a concurrent write landing mid-check, applied here to a concurrent clock
advance — and a real-Postgres integration test shows a live grant flip to
denied from nothing but a raw `UPDATE` simulating time passing, with the
cache immediately reflecting it rather than masking it for its own TTL.

Built via four independent, fully disjoint-file pieces (storage, the
reference resolver, cache safety, CLI/API), each agent handed an exact,
pinned interface contract rather than left to design any shared piece —
directly applying the previous batch's own two lessons above: no two
agents ever touched the same file, and every agent's own summary was
independently re-verified against its real files before being trusted. A
second real, distinct cross-cutting gap surfaced anyway and was disclosed,
not hidden: DST's fake store matches every query by exact SQL text, so a
real query's own SQL changing (a new column, a new filter) silently
invalidates whatever the fake had registered for the old text — found by
one agent running the full suite beyond its own assigned task and naming
the exact failure, fixed by reconciling every affected shape once every
piece had merged. Full account, including every fail-check:
[`docs/DECISIONS.md`](DECISIONS.md) D-150.

## Five bigger bets, built in parallel: scoped API keys, a batch endpoint, a privilege-escalation scanner, an SMT tier, and a machine-checked API spec

The same feature-ideation pass that produced D-144 through D-150 above named a second, bigger tier of ideas. Five were built next, dispatched as five independent, isolated-worktree agents in one parallel batch: a third, optional DB-backed API-key credential tier that can be scoped to a namespace set and/or given an expiry (`authz apikey create/revoke/list`) — the two existing static env-var keys stay completely unchanged; `POST /check/batch`, up to 50 independent checks in one call, order-preserving; `authz audit privesc`, a privilege-escalation scanner built entirely on the existing `productionCheck` primitive, flagging drift against an `--expected` allow-list; a hand-maintained OpenAPI 3.0.3 document (`GET /openapi.json`, zero new dependency); and a real SMT-backed exact tier for the schema verifier's non-recursive fragment (`z3-solver`, a new dependency approved specifically for this task), closing part of the gap this project's own SMT encoding sketch left open since the verifier first shipped.

Every SAT result the SMT tier reports is reconstructed into a concrete witness and replayed through the real, unmodified production engine before ever being called `VIOLATED` — never trusted on the solver's word alone, the same discipline the exact monotone prover already holds itself to. A real, disclosed finding surfaced while grounding the work: the task's own named "live proof" fixture is itself graph-recursive (via this schema's own deliberate parent-hierarchy and nested-group-membership features), so per the tier's own explicit scope it correctly declines on it — a same-shape non-recursive fixture delivers the genuine capability proof instead.

**Two real numbering collisions, both a direct consequence of dispatching from a moving base, caught before shipping.** These five worktrees were branched at different points relative to D-150 (some before it existed at all, some before its own README writeup landed) — since none of the agents could see D-150's own migration or decision number while working, one new migration collided on its number (`0007`→`0008`) and the SMT agent's own `docs/DECISIONS.md` addition also independently chose `D-150`, already taken by the expiring-tuples entry — renumbered to `D-151`, with the sibling four-piece writeup taking `D-152` once every piece merged.

**A real file-set collision, anticipated this time, but not prevented by anticipating it — unlike D-150's own batch, where zero file overlap was verified before dispatch.** Two agents were both instructed to add a new route to `src/api/server.ts`. Caught immediately after dispatch, resolved the same way D-148/D-149's own shared-file collision was: real `git merge` conflict resolution per worktree, reading and reconciling each actual conflict by hand.

**Two more cross-cutting gaps, both closed once every piece had merged together — the OpenAPI document couldn't describe a route that didn't exist yet in its own author's worktree, and one integration test's own fixture used ids invalid under this project's identifier grammar, found only by live-verifying against a real database rather than trusting a green DB-free suite.**

**A real security-scanner finding, surfaced only after opening the pull request — none of the local verification above catches this class of issue.** GitHub's CodeQL flagged the new API-key hashing function as `js/insufficient-password-hash`, a real rule built for a different threat model than this one: it targets low-entropy, human-chosen secrets, where a fast hash makes brute-forcing a leaked hash cheap. `hashApiKey` never hashes anything human-chosen — its only input is either `generateRawApiKey`'s own 256-bit CSPRNG output or an equality-lookup candidate compared against rows that all came from that same source, making an offline brute-force search infeasible regardless of hash speed, the identical bet GitHub's and Stripe's own API-key systems make. Two inline suppression-comment attempts didn't clear the alert — this repository's CodeQL configuration doesn't appear to honor them — so the fix converged by substance instead: `hashApiKey` now derives its digest via `scrypt` rather than a bare fast hash, with deliberately modest cost parameters since this function runs on every gated request, not once per login. Full account of every collision and every fail-check, including this one: [`docs/DECISIONS.md`](DECISIONS.md) D-151, D-152.

## Three more from that same list: a Horn-clause tier for the schema verifier, expiring tuples wired into the fuzzer, and an out-of-band audit anchor

D-151's own SMT tier explicitly declined on any recursive schema goal, naming a Horn-clause/CHC fixpoint solver as "the real v2 answer." That answer shipped next: `tools/schema-verifier/src/smt/chc.ts` compiles a recursive schema's rewrite rules into Horn clauses and queries `z3-solver`'s real `Fixedpoint` (PDR/Spacer) engine directly. Two real findings surfaced exercising the API directly, not assumed from documentation — every namespace has to share one Z3 `Int` sort rather than a per-namespace uninterpreted one (Spacer's model-based projection needs theory structure an uninterpreted domain doesn't give it), and negation of a registered relation is confirmed non-functional in this build's `Fixedpoint` engine, reproduced across every engine and configuration tried. `exclusion`/`notRelationEquals` are out of this tier's scope by disclosed design because of that second finding, not oversight — the repo's own CI-checked exclusion-reaching invariant is unaffected, still decided by bounded search exactly as before. The real payoff: `schema/example.authz`'s own `folder#sensitive_review`, D-151's own named example of what recursion made it decline on, is now decided exactly (`VIOLATED`, `proof: exact`, a real witness confirmed through the unmodified production engine) — genuinely fail-checked, the same way every tier here is: a 30-level recursive chain exceeding the engine's own depth ceiling produced a wrong `VIOLATED` with the self-verification gate disabled, confirmed, then reverted and kept as a permanent regression test.

D-150 shipped expiring tuples end to end but deliberately never exercised them through the main fuzzer's own random tuple-graph generator, naming the reason: the reference resolver's `now` and Postgres's real `now()` are two independently-timed clock reads, and a fuzz-generated `expiresAt` landing in the gap between them could make the two resolvers disagree for a reason unrelated to a real bug. Closed without synchronizing the two clocks — `generators.ts` marks a fraction of randomly generated tuples `'expired'`/`'valid'` deterministically, with no clock read at all; `runner.ts` captures one `expiryAnchor` per run and writes/backdates real timestamps a measured `EXPIRY_MARGIN_MS` (2 hours, ~600x an actually-measured full-run duration) to either side of it. Fail-checked live by breaking `productionCheck`'s own expiry filter: 3/3 fresh seeds went `unsound` with real nonzero `false_grant` counts, each traced to exactly the class of bug this feature exists to prevent; reverted, 3/3 `sound` again. A real run left 13 of 88 tuples in the random graph carrying `expires_at` — genuinely present, not just wired in theory.

D-148's hash chain catches a single tampered row but disclosed a real limit: a privileged database user can rewrite the whole chain forward, consistently, and the internal walk alone can't tell — because every input that walk trusts, including the chain's own history, lives in the one database that attacker already controls. `src/audit/anchor.ts` and a new `authz audit anchor [--file <path>]` command record the chain's own tip to a local, append-only NDJSON file instead — a new Postgres table was ruled out outright, since the same privileged user could rewrite that too. `authz audit verify --anchor-file <path>` independently re-derives what the chain actually hashes to at each anchored position from what's currently stored and compares it against what was recorded, reporting a distinct `ANCHOR MISMATCH`. **The one honest limit this can't engineer past, stated in the code and repeated every time the CLI runs, not just here:** a local file on the same host provides no real protection on its own — it only closes the gap once an operator replicates it somewhere this same Postgres instance genuinely cannot reach. Fail-checked live, the actual point of the work: recorded a real anchor, performed a genuine full consistent-forward rewrite via raw SQL, and confirmed — as two separately observed facts — that a plain `authz audit verify` reports the rewritten chain fully intact (the real, disclosed gap, proven not assumed) while `--anchor-file` correctly catches it. A real, previously-undiscovered bug turned up along the way: `readChainTip`'s own query cast `chain_seq` to text before sorting by it, sorting lexicographically instead of numerically and silently returning the wrong row as "the tip" past nine chained rows — fixed by dropping the redundant cast.

These three were dispatched as three independent, isolated-worktree agents in one parallel batch; the only collision was the by-now-familiar one — two of the three agents' own `docs/DECISIONS.md` additions both independently chose `D-153`, requiring one renumbered to `D-154` once merged. Full account of all three, including every fail-check: [`docs/DECISIONS.md`](DECISIONS.md) D-153, D-154, D-155.

## A real soundness bug, found and fixed: `exclusion` meeting a data cycle could flip a fail-closed deny into an unsound grant

A live-verification pass over this project's own deferred work — reading real code rather than trusting old doc prose — turned up a candidate gap: both resolvers' cycle guard fails closed (`false`, "cannot prove") on a permission that loops back on itself through real tuple data, which is correct everywhere _except_ inside an `exclusion` rule's `subtract` branch. There, the old code treated any `false` as "disproven, not excluded" — so a cycle-guard hit flipped, via exclusion's own `NOT`, into an unsound grant. This project's own SMT/CHC work (D-153) had already concluded this exact hazard in theory, in a completely different part of the codebase; nobody had live-tested it against this specific implementation until now.

**Reproduced live first, on an ordinary shape, not an exotic one:** `folder { permission view = grant - parent->view }`, with a self-referencing `folder:a#parent@folder:a` (self-referencing hierarchy tuples are this DSL's own headline pattern) and a real grant. Both resolvers returned `ALLOWED` before any fix — a genuine false grant, the exact failure class this whole project exists to prevent. The fix threads a `certain` flag alongside every recursive outcome in both resolvers, independently: a cycle- or depth-cut `false` is now distinguished from an exhaustively-proven one, and only the exhaustive kind is safe to negate — an uncertain `subtract` now denies the exclusion instead of granting it, fail-closed like every other guard in this codebase.

**A structural finding about the project's own proof machinery, not just a bug fix.** Because the bug was identical in both independently-coded resolvers, they agreed with each other on the wrong answer — a 5,000-query differential-soundness fuzz run with only this fix reverted still reported `SOUND, false_grant: 0`. Differential fuzzing structurally cannot catch a bug both resolvers share, at any budget — this is the first time that's been shown live for a real, specific bug, rather than just argued in the abstract (the exact failure mode the "fourth proof," metamorphic testing, was built to reach). Fail-checked independently twice — once by the agent that built the fix (reverting only the resolver files reproduces the bug; two controls, including a genuine non-cyclic exclusion, confirm no over-conservative regression), and a second time live against real Postgres through the unmodified CLI on the identical fixture, reproducing the false grant firsthand before confirming the fix closes it.

Built alongside two smaller closes from the same review: a runtime assertion that `productionCheck`'s snapshot-anchoring query is genuinely first on its pinned connection (closing a gap D-139 had disclosed but left as code-structure-only — and, on closer inspection, revealing the in-memory DST fake didn't have the described check either); and `openapi-document.ts` now checked against Fastify's own live route table instead of a second hand-maintained list, catching a stale comment already sitting in that file as a live instance of the exact drift it exists to guard against. Full account of all three, including every fail-check: [`docs/DECISIONS.md`](DECISIONS.md) D-156, D-157, D-158.

**The fix above had its own disclosed blind spot — checked, and it was real too.** Production actually has two resolution mechanisms: the TS-level walk the first bug lived in, and a separate SQL-backed fast path (`sqlRelationMembershipWithWitness`) for plain relation membership. The first fix's own writeup named this second mechanism's depth ceiling as sharing the identical algebraic shape but left it unverified. It turned out to be real: a fixture with a genuine 3-hop nested-group chain, checked at a pinned depth one hop short of the real match, produced the identical false grant — the SQL frontier scan hit its own ceiling and reported "no path found" as a certain, exhaustive proof rather than a truncation. Fixed the same way, and independently reproduced live a second time through the unmodified CLI (bypass the fix → the false grant returns; restore it → denied again). Alongside the fix, a new **permanent metamorphic property** (not a fixed fixture) now runs both mechanisms across dozens of randomly-generated schema/tuple-graph instances every time it's exercised, asserting an exclusion's subtract branch hitting an unprovable cut can never grant — closing the gap the first fix's own writeup explicitly left as future work rather than assumed solved. Full account: [`docs/DECISIONS.md`](DECISIONS.md) D-159, D-160.

**One more gap closed: the main fuzzer itself couldn't catch its own bug class.** Both fixes above measured the same uncomfortable fact — the standard-configuration differential fuzz run (the one CI actually executes on every PR) never caught either bug, even with them reintroduced, because the random generator's existing guaranteed structures never happened to construct this exact shape. The dedicated metamorphic property closed that as a standing guard, but CI's own fuzz job still couldn't. Now it can: a new guaranteed structure (the same reliability class as the existing guaranteed cycle and deep chain) wires a real, boundary-calibrated relation-membership chain into every generated fixture. Measured, not assumed: 0 of 10 fresh seeds caught the bug at standard configuration before this change; 10 of 10 catch it now, every single one tracing to exactly this construct. Full account: [`docs/DECISIONS.md`](DECISIONS.md) D-161.

## An offline acceleration index for nested groups, opt-in and provably inert until built

Zanzibar's own paper spends real design effort on one performance problem this project shares: a deeply or widely nested group graph pays the full cost of a live SQL walk on every single check, even though group membership changes far less often than it's read. Modeled on Zanzibar's own "Leopard index," `authz leopard refresh` offline-computes and materializes "every subject transitively reachable from this group" into two new tables, consulted as a fast path ahead of the existing recursive walk (`sqlRelationMembershipWithWitness`) — which itself isn't touched, not even by one line.

**Deliberately scoped down from Zanzibar's own full design, and disclosed as such, not silently narrowed.** This is a "Phase A" cut: **pinned checks only**, **ALLOW-only acceleration**. An index miss, for any reason at all, falls through unmodified to the live resolver; the index never produces an authoritative DENY (that needs a "root completeness" tracking mechanism this phase deliberately doesn't build — see the design proposal's own "Revisit if"). The design itself went through this project's own "design → adversarial review → correct" discipline before a line of it shipped: [`docs/LEOPARD-INDEX-PROPOSAL.md`](LEOPARD-INDEX-PROPOSAL.md) records four independently-explored architectures reconciled into one proposal, then a four-lens adversarial review that found and disclosed real defects in the proposal's own code samples — a hardcoded safety flag that would have reopened D-144's expiring-tuple gap, a test plan that would have silently exercised zero index code ever, a primary-key collision the rebuild had no answer for — every one corrected in the document itself before implementation began.

**Implementation surfaced two more real, previously-undisclosed bugs, both found and fixed live before shipping, neither a soundness risk.** Postgres freezes `now()` to a transaction's own _start_ instant, confirmed directly via a `pg_sleep(2)` bracketed by two `now()` reads in one transaction (both identical to the microsecond) — so `rebuild_finished_at = now()` inside a multi-statement rebuild transaction would have recorded when the rebuild _began_, not when it actually finished; switched to `clock_timestamp()`. And a genuinely serious one: `resolve()`'s own exception boundary around the index lookup correctly swallows a real Postgres error (a lock timeout racing a concurrent `authz leopard refresh`'s own `TRUNCATE` — an ordinary hardening config, not an exotic one) but Postgres poisons the _whole_ transaction on any statement error, so the very next statement — the live-CTE fallback the boundary exists to protect — threw a second, uncaught error, exactly defeating the "a miss, for any reason, falls through unconditionally" guarantee. Reproduced live, 15/15 clean runs at the default `lock_timeout=0` and 15/15 real throws at `lock_timeout=50ms` — fixed with a `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` pair, Postgres's own standard mechanism for recovering a poisoned transaction without a second connection, itself a genuinely new pattern in this codebase, disclosed as such. Live-verified fixed: the same forced-contention scenario, zero throws afterward.

**A new third comparison arm in the differential-fuzz harness, not just unit tests.** `SoundnessRunOptions.relationIndex: 'off' | 'cold' | 'warm'` compares the production engine against _itself_, index on versus off, at the identical pinned snapshot — `'cold'` proves a deployment that enables the flag but never rebuilds is provably inert (`indexQueriesHit === 0`, executed at the standard 5,000-query PR-speed budget, not just asserted in prose); `'warm'` proves every real index hit replays on the live CTE, with an `indexQueriesHit > 0` non-vacuity gate closing the exact "this whole mode silently tests nothing" trap an unpinned `atToken` would otherwise have created. Full account, every disclosed correction, and the complete fail-check record: [`docs/DECISIONS.md`](DECISIONS.md) D-163.

## An external review, answered: DST evolution, a machine-checked TLA+ proof, and a neutral benchmark against OpenFGA and SpiceDB

An external technical review of the Leopard index posed the four questions that actually separate a real Leopard index from a materialized cache wearing its name — does the watermark genuinely gate staleness and fall through on a miss; is the shipped structure the real Zanzibar skip-list-of-postings design or a denormalized closure table; what happens on a group-edge deletion; is there a real differential test proving it. All four checked out against the actual shipped code, not memory or the proposal's own prose — and the two nuances worth surfacing more prominently (the flat-table-vs-real-Leopard-structure distinction; the refresh-interval config that was parsed but never wired up) were pulled into [`docs/LEOPARD-INDEX-PROPOSAL.md`](LEOPARD-INDEX-PROPOSAL.md)'s own Status header instead of staying buried mid-document. That second gap is now closed too — see below.

**DST absorbed the Leopard index's own async pipeline, which it hadn't at all.** `grep`-confirmed directly, not assumed: none of the real rebuild/lookup code's own literal SQL (`BEGIN ISOLATION LEVEL REPEATABLE READ`, `pg_try_advisory_xact_lock`, `SAVEPOINT LEOPARD_LOOKUP`) matched anything `src/store/dst/connection.ts` recognized before this work. [`docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md`](DST-LEOPARD-EVOLUTION-PROPOSAL.md) adds a writable snapshot transaction mode, a non-blocking advisory-lock primitive, state for the two Leopard tables, and a genuinely new "poisoned connection" fault class modeling the exact D-163 `SAVEPOINT`-recovery bug shape — the one piece of this extension with real teeth, since only it can prove that recovery path actually works rather than merely never being exercised. Building it surfaced two real things, both disclosed rather than absorbed silently: the real new-shape count is 7, not the design's own stated 6 (one bullet bundled two distinct SQL literals); and implementing the poison fault exactly as specified surfaced a genuine bug before its own mandated fail-check even ran — the arm condition silently re-fired on the very next statement after a legitimate recovery, fixed with a dedicated one-shot latch mirroring an existing pattern. Fail-checked four times with real breaks and restores; the riskiest one (the `SAVEPOINT`-recovery invariant) was independently reproduced a second time. Fast suite grew from 73 files/1,119 tests to 75/1,147.

**A TLA+ spec of the watermark-publication protocol, checked clean — and, since first written, actually confirmed on the real, official TLC, not only an unofficial stand-in.** [`docs/leopard-index.tla`](leopard-index.tla) formalizes "watermark staleness must never produce a false ALLOW" as `IndexHitImpliesLiveTruth`. When first written, the real TLC model checker (`tla2tools.jar`, GitHub-Releases-only) couldn't be fetched in that sandbox, so a real but unofficial, single-maintainer WASM reimplementation (`tla-checker`) was used instead, clearly labeled as a supplementary check throughout — exhaustive and clean at 103,052 reachable states on the real design, a genuine counterexample at 57,120 states on a deliberately weakened variant that splits the real design's one atomic publish into two. On a later retry, GitHub Releases turned out to be reachable after all — the real, official TLC (v2.19) was run against the exact, unmodified spec and **confirmed the identical result**: 103,052 distinct states, zero violations, on the real `Spec`; a genuine violation at a comparable state count (58,158) on the weakened variant, ending in the identical `rebuildPhase = "WatermarkPublishedRowsPending"` shape. Two independent implementations — one official, one not — enumerating the identical state count for the identical spec is about as strong a confirmation as this kind of check gets. Full transcripts, both runs: [`docs/TLA-SPEC-NOTES.md`](TLA-SPEC-NOTES.md).

**A neutral benchmark harness against real, live OpenFGA and SpiceDB instances, not simulated numbers.** [`tools/rebac-benchmark/`](../tools/rebac-benchmark/) talks to all three engines over their own real network APIs — HTTP for authz/OpenFGA, gRPC for SpiceDB — with a real translation of `schema/example.authz` into each engine's own schema language. Docker isn't available in this project's own working sandbox, but the Go module proxy is: `go install`, pinned to the exact versions this harness's own numbers use (`openfga@v1.19.0`, `spicedb@v1.56.1`), gets real native binaries with no Docker involved. 8/8 cross-validation checks pass identically on all three engines against the real seeded demo graph, at both the original small proving run and a larger rerun (below). The depth-latency benchmark and a real write-then-poll consistency probe surfaced a genuine, citable finding, not a synthetic one: SpiceDB's default `minimizeLatency` consistency mode shows real staleness up to its own documented ~5-second revision-quantization window, while OpenFGA and this project's own engine resolve on the first poll by default — confirmed again, more sharply, on the larger rerun's 10-trial probe (alternating ~1ms and ~5000ms reads, not a one-off). The rerun also bumped `--runs-per-depth` from 3 to 50 for OpenFGA and SpiceDB, matching this repo's own `scripts/benchmark-check-depth.ts` precedent — for authz specifically it stayed smaller (10, not 50), a **disclosed asymmetry driven by a real constraint of the system under test**, not a benchmark shortcut: `POST /tuples` is rate-limited to 20/minute by this project's own default with no override, so writing the tuples a 50-run sweep needs would cost the better part of an hour of real rate-limit backoff; OpenFGA and SpiceDB have no equivalent limit. Every real limitation — small samples relative to a citable benchmark, shared-sandbox noise, no independent schema review — is named plainly in the design doc's own "What would make this citable outside this project" table, not glossed over. Full methodology and every real result, both runs: [`docs/BENCHMARK-PROPOSAL.md`](BENCHMARK-PROPOSAL.md).

**Two of the proposal's own disclosed gaps closed directly, not just re-confirmed.** `LEOPARD_INDEX_REFRESH_INTERVAL_MS` was parsed and validated by `env.ts` since the index first shipped but consulted nowhere else — `authz serve` never actually started a background timer regardless of its value. It now does: a nonzero interval runs the identical `pg_try_advisory_xact_lock`-guarded rebuild on a schedule, layered safely alongside (never instead of) any external cron an operator also runs, deliberately not gated on `LEOPARD_INDEX_ENABLED` so a deployment can pre-warm the index before flipping the flag. And the benchmark harness's own 11 unit tests, which existed and passed locally since its first commit, are now part of CI (`rebac-benchmark` job) instead of a local-only suite nobody but this session ever ran.

**A third: DST's own tombstone-visibility question, named in passing by the evolution proposal and left explicitly unconfirmed, turned out to be a real bug — investigated, confirmed, and fixed, not just re-flagged.** `tupleDeleteHandler` (`src/store/dst/shapes.ts`) used to splice a deleted row physically out of the shared `relationTuples` array the instant the deleting transaction committed — which cannot represent real Postgres's own `REPEATABLE READ` guarantee that an earlier-anchored snapshot never observes the effect of a transaction that commits after it, including a later `DELETE` of a row that snapshot already considers live. Confirmed live before being fixed: a snapshot anchored before a concurrent delete's commit incorrectly lost visibility into a row it should still see, the exact wrong-visibility symptom named in the design doc. Fixed the same way `tupleInsertHandler` already models the opposite end of a row's visible lifetime — tagging it with the deleting commit's own sequence number (its real-Postgres "xmax," mirroring `commitSeq`'s existing "xmin" role) instead of removing it, with every one of the 7 read call sites across `shapes.ts` and `frontier.ts` updated to the new tombstone-aware visibility rule. One existing test's own assertion (`state.relationTuples` array length) turned out to directly encode the old, wrong splice behavior — replaced with a check through the real read path instead of the fake's internal array shape. Fail-checked with a real break-then-restore cycle, independently reproduced a second time; fast suite grew to 76 files/1,154 tests.

Full account, every independent re-verification, and every fail-check: [`docs/DECISIONS.md`](DECISIONS.md) D-165/D-167.

---

That's the account through D-167. Everything that has shipped since —
scoped API keys widened to read-only credentials, expiring-tuple and
wildcard-subject follow-ups, the reverse-lookup accelerant for
`listObjects`, the third-party schema survey's own tally corrections, the
`never <namespace>#<relation>(<var>)` invariant primitive, and more — is
recorded the same way, entry by entry, in
**[`docs/DECISIONS.md`](DECISIONS.md)** (the complete, numbered decision
log this document's own citations point into throughout) and summarized
chronologically in **[`PROGRESS.md`](../PROGRESS.md)**. This document
covers the arc from the project's first proof to the point its own
narrated form outgrew the README's front page — it is deliberately not
extended further; newer work goes straight into `DECISIONS.md`/
`PROGRESS.md` instead.
