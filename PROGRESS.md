# Progress

Tracks state: files touched per phase, delegations, open questions. See
[`docs/DECISIONS.md`](docs/DECISIONS.md) for the reasoning behind choices —
this file is allowed to go stale, that one isn't.

## Phase 0 (pre) — Scaffold pivot from the previous repo identity

**Owner:** main agent (not delegated — this predates the subagent split in
`.claude/commands/build-authz-service.md` §14, and is scaffolding/repo
surgery, not implementation).

**What this repo was, briefly:** a multi-tenant security kit (tenant
context propagation, RBAC, per-tenant rate limiting, audit logging,
Postgres row-level security, per-tenant encryption), published as an npm
library. See `docs/DECISIONS.md` D-001 through D-007 for what was kept,
what was removed, and why.

**Files touched:**

- Removed: `src/{tenant,rls,rbac,rate-limit,audit,crypto,http}/`,
  `src/errors.ts`, `src/index.ts`, their tests, `examples/`,
  `doc-examples/`, `docs/{tenant-isolation,row-level-security,rbac,
rate-limiting,audit-logging,encryption,auth-integrations,
versioning-policy}.md`, `.changeset/`, `CHANGELOG.md`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`,
  `scripts/{verify-dist-singleton,verify-docs}.mjs`, `tsup.config.ts`,
  `.github/workflows/release.yml`.
- Repurposed, not deleted: `test/integration/rls-postgres.integration.test.ts`,
  `test/rls/postgres.test.ts`, `test/rls/postgres.fuzz.test.ts`, and
  `test/tenant/tenant-id.fuzz.test.ts` became
  `test/isolation/{permission-resolution.integration,
differential-soundness.fuzz, identifier-and-tuple-validation.fuzz}.test.ts`
  — real `.todo()` specs, not real assertions yet. See
  `test/isolation/README.md` for the file-by-file lineage.
- Added: `src/config/env.ts` + `.env.example` (the env loader — Phase-0
  scaffolding kept ahead of the phased build per `docs/DECISIONS.md` D-007),
  `docs/DECISIONS.md`, `.claude/commands/build-authz-service.md`,
  `.claude/agents/{schema-compiler,soundness-engineer,test-author,
report-designer}.md`, this file.
- Kept close to as-is: `.github/workflows/{ci,codeql,scorecard,
dependabot-auto-merge}.yml`, `.github/{CODEOWNERS,dependabot.yml,
ISSUE_TEMPLATE/,PULL_REQUEST_TEMPLATE.md}`, `docs/github-governance.md`
  (renumbered after removing the two publish-only steps), `.editorconfig`,
  `.prettierrc.json`, `eslint.config.js` (dropped dead ignores for removed
  dirs), `tsconfig.json` (dropped a dead exclude entry), `LICENSE`.
- Rewritten: `package.json` (private, unscoped name, dropped every
  npm-publish-only field, trimmed dependencies to what the kept/repurposed
  code actually needs — see `docs/DECISIONS.md`), `package-lock.json`
  (regenerated against the trimmed `package.json`), `README.md` (skeleton
  reflecting the new project's identity and honest current state),
  `vitest.config.ts` / `vitest.integration.config.ts` (integration tests
  now matched by `**/*.integration.test.ts` suffix since they live inside
  `test/isolation/` alongside the fuzz/unit tests they pair with, not in a
  separate `test/integration/` tree; coverage thresholds removed until
  there's real implementation coverage to hold a floor under).

**What's deliberately not built yet:** every phase in
`.claude/commands/build-authz-service.md` §9 — the schema DSL, the tuple
store, both resolvers, the differential-fuzzing harness, the API, and the
report/UI layer. `src/` currently contains only the Phase 0 env loader.
Building any of that now would be exactly the "write code before the spec
exists" mistake the build spec's own rule 0 warns against — see the spec
itself for what comes next.

**Verification run locally before this state was committed:** `npm run
lint`, `npm run typecheck`, `npm test` (35 `.todo()` tests across the
repurposed isolation suite, 0 failures), `npm run test:integration` (15
`.todo()`), `npm run build` — all clean.

**Open questions carried into Phase 0 proper:**

- Postgres hosting (Railway, per this org's other services, or otherwise) —
  needs a real `DATABASE_URL` before Phase 2 can do anything.
- Whether `docs/github-governance.md`'s checklist has actually been applied
  to this repo's GitHub settings yet (branch protection, required status
  checks, Dependabot auto-merge, CODEOWNERS) — none of that is visible from
  the git tree; confirm before treating Phase 8's exit criteria as met.

## Phase 0 — CLI + migration runner wiring

**Owner:** main agent (not delegated — CLI/scaffolding is explicitly main-agent
work per `.claude/commands/build-authz-service.md` §14, and this phase has
no §10 test-plan entries of its own for `test-author` to write from).

**Files touched:**

- Added: `src/cli/index.ts` (commander entry point — only `doctor` is
  registered; no stubs for later phases' commands), `src/cli/commands/doctor.ts`,
  `src/store/client.ts` (singleton `pg.Pool`, 5s connection timeout so
  `doctor` fails fast rather than hanging), `src/store/migrate.ts` (migration
  runner + `discoverMigrations()`, pure and unit-tested; a missing
  `migrations/` directory is zero migrations, not an error), `test/unit/migrate.test.ts`
  (5 tests against `discoverMigrations()`), `tsconfig.build.json` (see
  `docs/DECISIONS.md` D-009).
- Rewritten: `src/config/env.ts` (`DATABASE_URL`/`ADMIN_API_KEY`/`SOUNDNESS_FUZZ_SEED`
  now optional-if-blank via `optionalString()`, `dotenv.config({ quiet: true })`
  — see `docs/DECISIONS.md` D-008), `package.json` (`commander` + `pg` moved
  to real `dependencies`, `tsx` added for `npm run cli`, `bin.authz` entry,
  `build` now runs `tsconfig.build.json`).

**Two real bugs found and fixed by actually running the CLI, not by
inspection** (both recorded in `docs/DECISIONS.md`, D-008 and D-009):

1. Eager env validation crashed `authz --help` on a fresh clone with no
   `.env` — fixed by making `DATABASE_URL` optional at the schema layer,
   required at the point of use (`doctor` itself, before touching Postgres).
2. `npm run build` had no `rootDir`, so once `test/**/*.ts` shared a
   tsconfig with `src/**/*.ts` the inferred common root became the repo
   root — `dist/cli/index.js` (the `bin` target) never existed, the real
   file was at `dist/src/cli/index.js`, and the entire test suite was being
   compiled into the distributable output. Fixed with a dedicated
   `tsconfig.build.json`.

**Verification, against a real local Postgres 16 (not a mock):**

- `authz --help` — works with zero `.env` present, exit 0.
- `authz doctor` with no `DATABASE_URL` — specific message, exit 3, no hang.
- `authz doctor` with bad credentials — `password authentication failed for
user "baduser"`, exit 3.
- `authz doctor` with an unreachable host — `connect ECONNREFUSED`, exit 3,
  fails within the 5s connection timeout rather than hanging.
- `authz doctor` against a real, reachable Postgres — reports the database
  name and server version, creates `schema_migrations`, reports `0/0`
  applied (correct — Phase 2 hasn't added real migrations yet), and is
  idempotent on a second run.
- Built CLI (`node dist/cli/index.js`) verified identical to `tsx`-run
  source for both `--help` and `doctor`.
- Full local `npm run verify` equivalent (format:check, lint, typecheck,
  test, test:integration, build) — all clean; unit suite now 5 passed + 20
  `.todo()` (was 0 passed + 20 `.todo()`), integration suite unchanged at 15
  `.todo()`.

**CHECKPOINT reached — see build spec §9 Phase 0:** exit criteria met
(`authz --help` runs; `authz doctor` reports reachable or a specific error).
Waiting on Postgres hosting choice for the connection string Phase 2's
actual migrations will run against — the local Postgres used above is a
throwaway dev fixture (`authz` / `authz_dev` on `127.0.0.1`), not anything
this project depends on going forward.

**Resolved — Postgres hosting.** Railway, matching this org's other
services. Provisioned `Postgres-RBA` in the existing `Upwork Portfolio`
project (same image/variable convention as `Postgres-ERP`); `.env`'s
`DATABASE_URL` now points at the real instance via its public TCP proxy.
One real infra bug found and fixed along the way (missing persistent
volume — the container looped forever instead of starting; deployment
status alone said `SUCCESS` throughout, only the runtime logs showed the
actual problem) — see `docs/DECISIONS.md` D-010 for the full account.
`DATABASE_URL` is verified working — real auth, real `select version()` —
via a Railway-hosted sandbox exec, not from this session's own shell: this
session's network policy only proxies outbound HTTP(S), so raw TCP to
Postgres isn't reachable directly from here. PR #9 merged.

**Open question carried forward:** Phase 2 onward will want real
integration-test runs against this database (per this project's own
"verify by running it, not by inspection" standard). This session can't do
that directly — confirm before Phase 2's CHECKPOINT that GitHub Actions CI
(which has normal outbound network access) can reach
`yamanote.proxy.rlwy.net:36306`, or find another execution path (e.g. a
Railway sandbox exec, matching how `DATABASE_URL` itself was verified here)
for any integration test that needs to run from this session specifically.

## Phase 1 — Schema DSL

**Owner:** `schema-compiler` subagent (parser/compiler/types/errors + the
four example schemas), delegated per `.claude/commands/build-authz-service.md`
§14. `test-author` subagent dispatched separately, after `schema-compiler`
finished, given only the compiled interface (`types.ts`/`errors.ts`'s
exported shapes) — explicitly barred from reading `parser.ts`/`compiler.ts`
so its tests prove agreement with §5/§10 of the spec, not with the
implementation's own behavior (delegation rule 5).

**Files touched:**

- Added: `src/schema/dsl/{types.ts,errors.ts,parser.ts,compiler.ts}` — a
  pure, zero-I/O lexer/recursive-descent parser + semantic compiler for the
  §5 grammar. `schema/{document,folder,group,org}.authz` (the four example
  namespaces — `document`/`folder` verbatim from §5, `group`/`org`
  designed to match) and `schema/malformed-example.authz` (Phase 1's own
  exit-criteria fixture).
- Test suite: see below, added by `test-author` once its delegation
  completes.

**Main-agent review before accepting (delegation rule 4):** read every
file `schema-compiler` produced, then independently re-ran the compiler
myself — not just the subagent's own transcript — against all four
example schemas compiled together (confirmed idempotent), the malformed
example, and two adversarial cases beyond what the subagent reported on
its own (a relation subject type targeting another namespace's
_permission_ instead of a relation, and a self-referential `permission
view = view`). Both correctly rejected with a specific, located error.
`npm run lint`/`typecheck`/`format:check` re-run and confirmed clean
myself, not just trusted from the subagent's report.

**Judgment calls the subagent flagged, now recorded:** `docs/DECISIONS.md`
D-011 (rewrite-rule operator precedence — `&` binds tighter than `|`/`-`),
D-012 (tuple-to-userset's target-namespace check is strict; a plain
relation subject type's is soft — and why those are different, not
inconsistent), D-013 (circular-permission detection is a static
compile-time graph check over permission-to-permission edges only, not a
per-branch liveness proof).

**Test suite (`test-author`, two delegations):**

- First pass: 17 tests across `test/unit/schema/{rewrite-rules,
schema-validation}.test.ts`, covering all four §10 "Schema DSL" cases plus
  determinism, duplicate-name, and cycle-detection coverage. Fail-checked —
  every assertion independently mutated to a wrong expected value and
  confirmed to fail before being restored — proving the suite actually
  discriminates rather than vacuously passing.
- Second pass (main-agent-initiated follow-up, after reviewing the first
  pass's own flag): un-skipped exactly the two `test/isolation/identifier-
and-tuple-validation.fuzz.test.ts` `.todo()`s that are genuinely
  implementable against the Phase 1 compiler alone (namespace-name and
  relation-name injection-corpus rejection). Every other `.todo()` in that
  file needs Phase 2 (the tuple writer) or later and correctly stays
  `.todo()` — see the file's own updated doc comment for the four-way
  payload classification this required (`empty`/`whitespace-decorated`/
  `invalid-word`/`unlexable`) and why a whitespace-insensitive, unquoted
  grammar can't reject some corpus payloads by the string arriving intact
  in the first place — that's a structural property of the grammar, not a
  gap in validation.

Both passes written from `.claude/commands/build-authz-service.md` §5/§10
alone — `parser.ts`/`compiler.ts` deliberately not read while writing
either, per delegation rule 5 — and both independently re-run by the main
agent, not just trusted from the subagent's report.

**Main-agent review before accepting (delegation rule 4), both
`schema-compiler`'s and `test-author`'s output:** read every file
produced, independently re-ran the compiler against all four example
schemas, the malformed example, and two adversarial cases beyond what
either subagent reported on its own initiative. `npm run lint`/
`typecheck`/`format:check`/`test` all re-run and confirmed clean directly,
not assumed from a subagent transcript.

**Final state:** `npm test` — 24 passed, 18 `.todo()` (was 20 `.todo()`
before Phase 1; two genuinely Phase-1-scoped identifier-validation todos
now real and passing). Lint/typecheck/format all clean.

**CHECKPOINT reached — see build spec §9 Phase 1:** exit criteria met
(the four example schemas compile; the malformed example is rejected with
an error naming the exact line/construct — verified independently by the
main agent, not just the subagent's own claim).

**Not yet done:** the CLI's `authz schema compile <file>`/`authz schema
publish <file>` commands (§7) — Phase 1 built the DSL layer only; wiring
it to the CLI is still open, deferred to whichever later phase first
needs it from the command line (likely Phase 2, once there's a
`namespace_configs` table to publish into).

## Phase 2 — Tuple store

**Owner:** main agent (tuple store is explicitly main-agent territory per
`.claude/commands/build-authz-service.md` §14's delegation table). Test
suite delegated to `test-author`, reviewed and independently re-verified
by the main agent before accepting.

**Files touched:**

- `src/store/migrations/0001_relation_tuples_and_write_log.sql`,
  `0002_namespace_configs.sql` — §4's tables, with two real deviations from
  the literal SQL given (see `docs/DECISIONS.md` D-014, D-015). `checks`
  and `soundness_runs` stay deferred to Phase 5/6 (D-016).
- `src/schema/publish.ts` (new) — `publishSchema`/`getLatestNamespaceConfig`,
  the one place a schema file actually reaches Postgres.
- `src/store/tuples.ts` (new) — `writeTuple`/`deleteTuple`/
  `listTuplesByObject`/`listTuplesBySubject`. Writes validate against the
  latest published namespace config (relation must exist, must be a
  relation and not a permission, subject type must be declared); deletes
  deliberately don't (D-017).
- `src/store/tokens.ts` (new) — `currentToken`/`assertTokenObserved`, the
  concrete mechanism behind §6.3's consistency-token pin.
- `src/cli/commands/{schema,tuple}.ts` (new), `src/cli/index.ts` (wired) —
  `authz schema compile/publish`, `authz tuple write/delete` per §7.

**Main-agent verification against a real local Postgres, not by
inspection:** every rejection path (undeclared relation, permission-as-
relation, disallowed subject type, malformed identifier, unpublished
namespace), idempotent write/delete with strictly increasing tokens, and
the full CLI surface — all run for real before committing. Also verified
directly (not just documented from the spec): the NULL-safe unique index
actually de-duplicates a plain-subject tuple written twice, the `token`
generated column actually mirrors `id`, and `ON CONFLICT` against the
expression index actually works.

**`test-author`'s delegation — a real bug found:** `write_log.token` and
`relation_tuples.id` are Postgres `bigint`, which `pg` returns as a
string, never coerced to `number` on its own. `assertTokenObserved`'s
plain `token > observed` comparison was therefore comparing strings, not
numbers — silently correct whenever both tokens have the same digit
count, and silently **wrong** the moment they don't: a token that was
genuinely already observed could be rejected as unobserved once the
write counter crossed a digit boundary (9→10, 99→100, ...). Found and
deterministically reproduced (not a flaky "wait for a digit boundary"
test) in `test/unit/store/tuple-store.integration.test.ts`. Fixed by the
main agent (test-author correctly left it unfixed, per its own
instructions, so the finding stayed visible rather than papered over):
explicit `Number(...)` coercion at every bigint-column read site, not a
global `pg.types.setTypeParser` registration — see `docs/DECISIONS.md`
D-018 for why the explicit form was chosen over the implicit one.

**Test suite:** `test/unit/store/tuple-store.integration.test.ts` (14
tests, real Postgres, `npm run test:integration`) plus three `test/
isolation/identifier-and-tuple-validation.fuzz.test.ts` `.todo()`s
un-skipped in the fast suite (proven DB-free via an intentionally
unreachable pool). Every test fail-checked by the delegating agent
(mutate the real code, confirm red, restore) except the two
"unreachable database fails rather than passes" tests, which have no
plausible mutation to fail-check against — validated by construction
instead (a real `ECONNREFUSED` is unambiguous).

**Final state, after the bigint fix:** `npm test` — 27 passed, 15
`.todo()`. `npm run test:integration` — 14 passed, 15 `.todo()` (the
remaining 15 are all in `permission-resolution.integration.test.ts`,
correctly still open — Phase 3/4 territory), verified against the local
Postgres dev fixture before a second, real problem was found and fixed
(see next paragraph). Lint/typecheck/format all clean. Local dev database
left truncated and empty.

**A second real problem, caught before it reached a PR:** as originally
delegated, `tuple-store.integration.test.ts` hardcoded this session's own
local dev Postgres connection string. That's exactly the fast, real-DB
loop the whole phase was developed against — but `.github/workflows/
ci.yml`'s `test-integration` job provisions no Postgres of its own; the
job's own comment says the intended mechanism is a container the suite
starts itself. Left as delegated, this suite would have failed every test
with `ECONNREFUSED` on the first real CI run. Rewritten to start its own
`PostgreSqlContainer` (`@testcontainers/postgresql`) and apply migrations
via `runMigrations`, matching the pattern `vitest.integration.config.ts`
already anticipated — see `docs/DECISIONS.md` D-019. Could not be run to
completion in this session's own sandbox either (the same network policy
blocking a direct Railway connection, D-010, also blocks this sandbox's
Docker daemon from pulling images) — verified by typecheck, by matching
an established working pattern exactly, and by watching real GitHub
Actions CI on the opened PR, not by a local pass in this environment.

**Exit criteria met (build spec §9 Phase 2 — no formal CHECKPOINT for
this phase, but reported before starting Phase 3, which has one):**
writing and reading round-trip; a write returns a strictly increasing
token, now actually verified as a real `number` end to end; deleting a
tuple is immediately invisible to a read pinned to a post-delete token.

**Open question carried forward, unchanged from Phase 0/1:** Phase 3+'s
own reference/production resolvers will want the same kind of real-
Postgres verification this phase got — this session's own shell still
can't reach Railway's `DATABASE_URL` directly (network-policy-restricted,
see D-010), but the local Postgres dev fixture used throughout Phase 2
remains available and is what later phases should keep using for
interactive verification in this environment.

## Phase 3 — Reference resolver (the oracle)

**Owner:** `soundness-engineer` (the resolver itself), `test-author` (the
§10 test suite, from spec alone — did not read `resolver.ts`). Both
reviewed and independently re-verified by the main agent before
accepting, per delegation rule 4.

**Files touched:**

- `src/resolve/reference/resolver.ts` (new) — `referenceCheck`, a pure,
  synchronous, in-memory brute-force graph walker. No I/O, no cache, no
  shared code with the (not-yet-built) Phase 4 production resolver —
  isolation enforced structurally (module-private helpers, a redefined
  not imported tuple type, single import of `src/schema/dsl/types.ts`
  only). Walks both userset mechanisms (rewrite-rule tuple-to-userset and
  stored-tuple userset subjects) correctly; cycle detection is
  branch-local via strict backtracking; an independent depth ceiling
  backstops a genuinely acyclic but pathologically deep chain.
- `test/unit/resolve/reference-resolver.{rewrite-rules,graph-shape,
depth-budget,edge-cases}.test.ts` (new, 29 tests) — every §10 "Reference
  resolver (Phase 3)" case plus multi-hop tuple-to-userset, diamond-DAG
  (including a genuinely hard variant — same node _and_ same relation
  name revisited from sibling branches, which a naive "ever seen this
  node" cycle guard would get wrong but a correct per-path one doesn't),
  undeclared namespace/relation, the depth-budget ceiling, and a
  userset-subject test constructed specifically to catch a resolver that
  string-compares ids instead of really recursing.

**Main-agent review found two real problems, both fixed before
committing:**

1. **A raw NUL byte in the source, not a `\0` escape sequence** — same
   runtime string value, but `git` treats a blob containing one as binary
   (confirmed: `git diff` showed `Binary files ... differ` instead of a
   readable diff). Would have made this file's GitHub PR review show no
   diff at all. Fixed by replacing the raw byte with the two-character
   escape `\0`; the delimiter design itself (a separator that can never
   appear in a real identifier, so a composite key can't collide by
   accident) was sound and kept — see `docs/DECISIONS.md` D-023.
2. **A test-design gap `test-author` found and fixed via its own
   fail-check discipline**, worth calling out because of what it proves
   about testing methodology, not just this one test: the cyclic-nesting
   "terminates and resolves denied" test, run against the resolver's
   _default_ depth budget, would still pass even with cycle detection
   completely removed — the independent depth ceiling silently absorbed
   the infinite recursion before the assertion ran. Fixed by forcing an
   explicit, very large `maxDepth` so the depth backstop can't be the
   thing doing the work the test claims to be checking. See
   `docs/DECISIONS.md` D-024 — flagged explicitly as a lesson worth
   carrying into Phase 5's fuzz-harness design.

**Main-agent independent verification, beyond either subagent's own
report:** wrote and ran a standalone script exercising all 5 required
CHECKPOINT examples plus two adversarial cases of my own (a diamond DAG
confirmed _not_ falsely flagged as a cycle, and a direct self-loop) — 16/16
passed against the real resolver before it was ever accepted or committed.

**Final state:** `npm test` — 56 passed, 15 `.todo()` (unchanged — every
remaining isolation `.todo()` needs Phase 2+4 or Phase 3+4+5 together, none
satisfiable from Phase 3 alone). Lint/typecheck/format all clean.

**CHECKPOINT reached — see build spec §9 Phase 3:** the reference resolver
matches 5 hand-derived examples, including tuple-to-userset through a
3-level parent chain and a cyclic group nesting that correctly resolves
denied rather than hanging — verified independently by the main agent, not
just claimed by either subagent.

**Open question carried forward for Phase 4:** the reference resolver
deliberately does not return a resolution path (`docs/DECISIONS.md`
D-020) — confirm whether Phase 4's production resolver needs to agree on a
path-shaped return value before Phase 5's divergence reporting is built
around whatever shape exists at that point.

## Phase 4 — Production check engine

**Owner:** `soundness-engineer` (the resolver), main agent (`authz check`
CLI wiring — main-agent territory per §14, matching Phase 2's schema/tuple
CLI precedent), `test-author` (the test suite, cross-resolver-agreement
tests especially — this phase's actual exit criterion). All reviewed and
independently re-verified by the main agent before accepting.

**Files touched:**

- `src/resolve/production/resolver.ts` (new) — `productionCheck`, backed
  by real Postgres, hand-written SQL. Splits the walk across two
  genuinely different implementation strategies from the reference
  resolver (D-025): TypeScript-orchestrated recursion for rewrite-rule
  tuple-to-userset and the union/intersection/exclusion combinators
  (schema-driven, can't be one static SQL query); a single `WITH
RECURSIVE` query per relation-level check for stored-tuple userset-subject
  membership (nested group-style closures — schema-agnostic edge shape,
  exactly what recursive CTEs are for). Two independent cycle-safety
  mechanisms, deliberately not unified (D-026). Reuses `src/store/
