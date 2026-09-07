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

### Public/wildcard subjects — built, `docs/DECISIONS.md` D-171

**Status: built and shipped.** This section records the gap as it stood
before it was closed — see D-171 for what actually shipped (a per-relation,
opt-in `<ns>:*` subject type; a reserved `subject_id = '*'` store sentinel
requiring no migration; a single shared match funnel in each resolver, so
the exclusion-soundness argument holds by construction, not by empirical
luck; and `listUsers` widened to a discriminated concrete/wildcard result
that refuses outright, rather than approximating, the one genuinely
co-finite shape a wildcard-minus-concrete-exceptions subtraction produces).
D-114 is not silently edited — it stays standing as the historical marker
of what v1 meant, exactly per its own "Revisit if" clause — D-171 is the
dated decision reopening it that clause itself anticipated.

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

### A Watch endpoint — built, `docs/DECISIONS.md` D-174

**Status: built and shipped.** This section records the gap as it stood
before it was closed — see D-174 for what actually shipped
(`GET /watch?since=<token>&namespace=<ns>`, a live SSE stream over
`write_log`, DB-polling per connection rather than Postgres LISTEN/NOTIFY)
and for why that choice also gets multi-replica fan-out for free, with no
Redis and no cross-process signaling at all.

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

### Bulk writes and import/export — built, `docs/DECISIONS.md` D-170

**Status: built and shipped.** This section records the gap as it stood
before it was closed — see D-170 for what actually shipped
(`POST /tuples/batch` mirroring `/check/batch`'s design, plus
`authz tuple export`/`import` over NDJSON) and for the one real design
correction that pass made: unlike `/check/batch`, an individual item in a
tuple-write batch can genuinely fail its own validation, so the batch
route reports partial success per item rather than an all-or-nothing
verdict.

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

### Reverse lookup that isn't capped in the way it matters — built, `docs/DECISIONS.md` D-175

**Status: built and shipped.** This section records the gap as it stood
before it was closed — see D-175 for what actually shipped (a five-gate
reverse-lookup accelerant for `listObjects`, reusing the Leopard index's
own `relation_membership_index` table in the other direction via one new
secondary index; a real design revision, not a first-draft ship, after a
genuine adversarial review found the initial floor-comparison freshness
gate could silently omit real objects) and for the full account of why the
"genuinely new fourth direction, not something already named and deferred"
framing below turned out to be exactly right — confirmed by research
before design work began, not assumed.

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

### Metrics — built, `docs/DECISIONS.md` D-169

**Status: built and shipped.** This section records the gap as it stood
before it was closed — see D-169 for what actually shipped (`GET /metrics`,
a hand-rolled Prometheus text-exposition registry) and for a real bug live
verification caught before it shipped: an early draft counted every
_allowed_ check as "uncertain," because `certain` is only ever populated on
a _denied_ result.

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

### Release integrity — built, `docs/DECISIONS.md` D-172, D-180

**Status: built and shipped.** This section records the gap as it stood
before D-172 built the tooling and D-180 (a real, live-confirmed
correction — this section itself still said "mostly built," blocked on
cutting an actual tag, until this entry) confirmed the tag itself landed:
`.github/workflows/release.yml`, triggered only on a pushed `vX.Y.Z` git
tag, rejects a lightweight or unsigned tag (verified through the GitHub
REST API, the same mechanism behind the "Verified" badge), builds,
generates a CycloneDX SBOM, and attaches it to a GitHub Release.
Deliberately never touches npm publishing — `package.json` stays
`"private": true`, per D-002's own still-standing decision — so the
npm-provenance piece named below remains correctly out of scope, not
silently dropped.

