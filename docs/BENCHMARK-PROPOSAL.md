# A neutral ReBAC benchmark: methodology, feasibility, and a real first run

This document does for **performance comparison** what `docs/FINDINGS.md`
already did for **schema expressiveness**: state a methodology plainly
enough that someone outside this project could rerun it and check the
claims, disclose what wasn't measured as carefully as what was, and never
present a rough first pass as more than it is. `docs/FINDINGS.md`'s two
rules translate directly:

1. **A number this project's own engine wins is a data point, not a
   victory lap.** The honest framing is "under this workload, on this
   machine, this engine's check latency was X" — never "this engine is
   faster."
2. **Nothing below is published as a finding unless it was actually run**
   against a real, live instance of the engine it's about. Where a
   number wasn't obtained (SpiceDB throughput under sustained concurrent
   load, say), this document says so plainly rather than estimating it.

The harness itself lives in [`tools/rebac-benchmark/`](../tools/rebac-benchmark/)
— its own README has exact commands to reproduce every number below.

## Contents

- [Step 1: feasibility, checked live in this sandbox](#step-1-feasibility-checked-live-in-this-sandbox)
- [What's fair to compare](#whats-fair-to-compare)
- [The two metrics, and why these two](#the-two-metrics-and-why-these-two)
- [The workload, in all three schema languages](#the-workload-in-all-three-schema-languages)
- [Schema translation notes: real gaps found by actually running this](#schema-translation-notes-real-gaps-found-by-actually-running-this)
- [Harness architecture](#harness-architecture)
- [Environment this run's numbers came from](#environment-this-runs-numbers-came-from)
- [Real results](#real-results)
- [What would make this citable outside this project](#what-would-make-this-citable-outside-this-project)
- [Revisit if / future work](#revisit-if--future-work)

## Step 1: feasibility, checked live in this sandbox

The task that produced this document opened with a hard feasibility
question, and it's answered here first because everything downstream
depends on the answer: **can OpenFGA and SpiceDB actually run in this
environment at all, without Docker?**

```
$ docker info
...
Server:
failed to connect to the docker API at unix:///var/run/docker.sock:
check if the path is correct and if the daemon is running: dial unix
/var/run/docker.sock: connect: no such file or directory
```

Confirmed unreachable, independently of the probe that flagged this
before this document's own work began — environments can differ, and this
was checked again rather than assumed. But the fallback held:

```
$ go install github.com/openfga/openfga/cmd/openfga@latest   # → v1.19.0
$ go install github.com/authzed/spicedb/cmd/spicedb@latest   # → v1.56.1
```

Both built as **native binaries** through the Go module proxy (generic
GitHub access is blocked in this sandbox; the module proxy is not) and
both actually **started up and served real traffic**:

```
$ openfga run --datastore-engine memory --http-addr 0.0.0.0:8080 --grpc-addr 0.0.0.0:8081
...
🚀 starting HTTP server on '0.0.0.0:8080'...
🚀 starting gRPC server on '0.0.0.0:8081'...

$ spicedb serve --grpc-preshared-key "..." --datastore-engine memory \
    --http-enabled --http-addr 0.0.0.0:8443 \
    --dispatch-cache-enabled=false --dispatch-cluster-cache-enabled=false
...
grpc server started serving
```

Both engines' **in-memory datastore** (`--datastore-engine memory`, the
default for both) was used for the actual runs below — no Postgres
dependency for either third-party engine. This repo's own engine has no
in-memory mode (by design — see README.md's "Stack" section on why
hand-written SQL over a real Postgres connection is the point, not an
implementation detail to abstract away), so it needed a real Postgres
instead of Docker's `docker-compose.yml` Postgres service. That, too, was
available without Docker: `postgresql-16` was already installed as a
native Ubuntu package in this sandbox (`apt list --installed`), already
running (`pg_lsclusters` showed cluster `16 main` `online`), and a
dedicated role/database were created directly (`sudo -u postgres psql`)
matching this repo's own `.env.example`/`docker-compose.yml` credential
convention — no Docker involved anywhere in this document's numbers.

**This means the shape of this task did not have to change.** All three
engines ran as real, live, locally-installed processes; every number
below came from a real network call to one of them, not a simulation or
an estimate.

One caveat worth stating plainly here rather than burying it: `go install
...@latest` resolved to whatever each project's latest tagged release was
on the day this ran (2026-08-29) — **v1.19.0** for OpenFGA and **v1.56.1**
for SpiceDB. Neither version was pinned in advance; a rerun on a later
date would install newer code. See "What would make this citable" below
for why a real citable version of this harness pins exact versions
instead.

## What's fair to compare

Three engines with genuinely different data models and APIs can't be
compared by pointing the same client at all three — the comparison has to
be designed at the layer where they're actually equivalent, and disclosed
plainly everywhere they aren't.

**Equivalent, and used as the basis for comparison:**

- All three are Zanzibar-style ReBAC engines: a schema/model defines
  object types and rewrite rules (union, intersection, exclusion,
  tuple-to-userset, nested-userset subjects); a tuple/relationship store
  holds facts; a check operation answers one question — is this subject
  related to this object via this relation/permission? — by walking that
  graph.
- All three expose that check operation over a **real network API** this
  harness calls the same way it would call any of them in production:
  HTTP for this repo's own engine and for OpenFGA, gRPC for SpiceDB (see
  "Harness architecture" below for why SpiceDB specifically needs a
  client library rather than a hand-rolled HTTP call).
- All three can express this repo's own demo schema
  (`schema/example.authz`) with no loss of meaning — every rewrite-rule
  kind in it (union, exclusion, intersection, tuple-to-userset, nested
  group membership as a userset-typed subject) has a direct, checked
  translation in both OpenFGA's and SpiceDB's own schema languages. That
  translation is the workload; see below.

**Not equivalent, and deliberately not normalized away:**

- **Consistency model.** This repo's own engine has exactly one
  consistency mode: every check reads current committed Postgres state
  directly (no cache by default — `CHECK_CACHE_TTL_MS=0`). OpenFGA
  defaults to the same effective behavior (`check-query-cache-enabled`
  defaults to `false`). SpiceDB defaults to `minimizeLatency`, which may
  read a revision up to `--datastore-revision-quantization-interval`
  (default **5 seconds**) stale, and offers a separate, explicit
  `fullyConsistent` mode that reads current state like the other two.
  This harness's latency/correctness benchmarks pin SpiceDB to
  `fullyConsistent` so all three are answering from equally current data
  — **and separately measures the default-consistency gap on purpose**
  (see "Metric 2" below), because collapsing it would hide a real,
  disclosed design difference between the three engines' defaults, not a
  benchmark artifact.
- **Tenancy/isolation model.** OpenFGA is natively multi-tenant (a
  `store` holds one model + its tuples; the harness creates a fresh store
  per run, so runs never collide). This repo's own engine has no store
  concept — a namespace publish is additive and versioned
  (`docs/DECISIONS.md` D-149), so re-running the harness against the same
  Postgres database is naturally idempotent (`on conflict ... do
nothing`) and safe. SpiceDB (OSS) has **no per-run tenant isolation at
  all** — one schema, one relationship store, for the whole process —
  confirmed live: a `WriteSchema` call that would drop a definition still
  referenced by an existing relationship is flatly rejected
  (`cannot delete object definition ..., as at least one relationship
exists under it`), and a `CREATE` relationship-write against one that
  already exists is rejected too (`ALREADY_EXISTS`). The SpiceDB adapter
  works around both: one combined schema file covering the whole
  workload (`workloads/spicedb-combined.zed`) written once, and `TOUCH`
  instead of `CREATE` for idempotent writes. This is a real, structural
  difference between the three systems' operational models, not
  something this harness can or should normalize away — a team actually
  running SpiceDB in production faces the identical one-schema,
  one-tenant reality this adapter had to design around.
- **Write throughput under this repo's own default configuration.**
  `POST /tuples` is rate-limited to 20 requests/minute by default
  (README.md's "API and CLI" table; `src/api/server.ts`'s
  `writeRateLimit`, hardcoded, no environment-variable override) — a
  deliberate anti-abuse default, not an engine-performance number.
  Confirmed live: even this harness's own 22-tuple demo graph alone
  exceeds it, and populating the full depth-chain workload over HTTP
  took several real minutes of rate-limit backoff (see
  `tools/rebac-benchmark/src/adapters/authz-adapter.ts`'s
  `postWithBackoff`). Neither OpenFGA's nor SpiceDB's default
  configuration imposes an equivalent ceiling. **This harness does not
  report tuple-write throughput as a comparable metric at all** — doing
  so would measure this project's own safety default against the other
  two engines' absence of one, not the three check engines against each
  other. This is disclosed here as a real, load-bearing finding about
  this project's own default posture, not hidden because it's
  unflattering.
- **Deployment topology.** All three engines ran as single-process,
  single-machine instances in this sandbox — no multi-node dispatch, no
  read replicas, no network partition between a check request and its
  datastore. SpiceDB and OpenFGA are both built for exactly that
  multi-node topology in production; this harness cannot speak to how
  either behaves there. See "Revisit if" below.

## The two metrics, and why these two

The task brief named these two as "the most defensible neutral metrics";
this harness implements both, and no others, because these are the two
that survive the "not just an aspirational metrics suite" test — each one
is fully specified, actually implemented, and actually run below.

**Metric 1 — raw check-latency distribution at controlled permission-chain
depth.** Not a fixed QPS/concurrency load test (see "Revisit if" for why
that's deferred, not abandoned) — a **sequential** distribution: for each
of several chain depths, several structurally-identical but
data-independent checks are issued one at a time, and p50/p95/p99/max are
reported per depth per engine. This directly extends this repo's own
precedent (`scripts/benchmark-check-depth.ts`, README.md's "Latency"
section) to all three engines rather than inventing a new methodology —
same depths (1, 3, 5, 10 by default), same percentile definition
(`sort`-then-index), same "distinct chain per measurement, not one
repeated query" discipline carried one step further (see next
paragraph).

One deliberate improvement over the original script, needed specifically
because this is now a three-way comparison: `scripts/
benchmark-check-depth.ts` repeats the **identical** check `RUNS_PER_DEPTH`
times, which is a fair way to measure this repo's own engine (whose check
path has no cache by default) but would silently favor SpiceDB, whose
dispatch cache is **on** by default (`--dispatch-cache-enabled` defaults
to `true`) — the second and every subsequent identical check would be a
cache hit, not a graph walk. This harness's depth-chain workload
generates `runsPerDepth` **independent, freshly-written chains per
depth** (unique object ids, seeded and reproducible —
`src/workload.ts`'s `depthChainWorkload`), so every measured check is a
genuine cold graph walk on all three engines. SpiceDB's dispatch cache is
also explicitly disabled at the process level
(`--dispatch-cache-enabled=false --dispatch-cluster-cache-enabled=false`)
for the same reason, stated openly rather than left as a silent
methodology choice — see "What's fair to compare."

**Metric 2 — time-to-first-consistent-read after a write, at each
engine's own default consistency setting.** Write one fresh grant, then
poll (5ms interval, 8s timeout) using the engine's default — not
strongest — consistency mode, timing how long until the check reflects
the write. This is the one metric this harness deliberately does **not**
try to make "fair" by normalizing consistency settings away, because the
defaults themselves are the finding: this repo's own engine and OpenFGA
both resolved every trial on its very first poll, sub-5ms after the write
(both default to always-current reads with no cache — no staleness
window to observe), while SpiceDB showed a real, wide spread — sub-2ms in
some trials, 900ms–5000ms in others — consistent
with its documented revision-quantization design
(`--datastore-revision-quantization-interval`, default 5s). See "Real
results" for the actual numbers and every caveat on what a single-process
in-memory datastore can and can't tell you about this in production.

**Deliberately not implemented, even as a stretch goal:** fixed-QPS
sustained-concurrency load testing, multi-node dispatch behavior, and
cold-start/warm-cache steady-state separation. Each would need either
load-generation infrastructure this sandbox's own resource limits make
unreliable to interpret (a shared 4-vCPU sandbox has no load isolation
between the three engines' processes and this harness's own Node
process), or a multi-node topology this sandbox cannot stand up at all.
Reporting a number from either without that infrastructure would be
worse than not reporting one — see "Revisit if."

## The workload, in all three schema languages

The workload is this repo's own real demo graph — `schema/example.authz`,
populated exactly as `scripts/seed-example.ts` populates it (org/group/
folder/document, nested group membership two levels deep, and every
narrated case that file's own doc comment names — README.md and
`docs/RELATIONS.md` document the same graph by name) — translated by
hand into OpenFGA's and SpiceDB's own schema languages, plus one small
purpose-built `bench_node` type (a controlled tuple-to-userset chain)
used only for the depth-scaling latency benchmark.

This repo's own DSL (`schema/example.authz`, unmodified, read directly —
never copied):

```
namespace org {
  relation member: user | group#member
  relation banned: user
  permission view = member - banned
}
namespace group {
  relation member: user | group#member
  permission view = member
}
namespace folder {
  relation parent: folder
  relation owner: user
  relation editor: user | group#member
  relation viewer: user | group#member
  relation sensitive_reviewer: user | group#member
  permission edit = editor | owner | parent->edit
  permission view = viewer | edit | parent->view
  permission sensitive_review = (viewer | edit) & sensitive_reviewer
}
namespace document {
  relation parent: folder
  relation owner: user
  relation editor: user | group#member
  relation viewer: user | group#member
  permission edit = editor | owner | parent->edit
  permission view = viewer | edit | parent->view
}
```

OpenFGA's translation (`tools/rebac-benchmark/workloads/openfga-example.fga`,
the actually-loaded model is `openfga-combined.fga`, which is this file's
content plus the depth-chain type — see that file's own doc comment for
why combined):

```
model
  schema 1.1

type user
type group
  relations
    define member: [user, group#member]
type org
  relations
    define member: [user, group#member]
    define banned: [user]
    define view: member but not banned
type folder
  relations
    define parent: [folder]
    define owner: [user]
    define editor: [user, group#member]
    define viewer: [user, group#member]
    define sensitive_reviewer: [user, group#member]
    define edit: editor or owner or edit from parent
    define view: viewer or edit or view from parent
    define sensitive_review: (viewer or edit) and sensitive_reviewer
type document
  relations
    define parent: [folder]
    define owner: [user]
    define editor: [user, group#member]
    define viewer: [user, group#member]
    define edit: editor or owner or edit from parent
    define view: viewer or edit or view from parent
```

SpiceDB's translation (`tools/rebac-benchmark/workloads/spicedb-example.zed`,
the actually-loaded schema is `spicedb-combined.zed` for the same
one-schema-per-process reason covered in "What's fair to compare"):

```
definition user {}
definition group {
  relation member: user | group#member
}
definition org {
  relation member: user | group#member
  relation banned: user
  permission view = member - banned
}
definition folder {
  relation parent: folder
  relation owner: user
  relation editor: user | group#member
  relation viewer: user | group#member
  relation sensitive_reviewer: user | group#member
  permission edit = editor + owner + parent->edit
  permission view = viewer + edit + parent->view
  permission sensitive_review = (viewer + edit) & sensitive_reviewer
}
definition document {
  relation parent: folder
  relation owner: user
  relation editor: user | group#member
  relation viewer: user | group#member
  permission edit = editor + owner + parent->edit
  permission view = viewer + edit + parent->view
}
```

Every rewrite-rule kind in the original translates with **zero loss of
meaning** across all three:

| Original DSL                                                           | OpenFGA                                      | SpiceDB                                            | Confirmed identical behavior?                                  |
| ---------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------- |
| `\|` (union)                                                           | `or`                                         | `+`                                                | Yes — all 8 cross-validation checks agree across all 3 engines |
| `-` (exclusion)                                                        | `but not`                                    | `-`                                                | Yes — `org.view = member - banned`, mallory case               |
| `&` (intersection)                                                     | `and`                                        | `&`                                                | Yes — `sensitive_review`, carol/erin cases                     |
| `->` (tuple-to-userset)                                                | `<perm> from <rel>` (reversed reading order) | `->` (identical reading order to the original DSL) | Yes — `parent->edit`/`parent->view` cases                      |
| nested userset-typed subject (`group#member` as a tuple's own subject) | `[user, group#member]` type restriction      | `user \| group#member` (near-verbatim)             | Yes — dana's two-level nesting case                            |

The eight canonical checks cross-validated against all three engines
(`src/workload.ts`'s `exampleGraphWorkload`, mirroring the exact cases
README.md and `docs/RELATIONS.md` already narrate by name):

| #   | Check                                             | Expected | Why it's in the set                                                    |
| --- | ------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| 1   | `user:dana edit document:eng_handbook`            | ALLOWED  | 5-hop path, two-level group nesting — this repo's own headline example |
| 2   | `user:alice edit document:eng_handbook`           | ALLOWED  | 3-hop path, direct group membership — contrast case                    |
| 3   | `user:mallory view org:acme`                      | DENIED   | exclusion (`member - banned`)                                          |
| 4   | `user:carol sensitive_review folder:finance_docs` | ALLOWED  | intersection, positive case                                            |
| 5   | `user:erin sensitive_review folder:finance_docs`  | DENIED   | intersection, negative case                                            |
| 6   | `user:bob view document:roadmap`                  | ALLOWED  | depth 0 — direct grant only, no inheritance                            |
| 7   | `user:dana edit document:eng_backend_runbook`     | ALLOWED  | compounds 2 group-nesting hops with 2 folder-inheritance hops          |
| 8   | `user:mallory edit document:eng_handbook`         | DENIED   | negative control on the union side (no path at all, not just excluded) |

## Schema translation notes: real gaps found by actually running this

Two genuine, confirmed-live expressiveness/behavior differences surfaced
while building this harness — both disclosed here rather than quietly
worked around, matching `docs/FINDINGS.md`'s own discipline of reporting
what a translation can't do, not just what it can:

1. **OpenFGA rejects a userset-typed tupleset relation.** The
   depth-scaling benchmark's first design reused one relation
   (`member: bench_node#member`) both as a nested-userset subject _and_
   as the tupleset half of a tuple-to-userset rewrite
   (`member->view`) — exactly the shape
   `scripts/benchmark-check-depth.ts` already uses against this repo's
   own engine. OpenFGA's model validator rejected it outright: `the
relation type 'bench_node#member' on 'member' in object type
'bench_node' is not valid`. Confirmed live, not assumed from
   documentation. OpenFGA requires the left side of `X from Y` to carry
   only plain-object subject types, never a userset. The fix: the
   depth-chain benchmark uses a **plain tuple-to-userset chain**
   (`parent: bench_node`, the same shape as `folder.parent->edit` in the
   main demo schema) instead of a nested-membership chain, identically
   across all three engines — so the comparison stays apples-to-apples,
   at the cost of the depth-scaling benchmark specifically no longer
   exercising the nested-userset-subject shape (that shape is still
   fully exercised and cross-validated by the 8-check example-graph
   workload above, just not combined with the depth-scaling measurement
   in the same artifact). See `tools/rebac-benchmark/workloads/
openfga-depth-chain.fga`'s own doc comment for the full account.
2. **SpiceDB (OSS) has no per-run tenant isolation.** Covered under
   "What's fair to compare" above — a `WriteSchema` that drops a live
   definition is rejected, and a `CREATE` relationship-write against an
   existing one is rejected too. Both are real SpiceDB behaviors a
   production deployment would also have to design around, not artifacts
   of this harness.

Neither gap changes any of the eight cross-validation checks' expected
answers — all eight agree across all three engines (see "Real results").

## Harness architecture

```
tools/rebac-benchmark/
  workloads/           the schema translations above (.authz reference is
                        the real schema/example.authz; .fga/.zed here)
  src/
    types.ts           CanonicalTuple / CanonicalCheckQuery / EngineAdapter —
                        the one shape every adapter speaks; the workload
                        generator never imports an engine-specific type
    prng.ts            seeded PRNG (mulberry32) — the only randomness used,
                        and every call site takes an explicit seed
    workload.ts         the identical logical operation sequence: the demo
                        graph + 8 checks, and the seeded depth-chain generator
    stats.ts           percentile/summary helpers (matches
                        scripts/benchmark-check-depth.ts's own definition)
    report.ts          markdown table formatting
    adapters/
      authz-adapter.ts    real HTTP calls to `authz serve`
      openfga-adapter.ts  real HTTP calls via the official @openfga/sdk
      spicedb-adapter.ts  real gRPC calls via the official @authzed/authzed-node
    runner.ts           orchestrator/CLI: init → loadSchema → cross-validate
                        → depth-latency benchmark → consistency probe →
                        write raw JSON + print markdown
  results/              raw JSON from every run this harness has produced
```

Each adapter implements the identical `EngineAdapter` interface
(`init`/`loadSchema`/`writeTuple`/`check`/`close`) and is the **only**
place that engine's own wire format appears — the workload generator
(`workload.ts`) has zero engine-specific knowledge, so "identical
workload" is a property the code enforces, not a claim about it.
Transport choice per engine, and why:

- **authz** — plain `fetch` against `POST /schema/publish`, `/tuples`,
  `/check` (this repo's own documented HTTP API).
- **OpenFGA** — the official `@openfga/sdk` (`OpenFgaClient`, real HTTP)
  plus `@openfga/syntax-transformer` to compile the checked-in `.fga` DSL
  text into the JSON shape the API accepts — the same two-step flow
  OpenFGA's own CLI/playground tooling uses; neither the DSL grammar nor
  the transform is reimplemented here.
- **SpiceDB** — the official `@authzed/authzed-node` (real gRPC via
  Node's grpc-js). SpiceDB's OSS gRPC API has no bundled REST/JSON
  equivalent reachable with a plain `fetch` the way the other two
  adapters work; its `--http-enabled` gateway fronts the identical gRPC
  service, so using it would add a translation hop the other two
  adapters don't pay, not remove one.

## Environment this run's numbers came from

Disclosed in full, per the "hardware/environment disclosed" bar below —
this is a **shared, unisolated sandbox**, not dedicated benchmark
hardware, and every number in this document should be read with that
in mind:

|                               |                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Date                          | 2026-08-29                                                                                                                  |
| OS                            | Ubuntu 24.04.4 LTS, kernel 6.18.44                                                                                          |
| CPU                           | Intel(R) Xeon(R) Processor @ 2.80GHz, 4 vCPUs (shared, unisolated)                                                          |
| Memory                        | 15 GiB total                                                                                                                |
| Node.js                       | v22.22.2                                                                                                                    |
| Go                            | go1.24.7 linux/amd64                                                                                                        |
| Postgres (authz only)         | 16.13 (Ubuntu), local, native package — not Docker                                                                          |
| OpenFGA                       | v1.19.0, `go install ...@latest`, `--datastore-engine memory`                                                               |
| SpiceDB                       | v1.56.1, `go install ...@latest`, `--datastore-engine memory`, dispatch caches disabled                                     |
| `@openfga/sdk`                | 0.9.7                                                                                                                       |
| `@openfga/syntax-transformer` | 0.2.2                                                                                                                       |
| `@authzed/authzed-node`       | 1.6.1                                                                                                                       |
| All three engines             | single process each, same machine, same 4-vCPU pool as this harness's own Node process — **no load isolation between them** |

## Real results

Every number below came from a real run against a real, live instance —
raw JSON for every run is in `tools/rebac-benchmark/results/`. The tables
below come specifically from `results/1788027125006-openfga_spicedb.json`
(OpenFGA + SpiceDB, `--depths 1,3,5,10 --runs-per-depth 3
--consistency-trials 3 --seed 42`) and `results/1788027294770-authz.json`
(authz, identical arguments, run separately only because of the real
rate-limit backoff covered above — same seed, so its depth-chain tuples
are byte-identical in shape to the other two engines' runs). Two earlier,
smaller smoke-test files (`1788026868323-openfga.json`,
`1788026915006-spicedb.json`) are also real data, kept as-is rather than
deleted, from before the harness's final depths/runs-per-depth were
settled. Reproduce any of it with the exact commands in
`tools/rebac-benchmark/README.md`.

**Cross-validation — all three engines agree on all 8 canonical checks,
against their own translated schema:**

| Engine  | Checks agreeing with expected |
| ------- | ----------------------------- |
| authz   | 8 / 8                         |
| openfga | 8 / 8                         |
| spicedb | 8 / 8                         |

**Depth-latency (sequential, 3 independent cold chains per depth,
`--depths 1,3,5,10 --runs-per-depth 3 --seed 42`):**

| Engine  | Depth | n   | p50     | p95     | p99     | max     |
| ------- | ----- | --- | ------- | ------- | ------- | ------- |
| openfga | 1     | 3   | 2.12ms  | 2.17ms  | 2.17ms  | 2.17ms  |
| openfga | 3     | 3   | 2.20ms  | 2.76ms  | 2.76ms  | 2.76ms  |
| openfga | 5     | 3   | 2.23ms  | 2.38ms  | 2.38ms  | 2.38ms  |
| openfga | 10    | 3   | 2.51ms  | 2.69ms  | 2.69ms  | 2.69ms  |
| spicedb | 1     | 3   | 1.46ms  | 1.58ms  | 1.58ms  | 1.58ms  |
| spicedb | 3     | 3   | 1.86ms  | 1.92ms  | 1.92ms  | 1.92ms  |
| spicedb | 5     | 3   | 2.06ms  | 2.29ms  | 2.29ms  | 2.29ms  |
| spicedb | 10    | 3   | 3.31ms  | 4.04ms  | 4.04ms  | 4.04ms  |
| authz   | 1     | 3   | 8.04ms  | 9.48ms  | 9.48ms  | 9.48ms  |
| authz   | 3     | 3   | 11.32ms | 18.94ms | 18.94ms | 18.94ms |
| authz   | 5     | 3   | 13.30ms | 14.09ms | 14.09ms | 14.09ms |
| authz   | 10    | 3   | 19.62ms | 22.66ms | 22.66ms | 22.66ms |

**n = 3 per depth is intentionally small** — enough to prove the harness
works end-to-end against real, live instances of all three engines with
real, non-fabricated numbers, not enough to treat these percentiles as
stable. See "What would make this citable" for what a larger `n` would
need.

**authz was measurably slower on this metric in this one run — read that
plainly, with its actual cause, not as a verdict.** Two real, disclosed
factors both push in the same direction and neither is "the engine is
slow": (1) authz's check path does a real HTTP round trip _and_ a real
Postgres round trip per check (`performCheck`'s own recursive SQL, no
cache by default — see README.md's "Latency" section, whose own
in-process numbers at the same depths are 4.9ms–17.4ms **p50**, i.e.
most of authz's HTTP-adapter cost above is Postgres-and-recursion cost
this repo's own README already discloses, not added by this harness);
OpenFGA and SpiceDB's in-memory datastores have no comparable per-check
storage round trip to a separate process. (2) All three engines and this
harness's own Node process shared one 4-vCPU sandbox with zero isolation
— a slower measurement immediately after 60+ seconds of a different
process (the rate-limit backoff sleep, then a burst of queued writes) is
exactly the kind of dev-machine noise "What would make this citable"
calls out as unresolved. Neither factor is invalidated by the other two
engines' numbers being smaller; a same-process, no-network,
Postgres-in-the-loop comparison was not attempted here and would be
needed before "authz's checks are slower" could be stated as anything
more than this one run's own observation.

**Consistency probe (write, then poll at each engine's own default
consistency setting; 3 trials, 5ms poll interval, 8s timeout):**

| Engine  | Trial 1 | Trial 2 | Trial 3  |
| ------- | ------- | ------- | -------- |
| openfga | 1.5ms   | 1.4ms   | 1.2ms    |
| spicedb | 901.3ms | 1.1ms   | 4996.0ms |
| authz   | 4.8ms   | 4.2ms   | 4.5ms    |

This is the clearest, most citable real finding this first run produced:
**OpenFGA's default consistency setting behaved indistinguishably from
"always current" in every trial** (sub-2ms, matching its check-query
cache being off by default) — **SpiceDB's default setting did not**,
swinging from sub-2ms to nearly 5 full seconds depending on where in its
5-second revision-quantization window the write landed. Both behaviors
are the documented, intended design of each engine — this is not a bug
in either — but a caller who assumes "I wrote it, so a check right after
will see it" gets a materially different real-world guarantee from
SpiceDB's default than from OpenFGA's or this repo's own default. A
caller who needs read-your-writes from SpiceDB has to ask for it
explicitly (`fullyConsistent`, at whatever latency cost that carries —
not measured separately in this run, see "Revisit if"). authz's own
3 trials (4.8ms, 4.2ms, 4.5ms) land a few milliseconds above OpenFGA's —
consistent with the same real, disclosed cost named in the depth-latency
table just above (a real HTTP-plus-Postgres round trip per check, not a
cache), not with any staleness: every authz trial still resolved on its
very first poll, the same "always current by construction" behavior
OpenFGA showed.

## Rerun, 2026-08-29: larger `n`, pinned exact versions

A later session re-ran this harness, closing two of the gaps the table
below itself named as open: `go install ...@latest`'s floating versions
were pinned to the exact same versions the first run happened to resolve
(`openfga@v1.19.0`, `spicedb@v1.56.1` — confirmed identical, not merely
similar, via `go install`'s own `go: downloading github.com/openfga/openfga
v1.19.0`-style resolution log), and `--runs-per-depth` was raised from 3 to
**50** for OpenFGA and SpiceDB, matching `scripts/benchmark-check-depth.ts`'s
own `n=50` precedent this document's own citability table names as the
target.

**authz's own `n` deliberately stayed at 10, not 50 — a disclosed
asymmetry, not an oversight or a shortcut.** `POST /tuples`'s 20/minute
rate limit (no override, see above) means the tuples a full 50-run sweep
across depths 1/3/5/10 needs (≈1,150 individual writes) would cost the
better part of an hour of real backoff sleep; the 10-run sweep run here
already needed ~13 real minutes of rate-limited writing (confirmed live:
11 separate `429 rate_limited` backoff waits before the write, timestamped
in the harness's own console output). OpenFGA and SpiceDB have no
equivalent limit, so their own reruns cost seconds, not minutes — this is
a genuine, disclosed property of the system being measured, not a
benchmark artifact to paper over.

**Environment** — same sandbox, same day, only the versions below changed
from the table above:

|         |                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go      | go1.26.7 linux/amd64 (auto-selected by `go install`'s own toolchain resolution for `openfga@v1.19.0`'s stated `go >= 1.25.7` requirement — the first run's go1.24.7 predates this and was never re-tested against it)                                                                                                                                                                             |
| OpenFGA | v1.19.0, pinned explicitly (`go install .../openfga@v1.19.0`), `--datastore-engine memory` — its own `openfga version` reports `dev`/`unknown` regardless of the pinned tag (a known quirk of a plain `go install`, which carries no release-time `ldflags`-embedded version string); the pinned version is the one `go`'s own module resolution log actually fetched, not a self-reported string |
| SpiceDB | v1.56.1, pinned explicitly (`go install .../spicedb@v1.56.1`), `--datastore-engine memory`, dispatch caches disabled — `spicedb version` correctly self-reports `v1.56.1`                                                                                                                                                                                                                         |

**Cross-validation — unchanged, all three engines still agree on all 8
canonical checks** against their own translated schema (authz, openfga,
spicedb: 8/8 each) — the identical result as the first run, now at a
larger `n`.

**Depth-latency (`--depths 1,3,5,10 --seed 42`, `--runs-per-depth 50` for
openfga/spicedb, `--runs-per-depth 10` for authz — see the asymmetry
disclosed above):**

| Engine  | Depth | n   | p50     | p95     | p99     | max     |
| ------- | ----- | --- | ------- | ------- | ------- | ------- |
| openfga | 1     | 50  | 1.70ms  | 2.46ms  | 2.96ms  | 2.96ms  |
| openfga | 3     | 50  | 1.68ms  | 2.45ms  | 2.97ms  | 2.97ms  |
| openfga | 5     | 50  | 1.91ms  | 2.58ms  | 4.21ms  | 4.21ms  |
| openfga | 10    | 50  | 2.40ms  | 3.47ms  | 5.63ms  | 5.63ms  |
| spicedb | 1     | 50  | 1.30ms  | 1.49ms  | 1.63ms  | 1.63ms  |
| spicedb | 3     | 50  | 1.62ms  | 1.92ms  | 4.37ms  | 4.37ms  |
| spicedb | 5     | 50  | 2.00ms  | 2.32ms  | 8.02ms  | 8.02ms  |
| spicedb | 10    | 50  | 3.76ms  | 4.84ms  | 6.07ms  | 6.07ms  |
| authz   | 1     | 10  | 7.77ms  | 9.30ms  | 9.30ms  | 9.30ms  |
| authz   | 3     | 10  | 11.26ms | 14.49ms | 14.49ms | 14.49ms |
| authz   | 5     | 10  | 15.26ms | 24.81ms | 24.81ms | 24.81ms |
| authz   | 10    | 10  | 18.41ms | 33.03ms | 33.03ms | 33.03ms |

Same qualitative shape as the first run: OpenFGA/SpiceDB check latency
stays in the low single-digit milliseconds across depth (in-memory
datastore, no separate storage round trip); authz's own HTTP-plus-Postgres
round trip costs more, growing with depth exactly as README.md's own
in-process `performCheck` numbers already predict — this is the identical,
already-disclosed factor from the first run's own analysis (see above),
not a new finding.

**Consistency probe — the larger `n=10` trial count for OpenFGA/SpiceDB
makes the same finding sharper, not different:**

| Engine  | Trials (ms)                                                            |
| ------- | ---------------------------------------------------------------------- |
| openfga | 1.2, 1.1, 1.3, 1.2, 2.3, 1.5, 1.2, 1.3, 1.3, 1.2                       |
| spicedb | 3168.5, 1.2, 4994.2, 1.2, 4995.1, 1.3, 4995.4, 1.0, 5001.7, 1.0        |
| authz   | 4.8, 4.4, 4.7, 4.6, 4.1 (5 trials — see the asymmetry disclosed above) |

SpiceDB's own alternating pattern — roughly every other trial landing at
~5 seconds, the rest sub-2ms — is now visible across 10 trials instead of
3, and matches its own documented revision-quantization window exactly:
whether a given write happens to land just before or just after that
window's own boundary determines which side of the ~5-second gap that
trial falls on. OpenFGA stayed uniformly sub-3ms across all 10 trials;
authz stayed uniformly sub-5ms across all 5, both consistent with
"resolves on the first poll, every time" — the same real distinction the
first run's smaller sample already found, now with more evidence behind
it.

Raw JSON for both reruns: `tools/rebac-benchmark/results/1788033420009-openfga_spicedb.json`,
`tools/rebac-benchmark/results/1788034161801-authz.json`.

## What would make this citable outside this project

Explicit, so a reader can see exactly what's done versus what's still a
rough draft:

| Bar                                                    | Status here                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Methodology published                                  | **Done** — this document                                                                                                                                                                                                                                                                                                                                                          |
| Workload generation seeded/reproducible                | **Done** — `src/workload.ts`'s `depthChainWorkload(seed, depths, runsPerDepth)`; same seed always produces byte-identical tuples/checks                                                                                                                                                                                                                                           |
| Hardware/environment disclosed                         | **Done** — see table above                                                                                                                                                                                                                                                                                                                                                        |
| Raw data available, not just a summary                 | **Done** — `tools/rebac-benchmark/results/*.json`, one file per run, every individual latency sample                                                                                                                                                                                                                                                                              |
| Exact engine versions pinned                           | **Done, as of the 2026-08-29 rerun** — `go install .../openfga@v1.19.0`, `go install .../spicedb@v1.56.1`, explicit, not `@latest`; see "Rerun" above                                                                                                                                                                                                                             |
| Sample size large enough for stable percentiles        | **Partially done, as of the 2026-08-29 rerun** — OpenFGA/SpiceDB now at `n=50`, matching `scripts/benchmark-check-depth.ts`'s own precedent exactly; authz stayed at `n=10` (up from 3, but not 50) because of its own real, disclosed rate-limit cost — see "Rerun" above for why that asymmetry is a finding, not a shortcut                                                    |
| Dedicated, isolated hardware (no shared sandbox noise) | **Not done** — this ran on a shared 4-vCPU sandbox with all three engines and the harness itself contending for the same cores                                                                                                                                                                                                                                                    |
| Concurrent/sustained-load behavior                     | **Not done** — sequential checks only; see "Revisit if"                                                                                                                                                                                                                                                                                                                           |
| Independent review of the schema translations          | **Not done** — translated and cross-validated by the same effort that designed the benchmark; an independent reviewer re-deriving the same three schemas from the same source and confirming byte-for-byte (or behaviorally-equivalent) agreement would close this the way `docs/FINDINGS.md`'s own third-party survey was self-validated against the real engine, never asserted |
| Multiple independent runs / variance reported          | **Not done** — one run per engine reported here; a citable version reports mean/stddev (or a full distribution) across, say, 10 independent runs                                                                                                                                                                                                                                  |

## Revisit if / future work

- **A dedicated, unshared benchmark host becomes available.** Rerun with
  `n=50`+ per depth (matching this repo's own established precedent) and
  report variance across multiple independent runs, not a single sample.
- **Fixed-QPS, sustained-concurrency load testing is worth the
  infrastructure cost.** This needs either a load generator with real
  resource isolation from the engines under test, or accepting and
  clearly labeling shared-sandbox noise as a confound — the second option
  was rejected for this pass because a mislabeled load-test number is
  worse than no load-test number.
- **A multi-node topology is available to test against.** SpiceDB and
  OpenFGA's dispatch/clustering behavior, and this repo's own engine
  under real concurrent Postgres load, are all out of reach of a
  single-process comparison and were not attempted here.
- **SpiceDB's `fullyConsistent` latency cost, isolated from its default
  path.** This run measured `fullyConsistent` only for the correctness/
  depth-latency benchmarks and default-consistency only for the
  probe — a fuller version would report both consistency modes' latency
  for SpiceDB side by side, quantifying the cost of asking for the
  stronger guarantee explicitly.
- **An independent second implementer reproduces the schema
  translations from `schema/example.authz` alone**, without reading this
  harness's own `.fga`/`.zed` files first, and the two are diffed for
  disagreement — the single most concrete way to raise this past
  "self-validated" into "independently reviewed," mirroring exactly what
  `docs/FINDINGS.md`'s own methodology note asks of its third-party
  schema survey.
- **This project's own `POST /tuples` rate limit gains a documented,
  intentional override for controlled benchmark/load-test use** (out of
  this task's scope to add — it touches `src/api/server.ts`, outside
  this change's permitted files) — without one, any future write-heavy
  comparison against this repo's own HTTP API will keep needing the same
  multi-minute backoff this run needed.