tokens.ts`'s `assertTokenObserved` directly for consistency-token pinning
  — a deliberate carve-out from resolver isolation, since the token
  mechanism is store infrastructure, not resolver logic. `cache.ts` not
  built this phase (D-028 — out of scope per §6.6).
- `src/cli/commands/check.ts` (new), `src/cli/index.ts` (wired) —
  `authz check <subject> <relation> <object> [--at-token <n>]` per §7.
- `test/unit/resolve/production/{cross-resolver-agreement,
production-check-behavior}.integration.test.ts` (new, 20 tests) — every
  hand-derived example checked against **both** resolvers on identical
  fixtures (the actual Phase 4 exit criterion), plus production-only
  behavior (token pinning both directions, impossible-token/unreachable-DB
  rejection, undeclared-namespace/relation fail-closed-as-deny).
- `test/isolation/permission-resolution.integration.test.ts` — all 15
  `.todo()`s un-skipped (not explicitly requested; `test-author`'s own
  judgment call, since the file's own header said it was blocked on
  exactly Phase 2 + Phase 4, both of which now exist — correct per this
  project's standing "don't leave a satisfiable `.todo()` stale" rule).

**Two real problems found and independently reproduced by the main agent,
not just trusted from either subagent's report:**

1. **The cyclic-hang claim itself** — before accepting the resolver, the
   main agent deliberately removed the SQL path-array cycle guard and
   confirmed, with a hard OS-level timeout, that `productionCheck` really
   does hang against a real seeded cycle (killed after 6s). Restored and
   re-verified clean before committing.
2. **A third instance of the "termination test proves nothing unless it
   can fail" lesson** (D-029, after D-024 and D-027): with the SQL cycle
   guard removed but the independent depth cap left in place (bounded to
   20,000), the query still eventually returned the _correct_ boolean —
   just ~49 seconds instead of milliseconds. A boolean-only assertion,
   however generous its timeout, cannot tell "cycle detection works" apart
   from "the depth ceiling alone silently paid for its absence at 10,000x
   the cost." Every cyclic-termination test in this repo now asserts
   elapsed time, not just the returned value.

**Main-agent independent verification beyond both subagents' own reports:**
15 hand-run checks (all 5 CHECKPOINT-style examples checked against both
resolvers directly on identical fixtures, token pinning, unreachable-DB
behavior) before accepting the resolver; full CLI verification against
real Postgres (allowed/denied, both pinning directions, impossible-token
and unreachable-DB exit-3 paths, malformed-argument exit-2 paths) before
committing the CLI wiring.

**Final state:** `npm run test:integration` — 35 of this phase's own new
tests pass (plus the 15 newly-real isolation tests), 0 failed among
anything this phase touches. (`test/unit/store/tuple-store.integration
.test.ts` — Phase 2's own testcontainers-based file — fails in this
session's sandbox because its Docker daemon isn't reachable right now;
unrelated to this phase, consistent with D-019's already-documented
limitation, not a regression.) `npm test`, lint, typecheck, format all
clean.

**Exit criteria met (build spec §9 Phase 4 — no formal CHECKPOINT, but
reported before starting Phase 5, which has one):** the production
resolver agrees with the Phase 3 reference resolver on every hand-derived
example, including a cyclic case that terminates within a bounded budget
and resolves denied.

**Open question carried forward, still unresolved:** whether Phase 4's
return shape (`{ allowed: boolean }`, matching D-020's choice for Phase 3)
needs to grow a resolution path before Phase 5's divergence reporting is
designed around it — flagged again by this phase's own delegation, not
yet settled.

## Phase 5 — Differential-soundness fuzz harness

**Owner:** `soundness-engineer` (harness core) + main agent (migration,
CLI wiring, independent verification, CHECKPOINT) + `test-author` (§10
suite, not yet dispatched as of this section being written).

**Files touched so far:**

- `src/store/migrations/0003_soundness_runs.sql` (new, committed
  separately as `02a1617`) — the `soundness_runs` table from §4, verified
  against real local Postgres (CHECK constraint, jsonb/count defaults)
  before committing.
- `src/soundness/generators.ts` (new, 941 lines) — random schema, tuple
  graph, and query generator. Fixed-role namespace sources
  (group/hierarchical/resource) hand-place all four `RewriteRule` kinds
  and exactly one guaranteed userset-subject cycle in every fixture,
  regardless of the seed's random draws elsewhere; `computeCoverageReport`
  independently re-audits this against the _compiled_ schema and the
  _actual_ tuple array rather than trusting construction intent (D-032).
  Every generated namespace name is seed-salted (D-033) to prevent a
  cross-run tuple collision from producing a spurious `false_grant`.
  `critical` is fuzz-harness-only metadata (D-031), not a DSL feature.
  `fast-check` is used only as a seeded integer-stream PRNG source
  (D-034), never via composed arbitraries/shrinking.
- `src/soundness/classify.ts` (new, 100 lines) — `classifyResult`
  (agreement → `null`, else `false_grant`/`false_deny` per §6.5, tagging
  `critical` from the generator's metadata) and `computeVerdict`
  (`falseGrantCount > 0` → `unsound` unconditionally, checked before the
  coverage check so a real finding is never masked by
  `insufficient_coverage`).
- `src/soundness/runner.ts` (new) — `runSoundnessFuzz(pool, options)`:
  generates a fixture, compiles + publishes the schema, writes every
  tuple for real, checks every query against both resolvers, classifies,
  computes the verdict, persists one `soundness_runs` row. Includes a
  `maxDepth` override option for replay/reproduction — explicitly
  documented as _not_ a fix for the cycle-guard-detection gap below
  (D-035).

**Two things built by `soundness-engineer` and caught/fixed before they
became a problem, not after — both self-reported in their own final
report, independently re-verified by the main agent:**

1. The generator's first draft reproduced D-023's raw-NUL-byte bug
   independently (same `\0`-separator idiom in a cycle-detection key,
   landing as a literal `0x00` byte instead of the two-character escape).
   Found via `file`/byte inspection, fixed, re-verified.
2. The cross-run stale-tuple hazard behind D-033 — found and fixed before
   it could ever produce a false finding, not discovered via a bad run.

**Main-agent independent verification, beyond `soundness-engineer`'s own
report:** typecheck/lint/format/unit tests all clean; a clean 5000-query
run with an independently-chosen seed (`sound`, 0/0); reproducibility
confirmed directly (`generateFixture` called twice with the same seed →
identical fixture); coverage confirmed directly (all four rewrite-rule
kinds + a cycle present in the compiled artifact); the
intersection-as-union deliberately-broken-engine proof reproduced with an
independently-chosen seed (89 false grants, `verdict: "unsound"`),
`src/resolve/production/resolver.ts` restored and confirmed byte-identical
(`md5sum` match, empty `git diff`) afterward.

**A real finding, confirmed empirically, not just theorized (D-035):**
differential fuzzing at any depth setting cannot catch a missing SQL
cycle guard, because that bug class corrupts only a query's latency, never
its returned boolean. Confirmed twice, independently: by
`soundness-engineer` at the standard production-realistic depth, and by
the main agent attempting a forced-depth workaround (`maxDepth: 20_000`,
500 queries, SQL path-array guard removed) — which did not even finish,
timing out past 300 seconds, because forcing a large depth cap inflates
the cost of _every_ query in the batch, not just the one that would
demonstrate the bug. This is a deliberate, stated division of labor, not
a gap: that bug class stays covered by the existing elapsed-time-asserting
Phase 3/4 termination tests (D-024, D-027, D-029), not by this fuzzer —
see D-035 for the full reasoning, and the Phase 5 CHECKPOINT for how this
gets reported to the user.

**`authz soundness run [--queries N] [--seed S]` (§7)** —
`src/cli/commands/soundness.ts`, wired into `src/cli/index.ts`. Maps a
`SoundnessRunResult` onto §7's exit-code table (`0` sound, `1` unsound,
`2` insufficient_coverage or a malformed argument, `3` infrastructure
failure). `--seed` falls back to `env.SOUNDNESS_FUZZ_SEED`, then to a
fresh random seed. Independently verified against real local Postgres,
not just read: a sound run persists a row and exits 0; a malformed
`--queries` exits 2; an unreachable `DATABASE_URL` exits 3; and — after
deliberately re-breaking the production resolver's intersection handling
a second time — an unsound run exits 1 and prints every divergence with
its critical flag. Resolver mutation reverted and confirmed
byte-identical each time.

**§10 test suite (`test-author`):**

- `test/isolation/differential-soundness.fuzz.test.ts` — 7 of its 9
  pre-existing `.todo()`s un-skipped in place (reproducibility, both
  asymmetric-verdict tests, rewrite-rule/cycle coverage, the reference
  resolver's own cyclic termination, and both "fuzz harness has power"
  tests). 1 stays `.todo()` (resolution path — blocked on Phase 6,
  `DivergenceRecord` has no path field yet). 1 moved out (see below).
- `test/isolation/differential-soundness.fuzz.integration.test.ts` (new)
  — the literal §9/§10 exit criterion at the real 5,000-query standard
  budget against a real `PostgreSqlContainer`. Split out of the `.fuzz
.test.ts` file specifically because that file's suffix is matched by
  the fast, Docker-free `npm test` suite (`vitest.config.ts`'s `exclude`
  only drops `**/*.integration.test.ts`), and this is the one test that
  needs the real production engine against real Postgres to mean
  anything.
- `test/unit/cli/soundness.test.ts` (new) — the two §10 "CI" exit-code
  bullets now implementable given the CLI command above. DB-free by
  design: the `false_grant → exit 1` half stands in a canned
  `SoundnessRunResult` via `vi.spyOn(runnerModule, 'runSoundnessFuzz')`
  (detection power is already proven elsewhere; this isolates only the
  CLI's own exit-code mapping), the unreachable-DB half runs the real,
  unmocked `soundnessRun` against a guaranteed-closed port.
- The "cycle detection deliberately removed" `.todo()` is un-skipped but
  **renamed**, not weakened: its original wording ("times out ... or
  reports the resulting false state — it never silently passes") is not
  achievable as an honest passing assertion at any depth, per D-035. It
  now asserts the real, verified boundary — a synthetic double with the
  userset-subject cycle guard removed but the depth cap left in place
  returns the _same_ classification as the guarded version, proving the
  fuzzer is structurally blind to this bug class by design, and that real
  coverage lives in the Phase 3/4 termination tests instead.

**Two real things `test-author` found and fixed, independently verified
by the main agent, not just trusted from the report:**

1. Independently reproduced D-023's raw-NUL-byte bug a second time (a
   `\0`-separator idiom in the synthetic test double's own cycle-key,
   same as generators.ts's own earlier instance) — found via byte-level
   inspection, fixed by switching to a `|` separator. Confirmed via `file`
   on the committed files: all render as text, none as `data`.
2. A misleading doc comment in `generators.ts`: the reserved seed query 0
   ("touches the cyclic construct, expected denied") is **not actually
   guaranteed denied by construction** — its subject (`lonelyUser`) is
   drawn from the same pool `assignRandomTuples` freely assigns elsewhere,
   so an unrelated random tuple can coincidentally grant it a real path
   for some seeds. Only query 1 (the direct grant) is truly
   unconditional. `test-author` caught this before it caused a flaky
   test (an early draft of the cyclic-termination test trusted query 0's
   boolean and would have been seed-dependent-flaky) and derived its own
   guaranteed-absent witness instead. The main agent independently
   confirmed the root cause (`lonelyUser = userIds[userIds.length - 1]`,
   same pool as `assignRandomTuples`'s own `rng.pick(userIds)`) and fixed
   the misleading comment in `generators.ts` to state the real guarantee.

**Main-agent independent verification beyond `test-author`'s own report:**
typecheck/lint/format/`npm test` clean (66 passed, 7 todo — the todo count
checked line-for-line against the pre-existing baseline, no test silently
dropped); a from-scratch, independently-written synthetic intersection-bug
script run with an independently-chosen seed (66 false grants, `unsound`,
32ms) reproducing the fuzz-power claim without reusing any of
`test-author`'s own code; a real 5,000-query standard-budget run against
real local Postgres and the real production resolver with a fresh seed
(`sound`, 0/0, exit 0, ~3s); the same real 5,000-query run repeated with
the production resolver's intersection handling deliberately broken a
third time this phase (68 false grants, all critical, `UNSOUND`, exit 1),
resolver reverted and confirmed byte-identical afterward; a direct
fail-check of the new CLI exit-code test (broke `soundness.ts`'s own
`unsound → 1` mapping, confirmed the test goes red with the exact expected
diff, reverted, confirmed byte-identical and green again).

**Not yet done as of this section being written:** a PR, and the
CHECKPOINT report itself.

**Gap `test-author` could not close, not yet independently closed
either:** the actual pass/fail and elapsed time of the new real-Postgres
integration test (`differential-soundness.fuzz.integration.test.ts`) via
`npm run test:integration` — this sandbox's Docker daemon cannot pull
`postgres:16-alpine` from the registry (same limitation as D-019/D-030;
confirmed again via the proxy's own status endpoint). The main agent's own
5,000-query real-Postgres runs above used this sandbox's local dev
Postgres fixture directly (bypassing `testcontainers` entirely), which
independently confirms the _exit criterion itself_ holds against the real
system, but does not confirm the _committed test file_ runs green — that
still needs real GitHub Actions CI, same as every other testcontainers-based
file in this repo.

**Open question carried forward:** Phase 4's resolution-path question
(above) still stands, now sharpened by the fact that `DivergenceRecord`
currently stores only the query and the two booleans, not either
resolver's resolution path; a `false_grant` report is actionable today (it
names the exact query), but showing the bogus chain the production
resolver _thought_ it found (§6.7) would make it more so — deferred, not
forgotten, likely Phase 6's concern.

**Closed by Phase 6, see its own section below:** both resolvers now grow
a resolution path, and `DivergenceRecord` now carries each resolver's own
path.

## Phase 6 — Expand + audit trail

**Owner:** `soundness-engineer` (resolution paths on both resolvers,
`expand()`, threading paths into Phase 5's `DivergenceRecord`) + main
agent (`checks` migration, `src/audit/checks.ts`, CLI wiring, independent
verification) + `test-author` (the two untested exit-criterion halves).
No formal CHECKPOINT for this phase (build spec §9) — status reported,
not a mandatory stop.

**Files touched:**

- `src/store/migrations/0004_checks.sql` (new) — §4's `checks` table, the
  audit trail. `resolution_path jsonb` (nullable — populated iff
  `allowed`), two indexes (by object, by subject, most recent first).
- `src/resolve/reference/resolver.ts`, `src/resolve/production/
resolver.ts` — both grow a resolution path (`ReferenceCheckResult
.path`/`ProductionCheckResult.path`, present iff `allowed`): a real
  evidence tree, not a linear chain or a trusted boolean. `union` records
  the one branch that succeeded; `intersection` records every branch's
  own proof; `tupleToUserset` records the followed tuple and the proof at
  its target; `exclusion` records a proof of `base` **and** a symmetric
  NEGATIVE disproof tree proving `subtract` does not hold (D-020's own
  deferred design question, settled as D-036). Field-for-field
  independent between the two resolvers (D-022's precedent) — the
  production resolver's relation-membership disproof is deliberately a
  flat reachability certificate rather than a nested tree (D-037), since
  matching shapes would mean discarding the single-round-trip recursive
  CTE for cosmetic symmetry alone. The production resolver's
  `ProductionCheckResult` also grows `depth` — the actual maximum
  recursion depth reached, across both mechanisms (D-038).
- `src/audit/expand.ts` (new) — `expand()`: the exact subject tree for an
  object#relation, including tuple-to-userset members, mirroring the
  real rewrite-rule structure. Its own cycle guard (branch-local visiting
  set + depth ceiling), matching both resolvers' established discipline
  — cycle safety here is a termination property, not a proof obligation
  the way a check's disproof leaf is (D-040).
- `src/soundness/runner.ts` — `DivergenceRecord` grows
  `referencePath`/`productionPath` (present iff that resolver's own
  boolean was true), closing the Phase 4/5 carried-forward open
  question. `buildDivergenceRecord` extracted as a pure function so this
  is unit-testable without Postgres or mutating a shipped resolver file
  at test time (D-039). `classify.ts` itself untouched.
- `src/audit/checks.ts` (new) — `performCheck`: wraps `productionCheck`,
  times it, inserts one `checks` row per call. The _only_ caller is the
  CLI's `authz check` — a fuzz run's synthetic per-query checks
  deliberately never route through it (D-041), and a failed audit-log
  write fails the whole operation rather than silently returning an
  unlogged answer (D-042).
- `src/cli/commands/check.ts` — routes through `performCheck` instead of
  `productionCheck` directly; same engine, now logged.
- `src/cli/commands/expand.ts` (new) — `authz expand <object> <relation>`
  per §7: prints the resolved subject tree, indented to show the real
  rewrite-rule structure. Functional, not polished — a real rendering is
  Phase 7/8/9's job.
- Tests (new): `test/unit/resolve/reference-resolver.resolution-path
.test.ts` (12), `test/unit/resolve/production/production-resolution-path
.integration.test.ts` (11), `test/unit/audit/expand.integration.test.ts`
  (5), `test/unit/audit/checks.integration.test.ts` (6),
  `test/unit/cli/expand.test.ts` (3), `test/unit/cli/expand.integration
.test.ts` (1), `test/unit/cli/check.integration.test.ts` (1). One
  pre-existing `test/isolation/differential-soundness.fuzz.test.ts`
  `.todo()` un-skipped (the resolution-path-in-a-divergence-report test
  this phase makes satisfiable).
- `docs/DECISIONS.md`: D-036 through D-042.

**The single largest design decision this phase:** what an exclusion's
resolution path even means. §6.7/the exit criterion only say an allowed
check's path must "independently re-verify" — nothing in the spec
addresses what that means for `a - b`, where the negative half ("`b` does
NOT hold") is exactly as load-bearing as the positive half. Settled as a
full symmetric proof/disproof scheme (D-036) — the alternative (trust the
resolver's own "subtract was false" claim) would have quietly
reintroduced the exact kind of unverified trust this whole project's
soundness claim exists to eliminate, one layer up from where §6.2 already
eliminates it.

**Two real fail-checks the main agent performed independently, not just
trusted from either subagent's report** (beyond the extensive additional
independent verification detailed in this phase's own PR/commit
messages — clean nested-group `expand()` output, a real logged check
with its resolution path inspected directly via `jsonb_pretty`, a real
5,000-query standard-budget run with resolution paths threaded through
showing no regression, a real deliberately-broken run whose persisted
`soundness_runs.divergences` row was queried directly and shown to
contain the exact bogus chain):

1. Broke `resolveRelation`'s `tupleDisproofs` recording in the reference
   resolver (dropped one `push` call) — confirmed exactly the two
   exclusion-disproof tests go red, for the expected reason, restored,
   confirmed byte-identical.
2. Disabled `expand()`'s cycle guard — confirmed a real 12+ second hang
   (killed by a hard timeout, not a stack overflow, matching the
   `await`-based walk's own design), versus sub-second guarded, restored,
   confirmed byte-identical, no lingering Postgres backends.
3. Broke `checks.ts`'s own `resolution_path` storage (forced to
   always-null) — confirmed exactly the 3 dependent tests fail, restored,
   confirmed byte-identical.

**Final state:** `npm run verify`-equivalent (format:check, lint,
typecheck, test, build) clean throughout; fast suite 82 passed (was 56 at
the start of Phase 5), 6 `.todo()` remaining (down from 15 at the start
of Phase 5 — this phase converted the resolution-path-in-a-divergence-
report test from `.todo()` to real; the 6 remaining are unrelated,
carried over from earlier phases). All new real-Postgres tests (23 across
this phase's four new/touched integration files) independently
re-confirmed against real local Postgres, since this sandbox still cannot
pull `testcontainers` images (D-019/D-030's standing limitation) — real
GitHub Actions CI is what confirms the committed files themselves run
green.

**Exit criteria met (build spec §9 Phase 6 — no CHECKPOINT):**
`expand()` returns the exact subject tree including tuple-to-userset
members (verified directly against a real nested-group graph, matching
§8's own worked example); every check, allowed or denied, is logged
(verified directly — an allowed row has a path, a denied row has a null
path); an allowed check's log entry contains a path that independently
re-verifies (two from-scratch, real-Postgres-backed verifier suites, both
proven to have power via tamper tests and fail-checks, not just shape
assertions).

**Open questions carried forward:** none new. The `checks` audit trail
is now real but nothing yet renders it for a human (Phase 7/8/9); the
`authz expand` CLI output is functional, not the polished §8 chain
notation the eventual report/screens should use.

**Closed by Phase 7, see its own section below:** the `authz expand` CLI
output stays functional/plain per its own Phase 6 scope (report/screens
polish is Phase 8/9's concern, not Phase 7's), but the soundness report
itself now has the polished §8 chain notation Phase 6 deferred.

## Phase 7 — Report + CI surface

**Owner:** `report-designer` (the four `src/report/*.ts` files) + main
agent (CLI `--format` wiring, `.github/workflows/soundness.yml`, the
PR-comment script, a real build bug found and fixed, independent
verification, CHECKPOINT) + `test-author` (the report/CI test suite).
**This phase has a mandatory CHECKPOINT** (build spec §9): "screenshot of
the bot comment on a real PR in this repo. This is the demo." — see the
CHECKPOINT report delivered to the user for the real evidence; not
repeated in full here.

**Files touched:**

- `src/report/markdown.ts` (new, 37KB) — renders a `SoundnessRunResult`
  as one GitHub-flavored-markdown document. Normalizes both resolvers'
  independently-typed `ResolutionStep`/`DisproofStep` shapes into one
  internal display tree (a downstream reporting layer, not a D-022
  isolation violation — neither resolver imports this file or is walked
  by it). A linear proof (`directGrant`/`usersetMembership`/
  `tupleToUserset`/transparent `union`) collapses to one §8-style arrow
  chain; the moment an `intersection` or `exclusion` appears anywhere in
  the tree, rendering switches to a fenced ` ```text ` block (D-043 — a
  native nested markdown list was tried first and shown, by actually
  rendering it through a real parser, to have GFM's lazy-continuation
  rule silently swallow the "excluding:" label and the closing annotation
  into the wrong branch). `false_grant` gets the one reserved bold label,
  never an emoji (D-044 — §8's own text names an emoji as an equally
  valid option, but the subagent's own stricter copy rules win).
- `src/report/json.ts` (new) — the machine-readable sibling; raw path
  trees preserved verbatim, `false_grant` fields ordered first.
- `src/report/exitCodes.ts` (new) — single source of truth for
  `verdict -> 0|1|2`.
- `src/report/prComment.ts` (new) — pure `decidePrCommentAction`, the
  update-in-place decision (§10's own named CI bullet), no GitHub API
  calls anywhere in it.
- `src/cli/commands/soundness.ts` — gains `--format text|markdown|json`;
  exit-code mapping now delegates to `soundnessExitCode`.
- `.github/workflows/soundness.yml` (new) — runs on every PR. Its own
  ephemeral Postgres `services:` container, never `secrets.DATABASE_URL`
  (D-045 — the standard 5,000-query budget would otherwise accumulate
  synthetic fuzz data in a real, shared project database forever, purely
  as a side effect of CI running; matches `ci.yml`'s own
  `test-integration` precedent of a disposable database for anything
  that writes real rows during a run).
- `scripts/post-soundness-comment.mjs` (new) — plain Node 22 script
  (built-in `fetch`, no new dependency) calling the real
  `decidePrCommentAction` to post or update the PR comment (D-046 —
  deliberately not `actions/github-script`, which would mean a second,
  divergence-prone implementation of the same decision inline in
  workflow YAML).
- `scripts/copy-migrations.mjs` (new) + `package.json`'s `build` script —
  fixes a real, previously-latent bug (D-047, see below).
- `eslint.config.js` — `scripts/**/*.mjs` added to `allowDefaultProject`
  with Node globals declared by hand, matching the treatment
  `test/**/*.ts` already gets.
- Tests (new): `test/unit/report/{exitCodes,prComment,json,markdown}
.test.ts` (4+7+7+19 = 37 tests), `test/unit/cli/soundness-format.test.ts`
  (4 tests) — all DB-free, pure.
- `docs/DECISIONS.md`: D-043 through D-047.

**A real bug found and fixed, not by inspection but by actually running
the built CLI against a genuinely fresh database (D-047):** `tsc` has
never copied `.sql` files into `dist/` — since Phase 0. This went
unnoticed through every prior phase because every migration
verification in this project's history ran `tsx` against `src/`
directly, never the _built_ `dist/cli/index.js`. Building
`.github/workflows/soundness.yml` was the first thing to actually chain
`npm run build` into running the built CLI against a database with none
of this project's tables (a GitHub Actions `services:` container starts
empty) — `doctor` reported a misleadingly successful "Migrations: 0/0
applied" while the fresh database silently had no tables at all, which
would have made every later step in the real workflow fail with a raw
`relation "..." does not exist` instead of a clear message. Reproduced
locally by creating (and, after fixing, dropping) a genuinely fresh
Postgres database for this verification specifically, not reusing this
sandbox's already-migrated dev fixture. Fixed with
`scripts/copy-migrations.mjs`, chained into `npm run build`.

**Independent verification beyond both subagents' own reports:** read
every line of `markdown.ts`'s normalization functions by hand against
both resolvers' real exported types (correct 1:1 mapping, no bugs
found); independently reproduced report-designer's own markdown-
corruption claim end to end — a from-scratch script (not reusing any of
their fixture code) publishing a real schema, writing real tuples,
calling the real production resolver against real Postgres for both an
intersection and an exclusion case, rendering both through
`renderSoundnessMarkdown`, and running the output through a real
`markdown-it` parser: both fenced blocks close correctly, the
`_(this proves ...)_` annotations render as their own paragraphs, never
swallowed; independently reproduced the D-043 regression fail-check
myself (removed the blank-line separator, confirmed exactly the two
expected tests go red, restored, confirmed byte-identical); verified all
three `--format` values plus the invalid-format exit-2 path against real
local Postgres; ran the full CI step sequence (build, doctor, soundness
run --format markdown) against a genuinely fresh database twice — once
to discover D-047, once after the fix to confirm it now works — and
again through a deliberately-broken production resolver to confirm a
real UNSOUND markdown report renders correctly end-to-end through the
CLI at exit 1 (resolver reverted, confirmed byte-identical); verified
`scripts/post-soundness-comment.mjs`'s control flow by mocking `fetch`
and exercising all three real `decidePrCommentAction` outcomes (create;
update the one real match among decoys; update-plus-delete-stale) — each
produced exactly the expected HTTP calls, methods, and URLs.

**Final state:** `npm run verify`-equivalent (format:check, lint,
typecheck, test, build) clean throughout; fast suite 123 passed (was 56
at the start of Phase 5), 6 `.todo()` remaining, unrelated to this phase.

**A pre-existing, unrelated gap noted for the record, not fixed here:**
`test/isolation/identifier-and-tuple-validation.fuzz.test.ts` has two
`.todo()`s whose own doc comment says they're blocked on a raw-string
subject parser "scheduled for Phase 7/8" — that parser
(`parseSubjectRef`, `src/cli/commands/tuple.ts`) has actually existed
since Phase 2. Stale since then; found by `test-author` during this
phase's own delegation, flagged rather than silently fixed since it's
unrelated to Phase 7's own scope (report/CI surface, not tuple
validation grammar) — worth a deliberate, separate pass, not a drive-by
fix bundled into an unrelated phase's commit. (Fixed separately: see
`fix/tuple-validation-todo-gap`, PR #17, not part of any numbered phase.)

## Phase 8 — API + GitHub checks-and-balances

**Owner:** `report-designer` (`src/api/responses.ts`/`errors.ts` — pure
response/error-shape design) + main agent (`src/api/server.ts`/`auth.ts`,
`src/cli/commands/serve.ts`, `listLatestNamespaceVersions`, independent
verification, the GitHub-governance exit criterion) + `test-author` (two
separate delegations: server/auth wiring tests, then a follow-up for the
`responses.ts`/`errors.ts` gap the first delegation itself flagged). No
CHECKPOINT required for this phase (confirmed from §9's own text).

Built in a separate git worktree (`feat/phase-8-api-surface`, off
`origin/main`) rather than the main checkout, specifically so this
phase's work never collided with two other background agents still
writing files in the main checkout at the same time (the pre-existing
`.todo()` gap fix, and this phase's own `report-designer` delegation) —
see D-048 and the session's own concurrent-agent discipline.

**Files touched:**

- `src/api/errors.ts` (`report-designer`, extended by main agent) — the
  one error envelope every route returns: `ApiErrorCode`
  (`invalid_request`/`tuple_validation_failed`/`schema_compile_failed`/
  `unauthorized`/`infrastructure_unavailable`/`internal_error`),
  `API_ERROR_STATUS`, and one constructor per code. `invalid_request`
  (400) was added by the main agent (D-052) for a case outside
  `report-designer`'s original brief: a raw HTTP body that fails Zod
  validation before it ever becomes a domain result their other
  constructors know how to fail.
- `src/api/responses.ts` (`report-designer`, untouched by main agent) —
  pure response-shape builders for all five operations:
  `checkResponse`/`expandResponse`/`tupleWriteResponse`/
  `tupleDeleteResponse`/`schemaCompileResponse`/`schemaPublishResponse`/
  `healthResponse`. `path`/`tree` pass through the real
  `ResolutionStep`/`ExpandNode` verbatim, never reshaped (same D-036/
  D-043 evidence-tree discipline extended to this layer); every status
  is a literal, never derived from the body; no route ever returns 404
  (D-049, D-053 — the one call `report-designer` flagged as genuinely
  debatable, reviewed and signed off by the main agent).
- `src/api/auth.ts` (new, main agent) — `checkAdminAuth`, the pure
  `Authorization: Bearer <key>` check. `crypto.timingSafeEqual`, not
  `===` (D-054). An unconfigured `ADMIN_API_KEY` fails every write
  closed, never open (D-050).
- `src/api/server.ts` (new, main agent) — `buildServer(pool)`: `POST
/check`, `POST /expand`, `POST /tuples` (write, admin-gated), `DELETE
/tuples` (delete, admin-gated), `POST /schema/compile` (no auth),
  `POST /schema/publish` (admin-gated), `GET /health` (no auth,
  deliberately — D-051). Unversioned, flat, RPC-shaped routes named
  after the CLI operation, not a REST resource model (D-049). Zod
  request-body validation inline; a malformed body never reaches a
  domain function. Auth is a per-route Fastify `preHandler` option, not
  a global URL-string-matched hook — declared right next to each gated
  route, not in a separately-maintained list. A framework-level
  `setErrorHandler` maps malformed JSON and any genuinely unanticipated
  error to the same `invalid_request`/`internal_error` shapes every
  other route uses.
- `src/cli/commands/serve.ts` (new) — `authz serve`; binds `0.0.0.0`
  (not Fastify's loopback-only default) since this command exists to be
  reached from outside the process. Registered in `src/cli/index.ts`.
- `src/schema/publish.ts` — gains `listLatestNamespaceVersions(pool)`:
  every namespace's latest version in one query (`distinct on
