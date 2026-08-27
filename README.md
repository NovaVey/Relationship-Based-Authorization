# Relationship-Based Authorization

A fine-grained authorization service, Zanzibar-style: relationship tuples
and a graph-walking check engine, with a differential-fuzzing proof that
the check engine never grants a permission no real path supports.

[![CI](https://github.com/NovaVey/Relationship-Based-Authorization/actions/workflows/ci.yml/badge.svg)](https://github.com/NovaVey/Relationship-Based-Authorization/actions/workflows/ci.yml)
[![Soundness](https://github.com/NovaVey/Relationship-Based-Authorization/actions/workflows/soundness.yml/badge.svg)](https://github.com/NovaVey/Relationship-Based-Authorization/actions/workflows/soundness.yml)
[![Schema Verifier](https://github.com/NovaVey/Relationship-Based-Authorization/actions/workflows/schema-verifier.yml/badge.svg)](https://github.com/NovaVey/Relationship-Based-Authorization/actions/workflows/schema-verifier.yml)
[![DST](https://github.com/NovaVey/Relationship-Based-Authorization/actions/workflows/dst.yml/badge.svg)](https://github.com/NovaVey/Relationship-Based-Authorization/actions/workflows/dst.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**Live:** [`authz-api-production.up.railway.app`](https://authz-api-production.up.railway.app/health) —
seeded with the exact demo graph below (`document`/`folder`/`group`/`org`,
all four published); `GET /health` (unauthenticated) confirms this directly —
real database connectivity, and all four namespaces at their real versions.
`POST /check`/`/expand`/`/schema/publish` and `/tuples` writes are
`ADMIN_API_KEY`-gated (D-064) — this is a live instance of the real service,
not a public sandbox, so read access is deliberately not open to anyone who
finds the URL. `POST /schema/compile` (no write, no gate) is open if you want
to try the DSL compiler itself against your own source.

## Contents

- [The failure this exists to stop](#the-failure-this-exists-to-stop)
- [What an `allow` actually looks like here](#what-an-allow-actually-looks-like-here)
- [The soundness result](#the-soundness-result)
- [Also proven: the write path survives a crash mid-transaction, and every advisory lock actually blocks](#also-proven-the-write-path-survives-a-crash-mid-transaction-and-every-advisory-lock-actually-blocks)
- [A third proof: the static schema verifier](#a-third-proof-the-static-schema-verifier)
- [A fourth proof: metamorphic and mutation testing — plus a real deadlock found, reproduced, and fixed](#a-fourth-proof-metamorphic-and-mutation-testing--plus-a-real-deadlock-found-reproduced-and-fixed)
- [A scope decision, two proof extensions, a tamper-evident audit log, and a schema safety net](#a-scope-decision-two-proof-extensions-a-tamper-evident-audit-log-and-a-schema-safety-net)
- [Expiring tuples: D-144's own caveat, built](#expiring-tuples-d-144s-own-caveat-built)
- [Four bigger bets, built in parallel: scoped API keys, a batch endpoint, a privilege-escalation scanner, an SMT tier, and a machine-checked API spec](#four-bigger-bets-built-in-parallel-scoped-api-keys-a-batch-endpoint-a-privilege-escalation-scanner-an-smt-tier-and-a-machine-checked-api-spec)
- [Try it yourself — under 10 minutes, from a clean clone](#try-it-yourself--under-10-minutes-from-a-clean-clone)
- [How it works](#how-it-works)
- [Latency](#latency)
- [What this is not](#what-this-is-not)
- [Stack](#stack)
- [API and CLI](#api-and-cli)
- [Repository layout](#repository-layout)
- [Building this out further / contributing](#building-this-out-further--contributing)

## The failure this exists to stop

Every application that grows past "everyone with an account can see
everything" reinvents authorization, badly, in the same order: a `role`
column, then a `role` column plus a handful of special-cased `if`
statements for the exceptions, then a table of exceptions nobody fully
trusts, then an incident where someone could see something they shouldn't
have been able to — because the actual rule ("you can see this because
you're in the group that owns the folder it's in") was never expressed
anywhere as data. It was scattered across application code as a series of
individually-plausible checks nobody had ever verified agreed with each
other, until one of them didn't.

Relationship-based authorization (ReBAC) makes the relationships
themselves the source of truth. A permission question is never answered
by a route's own bespoke logic — it's answered by walking real,
current relationship data (`document:readme#viewer@user:alice`,
`folder:design#editor@group:eng#member`) the same way, every time, in one
place. That only replaces the risk above with a new one if the walk itself
can be wrong — so this project's actual subject is proving that it isn't,
not just building it.

## What an `allow` actually looks like here

This system never says a permission is granted because it seems like it
should be. Every `allow` names the exact chain of real tuples that
produced it — not a description of one, the actual evidence, re-derivable
by anyone who reads it. Here's a real one, from this repository's own
seeded example graph (`schema/example.authz`, `scripts/seed-example.ts`):
`user:dana` can `edit` `document:eng_handbook` — but she was never granted
that directly, and she isn't even a direct member of the group that was:

```
user:dana
  → group:eng_backend_interns#member
  → group:eng_backend#member
  → group:eng#member
  → folder:eng_docs#editor
  → document:eng_handbook#edit
```

Two levels of nested group membership, then a folder-level grant, then
inheritance down to the document — five real hops, none of them a
shortcut. `authz check user:dana edit document:eng_handbook --path` prints
this exact path (`docs/RELATIONS.md` walks through why each hop is there;
plain `check`, without `--path`, prints only `ALLOWED`/`DENIED` — the path
is always computed and logged to the audit trail either way, `--path` just
also prints it); `authz expand document:eng_handbook edit` shows the same
structure as a full tree, every branch that was and wasn't involved. Deny
decisions are symmetric: `authz check user:mallory view org:acme` returns `DENIED`
because she's excluded by name (`org.view = member - banned` — see
`docs/RELATIONS.md`), not because nothing else was checked.

## The soundness result

Fuzzed against an independent reference resolver across 5,000 random
`(schema, tuple graph, query)` triples:

```
## SOUND — 0 false_grant, 0 false_deny, across 5000 queries (seed <run's own seed>)
```

That's the real headline `authz soundness run` produces (`--format
markdown`, the exact shape posted as a PR comment on every pull request to
this repository — see the Soundness badge above), not a projected or
aspirational number. A system stating its own false-grant rate under
adversarial random testing, and reporting it even when it isn't zero, is a
claim almost nothing in this space states this plainly — and it's the
entire reason this project exists: proving the check engine never says yes
when no path exists is worth more than any feature the engine itself has.
`docs/RELATIONS.md`'s "every `allow` can show its work" section and
`.claude/commands/build-authz-service.md` §6.2/§6.5 cover the mechanism —
a deliberately naive, deliberately slow, independently-written oracle (no
shared code with the production engine) checked against the real engine on
every random query, with a **false grant always failing the run
outright**, regardless of how rare it was, and a false deny reported but
never blocking on its own — the asymmetry is deliberate, because the two
failure modes are not equally dangerous.

## Also proven: the write path survives a crash mid-transaction, and every advisory lock actually blocks

Differential fuzzing (above) proves the **check engine** never grants a
permission no real path supports. A second, complementary effort —
deterministic simulation testing (DST) — proves the **write path** itself
stays correct under faults an ordinary integration test can't reach on
demand: a connection dying mid-transaction, two writers genuinely racing
for the same advisory lock. It runs against an in-memory fake at the
storage seam, never inside real Postgres — Postgres isn't crash-injectable
or byte-for-byte replayable from outside its own process the way this
project's own code is, and claiming otherwise would be the kind of
overclaim this project's soundness language already refuses to make (see
**[`docs/DST-PROPOSAL.md`](docs/DST-PROPOSAL.md)**'s full design and
`docs/DECISIONS.md` D-095 for why). Six phases have landed so far:

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

Both proofs above are existential: differential fuzzing samples random
`(schema, tuple graph, query)` triples and confirms the check engine
agrees with an independent oracle on each one; DST confirms the write
path survives specific injected faults. Neither says anything about a
tuple set neither has happened to try yet. `tools/schema-verifier/` asks a
universal question instead — for a _given schema_, is there any possible
tuple set at all that could ever produce an unsafe grant — and answers it
once, structurally, rather than by sampling.

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
[`tools/schema-verifier/README.md`](tools/schema-verifier/README.md).

It's wired into this repo's own CI as a required status check
(`.github/workflows/schema-verifier.yml`) — every PR proves
`org#view = member - banned` still holds against `schema/example.authz`,
this repo's own real, live schema, not a demo fixture. And it's been run
against twelve real, published schemas this project didn't write (six
OpenFGA `sample-stores`, six SpiceDB `authzed/examples`): **originally**
nine came back `VIOLATED` and three `HOLDS`, with eight of those nine
sharing one root cause — the invariant language had no way to state a
_negative_ precondition, so any goal reachable via a directly-grantable
relation was trivially escapable. Closing that gap for two of the nine (a
new `notRelationEquals` primitive, D-131) moved the real, current count to
**7 `VIOLATED`, 5 `HOLDS`** — six of the seven remaining violations still
share the original root cause; the seventh (`openfga-expenses`) is a
distinct self-referential-manager-loop case. The survey's own biggest
result was never any one schema — it's this finding about the invariant
language itself, and the fact that closing part of it is now a real,
tracked, in-progress story rather than a static snapshot. Full table and
reasoning: [`docs/FINDINGS.md`](docs/FINDINGS.md).

`docs/DECISIONS.md` D-114 through D-131 has the complete build history —
the small-model property and exactly where it stops applying, the SMT
encoding sketch for the general case, why the verifier imports this
repo's own parser and engine rather than reimplementing either, the
ten-item definition-of-done checklist confirmed against the real, shipped
result rather than assumed (D-114–D-126), and three further real fixes
that landed after that checklist first closed: a confirmed false `HOLDS`
in the monotone-fragment exact prover (D-129), exact decisions for some
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
real, current status in [`PROGRESS.md`](PROGRESS.md).

## A fourth proof: metamorphic and mutation testing — plus a real deadlock found, reproduced, and fixed

The three proofs above all check things this project already knew to check
for. A **live-verification doc audit** asked a different question instead —
does anything already written down still match reality — by having 7
parallel review agents actually execute every documented command and count
every claimed number against live ground truth, rather than re-reading
prose and comparing it to code by inspection. It found real, confirmed
drift: `docs/DST-PROPOSAL.md` still opened "A proposal, not yet built"
while the entire design it describes had shipped weeks earlier as D-097
through D-102; two other docs both claimed the third-party schema survey's
OpenFGA/SpiceDB split was "six and six," when the real split, confirmed by
reading every source file's own header, is five and seven. Both fixed,
along with six more confirmed findings — see `docs/DECISIONS.md` D-139.

That audit was the first of four requested in sequence. The next three are
genuinely new ways of checking the engine itself, not the docs describing
it:

- **Metamorphic/invariant testing** (`test/metamorphic/`, D-140) checks
  algebraic properties — idempotence, write-order commutativity,
  monotonicity — directly against the real, unmodified production engine,
  needing no second implementation to compare against. This closes a blind
  spot differential fuzzing (above) structurally cannot reach: a bug the
  production engine and the independent reference resolver both share, from
  a common misreading of the same spec sentence, would still agree with
  itself and pass every differential run forever. All 7 originally-proposed
  properties turned out flawed on adversarial review before a line of
  implementation code was written — one property's own "backward" half was
  proven **false** by a constructed counterexample, not just softened. What
  shipped: 4 new files, 69 new tests, zero existing files modified,
  including `src/metamorphic/monotonicity.ts`'s classifier — sound but
  deliberately incomplete: a genuinely-monotone cyclic permission gets
  conservatively misclassified `false`, since the alternative risks the
  opposite, actually-dangerous direction — a real soundness bug in the
  classifier itself.

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
  deterministic single-process fault injection (above). 30 real concurrent
  `DELETE /tuples` calls against the 20/minute rate limit: exactly 20
  succeed, exactly 10 return `429`, nothing hangs or double-counts. A
  second test races a real revocation against a burst of concurrent
  `/check` calls to confirm the D-135 cache epoch fence holds under
  genuine, non-deterministic timing, not just DST's controlled pauses.

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
[`docs/DECISIONS.md`](docs/DECISIONS.md) D-139 through D-143.

## A scope decision, two proof extensions, a tamper-evident audit log, and a schema safety net

The four proofs above cover the check engine, the write path, a schema's
abstract safety, and — via metamorphic/mutation testing — blind spots none
of the others can reach. A feature-ideation pass raised about 28 further
ideas; most turned out to be "just build it," but one needed a real,
explicit decision before any code could touch it.

**D-144 — caveats, reopened narrowly, not drifted into.** D-114 named
caveats (SpiceDB-style attribute conditions on a relation) explicitly out
of scope for v1, and explicitly invited a future, dated decision to
reopen it if a real need ever surfaced — never a silent drift. One did:
time-boxed contractor/reviewer access, which today can only be expressed
by an external cron job deleting tuples out-of-band — exactly the
"authorization logic scattered outside the system of record" failure this
README opens by naming. **What's now in scope:** a closed-form time-window
check on a tuple (an `expires_at` comparison against the current clock,
provable the same way `atToken`'s floor comparison already is). **What
stays out, unchanged:** a general attribute/context-evaluation engine
(CEL/Rego/Cedar-style) — the "What this is not" section below still holds
that line. This entry was a decision only, with no code — the narrow form
itself, expiring/time-boxed tuples, shipped separately afterward (see
below).

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
Full account of both problems, and every decision above:
[`docs/DECISIONS.md`](docs/DECISIONS.md) D-144 through D-149.

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
[`docs/DECISIONS.md`](docs/DECISIONS.md) D-150.

## Four bigger bets, built in parallel: scoped API keys, a batch endpoint, a privilege-escalation scanner, an SMT tier, and a machine-checked API spec

The same feature-ideation pass that produced D-144 through D-150 above named a second, bigger tier of ideas. Five were built next, dispatched as five independent, isolated-worktree agents in one parallel batch: a third, optional DB-backed API-key credential tier that can be scoped to a namespace set and/or given an expiry (`authz apikey create/revoke/list`) — the two existing static env-var keys stay completely unchanged; `POST /check/batch`, up to 50 independent checks in one call, order-preserving; `authz audit privesc`, a privilege-escalation scanner built entirely on the existing `productionCheck` primitive, flagging drift against an `--expected` allow-list; a hand-maintained OpenAPI 3.0.3 document (`GET /openapi.json`, zero new dependency); and a real SMT-backed exact tier for the schema verifier's non-recursive fragment (`z3-solver`, a new dependency approved specifically for this task), closing part of the gap this project's own SMT encoding sketch left open since the verifier first shipped.

Every SAT result the SMT tier reports is reconstructed into a concrete witness and replayed through the real, unmodified production engine before ever being called `VIOLATED` — never trusted on the solver's word alone, the same discipline the exact monotone prover already holds itself to. A real, disclosed finding surfaced while grounding the work: the task's own named "live proof" fixture is itself graph-recursive (via this schema's own deliberate parent-hierarchy and nested-group-membership features), so per the tier's own explicit scope it correctly declines on it — a same-shape non-recursive fixture delivers the genuine capability proof instead.

**Two real numbering collisions, both a direct consequence of dispatching from a moving base, caught before shipping.** These five worktrees were branched at different points relative to D-150 (some before it existed at all, some before its own README writeup landed) — since none of the agents could see D-150's own migration or decision number while working, one new migration collided on its number (`0007`→`0008`) and two of the five agents' own `docs/DECISIONS.md` additions both independently chose `D-150` for themselves, requiring renumbering to `D-151`/`D-152` once every piece merged.

**A real file-set collision, anticipated this time, but not prevented by anticipating it — unlike D-150's own batch, where zero file overlap was verified before dispatch.** Two agents were both instructed to add a new route to `src/api/server.ts`. Caught immediately after dispatch, resolved the same way D-148/D-149's own shared-file collision was: real `git merge` conflict resolution per worktree, reading and reconciling each actual conflict by hand.

**Two more cross-cutting gaps, both closed once every piece had merged together — the OpenAPI document couldn't describe a route that didn't exist yet in its own author's worktree, and one integration test's own fixture used ids invalid under this project's identifier grammar, found only by live-verifying against a real database rather than trusting a green DB-free suite.**

**A real security-scanner finding, surfaced only after opening the pull request — none of the local verification above catches this class of issue.** GitHub's CodeQL flagged the new API-key hashing function as `js/insufficient-password-hash`, a real rule built for a different threat model than this one: it targets low-entropy, human-chosen secrets, where a fast hash makes brute-forcing a leaked hash cheap. `hashApiKey` never hashes anything human-chosen — its only input is either `generateRawApiKey`'s own 256-bit CSPRNG output or an equality-lookup candidate compared against rows that all came from that same source, making an offline brute-force search infeasible regardless of hash speed, the identical bet GitHub's and Stripe's own API-key systems make. Two inline suppression-comment attempts didn't clear the alert — this repository's CodeQL configuration doesn't appear to honor them — so the fix converged by substance instead: `hashApiKey` now derives its digest via `scrypt` rather than a bare fast hash, with deliberately modest cost parameters since this function runs on every gated request, not once per login. Full account of every collision and every fail-check, including this one: [`docs/DECISIONS.md`](docs/DECISIONS.md) D-151, D-152.

## Try it yourself — under 10 minutes, from a clean clone

```bash
git clone https://github.com/NovaVey/Relationship-Based-Authorization
cd Relationship-Based-Authorization
npm install
cp .env.example .env        # set DATABASE_URL to any reachable Postgres 16+
npx tsx src/cli/index.ts doctor          # confirms Postgres is reachable, applies migrations
npm run seed:example                     # publishes schema/example.authz + the real demo graph above
npx tsx src/cli/index.ts check user:dana edit document:eng_handbook --path   # --path prints the diagram above, exactly
npx tsx src/cli/index.ts expand document:eng_handbook edit
npx tsx src/cli/index.ts soundness run --dry-run   # the SOUND result above, reproduced live against your own database
```

`npm run seed:example` prints a handful of other real checks worth trying
(a denied case, the intersection case) once it finishes. `authz soundness
run` generates and checks its **own** random schema/tuple graph each time
(that's the whole point — it's testing the engine, not this repository's
example data) — `--dry-run` runs that exact same real fuzz cycle for real,
against your real database, and computes the exact same verdict, but
deletes every row it created before returning, so your demo graph's
database is left exactly as `seed:example` left it. Drop `--dry-run` if
you'd rather see the generated fixture persist in `namespace_configs`
afterward — it's harmless either way, just no longer the default.

5,000 real queries against a database that isn't `localhost` (a hosted
Postgres, say) can take a while, and this command otherwise prints nothing
until it's completely done — silence that's easy to mistake for a hang.
Add `--progress <n>` to get a `checked X/Y queries` line on stderr every
`n` queries: `authz soundness run --dry-run --progress 500`.

### Troubleshooting: `authz doctor` says `Postgres: unreachable`

`cp .env.example .env` alone leaves `DATABASE_URL` pointing at the
placeholder in that file — a template connection string, not a real
database. `doctor` reporting `Postgres: unreachable` means exactly that:
nothing is listening wherever `DATABASE_URL` currently points. Three ways
to fix it, in order of least setup required:

1. **`docker compose up -d`** — this repo ships a `docker-compose.yml`
   with credentials matched to `.env.example`'s own placeholder, so if you
   haven't edited `DATABASE_URL` yet, this needs no further changes at
   all. Requires Docker; nothing else.
2. **A free hosted Postgres** — [Railway](https://railway.com),
   [Neon](https://neon.tech), or [Supabase](https://supabase.com) all have
   free tiers. Create a project, copy the connection string it gives you
   into `DATABASE_URL`.
3. **A native Postgres 16+ install** — via your OS's package manager or
   [postgresql.org](https://www.postgresql.org/download/), then point
   `DATABASE_URL` at the user/password/database you configured.

Re-run `authz doctor` after any of these — it should report `Postgres:
reachable` before you move on to `seed:example`.

## How it works

Two kinds of facts live in a namespace: a **relation** is something you
can write a tuple against (a stored fact — `alice is an editor of
readme`); a **permission** is a rule computed from relations, on demand,
every time — union, intersection, exclusion, and tuple-to-userset
(following a relation to another object, then recursing) are the four
ways a permission can combine them. Nested group membership needs no
special case at all — it falls out of letting a relation's subject be
another relation's entire member set. **[`docs/RELATIONS.md`](docs/RELATIONS.md)**
covers all four with real examples from this repository's own schema, plus
why a depth ceiling and cycle detection are correctness requirements here,
not performance tuning.

Every write returns a consistency token; a check can pin to it and is
then guaranteed to observe that write and everything before it — a plain,
stated read-your-writes guarantee on a single Postgres instance, not
Spanner-style external consistency across a distributed deployment.
**[`docs/CONSISTENCY.md`](docs/CONSISTENCY.md)** states the one property
this must never violate, and what this project deliberately does not
claim.

## Latency

`performCheck` (the check engine's own graph walk plus its real Postgres
round trips — no HTTP/network transit, which is a property of where a
caller is calling _from_, not a property of this engine) at increasing
permission-chain depth, measured against real Postgres, 50 runs per depth:

| Depth | p50    | p95    |
| ----- | ------ | ------ |
| 1     | 4.9ms  | 6.5ms  |
| 3     | 9.6ms  | 12.6ms |
| 5     | 12.6ms | 15.3ms |
| 10    | 17.4ms | 21.5ms |

Cost grows with depth — expected, since each hop is a real recursive step,
not memoized (§6.1: no cached, precomputed permission anywhere) — these
numbers reflect the uncached path, which is still what every correctness
claim in this project is proven against. An opt-in check-result cache now
exists (`src/resolve/production/cache.ts`, D-028/D-135 in
[`docs/DECISIONS.md`](docs/DECISIONS.md)) — still off by default
(`CHECK_CACHE_TTL_MS=0`) — with write-triggered invalidation designed,
adversarially reviewed, and proven correct (including a real
concurrent-request race the first design draft missed and a fully
deterministic regression test proving it's closed) before it shipped; see
`docs/CONSISTENCY.md`'s own section on the one non-negotiable rule it has to
hold. Numbers are this repo's own, not a vendor claim, and will vary by
machine — reproduce them yourself against your own database and hardware
with `npm run benchmark` (`scripts/benchmark-check-depth.ts`), the same
script that produced this table.

## What this is not

This is not a from-scratch alternative to production Zanzibar
implementations — [SpiceDB](https://authzed.com/spicedb),
[OpenFGA](https://openfga.dev/), and [Ory Keto](https://www.ory.sh/keto/)
already exist, are battle-tested at real scale, and are the right choice
for most teams that need this today. This project is not a distributed,
globally-consistent authorization system either — it runs on a single
Postgres, with consistency handled by the token mechanism above, not
multi-region consensus. It is not an ABAC/policy-language engine (no
attribute rules, no Rego/Cedar-style policy evaluation) — relationships
only. It is not an authentication system — subjects are opaque ids; who
authenticates them is out of scope entirely.

What this project actually contributes is the proof methodology —
differential fuzzing against an independent oracle, asymmetric verdicts
that treat an over-grant as categorically worse than an under-grant,
resolution-path audit trails for every decision, and deterministic
simulation testing of the write path itself under crash, lock, and
snapshot-isolation races (see above) — applied carefully to a
well-understood model (Zanzibar), not a
novel authorization model of its own. It demonstrates the ability to design, build, and prove correct
relationship-based authorization infrastructure end to end. If you want
this done against your own product's real schema rather than this
repository's example one, see **[`docs/DELIVERY.md`](docs/DELIVERY.md)**.

## Stack

Node 22 LTS + TypeScript (strict), Postgres via `pg` (hand-written SQL and
migrations, no ORM — the recursive graph walk is the part of this project
that must be exactly right and auditable, and a query builder is the
wrong place to hide that), Fastify for the API, `commander` for the CLI,
Vitest + `fast-check` for testing and property-based fuzzing, GitHub
Actions for CI. An optional `ioredis` client, gated entirely behind
`REDIS_URL` and unset by default, backs cross-replica rate-limit/flood-guard
state for deployments that actually run more than one instance — see
"API and CLI" below and D-137. No LLM API, no third-party auth provider —
Postgres is the only paid dependency a default, single-instance deployment
of this project has.

## API and CLI

| Command                                                                                | Does                                                                                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `authz doctor`                                                                         | Confirm `DATABASE_URL` is reachable, apply migrations, report status                                                                       |
| `authz schema compile <file>`                                                          | Parse + compile a namespace DSL file                                                                                                       |
| `authz schema publish <file>`                                                          | Compile and publish a new `namespace_configs` version                                                                                      |
| `authz schema diff <file>`                                                             | Compare a candidate against each namespace's currently-published version; warns (exit 1) on any change that isn't a provable widen (D-149) |
| `authz schema rollback <namespace> <version>`                                          | Republish an earlier published version's exact original source as a new version (D-149)                                                    |
| `authz tuple write <object> <relation> <subject> [--expires-at T]`                     | Write a tuple, prints the returned consistency token; `--expires-at` (ISO-8601) makes it live only until then (D-150)                      |
| `authz tuple delete <object> <relation> <subject>`                                     | Delete a tuple, prints the returned consistency token                                                                                      |
| `authz check <subject> <relation> <object> [--at-token T] [--path]`                    | Is `subject` related to `object` via `relation`? `--path` prints the real resolution path (see "What an `allow`..." above)                 |
| `authz expand <object> <relation>`                                                     | Print the resolved subject tree for `object`#`relation`                                                                                    |
| `authz soundness run [--queries N] [--seed S] [--format …] [--dry-run] [--progress N]` | Run the differential fuzz harness, print/store the report (`--dry-run`: leave nothing persisted; `--progress`: progress on stderr)         |
| `authz audit verify`                                                                   | Walk the `checks` hash chain; reports every row verified intact or names the exact first tampered row (D-148)                              |
| `authz audit privesc <object> <relation> [--expected s1,s2,...]`                       | Every real subject currently able to reach a relation/permission, each with its own path; `--expected` flags UNEXPECTED/MISSING drift      |
| `authz apikey create --role <admin\|readonly> [--scope ns1,ns2] [--expires-at T]`      | Mint a real, DB-backed API key; prints the raw key exactly once (D-152)                                                                    |
| `authz apikey revoke <id>`                                                             | Revoke a DB-backed API key by id; rejected immediately on every future use (D-152)                                                         |
| `authz apikey list`                                                                    | List every DB-backed API key (id, name, role, scopes, timestamps) — never a hash or raw key (D-152)                                        |
| `authz serve`                                                                          | Start the Fastify API server                                                                                                               |

`authz serve` exposes the same operations over HTTP, plus two bulk
reverse-lookup operations with no CLI command of their own:

| Method   | Route             | Auth                                  | Rate limit | Does                                                                       |
| -------- | ----------------- | ------------------------------------- | ---------- | -------------------------------------------------------------------------- |
| `POST`   | `/check`          | `ADMIN_API_KEY` or `READONLY_API_KEY` | 200/min    | Is `subject` related to `object` via `relation`?                           |
| `POST`   | `/check/batch`    | `ADMIN_API_KEY` or `READONLY_API_KEY` | 20/min     | Up to 50 checks in one call, order-preserving, independent results (D-152) |
| `POST`   | `/expand`         | `ADMIN_API_KEY` or `READONLY_API_KEY` | 200/min    | Resolved subject tree for `object`#`relation`                              |
| `POST`   | `/list-objects`   | `ADMIN_API_KEY` or `READONLY_API_KEY` | 200/min    | Every object a subject has a permission on (D-136)                         |
| `POST`   | `/list-users`     | `ADMIN_API_KEY` or `READONLY_API_KEY` | 200/min    | Every subject with a permission on an object (D-136)                       |
| `POST`   | `/tuples`         | `ADMIN_API_KEY`                       | 20/min     | Write a relation tuple (`expiresAt` optional, D-150)                       |
| `DELETE` | `/tuples`         | `ADMIN_API_KEY`                       | 20/min     | Delete a relation tuple                                                    |
| `POST`   | `/schema/compile` | none                                  | 100/min    | Parse + compile a namespace DSL source string (no write, no gate)          |
| `POST`   | `/schema/publish` | `ADMIN_API_KEY`                       | 20/min     | Compile and publish a new `namespace_configs` version                      |
| `GET`    | `/health`         | none                                  | 300/min    | Database connectivity and every currently-published namespace's version    |
| `GET`    | `/openapi.json`   | none                                  | 100/min    | This table, as a hand-maintained OpenAPI 3.0.3 document                    |

`READONLY_API_KEY` (D-138) is a second, narrower credential: it authorizes
the four read/list routes above without also granting write access.
`ADMIN_API_KEY` alone still authorizes every route, exactly as before that
credential existed. A third, optional credential tier (D-152) mints real,
DB-backed keys (`authz apikey create/revoke/list`) that can additionally be
scoped to a fixed set of namespaces and/or given an expiry — every gated
route above rejects an out-of-scope namespace with `403`, and neither
static env-var key is affected: a deployment that never mints a DB-backed
key keeps behaving exactly as it always has. Every rate/flood-guard budget
above can be backed by Redis instead of one process's own memory via the
optional `REDIS_URL` (D-137) — unset by default, a single-instance
deployment needs nothing new. See `src/api/server.ts`'s own doc comments
for the exact route shapes.

Static mockups of what a real UI over this would look like —
Namespaces, Tuple browser, Check playground, Soundness runs, Expand
tree — live under [`docs/screens/`](docs/screens/), built against this
same real example data.

## Repository layout

```
src/
  config/      validated environment loading
  schema/      the namespace DSL — publish.ts, diff.ts (schema-diff safety check, D-149), plus dsl/ (parser, compiler, types, errors)
  store/       migrations/ (the real .sql files), the tuple store, consistency tokens
    dst/     deterministic simulation testing — the in-memory fake storage seam (docs/DST-PROPOSAL.md)
  resolve/
    reference/   the differential-fuzzing oracle — deliberately naive, no shared code with production/
    production/  the real, SQL-backed check engine, plus the opt-in check-result cache (cache.ts)
  metamorphic/ classifyMonotone()/findFlippableExclusion() — the monotonicity classifier backing test/metamorphic/'s property tests (D-140, D-147)
  soundness/   the differential-fuzz generator, classifier, runner
  audit/       expand(), listObjects()/listUsers(), privesc.ts (privilege-escalation scanner, D-152), and the hash-chained checks audit trail every real check is logged to (tamper-evidence, D-148)
  report/      markdown/JSON soundness reporters, exit codes, PR-comment logic
  api/         the Fastify server, db-api-keys.ts (DB-backed API-key tier, D-152), openapi-document.ts (GET /openapi.json's own document, D-152), plus the opt-in Redis-backed rate-limit store (redis-store.ts)
  cli/         the authz CLI — index.ts, plus commands/ (one file per subcommand)
schema/example.authz        the real demo schema this README's own examples come from
scripts/seed-example.ts     publishes it + the real demo tuple graph
scripts/generate-openapi.ts writes docs/openapi.json (D-152)
tools/schema-verifier/  the static schema verifier — see "A third proof" above; src/smt/ is the z3-backed exact tier for the non-recursive fragment (D-151)
docs/        RELATIONS.md, CONSISTENCY.md, DELIVERY.md, DECISIONS.md, INVARIANTS.md, FINDINGS.md,
             DST-PROPOSAL.md, github-governance.md, dst-regression-corpus.json, screens/
test/
  isolation/   the inherited, repurposed proof suite — see test/isolation/README.md
  metamorphic/ a fourth proof mechanism — algebraic/invariant properties, no second implementation needed (D-140)
  unit/        per-module unit + integration tests, one file per real claim
.claude/commands/  the build specification this whole project was built under
.claude/agents/    the subagents that specification delegates specific phases to
.claude/workflows/ the multi-agent audit workflow this project runs periodically against itself
```

## Building this out further / contributing

Read [`.claude/commands/build-authz-service.md`](.claude/commands/build-authz-service.md)
in full before touching implementation code — it defines the phases, the
data model, the soundness-validation methodology, the test plan, and the
subagent delegation rules this project was built under. Track real,
current status in [`PROGRESS.md`](PROGRESS.md) and the reasoning behind
every non-obvious call in [`docs/DECISIONS.md`](docs/DECISIONS.md) — on an
authorization system, "it seemed reasonable" is not an answer a security
reviewer should accept, and it isn't one this project accepts from itself
either.
