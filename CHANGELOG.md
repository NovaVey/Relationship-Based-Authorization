# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.1] - 2026-08-14

### Fixed

- `package.json`'s `homepage`, `bugs.url`, and `repository.url` (and a
  JSDoc `@link` in `src/rbac/middleware.ts`) used an all-lowercase repo
  path (`NovaVey/multi-tenant-security-kit`) instead of the repository's
  correct case (`NovaVey/Multi-Tenant-Security-Kit`). GitHub's own routing
  is case-insensitive so this never broke anything on github.com, but it
  broke the OpenSSF Scorecard badge/viewer link in `README.md` —
  `scorecard.dev`'s lookup is case-sensitive and returned "invalid repo
  path" for the lowercase form. Fixed the same casing across every other
  reference repo-wide (docs, issue templates, `CONTRIBUTING.md`'s clone
  command).

## [1.1.0] - 2026-08-14

Fixes every issue found by a post-1.0 in-depth security audit — 17
findings across `src/`, release infrastructure, and docs, shipped as 5
phases (Critical → High → Medium → Docs, each merged and CI-verified
before the next started; see PRs #25, #27, #28, #29, #30).

### Fixed

- **Critical:** `generateTenantIsolationPolicySql` emitted both `USING`
  and `WITH CHECK` unconditionally regardless of `command`, but Postgres
  only accepts `WITH CHECK` on `INSERT`/`UPDATE`/`ALL` policies and only
  accepts `USING` on `SELECT`/`UPDATE`/`DELETE`/`ALL` — so `command:
'SELECT' | 'INSERT' | 'DELETE'` (all documented values) produced a
  `CREATE POLICY` statement that failed outright against a real database.
  Verified against a live Postgres 16 container. No change for the `ALL`
  default or `UPDATE`.
- **`AuditLogger.log()`** could throw despite its documented "never
  throws" guarantee — a throwing `redact` wasn't try/catch-protected like
  sink writes. Now caught, reported via `onSinkError`, and the event is
  dropped (not delivered unredacted) on failure.
- **`RbacPolicy.can()`/`.assert()`** never validated `subject.roles` is
  an array. A malformed `roles` either silently iterated a string
  character-by-character or threw a raw, unbranded `TypeError` out of
  `assert()` — not `instanceof ForbiddenError`, so `requirePermission`'s
  middleware skipped `onDenied` entirely. Both now cleanly resolve to a
  normal `ForbiddenError` denial.
- **`createTenantMiddleware`'s `onMissing`** didn't fire for a
  resolved-but-invalid tenant id, contradicting its own JSDoc/docs —
  threw `InvalidTenantIdError` instead, echoing the raw value via
  `JSON.stringify`. `onMissing` now fires for both cases via a new 4th
  `info: TenantMissingInfo` argument; the default handler no longer
  echoes the raw value.
- **`tenantWhereClause`'s `paramIndex`** was spliced directly into the
  returned SQL text with no validation — a non-integer value could
  inject arbitrary SQL text into the placeholder position. Now throws
  `InvalidSqlIdentifierError` unless `paramIndex` is a positive integer.
- **`TenantRateLimiter.consume()`** never validated `points` — zero,
  negative, `NaN`, or infinite values reached the store's arithmetic
  unchecked and could unconditionally bypass the limit. Now throws the
  new `InvalidRateLimitPointsError` before the store is ever called.
- **`MemoryRateLimitStore`** grew unboundedly — being deliberately
  timer-free, it never expired idle buckets, a real memory-exhaustion
  vector if the key space is reachable by unauthenticated input. New
  `maxBuckets` option (default `50_000`) bounds it via inline LRU
  eviction; adds a `.size` getter.
- **`package.json`'s `exports` map** broke TypeScript type resolution for
  every subpath under `node10` and `node16`-from-CJS resolution (a shared
  flat `types` key instead of per-condition `import`/`require` types, no
  `typesVersions` fallback) — types-only, real JS consumers were
  unaffected. Fixed and now permanently guarded by `npm run verify:types`
  (`@arethetypeswrong/cli` against the real `npm pack` tarball), wired
  into `npm run verify` and CI.
- **`release.yml`'s publish-detection guard** referenced a nonexistent
  `changesets/action` output twice in a row while chasing this down: an
  incorrect kebab-case fix (verified against the action's unreleased
  default-branch source) had to be reverted back to the correct camelCase
  `hasChangesets` (verified against the actual deployed `@v1` tag). Also
  hardened the npm-registry-propagation retry loop to fail the job
  loudly instead of silently warning on exhaustion, and extended its
  budget (~140s, up from a flat 30s).
- Every third-party GitHub Action across all 5 workflow files is now
  SHA-pinned instead of floating-tag-pinned (`changesets/action` and
  `ossf/scorecard-action` are deliberate exceptions).

### Documentation

- Clarified (JSDoc + `docs/rbac.md`, no behavior change) that
  `requirePermission`'s `getSubject` throwing is forwarded to `next(err)`,
  not treated as a denial via `onDenied` — only a `getSubject` that
  resolves to `undefined` is.
- Documented that RLS `tenantColumn` must be `text`-typed (`CREATE
POLICY` already failed loudly for `uuid`/`integer` columns; this was
  previously undocumented).
- Added the missing error-class rows (`SecurityKitError` + each module's
  specific error class) to all 6 module docs' API reference tables.
- Fixed `examples/express-basic.ts` so README.md's "audit logging on
  every denial" claim is actually true: the POST route's cross-tenant
  path and the rate-limit-denial path are now both audit-logged, matching
  the GET route's existing pattern.
- `SECURITY.md` no longer says "pre-1.0" — updated to describe the real
  1.x support policy.
- Fixed `docs/versioning-policy.md`'s cross-reference for where
  `examples/`'s typecheck exclusion is actually documented.

## [1.0.0] - 2026-08-14

First stable release. No breaking changes from `0.3.0` — this entry marks
a commitment, not a migration.

### What "stable" means from here

Per [`docs/versioning-policy.md`](./docs/versioning-policy.md), added in
`0.2.1`:

- **The public API is exactly what's reachable through this package's
  `exports` map** — the root entry point and the `/tenant`, `/rbac`,
  `/rate-limit`, `/audit`, `/rls`, `/crypto` subpaths. Nothing else is
  covered, regardless of what a source file happens to export.
- **`error.code` values are stable.** Every error this package throws
  extends `SecurityKitError` and carries a machine-readable `code`;
  existing values won't change or be removed without a `MAJOR` bump.
- **Nothing gets removed or renamed without a full deprecation cycle**:
  an `@deprecated` release first, removal only in the next `MAJOR` after
  that.
- Breaking changes are `MAJOR` only, new backward-compatible capabilities
  are `MINOR`, fixes are `PATCH` — including for `engines.node` bumps
  (driven by upstream Node's own EOL schedule, not this package's API).

### The path here

Six modules — `tenant`, `rbac`, `rate-limit`, `audit`, `rls`, `crypto` —
shipped together in `0.1.0` and hardened over four subsequent phases:

- **RLS enforcement verified against a real Postgres** (not just its
  generated SQL text), plus property-based fuzz testing of every
  identifier-validation code path against a curated SQL-injection-payload
  corpus, and an OpenSSF Scorecard supply-chain check.
- **Every code sample in `README.md` and `docs/*.md` is type-checked and
  run in CI** against the real built package — the exact mechanism that
  catches a doc that looks right but doesn't compile before it ships, not
  after — alongside fully automated Changesets-driven releases (this
  release included).
- **Auth-provider integration guide** (Auth.js, Clerk, Auth0) and a
  **Prisma/Drizzle RLS integration guide**, both verified against the
  real SDKs' installed types rather than assumed from memory.
- **Optional OpenTelemetry hooks** for the audit module, with zero new
  runtime dependencies.
- A final API-surface review closing the two consistency gaps found
  (`rls`'s `InvalidSqlIdentifierError`, `SecurityKitError` re-exported
  from every subpath — both in `0.2.1`) and raising the Node floor off an
  already-end-of-life runtime (`0.3.0`).

## [0.3.0] - 2026-08-14

### Changed

- **Minimum supported Node.js version raised from `>=20.19` to `>=22`.**
  Node 20 ("Iron") LTS has reached its own end-of-life; per
  `docs/versioning-policy.md`, raising `engines.node` is a `minor` bump,
  not `major` — it's driven by upstream Node's own release schedule, not
  a change to this package's API, but can still break a consumer running
  an old runtime. The CI matrix, `.nvmrc`, and `README.md`'s stated
  requirement all move to Node 22 in the same change; the `test` job's
  CI matrix drops to a single Node 22 entry (kept as a one-entry matrix
  specifically so its required-status-check name stays `test (22)`
  unchanged — only `test (20)` stops reporting).

## [0.2.1] - 2026-08-14

### Fixed

- `rls`'s identifier validation (`generateEnableRlsSql`,
  `generateTenantIsolationPolicySql`, `generateSetTenantContextSql`,
  `tenantWhereClause`, `generateTenantIsolationMigration`) now throws
  `InvalidSqlIdentifierError` (`code: 'INVALID_SQL_IDENTIFIER'`) instead of
  a plain `TypeError`. Every other module's errors already extended the
  shared `SecurityKitError` base with a stable `.code`; `rls` was the one
  outlier, breaking the "every error this kit throws has a stable `.code`"
  promise `src/errors.ts`'s own doc comment already made. Found and fixed
  while reviewing the public API surface ahead of `1.0.0` — see
  `docs/versioning-policy.md`, new in this release.
