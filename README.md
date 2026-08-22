# Relationship-Based Authorization

A fine-grained authorization service, Zanzibar-style: relationship tuples
and a graph-walking check engine, with a differential-fuzzing proof that
the check engine never grants a permission no real path supports.

[![CI](https://github.com/NovaVey/Relationship-Based-Authorization/actions/workflows/ci.yml/badge.svg)](https://github.com/NovaVey/Relationship-Based-Authorization/actions/workflows/ci.yml)
[![Soundness](https://github.com/NovaVey/Relationship-Based-Authorization/actions/workflows/soundness.yml/badge.svg)](https://github.com/NovaVey/Relationship-Based-Authorization/actions/workflows/soundness.yml)
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
SOUND — 0 false_grant, 0 false_deny, across 5000 queries
```

That's a real run's output (`authz soundness run`), not a projected or
aspirational number — every PR to this repository re-runs it and posts
the result as a comment (see the Soundness badge above). A system stating
its own false-grant rate under adversarial random testing, and reporting
it even when it isn't zero, is a claim almost nothing in this space states
this plainly — and it's the entire reason this project exists: proving
the check engine never says yes when no path exists is worth more than
any feature the engine itself has. `docs/RELATIONS.md`'s "every `allow`
can show its work" section and `.claude/commands/build-authz-service.md`
§6.2/§6.5 cover the mechanism — a deliberately naive, deliberately slow,
independently-written oracle (no shared code with the production engine)
checked against the real engine on every random query, with a **false
grant always failing the run outright**, regardless of how rare it was,
and a false deny reported but never blocking on its own — the asymmetry
is deliberate, because the two failure modes are not equally dangerous.

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
`docs/DECISIONS.md` D-095 for why). Five phases have landed so far:

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

`npx vitest run test/unit/store/dst/` runs the DB-free half of it — no
Postgres, no Docker, identical result every time. D3's own
differential-equivalence proof against real Postgres lives alongside the
other `*.integration.test.ts` suites (`npm run test:integration`) since,
unlike the rest of DST, it genuinely needs a real database to check itself
against.

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
not memoized (§6.1: no cached, precomputed permission anywhere). No cache
is enabled by default (`CHECK_CACHE_TTL_MS=0` — see `docs/CONSISTENCY.md`'s
own section on why, and what it would take to turn one on safely). Numbers
are this repo's own, not a vendor claim — reproduce them yourself against
your own database and hardware with `npm run benchmark`
(`scripts/benchmark-check-depth.ts`), the same script that produced this
table.

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
Actions for CI. No LLM API, no third-party auth provider — Postgres is
the only paid dependency this project has.

## API and CLI

```
authz doctor                                        confirm DATABASE_URL is reachable, apply migrations, report status
authz schema compile <file>                         parse + compile a namespace DSL file
authz schema publish <file>                         compile and publish a new namespace_configs version
authz tuple write <object> <relation> <subject>     write a tuple, prints the returned consistency token
authz tuple delete <object> <relation> <subject>
authz check <subject> <relation> <object> [--at-token <n>] [--path]   --path: print the real resolution path (see "What an allow actually looks like here" above)
authz expand <object> <relation>                    print the resolved subject tree
authz soundness run [--queries N] [--seed S] [--format text|markdown|json] [--dry-run] [--progress N]   run the differential fuzz harness, print/store the report (--dry-run: leave nothing persisted; --progress: "checked X/Y queries" on stderr every N queries)
authz serve                                         start the Fastify API server
```

`authz serve` exposes the same five operations over HTTP
(`POST /check`, `POST /expand`, `POST`/`DELETE /tuples`, `POST
/schema/compile`, `POST /schema/publish`, plus `GET /health`) —
`ADMIN_API_KEY`-gated writes, rate-limited, `/health` reporting database
connectivity and every currently-published namespace's version. See
`src/api/server.ts`'s own doc comments for the exact route shapes.

Static mockups of what a real UI over this would look like —
Namespaces, Tuple browser, Check playground, Soundness runs, Expand
tree — live under [`docs/screens/`](docs/screens/), built against this
same real example data.

## Repository layout

```
src/
  config/    validated environment loading
  schema/    the namespace DSL — parser, compiler, publish
  store/     migrations, the tuple store, consistency tokens
    dst/     deterministic simulation testing — the in-memory fake storage seam (docs/DST-PROPOSAL.md)
  resolve/
    reference/   the differential-fuzzing oracle — deliberately naive, no shared code with production/
    production/  the real, SQL-backed check engine
  soundness/ the differential-fuzz generator, classifier, runner
  audit/     expand(), and the checks audit trail every real check is logged to
  report/    markdown/JSON soundness reporters, exit codes, PR-comment logic
  api/       the Fastify server
  cli/       the authz CLI
schema/example.authz        the real demo schema this README's own examples come from
scripts/seed-example.ts     publishes it + the real demo tuple graph
docs/        RELATIONS.md, CONSISTENCY.md, DELIVERY.md, DECISIONS.md, DST-PROPOSAL.md, github-governance.md, screens/
test/
  isolation/ the inherited, repurposed proof suite — see test/isolation/README.md
  unit/      per-module unit + integration tests, one file per real claim
.claude/commands/  the build specification this whole project was built under
.claude/agents/    the subagents that specification delegates specific phases to
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
