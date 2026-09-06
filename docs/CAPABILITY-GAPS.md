# Capability gaps

This is a capability-gap analysis, not a roadmap commitment: ten ideas from
an internal architecture-review brainstorm about what this repo doesn't do
yet, each one re-checked against the actual current source rather than left
as asserted prose (an eleventh idea — folding this engine into a separate,
external project — is architectural reasoning, not a checkable gap, and gets
its own closing section instead). Six of the ten turned out to already be
partly built, mischaracterized, or resolvable from code rather than
genuinely open — those are flagged up front in their own sections, not
buried after a paragraph that first pretends the gap is clean. Every claim below carries a `file:line`
citation or a live-verification note, in this project's own established
style (`docs/DECISIONS.md`, `docs/FINDINGS.md`); nothing here is restated from
the brainstorm without having been checked. Written against the repo at
commit `85126e8`.

## Core capability gaps

### Public/wildcard subjects

Confirmed absent, and deliberately: grep for wildcard/`user:*` support across
`src/schema/dsl`, `src/store/tuples.ts` and `src/resolve/*/resolver.ts` turns
up nothing real, and D-114 (`docs/DECISIONS.md:1581`) names wildcard subjects
out of scope for the frozen v1 grammar ("no analog anywhere in this
grammar"). It's enforced today, not just undeclared: `subjectId` is validated
against the same `IDENTIFIER_PATTERN` namespaces use
(`src/schema/dsl/types.ts:51`, `src/store/tuples.ts:91-111`), so a literal
`user:*` tuple is rejected outright with `invalid_identifier`. "Any
authenticated user can view this" needs one tuple per user as a result — a
real instance of the "authorization scattered outside the system of record"
pattern. That exact phrase does appear verbatim in the README
(`README.md:393`), but not in its true opening section ("The failure this
exists to stop," starting around line 44), which uses different wording
("scattered across application code..."); the phrase itself lives in the
README's own D-144/"Expiring tuples" section, echoing D-144's coinage
(`docs/DECISIONS.md:2394`) for the structurally similar caveat gap rather
than the reverse. The closed-form citation should point at D-114, not D-144 — D-144's
discipline (`docs/DECISIONS.md:2400`) is scoped to caveats and says nothing
about wildcards; the analogy (a `/check`-time wildcard match is a closed,
decidable lookup, no new fuzz/DST axis) is a reasonable extension of that
reasoning, but reopening D-114 needs its own dated entry, and isn't
grammar-free — relations declare a typed `subjectTypes` list enforced
per-tuple (`compiler.ts:191-222`, `src/store/tuples.ts:210-220`), so a
wildcard type needs a real `SubjectTypeRef` variant, not just a
tuple-write relaxation.

The interactions are the right place to focus, though. `listUsers` is
concrete-subject-only by contract today (`src/audit/list.ts:381-384`, built
by `evaluateExpandNode`'s flatten at `list.ts:510-535`), which would silently
mis-flatten a stored `user:*` into one literal entry unless handled
explicitly; and exclusion subtract branches are exactly where this project's
worst real soundness bugs lived (D-158 through D-161,
`docs/DECISIONS.md:2689-2775`). But be precise about the `certain` flag: it
was built to flag cycle/depth-ceiling _truncation_ inside subtract
(`src/resolve/reference/resolver.ts:385-408`), not open-ended subject
matching — a wildcard only stresses it via a cyclable path to that subject,
not by existing at all. And D-160's metamorphic property
(`src/metamorphic/unprovable-exclusion-fixtures.ts`) deliberately didn't
extend the existing generators for its own two mechanisms (lines 26-45), so
a wildcard-in-subtract case is genuinely new, not-yet-built work in the same
spirit — a third mechanism, not a variant these properties already cover.

### A Watch endpoint

Still a real, wide-open gap, and the foundation for it is unusually solid.
`write_log` (`src/store/migrations/0001_relation_tuples_and_write_log.sql:45-57`)
already stores exactly `(token, operation, tuple, written_at)` per change,
and `token` is genuinely monotonic in commit order, not just allocation
order — `src/store/tuples.ts`'s global `pg_advisory_xact_lock` (lines
293-363) exists specifically because the identity sequence alone let
allocation and commit order diverge under concurrency, a race the project
found and closed live against real Postgres. Today, though, there is no way
to read that log at all: the full route list in `src/api/server.ts` (lines
1174-1654) has no `/watch`, no SSE, no LISTEN/NOTIFY anywhere in the tree,
and not even a plain GET over `write_log` or `relation_tuples` for polling.

The result is exactly the TTL-guessing problem you'd expect, and the
project's own docs already say so: `docs/CONSISTENCY.md` (lines 198-210)
discloses that its in-process check cache (`CHECK_CACHE_TTL_MS`, off by
default, D-135) invalidates immediately only for writes made through the
same process — a write from a different process or replica is invisible to
it until the TTL expires, by design. The clearest proof this is a real,
not hypothetical, prerequisite is internal: the project's own Leopard
materialized index (`docs/LEOPARD-INDEX-PROPOSAL.md`, D-163) rebuilds
against a `write_log` watermark (`src/store/relation-index.ts:108`), and
even though D-167 (`docs/DECISIONS.md:2915`) wired its own in-process
refresh timer up (`startLeopardRefreshLoop`, `src/cli/commands/serve.ts:49,90`
— `docs/LEOPARD-INDEX-PROPOSAL.md` itself is stale on this point, still
saying "never wired up" at its own lines 36/56), that timer only re-triggers
a rebuild on an interval — it's not something an external consumer could
subscribe to, and it's still one more poll loop layered on top of another,
not a push signal. A watch endpoint would replace guessed intervals
everywhere, including this one, with something that reacts to the real
`write_log` token. So the honest scope for it is a bit more than plumbing:
the token/log semantics it would read are already proven, but there's no
push substrate to build on today — no LISTEN/NOTIFY, no SSE anywhere in the
tree — so `GET /watch?since=<token>` over SSE means either an internal
DB-polling loop fanning out to connected clients or adding Postgres NOTIFY
triggers on `write_log` inserts, plus the usual SSE concerns
(reconnect-with-`since`, backpressure, multi-replica fan-out). None of that
is designed yet.

### Bulk writes and import/export — partially addressed

The 20/min `writeRateLimit` on `POST /tuples`
(`src/api/server.ts:1144-1145`, applied at line 1429) is already costing
you: it's the disclosed reason the benchmark ran authz at `n=10` while
OpenFGA and SpiceDB ran at `n=50` —
`docs/BENCHMARK-PROPOSAL.md:613-624` names the 20/min limit explicitly as
the cause (a full n=50 sweep's ≈1,150 writes would cost the better part of
an hour of `429` backoff). A `POST /tuples/batch` mirroring `/check/batch`
(D-152; `src/api/server.ts:1278-1327`) would help — worth reusing its real
mechanism precisely: `/check/batch` runs `MAX_CONCURRENCY`-sized slices in
parallel via `Promise.all` and preserves input order by writing each result
to a pre-computed array index (`runCheckBatch`,
`src/api/server.ts:414-438`), not by processing serially. No such batch
route exists for tuples today — `server.ts` has exactly one `/tuples`
route, and `writeTuple` (`src/store/tuples.ts:398-401`) takes a single
`TupleKey` with no batch variant even at the store layer.

There is also no NDJSON (or any) tuple import/export tooling anywhere in
the repo: `src/cli/commands/tuple.ts` exposes only single-tuple
`tupleWrite`/`tupleDelete`, and the only NDJSON format in the codebase is
the unrelated audit hash-chain anchor file (`src/audit/anchor.ts:65,110`).
Two more places confirm the gap: `scripts/seed-example.ts:146-148` seeds
the entire demo tuple graph through a plain sequential loop calling
`writeTuple` once per tuple — even bypassing the API rate limit entirely by
calling the store function directly, it's still one-at-a-time, so a batch
primitive would speed up fixture seeding independent of any rate-limit fix.
And `docs/DELIVERY.md:14` lists "a tuple store migrated onto your
infrastructure" as a deliverable while scoping out only the semantic
_mapping_ work (lines 54-59: "the mapping... is the product"), not the
mechanical bulk-load step — a batch write path plus NDJSON import/export
would give that migration deliverable a mechanism DELIVERY.md currently
doesn't name at all.

### Reverse lookup that isn't capped in the way it matters — partially addressed

`listObjects` (`src/audit/list.ts:347-370`) enumerates candidates via
`select distinct object_id from relation_tuples where object_ns = $1 order
by object_id asc limit LIST_OBJECTS_MAX_CANDIDATES + 1`
(`src/audit/list.ts:272-287`), then runs a real `productionCheck` per
candidate in concurrency-bounded batches (`src/audit/list.ts:301-331`) —
never `performCheck`, by deliberate design (`src/audit/list.ts:72-100`).
The cap is `LIST_OBJECTS_MAX_CANDIDATES = 1000`
(`src/audit/list.ts:229`), self-described as "a deliberately simple, round
starting point, not derived from a load test," and truncation is surfaced
honestly as `truncated: boolean` (`src/audit/list.ts:249, 284`), threaded
through the HTTP response too (`src/api/responses.ts:277-278`). So the
mechanics are exactly as documented, and the file's own doc comments already
anticipate the objection: at 1000 candidates and `MAX_CONCURRENCY`'s default
of 8, that's 125 sequential batches of full recursive graph walks — fine
for bulk discovery, not for "which of these 50k documents can Alice see" on
every list-view render.

This is a real, open gap: nothing in the repo today gives `listObjects`
sub-linear, subject-keyed lookup. It is not, however, an unconsidered one —
D-135's own "Revisit if" (`docs/DECISIONS.md:2201`) already flags
`listObjects`/`listUsers` as due "the same optimization" someday, though
only in the sense of the existing TTL check-result cache, not a structural
index. The real precedent to build from is the Leopard index (D-163,
`docs/DECISIONS.md:2823-2827`; `src/resolve/production/resolver.ts:727-794`):
its hit/miss discipline is exactly "a miss, for any reason at all, falls
through unconditionally" to the unmodified live resolver, and an index hit
can only `return { allowed: true, certain: true, ... }` — it never
manufactures a DENY. That discipline is real, load-bearing (guarded by a
SAVEPOINT/ROLLBACK-TO-SAVEPOINT pair so even a thrown lookup error can't
poison the check), and would transfer cleanly to a subject-to-object
reverse structure. But check `docs/LEOPARD-INDEX-PROPOSAL.md` before
assuming this is untouched territory: it already reserves the name "Phase
B" for two other, already-scoped extensions — unpinned-check acceleration
and DENY-capable "root completeness" tracking (Candidate D, lines 217-236,
778-790, 1494-1499) — neither of which is a subject-keyed reverse walk. A
`listObjects`-accelerating reverse index is a genuinely new fourth
direction, not something already named and deferred under a different
label; it would need its own soundness write-up alongside the other three
"Revisit if" items already on that document's list.

## Operational

### Metrics — partially addressed

Logging is Fastify's own built-in pino logger, configured from
`env.LOG_LEVEL` (`src/api/server.ts`, `src/config/env.ts:99`) — and nothing
else: no Prometheus endpoint, no OTel (`@opentelemetry/api` appears only as
vitest's unused optional peer dep in `package-lock.json`; grepping `src`
turns up zero Prometheus/OTel references). The full route table
(`src/api/server.ts`, every `app.get`/`app.post`/`app.delete`
registration) is `/check`, `/check/batch`, `/expand`, `/list-objects`,
`/list-users`, `POST /tuples`, `DELETE /tuples`, `/schema/compile`,
`/schema/publish`, `/health`, and `/openapi.json` — no `/metrics` among
them.

The gap isn't uniform, though. Cache hit/miss and Leopard-index
hit-vs-fallback are genuinely nowhere: `CheckCache`
(`src/resolve/production/cache.ts`) exposes `get`/`trySet`/`clear` with no
counter field at all, and `ProductionCheckResult.indexHit`
(`resolver.ts:488`) is computed correctly on every live check but discarded
the instant `performCheck` returns — never written to the `checks` table,
never touched by `src/api`. (`indexQueriesHit` does exist as a real
counter, but only inside the offline soundness fuzz harness,
`src/soundness/runner.ts:350` — it never runs against live traffic.)
Depth-ceiling and cycle-guard hits are better off than that, but still not
actually observable: since D-158/D-159 (`docs/DECISIONS.md`), hitting
either produces a fail-closed `allowed: false, certain: false`
(`resolver.ts:699-715`), and a `certain` column is already persisted per
check row and printed as `DENIED (inconclusive — hit depth/cycle limit...)`
in `authz check --path` (`src/cli/commands/check.ts:196-211`). But that
column is never read by anything live — no logger call fires anywhere near
either guard (grepped `resolver.ts`/`cache.ts`/`checks.ts`, zero hits), the
HTTP API never returns `certain` (absent from `src/api/responses.ts` and
every route), and nothing aggregates the column into a rate.

So the fix here isn't "start computing this" — depth and duration per row,
and now `certain` per row, already exist as data; it's turning what's
already sitting in the `checks` table, plus the two genuinely uncomputed
signals (cache hit rate, indexHit-vs-fallback), into something that alerts
a human before a `certain: false` spike quietly reads as "real users losing
access" only in hindsight, via a manual SQL query.

### A Dockerfile — built, `docs/DECISIONS.md` D-168

**Status: built and shipped.** This section records the gap as it stood
before it was closed — see D-168 for what actually shipped (a multi-stage
`Dockerfile` plus a `docker-compose.yml` `app` service) and for a real,
previously-latent packaging bug (`fast-check` misclassified as a
devDependency) this work found live, not by inspection.

Confirmed: no Dockerfile exists anywhere in the repo (`find . -iname
"Dockerfile*"` returns nothing), and `docker-compose.yml`'s only service is
`postgres` (lines 12-29) — its own header comment scopes it to local dev
only (lines 1-9). There's no image, multi-stage build, or compose profile
for the authz service itself.

`package.json` does have `private: true` (line 4) next to `bin: { authz:
... }` (lines 29-31), but the "so `npx authz` doesn't work" causation needs
a fix: this package's actual npm name is `relationship-based-authorization`
(`package.json:2`), so plain `npx authz` would never resolve here
regardless of `private` — and a live registry check shows it's worse than
a clean failure: `authz` is already squatted by an unrelated 2013 package
on the public npm registry, while `relationship-based-authorization` itself
is unpublished (`404`). None of that blocks local use, though — `npm run
cli` (`package.json:35`) and the README's own documented `npx tsx
src/cli/index.ts doctor` (`README.md:568`) already run the CLI with zero
build or publish step, and a Dockerfile wouldn't fix the npm-naming problem
anyway; that's a separate `name`-field/publishing decision.

What's real and still open: README.md already headlines "under 10 minutes,
from a clean clone" (`README.md:561`), but today that's four manual
commands after clone (`npm install`, `cp .env.example .env`, `doctor`,
`seed:example` — `README.md:566-569`), with `docker compose up -d` offered
only as one of three ways to get Postgres (`README.md:600-603`), not an
end-to-end path. A multi-stage Dockerfile plus a compose profile chaining
postgres → migrate → seed → serve would genuinely collapse that into one
command — a real, unaddressed gap, just one that should be scoped honestly
to the onboarding problem rather than also credited with fixing `npx authz`.
(Separately, production deployment already exists without Docker at all —
`README.md:13` links a live Railway deployment — so this is an
onboarding/reproducibility gap, not a deployability blocker.)

### Release integrity — partially addressed

CodeQL (`.github/workflows/codeql.yml`, security-extended queries, weekly +
every push/PR to main), OpenSSF Scorecard
(`.github/workflows/scorecard.yml`, weekly + every push to main, publishing
to scorecard.dev), and Dependabot (`.github/dependabot.yml` plus the
low-risk auto-merge in `.github/workflows/dependabot-auto-merge.yml`) are
all real and running today.

What's missing: no SBOM generation (CycloneDX/SPDX — confirmed absent
repo-wide), no signed git tags (`git tag -l` returns zero tags in this repo
at all, and no release workflow to hang signing off of), and no npm
provenance attestation. That last one needs a caveat the brainstorm skips:
`package.json` sets `"private": true`, so there's no `npm publish` step
today for provenance to attach to — this is a gap that would matter if/when
the project starts publishing to npm, not a hole in a live pipeline right
now. `docs/github-governance.md`'s own Step 5 upgrade-path checklist
already tracks two adjacent, deliberately-deferred items — signed commits
and a second required reviewer (lines 133-138) — but never mentions signed
tags or SBOM/provenance at all, so this is a genuine blind spot in that
checklist, not a restatement of something already considered and
consciously postponed. Scorecard already scores exactly these axes (SBOM,
Signed-Releases, Pinned-Dependencies) on scorecard.dev, so the gap is
externally visible today — fitting, given this project's own
`file:line`-citation discipline makes "prove it rather than assert it" a
real, load-bearing practice here, not just a slogan.

## Proof machinery

### Package the schema verifier separately

The third-party survey — 7 VIOLATED / 5 HOLDS, 0 UNKNOWN
(`docs/FINDINGS.md:101`, current as of D-131's `notRelationEquals`
primitive closing two of the original nine) — is the most externally
interesting result in the repo, and today it's only a markdown table
(`docs/FINDINGS.md:86-99`). Nothing in the repo packages it further: there
is no `action.yml` anywhere, and the one existing CI hook
(`.github/workflows/schema-verifier.yml`) isn't a reusable action — it
hardcodes `schema/example.authz`/`schema/example.invariant`, this repo's
own fixtures, with no `workflow_call` trigger. That said, the CLI it wraps
(`tools/schema-verifier/src/cli/index.ts`, D-122) already takes arbitrary
`<schema-file> --invariants <file>` paths, so an `action.yml` wrapper is
comparatively thin work — the real blocker is that other repos' models
aren't in this project's DSL.

You did hand-translate twelve real schemas for the survey
(`tools/schema-verifier/thirdparty/`, five genuine OpenFGA `.fga` files
plus seven SpiceDB-syntax sources — six embedded in `schema-and-data.yaml`
fixtures, one in an authzed/docs MDX page, not standalone `.zed` files),
and the translation rules are written down
(`tools/schema-verifier/thirdparty/README.md`'s methodology section) — but
that's a documented-by-hand mapping plus twelve worked examples, not code;
nothing in `src/` or `tools/schema-verifier/src/` parses either syntax. The
two front ends aren't symmetric work, though: OpenFGA already has an
official offline parser — `@openfga/syntax-transformer`, vendored right in
this monorepo for `tools/rebac-benchmark`
(`tools/rebac-benchmark/src/adapters/openfga-adapter.ts`) — so that side is
a JSON-to-IR mapper over an existing library, not a parser from scratch.
SpiceDB has no such shortcut anywhere here: the benchmark's own SpiceDB
adapter parses `.zed` syntax only by handing it to a live `spicedb serve`
process via gRPC (`tools/rebac-benchmark/src/adapters/spicedb-adapter.ts:74-77`),
so a real offline `.zed` parser is still unbuilt work. Net: the Action
wrapper is cheap, the OpenFGA front end is a mapping exercise over a
dependency you already have, and the SpiceDB front end is the one
genuinely new parser this needs.

### Close the invariant-language root cause — mischaracterized (the published number is stale)

This is worth leading with a correction rather than the gap itself:
`docs/FINDINGS.md:101` still publishes "7 VIOLATED, 5 HOLDS," but running
the real `verify-schema` CLI against all twelve
`tools/schema-verifier/thirdparty/*.authz` fixtures today returns **8
VIOLATED / 4 HOLDS**. `spicedb-userdefined-roles` (published at
`docs/FINDINGS.md:97` as "HOLDS up to k = 1") now comes back a
self-validated exact VIOLATED, with a live witness
(`role:r#project@project:p, role:r#built_in_role@project:p,
role:r#project@project:obj1, project:obj1#role_manager@role:obj2#member,
role:obj2#member@user:m`), because D-151's z3 SMT tier
(`docs/DECISIONS.md:2524-2548`, shipped 2026-08-26) runs ahead of the
bounded search that produced that old verdict in
`tools/schema-verifier/src/validate/check-and-validate.ts:117`, and nothing
has re-checked the third-party survey against it since D-139's "zero drift"
audit the day before (`docs/DECISIONS.md:2251-2268`). No test in
`tools/schema-verifier/test/` pins this fixture's verdict either, so
nothing would have caught the flip. This needs its own follow-up: a
documented re-run of the survey against the SMT/CHC tiers, and a
regression test pinning the new verdict.

That correction doesn't undercut the underlying recommendation — if
anything it strengthens it, since the new entry is itself a second,
structurally different manifestation of the same underlying gap (an
unconstrained second tuple slipping past an already-pinned relation, not
the classic "directly-grantable relation" escape). Of the (corrected) 8, six
(`openfga-github`, `spicedb-superuser`, `spicedb-docs-style-sharing`,
`openfga-gdrive`, `openfga-slack`, `spicedb-github`) still share the one
cause `docs/FINDINGS.md`'s own "recurring finding" names (lines 26-45): no
way to state a negative precondition. D-131's `notRelationEquals`
(`docs/DECISIONS.md:2063`; `docs/INVARIANTS.md:209-249`) only partly
addressed that, closing 2 of the original 8 and naming, in its own "Revisit
if" (`docs/DECISIONS.md:2097`), exactly the schema-level primitive still
needed ("this relation can never be satisfied via any object, anywhere,"
not a bare-principal exclusion). That's pre-scoped, not a new ask. The
other two — `openfga-expenses`'s self-referential manager loop and the
newly-surfaced `spicedb-userdefined-roles` escape — are distinct shapes the
same primitive was never meant to reach. Closing the six, and publishing
the corrected 8-VIOLATED count alongside it, moves the survey number
honestly rather than by narrowing the question — which is the project's
own stated preference in an analogous case (`docs/DECISIONS.md:950` rejects
"narrowing the documented claim" as "the wrong tradeoff").

## Testing

### Fault injection above the storage seam — mischaracterized (the rate limiter already fails closed)

DST covers the store thoroughly (`test/isolation/README.md:34-41`),
including, per D-165/D-167, the Leopard index's async rebuild/lookup
pipeline (`docs/DECISIONS.md:2865-2877`) — but by construction
(`src/store/dst/*.ts` has zero fastify/http/redis references) it never
touches the HTTP layer, and nothing else does either: no code anywhere in
`src/api` reacts to a client socket closing mid-request (grepped for
`.on('close')`/`request.raw`/`reply.raw`/`abort`/`hijack` — no hits), and
no test simulates it. A Redis outage while `REDIS_URL` is set is equally
untested — `test/unit/api/redis-store.test.ts`'s `RedisFloodStore` suite
only ever mocks `eval()` as resolving, never rejecting, and
`rate-limit.test.ts`/`server.test.ts` never set `REDIS_URL` at all.

But the rate limiter's _behavior_ on a Redis outage isn't actually an open
question — it's resolvable from the code, and the answer cuts against the
abuse-path fear the brainstorm raised. Both Redis-backed mechanisms fail
**closed** today, not open. `@fastify/rate-limit`'s own Redis store throws
on a connection error, and since `src/api/server.ts:827` never sets
`skipOnError` (the dependency's own default,
`node_modules/@fastify/rate-limit/index.js:138`, is `false`),
`applyRateLimit` (`index.js:300-303`) re-throws rather than admitting the
request; `authFloodGuard` (`server.ts:1084-1089`) and
`RedisFloodStore.increment` (`src/api/redis-store.ts:149-167`) both await
Redis with no `try`/`catch` either, so a rejected `eval()` propagates the
same way. Neither path is recognized by `setErrorHandler`'s
`retryAfterSeconds`/sub-500 branches (`server.ts:768-798`), so both land on
a bare `500 internal_error` — not the established `503
infrastructure_unavailable` this codebase already uses for other infra
failures reaching a route handler (`server.ts:948, 981`; tested at
`test/unit/api/server.test.ts:924-940`).

So the real, still-open gap isn't "does it fail open" — it doesn't. It's
threefold: this fail-closed behavior has zero test coverage and could
silently regress; a sustained Redis outage today reads as a self-inflicted
denial-of-service (every gated route 500s) rather than a graceful degrade
to per-process rate limiting, which `src/api/redis-store.ts`'s own
error-handler log line (`createRedisClient`, line 60: "Redis client error
(rate-limit/flood-guard budgets degrade to per-process only while this
persists)") seems to assume happens but no code implements; and
the error surfaces as a generic 500 instead of the codebase's own 503
convention. Worth a fault-injection suite that breaks Redis mid-request and
asserts the intended behavior explicitly, whichever way it's meant to go,
plus, separately, a client-disconnect-mid-check test, since that has no
coverage or code path at all today. (D-162's rate-limiter finding, for
contrast, was a keyGenerator/bucketing fix — multi-IP budget-multiplication
via one credential — and is unrelated to this Redis-outage question.)

## What I'd actually do first

Given that this engine might get folded into a Taint-Tracked-Tool-Broker —
an agent tool-call authorizer — worth naming plainly: nothing in this repo
knows about that project. It doesn't exist here, isn't referenced anywhere
in `src/`, `docs/`, `README.md`, or `PROGRESS.md`, and nothing below is a
claim about its code. What follows is architectural reasoning about why
_this repo's own_ primitives fit that shape, not a verified fact about the
broker.

The broker's "may this tool call proceed" decision maps directly onto this
engine's existing subject/relation/object check shape (`performCheck`,
`src/audit/checks.ts:554-561`, `agent` as subject, `tool` as object — no
namespace-specific logic stands in the way). Taint provenance is
expressible without inventing caveats, using the DSL's real exclusion
operator (`ExclusionRule`, `src/schema/dsl/types.ts:157-161`): a
hypothetical `tool.invoke = permitted - reached_by_untrusted` is not code
that exists today, but it's exactly the shape already shipped and tested as
`permission unbanned_view = viewer - banned`
(`src/soundness/generators.ts:679`, exercised in
`test/unit/schema/rewrite-rules.test.ts:62-95`). If `reached_by_untrusted`
were itself a recursive taint-propagation relation, that check would run
through the exact code path D-158–D-161 hardened: exclusion's subtract
branch interacting with a tuple-data cycle or depth ceiling, which used to
flip a fail-closed "cannot prove" into an unsound grant in both resolvers
and production's SQL fast path (`docs/DECISIONS.md` D-158/D-159), now
covered by a permanent metamorphic property and the main fuzzer by default
(D-160/D-161).

The hash-chained `checks` log (D-148, `docs/DECISIONS.md:2456`, migration
`0006_checks_hash_chain.sql`) gives every allow and deny a real chained
SHA-256 record — but precisely: it's tamper-_evident_ for a single edited
row, not tamper-_proof_ against a privileged database user rewriting the
chain forward, which is exactly the residual D-148 named and D-155
(`docs/DECISIONS.md:2643`) closed with an out-of-band NDJSON anchor
(`src/audit/anchor.ts`) — one that only buys anything once replicated
off-host; its own doc comment says a local anchor provides no real security
improvement on its own. That's a meaningfully stronger tamper-evidence
story than most agent-tooling stacks have today, as long as the anchor is
actually shipped somewhere the database's own privileged user can't reach.

Wildcard subjects would genuinely help with "any agent may read public
docs," and genuinely don't exist: D-114 named them explicitly out of scope
for v1 ("no analog anywhere in this grammar"), never reopened since — a
real, open, but already-documented gap, and the one item on this whole list
I'd pick up first if this integration became real, precisely because the
other two pieces (the exclusion operator, the hash chain) are already
sitting there, shipped and hardened, waiting for a caller.
