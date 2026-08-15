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
