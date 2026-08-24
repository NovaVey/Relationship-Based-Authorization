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
actually wired into a scheduled CI job later (D-134). Track real, current
status in [`PROGRESS.md`](PROGRESS.md).

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

| Command                                                                                | Does                                                                                                                               |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `authz doctor`                                                                         | Confirm `DATABASE_URL` is reachable, apply migrations, report status                                                               |
| `authz schema compile <file>`                                                          | Parse + compile a namespace DSL file                                                                                               |
| `authz schema publish <file>`                                                          | Compile and publish a new `namespace_configs` version                                                                              |
| `authz tuple write <object> <relation> <subject>`                                      | Write a tuple, prints the returned consistency token                                                                               |
| `authz tuple delete <object> <relation> <subject>`                                     | Delete a tuple, prints the returned consistency token                                                                              |
| `authz check <subject> <relation> <object> [--at-token T] [--path]`                    | Is `subject` related to `object` via `relation`? `--path` prints the real resolution path (see "What an `allow`..." above)         |
| `authz expand <object> <relation>`                                                     | Print the resolved subject tree for `object`#`relation`                                                                            |
| `authz soundness run [--queries N] [--seed S] [--format …] [--dry-run] [--progress N]` | Run the differential fuzz harness, print/store the report (`--dry-run`: leave nothing persisted; `--progress`: progress on stderr) |
| `authz serve`                                                                          | Start the Fastify API server                                                                                                       |

`authz serve` exposes the same operations over HTTP, plus two bulk
reverse-lookup operations with no CLI command of their own:

| Method   | Route             | Auth                                  | Rate limit | Does                                                                    |
| -------- | ----------------- | ------------------------------------- | ---------- | ----------------------------------------------------------------------- |
| `POST`   | `/check`          | `ADMIN_API_KEY` or `READONLY_API_KEY` | 200/min    | Is `subject` related to `object` via `relation`?                        |
| `POST`   | `/expand`         | `ADMIN_API_KEY` or `READONLY_API_KEY` | 200/min    | Resolved subject tree for `object`#`relation`                           |
| `POST`   | `/list-objects`   | `ADMIN_API_KEY` or `READONLY_API_KEY` | 200/min    | Every object a subject has a permission on (D-136)                      |
| `POST`   | `/list-users`     | `ADMIN_API_KEY` or `READONLY_API_KEY` | 200/min    | Every subject with a permission on an object (D-136)                    |
| `POST`   | `/tuples`         | `ADMIN_API_KEY`                       | 20/min     | Write a relation tuple                                                  |
| `DELETE` | `/tuples`         | `ADMIN_API_KEY`                       | 20/min     | Delete a relation tuple                                                 |
| `POST`   | `/schema/compile` | none                                  | 100/min    | Parse + compile a namespace DSL source string (no write, no gate)       |
| `POST`   | `/schema/publish` | `ADMIN_API_KEY`                       | 20/min     | Compile and publish a new `namespace_configs` version                   |
| `GET`    | `/health`         | none                                  | 300/min    | Database connectivity and every currently-published namespace's version |

`READONLY_API_KEY` (D-138) is a second, narrower credential: it authorizes
the four read/list routes above without also granting write access.
`ADMIN_API_KEY` alone still authorizes every route, exactly as before that
credential existed. Every rate/flood-guard budget above can be backed by
Redis instead of one process's own memory via the optional `REDIS_URL`
(D-137) — unset by default, a single-instance deployment needs nothing
new. See `src/api/server.ts`'s own doc comments for the exact route
shapes.

Static mockups of what a real UI over this would look like —
Namespaces, Tuple browser, Check playground, Soundness runs, Expand
tree — live under [`docs/screens/`](docs/screens/), built against this
same real example data.

## Repository layout

```
src/
  config/    validated environment loading
  schema/    the namespace DSL — publish.ts, plus dsl/ (parser, compiler, types, errors)
  store/     migrations/ (the real .sql files), the tuple store, consistency tokens
    dst/     deterministic simulation testing — the in-memory fake storage seam (docs/DST-PROPOSAL.md)
  resolve/
    reference/   the differential-fuzzing oracle — deliberately naive, no shared code with production/
    production/  the real, SQL-backed check engine, plus the opt-in check-result cache (cache.ts)
  soundness/ the differential-fuzz generator, classifier, runner
  audit/     expand(), listObjects()/listUsers(), and the checks audit trail every real check is logged to
  report/    markdown/JSON soundness reporters, exit codes, PR-comment logic
  api/       the Fastify server, plus the opt-in Redis-backed rate-limit store (redis-store.ts)
  cli/       the authz CLI — index.ts, plus commands/ (one file per subcommand)
schema/example.authz        the real demo schema this README's own examples come from
scripts/seed-example.ts     publishes it + the real demo tuple graph
tools/schema-verifier/  the static schema verifier — see "A third proof" above
docs/        RELATIONS.md, CONSISTENCY.md, DELIVERY.md, DECISIONS.md, INVARIANTS.md, FINDINGS.md,
             DST-PROPOSAL.md, github-governance.md, dst-regression-corpus.json, screens/
test/
  isolation/ the inherited, repurposed proof suite — see test/isolation/README.md
  unit/      per-module unit + integration tests, one file per real claim
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
