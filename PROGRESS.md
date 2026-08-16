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
