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
`POST /check`/`/expand` accept either `ADMIN_API_KEY` or `READONLY_API_KEY`
(D-064, widened by D-138); `/schema/publish` and `/tuples` writes remain
`ADMIN_API_KEY`-only — this is a live instance of the real service, not a
public sandbox, so read access is deliberately not open to anyone who finds
the URL. `POST /schema/compile` (no write, no gate) is open if you want to
try the DSL compiler itself against your own source.

## Contents

- [The failure this exists to stop](#the-failure-this-exists-to-stop)
- [What an `allow` actually looks like here](#what-an-allow-actually-looks-like-here)
- [The soundness result](#the-soundness-result)
- [Further proof, and the full review history](#further-proof-and-the-full-review-history)
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

## Further proof, and the full review history

Beyond the differential-fuzzing result above, this project has been
through nine more rounds of proof, review, and hardening: deterministic
simulation testing of the write path under crash and lock faults, a
static schema verifier proving universal safety rather than sampling it,
a live-verification doc audit plus metamorphic and mutation testing (which
together found and fixed a real soundness bug — `exclusion` meeting a
data cycle could flip a fail-closed deny into an unsound grant), an
offline acceleration index for nested groups, and an external technical
review answered point by point with a machine-checked TLA+ proof and a
neutral benchmark against OpenFGA and SpiceDB. Read the full,
chronological account — every decision, every fail-check, every bug found
and fixed, in the order it actually happened — in
**[`docs/REVIEWS.md`](docs/REVIEWS.md)**.

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

### Or, with Docker — no local Node or Postgres install at all

```bash
git clone https://github.com/NovaVey/Relationship-Based-Authorization
cd Relationship-Based-Authorization
cp .env.example .env
docker compose up -d              # postgres + the built service, migrations applied automatically
docker compose exec app npm run seed:example   # one-off — see below for why this isn't automatic
curl -s -H "Authorization: Bearer local-dev-only-admin-key-not-for-production-use" \
  -X POST http://localhost:3000/check \
  -d '{"subject":{"ns":"user","id":"dana"},"relation":"edit","object":{"ns":"document","id":"eng_handbook"}}'
```

Two commands, deliberately, not one: `docker compose up -d` builds the
image (`Dockerfile`) and starts `postgres` plus `app` — `app`'s own `CMD`
runs `authz doctor` (applies every migration, exits nonzero on a real
failure) then `authz serve`, exactly `npm start`'s own definition — but
seeding the demo graph stays a separate `docker compose exec` step on
purpose: `publishSchema` always inserts a new `namespace_configs` version
row, never a no-op on identical content, so running it automatically on
every container restart would pile up redundant schema versions forever
instead of a clean, one-time seed. `docker-compose.yml`'s own `app`
service ships a local-only `ADMIN_API_KEY` placeholder (never reuse it
anywhere real) so the write routes and `/check` above work with zero
further setup.

### Troubleshooting: `authz doctor` says `Postgres: unreachable`

`cp .env.example .env` alone leaves `DATABASE_URL` pointing at the
placeholder in that file — a template connection string, not a real
database. `doctor` reporting `Postgres: unreachable` means exactly that:
nothing is listening wherever `DATABASE_URL` currently points. Three ways
to fix it, in order of least setup required:

1. **`docker compose up -d postgres`** — this repo ships a
   `docker-compose.yml` with credentials matched to `.env.example`'s own
   placeholder, so if you haven't edited `DATABASE_URL` yet, this needs no
   further changes at all. Requires Docker; nothing else. (Naming the
   service matters here — bare `docker compose up -d` also starts the
   `app` service below, which is the point if you want the whole stack
   containerized rather than running from source against a bare Postgres.)
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

A caller that checks permissions inline, on a real request path — an API
gateway, a policy-decision point, an agent tool-call broker — has sharper
requirements than this section covers: a real HTTP-plus-Postgres latency
budget (not just the in-process numbers above), when the opt-in cache is
actually worth enabling, what a pinned check whose token hasn't landed yet
should do, how `/check/batch` behaves under a partial failure, and a
stated fail-open/fail-closed contract for when this service can't be
reached at all. **[`docs/INTEGRATION.md`](docs/INTEGRATION.md)** is
written for exactly that caller.

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
authenticates them is out of scope entirely (see
**[`docs/INTEGRATION.md`](docs/INTEGRATION.md)**'s own "identity seam"
section for exactly what a real caller has to get right instead).

What this project actually contributes is the proof methodology —
differential fuzzing against an independent oracle, asymmetric verdicts
that treat an over-grant as categorically worse than an under-grant,
resolution-path audit trails for every decision, and deterministic
simulation testing of the write path itself under crash, lock, and
snapshot-isolation races (see `docs/REVIEWS.md`) — applied carefully to a
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

| Command                                                                                      | Does                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authz doctor`                                                                               | Confirm `DATABASE_URL` is reachable, apply migrations, report status                                                                                                                                                 |
| `authz schema compile <file>`                                                                | Parse + compile a namespace DSL file                                                                                                                                                                                 |
| `authz schema publish <file>`                                                                | Compile and publish a new `namespace_configs` version                                                                                                                                                                |
| `authz schema diff <file>`                                                                   | Compare a candidate against each namespace's currently-published version; warns (exit 1) on any change that isn't a provable widen (D-149)                                                                           |
| `authz schema rollback <namespace> <version>`                                                | Republish an earlier published version's exact original source as a new version (D-149)                                                                                                                              |
| `authz tuple write <object> <relation> <subject> [--expires-at T]`                           | Write a tuple, prints the returned consistency token; `--expires-at` (ISO-8601) makes it live only until then (D-150)                                                                                                |
| `authz tuple delete <object> <relation> <subject>`                                           | Delete a tuple, prints the returned consistency token                                                                                                                                                                |
| `authz tuple export [--namespace <ns>]`                                                      | Export every stored tuple (or one namespace) as NDJSON to stdout (D-170)                                                                                                                                             |
| `authz tuple import [<file>] [--progress <n>]`                                               | Import NDJSON tuples from `<file>` (or stdin) via the real `writeTuple`, one bad line reported and skipped rather than sinking the whole import (D-170)                                                              |
| `authz check <subject> <relation> <object> [--at-token T] [--path]`                          | Is `subject` related to `object` via `relation`? `--path` prints the real resolution path (see "What an `allow`..." above)                                                                                           |
| `authz expand <object> <relation>`                                                           | Print the resolved subject tree for `object`#`relation`                                                                                                                                                              |
| `authz soundness run [--queries N] [--seed S] [--format …] [--dry-run] [--progress N]`       | Run the differential fuzz harness, print/store the report (`--dry-run`: leave nothing persisted; `--progress`: progress on stderr)                                                                                   |
| `authz audit verify [--anchor-file <path>]`                                                  | Walk the `checks` hash chain; reports every row verified intact or names the exact first tampered row (D-148). `--anchor-file` also catches a full, consistent forward rewrite the internal walk alone can't (D-155) |
| `authz audit anchor [--file <path>]`                                                         | Append one entry recording the checks hash chain's current tip to a local, append-only file (D-155)                                                                                                                  |
| `authz audit privesc <object> <relation> [--expected s1,s2,...]`                             | Every real subject currently able to reach a relation/permission, each with its own path; `--expected` flags UNEXPECTED/MISSING drift                                                                                |
| `authz apikey create --role <admin\|readonly> [--scope ns1,ns2] [--expires-at T] [--name L]` | Mint a real, DB-backed API key; prints the raw key exactly once (D-152)                                                                                                                                              |
| `authz apikey revoke <id>`                                                                   | Revoke a DB-backed API key by id; rejected immediately on every future use (D-152)                                                                                                                                   |
| `authz apikey list`                                                                          | List every DB-backed API key (id, name, role, scopes, timestamps) — never a hash or raw key (D-152)                                                                                                                  |
| `authz leopard refresh [--dry-run]`                                                          | Rebuild the offline Leopard index (D-163) — an opt-in, pinned-checks-only acceleration for nested-group membership; a miss always falls through to the live resolver unmodified                                      |
| `authz leopard status`                                                                       | Report whether the Leopard index is enabled, never built, or built (with watermark/staleness)                                                                                                                        |
| `authz serve`                                                                                | Start the Fastify API server                                                                                                                                                                                         |

`authz serve` exposes the same operations over HTTP, plus two bulk
reverse-lookup operations with no CLI command of their own:

| Method   | Route             | Auth                                  | Rate limit | Does                                                                                                                  |
| -------- | ----------------- | ------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/check`          | `ADMIN_API_KEY` or `READONLY_API_KEY` | 200/min    | Is `subject` related to `object` via `relation`?                                                                      |
| `POST`   | `/check/batch`    | `ADMIN_API_KEY` or `READONLY_API_KEY` | 20/min     | Up to 50 checks in one call, order-preserving, independent results (D-152)                                            |
| `POST`   | `/expand`         | `ADMIN_API_KEY` or `READONLY_API_KEY` | 200/min    | Resolved subject tree for `object`#`relation`                                                                         |
| `POST`   | `/list-objects`   | `ADMIN_API_KEY` or `READONLY_API_KEY` | 200/min    | Every object a subject has a permission on (D-136), reverse-lookup-accelerated when the Leopard index is warm (D-175) |
| `POST`   | `/list-users`     | `ADMIN_API_KEY` or `READONLY_API_KEY` | 200/min    | Every subject with a permission on an object (D-136)                                                                  |
| `POST`   | `/tuples`         | `ADMIN_API_KEY`                       | 20/min     | Write a relation tuple (`expiresAt` optional, D-150)                                                                  |
| `POST`   | `/tuples/batch`   | `ADMIN_API_KEY`                       | 20/min     | Up to 50 tuple writes in one call, order-preserving; one bad tuple never sinks the others (D-170)                     |
| `DELETE` | `/tuples`         | `ADMIN_API_KEY`                       | 20/min     | Delete a relation tuple                                                                                               |
| `POST`   | `/schema/compile` | none                                  | 100/min    | Parse + compile a namespace DSL source string (no write, no gate)                                                     |
| `POST`   | `/schema/publish` | `ADMIN_API_KEY`                       | 20/min     | Compile and publish a new `namespace_configs` version                                                                 |
| `GET`    | `/health`         | none                                  | 300/min    | Database connectivity and every currently-published namespace's version                                               |
| `GET`    | `/openapi.json`   | none                                  | 100/min    | This table, as a hand-maintained OpenAPI 3.0.3 document                                                               |
| `GET`    | `/metrics`        | `ADMIN_API_KEY` only, unscoped        | 200/min    | Prometheus text exposition — check counts, cache hit rate, Leopard-index hits, uncertain-check rate (D-169)           |
| `GET`    | `/watch`          | `ADMIN_API_KEY` or `READONLY_API_KEY` | 200/min\*  | Live SSE stream of every tuple write/delete from `?since=<token>` (or "now") forward (D-174)                          |

`READONLY_API_KEY` (D-138) is a second, narrower credential: it authorizes
the five read/list routes above (including `/watch`) without also granting
write access. `ADMIN_API_KEY` alone still authorizes every route, exactly
as before that credential existed. A third, optional credential tier
(D-152) mints real, DB-backed keys (`authz apikey create/revoke/list`) that
can additionally be scoped to a fixed set of namespaces and/or given an
expiry — every gated route above rejects an out-of-scope namespace with
`403` (`/watch` requires the namespace scope, since a scoped credential has
no "every namespace" mode to fall back on — see D-174), and neither static
env-var key is affected: a deployment that never mints a DB-backed key
keeps behaving exactly as it always has. Every rate/flood-guard budget
above can be backed by Redis instead of one process's own memory via the
optional `REDIS_URL` (D-137) — unset by default, a single-instance
deployment needs nothing new. \* `/watch`'s own rate limit gates the
initial connection only — once open, a stream's own pushed events are
never individually rate-limited. See `src/api/server.ts`'s own doc
comments for the exact route shapes.

Static mockups of what a real UI over this would look like —
Namespaces, Tuple browser, Check playground, Soundness runs, Expand
tree — live under [`docs/screens/`](docs/screens/), built against this
same real example data.

## Repository layout

```
src/
  config/      validated environment loading
  schema/      the namespace DSL — publish.ts, diff.ts (schema-diff safety check, D-149), plus dsl/ (parser, compiler, types, errors)
  store/       migrations/ (the real .sql files), the tuple store, consistency tokens, relation-index.ts (the offline Leopard-index rebuild + lookup, D-163; plus the reverse-lookup accelerant reusing the same table, D-175)
    dst/     deterministic simulation testing — the in-memory fake storage seam (docs/DST-PROPOSAL.md), extended to the Leopard index's own async rebuild/lookup pipeline (docs/DST-LEOPARD-EVOLUTION-PROPOSAL.md, D-165)
  resolve/
    reference/   the differential-fuzzing oracle — deliberately naive, no shared code with production/
    production/  the real, SQL-backed check engine, plus the opt-in check-result cache (cache.ts)
  metamorphic/ classifyMonotone()/findFlippableExclusion() — the monotonicity classifier backing test/metamorphic/'s property tests (D-140, D-147)
  soundness/   the differential-fuzz generator, classifier, runner — including expiring tuples in the random tuple graph (D-154)
  audit/       expand(), listObjects()/listUsers() (listObjects reverse-lookup-accelerated, D-175), privesc.ts (privilege-escalation scanner, D-152), the hash-chained checks audit trail every real check is logged to (tamper-evidence, D-148), and anchor.ts (the out-of-band, append-only tip anchor, D-155)
  report/      markdown/JSON soundness reporters, exit codes, PR-comment logic
  api/         the Fastify server, db-api-keys.ts (DB-backed API-key tier, D-152), openapi-document.ts (GET /openapi.json's own document, D-152), plus the opt-in Redis-backed rate-limit store (redis-store.ts)
  cli/         the authz CLI — index.ts, plus commands/ (one file per command group, e.g. schema.ts backs compile/publish/diff/rollback; leopard.ts backs refresh/status, D-163; serve.ts's own optional in-process Leopard-refresh timer, D-167)
schema/example.authz        the real demo schema this README's own examples come from
scripts/seed-example.ts     publishes it + the real demo tuple graph
scripts/generate-openapi.ts writes docs/openapi.json (D-152)
tools/schema-verifier/  the static schema verifier — see docs/REVIEWS.md's "A third proof" section; src/smt/ is the z3-backed exact tier for the non-recursive fragment (D-151), src/smt/chc.ts the Horn-clause/CHC tier for the recursive fragment (D-153)
tools/rebac-benchmark/  a neutral check-latency/consistency benchmark against real OpenFGA and SpiceDB instances — see docs/REVIEWS.md's "An external review, answered" section; its own README.md is the practical run guide, docs/BENCHMARK-PROPOSAL.md the methodology and every real result
docs/        REVIEWS.md (the full, chronological proof/build history), RELATIONS.md,
             CONSISTENCY.md, INTEGRATION.md (latency budget, caching story, consistency-token
             discipline, fail-open/fail-closed contract, and the identity seam — for a caller
             integrating this service into its own request path), DELIVERY.md, DECISIONS.md,
             INVARIANTS.md, FINDINGS.md, DST-PROPOSAL.md, DST-LEOPARD-EVOLUTION-PROPOSAL.md,
             LEOPARD-INDEX-PROPOSAL.md, leopard-index.tla/.cfg + TLA-SPEC-NOTES.md (a
             machine-checked proof of the index's own staleness invariant, D-165/D-167),
             BENCHMARK-PROPOSAL.md, github-governance.md, dst-regression-corpus.json,
             openapi.json, screens/
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
