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
*permission* instead of a relation, and a self-referential `permission
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

**Not yet done:** `test-author`'s test suite (in progress at time of this
commit — Phase 1's CHECKPOINT isn't reported until that's back and
reviewed too). The CLI's `authz schema compile <file>` command (§7) —
Phase 1 built the DSL layer only; wiring it to the CLI is still open,
possibly folded into this phase's completion or deferred to whichever
later phase first needs it from the command line.
