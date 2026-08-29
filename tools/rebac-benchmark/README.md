# ReBAC benchmark

A neutral check-latency and write-consistency benchmark comparing this
repo's own `authz` service against real, live instances of
[OpenFGA](https://openfga.dev/) and [SpiceDB](https://authzed.com/spicedb)
on an identical, seeded workload. The methodology, what's fair to
compare, and every real result this harness has produced live in
**[`docs/BENCHMARK-PROPOSAL.md`](../../docs/BENCHMARK-PROPOSAL.md)** —
read that first. This file is the practical "how to actually run it"
companion.

Every adapter talks to a real, separately-running instance of its engine
over that engine's own real network API (HTTP for authz/OpenFGA, gRPC for
SpiceDB) — nothing here calls into any engine's code in-process, and
nothing here is simulated or estimated.

## Prerequisites

- **This repo's own `authz` service**: a reachable Postgres 16+
  (`DATABASE_URL`) — see the root `README.md`'s "Try it yourself" section.
  No Docker required; a native `postgresql-16` install works identically.
- **OpenFGA and SpiceDB, as native Go binaries** — no Docker needed for
  either. This harness was built and proven against binaries installed
  straight from the Go module proxy:

  ```bash
  export GOBIN=/somewhere/on/PATH   # or leave default ($(go env GOPATH)/bin)
  go install github.com/openfga/openfga/cmd/openfga@latest
  go install github.com/authzed/spicedb/cmd/spicedb@latest
  ```

  `@latest` floats — pin an exact version (`@v1.19.0`, `@v1.56.1`, the
  versions this harness's own published numbers used) for a reproducible
  install. Generic GitHub access is not required for either — only the Go
  module proxy (`proxy.golang.org`), which is reachable even in sandboxes
  that block `github.com`/`api.github.com` directly.
- Node 22+ (matches the root project's own `.nvmrc`).

## Install

```bash
cd tools/rebac-benchmark
npm install
```

This tool has its **own** `package.json`/`node_modules`, separate from
the root project's — it needs `@openfga/sdk`, `@openfga/syntax-transformer`,
and `@authzed/authzed-node`, none of which the root project has any other
reason to depend on. Nothing here touches the root project's own
`node_modules`, `package.json`, or lockfile.

Run the unit tests (no live engine needed — these cover only the
engine-agnostic workload generator and PRNG, e.g. "the same seed always
produces byte-identical output"):

```bash
npm test
```

## Start all three engines

Three separate terminals/processes, all on `localhost`, all in-memory
except authz's real Postgres:

```bash
# 1. authz — from the repo root
export DATABASE_URL="postgres://user:password@localhost:5432/authz_service"
export ADMIN_API_KEY="<any string >= 32 chars>"
export PORT=3001
npx tsx src/cli/index.ts serve

# 2. OpenFGA — in-memory datastore, no Postgres needed
openfga run --datastore-engine memory --http-addr 0.0.0.0:8080 --grpc-addr 0.0.0.0:8081

# 3. SpiceDB — in-memory datastore, dispatch caches disabled for a fair
#    cold-check comparison (see docs/BENCHMARK-PROPOSAL.md's "Metric 1")
spicedb serve --grpc-preshared-key "benchmark-psk" \
  --grpc-addr 0.0.0.0:50051 --http-enabled --http-addr 0.0.0.0:8443 \
  --datastore-engine memory \
  --dispatch-cache-enabled=false --dispatch-cluster-cache-enabled=false
```

Confirm each is actually up before running the benchmark:

```bash
curl http://localhost:3001/health      # authz
curl http://localhost:8080/healthz     # OpenFGA
# SpiceDB has no plain-HTTP healthcheck this harness relies on — a
# successful `npm run bench:spicedb` below is the real confirmation.
```

## Run it

```bash
npm run bench:authz      # authz only
npm run bench:openfga    # OpenFGA only
npm run bench:spicedb    # SpiceDB only
npm run bench:all        # all three, one after another, one combined table at the end

# or directly, with explicit flags:
npx tsx src/runner.ts --engine authz,openfga,spicedb \
  --depths 1,3,5,10 --runs-per-depth 3 --seed 42 --consistency-trials 3
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--engine` | `authz,openfga,spicedb` | comma-separated list |
| `--depths` | `1,3,5,10` | permission-chain depths for the latency benchmark |
| `--runs-per-depth` | `30` | independent, freshly-written chains measured per depth (see below for why not one repeated query) |
| `--seed` | `42` | seeds the depth-chain generator — same seed ⇒ byte-identical tuples/checks, any engine, any host |
| `--consistency-trials` | `5` | write-then-poll trials for the consistency probe |

Connection details default to the ports above; override with
`AUTHZ_BASE_URL`/`AUTHZ_ADMIN_API_KEY`, `OPENFGA_API_URL`,
`SPICEDB_ENDPOINT`/`SPICEDB_PSK` if you started an engine elsewhere.

**A real constraint worth knowing before you run this against authz:**
`POST /tuples` is rate-limited to 20 requests/minute by this project's own
default (`src/api/server.ts`, no override) — even the 22-tuple demo graph
alone exceeds it. The authz adapter (`src/adapters/authz-adapter.ts`)
retries automatically on `429` using the real `x-ratelimit-reset` header,
so a full run against authz **completes correctly but takes several real
minutes** of rate-limit backoff. `--engine openfga,spicedb` runs in a
couple of seconds; add `authz` when you have the time, or run it alone in
the background. See `docs/BENCHMARK-PROPOSAL.md`'s "What's fair to
compare" for why this is disclosed as a finding, not silently worked
around by, say, calling the CLI instead of the HTTP API for writes.

**A real constraint worth knowing before you re-run this against a
long-lived SpiceDB process:** SpiceDB OSS has no per-run tenant/store
isolation — this benchmark's schema and tuples land in the one, global
schema/datastore that process owns for as long as it runs. The adapter
(`src/adapters/spicedb-adapter.ts`) uses `TOUCH` (idempotent upsert), not
`CREATE`, specifically so re-running the harness against a SpiceDB
process you didn't just start doesn't fail with `ALREADY_EXISTS`. A
schema that would **drop** a definition still in use (which this
harness's schema never does across repeat runs) is rejected outright by
SpiceDB itself, confirmed live — see the design doc for the exact error.
OpenFGA needs no equivalent care (`init()` creates a fresh store per
run); authz needs none either (`writeTuple`'s own `on conflict ... do
nothing`, already idempotent by design).

## What each run actually does

1. `init()` — a fresh, isolated store (OpenFGA) / namespace publish
   (authz) / schema write (SpiceDB) for this run.
2. `loadSchema()` — the translated `schema/example.authz` demo graph plus
   the `bench_node` depth-chain type (`workloads/`).
3. **Cross-validation**: write the real demo graph
   (`scripts/seed-example.ts`'s own tuple set, translated), then run 8
   canonical checks and print whether each engine's answer matches the
   expected ALLOWED/DENIED this repo's README already documents for that
   exact graph.
4. **Depth-latency benchmark**: `--runs-per-depth` independent, freshly
   written chains per requested depth, each checked once, latency
   recorded — never one query repeated (see
   `src/workload.ts`'s own doc comment: SpiceDB's dispatch cache being on
   by default would otherwise make "check latency" mean "cache-hit
   latency" after the first call).
5. **Consistency probe**: write one fresh grant, then poll at the
   engine's own DEFAULT (not strongest) consistency setting until the
   check reflects it, timing how long that takes.

Every run prints markdown tables to stdout and writes the complete raw
data (every individual latency sample, not just percentiles) to
`results/<timestamp>-<engines>.json`.

## Reproducing this harness's own published numbers exactly

```bash
npx tsx src/runner.ts --engine openfga,spicedb --depths 1,3,5,10 --runs-per-depth 3 --consistency-trials 3 --seed 42
# and, separately (real rate-limit backoff, several minutes):
npx tsx src/runner.ts --engine authz --depths 1,3,5,10 --runs-per-depth 3 --consistency-trials 3 --seed 42
```

These are the exact commands and seed `docs/BENCHMARK-PROPOSAL.md`'s
tables came from. A rerun will not reproduce the exact latency numbers
(that depends on the host machine, load, and whichever OpenFGA/SpiceDB
version `go install ...@latest` resolves to on the day you run it — see
the design doc's own disclosure on that) but will reproduce the identical
tuples/checks byte-for-byte, and should reproduce the same
ALLOWED/DENIED verdict on all 8 cross-validation checks and the same
qualitative consistency-probe pattern (OpenFGA/authz near-zero, SpiceDB
occasionally near its quantization window).

## Layout

```
workloads/
  openfga-example.fga        OpenFGA translation of schema/example.authz (reference copy)
  openfga-depth-chain.fga    OpenFGA depth-chain type (reference copy)
  openfga-combined.fga       both of the above, as one model — what's actually loaded
  spicedb-example.zed        SpiceDB translation of schema/example.authz (reference copy)
  spicedb-depth-chain.zed    SpiceDB depth-chain type (reference copy)
  spicedb-combined.zed       both of the above, as one schema — what's actually loaded
                             (SpiceDB has no per-run tenant isolation to split these by — see above)
src/
  types.ts        CanonicalTuple / CanonicalCheckQuery / EngineAdapter
  prng.ts         seeded PRNG (mulberry32) — the only randomness this tool uses
  workload.ts     the identical logical operation sequence every adapter replays
  stats.ts        percentile/summary helpers
  report.ts       markdown table formatting
  adapters/       one file per engine — the only place each engine's wire format appears
  runner.ts       orchestrator/CLI entry point
test/             unit tests for the engine-agnostic pieces only (workload.ts, prng.ts) —
                  nothing here needs a live engine; run with `npm test`
results/          raw JSON from every run this harness has produced — not gitignored,
                  kept as real evidence (see docs/BENCHMARK-PROPOSAL.md's "raw data available" bar)
package.json      this tool's own dependencies (@openfga/sdk, @authzed/authzed-node, ...),
                  separate from the root project's — see "Install" above
tsconfig.json, eslint.config.mjs, vitest.config.ts
                  standalone tooling config, same pattern tools/schema-verifier/ established
                  (own doc comments in each file explain every divergence from that precedent)
```

## What this is not

Not a load-testing tool (fixed QPS, sustained concurrency) — sequential
checks only. Not a multi-node/clustering benchmark — every engine ran as
one process in this harness's own testing. Not a verdict on which engine
is "faster" — three numbers from one shared, unisolated sandbox on one
day are a data point, not a ranking. See
`docs/BENCHMARK-PROPOSAL.md`'s "What would make this citable outside this
project" for the explicit gap list between what this is and a benchmark
someone outside this project could cite as authoritative.