- `SecurityKitError` (the shared base class) is now re-exported from every
  subpath barrel (`/tenant`, `/rbac`, `/rate-limit`, `/audit`, `/rls`,
  `/crypto`), not just the package root, matching how each module already
  re-exports its own specific error classes. A consumer importing only one
  subpath can now `catch (e) { if (e instanceof SecurityKitError) ... }`
  without an extra root import.

### Added

- `docs/versioning-policy.md` — spells out exactly what SemVer means for
  this package: what counts as the public API (precisely what's reachable
  through `package.json`'s `exports` map — internal-but-technically-exported
  values like `IDENTIFIER_PATTERN`/`DEFAULT_TENANT_ID_PATTERN` don't count),
  what triggers a `patch`/`minor`/`major` bump, that `error.code` strings
  become stable once `1.0.0` ships, that raising the minimum supported
  Node.js version is a `minor` bump not `major`, and the
  deprecate-one-cycle-before-removing policy. Linked from `README.md` and
  `CONTRIBUTING.md`.

## [0.2.0] - 2026-08-14

### Added

- **OpenTelemetry integration for the audit module** (`/audit`):
  `openTelemetrySink({ getActiveSpan })` and
  `traceContextTransform({ getActiveSpan })`. The sink records every audit
  event as a span event on the currently active span and marks the span an
  error for any outcome other than `'success'`; the transform stamps
  `traceId`/`spanId` from the active span onto every event's `metadata` (via
  `AuditLoggerOptions.redact`) so even sinks with no OpenTelemetry awareness
  can be correlated back to the trace that produced them. Neither imports
  `@opentelemetry/api` — this package keeps its zero-runtime-dependency
  footprint by accepting a `getActiveSpan` callback typed against a small
  structural `OtelSpanLike` interface, which a real `@opentelemetry/api`
  `Span` satisfies with no adapter or cast. See
  `docs/audit-logging.md`'s "OpenTelemetry integration" section.
