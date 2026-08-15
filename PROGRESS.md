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