(namespace) ... order by namespace, version desc`), for `/health`.
- `package.json` — `fastify` added (pre-approved, §2's stack);
  `@fastify/rate-limit` added later in this same phase, outside §2's
  stack — asked first (rule 6), approved (D-056).
- `src/api/server.ts`/`errors.ts` — `@fastify/rate-limit` registered
  globally (100/min default), overridden per-route (300/min `/health`,
  20/min on the three `ADMIN_API_KEY`-gated write routes), closing a
  real CodeQL finding (`js/missing-rate-limiting`, high severity) on
  `/health` found by CI on this phase's own PR. `buildServer` became
  `async` as part of this fix — see D-056 for the real integration bug
  (an un-awaited plugin registration silently rate-limited nothing) this
  surfaced and fixed. New `rate_limited` `ApiErrorCode` (429).
- Tests (new): `test/unit/api/auth.test.ts` (10), `server.test.ts` (22,
  fast/DB-free, mocked `pool` + `vi.spyOn` on every domain module),
  `server.integration.test.ts` (4, real `PostgreSqlContainer`, no
  mocks — the genuine end-to-end proof of both of this phase's own exit
  criterion clauses), `errors.test.ts` (22), `responses.test.ts` (34),
  `rate-limit.test.ts` (2, written directly by the main agent, not
  delegated) — 90 new tests total.
- `docs/DECISIONS.md`: D-048 through D-056.

**A real, self-identified gap, closed within this same phase rather than
carried forward:** the first `test-author` delegation (server/auth
wiring) explicitly flagged that `src/api/responses.ts`/`errors.ts` — the
`report-designer`-authored pure response-shape modules — had no unit
tests of their own anywhere in the repo, since `server.test.ts`
deliberately only tests `server.ts`'s _wiring_ of them. A second,
narrowly-scoped `test-author` delegation closed this immediately (56
tests: `errors.test.ts` + `responses.test.ts`), rather than letting it
sit as a documented-but-open gap the way the tuple-validation `.todo()`s
did across Phases 2-7.

**A real gap this session could not close, honestly reported rather than
worked around:** `server.integration.test.ts` — the file proving both of
this phase's own literal exit-criterion clauses ("`/health` reports
green", "an unauthenticated write attempt is rejected") against a real
database — could not run inside `test-author`'s own sandbox: Docker's
registry CDN is egress-blocked there (confirmed environment-wide, not
file-specific, by reproducing the identical failure against an
already-passing sibling integration test). The main agent independently
ran it for real via this project's own established LOCALVERIFY
technique — copied to a `LOCALVERIFY-`-prefixed sibling, swapped
`PostgreSqlContainer` for this sandbox's real local Postgres fixture,
ran all 4 cases for real (all passed, including the real
unauthenticated-write-writes-nothing and real-`/health`-reflects-a-real-
publish assertions), then deleted the copy — never committed. The
committed file itself is untouched and identical to what `test-author`
wrote; only this session's local verification method differed from what
CI will actually do (CI's own `test-integration` job runs in an
environment with real Docker access, per `.github/workflows/ci.yml`'s
existing job, so the committed file is expected to run for real there).

**Independent verification beyond both subagents' own reports:** read
`report-designer`'s `responses.ts`/`errors.ts` in full and verified
every type they import against the real, current exported shape of
`src/audit/checks.ts`, `src/audit/expand.ts`, `src/store/tuples.ts`,
`src/schema/dsl/errors.ts`, `src/schema/dsl/types.ts`, and
`src/schema/publish.ts` — no mismatch found; ran the full built server
for real against real local Postgres (not mocks) and hit every route
with `curl`: schema compile/publish, tuple write/delete, `check` (a real
multi-hop resolution path through a group membership, structurally
verified), `expand`, confirmed unauthenticated and wrong-key writes are
rejected with the underlying database showing zero new rows (checked
directly via `psql`, not inferred from the HTTP response alone), and
confirmed `/health` goes `503` with an empty namespace list when
`DATABASE_URL` is unset entirely, `200` with the real, current namespace
list otherwise; independently fail-checked two claims myself beyond
what either `test-author` delegation already fail-checked on its own —
removed the `preHandler` auth gate from the `POST /schema/publish` route
registration itself (not the auth function — the route _wiring_),
confirmed exactly the two expected "never called" tests failed for the
right reason (the route actually reached `publishSchema`), restored,
confirmed byte-identical; and independently broke `healthResponse`'s
defensive-copy behavior (`namespaces: [...namespaces]` → `namespaces`),
confirmed exactly the one expected "mutating the input array after the
call has no effect" test failed, restored, confirmed byte-identical.

**GitHub governance — Phase 8's other exit criterion (D-055):**
confirmed applied. No available tool can read branch-protection-rule/
ruleset, Dependabot auto-merge, or Code-security-and-analysis settings
directly (confirmed via a real `ToolSearch` — genuine gap, not assumed).
One piece was independently, directly confirmed by this session's own
tooling regardless: "require conversation resolution before merging" is
genuinely active, proven by a real blocked-merge `405` error encountered
on PR #16 in Phase 7. For the rest, asked the repo owner directly rather
than deferring; the owner worked through `docs/github-governance.md`'s
Steps 1-4 in the GitHub UI and confirmed completion.

**Final state:** `npm run verify`-equivalent (format:check, lint,
typecheck, test, build) clean throughout; fast suite 215 passed (up from
123 before this phase), 6 `.todo()` remaining (all pre-existing,
unrelated to Phase 8). Real built-CLI smoke test confirmed real
`x-ratelimit-limit`/`x-ratelimit-remaining` headers on `/health` against
real local Postgres.

**Open questions carried forward:**

- The one genuinely debatable design call this phase made
  (`no_published_schema` → 400, never 404) is recorded and signed off
  (D-053), but revisit if a future phase adds a real
  resource-fetch-shaped endpoint (e.g. `GET /namespaces/:ns`).
- `server.integration.test.ts` has run for real in this session (via
  LOCALVERIFY) but not yet inside actual CI — first CI run on this
  phase's PR is the first time it runs in the environment it was
  actually written for (a real Docker-backed `test-integration` job).

## Phase 9 — Screens, example schema, docs, demo

**Owner:** main agent (`schema/example.authz`, `scripts/seed-example.ts`,
`docs/RELATIONS.md`, `docs/CONSISTENCY.md`, `docs/DELIVERY.md`, the
README rewrite, all independent verification) + `report-designer` (the
five `docs/screens/*.html` mockups, one agent per screen) + `test-author`
(the demo-graph structural-verification test). No CHECKPOINT required
for this phase (confirmed from §9's own text) — still followed this
project's own established "report before merging" pattern from every
prior non-CHECKPOINT phase (2, 4, 6, 8): this phase's PR is opened and
reported, not merged, until the user says so.

Built in a separate git worktree (`feat/phase-9-screens-example-docs`,
off `origin/main`), matching Phase 8's own concurrent-agent discipline —
the six-agent `report-designer`/`test-author` fan-out (below) ran
entirely inside this worktree, isolated from the main checkout.

**Files touched:**

- `schema/example.authz` (new, 88 lines) — the Phase 9 demo schema: all
  four namespaces (`org`/`group`/`folder`/`document`) in one file, so
  `authz schema publish schema/example.authz` publishes all of them in
  one command (D-057). Deliberately exercises all five real mechanics —
  union, exclusion (`org.view = member - banned`), intersection
  (`folder.sensitive_review = (viewer|edit) & sensitive_reviewer`),
  tuple-to-userset (`parent->edit`/`parent->view`), and nested-group-as-
  subject — not just the one §9 Phase 9 names by name (D-058). Phase 1's
  own `schema/{document,folder,group,org}.authz` are untouched, kept as
  historical CHECKPOINT evidence (D-057).
- `scripts/seed-example.ts` (new, `.ts`, run via `npx tsx`/
  `npm run seed:example`) — publishes the real schema and writes a real
  22-tuple graph (6 org members incl. one banned, two levels of nested
  groups, a folder hierarchy with a mix of direct and inherited grants,
  an intersection case). `tsconfig.json`'s `include` extended to cover
  `scripts/**/*.ts` (confirmed `tsconfig.build.json` has its own separate
  `include`, so this doesn't leak into `dist/`) so this file gets full
  project-service type-checking, not ESLint's loose fallback. Found and
  fixed live: every hyphenated demo id (`eng-backend`, `finance-docs`, …)
  was rejected by `IDENTIFIER_PATTERN` the moment the script actually ran
  against real Postgres — fixed to underscores throughout (D-059).
- `docs/RELATIONS.md`, `docs/CONSISTENCY.md` (new) — the two plain-
  language docs §9 Phase 9 names explicitly, every example pulled from
  the real `schema/example.authz`/real check-and-expand output, never
  invented. `docs/CONSISTENCY.md`'s test citations were caught and fixed
  before finalizing: an initial draft cited invented literal test names
  that don't exist verbatim anywhere in `test/`; replaced with the real
  `it()` description strings from
  `test/isolation/permission-resolution.integration.test.ts` and
  `test/unit/resolve/production/production-check-behavior.integration.test.ts`,
  found by grep, not memory.
- `docs/DELIVERY.md` (new) — §13's content. Not named explicitly by §9
  Phase 9's own paragraph, but listed in §3's repo layout with no other
  phase claiming it, and Phase 9 is the last "docs, demo" phase this
  build spec has (D-061).
- `docs/screens/{namespaces,tuples,check,soundness,expand}.html` (new,
  6,774 lines total) — the five screens per §8, one `report-designer`
  agent per screen, dispatched together via a `Workflow` fan-out (below).
  Every id, tuple, check result, resolution path, and soundness run shown
  is real, captured directly from this repo's own CLI/API against
  `schema/example.authz`, never invented; where a screen had no captured
  data for a case, it says so rather than filling the gap (confirmed
  independently — see verification below). `docs/screens/README.md`
  (new, main agent) — a short index explaining these are static mockups,
  not a live app, and pointing back to the README's own "try it
  yourself" section for reproducing the underlying data.
- `test/unit/demo/example-schema.integration.test.ts` (new, new
  directory, `test-author`) — publishes the real `schema/example.authz`
  and writes a hand-transcribed 22-tuple `DEMO_TUPLES` graph, with a
  parity test that re-parses `scripts/seed-example.ts`'s own source text
  at run time and asserts byte-for-byte match, so the two can never
  silently drift. Asserts `check(user:dana, edit, document:eng_handbook)`
  structurally, field-by-field down the full resolution path (union →
  tupleToUserset → union → usersetMembership → usersetMembership →
  usersetMembership → directGrant) — not a bare `allowed === true` — plus
  a negative control (`user:bob`, denied, no path).
- `README.md` (fully rewritten per §12's exact structure) — failure-
  first opener, the real 5-hop `dana` chain as the headline resolution-
  path example, the real "SOUND — 0 false_grant, 0 false_deny, across
  5,000 queries" result stated before any feature list, a "Try it
  yourself — under 10 minutes" section with the exact real commands, an
  honest note about `authz soundness run` writing real rows into
  whatever database it's pointed at (D-060), "How it works" linking the
  two new docs, honest positioning naming SpiceDB/OpenFGA/Ory Keto and
  linking `docs/DELIVERY.md`, the full CLI/API reference, and an updated
  repository layout.
- `docs/DECISIONS.md` — D-057 through D-062 (this phase's six entries,
  below).

**Real fan-out, real captured data, not invented content:** before
dispatching any subagent, the main agent ran the real CLI/API against
`schema/example.authz` and the real seeded graph and captured every
output to a `.captures/` staging directory (schema source, compiled
JSON, `/health`, four real `check` responses spanning all three
outcomes worth showing — allowed/denied/exclusion-denied/intersection —
two real `expand` trees, and two real, independent `authz soundness run`
results with their real seeds). All six subagents (five `report-designer`,
one `test-author`) were dispatched together via a single `Workflow`
`parallel([...])` fan-out, each given the same real capture pointers plus
a per-screen brief, and required to cite a real capture file for every
concrete value they used rather than inventing one. `.captures/` was
deleted before committing — staging data, never committed, matching this
project's own LOCALVERIFY-never-committed precedent.

**Independent verification performed by the main agent, not trusted from
any subagent's own report alone:**

- A from-scratch Python `html.parser` tag-balance checker run personally
  against all five screen files — zero unclosed/mismatched tags on all
  five — plus `npx prettier --check docs/screens/*.html`, clean.
- Grep-confirmed the headline `dana` chain (`…eng_backend_interns#member
→ …eng_backend#member → …eng#member → folder:eng_docs#editor →
document:eng_handbook#edit`) actually appears on `check.html`/
  `expand.html`/`namespaces.html`; confirmed the complete set of user ids
  referenced across all five screens is exactly the real six-person cast
  (`alice, bob, carol, dana, erin, mallory`) — zero fabricated identities;
  confirmed `tuples.html` renders exactly 22 rows (the real seeded
  count); confirmed `namespaces.html` renders the real exclusion and
  intersection rewrite rules verbatim against `compiled-schema.json`;
  confirmed `soundness.html` contains both real captured seed strings (10
  total occurrences) and the `FALSE_GRANT` badge markup.
- Redid, properly, an emoji-adjacency check on `soundness.html`'s
  `FALSE_GRANT` styling that had initially failed to execute (a Python
  regex error) rather than accepting its inconclusive fallback output:
  read the actual surrounding HTML directly and confirmed the badge CSS
  (`text-transform: uppercase`, `font-weight: 700`, solid `--alert`
  fill) and every nearby line are plain text — no emoji anywhere near any
  `FALSE_GRANT` reference, and `.badge-false-deny` uses the muted,
  bordered, unfilled treatment — matching this project's own established
  asymmetric-severity convention (D-044) exactly.
- Ran the real, committed `test/unit/demo/example-schema.integration.test.ts`
  directly — not the subagent's own scratch-copy report — via this
  project's established LOCALVERIFY technique (copied to a
  `LOCALVERIFY-`-prefixed sibling, swapped `PostgreSqlContainer` for this
  sandbox's real local Postgres, ran for real, deleted the copy, never
  committed): all 3 tests passed against a freshly-reset real database.
  Performed an independent fail-check of its own, distinct from
  `test-author`'s three already-performed fail-checks: edited the real,
  committed `scripts/seed-example.ts` (not the test's own copy) to
  change one real tuple's subject (`user:dana` → `user:dave`), reran, and
  confirmed the parity test failed with a precise, correctly-located
  diff — proving the byte-for-byte drift check genuinely catches drift
  in the real committed source, not just in a private copy of it.
  Restored the file and confirmed byte-identical restoration via
  `md5sum` before and after.
- Ran the complete `npm run verify` pipeline (format:check, lint,
  typecheck, test, build) against the full, final worktree state — every
  new file together, not piecemeal — clean throughout: 217 tests passed,
  4 `.todo()` remaining (all in `test/isolation/`, pre-existing, see
  D-062), build clean.
- Independently re-ran the exact README-documented "try it yourself"
  flow end-to-end (`doctor` → `seed:example` → `check` → `expand` →
  `soundness run`) from a freshly, fully wiped local database (`drop
schema public cascade`) — completed in 6.41 real seconds, verdict
  SOUND, 0 false_grant / 0 false_deny across 5,000 queries — reconfirming
  the README's claims with a fresh run, not the same run already cited
  in the README's own text.

**A real, disclosed gap, found and then closed on the same PR:** four
`test/isolation/identifier-and-tuple-validation.fuzz.test.ts` `it.todo()`s
remained open with Phase 9 being the last phase this build spec names, so
there was no further phase left to attribute them to — recorded honestly
per D-062 rather than left unmentioned. Per direct user instruction ("fix
the open gap"), dispatched a second `test-author` delegation to
un-skip and implement all four for real: a DB-free SQL/DDL-splicing
proof across `publishSchema`/`writeTuple`/`deleteTuple`, and two 2,000-run
`fast-check` property tests plus a deterministic boundary case against
the identifier grammar. Writing the namespace-name property surfaced a
real, narrow gap between the _published_ grammar
(`IDENTIFIER_PATTERN`/`MAX_IDENTIFIER_LENGTH`) and what the parser
actually enforces (`namespace`/`relation`/`permission` are reserved
words despite matching the pattern) — folded correctly into the test's
own oracle, and `IDENTIFIER_PATTERN`'s doc comment updated to state it
explicitly. Independently verified by the main agent (not accepted from
`test-author`'s report alone): read the full diff; ran the file directly
(11/11 passed, zero `it.todo()` left anywhere in `test/isolation/`); ran
the full `npm run verify` pipeline (221/221, up from 217/4-todo);
performed an independent fail-check of my own, distinct from
`test-author`'s own four, targeting a different source location
(`parser.ts`'s own length-boundary check) and confirmed byte-identical
restoration via `git diff`/`md5sum`. Full detail in D-062's own
resolution note.

**Final state:** `npm run verify` clean (format:check, lint, typecheck,
221 tests passed, 0 todo, build); the real demo-graph integration test
passes against real local Postgres (verified directly, twice, including
one independent fail-check); all five screens independently confirmed
well-formed, prettier-clean, and grounded in real captured data; the
full README-documented 10-minute flow independently re-run end-to-end
from a clean database in 6.41 seconds with a genuine `SOUND` verdict;
zero `it.todo()` remaining anywhere in `test/isolation/`.

**Open questions carried forward:**

- `authz soundness run` writing real rows into whatever database it's
  pointed at (including a stranger's own freshly-seeded demo database)
  is disclosed plainly in the README rather than engineered around
  (D-060) — revisit if a future `--dry-run` mode or a documented
  disposable-database convention makes the walkthrough's own advice
  worth changing. **Resolved 2026-08-16 — see the section below.**

## `authz soundness run --dry-run` (D-063, closing D-060)

**Owner:** main agent (`deletePublishedNamespaceVersion` in
`src/schema/publish.ts` — schema-config plumbing, own turf; CLI wiring in
`src/cli/commands/soundness.ts`/`src/cli/index.ts`; README/DECISIONS/
PROGRESS; all independent verification) + `soundness-engineer` (the
`dryRun` orchestration itself in `src/soundness/runner.ts`) +
`test-author` (the real-Postgres integration test). Not a numbered build
phase — the build spec's own 9 phases are complete; this closes the one
open item left on record (D-060's own "revisit if"), per direct user
instruction ("fix what is open").

**What it does:** `authz soundness run --dry-run` runs the exact same
real differential-fuzz cycle as always — real schema publish, real tuple
writes, real checks against both resolvers, the exact same verdict — and
then deletes every row it created (the `soundness_runs` row, every
generated tuple, every published namespace version) before returning, so
the database ends the call exactly as it started. `write_log` is
deliberately untouched (an honest ledger of writes that really
happened). The README's "try it yourself" walkthrough now uses
`--dry-run` by default, closing the friction D-060 originally disclosed
rather than engineered around.

**Files touched:**

- `src/schema/publish.ts` — new `deletePublishedNamespaceVersion(pool,
namespace, version)`, the first (and only) place this codebase ever
  deletes a `namespace_configs` row, narrowly scoped to this one caller
  and documented as such.
- `src/soundness/runner.ts` — `SoundnessRunOptions.dryRun`, a
  `cleanupDryRunArtifacts` helper (best-effort, every deletion category
  attempted independently, never masks a genuine run failure already in
  flight), and `runSoundnessFuzz`'s body wrapped in `try`/`catch` (not a
  plain `finally` — see the in-code comment on why a `finally` that
  itself throws would silently replace an in-flight error). Non-dry-run
  path provably unchanged.
- `src/cli/commands/soundness.ts`, `src/cli/index.ts` — `--dry-run` flag,
  one extra honest line in `--format text` output only (`--format
markdown`/`json`'s "stdout is exactly the report" contract, which CI's
  PR-comment capture depends on, is untouched either way).
- `test/unit/soundness/dry-run-cleanup.integration.test.ts` (new
  directory) — 5 real-Postgres tests: exact row-count preservation
  (namespace_configs/relation_tuples/soundness_runs unchanged, the
  specific inserted-then-deleted row and the specific generated
  namespace/tuple rows confirmed gone, not just aggregate totals);
  same-seed dry-run vs. real-run byte-identical computed results (the
  single most important assertion — catches a dry-run that silently
  weakens the actual comparison, which the persistence checks alone
  wouldn't); normal persistence still works for a real run; `write_log`
  correctly grows by `2×tupleCount` rather than staying flat or being
  pruned; explicit `dryRun: false` and omitted `dryRun` both behave
  identically to each other and to today's pre-existing default.
- `README.md` — "try it yourself" now uses `--dry-run`; CLI reference
  table updated.
- `docs/DECISIONS.md` — D-063 (new), D-060 marked resolved with a
  cross-reference.

**A real, disclosed test-coverage gap, found and explained, not
papered over:** neither `test-author`'s integration test nor any other
automated test in this repo proves "cleanup still runs for whatever was
created when the run itself fails partway through" against a genuine,
deterministically-triggered failure reached only through
`runSoundnessFuzz`'s own public API with zero source changes —
investigated directly and found not reliably achievable that way (every
throw site is only reachable from a fixture the generator's own
self-consistency guarantees can never actually produce; the one real
race available, two concurrent same-seed calls, isn't deterministic
enough to build a non-flaky test on). This case is instead validated by
the main agent's own manual fail-checks against the real, committed
source (below) — a real, honest choice not to fake automated coverage
for a case that can't be triggered honestly through the public surface.

**Independent verification performed by the main agent, not accepted
from either subagent's report alone:**

- Read the full diff of both subagents' work directly.
- Ran a same-seed dry-run-vs-real comparison against real local
  Postgres myself (distinct from `test-author`'s own, using a different
  seed and query count): `falseGrantCount`/`falseDenyCount`/`verdict`
  byte-identical between the two calls; `namespace_configs`/
  `relation_tuples`/`soundness_runs` counts exactly unchanged after the
  dry run; a real, non-dry-run call with the same seed persisted
  normally afterward.
- Performed an original fail-check on `src/schema/publish.ts`'s new
  function, distinct from `soundness-engineer`'s own four: forced
  `deletePublishedNamespaceVersion` itself to always fail while leaving
  tuple/soundness_runs cleanup untouched — confirmed the real database
  ended up exactly as the "each cleanup category is independent" design
  predicts (`relation_tuples`/`soundness_runs` correctly returned to
  zero, `namespace_configs` correctly retained exactly the rows whose
  deletion was forced to fail, the thrown `AggregateError` named exactly
  those failures) — then restored and confirmed byte-identical via
  `md5sum`.
- Ran `test-author`'s real, committed integration test myself via this
  project's established LOCALVERIFY technique (real local Postgres, not
  the subagent's own scratch-copy report) — 5/5 passed. Performed an
  original fail-check of my own against that exact committed test and
  the real, committed `runner.ts` (not a scratch copy): changed
  `options.dryRun ?? false` to `options.dryRun ?? true` (a real,
  plausible wrong-default bug) and confirmed exactly and only the
  "explicit `false` vs. omitted" test failed — the other four,
  including the explicit `dryRun: true`/`false` tests, stayed correctly
  green, precisely isolating the fault. Restored, confirmed
  byte-identical via `md5sum`, reran clean.
- Smoke-tested the real CLI against real Postgres directly: `--dry-run`
  alone (zero row-count change, exit 0, honest text note printed),
  `--dry-run --format markdown` (confirmed the dry-run note does NOT
  leak into markdown output, preserving the contract
  `.github/workflows/soundness.yml`'s PR-comment capture depends on),
  and a plain non-dry-run run (regression check — rows persist exactly
  as before this change).
- Ran the complete `npm run verify` pipeline against the full, final
  worktree state: clean throughout (format:check, lint, typecheck, 221
  tests passed, build).

**Final state:** `npm run verify` clean; the new dry-run mechanism
independently proven against real Postgres by two different fail-check
approaches on top of the implementing/testing subagents' own; the
README's walkthrough now leaves zero trace by default; D-060's "revisit
if" fired and is closed.

## API auth-gating and dry-run cleanup fixes (D-064, D-065, D-066)

**Owner:** main agent (all three findings — API/CLI surface, own turf).
Not a numbered build phase — a full-repo audit (2026-08-16) found three
HIGH-severity findings this entry closes, part of the batch the direct
user instruction "fix the critical and high findings" covers.

**Finding #4 — `/check`/`/expand` unauthenticated (D-064):**
`requireAdminAuth` now gates `/check` and `/expand` in
`src/api/server.ts`, exactly as it already gated the three write routes.
Both get a new, more generous rate-limit budget (`gatedReadRateLimit`,
200/minute) than writes' 20/minute. `/schema/compile` and `/health`
remain the only unauthenticated routes — both answer questions about the
caller's own supplied input or non-sensitive schema metadata, never the
real tuple graph.

**Finding #5 — rate-limit counted before auth ran (D-065):** every
gated route's `config.rateLimit` now sets `hook: 'preHandler'`
(`@fastify/rate-limit`'s own option, default `onRequest`), confirmed by
reading the installed plugin's own source
(`node_modules/@fastify/rate-limit/index.js`'s `addRouteRateHook`) to
append onto the route's already-declared `preHandler: requireAdminAuth`
rather than run as an earlier, separate hook — so a flood of failed-auth
requests can no longer exhaust a route's rate-limit budget before ever
being compared against the real key. `trustProxy: true` added to the
`Fastify(...)` constructor so `request.ip` (the rate-limiter's default
key) resolves from `X-Forwarded-For` behind a reverse proxy (Railway),
rather than collapsing every real caller onto the proxy's own shared
budget.

**Finding #7 — a dry-run cleanup failure could discard a real,
already-computed verdict (D-066):** `runSoundnessFuzz`'s
(`src/soundness/runner.ts`) success-path `cleanupIfDryRun()` call is now
wrapped in its own `try`/`catch` — a cleanup failure is logged via
`console.error`, never thrown, so it can no longer fall into the
function's own outer `catch` and get mapped by
`src/cli/commands/soundness.ts` to exit code 3
("infrastructure failure — no verdict exists") for a run that actually
succeeded, possibly with a critical `unsound`/`false_grant` verdict that
was about to be silently lost.

**Files touched:**

- `src/api/server.ts` — `trustProxy: true`; `hook: 'preHandler'` on
  `writeRateLimit`; new `gatedReadRateLimit`; `/check`/`/expand` gated
  with `requireAdminAuth`.
- `src/api/auth.ts` — doc comment updated (no functional change) to
  drop the write-exclusive framing now that `requireAdminAuth` gates
  five routes, not three.
- `src/soundness/runner.ts` — success-path cleanup wrapped in
  `try`/`catch`; doc comments updated.
- `test/unit/api/server.test.ts` — extensive updates for the new
  auth contract on `/check`/`/expand` (renamed describe blocks, new
  positive/negative auth cases), plus a new dedicated regression test
  proving D-065: 25 wrong-key requests against `POST /tuples` (five past
  `writeRateLimit`'s own `max: 20`) all return 401 (never 429) and never
  call `writeTuple`, then a request with the correct key right after
  still succeeds.
- `test/unit/api/server.integration.test.ts` — added auth headers to
  the three `/check`/`/expand` calls that previously ran unauthenticated
  (now correctly required); re-verified against real local Postgres via
  this project's established LOCALVERIFY technique.
- `test/unit/soundness/runner-dry-run-cleanup-failure.test.ts` (new) —
  DB-free, mocks every I/O dependency `runSoundnessFuzz` has to force a
  successful dry run whose cleanup then fails; proves the real result is
  still returned and the failure is logged, not swallowed or thrown.
- `docs/DECISIONS.md` — D-064, D-065, D-066.

**Verification:**

- `test/unit/api/server.test.ts`: 27/27 passing (was 26; +1 new
  regression test for D-065).
- `test/unit/api/server.integration.test.ts`: 4/4 passing against real
  local Postgres via LOCALVERIFY (copied, connection string swapped,
  run for real, deleted — never committed).
- `test/unit/soundness/runner-dry-run-cleanup-failure.test.ts`: 2/2
  passing. Fail-checked directly: reverted the `try`/`catch` back to a
  bare `await cleanupIfDryRun();`, confirmed the test fails for the
  right reason (the simulated cleanup error propagates uncaught instead
  of being logged and swallowed), restored, confirmed byte-identical via
  `md5sum`.
- `npx tsc --noEmit`, `npx eslint`, `npx prettier --check` all clean on
  every touched file.

**Final state:** all three findings closed; `test/unit/api/server.test.ts`
and the new soundness unit test both pass, the integration test
re-verified live against real Postgres, and the dry-run cleanup fix's
fail-check confirms the regression it closes is real and now caught.

## Schema DSL unbounded-recursion DoS fix (D-067)

**Owner:** `schema-compiler` (the actual parser/compiler fix, its
regression test) + main agent (independent live re-verification,
`docs/DECISIONS.md`/`PROGRESS.md`, review). Not a numbered build phase —
a full-repo audit (2026-08-16) found two independent, unauthenticated
denial-of-service paths in `src/schema/dsl/` reachable from `POST
/schema/compile`, both HIGH severity; this closes one of them (the
critical + high finding set the direct user instruction "fix the
critical and high findings" covers).

**What was wrong:** `parser.ts`'s `parseAtom`/`parseTerm`/
`parseExpression` (mutually recursive, one native call-stack frame per
level of `(` nesting) threw a raw, unhandled `RangeError` at ~3,000
nested parens. Independently, `compiler.ts`'s `checkCircularPermissions`
walked its permission-dependency graph via a second, structurally
separate native recursion (`dfs`, one frame per chain edge in a flat
`permission pN = pN+1` chain) that overflowed on its own between 5,000
and 10,000 permissions — confirmed by a captured stack trace to never
touch the parser at all, proving a paren-only fix would have left this
second path open.

**The fix:**

- `src/schema/dsl/types.ts` — new `MAX_EXPRESSION_NESTING_DEPTH = 100`.
- `src/schema/dsl/errors.ts` — new `SchemaErrorCode`,
  `'expression_nesting_too_deep'`.
- `src/schema/dsl/parser.ts` — `ParserState.parenDepth`, checked in
  `parseAtom` on every `(`; past the ceiling, throws the existing
  `SchemaParseError` machinery instead of letting native recursion run
  unbounded.
- `src/schema/dsl/compiler.ts` — `checkCircularPermissions`'s `dfs`
  rewritten from native recursion to an explicit iterative worklist
  (`dfsFrom`/`DfsFrame`), removing the native-recursion depth limit
  entirely (the right fix here, since there's no principled reason to
  cap a legitimate acyclic permission chain's length, unlike `(`
  nesting).
- A second, latent bug found live while load-testing the iterative
  rewrite: `reportCycle` rebuilt the same `cycle.join(' -> ')` string
  once per cycle member — O(N²), invisible before because the recursive
  `dfs` always stack-overflowed first at N≈5,000-10,000. Fixed by
  hoisting the join outside the loop (20,000-permission cycle: 33.8s →
  140ms; 100,000-permission cycle: OOM crash → ~800ms).
- `test/unit/schema/recursion-depth-guards.test.ts` (new) — the paren
  ceiling accepted at exactly 100 / rejected at 101 / rejected cleanly at
  6,000; a 10,000-permission legitimate acyclic chain compiling
  successfully and fast; a 10,000-permission adversarial flat cycle
  rejected cleanly with exactly 10,000 located errors, fast.

**Verification, independent of the implementing subagent's own report:**

- Read the full diff by hand — confirmed the `parenDepth` counter is
  incremented/decremented at exactly the right points, and that the
  iterative `dfsFrom` rewrite preserves the original recursive `dfs`'s
  GREY/BLACK coloring, shared-`path` semantics, and cycle-reporting
  exactly (frames pushed/popped in lock-step with `path`, deps snapshot
  taken at push time).
- Ran the full existing suite myself in the subagent's own worktree:
  `npx vitest run` — 226/226 passed, zero DB required; `npx tsc --noEmit`,
  `npx eslint .`, `npx prettier --check` all clean.
- Performed an original live spot-check, independent of the subagent's
  own 255-case differential comparison and fail-check: compiled a fresh
  4,000-nested-paren schema and a fresh 7,000-permission adversarial flat
  cycle directly against the built compiler — both rejected cleanly
  (`expression_nesting_too_deep`, `circular_permission_definition`
  respectively), the cycle case in 68ms with exactly 7,000 located
  errors, and confirmed a small legitimate schema still compiles
  correctly.
- Renumbered the subagent's own `docs/DECISIONS.md` entry from D-064 to
  D-067 before merging — D-064/D-065 were independently claimed in
  parallel by the main agent's own concurrent auth-ordering fix on a
  different branch; caught before push, not after.

**Final state:** `npm run verify`-equivalent checks clean throughout;
both DoS paths independently confirmed closed via a live, original
reproduction distinct from the implementing subagent's own; pushed as
its own branch/PR, per this project's one-fix-per-PR convention for this
audit's findings.

## An infrastructure failure never leaves the soundness PR comment silently blank (D-068, full-repo-audit HIGH finding #8)

**Owner:** a dedicated fix-agent, on branch `fix/soundness-ci-silent-failure-report`, scoped to exactly this one finding from the 2026-08-16 full-repo audit (one of several parallel audit-fix branches; not a numbered build phase).

**What was wrong, confirmed live before fixing:** `soundnessRun` (`src/cli/commands/soundness.ts`) reaches exit code 3 ("infrastructure failure") from two places — `runSoundnessFuzz` throwing (DB unreachable, a generator bug, ...), and its own `DATABASE_URL`-not-set early return — and both printed the real error to **stderr only**, leaving **stdout completely empty**. `.github/workflows/soundness.yml`'s "Run soundness fuzz" step captures `--format markdown`'s stdout verbatim into `soundness-report.md` (`node dist/cli/index.js soundness run --format markdown > soundness-report.md`), and `scripts/post-soundness-comment.mjs` reads that file as the literal PR-comment body, posting it or PATCHing the _existing tracked_ comment (matched via `SOUNDNESS_REPORT_MARKER`) unconditionally. A 0-byte report file therefore either posted a blank PR comment, or — worse — silently blanked the last known-good, already-tracked soundness comment, with no evidence of failure visible to a human reading the PR thread. (The CI job's own pass/fail state was never the bug: `.github/workflows/soundness.yml`'s final step already fails the job on a non-zero exit code regardless.) Reproduced directly: built the CLI, ran it against `DATABASE_URL="postgres://user:pass@127.0.0.1:1/nonexistent" ... --format markdown > soundness-report.md` — confirmed `soundness-report.md` was a genuine 0-byte file, exit code `3`, stderr the only place the real error appeared.

**What it does now:** Both exit-3 call sites in `soundnessRun` route through a new `printInfrastructureFailure(format, message)` helper. For `--format markdown`, it prints a new, honest markdown message (`renderSoundnessInfrastructureFailureMarkdown`, `src/report/markdown.ts`) that starts with `SOUNDNESS_REPORT_MARKER` (so `decidePrCommentAction` still recognizes and updates the same tracked comment on the next successful run, rather than orphaning it and creating a new one), names an `INFRASTRUCTURE_FAILURE` headline distinct from any real verdict word, states plainly that no verdict was produced and `0 false_grant` is not being claimed, and includes the real error text. For `--format json`, it prints a new, honestly-different shape (`SoundnessInfrastructureFailureJson` — `{ status: 'infrastructure_failure', message }`, `src/report/json.ts`) rather than a `SoundnessJsonReport` with zeroed-out fields, so a consumer checking `verdict === 'sound'` can never mistake this for a clean pass. `--format text` is unchanged (stderr-only, as before — nothing in this repo captures its stdout as a report body). As a second, narrow layer, `scripts/post-soundness-comment.mjs` now refuses to call the GitHub API at all if the report file is empty-or-whitespace-only (checked directly, never by a length heuristic, so a legitimately short `sound` result is never mistaken for a failure).

**Files touched:**

- `src/cli/commands/soundness.ts` — `printInfrastructureFailure` helper wired into both exit-3 call sites; top-of-file doc comment updated to document the new exit-3 stdout contract.
- `src/report/markdown.ts` — new `renderSoundnessInfrastructureFailureMarkdown(message)`.
- `src/report/json.ts` — new `SoundnessInfrastructureFailureJson` type and `renderSoundnessInfrastructureFailureJsonString(message, pretty?)`.
- `scripts/post-soundness-comment.mjs` — refuses an empty/whitespace-only report body before calling the GitHub API; doc comment updated.
- `test/unit/cli/soundness-infrastructure-failure.test.ts` (new) — six tests: markdown/json/text failure-path rendering with `runSoundnessFuzz` mocked to reject (deterministic exact-output assertions), one test against a genuinely unreachable database (unmocked, matching the original repro method), and two tests for the `DATABASE_URL`-not-set path (markdown reports without ever calling `runSoundnessFuzz`; text unchanged).
- `docs/DECISIONS.md` — D-068 (new): the full reasoning, including why the fix was widened to the `DATABASE_URL`-not-set path but deliberately not to the exit-2 argument-validation paths, why the JSON fallback is an honestly different shape rather than a zeroed `SoundnessJsonReport`, and why the workflow YAML itself needed no change while the comment-posting script did.

**Verification:** `npx tsc --noEmit` clean; `npm run build` clean; `npx eslint .` clean; `npx prettier --check .` clean; full `npx vitest run` (excludes `*.integration.test.ts`, no Docker required) — 227/227 passed. Real end-to-end smoke test against the built CLI, all three formats, both failure paths: `--format markdown`/unreachable DB (425-byte report, starts with the marker, real error text, exit 3); `--format json`/unreachable DB (valid `{"status":"infrastructure_failure",...}`, exit 3); `--format markdown`/`DATABASE_URL` unset (report present, exit 3); `--format text`/unreachable DB (0-byte stdout, unchanged, exit 3). `scripts/post-soundness-comment.mjs`'s new guard smoke-tested directly against an empty file with fabricated env vars — threw and exited non-zero before any `fetch` call. **Fail-check performed:** reverted `printInfrastructureFailure`'s body to its pre-fix stderr-only behavior (source only), re-ran the new test file — exactly the four markdown/json/real-DB/`DATABASE_URL`-missing-markdown tests failed for the right reason (`expected "log" to be called 1 times, but got 0 times`), the two text-format tests stayed green; restored the file and confirmed byte-identical restoration via `md5sum`.

**Final state:** `soundness-report.md` is never a 0-byte file on an infrastructure failure for `--format markdown`/`json`; the tracked PR comment is never silently blanked by this failure mode, and — as a second, independent layer — never posted/updated with a blank body regardless of cause. `--format text`'s existing behavior is byte-for-byte unchanged. Left uncommitted in the worktree for the main agent to review, per this task's own instruction.

## Production resolver depth-budget accounting fixes (D-069)

**Owner:** `soundness-engineer` (resolver.ts fix, regression tests) +
main agent (independent live re-verification, DECISIONS.md/PROGRESS.md,
review). Not a numbered build phase — a full-repo audit (2026-08-16)
found this as the single CRITICAL finding (a real `false_grant`) plus a
paired HIGH finding (a real `false_deny`), the highest-priority item in
the direct user instruction ("fix the critical and high findings").

**What was wrong:** three separate depth-budget accounting bugs in
`src/resolve/production/resolver.ts`, all stemming from the same root
cause — `resolve()`'s per-call `depth` parameter didn't mean the same
thing at every point it was read, compared to the reference resolver's
own consistent convention. (1) CRITICAL: the SQL-level relation lookup
received the full `ctx.maxDepth` ceiling instead of the depth remaining
after prior hops — a `false_grant`, confirmed live (a 3-level nested
group chain that the reference resolver correctly denied at
`maxDepth: 3`, production incorrectly allowed). (2) HIGH: `tupleToUserset`
charged an extra `+1` on top of the `+1` its own entry into `evalRewrite`
already spent, double-costing the same conceptual hop `computedUserset`
charges once — a `false_deny`, confirmed live (a 25-level `folder`
parent chain: reference allowed to 24 hops of distance, production
started denying around hop 11-12). (3) found independently while
verifying the fix for (1)-(2): a residual `>=`/`>` off-by-one at the
ceiling comparator itself, invisible until the first two bugs were
fixed and the remaining discrepancy could be isolated.

**Why none of this was caught before:** the existing
`cross-resolver-agreement.integration.test.ts` suite had no fixture
deeper than 3 levels — nowhere near deep enough to make TS-level depth
bookkeeping the deciding factor in any assertion.

**The fix** (`src/resolve/production/resolver.ts`): (1) pass
`Math.max(0, ctx.maxDepth - depth)`, not `ctx.maxDepth`, into
`sqlRelationMembershipWithWitness`. (2) `tupleToUserset`'s recursive
call now passes `depth` unchanged, matching `computedUserset`'s own
convention. (3) the ceiling comparator changed from `depth >=
ctx.maxDepth` to `depth > ctx.maxDepth`, matching the reference
resolver's own `resolveMembership`.

**Regression tests:** 6 new `it`s added to
`cross-resolver-agreement.integration.test.ts` — the false_grant fixture

- a raised-budget control; the 25-level false_deny fixture + a
  past-ceiling control; an isolated ceiling-comparator fixture + its own
  past-ceiling control (with an honest in-test disclosure that this last
  fixture is NOT independently isolated from bug 2 — reverting either bug
  2 or bug 3 alone fails it, confirmed by fail-checking each).

**A genuine, disclosed coverage gap found while proving the fuzz
harness has power against this fix:** reintroducing bug 1 and running
the real 5,000-query differential fuzz at the _standard_ configuration
(default `maxDepth`, several fresh seeds) did **not** catch it —
`src/soundness/generators.ts`'s `OBJECTS_PER_NAMESPACE_MAX = 6` caps
graphs too small to ever produce the ~20+-hop chain the bug needs to
diverge from correct behavior. Tightening `maxDepth` to 2 via the
harness's own existing option reliably caught it (unsound in ~33/40
seeds). This is a real, new coverage gap — distinct from D-035's
latency-only gap, a genuine boolean-level defect the harness _can_
catch, just not at the generator's default scale — flagged in D-069,
out of scope for this fix (`generators.ts` is Phase 5/soundness-engineer
territory), and disclosed to the user as a candidate follow-up rather
than left for someone to find the hard way.

**Verification, independent of the implementing subagent's own
report:** read the full diff by hand against my own prior understanding
of bugs 1-2 (already personally reproduced earlier this session via
throwaway `VERIFY-finding1.ts`/`VERIFY-finding2.ts` scripts before
delegating). Ran all 20 tests in `cross-resolver-agreement.integration
.test.ts` (14 existing + 6 new) live against real local Postgres via
LOCALVERIFY, all passing. Performed an original fail-check of my own,
distinct from the subagent's: reverted _only_ the comparator fix (bug 3,
`>` back to `>=`, bugs 1-2 left fixed) and re-ran the suite live — exactly
the two tests the subagent predicted failed (`false_deny` fixture and
the isolated comparator fixture), everything else stayed green, then
restored and confirmed byte-identical via `md5sum`. Full fast unit
suite (`npx vitest run`) 221/221 passing; `tsc`/`eslint`/`prettier` all
clean on every touched file.

**Final state:** all three depth-budget bugs fixed and independently
re-verified live against real Postgres; the fuzz-harness coverage gap
disclosed rather than smoothed over, with its own "revisit if" trigger
in D-069.

## A guaranteed deep chain closes D-069's own generator coverage gap — and finds it's only half-closable without touching runner.ts (D-070)

**Owner:** a dedicated fix-agent, on branch
`fix/soundness-generators-deep-chain-coverage`, scoped to exactly
`src/soundness/generators.ts` and its own tests, closing D-069's
disclosed "Revisit if" (the standard-configuration fuzz run's generator
was too small to ever exercise the depth-budget-accounting bug class
D-069 fixed).

**What was wrong:** `generateFixture`'s `OBJECTS_PER_NAMESPACE_MAX = 6`
meant no randomly generated userset-subject or tuple-to-userset chain
could ever get anywhere near the ~20+ hops needed to make "remaining
depth budget after N prior hops" and "the full budget" disagree under
`env.CHECK_MAX_DEPTH`'s default ceiling (25) — the exact structural
precondition D-069's own critical bug (a real `false_grant`) needs to
produce a wrong boolean. The standard 5,000-query fuzz run's own small
graphs made the bug statistically invisible, confirmed by D-069 itself
reintroducing the bug and getting a clean run back.

**The fix:** a second guaranteed, deterministic structure —
`buildGuaranteedDeepChain` — inserted into every fixture the same
deliberate way the pre-existing guaranteed cycle already is: a 24-hop
`hierNs` parent chain landing on a 13-group `groupNs` nested-membership
chain, reusing both namespaces' already-compiled schema shapes (no new
namespace, no new rewrite-rule kind). Four reserved queries (indices
2-5, appended after the two pre-existing cyclic ones) are hand-derived
against this exact structure, each isolating one of D-069's three bugs
as precisely as the structure allows — see D-070 for the full numeric
derivation (`D + k <= CHECK_MAX_DEPTH - 1` as the shared boundary, and
why 12/13 and 24 are the specific numbers chosen). The deep chain's own
objects are excluded from the generator's random-tuple-assignment loop
so no coincidental random edge can ever change the hand-derived chain
length a reserved query depends on.

**The most important finding, from this fix's own live verification,
not assumed from a clean fuzz run:** D-069's critical bug (the
`false_grant`) **cannot be produced at `runSoundnessFuzz`'s literal
default configuration** (`options.maxDepth` omitted) by any deep chain,
at any depth — an architectural fact, not a generator-depth shortfall.
At that configuration, production uses `env.CHECK_MAX_DEPTH` (25) while
the reference resolver independently defaults to `DEFAULT_REFERENCE_
MAX_DEPTH` (1000) — 40x larger. Any real chain buggy production can
find (bounded to roughly 2×25=50 hops even with the bug, since the
bug's own worst case is still capped at the nominal ceiling in each of
the two places it can bite) is trivially within reference's 1000-hop
reach too, so reference always independently agrees — never a
divergence, regardless of the bug. Confirmed three ways before being
trusted: hand-derivation; a live `(D=20, k=1..30)` sweep against real
Postgres showing the exact predicted allow/deny boundary for the fixed
resolver and full agreement (never a `false_grant`) for the buggy one
at every `k`; and the actual, real, standard-configuration 5,000-query
`runSoundnessFuzz` run itself, across 10 fresh seeds with the bug
reintroduced — **0/10 unsound, `false_grant` totalling 0**. What
_does_ reliably close it: pinning `maxDepth` explicitly via
`runSoundnessFuzz`'s own already-existing option
(`{ maxDepth: env.CHECK_MAX_DEPTH }`) — the same 10 seeds, same bug,
same real 5,000-query budget: **10/10 unsound, `false_grant: 1` on
every single seed**, deterministic — a dramatic reliability
improvement over D-069's own disclosed "33/40 seeds at `maxDepth: 2`."
Closing the literal-default-config half of this gap needs a
`runner.ts`-scoped change (defaulting `SoundnessRunOptions.maxDepth` to
`env.CHECK_MAX_DEPTH` instead of leaving both resolvers at independently
mismatched defaults) — out of scope for this fix's own task boundary,
disclosed in D-070 rather than smoothed over, exactly as D-069 disclosed
the generator half of the same gap for this fix to pick up.

**What the deep chain closes unconditionally, no `maxDepth` pinning
needed:** D-069's other two bugs (both `false_deny`-shaped) — confirmed
live, each reintroduced alone at the literal default configuration:
bug 2 (tupleToUserset double-charging) raises the guaranteed baseline
`false_deny` count from 1 to exactly 4 on every seed; bug 3 (the
`>=`/`>` ceiling comparator) raises it from 1 to exactly 2. Neither
flips `verdict` (§6.5/D-006: `false_deny` never blocks alone), but both
are now a real, deterministic, always-visible signal in every run's own
report where before this fix neither bug moved that number at standard
scale at all.

**Tests:** `test/unit/soundness/generators.test.ts` (new, DB-free) — 37
tests across 5 distinct seeds asserting the exact hand-derived tuple and
query shape of the guaranteed deep chain (every edge, both plain
grants, exactly two tuples on `dc_h0`'s `editor` relation and exactly
one on every interior chain node, proving no random tuple ever lands on
a reserved object), the four reserved queries' exact shape, that
`referenceCheck` allows all four (confirming they're real chains, not
phantoms), reproducibility, and graceful degradation for small
`queryCount`. `test/isolation/differential-soundness.fuzz.test.ts` (the
pre-existing suite) needed zero changes — all 8 tests still pass
unmodified.

**Verification:** `npx tsc --noEmit`/`npx eslint .`/`npx prettier
--check .` all clean; `npx vitest run` 276/276 passing (239 pre-existing

- 37 new); `test/isolation/differential-soundness.fuzz.integration.test
.ts` and `test/unit/resolve/production/cross-resolver-agreement
.integration.test.ts` (D-069's own regression suite) both re-run via
  LOCALVERIFY-against-real-local-Postgres, 1/1 and 20/20 passing; every
  live probe described above (bug 1 at default and pinned `maxDepth`, and
  bugs 2/3 individually at default) performed via a temporary,
  single-line edit to `src/resolve/production/resolver.ts`, rebuilt, run,
  and restored byte-identical (`md5sum`-confirmed) before the next probe
  — never left in place, never committed. Every real 5,000-query
  `runSoundnessFuzz` call completed in 5-10 seconds; the deep chain adds
  `O(depth)` tuples (~40), not `O(depth²)`.

**Final state:** the standard-configuration fuzz run now reliably
exercises real depth-budget accounting near the actual ceiling on every
run (a guaranteed, deterministic `false_deny` from the chain's own
"just past the boundary" witness, at default config); D-069's bug 1 is
now reliably (10/10, deterministic) caught the moment a caller pins
`maxDepth`, and bugs 2/3 are now visibly, deterministically caught at
the literal default configuration too. The literal-default-config half
of bug 1's own gap remained open and disclosed, with its own "Revisit
if," as `runner.ts`-scoped follow-up work, not implemented in this
entry — **closed immediately after by the very next entry below
(D-071)**, in the same worktree/PR, per the coordinator's own
follow-up instruction. Left uncommitted in the worktree for the main
agent to review, per this task's own instruction.

## `runSoundnessFuzz` now resolves one effective maxDepth for both resolvers, closing D-070's own disclosed gap for real (D-071)

**Owner:** the same fix-agent as D-070, on the same branch
(`fix/soundness-generators-deep-chain-coverage`), same worktree, same
uncommitted PR — a direct coordinator-requested follow-up closing the
"Revisit if" D-070 itself named as `runner.ts`-scoped, out-of-boundary
work for that entry.

**What was wrong:** `runSoundnessFuzz`'s `checkAllQueries` let each
resolver silently fall back to its own default whenever a caller
omitted `options.maxDepth` (true of every real invocation path — CLI,
CI, API; there is no `--max-depth` flag anywhere) —
`productionCheck` to `env.CHECK_MAX_DEPTH` (25), `referenceCheck` to
the independent, 40x-larger `DEFAULT_REFERENCE_MAX_DEPTH` (1000). D-070
proved by hand-derivation and live Postgres testing that this exact
mismatch makes D-069's own critical bug (a real `false_grant`)
structurally undetectable by the standard-configuration fuzz run, no
matter how deep the fixture generator's chains are — a buggy
production resolver can never find a real chain reference doesn't also
independently find within its own much larger budget, so the two
always agree, bug or no bug.

**The fix:** `runSoundnessFuzz` now resolves
`options.maxDepth ?? env.CHECK_MAX_DEPTH` exactly once and passes that
single value to _both_ `referenceCheck` and `productionCheck`,
unconditionally, for every query — `checkAllQueries`'s own signature
tightened to require a concrete number rather than accept `undefined`
and silently omit the option. An explicit `options.maxDepth` still
overrides both resolvers uniformly, exactly as before — only the
omitted case's behavior changed.

**Live-verified, the actual acceptance criterion:** D-069 bug 1
reintroduced (temporary, single-line, restored byte-identical after via
`md5sum`), real standard-configuration `runSoundnessFuzz` (5,000
queries, real Postgres, `maxDepth` genuinely omitted, not pinned),
across 10 fresh seeds: **10/10 `unsound`, `false_grant: 1` on every
seed** — the same deterministic reliability D-070 had only been able to
show for a `maxDepth`-pinned invocation, now true of the literal
default too. Resolver restored, same 10 seeds: **10/10 `sound`,
`false_grant: 0`**.

**Design questions resolved, with reasoning (full detail in D-071,
`docs/DECISIONS.md`):** the `SoundnessRunOptions.maxDepth` doc comment
updated to describe the new default behavior; **no** new field added to
`SoundnessRunResult`/`soundness_runs` for the resolved `maxDepth` value
— checked whether an existing field already served this purpose (it
doesn't — `graph_seed`/`queryCount` are recorded because they're
required inputs to `generateFixture` itself, `maxDepth` never is) and
concluded a persisted field isn't justified until a real caller can
actually vary it (no `--max-depth` flag exists anywhere today) rather
than added speculatively; D-070's own query 5 ("outside" combo witness)
re-verified live under the new default — its guaranteed `false_deny`
(1 on every prior run) is now `0` on every seed, because reference now
also shares the real ceiling — confirmed to be agreement (the correct
outcome), never a new `false_grant` risk; every existing test calling
`runSoundnessFuzz` without an explicit `maxDepth` audited and re-run,
none needed a change.

**Tests:** `test/unit/soundness/runner-maxdepth-resolution.test.ts`
(new, DB-free, mocked I/O + a delegating spy on `referenceCheck` to
observe its real call arguments) — asserts both resolvers receive
`{ maxDepth: env.CHECK_MAX_DEPTH }` on every query when omitted, and
the exact explicit override value when set.

**Verification:** `npx tsc --noEmit`/`eslint`/`prettier --check` all
clean; `npx vitest run` 278/278 passing (276 + 2 new); the live probe
above; a separate 10-fresh-seed run of the fixed resolver at the
genuinely-default configuration (10/10 `sound`, `false_grant: 0`,
`false_deny: 0`, confirming no spurious divergence); explicit-override
sanity checks at `maxDepth: 25` and `maxDepth: 2`; three
`*.integration.test.ts` files (`differential-soundness.fuzz`,
`dry-run-cleanup`, `cross-resolver-agreement`) all re-run via
LOCALVERIFY against real local Postgres, 1/1, 5/5, 20/20 passing,
unmodified. **Fail-check performed:** `referenceCheck`'s own call
temporarily reverted to omit `{ maxDepth }` entirely (reproducing the
pre-fix behavior) — both new tests failed for the right reason
(`expected undefined to deeply equal { maxDepth: 25 }`); restored,
`md5sum`-confirmed byte-identical.

**Final state:** D-070's own disclosed gap is now fully closed — the
standard-configuration fuzz run (no `maxDepth` override, exactly what
CI/CLI actually run) reliably, deterministically catches D-069 bug 1's
`false_grant` shape, D-070's own deep chain does not introduce any
spurious divergence at the new default, and D-070's own doc comments
(in `src/soundness/generators.ts`) were updated in place to describe
the new default behavior accurately rather than left describing a
mismatch that no longer exists. Left uncommitted in the worktree for
the main agent to review, commit, and push as one PR covering both
D-070 and D-071 together, per the coordinator's own instruction.

## Full-repo audit batch 1: medium/low findings + API body-size limit (D-072–D-079)

**Owner:** main agent directly for API/CLI/CI/store/doc fixes, `report-designer` for response/report-shape additions (new `not_found` API error, fixture-failure report renderers, the `/health` namespace-listing-status type), `schema-compiler` for `src/schema/publish.ts` (findings #26/#27), `test-author` for new/updated coverage across the batch. Branch `claude/audit-findings-batch1-medium-low`, working through the ~29 medium/low/style findings from the 2026-08-16 full-repo audit (findings #9–#38; #1–#8 were the earlier critical/high batch, already merged) plus D-067's disclosed-but-unimplemented body-size-limit recommendation.

**Findings fixed this pass, full reasoning in `docs/DECISIONS.md` D-072 through D-079:**

- **#13 + #14 (D-072):** unmatched routes bypassed rate limiting entirely (confirmed live: 150 requests to a bogus path, never a 429) and returned Fastify's raw default 404 body instead of this API's one documented error envelope. Fixed with `app.setNotFoundHandler({ preHandler: app.rateLimit() }, handler)` plus a new `notFoundError()`/`not_found` `ApiErrorCode` (`src/api/errors.ts`).
- **#15 + #22 + #23 (D-073):** `/health` forwarded the raw Postgres driver error to any unauthenticated caller, and conflated "database unreachable" with "the namespace-listing query itself failed." Split into two independent try/catches; a new `HealthNamespaceListStatus` type (`src/api/responses.ts`) lets `database.reachable` stay strictly accurate while `namespaces` reports its own outcome; both failures still fail closed (503) but are now honestly distinguishable. #23 needed no separate fix — its premise (`/check`/`/expand` unauthenticated) was already closed by D-064.
- **#9 (D-074):** `assertTokenObserved`'s `requested > observed` silently passed a `NaN` token (JS: any `>`/`<` comparison with `NaN` is `false`). Now rejects a non-integer/negative token before ever querying the database.
- **#12 (D-075):** `soundnessRun`'s `catch` mapped every thrown error to exit code 3, contradicting its own doc comment (generator/fixture bugs belong at exit code 2). `runSoundnessFuzz` now throws a distinguishable `SoundnessFixtureError` at its three generator-bug sites; the CLI branches on `instanceof` and no longer mislabels a fixture bug with `"Postgres: "` framing.
- **#16 (D-076):** Commander's own default usage-error exit code (always `1`, confirmed by reading its source) collided with `soundness run`'s security-significant exit code 1 (unsound verdict). `program.exitOverride()` + a `try`/`catch` remaps it to exit code 2. Live-verified across `--help`/`--version`/bad-flag/missing-arg/unknown-subcommand/existing-validation/infra-failure cases.
- **Item 2, D-067's deferred recommendation (D-077):** `bodyLimit: 262_144` (256 KiB) set explicitly on the Fastify constructor (Fastify already defaulted to 1 MiB, undocumented — this tightens and documents it), plus a `.max(65_536)` field-specific ceiling on `schemaSourceBodySchema.source`. Found and fixed a companion bug while implementing this: the generic framework-error handler was hardcoding every sub-500 status to 400, which would have silently turned a new, real 413 into a misleading 400 — now preserves the real status code.
- **Doc-drift sweep, seven files (D-078):** #18/#25/#28/#35 (stale comments describing states that no longer hold — a `.todo()` claim, a "yet to be refactored" claim, a missing CLI flag, Phase-0-era coverage scaffolding), #19 (CONSISTENCY.md's SQL example didn't match the real migration), #29 (an invalid hyphenated identifier copied into two files' comments), #30 (D-020's own "Revisit if" was satisfied by D-036 with no cross-reference back).
- **Dependency hygiene (D-079):** `@types/node` re-pinned from `^26.2.0` to `^22.20.1` (four majors ahead of the real `engines.node: >=22` floor — benign today, a landmine for later); `testcontainers` dropped as a redundant direct devDependency (`@testcontainers/postgresql` already carries it transitively, confirmed via `npm ls`).

**#26 + #27 (D-080), landed since the summary above was written:** `src/schema/publish.ts`'s `publishOne` had a real, unhandled concurrent-publish race (select-max-then-insert, no lock) — two concurrent `publishSchema` calls to the same namespace could collide, and the loser got a raw Postgres error instead of a handled result. Fixed with a `pg_advisory_xact_lock(hashtext(namespace))` serializing publishes per namespace; live-verified twice independently (3/3 clean concurrent runs with the fix, 3/3 reproduced raw constraint violations with it reverted). `deletePublishedNamespaceVersion`'s doc-comment-only single-caller contract is now also ESLint-enforced (`no-restricted-imports`, `eslint.config.js`) — a future non-`runner.ts` caller fails lint, not just review.

**#10, #11, #17, #20, #21, #31–#34 (D-081), landed:** the remaining nine test-gap findings, all closed with real test coverage — full detail in D-081, including two cases (`#17`, `#20`) where the finding's own suggested mechanism didn't actually work against the real code and a genuine alternative had to be found and justified. `git diff --stat src/` for this pass is empty — every change lives in `test/`. `npx vitest run`: 328/328 passing; all touched/new `*.integration.test.ts` files re-verified against real Postgres.

**All 30 findings from the full-repo audit's medium/low/style batch (#9–#38) are now closed.** Item 2 (the API body-size limit, D-067's deferred recommendation) is also done. Item 3 (branch housekeeping) was already done earlier in this session. See D-072 through D-081 (`docs/DECISIONS.md`) for the complete reasoning trail. Not yet committed as of this note — see this file's own commit history for when it actually landed.

**Verification so far:** `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .` all clean after every fix above. Live-verified against real local Postgres (`postgres://authz:authz_dev_password@127.0.0.1:5432/authz_dev`): the `not_found` envelope and rate-limited 404s, `/health`'s sanitized/split error handling against both a reachable and a genuinely unreachable database, the 413/400 two-layer body-size ceiling, and the full Commander exit-code remap across every usage-error shape. `npm install`/`npm run build` clean after the `package.json` changes. Full `npx vitest run` pass count and any remaining fail-checks to be confirmed once `test-author`'s in-flight coverage for this batch lands — see the follow-on entry.

## Second full-repo audit: 17 findings, batch 2 (D-082–D-087)

**Owner:** three parallel agents plus the main agent directly, all working in the same shared worktree on branch `claude/audit-findings-batch2` off `main` (batch 1, above, had already merged) — `soundness-engineer` for the consistency-token watermark race, `report-designer` for the `false_grant`-rendering crash, `test-author` for five test-gap/improvement findings, main agent for the `trustProxy` fix, the `expand()` cache, the `authz check --path` flag, and the remaining mechanical doc-drift/hygiene findings. Ran after batch 1 merged, per the user's own request to "run an improvement workflow" — the `full-repo-audit` workflow (14 parallel review dimensions, adversarial verification, 31 agents total) found 17 real findings after dedup (1 refuted) across 3 high/6 medium/8 low, none critical.

**High severity, full reasoning in D-082/D-083/D-084:**

- **`trustProxy: true` → `trustProxy: 1` (D-082):** the original D-065 fix trusted an unbounded `X-Forwarded-For` chain, not just the one real reverse-proxy hop — any caller could fabricate a leading address and get a fresh rate-limit budget on every request, defeating every limit in the API including `/health`'s (D-056, closing a CodeQL DoS finding). Reproduced live against the real installed Fastify; fixed with a one-line config change; new regression test confirmed to fail against the old config and pass against the new one.
- **Token-watermark race (D-083):** `assertTokenObserved` assumed `write_log.token` allocation order matched commit order — not guaranteed on Postgres's non-transactional identity-column allocation. A slow-committing write could get a lower token than a faster concurrent one, so pinning to the faster write's token didn't guarantee observing the slower one — a real, if narrow, violation of `docs/CONSISTENCY.md`'s stated invariant. Closed with a global (not namespace-scoped, unlike D-080's analogous fix — `write_log` is one sequence shared by every namespace) transaction-scoped advisory lock around `writeTuple`/`deleteTuple`'s `write_log` insert. Live-verified with two independently-committing connections in deliberately inverted order, both before (race reproduced) and after (lock correctly blocks) the fix.
- **`false_grant` rendering crash (D-084):** every `false_grant` divergence rendered uncapped by design — correct in spirit (never summarize the worst finding away) but with no size ceiling, so a genuine severe regression (150+ false_grants, plausible at CI's 5,000-query budget) could blow past GitHub's ~65KB comment limit and crash the PR-comment poster unhandled, silently leaving no comment (or a stale clean one) for exactly the worst-case scenario this pipeline exists to surface. Fixed with a real size budget (not a fixed entry count, unlike `false_deny`) plus an independent second safety net in the poster script itself.

**Medium/low findings, full reasoning in D-085/D-086/D-087:**

- **`expand()` gets a namespace-config cache (D-085):** mirrors the production resolver's own identical-purpose cache, closing a real, measured query-count gap (44 → 23 `pool.query` calls for a 10-level `parent->view` chain, confirmed by instrumenting a real `expand()` call before/after).
- **`authz check --path` (D-086):** the README's own headline example claimed `check` "returns this exact path" — it never did until this flag. A real rendering bug (using the wrong `ResolutionStep` field for a `tupleToUserset` hop's trailing label) was caught live against the real seeded example graph and fixed before landing; output now matches the README's own quoted diagram exactly, verified against all four `ResolutionStep` shape families (direct grant, userset membership, tuple-to-userset, intersection, exclusion).
- **Five test-gap/improvement findings (D-087):** cycle-detection blind spots for two of three mechanisms (`tupleToUserset`, direct self-loop), a stale rate-limit test masking real drift post-D-064/D-065, an untested `--dry-run`×`--format` contract, D-013's actual rejected alternative finally regression-tested (with a drafting mistake — a weak substring assertion — caught and fixed during the fail-check, not shipped), and Fastify/pino test-log silencing. One file (`test/unit/api/server.integration.test.ts`) couldn't be live-verified — no Docker in this sandbox — disclosed rather than assumed equivalent.

**One finding refuted, not fixed:** a claimed unauthenticated-DoS path via `collectPermissionDeps` (`src/schema/dsl/compiler.ts:310`) — both independent skeptics reproduced a real stack overflow, but from a materially different term count and at a different call site (`compileRewriteRule`, not the cited line) than the finding's own "captured stack trace" claimed, and one skeptic showed the actual API-level impact is a graceful 500, not a crash. See the audit's own "Considered and Ruled Out" section.

**Coordination note:** three agents plus the main agent worked concurrently in the same git working tree (not separate worktrees) — deliberately, to let overlapping-but-disjoint file sets land without `git worktree` overhead. This mostly worked cleanly (agents self-coordinated D-number collisions by checking `docs/DECISIONS.md` before writing, and one agent switched from whole-file backup/restore to surgical `Edit`-based fail-check reverts after briefly clobbering a concurrent change once), but produced two real integration issues the main agent caught and fixed during final review, not before: one agent accidentally deleted two other agents' untracked `LOCALVERIFY-*.mjs` scratch scripts while cleaning up its own (disclosed by the agent that did it; no permanent loss since they were reproduction scratch files, not deliverables), and two agents' concurrent `Edit` calls to `docs/DECISIONS.md` interleaved badly enough to strand one entry's own "Revisit if" closing paragraph at the very end of the file, after a _later_ entry's content, with no section header — caught by reading the file's own tail during final review, not by any tool, and repaired by moving the orphaned paragraph back into its correct entry.

**Verification:** `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .` all clean across the full combined diff. `npx vitest run` (fast suite) green. Every touched/new `*.integration.test.ts` file re-verified against real local Postgres via this project's established LOCALVERIFY technique (Docker unavailable in this sandbox) by whichever agent/main-agent touched it, several independently re-spot-checked by the main agent during final integration. `npx tsx src/cli/index.ts soundness run --dry-run` re-run clean against real Postgres to confirm the differential-fuzz harness itself still works under the new global write-lock.

## Third full-repo audit: 20 findings, all closed (D-089–D-094)

**Owner:** the main agent directly for two mechanical fixes plus a real Windows-user bug report and a feature request that landed alongside this round (D-089/D-090/D-091), then three parallel subagents — `soundness-engineer` for the resolver/differential-fuzz/audit-trail cluster, a `general-purpose` agent for the API-surface/CLI/config-validation/migration-locking cluster, `schema-compiler` for the schema DSL/publish cluster — each on its own branch off `main`, working the same shared working tree with strict file-ownership discipline (explicit `git add` lists, never `-A`). Ran after a real end user's own Windows walkthrough of the README surfaced two genuine bugs (the `.pathname` Windows drive-letter defect, and a request for `soundness run` progress output — D-089/D-090), then the user asked for "an improvement workflow" with Ultracode on; the `full-repo-audit` workflow found 20 real findings, none refuted this round.

**Mechanical + user-reported, D-089/D-090/D-091:** `authz doctor`'s `MIGRATIONS_DIR` used `new URL(...).pathname`, which leaves an invalid leading `/` before a Windows drive letter — silently reported "Migrations: 0/0 applied" instead of failing, discovered live by a real user following the README on Windows (D-089); fixed there and, once the audit's own finding #5 confirmed the same defect existed in 15 `*.integration.test.ts` files' own boilerplate, mechanically fixed there too (D-091, via a small regex-substitution script, `fileURLToPath` in place of `.pathname` everywhere, `doctor.test.ts`'s own regression test for the bug deliberately excluded). A `--progress <n>` flag for `soundness run` (D-090), requested mid-troubleshooting by the same user watching a 5,000-query run with no feedback — a pure function (`createProgressReporter`) reporting on milestone crossings, threaded through the runner and CLI. D-091 also added `soundness.yml`'s missing `concurrency` group, closing finding #7 (a duplicate-PR-comment race between overlapping workflow runs).

**Findings #1/#2/#6/#8/#15/#16/#17 — resolver/differential-fuzz/audit-trail cluster (D-092), PR #40:** the two HIGH findings, both in `src/resolve/production/resolver.ts`. #1: every read inside one `productionCheck` call was its own independent, autocommit query, with no shared snapshot — a concurrent write landing mid-check could stitch a resolution path together from facts that never coexisted at any real point in time. Fixed with one `pg.PoolClient` per check, running the entire walk inside a `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction; `atToken` pinning re-verifies its floor check as the transaction's literal first statement so the snapshot anchor is provably no earlier than the pinned token. A regression test uses a real `LOCK TABLE namespace_configs IN ACCESS EXCLUSIVE MODE` to deterministically reproduce the race rather than depend on timing — confirmed live, with the fix reverted, that the test fails exactly as predicted. #2: `fetchReachableFrontier`'s recursive CTE had no per-iteration dedup, so a reconvergent-but-acyclic group hierarchy (the normal shape of a real nested-group tree) produced exponentially many rows for a linear number of distinct nodes — confirmed live: a 12-level branching-3 diamond chain never returned within 20s unfixed, under 100ms with a `distinct on` added to the recursive term. Argued and then empirically fuzzed (3,000 random graphs) that the dedup cannot silently drop real reachability. The remaining five: `referenceCheck` rejecting a non-finite/negative `maxDepth` instead of silently disabling its own depth ceiling (#6, the same bug class D-074 already closed once); a second cyclic-termination test for `expand()`'s `tupleToUserset` call site, independent of the pre-existing one (#8); a real Postgres `BEFORE DELETE` trigger forcing the previously-untested asymmetric dry-run cleanup failure combination (#15); a corrected misleading comment (#16); and a test proving `checks.depth` reports a union's failing branches' own depth, not just its winning branch's (#17). The full 5,000-query differential soundness fuzz was re-run against the rewritten resolver (0 `false_grant`), and the fuzz harness's own power was re-confirmed against this specific resolver via a deliberate intersection-as-union break, caught and reverted.

**Findings #3/#4/#9/#10/#11/#12/#13/#14 — API-surface/CLI/config-validation/migration-locking cluster (D-093), PR #39:** `/check`/`/expand` accepted any non-empty string as `ns`/`id`/`relation` with no identifier-grammar enforcement, unlike every tuple write — fixed via a shared `identifierField()` helper; a `authFloodGuard` closes a companion gap where failed-auth requests were counted by no rate limiter at all (a shared-array bug in an early draft of this fix — silently breaking 4 of 5 routes' limiters via `@fastify/rate-limit`'s own in-place array mutation — was caught live and fixed before shipping). `authz doctor` split one try/catch into two so a migration failure no longer prints "Postgres: unreachable" (mirroring D-073's identical `/health` fix). `src/config/env.ts` failed outright on a blank `.env` placeholder for every defaulted field except three — `ADMIN_API_KEY` now requires 32+ characters, independently verified safe against the actual deployed Railway production key (64 characters) before landing. `runMigrations` gained a third advisory lock (session-scoped, not transaction-scoped like D-080's and D-083's — each migration must still commit independently) closing the same read-then-apply race those two decisions already closed elsewhere; two real bugs (an unlocked-DDL catalog-conflict race, an intermediate draft that broke even a single serial call) were caught live during this fix's own verification and never shipped. `--at-token ''` now rejected instead of silently coercing to token `0`.

**Findings #18/#19/#20 — schema DSL/publish cluster (D-094), PR #38:** `(a|b)|c` and `a|(b|c)` compiled to different `RewriteRule` shapes purely because of which side of the operator the parens landed on — the flattening check only ever tested one side. A new `flattenChildren` helper checks both sides symmetrically; live-verified both forms now compile byte-identical. A republish test proving `getLatestNamespaceConfig` — the function gating every real write and check — actually picks up a namespace's second published version, never exercised before. `schema/malformed-example.authz`, cited in its own header comment and `docs/RELATIONS.md` as a worked rejection example, actually compiled for the first time, pinning both its errors by line.

**All 20 findings from the third full-repo audit (#1–#20) are now closed** — no gaps, cross-checked against every decision entry's own finding-number citation. Two genuine git-history divergence bugs (a local pre-merge commit's SHA diverging from GitHub's own squash-merge commit for the same content, causing a real, avoidable merge conflict) were hit and fixed along the way, both via isolated `git worktree` rebases so a still-running background agent's uncommitted work in the shared main working tree was never disturbed.

**Verification:** `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .` clean on every PR, independently re-run by the main agent after each subagent batch rather than trusted from the subagent's own report alone. Every touched/new `*.integration.test.ts` file LOCALVERIFY-run against real local Postgres and restored to its committed form. `npm run test`: 410/410 passing after the resolver rewrite. CI's own `soundness` job (5,000 real queries against the merged resolver) reported SOUND — 0 `false_grant`, 0 `false_deny` — on every one of the four PRs.

## Deterministic simulation testing scoped, then built end to end: D0–D5 (D-095, D-097–D-102)

**Owner:** the main agent, directly, phase by phase per `docs/DST-PROPOSAL.md`'s own six-phase plan — each phase reviewed, fail-checked, and shipped as its own PR before the next began.

**D-095 — scoping:** a three-way design panel (abstract interface seam vs. SQL-pattern-matching fake driver vs. a narrow hybrid extending `publishOne`'s existing `{ query: Pool['query'] }` precedent), scored independently by two judges against fidelity, blast radius, maintainability, fault-class coverage, and fit with this project's own conventions. The narrow hybrid won on both scorecards: a real, working in-memory fake swapped in at the storage seam, modeling Postgres's documented transaction/lock/MVCC semantics closely enough to inject partial writes, crashes, reordering, and seeded concurrent interleaving — explicitly not a claim that Postgres's own crash-recovery correctness is being proven, only this project's own application-level concurrency logic under adversarial scheduling.

**D0 (D-097):** the storage seam itself. `writeTuple`/`deleteTuple`/`listTuplesByObject`/`listTuplesBySubject` (`tuples.ts`), `currentToken`/`assertTokenObserved` (`tokens.ts`), and `getLatestNamespaceConfig` (`publish.ts`) narrowed from concrete `pg.Pool`/`pg.PoolClient` to two new structural types, `QueryExecutor`/`ConnectionSource`. A real fake connection/transaction engine (`src/store/dst/`) with a per-connection write buffer, commit-sequence tagging, and an injectable crash immediately found a real, latent bug: `writeTuple`/`deleteTuple`/`publishSchema` all shared the same "a failed `ROLLBACK` silently masks the real error" defect — fixed the same day, in the same PR.

**D1 (D-098):** a real, blocking, Promise-based advisory-lock engine (`src/store/dst/locks.ts`) — a FIFO wait-queue mutex, not a boolean flag or a timer, so two connections driven via `Promise.all` interleave exactly like two real Postgres backends. All four real lock call sites this codebase issues (the write-log lock, the per-namespace publish lock, the migrations session lock and its explicit unlock) wired directly into `connection.ts`. `publishSchema`/`runMigrations` narrowed to `ConnectionSource` in the same phase, and `migrate.ts`'s own rollback-masking gap — named but explicitly deferred in D0 — closed here too.

**D2 (D-099):** `REPEATABLE READ` snapshot visibility, modeled for real — a transaction anchors its snapshot at its first real statement, not at `BEGIN`, matching Postgres's own documented semantics exactly, enforced structurally (a write attempted inside snapshot mode throws, it doesn't just get discouraged by convention). `productionCheck` runs through the fake completely unmodified. The headline result: D-092's own phantom-witness regression test (originally verified only against real Postgres) now runs, deterministically, under this harness — proving the fix generalizes beyond the one fixture that happened to catch it originally.

**D3 (D-100):** the one piece D2 deliberately stubbed — a real, multi-level recursive-frontier BFS, not a single-hop approximation — proven equivalent to the real Postgres recursive CTE via a seeded differential sweep across random graph shapes, not merely inspected for correctness.

**D4 (D-101):** one seeded, reusable scheduler replacing D0–D3's own ad hoc PRNGs and hand-rolled pause choreography — and immediately found its own first version was broken: an adversarial review before shipping caught that the replacement didn't actually preserve the interleavings the phases it replaced had been relying on, fixed before merge.

**D5 (D-102):** real PR and nightly CI wiring for the whole DST suite, a genuine `publishSchema` coverage gap closed along the way, a structural gate enforcing every new SQL-shape "recognizer" the fake adds is actually exercised somewhere (not just registered), and a shared seed-count knob so PR-time and nightly runs are the same test logic at different budgets, not two diverging implementations.

**Verification:** every phase fail-checked live before shipping (break the mechanism, confirm the predicted test failures, restore, confirm byte-identical) — this project's own standing discipline, applied to a test _harness_ this time rather than application code. `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .` clean at every phase. Each phase shipped as its own PR, reviewed, merged, `main` synced before the next began.

## `pg.Pool` error-listener fix — a real CI flake traced to a real, load-bearing production gap (D-096)

**Owner:** the main agent, directly, while chasing an intermittent `test-integration` CI failure.

Every `test-integration` failure on this project had the identical signature: every real test passing, followed by an "Unhandled Errors" crash reporting Postgres error `57P01` (`terminating connection due to administrator command`) — previously shrugged off as "a container-teardown race, re-running fixes it." It wasn't fixed by a re-run avoiding the window; the window was never closed. `grep -rn "\.on('error'" src/ test/` returned zero matches, on the one real production pool (`src/store/client.ts`) or any of the 21 test pools across 16 integration-test files — this project had never guarded against `pg`'s own documented gotcha: an idle client's background connection error crashes the whole Node process by default, since `EventEmitter`'s default behavior for an unhandled `'error'` event is to throw. Fixed everywhere `new Pool(...)` appears, with a listener that logs instead of throws.

This was not merely a CI-reliability fix. The identical, previously-unguarded gap sat in the real production pool — before this fix, something as mundane as Postgres restarting during routine maintenance, or one idle connection getting reset by a network blip, would have crashed the entire `authz-api` process, not just failed the one in-flight request using that connection. Found via a CI flake, load-bearing well beyond it.

**Verification:** confirmed as the real root cause (not merely correlated) by matching the exact error signature across two independent failures, including one on a 100%-documentation commit — proof by construction the failure wasn't a code regression. `npx tsc --noEmit`, `npx eslint .` clean; `test-integration` re-run clean post-fix.

## Dependabot/CI bot triage finds two real infrastructure bugs, and a Fastify 5.12.1 upgrade needs a hand-written trustProxy replacement (D-103, D-104)

**Owner:** the main agent, directly, while triaging six open Dependabot PRs.

**Bug 1:** `dependabot-auto-merge.yml`'s approve step was written as fatal, contradicting its own top-of-file comment describing it as best-effort. Confirmed live across four real PRs: every one failed with `GitHub Actions is not permitted to approve pull requests` (an org-level restriction), killing the job before the actual merge step ever ran — this workflow had never successfully auto-merged a single PR since it was written, silently. Fixed with `|| true`.

**Bug 2:** three separate Dependabot PRs each bumped one line of `codeql.yml`'s matched `init`/`analyze` `codeql-action` version pair independently — this repo's own top-of-file comment already warns the two must move together, in the same commit. Two of the three PRs individually left the pair mismatched, confirmed live via each PR's own failing `Analyze` job (`Loaded a configuration file for version '4.37.7', but running version '4.37.6'`). Fixed by bumping both together in one commit; the two now-redundant PRs closed with a direct reference.

**`fastify` 5.12.0 → 5.12.1 (D-103's own deferred finding, closed by D-104):** the version bump's typecheck break wasn't types-only — fastify's maintainers removed `number` from `trustProxy`'s accepted type because the numeric form (`trustProxy: 1`, this project's own D-082 config) never actually inspected the connecting socket before trusting it as a proxy, only counted hops. Live-verified byte-for-byte: identical `X-Forwarded-For` requests against real 5.12.0 and 5.12.1 servers diverged completely — 5.12.1 silently ignored the header entirely under the old numeric config, collapsing every real client's rate-limit budget into one shared bucket keyed on the proxy's own address. Fixed with a hand-written `trustExactlyOneRealProxyHop` (`TrustProxyFunction`), verified against the same five-scenario table D-082 originally used, all matching exactly.

**A same-day correction, made because a PR body wasn't read closely enough the first time:** the fastify bump actually patched a real, named advisory (GHSA-3m5p-2c4r-xxw2 / CVE-2026-3635) — re-reading the replacement function against that advisory's real threat model found it has the identical structural blind spot the number it replaced had, just expressed as a function. The actual security boundary for this deployment turned out to be verified via Railway's own live GraphQL API, not the function: `authz-api` has exactly one public exposure (a standard edge-proxied Railway domain, no raw TCP path), closing the anonymous-internet-attacker reading of the advisory; a narrower residual path exists via other services the same account owner controls in one shared private network, confirmed with the owner and judged an acceptable, disclosed residual risk rather than something to over-engineer around with an unverifiable Railway-CIDR allowlist.

**Verification:** every claim checked against real GitHub Actions job logs, not inferred from workflow YAML. `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .` clean; `npm run test` (512 tests) green; `npm run build` clean.

## Second full-repo audit round: 20 findings, all closed (D-105–D-113)

**Owner:** the main agent directly for D-105–D-109 (PRs #62–#65: the HIGH finding and the resolver/CLI/test-coverage cluster), then a 4-unit parallel `Workflow` (implement → independent adversarial verify, per unit) for the remaining six findings, D-110–D-113 (PRs #66–#69) — Ultracode was on for this half of the round.

Ran against the same repo shortly after the "third full-repo audit" round above, using the same `full-repo-audit` workflow; found 20 real findings this time (1 HIGH, 8 MEDIUM, 11 LOW), user selected "fix everything."

**HIGH + resolver/store fixes, D-105–D-108:** `authFloodState`'s plain, unbounded `Map` (D-105) — nothing stopped a caller who controls a routable IPv6 `/64` from growing it forever without spoofing anything; replaced with a bounded `toad-cache` `LruMap`, real eviction proven live via a test-only cap override. `productionCheck`'s catch block could let a `ROLLBACK` failure mask the real underlying error (D-106) — the same bug class D-097 already fixed twice elsewhere, missed here only because this file's transaction wrapper postdated D-097's own scan. `expand()` gained the same pinned-connection-transaction treatment `productionCheck` already had (D-107), closing the identical phantom-witness class D-092 fixed for the other resolver. `authz check`/`authz expand`'s CLI arguments validated against the same identifier grammar the equivalent API routes already enforce (D-108).

**Test-coverage + refactor cluster, D-109–D-110:** three real coverage gaps closed with fail-checked assertions — exclusion's jsonb round trip through a real `checks` row (never previously exercised, only path-construction was), the two request-body-size ceilings (413 vs. 400, and the historical flattening bug they once had), and the JSON reporter's field-order invariant its own doc comment claimed but never asserted (D-109). `scripts/post-soundness-comment.mjs`'s inline decision logic — PR-number validation, empty-report rejection, the byte-limit fallback — extracted into a real, tested `src/report/` module following the `decidePrCommentAction` precedent, closing a gap where three prior incidents had all traced back to this exact untested script; a byte-vs-character wording bug fixed alongside it (D-110).

**Dependency, store, and doc-drift cluster, D-111–D-113:** a Dependabot PR had silently re-widened `@types/node` back past D-079's own re-pin, undoing it without touching `engines.node` — re-pinned again, with the regression demonstrated live rather than merely asserted (D-111). `soundness_runs` gained a `dry_run` column so an orphaned dry-run row can finally be told apart from a real one after a partial cleanup failure, plus a doc-comment disclosure of a real, narrow same-seed concurrency limit (D-112). Five independent doc/comment corrections — several citing D-numbers or files that had drifted since being written — closed the round (D-113), including a correction the round's own adversarial-verify stage caught in its own citation (D-097 alone, not D-097/D-098, narrowed the functions in question) before it could ship wrong.

**All 20 findings from this round are now closed**, cross-checked against every decision entry's own finding-number citation, the same discipline the third audit's own closing paragraph established. Every fix's diff, once produced by a Workflow subagent, was reviewed and independently re-verified by the main agent (not trusted from the subagent's own report alone) before being committed and shipped as its own PR — the Workflow's own adversarial-verify stage additionally caught one real (non-blocking) factual error in an implementer's own narrative, described above.

**Verification:** `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .` clean on every PR. `npm run test`: 46 files, 561 tests passing on `main` after all four PRs merged. `npm run build` clean. Each PR's own CI (lint, typecheck, unit, integration, soundness, DST, CodeQL) green before merge; two of the four PRs (developed off a stale `main` in parallel) needed a rebase to resolve `docs/DECISIONS.md`'s own append-point conflict before merging, resolved by hand, re-verified, and force-pushed each time.

## Schema verifier — §2 prerequisites: DSL frozen, random schema generator lands on `main` (D-114)

**Owner:** the main agent, directly, on `main` — deliberately before the `verifier` branch exists at all, per the schema verifier's own scoped build spec (§2: "do these on `main`, not on this branch," so both this track and any future DST-adjacent work build against the same frozen target rather than each risking its own copy).

Two prerequisites, both closing before any schema-verifier code is written. **§2a:** the namespace DSL's grammar — five `RewriteRule` kinds, the informal BNF in `parser.ts`'s own header comment, `&` binding tighter than `|`/`-`, the reserved-word set, identifier/nesting-depth limits — tagged `schema-dsl-frozen-v1`. A repo-wide grep for `TODO`/`FIXME`/`not yet`/`unsupported` across `src/schema/dsl/` returned nothing; this grammar has been unchanged through all nine build phases, the third full-repo audit, and the entire DST D0–D5 effort — freezing it recognizes an already-true fact rather than committing to something new. What's deliberately _out_ of v1 is written down explicitly rather than left implicit: wildcard subjects, caveats/conditions, multi-hop `tupleToUserset` in one atom, and cross-file namespace declarations (the last of which turns out to already work within one compilation unit — a packaging question, not a grammar gap).

**§2b:** `src/schema/dsl/random.ts`, new — `generateRandomSchema(seed, options?)`, a general-purpose random _schema_ generator (namespace/relation/permission shape, rewrite-rule depth and operator mix — all seed-controlled), landed once on `main` so the schema verifier's own future differential tests and any DST-adjacent workload generation draw from one shared generator instead of each growing its own copy. Deliberately distinct from the existing `src/soundness/generators.ts`'s `generateFixture`, which randomizes tuple _data_ over one fixed three-namespace-role schema shape, purpose-built for Phase 5 — read first, found not reusable here (see D-114's own "Alternative rejected" for why), and left completely untouched.

Built for constructive correctness, not generate-and-filter: permissions are generated in strict dependency order so a same-namespace cycle is structurally unreachable, not merely unlikely; `tupleToUserset` only ever follows a relation whose subject types are all namespaces already declared in the same generated unit; every name is index-derived and therefore collision-free by construction. The generated source is always run through the real `compileSchema` before being returned — never hand-assembled — both matching this project's "don't reimplement the parser" discipline and because a thrown compile failure is the fastest signal the generator's own correctness claim has a bug. It found one: the first version picked a relation's `namespace#relation`-style subject-type target from _any_ member name (relations and permissions together), when `compiler.ts` requires a relation specifically there — caught by the generator's own "always compile the output" discipline on its first real sweep, fixed before any test was written against the broken version, and then fail-checked live (deliberately reintroduced, confirmed 8 of 17 tests fail for exactly that reason, reverted, `md5sum`-confirmed byte-identical).

**Verification:** 500 default-option seeds and 1000 high-ceiling seeds (5 namespaces, depth 4, all four rewrite-rule operators) all compile through the real compiler, with every operator kind confirmed to actually appear somewhere across the sweep. Determinism confirmed directly: same seed + options → byte-identical source and a deep-equal compiled schema, twice. Disabling `intersection`+`exclusion` together is confirmed to produce a schema containing neither — the exact dial the verifier's own future fragment-detection tests will need. `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .` clean; `npm run test`: 47 files, 578 tests (+17 net new); `npm run build` clean.

**CHECKPOINT 2, per the verifier's own build spec, closes here** — both §2 exit criteria met (DSL tagged; `main` has a seeded random schema generator with a test proving the same seed produces the same schema). The `verifier` branch itself, and §3's schema-graph IR, are the next phase.

## Schema verifier — §3 schema-graph IR, §4 invariant language (D-115)

**Owner:** the main agent, directly, on the `verifier` branch (off `main`, at the D-114 commit) — scoped per the build spec's own branch discipline to `tools/schema-verifier/` plus `docs/INVARIANTS.md` and an append-only `docs/DECISIONS.md`; this entry itself lands on `main` separately for exactly that reason.

**§3, `tools/schema-verifier/src/ir/`:** `buildSchemaGraph` turns a `CompiledSchema` into an explicit node/edge graph — a `NamedNode` per `(namespace, relation-or-permission)` pair, a `SyntheticNode` per non-top-level combinator or `tupleToUserset`, every edge kind the build spec names (direct, computed-userset, tuple-to-userset, union, intersection, exclusion), type restrictions carried on every edge that has them, cycles represented as ordinary edges back to an already-registered node id rather than needing any visited-set at construction time. `printSchemaGraph` dumps it deterministically. A test-only round-trip (`reconstructReference`/`reconstructDefinition`) proves nothing is lost — checked against all 5 real fixtures and 300 random schemas from §2's generator. Two test-authoring bugs (wrong fixture file, wrong assumption about which node in the graph carries a union-child `tupleToUserset` edge) were found and fixed — not builder bugs, confirmed by the round-trip suite staying green throughout.

**§4, `tools/schema-verifier/src/invariants/`:** a tiny, hand-written, line-oriented invariant language — typed variables, `distinct(...)`/relation-equality constraints, a `goal:` permission call — parsed with line-numbered errors on malformed input. Two identifier vocabularies, not one: schema names (relation/permission/type/invariant names, meant to resolve against a real schema in §5) keep this repo's own `snake_case` convention; variable names get their own broader pattern, since the build spec's own worked example writes `orgA`/`orgB` in mixed case. Ships the three required fixtures: tenant isolation, "no public path to a private document," and a deliberately-satisfiable positive control (proves the future search can actually find a witness, not just default to reporting none). `docs/INVARIANTS.md` is the shared static/dynamic/temporal vocabulary file the build spec's §1 calls for — DST's own dynamic-invariants section is left for that branch to add.

**A real, disclosed gap:** the two non-control fixtures reference relation names (`tenant`, `member`, `visibility`) no real schema in this repo currently declares — `schema/example.authz` has no cross-namespace tenant/org scoping today. Deliberate: §4 is the invariant language, checked independent of any schema; choosing or authoring a real fixture schema these invariants actually resolve against is §5's job.

**Also landed:** a nested `tools/schema-verifier/eslint.config.mjs`, needed because this tool's test files and `vitest.config.ts` fell outside the root config's own path-anchored exemptions, and the root config itself is out of this branch's file-touch scope. Its real nested-discovery behavior — `files`/`allowDefaultProject` patterns are relative to the nested config's own directory, not the repo root — was confirmed empirically rather than assumed; `npx eslint .` (the same invocation CI uses) is now clean for the whole repo, including `tools/schema-verifier/`, previously unverified since §3's own first commit never ran it.

**Verification:** `npx tsc --noEmit -p tools/schema-verifier/tsconfig.json`, `npx eslint .`, `npx prettier --check .` all clean. `npx vitest run --config tools/schema-verifier/vitest.config.ts`: 2 files, 37 tests (19 IR + 18 invariant-language), all green. Full design notes and the ESLint investigation: `docs/DECISIONS.md` D-115.

Holding at CHECKPOINT 3 (per the build spec's own numbering, closing after both §3 and §4's exit criteria are met) — §5 (monotone reachability and witness construction) is the next phase.

## Schema verifier — §5 monotone reachability and witness construction (D-116)

**Owner:** the main agent, directly, on the `verifier` branch.

`checkInvariant` (`tools/schema-verifier/src/reachability/`) — exhaustive backward search over the schema-graph IR's monotone fragment (union, computedUserset, tupleToUserset), returning `HOLDS`/`VIOLATED`/`UNKNOWN`, never collapsing `UNKNOWN` into `HOLDS`. A clone-on-write `UnionFind` unifies constraint-pinned and search-introduced `(object, relation)` slots through one shared key — "union-find plus a type check, not a solver," per the build spec's own words. Cycles use a per-search-path visited-node set; reaching intersection/exclusion yields `UNKNOWN` immediately (§7's job, not attempted here).

A new fixture schema (`tools/schema-verifier/fixtures/schemas/tenancy.authz`) closes the gap D-115 disclosed — the two non-control invariant fixtures now resolve against a real, compiled schema for the first time.

**A significant, disclosed finding, not a quiet correction:** building the search against a real schema showed that `tenant_isolation`, worded exactly as the build spec's own §4 example states it, structurally cannot return `HOLDS` — a `relationEquals` constraint pins one `(object, relation)` slot, but the search's own terminal edge almost always needs a _different_ one, and nothing stops a witness from populating that second slot unconstrained. Concretely: `tenant(s) = orgA` pins `user.tenant`, a relation `document.view`'s actual rewrite rule (`tenant->member`) never consults — so the search correctly finds a witness where `s` gets an independent, unconstrained `organization:orgB#member` tuple, `VIOLATED`. This is the verifier doing its job, not a bug: a schema author who thought that constraint gated `view` would be wrong, and the witness is the proof. `tenant-isolation.invariant`'s content is unchanged (still the build spec's example, verbatim) — only its comment, and the docs describing its expected verdict, were corrected. `no-public-path-to-private-document.invariant` was recast around what this constraint vocabulary _can_ prove unconditionally — type-level unreachability (a `private_document` whose `view` permission never accepts a `user` subject, directly or transitively) — genuinely `HOLDS`, true regardless of any tuples ever written. Full reasoning, including the schema shapes tried and rejected before reaching this conclusion: `docs/DECISIONS.md` D-116.

**Verification:** `npx tsc --noEmit -p tools/schema-verifier/tsconfig.json`, `npx eslint .`, `npx prettier --check .` all clean. `npx vitest run --config tools/schema-verifier/vitest.config.ts`: 3 files, 49 tests (19 IR + 18 invariant-language + 12 reachability) — including all three fixtures returning their documented verdict with a real witness where claimed, a real intersection (`folder.sensitive_review`) correctly yielding `UNKNOWN`, and a self-referential nested-group cycle resolving to a real witness without hanging.

§5 has no dedicated build-spec checkpoint of its own (the real `CHECKPOINT 4` — "the most important checkpoint in the file" — comes only after §6, counterexample self-validation). Holding here anyway: §6 needs live replay against the real check engine (a real database), which is substantial additional work best started fresh rather than folded into the same pass as §5.

## Schema verifier — §6 counterexample self-validation, CHECKPOINT 4 (D-117)

**Owner:** the main agent, directly, on the `verifier` branch.

`checkAndValidate` (`tools/schema-verifier/src/validate/`) wraps §5's search with the automatic self-validation the build spec requires: a `VIOLATED` verdict's witness is replayed tuple-by-tuple through the real, unmodified `writeTuple` and `productionCheck`, on a fresh DST fake scratch store (no real Postgres available in this environment, and none needed — the fake is the exact same storage seam those functions already run against throughout DST). The real engine's `allow` confirms the counterexample; a denial, or any rejected tuple, is a `mismatch`, reported loudly. A `HOLDS` verdict gets the complementary empirical check — N random type-valid tuple sets thrown at the same goal, none may ever produce `allow`.

**Self-validation caught a real bug in its own code on the first live run**, exactly as it's meant to: `tenant_isolation`'s witness names `orgB` (a valid mixed-case invariant variable, D-115) as a tuple id — but the real tuple store only accepts lowercase `snake_case` ids, and the very first replay reported a rejection, not a real engine/IR disagreement. Fixed with a small label-to-valid-id mapper, used consistently everywhere a witness label becomes a real tuple id.

**CHECKPOINT 4 — the exit criteria are met and shown, not just asserted:**

- `tenant_isolation` and `positive_control`: both `VIOLATED`, both `confirmed` — the real engine's own resolution path (a real `tupleToUserset` hop through a real `directGrant`) is logged directly in the test output. This is the exact ask: real tuples, a real check, a real `allow`, reproducible by anyone in seconds.
- `no_public_path_to_private_document`: `HOLDS`, empirically confirmed clean across 25 fuzzed tuple sets against the real engine.
- The fail-check: `private_document#owner`'s real `service_account`-only restriction is deliberately widened (a corrupted IR edge, simulating exactly the class of bug §3 warned about), the search wrongly reports `VIOLATED`, and self-validation — checking the witness against the real, uncorrupted schema — rejects the tuple outright and reports `mismatch` with a specific, correct reason. The real, uncorrupted graph is independently re-confirmed `HOLDS` in the same test.

**Verification:** `npx tsc --noEmit -p tools/schema-verifier/tsconfig.json`, `npx eslint .`, `npx prettier --check .` all clean. `npx vitest run --config tools/schema-verifier/vitest.config.ts`: 4 files, 54 tests (19 IR + 18 invariant-language + 12 reachability + 5 self-validation), all green. Full design notes and the caught-bug narrative: `docs/DECISIONS.md` D-117.

CHECKPOINT 4 closes here, per the build spec's own numbering — §7 (the non-monotone fragment: intersection and exclusion) is the next phase.

## Schema verifier — §7 the non-monotone fragment: bounded search over intersection/exclusion (D-118)

**Owner:** the main agent, directly, on the `verifier` branch.

§5's exact search can't handle intersection or exclusion — they don't have the small-model property union/computedUserset/tupleToUserset do — and returns `UNKNOWN` the moment it meets one. §7 gives that case a real, disclosed-bound answer instead of leaving it there. `scanReachability` (`tools/schema-verifier/src/reachability/fragment.ts`) walks every edge reachable from the goal, over every edge kind, and reports which fragment the schema falls into (plus every relation reached, feeding candidate generation). `checkAndValidate` consults this first on every call: `'monotone'` routes to §5/§6 exactly as before; `'non-monotone'` routes to `boundedSearch` (`tools/schema-verifier/src/bounded/`) instead.

`boundedSearch` doesn't hand-model what intersection/exclusion mean — it fixes a bound `k`, enumerates every type-valid candidate tuple up to that bound, and brute-forces every _subset_ directly through the real, unmodified `productionCheck`. First `allow` → `VIOLATED`, already self-validated by construction (no separate replay step for this path — every verdict already came from the real engine). No subset allows → always `HOLDS up to k = N`, never a bare `HOLDS`, per the build spec's own explicit warning about what that collapse would mean. An invariant's own `relationEquals` constraints are held fixed as _given_ facts in every subset tried, not left to the enumeration — without that, "a blocked user can never publish" would be meaningless. `MAX_BOUNDED_CANDIDATES = 20` refuses to run rather than hang, with a disclosed reason rather than a silent stall.

**A second real bug, caught before shipping, and the more dangerous kind — a false negative.** Candidate generation's first version built instance pools only from namespaces with their own `namespace X { ... }` declaration. A type used only as a subject (`relation editor: user`, no `namespace user { ... }` block — exactly the new `non-monotone.authz` fixture's own shape) never appears there, so its pool came back empty, every candidate was silently dropped, and an intersection invariant with _no constraints at all_ — which should obviously be `VIOLATED`, the same "positive control" shape D-116 already established — instead reported `HOLDS`. Exactly the failure mode §5's own doc comment already names as "the failure mode that makes a verifier actively dangerous," reached through a different bug than the one that comment was written about. Caught immediately by this phase's own new intersection fixture (written specifically because its answer is obvious). Fixed by deriving instance pools from every reachable relation's own declared subject types too, not just declared namespaces.

**Default bound: k = 1, not the build spec's own illustrative k = 3.** Worked out, not guessed: candidate count for two relations sharing a type pair grows as `2 × (k + 1)²`. k = 1 → 8 candidates, 256 subsets, single-digit milliseconds. k = 2 → 18 candidates, 262,144 subsets — measurably too slow: an earlier draft of this phase's own tests ran a k = 2 case and it didn't finish inside vitest's 5-second default test timeout. k = 3 (the spec's own illustrative bound) → 32 candidates, which `MAX_BOUNDED_CANDIDATES` would refuse outright, on even the minimal two-relation fixture built for this phase. Callers may still pass a higher `k` for a schema small enough to afford it; the ceiling is what stops that from ever silently hanging.

**SMT sketch, as §7 asks for explicitly:** one uninterpreted sort per namespace and one uninterpreted boolean predicate per relation, the permission's rewrite tree translated structurally into a formula (union → OR, intersection → AND, exclusion → AND-NOT, tupleToUserset → an existentially-quantified object variable), the invariant's constraints as first-order assertions, satisfiability asked directly — SAT gives a genuine `VIOLATED` witness with no bound at all, UNSAT gives a _real_ proof of `HOLDS`, not "up to k". The actual obstacle, and why this stays out of scope for v1 rather than merely unimplemented: recursion. A self-referential relation makes naive formula expansion not terminate, and the honest fixes (a fixpoint construction, which loses soundness the moment exclusion sits in the same cycle; bounded unrolling, which is bounded search's own `k` again with no free lunch; or a dedicated Horn-clause/CHC solver built for least-fixpoint reasoning) are a real v2 phase, not a bare SMT call over the fragment above.

**Verification:** `npx tsc --noEmit -p tools/schema-verifier/tsconfig.json`, `npx eslint .`, `npx prettier --check .` all clean. `npx vitest run --config tools/schema-verifier/vitest.config.ts`: 5 files, 63 tests (19 IR + 18 invariant-language + 12 reachability + 5 self-validation + 9 bounded search), all green — both new non-monotone fixtures correctly labeled and resolved (`approve_reachable_via_intersection` `VIOLATED up to k = 1` with a two-tuple witness; `blocked_user_cannot_publish` `HOLDS up to k = 1`, with a direct unit test proving the given-tuple mechanism is what keeps it that way, not mere absence of a counterexample), both monotone fixtures still correctly labeled and unaffected, and `MAX_BOUNDED_CANDIDATES` firing `UNKNOWN` on a deliberately oversized candidate list without trying a single subset. Full design notes, the false-negative bug, the tractability math, and the SMT sketch: `docs/DECISIONS.md` D-118.

§7 has no dedicated build-spec checkpoint of its own — the next real checkpoint (CHECKPOINT 5) comes after §8, "Testing the verifier itself" (mutation testing, differential-against-brute-force, a known-answer corpus). Holding here to report §7's completion before starting that phase.

## Schema verifier — §8 testing the verifier itself: mutation testing, a brute-force differential oracle, a known-answer corpus (D-119)

**Owner:** the main agent, directly, on the `verifier` branch.

Three deliverables, each checking the shipped tests actually have teeth rather than assuming a green run means correct.

**Mutation testing.** Nine hand-curated, single-change mutations applied directly to this tool's own core algorithmic files (the union-find's conflict detection, the search's cycle safety and terminal type check, fragment detection, the bounded-search ceiling, and both of §7's own real bugs — `generateGivenTuples`, `collectPoolNamespaces` — plus `replayWitness` and `fuzzHolds`), each confirmed to turn the full suite red for the right reason, then reverted (this project's own standing "mutate the real code, confirm red, restore" discipline, run across the whole tool at once). Seven caught immediately or broadly. One (disabling `MAX_BOUNDED_CANDIDATES`) was verified by reasoning and a bounded 2-second race rather than a live full run — the abandoned 2²¹-subset search monopolizes the Node event loop badly enough that even a timeout race never returned, itself direct evidence of the exact danger the ceiling exists to prevent.

**Two mutations went completely uncaught — real gaps, not noise, closed rather than left disclosed-and-open:**

- `collectPoolNamespaces`'s own contribution (§7's real fix, walking a reachable relation's own subject types) turned out to be silently masked by a different line in the same function whenever the invariant's own goal subject type happened to match — true for both shipped non-monotone fixtures. Closed with a new, deliberately isolating unit test using goal types matching nothing in the schema, so only `collectPoolNamespaces` itself can produce the candidates.
- `replayWitness`'s second `mismatch` branch (engine denies despite every witness tuple writing successfully) had no test reaching it — the CHECKPOINT-4 fail-check only ever exercises the first branch (a rejected write). Closed with a direct unit test against a hand-built, individually-valid but deliberately incomplete witness.
- `fuzzHolds` had no test proving it can actually find a real counterexample — every fixture reaching it is one where `HOLDS` is genuinely true. Closed with a direct call against the trivially-satisfiable `positive_control` fixture.

**Differential-against-brute-force** (`test/differential.test.ts`): `src/schema/dsl/random.ts`'s own header comment already names this verbatim — "on small random schemas from §2b, run the verifier against a deliberately dumb exhaustive checker." §7's `boundedSearch` already _is_ that checker; this turns it into a genuine second, independent oracle specifically for `checkInvariant`'s (§5) own `HOLDS` verdicts — the one direction that previously only got empirical sampling (`fuzzHolds`), since every `VIOLATED` is already confirmed against the real engine on every real run. 216 of 240 random schema/goal trials cross-checked, 0 disagreements. New `src/testing/random-invariant.ts` supplies the random-goal half (D-114's `generateRandomSchema` already supplied the schema half).

**Known-answer corpus** (`test/known-answers.test.ts`): every fixture invariant this project ships — all five, spanning both fragments and both verdicts — gathered into one literal table with its exact committed result, swept with `it.each`, each row citing the `docs/DECISIONS.md` entry that reasoned out why. Caught one real bug in its own first draft (a `VIOLATED` row wrongly expecting `bound: 1`, which only a `HOLDS` verdict ever sets) before it shipped.

**Verification:** `npx tsc --noEmit -p tools/schema-verifier/tsconfig.json`, `npx eslint .`, `npx prettier --check .` all clean. `npx vitest run --config tools/schema-verifier/vitest.config.ts`: 7 files, 73 tests, all green. Full mutation list, both closed gaps, and the differential/corpus design: `docs/DECISIONS.md` D-119.

§8, "Testing the verifier itself," is built and shipped — the phase CHECKPOINT 5 (the build spec's own next checkpoint after CHECKPOINT 4) sits behind. Holding here to report and confirm CHECKPOINT 5's exit criteria are met before treating it as closed, rather than assuming; any further section the build spec names beyond §8 is for a future continuation to scope.

## Schema verifier — §8 gap closure: recovering the real build spec text found three real mismatches, all three closed (D-120)

**Owner:** the main agent, directly, on the `verifier` branch.

The build spec was pasted directly into a prior session's conversation and never saved to a file; by the time D-119 was written, that literal text had been summarized away, and D-119 was built from a paraphrase instead. The literal text turned out to still be recoverable from the raw session transcript. Reading it directly found three real mismatches between what D-119 shipped and what §8 actually asks for — all three closed here, alongside D-119's own work (which stays real and valuable for the different question it answers), not replacing it.

- **§8a is schema-level mutation, not source-code mutation.** The real text: "take a schema whose invariant holds, mutate it — add a rewrite rule, widen a type restriction, add a tuple-to-userset edge across a boundary — confirm the verifier flips to VIOLATED, at least eight mutations, at least two subtle (widening a type restriction by one type; an edge that only leaks at depth 3)." New `test/schema-mutations.test.ts`: eight schema-text mutations against `no_public_path_to_private_document` (genuinely `HOLDS`, D-116), each confirmed to flip to `VIOLATED` and self-validate automatically against the real engine. Two subtle exactly as named — a one-type widening, and a tuple-to-userset chain that only leaks at depth 3 (asserted directly against the witness's own tuple count: 3).

- **§8b wants `k = 3` ("up to 3 objects per type"), run nightly, explicitly not on PRs.** New `test/differential.nightly.test.ts`: the same `checkInvariant`-vs-`boundedSearch` independent cross-check as the existing PR-speed test, at `k = 3` over 150 random schemas — verified locally, twice, deterministically: ~4 minutes, 538 trials genuinely cross-checked, 0 disagreements both times. Excluded from the default suite (`vitest.config.ts`, matching this repo's own root-config precedent for `*.integration.test.ts`); a new `vitest.nightly.config.ts` runs it directly (vitest's own `--exclude` CLI flag appends to a config's exclude list rather than overriding it, confirmed directly — a second config was the clean fix). **Deliberately not built here:** the actual scheduled-workflow YAML. `.github/workflows/` sits outside this branch's own file-touch discipline ("only create or edit files under `tools/schema-verifier/`, plus two docs files") — a draft was built, confirmed to work locally, then removed before committing, since nothing authorizes stepping outside that rule just because its own original justification (a concurrent `dst` branch) is now moot. This also lines up with where the real spec text actually puts CI wiring: §9, literally titled "CLI and CI," names "wire it as a required PR check" as its own exit criterion — that's where the real workflow belongs.

- **§8c wants three specific pathological fixtures, not just the five already shipped.** Three new schemas: `self-referential-folder.authz` (a genuinely self-referential schema, proving the small-model property against a real self-loop, not just a linear chain — resolves correctly in 4ms); `depth-exceeds-limit.authz` (a 30-namespace chain whose only witness exceeds the real engine's own `CHECK_MAX_DEPTH` of 25 — the verifier's unbounded search finds `VIOLATED`, and self-validation correctly reports `mismatch`, not `confirmed`, a real, disclosed static/runtime disagreement, not a bug in either component); and `cycle-unroll-once.authz`, the hardest of the three. First attempt (a `boundedSearch` `k = 1` vs. `k = 2` split, mirroring D-118's own exclusion-fixture framing) was explored and rejected after direct empirical testing — a direct, unconditional `grant` candidate always wins immediately regardless of `k`, since bounded search's own bound controls instance count per type, not cycle traversal. What actually demonstrates it: a real mutual cycle where one node's own exclusion correctly protects it from what its cycle-neighbor directly grants, requiring the real production engine to genuinely traverse the cycle once (`depth: 2`, confirmed directly) before its own cycle guard fires. This surfaced a broader, disclosed finding worth stating plainly: the real engine's cycle guard always _denies_ a repeated lookup rather than reusing a memoized answer, so a cycle can never be load-bearing for a grant — suggesting this project's small-model property may hold informally even outside the monotone fragment §1's own theorem formally covers, for a different, engine-specific reason.

**Verification:** `npx tsc --noEmit -p tools/schema-verifier/tsconfig.json`, `npx eslint .`, `npx prettier --check .` all clean. `npx vitest run --config tools/schema-verifier/vitest.config.ts`: 10 files, 86 tests, all green (up from 7/73) — the eleventh file (`differential.nightly.test.ts`) independently verified via `vitest.nightly.config.ts`. Full account of all three gaps, the schema-mutation list, and the cycle-guard finding: `docs/DECISIONS.md` D-120.

CHECKPOINT 5's own exit criteria ("eight mutations caught; differential agreement over a nightly run; corpus green") are now genuinely met against the real spec text, not a paraphrase. Holding here to report before continuing into §9 ("CLI and CI") — where the actual scheduled-workflow wiring deferred above, and the required-PR-check demonstration, both belong.

## Schema verifier — §11 README worked example lands (D-121)

**Owner:** the main agent, directly, on the `verifier` branch.

§11's own words: "a section leading with a worked example: a schema with a three-hop leak, the invariant, the counterexample tuples, the engine confirming them. Someone should understand what the tool does from that example alone without reading prose." No `README.md` existed under `tools/schema-verifier/` before this — a from-scratch write, not an edit.

- **The example.** Reused the same shape as `test/schema-mutations.test.ts`'s own mutation #3 (`private_document.linked_doc -> document.tenant -> organization.member -> user`, one of §8a's two required "subtle" mutations), given its own standalone fixture pair — `examples/three-hop-leak.authz`, `examples/three-hop-leak.invariant` — rather than reused as a runtime string-splice, so a reader can see the leak as an ordinary schema. `examples/run.ts` loads both directly through the public API (`compileSchema` → `buildSchemaGraph` → `parseInvariants` → `checkAndValidate`) and prints the verdict, the three witness tuples, and the §6 self-validation outcome — this is also what README.md's own "checking your own schema" section points readers at, since no CLI exists yet (§9, still future work).

- **Backed, not just asserted.** New `test/worked-example.test.ts` loads the same two fixture files `examples/run.ts` does and pins the exact verdict, 3-edge witness shape, and `confirmed` self-validation outcome README.md quotes verbatim — if the schema, the engine, or the search itself ever drifts, this fails in CI, not just on a human rerun.

- **A real drift caught along the way.** `vitest.config.ts`'s own comment (written for D-120's Gap 2) still claimed `.github/workflows/schema-verifier.yml`'s nightly job "runs it directly by path" — that workflow file was deliberately never shipped (D-120), and the comment was never updated to match. Fixed here to point at the real reproduction command instead.

- **Fresh-clone reproduction — §11's own exit criterion, done literally.** `git clone --branch verifier --single-branch` into a scratch path never previously used, `npm install`, then the README's own two Quickstart commands verbatim (`npx tsx tools/schema-verifier/examples/run.ts`, then `cd tools/schema-verifier && npx vitest run`) — both reproduced exactly, no undocumented step needed.

**Verification:** `npx vitest run` (12 files, 88 tests, up from 11/87), `npx eslint .`, `npx tsc --noEmit -p tsconfig.json`, `npx prettier --check .` all clean, plus the fresh-clone reproduction above and an independent re-run of the nightly differential config (246s, 1/1 green). Full rationale: `docs/DECISIONS.md` D-121.

This closes only the README portion of §11 — the rest (an explicit small-model-property writeup, the SMT sketch, backward-vs-forward search rationale, why the verifier imports the parser) is substantially already covered across D-115–D-118 and D-120 but hasn't been swept as a dedicated §11 pass. Left for future continuation, not silently claimed done here.

## Schema verifier — §9's CLI lands: `verify-schema` (D-122)

**Owner:** the main agent, directly, on the `verifier` branch.

Build spec §9's own usage line: `verify-schema <schema-file> --invariants <file> [--bound k] [--json]`, exit codes 0 holds / 1 violated / 2 unknown-or-bound-exceeded / 3 tool error. New `src/cli/` module — `exitCodes.ts` (pure result → exit code mapping), `format.ts` (human + `--json` rendering), `verify.ts` (the pipeline), `index.ts` (Commander wiring, invoked by path — not a `package.json` `bin`, since the root `package.json` sits outside this branch's file-touch scope).

- Two judgment calls the build spec's own table doesn't spell out, both documented explicitly: a bounded non-monotone `HOLDS` maps to exit `2`, not `0` (it's not a proof); self-validation disagreeing with the search (`mismatch`/`empirical-counterexample`) maps to exit `3`, not `1` or `2` (the verifier's own claim isn't substantiated, so don't trust it as a verdict either way). Multi-invariant files combine via worst-wins (`3 > 1 > 2 > 0`), confirmed end to end with a real fixture naming both a HOLDS and a VIOLATED invariant.

- **A deliberate self-review pass** (asked to slow down and re-check rather than treat 112 green tests as done) caught three real mistakes before any of it shipped: an unnecessary fifth exit code invented for CLI usage errors, corrected to reuse exit `3` (which already fits, and keeps every code inside §9's own literal four-entry table); a factually wrong doc comment claiming an invariants file always parses to at least one invariant — checked directly, and `parseInvariants('')` genuinely returns `{ ok: true, invariants: [] }`, so the runtime guard was already right but the comment justifying it wasn't; and a comment claiming `--version` behaves like `--help` when no `.version()` was ever registered on this program. All three fixed, plus two new end-to-end tests (an empty-invariants-file fixture, the multi-invariant fixture above) proving the edge cases the review surfaced, not just asserting they're handled.

**Verification:** `npx vitest run` (13 files, 115 tests, up from 12/88 — 13 pure-function tests plus 15 real-subprocess tests against every known-answer-corpus fixture), `npx eslint .`, `npx tsc --noEmit -p tsconfig.json`, `npx prettier --check .` all clean, plus a fresh-clone reproduction of the README's own updated CLI usage line and Quickstart. Full account: `docs/DECISIONS.md` D-122.

**This is the CLI half of §9 only.** The other half — "wire it as a required PR check on this repo's own schemas" — needs a `.github/workflows/` file and `tools/schema-verifier/` actually landing on `main`, both outside this branch's own absolute file-touch discipline. Raised explicitly for a decision rather than silently widening that discipline or silently skipping §9's own exit criterion — not yet resolved as of this entry.

## Schema verifier — §9 fully closed: `tools/schema-verifier/` lands on `main`, CI wired (D-123)

**Owner:** the main agent, directly.

The CI-wiring question above was resolved via an explicit decision: merge `verifier` into `main` for real (PR #82, squash — this repo's branch protection allows only squash, confirmed live), then build the workflow as a real follow-up (PR #83) once the module existed on `main` to reference. The old `verifier`-branch file-touch discipline is now moot — it applied only while that branch was in use.

- **PR #82.** Verified CI-safe before opening it, not assumed: root `lint`/`typecheck`/`test`/`build`/`format:check` each confirmed to skip `tools/schema-verifier/` entirely (ESLint's own nested-config-boundary behavior; tsconfig/vitest `include` globs never reaching `tools/**`). All 11 real CI checks passed on the actual merge. `origin/verifier` was auto-deleted on merge; its full commit history is preserved by a `verifier-landed` tag (pushed by the repo owner directly — this session's git credentials can push branches but not tags, confirmed via a live `403`).
- **PR #83 — `.github/workflows/schema-verifier.yml`.** Runs `verify-schema` against a new `schema/example.invariant` (`banned_member_never_views_org`, checked against this repo's own real `schema/example.authz`) on every PR/push to `main`. A real authoring bug (`banned(s) = o` instead of `banned(o) = s`) was caught by actually running the CLI before writing the workflow. Gates on `{0, 2}` = pass, `{1, 3}` = fail; fail-checked live by temporarily adding a leaky permission and confirming the job would fail, then reverting. Not yet a required status check — deliberately deferred until it's run green on a real PR.

**Verification:** root suite (47 files, 578 tests) and `tools/schema-verifier`'s own suite (13 files, 115 tests) both clean from `main`. Full account: `docs/DECISIONS.md` D-123.

## Schema verifier — §10 closed: twelve third-party schemas surveyed, `docs/FINDINGS.md` published (D-124)

**Owner:** the main agent, directly, on `schema-verifier-thirdparty-survey`.

Two background research agents fetched real, verbatim, source-cited schema content from `openfga/sample-stores` and `authzed/examples`/`authzed/docs`. Twelve schemas — six per ecosystem — were translated into this repo's own DSL (`tools/schema-verifier/thirdparty/*.authz`) and checked with the real CLI against an invariant their own docs state or imply (`*.invariant`); results and methodology in `docs/FINDINGS.md` and `tools/schema-verifier/thirdparty/README.md`.

- **Translation methodology.** OpenFGA's `define X: [T] or Y or Z from W` splits into `relation X_direct: T` + `permission X = X_direct | Y | W->Z`; SpiceDB is closer to 1:1. Two real compiler restrictions came up repeatedly — `type#relation` must name a genuine relation, never a permission, and every type in a traversed union relation must declare whatever the traversal reaches — both worked around with a faithful restructuring (splitting a union relation by target type) everywhere the math allowed it, disclosed in each file's own header.
- **The survey's own biggest finding.** This invariant language has no negative-constraint primitive (`distinct`/`relationEquals` are both positive pins only), so any goal permission reachable via a relation directly grantable to the tested subject's type is trivially escapable regardless of what the invariant meant to probe. Confirmed to recur identically across eight of the twelve entries, across six different domains and both ecosystems — a property of the language, not of any one schema. Two entries (`spicedb-superuser`, a documented intentional backdoor; `spicedb-docs-style-sharing`, whose own `assertFalse` proves real sibling-group isolation this survey can't verify) specifically demonstrate rule 1 (`VIOLATED` ≠ vulnerability).
- **Final tally:** 12 schemas, 9 `VIOLATED` (all self-validated), 3 `HOLDS` (1 exact, 2 bounded non-monotone), 0 `UNKNOWN`, 0 tool errors. Two source schemas (OpenFGA's `superadmin`, SpiceDB's `caveats`) excluded outright as "Not analyzed" — both are built entirely around ABAC/caveat concepts this DSL has no equivalent for.

**Verification:** all twelve schema/invariant pairs re-run against the real CLI in one pass immediately before writing `docs/FINDINGS.md`. Root and `tools/schema-verifier` suites both clean with `thirdparty/` present. Full account: `docs/DECISIONS.md` D-124.

This closes build spec §10 and its `CHECKPOINT 6`. Per §0's own rule (stop at every checkpoint, wait for a reply), holding here rather than continuing automatically into §11's remaining sweep or §12's definition-of-done checklist.

## Schema verifier — §11 closed: the documentation sweep D-121 left open (D-125)

**Owner:** the main agent, directly, on `main`.

D-121 (above) shipped only the README worked example and explicitly flagged the rest of §11 as scattered-but-unswept. This entry checks that claim directly and closes it: four of §11's five `docs/DECISIONS.md` asks (the small-model property, the SMT sketch, backward-vs-forward search, mutation testing results) were genuinely already written across D-115–D-120, just never stated as one coherent, cross-referenced argument — D-125 pulls each into a single explicit paragraph pointing back to its fuller original treatment. The fifth — **why the verifier imports the parser rather than reimplementing it** — was never actually written down anywhere as its own argument, despite being followed as a consistent practice from D-114 onward; that's the one genuinely new piece of content: a static verifier's whole claim depends on its model of the schema agreeing with the real compiler's and the real engine's, so a second implementation of either is a second place that agreement could go quietly wrong with nothing positioned to catch it, and importing sidesteps the question rather than answering it well.

`docs/INVARIANTS.md` was re-read in full and confirmed already correct — the dynamic-invariants section is deliberately left as DST's own stub to fill in, not a gap this branch has authority to close.

**Fresh-clone reproduction, re-run rather than assumed still valid:** §9 and §10 both landed on `main` since D-121's own clone test. A fresh clone into a new scratch path, `npm install`, then the worked example, the README's own CLI usage line, and the full `tools/schema-verifier` test suite (13 files, 115 tests) all reproduced exactly — none of which existed yet when D-121 shipped.

**Verification:** documentation-only change. Root suite (47 files, 578 tests) and `tools/schema-verifier`'s own suite both clean; lint/typecheck/format all clean. Full account: `docs/DECISIONS.md` D-125.

This closes build spec §11 in full. Per §0's own rule, holding here — only §12 (the definition-of-done checklist) remains, and one item on it (flipping the schema-verifier CI check to "required" in branch protection) is a real open decision, not a formality.

## Schema verifier — §12 closed: `schema-verifier` is a required status check, definition-of-done fully satisfied (D-126)

**Owner:** the main agent, directly, on `main`.

Asked explicitly whether to promote `schema-verifier` to required now that it had run green on three real PRs (#83, #84, #85) — the answer was yes. `docs/github-governance.md` Step 2 and the schema-verifier README's own CI section were updated to designate it (PR #86), but applying the setting itself is GitHub branch-protection configuration this project's own tooling has no endpoint to write — no tool available here exposes branch protection or rulesets, and raw API calls are out of scope for this project's GitHub access. The repo owner applied it directly in GitHub's UI and confirmed it.

Went through build spec §12's own ten-item checklist explicitly rather than assuming it was already satisfied — all ten are true, each pointing at the entry that closed it (D-114 through D-126). §13's own out-of-scope list was never violated across any phase, confirmed by construction (every phase imported the real compiler/engine rather than modifying either).

**Verification:** documentation-only. Root suite (47 files, 578 tests) and `tools/schema-verifier`'s own suite (13 files, 115 tests) both clean; lint/typecheck/format all clean. Full account: `docs/DECISIONS.md` D-126.

**This closes the schema verifier project as scoped by its own build spec, §1 through §12, in full.** Every checkpoint has been reported and confirmed. Nothing remains open against the original spec.

## `docs/INVARIANTS.md`'s dynamic-invariants stub, written (D-127)

**Owner:** the main agent, directly, on `main`.

`docs/INVARIANTS.md`'s "Dynamic invariants (DST)" section had said "not yet written here — this section is DST's own to add" since before DST's first commit — DST shipped in full (D0–D5) and nobody came back to fill it in. Found while re-grounding the repo's actual state for an unrelated review. Five dynamic invariants written, each cited against a real, verified-against-the-actual-file test: write atomicity under crash (D0), advisory-lock correctness under crash (D1), no phantom witness under concurrency (D2, generalizing D-092), the frontier BFS/real-Postgres equivalence (D3), and the shared fault-injection scheduler (D4). Explicitly disclaims overclaiming a parallel to the still-not-started temporal-safety layer.

**Verification:** documentation-only; `npx prettier --check .` clean. Full account: `docs/DECISIONS.md` D-127.

## Consistency token is now opaque on the wire (D-128)

**Owner:** the main agent, directly, on `main`.

`write_log.token` was exposed to every caller as a plain integer — `authz tuple write` printed it raw, the API returned it raw, `--at-token`/`atToken` both took it back raw. Nothing about that representation was ever a promise to callers, but exposing it directly made it one by accident. `src/store/tokens.ts` gains `encodeToken`/`decodeToken` — a small, versioned, base64url-encoded envelope — wired in at exactly two boundaries (the CLI's `tuple`/`check` commands, the API's `/tuples`/`/check` routes); every internal caller (`assertTokenObserved`, `ProductionCheckOptions.atToken`, the DST fake store) is untouched.

Explicitly not a security fix — no signature, no integrity check, stated plainly in D-128 — a forged token can only ever widen or narrow which freshness floor a check waits for, never grant a permission the tuple data doesn't already grant. Fail-checked live: `encodeToken` reverted to a raw `String(token)`, 10 real tests failed for the right reason, reverted, reconfirmed green.

**Verification:** `npx vitest run` (47 files, 602 tests, up from 578), `npx eslint .`, `npx tsc --noEmit`, `npx prettier --check .`, `npm run build` all clean. Full account: `docs/DECISIONS.md` D-128.

Second of the small batch of improvements identified while reviewing a proposed consistency-layer plan against this repo's actual state (first: `docs/INVARIANTS.md`'s dynamic-invariants section, D-127).

## A confirmed false HOLDS in the monotone-fragment exact prover, closed (D-129)

**Owner:** the main agent, directly, on `main`.

Found while grounding item 3 of the same batch (the exact type-mismatch upgrade to the monotone prover): an adversarial design-review workflow surfaced a claim that `checkInvariant`'s cycle guard could report a false `HOLDS` for a schema with no intersection or exclusion at all — squarely inside the fragment this project's own docs call "exact — sound and complete." Independently confirmed by hand: built the exact repro (a recursive `org.admin` relation, an invariant pinning the goal object's own `top_admin` away from the goal subject via `relationEquals`) and ran the witness through the real, unmodified `productionCheck` engine directly — `allowed: true` — while `checkInvariant` claimed `HOLDS`, no witness possible.

Root cause: the cycle guard keyed its visited-set on the schema node alone, unable to tell "truly redundant revisit" from "a different, freely-choosable object at the same node." Fixed by scoping a revisit per instance (the invariant's own named variable, or a shared key for any engine-minted fresh variable) instead of per node — plus a disclosed `MAX_ATTEMPT_CALLS` exploration-budget ceiling (a second, independent adversarial review found the first-draft fix could blow up combinatorially with named-variable count, though it always terminated) and a matching `UnionFind` fix so two aliased variables share one binding, not two.

Two full rounds of independent adversarial review before any of it shipped, plus three isolated live fail-checks (each confirmed to flip exactly the tests it should, nothing else) and direct re-verification of every claim against the real, shipped code — not taken on the reviews' word alone.

**Verification:** `tools/schema-verifier`'s own suite — 13 files, 124 tests (up from 115) — plus `npx eslint .`/`npx tsc --noEmit`/`npx prettier --check .` all clean. Full account, including the exact repro and both reviews' findings: `docs/DECISIONS.md` D-129.

This closes the bug; item 3 (the type-mismatch upgrade) resumes next on top of a cycle guard that's actually sound.

## Item 3 closed: `checkInvariant` can now decide some intersection/exclusion cases exactly, closing the disclosed `spicedb-googledocs-typecheck-bug` gap (D-130)

**Owner:** the main agent, directly, on `main`.

Two narrow, sound short-circuits added to `search.ts`'s `attempt()`: AND-infeasibility (an intersection with any structurally-impossible child is impossible as a whole) and exclusion reduction (`A - B` reduces exactly to `A` when `B` is structurally unreachable). `checkAndValidate` now always calls `checkInvariant` first, regardless of fragment, falling back to bounded search only when it genuinely can't decide on a structurally non-monotone schema. A new `proof: 'exact' | 'bounded'` field on `CheckResult`, decoupled from `fragment`, reports which.

Directly re-verified against the real disclosed fixture: `spicedb-googledocs-typecheck-bug`'s `edit_always_unreachable_for_any_user` now reports an unconditional `HOLDS` (`fragment: non-monotone`, `proof: exact`), where it used to be `HOLDS up to k = 1`. `docs/FINDINGS.md` and D-124's tally updated to reflect the gap is closed (the _other_ previously-bounded entry, `spicedb-userdefined-roles`, is a genuinely different kind of gap and is unaffected).

Grounded and adversarially reviewed via an 8-agent workflow before D-129 (that review is what surfaced D-129's cycle-guard bug in the first place) — implementation waited until that dependency was actually fixed, then re-verified directly against the real, shipped code. Fail-checked live: three isolated breaks (Rule A, Rule B, the routing change) each confirmed to flip exactly the tests they should, nothing else — proving the unit tests and the integration test catch genuinely different pieces of the change.

**Verification:** `tools/schema-verifier`'s own suite — 14 files, 134 tests (up from 124) — plus `npx eslint .`/`npx tsc --noEmit`/`npx prettier --check .` all clean. Full account: `docs/DECISIONS.md` D-130.

This closes the batch begun at D-127/D-128 (dynamic-invariants stub, token opacity, the cycle-guard fix, and this) plus the originally-planned item 3. Item 2 (the negative-constraint primitive) and the fourth full-repo audit remain, per the agreed build order.

## Item 2 closed: a new `notRelationEquals` invariant primitive, shipped narrow and honestly scoped — closes 2 of 9 disclosed entries, not the 8 originally hoped for (D-131)

**Owner:** the main agent, directly, on `main`.

A new `not <relation>(<var>) = <var>` primitive, mirroring `relationEquals`'s own scope exactly (bare-principal only, declared variables only, no fresh/existential form): ruling out one specific, already-known `(relation, subject, value)` triple. Enforced at exactly two sites — the exact search's bare-principal direct edge (`search.ts`, checked against the post-bind union-find state, not pre-bind, since `bindSlot`'s own union side effect is what can create the very collision being checked for) and the bounded search's candidate generation (`bounded/candidates.ts`) — plus a new upfront contradiction check in `checkInvariant` (an invariant pinning a slot via `relationEquals` and simultaneously excluding that same value via `notRelationEquals` is self-contradictory, reported `UNKNOWN`, not silently searched anyway). A new read-only `UnionFind.slotEquals` primitive backs both checks.

Grounded and adversarially reviewed before any shipped code was written — and the review's own two agents directly disagreed on the primitive's real-world value: one traced `openfga-github`'s witness by hand and found a second, unblockable userset-subject escape route the primitive can't reach; the other, without ever running the "after" state, wrote a test asserting most of the eight same-shape disclosed entries would close. Rather than trust either claim, independently prototyped both enforcement sites against the real, unmodified repo and ran all eight candidate entries through it by hand. **The real count: 2 of 8, not 8 of 8** — `spicedb-entitlements` and `openfga-entitlements`, both a single-chain closure with no alternate escape; the other 6 have a second, structurally different (userset-subject or recursive) escape this narrow primitive was never designed to reach. Presented the corrected finding to the user and asked for direction — decision: ship the narrow primitive as designed, on this honestly-scoped basis, not the larger redesign.

Directly re-verified against the real fixtures: both entitlements invariants gained one line, `not member(o2) = u`, and now report `HOLDS` (exact, monotone) against the real CLI. All 7 remaining disclosed `VIOLATED` entries re-run unmodified and stay `VIOLATED` — no over-claim. `docs/FINDINGS.md` updated: tally moves from 9 VIOLATED/3 HOLDS to 7 VIOLATED/5 HOLDS, and the "recurring finding" section states the 2-of-9 closure explicitly.

Fail-checked live: three isolated breaks (the exact-search site-1 check, the bounded-search filter, the upfront contradiction check) each confirmed to flip exactly the tests they should, nothing else — including confirming the contradiction check's absence degrades silently to `HOLDS` rather than crashing or false-`VIOLATED`, the predicted failure mode.

**Verification:** `tools/schema-verifier`'s own suite — 15 files, 151 tests (up from 134, 17 net new) — plus `npx eslint .`/`npx tsc --noEmit`/`npx prettier --check .` all clean. Full account: `docs/DECISIONS.md` D-131.

This closes the four-item batch begun at D-127/D-128 in full (dynamic-invariants stub, token opacity, the cycle-guard fix, the intersection/exclusion short-circuits, and this). The fourth full-repo audit remains, per the agreed build order.

## Fourth full-repo audit: 14 findings (1 critical, 7 medium, 6 low), 0 refuted — working through them by severity

**Owner:** the main agent, directly, on `main`.

Ran the `full-repo-audit` workflow (14 parallel review dimensions, adversarial verification of every raw finding before it's reported). Result: 14 findings survived verification, 0 refuted.

**Critical (1):** an unauthenticated, confirmed, live-reproduced CPU-exhaustion DoS in the schema parser.
**Medium (7):** a production-resolver false-deny gap (D-012's own "revisit if" condition, never closed) · a build-script merge-not-mirror bug in `dist/` migrations · no API body schema uses `.strict()`, silently dropping typo'd fields like `atToken`/`subjectRelation` · `expand()`'s multi-parent tuple-to-userset branch untested against real Postgres · `serve.ts` has zero test coverage · `POST /check`'s malformed-token rejection path untested · a doc screen shows a stale pre-D-064 `/health` response shape.
**Low (6):** `serve()`'s `buildServer()` call unguarded, breaking this file's own try/catch convention · no test sends `subjectRelation` through the tuples API · a test cites a removed `docs/RELATIONS.md` line · README's reference table reads as if `/check`/`/expand` are unauthenticated · `env.ts`'s `ADMIN_API_KEY` comment understates D-064's scope · `NODE_ENV` validated/defaulted but drives no runtime behavior.

Full findings detail (file/line, reproduction, verdict, suggested fix) recorded in the audit's own report, summarized per-finding in the entries below as each is closed. Working through them critical → medium → low, per the user's own explicit direction.

## Critical audit finding closed: unauthenticated O(N²) CPU-exhaustion DoS in the schema parser's `flattenChildren` (D-132)

**Owner:** the main agent, directly, on `main`.

`src/schema/dsl/parser.ts`'s `flattenChildren` rebuilt the entire accumulated children array via array-spread on every step of a flat, unparenthesized same-operator chain (`a1 & a2 & ... & aN`) — genuine O(N²) work. Reachable through `POST /schema/compile`, one of only two routes that deliberately skip auth (D-067), which calls `compileSchema()` synchronously with no `await` — blocking the entire event loop, including `/health`, for every caller. A ~32,700-term chain (the largest that fits the real 65,536-byte body cap) took 8.3s of pure CPU before the fix; ~7-8 such requests, comfortably inside the existing 100/min rate limit, are enough to wedge the server permanently. Structurally distinct from the two DoS classes D-067 already closed (native recursion) — this involves zero recursion, so neither existing guard touched it.

Fixed by extending the accumulated array in place (a loop, not a spread-into-push, to avoid any engine's argument-count limit) instead of always copying it — amortized O(1) per term instead of O(n). Re-verified directly: 8.3s → 49ms at the exact byte-cap boundary; the D-094 symmetric-flattening invariant (`a|(b|c)` and `(a|b)|c` producing identical shapes) confirmed untouched.

3 new tests (`test/unit/schema/recursion-depth-guards.test.ts`, alongside D-067's own DoS regression suite, documented there as "Bug C"): 60,000-term flat `&`/`|` chains must compile fast _and_ produce a correctly-shaped node with all children present (not just fast — a silently-truncating fix would be worse than the bug), plus a mixed-operator test confirming the in-place mutation never aliases state across independent operators. Fail-checked live: reverting the fix flipped exactly the 2 timing-sensitive tests red (27s vs a 10s ceiling), nothing else.

**Verification:** `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .`, `npx vitest run` (47 files, 605 tests, up from 602) all clean; `tools/schema-verifier`'s own suite (151 tests) reconfirmed unaffected. Full account: `docs/DECISIONS.md` D-132.

## Fourth full-repo audit closed in full: the remaining 13 findings (7 medium, 6 low), all in one PR per explicit direction (D-133)

**Owner:** the main agent, directly, on `main`.

Closed all 13 remaining findings from the fourth full-repo audit's 14-item report:

- **#2 (medium):** closed the D-012 "revisit if" gap for real — `validateAgainstSchema` now verifies a tuple-to-userset subject's `subjectRelation` actually names a relation, not a permission, on the subject namespace's own published config, closing a genuine cross-resolver false-deny. Deliberately lenient when the subject namespace isn't published yet (publish order must stay unconstrained).
- **#3 (medium):** `copy-migrations.mjs` now mirrors `dist/store/migrations/` (removes stale files first) instead of merely merging into it.
- **#4 (medium):** every API request body schema now uses `.strict()` — a misspelled `atToken`/`subjectRelation` is a 400, not a silent, undetectable semantics change.
- **#5 (medium):** `expand()`'s multi-parent tuple-to-userset branch (`children.length > 1`) now has real test coverage.
- **#6/#9 (medium/low):** `serve.ts` gained its first test file (4 tests) and its `buildServer()` call is now guarded by the same try/catch every sibling CLI command already uses.
- **#7/#10 (medium/low):** `POST /check`'s malformed-`atToken` rejection and `subjectRelation` passthrough on the HTTP tuples routes are now tested.
- **#8 (medium):** a doc screen's `/health` example updated to the real, current response shape.
- **#11/#12/#13 (low):** three doc-drift fixes — a stale test citation, a README table implying two routes are unauthenticated when they're not, and an `env.ts` comment understating what an unset `ADMIN_API_KEY` disables.
- **#14 (low):** `NODE_ENV`'s informational-only status now disclosed explicitly, matching `CHECK_CACHE_TTL_MS`'s own D-028 precedent.

Two findings (#2, #5) have a real-Postgres integration-test half this sandbox couldn't run locally — no working Docker daemon here (confirmed live: `Could not find a working container runtime strategy`, not assumed) — so those were verified instead by direct code/compiler inspection plus a DB-free counterpart test proving the same logic against the DST fake store. Reported honestly in `docs/DECISIONS.md` D-133 rather than claimed as locally-verified; CI's own `test-integration` job (Docker preinstalled) runs the real versions.

Fail-checked live everywhere a real bug existed to revert: the D-012 gap (DST fake, 2/4 tests correctly flip), the migrations mirror fix (a real stale-file injection, both directions), `.strict()` (7 tests flip, each to a 503 instead of 400 — itself confirming the domain function really was being called without the fix), and the `serve.ts` `buildServer` guard (1 test flips, error propagates uncaught as predicted).

**Verification:** `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .`, `npx vitest run` (48 files, 623 tests, up from 605) all clean; `tools/schema-verifier`'s own suite (151 tests) reconfirmed unaffected; `npm run build` clean. Full account: `docs/DECISIONS.md` D-133.

This closes the fourth full-repo audit in full — all 14 findings addressed (1 critical via D-132, 13 medium/low via this entry).

## Five post-audit improvements, shipped together in one PR per explicit direction: CI nightly wiring, the check-result cache (D-028), bulk reverse-lookup endpoints, Redis-backed horizontal-scaling readiness, and a scoped read-only credential tier (D-064)

**Owner:** the main agent, dispatching a soundness-engineer for `listObjects`/`listUsers` and a test-author for the remaining wiring-level test coverage, on `post-audit-improvements`.

Asked what to build next after the fourth full-repo audit closed, the user picked all four of the main agent's proposed items from a grounded research pass, plus the already-agreed CI scheduling fix, with the Redis item scoped opt-in/default-off per the user's own explicit choice — and directed everything into one combined PR.

**1. `schema-verifier`'s nightly k=3 differential test, built but never scheduled, is now actually wired into CI (D-134).** `tools/schema-verifier/test/differential.nightly.test.ts` (§8b) existed, ran correctly on demand, and was even disclosed in this repo's own README as "run nightly, not on PRs" — but no scheduled job ever actually invoked it. `.github/workflows/schema-verifier.yml` now has a `schema-verifier-nightly` job on a daily cron, mirroring `dst.yml`'s own `dst-pr`/`dst-nightly` split. Verified locally: 1 test file, 1 test, 327s.

**2. The check-result cache is built, closing D-028 (D-135).** `src/resolve/production/cache.ts`, opt-in via `CHECK_CACHE_TTL_MS` (still `0`/off by default), wired into `performCheck` as a new optional parameter every existing call site is unaffected by. Before any implementation code was written, the design went through an adversarial-review workflow — three independent skeptics, each explicitly tasked with trying to break it — and all three, working independently, found the same real, critical race the first design draft missed: a `clear()` from a concurrent write could land while an unpinned check's own `productionCheck` call was still in flight, and that check's own miss-path `cache.set()` would then write its now-stale answer back in _after_ the clear that was supposed to invalidate exactly that data. Closed with a monotonic epoch fence (`beginMiss()`/`trySet(epoch, ...)`) before any of the surrounding wiring was built. The same review also caught two more real bugs: the audit-log insert on a miss ran _before_ the cache write instead of after (so a discarded, never-logged decision could live on in the cache and be served under a different caller's own, misleadingly-timestamped audit row) and `toad-cache`'s real `ttl <= 0` behavior is "cache forever," not "disabled" — the exact opposite of this project's own default, closed structurally via `createCheckCache` returning `undefined` for any non-positive TTL rather than trusting every call site to re-derive that gate correctly, forever. All three fixes are proven by fully deterministic (no real timing, no Postgres) regression tests before any server-level wiring was added, then re-proven at the real HTTP-route level once that wiring existed (cache-hit dedup, `clear()` reachable from all three mutation routes, the success-only guard, the default-off regression guard).

**3. `listObjects`/`listUsers`, the two bulk reverse-lookup operations neither `/check` nor `/expand` answered (D-136).** Dispatched to a soundness-engineer with an explicit soundness argument to independently verify before writing any code (an object with zero `relation_tuples` rows naming it as object can never be `allowed: true` — confirmed against the real resolver, no counterexample found) and an explicit warning about a real correctness trap for `listUsers`: naively flattening `expand()`'s own tree over-reports for `intersection`/`exclusion` permissions, since those nodes show each branch's raw membership independently, not the combined boolean formula's actual result. `evaluateExpandNode` implements the real set-algebra evaluation instead, proven by a real-Postgres differential test against an independent brute-force oracle plus a named trap test confirming a subject naive flattening would wrongly include is genuinely absent from the real output — and, fail-checked live: temporarily broken back to naive flattening, both the unit and integration trap tests failed with exactly the predicted diffs before being reverted. Neither function logs to the `checks` audit table (mirrors `expand()`'s own established precedent) — a disclosed, deliberate gap, not an oversight.

**4. Opt-in, default-off horizontal-scaling readiness (D-137).** `src/api/redis-store.ts`, a new `REDIS_URL` env var (unset by default — this project's own real deployment stays single-instance and constructs nothing new). When set, backs both `@fastify/rate-limit`'s own bundled `RedisStore` and the hand-rolled `authFloodGuard` counter (D-105), the latter via a new `RedisFloodStore` using an atomic `INCR`+`PEXPIRE`+`PTTL` Lua script so a fresh key's expiry can never be lost to a concurrent-increment race.

**5. A second, scoped read-only credential tier, closing D-064's own "Revisit if" (D-138).** `checkReadAuth` (`src/api/auth.ts`) — a new, optional `READONLY_API_KEY` authorizes `/check`, `/expand`, `/list-objects`, and `/list-users` without also granting write access; `ADMIN_API_KEY` alone still authorizes every read route exactly as it did before this tier existed, so every pre-existing deployment is unaffected.

**Verification:** `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .` all clean. Root suite: 54 files, 731 tests (up from 623 before this batch — 108 net new). `npm run build` clean. The `listObjects`/`listUsers` real-Postgres integration test was verified against a throwaway local Postgres database (Docker unavailable in this sandbox, the same honestly-disclosed gap this project has hit before — D-092/D-093/D-107's own LOCALVERIFY precedent), then the committed file was confirmed restored to its exact, unmodified `PostgreSqlContainer` form before shipping. A final integration-level adversarial-review workflow (three lenses: route-gating completeness across the whole of `server.ts`, cache-invalidation-path completeness across every real mutation route, and a diff-based regression check against every pre-existing route/response shape — the last one backed by a real live smoke test against real Postgres, not just a diff read) ran across the fully combined diff before this was opened as a PR. Route-gating and cache-invalidation both came back clean (every route enumerated, all three mutation paths confirmed to call `checkCache?.clear()` correctly gated and synchronously ordered before their own response). The regression pass found one real, previously-unflagged behavior change: `/check`/`/expand`'s 401 rejection text changed from "missing or invalid admin API key" to "missing or invalid API key" as a direct, correct consequence of those routes now accepting either credential — D-138's own "zero behavior change" claim was overstated and has been corrected to scope that claim to authorization _outcome_, not response _text_. A second, lower-severity documentation-consistency gap (D-137's "Revisit if" note not clarifying that `REDIS_URL` doesn't also make the check cache cross-replica-safe) was fixed the same way. Neither required a code change — both were doc-accuracy fixes to `docs/DECISIONS.md` D-137/D-138, made before opening the PR.

Full account of all five items, including the exact race the cache's adversarial review found and how it was closed: `docs/DECISIONS.md` D-134 through D-138 (plus update notes on D-028 and D-064).

## Live-verification doc audit — a new audit methodology, run and acted on (D-139)

**Owner:** the main agent, dispatching 7 parallel review agents, one or more doc files each.

Asked whether a genuinely new audit methodology could find gaps `full-repo-audit`'s existing `docs-accuracy` dimension can't, proposed and — per explicit user direction, first of four agreed follow-on audits — ran a **live-verification doc audit**: every checkable claim in every doc file actually executed, run, or counted against live ground truth, not just re-read and compared by inspection. Scope: every doc file in the repo, including six previously outside `docs-accuracy`'s coverage (`tools/schema-verifier/README.md`, `tools/schema-verifier/thirdparty/README.md`, `docs/INVARIANTS.md`, `docs/FINDINGS.md`, `docs/DST-PROPOSAL.md`, `docs/dst-regression-corpus.json`, `test/isolation/README.md`), plus a re-confirmation pass on everything `docs-accuracy` already covers.

**Headline finding:** `docs/DST-PROPOSAL.md` still opened "A proposal, not yet built" while the entire design it describes (D0–D5) had shipped weeks earlier as D-097 through D-102 — self-contradicted by `docs/INVARIANTS.md`'s own "actually shipped and proven" language about the identical work, and undetected through however many `docs-accuracy` passes ran in the meantime. Fixed with a status banner, the phased plan converted from roadmap to completed record, and two real content corrections disclosed inline: two of the three "promoted operations" the proposal describes were never built as named two-implementation helpers (D-098/D-099 instead special-cased literal SQL text in the fake, same mechanism as the plain shapes), and one of the two "grafts" — a pg-side runtime check enforcing snapshot-anchoring query order — was applied only to the in-memory fake, never to the real production resolver, a genuine still-open gap flagged rather than silently fixed (out of scope for a doc pass).

**Six more confirmed, real findings, all fixed:** `docs/RELATIONS.md`'s opening schema snippet didn't compile as printed (missing `relation parent: folder` — caught by literally feeding it to the real compiler); `tools/schema-verifier/README.md` and `docs/FINDINGS.md` both had the third-party survey's OpenFGA/SpiceDB split backwards (claimed six/six, really five/seven, one of the seven from a different source repo entirely); `tools/schema-verifier/README.md` still described the nightly CI job as unwired, though D-134 (this same batch) had already wired it; `docs/github-governance.md` cited a stale integration-test file count (13, live is 18); `docs/INVARIANTS.md` said "all five" known-answer fixtures where a sixth had since been added; `test/isolation/README.md` omitted a fourth test file from its lineage table and still described the suite's tests as `it.todo()` placeholders when zero remain. Two low-severity stale line-number citations inside `docs/DECISIONS.md` itself (D-069, D-132 — code moved due to later, unrelated edits) were also corrected.

**Confirmed clean, not assumed:** `docs/CONSISTENCY.md`, `docs/DELIVERY.md`, `docs/screens/README.md`, `docs/dst-regression-corpus.json`, `tools/schema-verifier/thirdparty/README.md`, `PROGRESS.md`'s own recent sections, `README.md` (re-confirmed post-merge), and `docs/FINDINGS.md`'s full 12-schema verdict table (independently re-run live against the real CLI) all had zero real drift after actually being executed, counted, or read against live source — each agent's report says explicitly what it checked, not just that nothing was found.

**Verification:** `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .` all clean (`test/isolation/README.md`'s table needed one `prettier --write` pass). Root suite unchanged: 54 files, 731 tests, re-confirmed both before and after this batch's edits (pure documentation changes plus two corrected schema snippets in `docs/RELATIONS.md`, re-verified against the real compiler and the real `schema/example.authz`).

Full account, including every finding's exact evidence and the argument for why this catches a different class of drift than `docs-accuracy`: `docs/DECISIONS.md` D-139.

## Metamorphic/invariant testing — a fourth proof mechanism (D-140), second of four requested audits

**Owner:** the main agent, dispatching a design workflow (one `soundness-engineer` proposing 7 candidate properties, one independent skeptic per property adversarially reviewing it) followed by an implementation workflow (5 `soundness-engineer` agents: classifier, algebraic properties, DST token-pin coverage, monotonicity integration, and a final adversarial review of the whole diff).

Asked to keep going with the three remaining audits after the live-verification doc audit, per the user's own explicit ordering. Built a genuinely new proof mechanism: mathematical properties of the ReBAC model checked directly against the real production engine, needing no second implementation to compare against — closing the one blind spot differential fuzzing structurally cannot reach (a bug both the production engine and the reference resolver share, from a common misreading of the same spec sentence, would still agree with itself forever).

**Every one of the 7 originally-proposed properties turned out flawed on adversarial review — not a formality.** Two justifications cited the wrong source function (the real relation-membership mechanism follows userset-subject edges across namespaces; the cited SQL was a different, narrower function). One property's "atToken pins an exact historical snapshot" framing was directly false — `atToken` is a floor, never a ceiling. One property's original "backward" half ("a check never observes a write with a higher token than its own pin") was proven **false** by a real, constructed counterexample against this repo's own DST/`raceUnderPause` machinery — dropped entirely rather than softened. Three sketches used a hyphenated UUID directly in a namespace name, which `IDENTIFIER_PATTERN` rejects. One property's own generator-guaranteed fixture would have been silently misclassified by the exact algorithm the property's own text specified. Every one got a corrected, narrower, re-verified-sound version before implementation began.

**Shipped: 4 new files, 69 new tests, zero existing files modified.** `src/metamorphic/monotonicity.ts` (+ 7 unit tests) — a conservative, sound-but-incomplete classifier deciding whether a permission's transitive rewrite closure is exclusion-free. `test/metamorphic/algebraic-properties.integration.test.ts` (6 tests, real Postgres) — idempotent-write invariance, write-order commutativity, a sole-grounding-tuple deletion cross-checked against `expand()`, and an ungrounded cyclic tuple graph proven denied-and-terminating at three independent guard levels (SQL recursive-CTE, TypeScript `visited`-Set, depth ceiling). `test/metamorphic/monotonicity.integration.test.ts` (2 tests, real Postgres, 50+20 seeds) — a monotone permission never loses a previously-granted subject under pure tuple addition; the one guaranteed exclusion shape this repo's fuzzer ships never gains one. `test/unit/store/dst/token-pin-coverage.dst.test.ts` (54 tests, DB-free) — generalizes the existing D-092 phantom-witness regression across all four rewrite-rule kinds and every real pause point each issues.

**A real, minor gap the implementation's own adversarial review caught before shipping:** Property 4's health-check only asserted a nonzero _classified_ count, not a nonzero count of pairs that actually reached the property's own assertion — closed with a second, more precise counter, matching this project's own D-119 (M7/M8/M9) precedent for exactly this class of gap.

**Fail-checked directly, three distinct mechanisms, after implementation:** swapped `deleteTuple`'s bind-parameter order — Property C failed immediately for the right reason. Disabled `resolve()`'s TS-level cycle guard — a safe, DST-fake-bounded repro showed resolution depth jump from 2 (fast cycle-catch) to 21 (forced to the ceiling) with the guard gone. The SQL-level recursive-CTE guard was verified by reasoning plus a non-executing `EXPLAIN` plan check rather than a live broken run — actually executing that specific unbounded query against the shared local Postgres carried real, disclosed operational risk this project's own D-119 M5 precedent already established the honest way to handle.

**A real, disclosed production hazard found as a byproduct, not fixed here:** Property A's first draft deadlocked for real against local Postgres running its two query batches concurrently — traced to a genuine, currently-latent structural gap between `MAX_CONCURRENCY` (default 8) and the connection pool's default size (`max: 10`), an implicit numeric relationship enforced nowhere. Fixed in the test itself (made sequential); the production-code gap is disclosed, not silently dropped, as real standalone follow-up work.

**Verification:** `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .` all clean. Root fast suite: 56 files, 792 tests (up from 54/731). The two real-Postgres integration files (8 tests) independently re-confirmed by this entry's own author post-implementation, not just trusted from agent reports, via this repo's own established LOCALVERIFY accommodation — each file's committed, container-based form confirmed checksum-identical after every temporary local substitution.

Full account: `docs/DECISIONS.md` D-140.

## Mutation testing of the core engine — hand-curated, live-executed mutations (D-141), third of four requested audits

**Owner:** the main agent, dispatching a design workflow (one `soundness-engineer` agent per file — `resolver.ts`, `tuples.ts`, `publish.ts`, `checks.ts` — each proposing concrete mutation candidates with a predicted symptom and a self-run live fail-check where feasible), then personally re-verifying every candidate flagged as a real gap and every fast/DB-free candidate directly.

Asked to complete the remaining two of four requested audits, built mutation coverage of the four files carrying this project's actual soundness/audit guarantees — deliberately as hand-curated, load-bearing mutations rather than adopting a framework, the identical discipline `tools/schema-verifier`'s own D-119 already established and documented: a mechanical operator-flipper scores hundreds of equivalent or trivial mutants; a human/agent choosing plausible real bugs finds the ones worth finding, each proven live, not just counted as "killed."

**The design workflow's first launch failed entirely** on a transient tool-execution/permission-handler infrastructure fault (traced through the raw agent transcripts, not guessed) unrelated to the script itself — one agent correctly self-reported it had no real mutation to propose rather than hallucinate content. A fresh relaunch of the identical script succeeded completely.

**21 total candidates across 4 files. 5 real, confirmed, previously-100%-uncovered coverage gaps found and closed with new tests; 1 candidate left honestly disclosed as reasoning-only; the remaining 15 confirmed caught by existing coverage.** Two gaps stood out as the most valuable class of finding this exercise exists to produce — a concrete input sequence that reaches a wrong `allowed`/`denied` answer in the shipped, unmutated engine today, with _zero_ existing test (fast suite or real-Postgres integration) catching it:

1. **`tuple-to-userset-first-subject-only`** (`resolver.ts`) — narrowing `evalRewrite`'s `tupleToUserset` case to try only the first stored subject a followed relation returns, not every one. Nothing in the schema or tuple store prevents a `parent`-style relation from carrying more than one tuple on the same object; no existing fixture ever wrote two. Closed with a new DST test writing a non-granting tuple first (tried first, deterministically) and the real grant second, proving every stored subject is followed.
2. **`frontier-join-drops-relation-filter`** (`resolver.ts`) — dropping one of three predicates (`rt.relation = m.relation`) from `fetchReachableFrontier`'s recursive CTE join, making it object-scoped instead of relation-scoped: a userset tuple stored under one relation leaks into a _different_ relation's transitive frontier on the same object. No existing fixture ever put two different userset-carrying relations on one object. Closed with a new real-Postgres integration test (plus a control proving the matching-relation form genuinely does grant).

**Three more real gaps, flagged by their own design agents and independently re-verified live by this entry's own author:** `tuples.ts`'s `subjectTypeAllowed` check (`&&` weakened to `||`) let a **plain** subject sneak past validation by matching only half of one declared entry and half of a different one — closed with a new test proving a plain `group:eng` write is rejected even though `user` (plain) and `group#member` (userset) are each independently declared. `publish.ts`'s compile-failure branch, mutated to drop the real per-error compiler diagnostic in favor of a generic placeholder, evaded every test because none ever asserted on `result.errors`'s actual content — closed with a test asserting the real undeclared-relation name appears in the returned error. `publish.ts`'s ROLLBACK-failure-masking catch block (mirroring `production-check.dst.test.ts`'s own D-106 regression for `productionCheck`, but never independently proven for `publishSchema` itself) — closed with a new D-106-equivalent test: a connection that dies mid-transaction still surfaces the original crash, not a second, masking ROLLBACK-failure error.

**One candidate left honestly disclosed, not live-executed:** a TS-level cycle-guard removal in `resolver.ts` whose own designer raised an unresolved concern about a false-grant vector through `exclusion`-branch interaction that couldn't be safely bounded for a live trial — the identical disposition D-119's own M5 finding already established as this project's precedent for exactly this situation.

**The remaining 15 candidates** — re-verifying two of D-069's own historical bugs (the TS depth ceiling, the relation-lookup budget reduction), `intersection`'s early return, the token-snapshot floor check, D-092's `REPEATABLE READ` isolation (34/72 tests broke), three distinct D-135 check-cache race re-derivations, and four more `tuples.ts`/`publish.ts` candidates (`writeTuple`'s `ON CONFLICT`, `deleteTuple`'s WHERE clause and parameter order, `insertWriteLog`'s parameter order, the per-loop transaction-commit granularity, `publishOne`'s version-increment logic) — were all confirmed caught by existing tests.

**Verification:** `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .` all clean. Root fast suite: 56 files, 796 tests (up from 56/792 — 4 net new DB-free tests). Both touched real-Postgres integration files independently re-run in full via this repo's own LOCALVERIFY accommodation (27/27 and 22/24 — the 2 non-running tests sit in an unrelated, separately-containered describe block this sandbox's Docker-less setup can't start at all, not a mutation-testing regression). `resolver.ts`/`tuples.ts`/`publish.ts` confirmed byte-clean after every mutation trial; all four touched test files are pure additions with zero deletions.

Full account, including every candidate and its exact resolution: `docs/DECISIONS.md` D-141.

## A real concurrent load test — genuine OS-level HTTP concurrency (D-142), fourth and final of four requested audits

**Owner:** the main agent.

Built the one proof mechanism this repo's test suite genuinely lacked: `test/unit/api/concurrent-load.integration.test.ts` starts a real, listening Fastify server (`app.listen()` on an OS-assigned loopback port — every other test that touches `buildServer` uses `app.inject()`, which never opens a real socket) and fires genuinely concurrent HTTP traffic at it via Node's built-in `fetch` and `Promise.all`. No new dependency. This is deliberately a _different_ proof mechanism than the DST suite, not a duplicate: DST is one process, deterministically paused and resumed at hand-chosen statement boundaries — exhaustive but only within the interleavings it was told to construct; this file exercises the real OS scheduler, real concurrent connections, and real, non-deterministic timing instead.

**Two tests, targeting the two mechanisms in this codebase specifically about concurrent traffic.** (1) The rate limiter under a genuine 30-request concurrent burst against a 20/minute budget — exactly 20 succeed, exactly 10 get `429`, nothing hangs or double-counts, reliably across every run. (2) The check-result cache's D-135 epoch fence under real concurrent racing (not DST's deterministic pause injection) — several independent trials, each establishing a grant, priming the cache, then racing a real revocation against a burst of concurrent re-checks, asserting the final settled state always correctly reflects the revocation.

**A real bug in the file's own first draft, caught live before shipping.** Both tests originally shared one `buildServer()` app. `@fastify/rate-limit`'s counters are per-process, per-route — the rate-limit test's own deliberate burst exhausted the write-route budget for the rest of the file, so the epoch-fence test's own `DELETE /tuples` calls started silently returning `429` instead of actually deleting anything, and the epoch-fence test failed for a completely uninteresting shared-state reason, not the real property it exists to check. Fixed by giving each describe block its own dedicated `app` against one shared Postgres container.

**A disclosed limitation of this file's own live fail-check, found by actually trying it.** The epoch-fence test was fail-checked per this project's own discipline: the epoch guard was disabled live and the test re-run against the mutation, both as a one-on-one race and as a one-delete-vs-ten-concurrent-checks burst. Neither ever caught it, confirmed clean across repeated runs. Real concurrent timing on this sandbox's fast, jitter-free loopback path never lands inside the microsecond-scale unsafe window DST deliberately constructs on demand — `Promise.all`'s own left-to-right eager evaluation gives the delete a small, consistent head start that dominates real variance on one machine with no real network jitter. Trying to force more timing variance by shrinking the test's own connection pool **independently reproduced this project's own already-disclosed D-140 connection-exhaustion deadlock hazard live** (hung outright under `max: 4` with 10 concurrent checks, killed after a 2-minute timeout) — not pursued further, since deliberately risking a known, disclosed, still-unfixed deadlock in CI would trade one honest gap for a flaky, hanging suite. The epoch fence itself is not left unverified by this: D-135's own dedicated unit test and D-141's mutation-testing pass both already fail-check this exact mechanism deterministically. What this file adds is different, complementary evidence — across many independent real trials over genuine concurrent HTTP traffic, the system is never observably wrong at rest, and nothing crashes, hangs, or double-counts under real load.

**Verification:** `npx tsc --noEmit`, `npx eslint .`, `npx prettier --check .` all clean. New, real-Postgres-only file (adds nothing to the 56-file/796-test fast suite); independently re-run in full via LOCALVERIFY, reliably green across 6+ repeated runs with no flakes observed. Named `*.integration.test.ts` deliberately — the existing `test-integration` CI job already runs every file matching that suffix, so this needs zero new CI wiring.

This closes the fourth and final of the four audits requested after the live-verification doc audit (D-139 → D-140 → D-141 → this entry).

Full account: `docs/DECISIONS.md` D-142.