- `docs/auth-integrations.md` — adapter guide wiring **Auth.js**
  (`@auth/express`), **Clerk** (`@clerk/express`), and **Auth0**
  (`express-oauth2-jwt-bearer`) session/claims into `claimTenantResolver`
  and `subjectFromRequestRoles`. Each provider's real claim shape (Clerk's
  single-string `orgRole`, Auth0's namespaced custom claims via Actions,
  `express-oauth2-jwt-bearer`'s global `Express.Request.auth` augmentation)
  was confirmed against the SDK's own installed `.d.ts` output rather than
  assumed from memory.
- `docs/row-level-security.md`: new "Using an ORM" section covering
  **Prisma** (`$transaction` + `$executeRawUnsafe`, which accepts
  `generateSetTenantContextSql()`'s `$1`-placeholder output directly) and
  **Drizzle** (`db.transaction` + its own ` sql` `` tagged template —
  `db.execute()` does **not** accept a raw string plus a separate params
  array the way `pg`/Prisma's `$executeRawUnsafe` do, confirmed directly
  against `drizzle-orm`'s own type declarations before documenting it).
- `test/integration/rls-postgres.integration.test.ts` — RLS enforcement
  tested against a real Postgres (via `testcontainers`), connecting as a
  non-superuser table-owner role so `FORCE ROW LEVEL SECURITY` is actually
  exercised (superusers bypass RLS unconditionally, making that setting a
  no-op in a naive test setup). Run via `npm run test:integration`
  (requires Docker), separate from the fast unit suite.
- `test/rls/postgres.fuzz.test.ts` and `test/tenant/tenant-id.fuzz.test.ts`
  — property-based fuzz tests (`fast-check`) against this package's own
  identifier/tenant-id validation regexes and a curated corpus of
  SQL-injection-shaped payloads.
- OpenSSF Scorecard workflow (`.github/workflows/scorecard.yml`) and badge.
- `doc-examples/` is now a permanent, CI-enforced check (`npm run
verify:docs`, wired into `npm run verify` and CI's `build` job): every
  code sample in `README.md` and `docs/*.md` is mirrored here and actually
  type-checked/run against the real built package (resolved through this
  repo's own `package.json` `exports` map, the same way a real consumer's
  `import` would resolve), not just eyeballed. See
  `doc-examples/README.md`.
- Release automation via [Changesets](https://github.com/changesets/changesets)
  (`.github/workflows/release.yml`, `.changeset/`): a PR that changes
  published behavior adds a changeset; on merge to `main`, a "Version
  Packages" PR accumulates the resulting version bump; merging that PR
  publishes to npm (with provenance), pushes the `vX.Y.Z` tag, and creates
  the GitHub Release automatically. Replaces the previous flow, which
  required manually bumping `package.json` and pushing a git tag by hand
  for every release (0.1.0 - 0.1.2). See `CONTRIBUTING.md`'s "How a release
  happens".

### Fixed

- The first real run of `release.yml` failed at the "create pull request"
  step with `GitHub Actions is not permitted to create or approve pull
requests` — the repo setting documented in `docs/github-governance.md`
  Step 4 ("Allow GitHub Actions to create and approve pull requests") was
  not yet enabled. This release's Version Packages PR (#16) was opened by
  hand from the branch `changesets/action` had already pushed successfully
  (only the PR-creation API call needs that permission, not the git push)
  to unblock this release; an admin still needs to enable that setting so
  future releases open the PR automatically.

## [0.1.2] - 2026-08-13

### Fixed

- **`MinimalRequest`/`MinimalResponse` silently broke Express type-compatibility.**
  Both had a `[key: string]: unknown` index signature (meant to document
  that frameworks attach arbitrary properties like `req.user`), but
  TypeScript only lets a _declared_ type (like `express.Request`) satisfy a
  target type that has an index signature if the declared type also has a
  matching one — and Express's own types don't. The result: every
  documented Express usage (`app.use(createTenantMiddleware(...))`,
  `app.use(createRateLimitMiddleware(...))`, `app.use(requirePermission(...))`)
  failed `tsc --noEmit` under strict TypeScript, including this README's own
  Quickstart and `examples/express-basic.ts` — never caught by CI, since
  `examples/` is excluded from typecheck by design. Found via a full
  doc-sweep that type-checks every documented code sample against the real
  published package rather than trusting source-level tests or review, the
  same lesson that produced 0.1.1's fix. Fixed by dropping the index
  signature; the one place that needed dynamic property access internally
  (`subjectFromRequestRoles`) now casts through `Record<string, unknown>`
  locally instead of widening the public type.
- `AuditSinkError` (`/audit`), `TenantContextError`/`CrossTenantAccessError`/
  `InvalidTenantIdError` (`/tenant`), `ForbiddenError`/`RbacConfigurationError`
  (`/rbac`), `RateLimitExceededError` (`/rate-limit`), and `DecryptionError`
  (`/crypto`) are now re-exported from the subpath whose own public API
  throws them, not just the package root — e.g. `onSinkError: (error:
AuditSinkError) => ...`, as shown in docs/audit-logging.md, previously
  failed to type-check when only `/audit` was imported.
- `docs/rate-limiting.md`'s Redis store example had an empty method body
  with a non-`void` return type, which doesn't compile as literally
  written; replaced with a throwing stub pointing at the new full reference
  implementation (see Added, below). Its `points`/`getTenantId` callback
  examples now show the explicit `<express.Request>` type argument needed
  to access framework-specific properties (`req.path`, `req.params`) —
  these middleware factories are generic over the request type and default
  to the framework-agnostic `MinimalRequest`, which doesn't have them.
- `docs/rbac.md`'s custom `SubjectResolver` example imported
  `requireCurrentTenantId` from `/rbac`; it's exported from `/tenant`.
- `docs/tenant-isolation.md` and `docs/rate-limiting.md`: two route-param
  lookups now coerce with `String(...)` — Express 5 types `req.params[key]`
  as `string | string[]` (to support repeated-segment patterns), which
  doesn't assign to a plain `string` parameter as literally written.

### Added

- CodeQL static analysis (`.github/workflows/codeql.yml`) — runs on every
  push/PR to `main` plus a weekly schedule, reporting to the repo's Security
  -> Code scanning alerts tab. Kept advisory (not a required status check),
  matching this repo's Standard governance tier; see
  `docs/github-governance.md` Step 6 for the (deliberately manual) option to
  promote it.
- `examples/fastify-basic.ts` and `examples/koa-basic.ts` — tenant +
  rate-limit middleware wired into Fastify and Koa, each with a small,
  verified request/response adapter (neither framework's native
  request/response type matches `MinimalRequest`/`MinimalResponse` closely
  enough to skip one, unlike Express).
- `examples/nextjs-route-handler.ts` — the same tenant/rate-limit/RBAC
  behavior inside a Next.js Route Handler, calling `runWithTenant()`,
  `TenantRateLimiter.consume()`, and `RbacPolicy.assert()` directly instead
  of through `Middleware`, since Route Handlers use the Web Fetch API's
  `Request`/`Response` rather than an Express-shaped `(req, res, next)`.
  Notes the Node.js-runtime requirement (`AsyncLocalStorage` needs it, Route
  Handlers use it by default, root `middleware.ts` does not).
- `examples/redis-rate-limit-store.ts` — a full, verified reference
  `RateLimitStore` implementation backed by Redis: an atomic Lua-scripted
  token bucket (via `ioredis`'s `defineCommand`) mirroring
  `MemoryRateLimitStore`'s refill math exactly, for multi-instance
  deployments. Linked from `docs/rate-limiting.md`'s "Scaling past one
  process" section.

## [0.1.1] - 2026-08-13

### Fixed

- **Critical: the active-tenant context was not actually shared across the
  package's public entry points.** Every entry point (`.`, `./tenant`,
  `./rbac`, `./rate-limit`, `./audit`, `./rls`, `./crypto`) was built as an
  independently-bundled file, each inlining its own separate copy of the
  `AsyncLocalStorage` singleton in `tenant/context.ts`. Any usage mixing
  more than one entry point — including this README's own Quickstart
  example — silently talked to different storages: tenant context set via
  `createTenantMiddleware` (`./tenant`) was invisible to
  `subjectFromRequestRoles` (`./rbac`) and the default tenant resolution in
  `createRateLimitMiddleware` (`./rate-limit`), both of which threw
  `TenantContextError` on every call. Fixed by switching the build
  (`tsup.config.ts`) from bundling each entry independently to
  `bundle: false` with every source file as its own entry, so Node's own
  module cache (the ESM registry / the CJS `require` cache, both keyed by
  resolved file path) guarantees `tenant/context.ts` loads exactly once per
  process regardless of which entry point is imported. A permanent
  regression test (`scripts/verify-dist-singleton.mjs`, run via
  `npm run verify:dist`) now runs against the built `dist/` output as part
  of `npm run verify` — and therefore CI's `build` job and the release
  workflow — since this class of bug only exists in bundled output and is
  invisible to source-level tests.

### Added

- Dependabot auto-merge (`.github/workflows/dependabot-auto-merge.yml`) for
  the low-risk subset of dependency bumps only: npm devDependency
  minor/patch updates and `github-actions` minor/patch updates. Any
  semver-major bump, and any npm production-dependency bump, is never
  auto-merged — those stay normal PRs for manual review. Requires "Allow
  auto-merge" enabled under Settings -> General (see
  `docs/github-governance.md`, Step 4).

## [0.1.0] - 2026-08-13

### Added

- **`tenant`** — `AsyncLocalStorage`-based tenant context (`runWithTenant`,
  `getCurrentTenant(Id)`, `requireCurrentTenant(Id)`), cross-tenant isolation
  guards (`assertSameTenant`, `assertTenantMatches`, `scopeToTenant`), and
  request-scoping middleware with header/subdomain/claim resolvers.
- **`rbac`** — `RbacPolicy` with role inheritance and wildcard permission
  matching, `requirePermission` middleware, `subjectFromRequestRoles` helper.
- **`rate-limit`** — per-tenant token-bucket rate limiting
  (`TenantRateLimiter`, `MemoryRateLimitStore`), Express middleware setting
  `RateLimit-*` response headers, `assertNotRateLimited` for non-HTTP call
  sites, and a pluggable `RateLimitStore` interface for Redis/etc.
- **`audit`** — `AuditLogger` fanning events out to multiple `AuditSink`s
  with per-sink error isolation, `ConsoleAuditSink`/`InMemoryAuditSink`/
  `callbackAuditSink`, event redaction, and `child()` loggers.
- **`rls`** — Postgres row-level-security SQL generation
  (`generateEnableRlsSql`, `generateTenantIsolationPolicySql`,
  `generateSetTenantContextSql`, `tenantWhereClause`,
  `generateTenantIsolationMigration`), with strict identifier validation and
  zero database-client dependencies.
- **`crypto`** — per-tenant AES-256-GCM encryption (`TenantEncryptor`) with
  HKDF-derived keys from a single master secret (`EnvKeyProvider`), a
  pluggable `KeyProvider` interface for real KMS integration, and
  `StaticKeyProvider` for tests.
- Shared error hierarchy (`SecurityKitError` and typed subclasses) used
  consistently across every module.
- Full test suite (250+ tests) and dual ESM/CJS build with type declarations.
- Minimum supported Node.js version is **20.19** (`engines.node`, CI matrix,
  `.nvmrc`). `vitest@4`/`vite`/`rolldown` — pulled in to fix real CVEs in an
  older `vitest`/`esbuild` — hard-require Node 20.19+/22.13+/24+ and cannot
  start on Node 18 at all; Node 18 has also been end-of-life since April 2025. An earlier draft of this package targeted Node >=18.18; that was
  narrowed before the first release once CI caught the incompatibility.
- GitHub governance: CI (lint, typecheck, multi-version test matrix, build,
  advisory `npm audit`), tag-triggered release automation with npm
  provenance, CODEOWNERS, Dependabot (npm + GitHub Actions), issue/PR
  templates, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and a
  manual branch-protection setup checklist
  (`docs/github-governance.md`).

[Unreleased]: https://github.com/NovaVey/Multi-Tenant-Security-Kit/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/NovaVey/Multi-Tenant-Security-Kit/releases/tag/v1.1.1
[1.1.0]: https://github.com/NovaVey/Multi-Tenant-Security-Kit/releases/tag/v1.1.0
[1.0.0]: https://github.com/NovaVey/Multi-Tenant-Security-Kit/releases/tag/v1.0.0
[0.3.0]: https://github.com/NovaVey/Multi-Tenant-Security-Kit/releases/tag/v0.3.0
[0.2.1]: https://github.com/NovaVey/Multi-Tenant-Security-Kit/releases/tag/v0.2.1
[0.2.0]: https://github.com/NovaVey/Multi-Tenant-Security-Kit/releases/tag/v0.2.0
[0.1.2]: https://github.com/NovaVey/Multi-Tenant-Security-Kit/releases/tag/v0.1.2
[0.1.1]: https://github.com/NovaVey/Multi-Tenant-Security-Kit/releases/tag/v0.1.1
[0.1.0]: https://github.com/NovaVey/Multi-Tenant-Security-Kit/releases/tag/v0.1.0