**`v1.3.0` is a real, GitHub-verified signed tag, and the workflow ran
clean against it, confirmed directly against the live repository, not
assumed from this section's own stale prose:** `list_tags` shows `v1.3.0`
on the real remote; the `Release` workflow's own run against it
(`head_sha` matching the version-bump commit) completed with
`conclusion: success` — meaning its own first step (reject a lightweight
or unsigned tag) passed, so the tag really is a signed, annotated,
GitHub-verified one, not merely present. Every later step ran too: `npm
run build`, `npx cyclonedx-npm` (the real SBOM, `sbom.cdx.json`), and
`softprops/action-gh-release` publishing the GitHub Release itself (with
the SBOM attached as a release asset and `generate_release_notes: true`
producing the changelog body) — [the live release](https://github.com/NovaVey/Relationship-Based-Authorization/releases/tag/v1.3.0)
confirms all three. `docs/DECISIONS.md` D-172 itself is left exactly as it
stood when written (a historical marker, per this project's own D-114/
D-171 precedent for not silently editing a settled entry) — it's this
section, the live-status tracker, that was stale.

CodeQL (`.github/workflows/codeql.yml`, security-extended queries, weekly +
every push/PR to main), OpenSSF Scorecard
(`.github/workflows/scorecard.yml`, weekly + every push to main, publishing
to scorecard.dev), and Dependabot (`.github/dependabot.yml` plus the
low-risk auto-merge in `.github/workflows/dependabot-auto-merge.yml`) are
all real and running today.

The one piece still genuinely out of scope, not missing: npm provenance
attestation. `package.json` sets `"private": true`, so there's no `npm
publish` step for provenance to attach to — a gap that would matter
if/when the project starts publishing to npm, not a hole in the live
pipeline. `docs/github-governance.md`'s own Step 5 upgrade-path checklist
never mentions signed tags or SBOM/provenance at all, so updating that
checklist to reflect this section's own now-closed status is the one
remaining loose end (a doc-sync task, not a capability gap).

## Proof machinery

### Package the schema verifier separately — built, `docs/DECISIONS.md` D-173, D-178, D-179, D-181

**Status: built and shipped.** D-173 closed the cheapest piece
(`tools/schema-verifier/action.yml`, a reusable composite GitHub Action
wrapping `verify-schema`, dogfooded in this repo's own
`.github/workflows/schema-verifier.yml` via a local
`uses: ./tools/schema-verifier` reference). D-178 closed the OpenFGA front
end and D-179 the SpiceDB front end — see those entries for what shipped
(`tools/schema-verifier/src/frontends/{openfga,spicedb}/`, sharing one
`frontends/common/` layer). D-181 investigated and closed the one question
D-178 disclosed but left open (below). All three pieces this section
originally named are now built.

The third-party survey — **8 VIOLATED / 4 HOLDS, 0 UNKNOWN**
(`docs/FINDINGS.md:131`, current as of D-151's SMT tier correcting
`spicedb-userdefined-roles`, pinned by
`tools/schema-verifier/test/thirdparty-survey.test.ts` since D-176; this
section itself cited the stale `7/5` figure from before that correction
until this entry) — is the most externally interesting result in the
repo. D-173 already closed "nothing packages it further" for the CI-hook
half of that complaint.

**What D-178 actually found, correcting three things this section
previously got wrong:**

1. **The OpenFGA side was never "just a JSON-to-IR mapper over an
   existing library."** `@openfga/syntax-transformer` (now a real
   dependency of this repo's own root `package.json`, not just
   `tools/rebac-benchmark`'s) does remove all _parsing_ risk — real
   `.fga` DSL text goes in, a fully-formed `AuthorizationModel` comes out,
   zero grammar work needed. But OpenFGA's `define` conflates what this
   DSL keeps separate (a name can be directly writable, computed, or
   both at once) — turning that into this DSL's own `relation`/
   `permission` split, precedence-correct DSL text, and the `type#relation`
   nested-userset narrowing the hand-translated `openfga-github`/
   `openfga-slack` survey entries already had to do by hand, is real,
   substantial logic (`tools/schema-verifier/src/frontends/common/ir.ts`'s
   `splitMember`, `dsl-print.ts`'s precedence-aware printer,
   `openfga/translate.ts`'s narrowing pass) — comparable in size to the
   parsing this section credited as the hard part, not incidental
   glue around it. It's also the _shared_ half: the common layer this
   logic lives in is written once and reused by whatever SpiceDB front
   end comes next, unlike OpenFGA's own parsing step.
2. **D-171's wildcard-subject grammar addition was never connected to
   this survey** until now. `openfga-gdrive`'s own hand-translated
   header comment disclosed dropping `user:*` because "this DSL has no
   wildcard concept" — true when written, stale since D-171 shipped.
   D-178's translator includes real wildcard subject types, and disclosed
   the one genuinely open question this surfaced: whether the verifier's
   own reachability/bounded/SMT tiers reason _soundly_ about a
   wildcard-declared relation in every case, not just this survey's own
   witness-driven cases. **D-181 investigated and closed this.** The
   `HOLDS`/`UNSAT` direction, and disjoint-subject-type reasoning
   specifically, were both proven sound — wildcard-blindness there is
   provably harmless. The `VIOLATED`/witness direction had a real gap,
   confined to bounded search: `generateCandidateTuples` never
   constructed the literal `'*'` sentinel, a structural blind spot no
   bound `k` could close, masked in practice only by an independent,
   also-real bug in `src/store/tuples.ts` that wrongly accepted a
   concrete grant against a wildcard-only relation. Both are fixed; see
   D-181.
3. **The SpiceDB front end's _parser_ was indeed smaller than this section
   previously framed, exactly as D-178 predicted — but D-179 found two
   genuinely new, real translation problems neither this section nor
   D-178 anticipated at all.** The parser itself is the light fork of
   `src/schema/dsl/parser.ts` D-178 predicted, and it reuses the shared
   `frontends/common/` layer with zero `splitMember`-style work of its
   own. But: (a) SpiceDB's own schema-language reference states plainly
   that union (`+`) binds _tighter_ than intersection (`&`)/exclusion
   (`-`) — the exact opposite of this DSL's own grammar — a real
   precedence inversion a naive per-operator text substitution would get
   silently wrong; and (b) a nested-userset subject type can target _any_
   permission in SpiceDB (not just ones reducible to a single relation the
   way OpenFGA's own split mechanism always produces), needing a real
   three-case resolution algorithm, plus a third, independent problem
   (`spicedb-superuser`'s own `owner: user | organization` followed by
   `owner->admin`, where `user` alone has no `admin` at all) that this
   DSL's own stricter compiler would otherwise reject outright. See D-179
   for the full account, including how the shared `dsl-print.ts`
   parenthesization logic (built for OpenFGA) turned out to already handle
   the precedence inversion correctly with zero SpiceDB-specific code.

### Close the invariant-language root cause — built, `docs/DECISIONS.md` D-131, D-182

**Status: built and shipped.** The stale-number half of this section was
fixed first: `docs/FINDINGS.md` published the corrected `8 VIOLATED, 4
HOLDS` count, with `spicedb-userdefined-roles`'s own flip (`HOLDS up to k
= 1` → a confirmed, exact `VIOLATED`, once D-151's SMT tier was actually
re-run against it) recorded there in full, plus a new permanent
regression guard (`tools/schema-verifier/test/thirdparty-survey.test.ts`)
pinning all twelve published verdicts so a future drift like this one
can't happen silently again. D-182 then built the section's own closing
recommendation — the schema-level "this relation can never be satisfied
via any object, anywhere" primitive (`NeverRelationConstraint`) — and
closed 6 of the remaining 8 `VIOLATED` entries with it:
`openfga-github`, `spicedb-superuser`, `spicedb-docs-style-sharing`,
`openfga-gdrive`, `openfga-slack`, `spicedb-github`. `docs/FINDINGS.md`
now publishes **2 VIOLATED, 10 HOLDS** — the remaining two
(`openfga-expenses`'s self-referential manager loop,
`spicedb-userdefined-roles`'s own distinct escape) are structurally
different shapes neither primitive was ever designed to reach. The
section below is otherwise left as it stood before either fix, for
context.

This is worth leading with a correction rather than the gap itself:
`docs/FINDINGS.md:101` used to publish "7 VIOLATED, 5 HOLDS" (now
corrected, as described above) — running
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
nothing would have caught the flip. **Done, per the "Status" note above:**
a documented re-run of the survey against the SMT/CHC tiers, and a
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

### Fault injection above the storage seam — built, `docs/DECISIONS.md` D-177

**Status: built and shipped.** This section records the gap as it stood
before it was closed — see D-177 for what actually shipped: `authFloodGuard`
now catches a rejected `RedisFloodStore.increment` precisely at its own
call site and reports `503 infrastructure_unavailable` (`service: 'Redis'`,
never falsely claiming Postgres); `@fastify/rate-limit`'s own bundled
Redis-store failure — which exposes no call site this codebase owns to
wrap directly — is now recognized by a disclosed, narrowly-scoped
`setErrorHandler` heuristic instead; the misleading "degrades to
per-process" log line is corrected to describe the real, fail-closed
behavior; and a `buildServer(pool, { redisClient })` test-only override
lets a real (but fast-failing) `ioredis` client be injected for
deterministic fault-injection tests, closing a real, related bug the new
tests caught along the way: `buildServer`'s own shutdown hook crashed if
`redisClient.quit()` itself rejected against an already-broken connection.
The client-disconnect-mid-check gap named below is also closed — a real
`app.listen()` + real, aborted `fetch()` test (mirroring
`test/unit/api/watch.integration.test.ts`'s own established real-socket
precedent) confirms, empirically, that many concurrent real clients
aborting a real `/check` mid-flight never crashes the server and never
corrupts its ability to serve the next request.

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
convention. **Done, per the "Status" note above** — checked with the user
first, which of the two ways "it's meant to go" was chosen: keep the
existing fail-closed behavior exactly as-is (a deliberate, safer default —
building an actual degrade-to-per-process fallback would be a real
availability/abuse policy change, not a same-day fix) and correct the log
line to match it, rather than build the degrade. A fault-injection suite
that breaks Redis mid-request and asserts that chosen behavior explicitly,
plus, separately, a client-disconnect-mid-check test, since that had no
coverage or code path at all before. (D-162's rate-limiter finding, for
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
docs" — and, since this was first written, they've shipped: D-114 named
them explicitly out of scope for v1, but D-171 built them (a per-relation,
opt-in `<ns>:*` grammar — see this file's own "Public/wildcard subjects"
section above for exactly what shipped and what it deliberately doesn't
cover), and D-181 later closed a real soundness question D-178 had left
open about them. All three pieces this section originally named — the
exclusion operator, the hash chain, and wildcard subjects — are now
sitting there, shipped and hardened, waiting for a caller.
