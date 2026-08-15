# Decisions

Why this system is built the way it is. One entry per non-obvious call,
written when the call is made — never reconstructed later. See
[`.claude/commands/build-authz-service.md`](../.claude/commands/build-authz-service.md)
rule 4: `PROGRESS.md` records state and goes stale; this file records
reasoning and stays true. If someone asks "why did you do it that way" and
the answer isn't here, the answer is already lost.

Entries D-001 through D-007 were settled while turning this repository from
its previous identity (a multi-tenant security kit) into this one, before
Phase 0 of the build spec starts for real. Later entries come from build
decisions and continue the numbering. Never delete an entry — supersede it
with a new one and mark the old one `superseded by D-0NN`.

**Template**

## D-0NN — <the decision, in one sentence>

**Date:** YYYY-MM-DD · **Phase:** N · **Status:** settled
**Decision:** what we do.
**Alternative rejected:** what we could have done instead.
**Why it lost:** the failure it causes or the cost it carries.
**Revisit if:** the condition that would reopen this.

---

## D-001 — Repurpose the isolation test suite as `.todo()` specs, not delete it and not half-implement it

**Date:** 2026-08-15 · **Phase:** 0 (pre) · **Status:** settled
**Decision:** The three files under `test/isolation/` restate the old tenant-isolation proof's exact assertions in ReBAC terms — real `describe`/`it.todo()` names, real doc comments, zero implementation. See `test/isolation/README.md` for the full mapping from old file to new.
**Alternative rejected:** (a) Delete the suite entirely and let Phase 1+ write tests from scratch. (b) Write real, passing tests now against a minimal implementation invented for the purpose.
**Why it lost:** (a) throws away the single most valuable thing inherited from the previous identity — a proven shape for proving a negative security property (no unauthorized path/row) three independent ways (real-database integration, differential/property fuzzing, hand-picked injection regression). Re-deriving that shape from nothing in a later phase is real, avoidable work, and worse, an easy shape to under-scope on a first pass. (b) violates the explicit instruction to write the build specification before any implementation code, and a minimal implementation invented just to make tests pass now would very likely not match what Phase 1–5 actually build, making the tests wrong by construction and require rewriting anyway.
**Revisit if:** Never. Un-skip each `.todo()` in the same change that implements what it needs — a `.todo()` staying red past its phase's stated exit criteria is itself a signal that phase isn't actually done.

## D-002 — Drop the npm-publish scaffolding entirely; this is a private deployed service, not a published library

**Date:** 2026-08-15 · **Phase:** 0 (pre) · **Status:** settled
**Decision:** Removed `.changeset/`, `CHANGELOG.md`, `CONTRIBUTING.md` (its content was the changesets release flow), `docs/versioning-policy.md` (semver promises about a `package.json` `exports` map that no longer exists), `.github/workflows/release.yml`, and every `package.json` field that only makes sense for a published npm package (`exports`, `typesVersions`, `main`/`module`/`types`, `files`, `publishConfig`). `package.json` now carries `"private": true`.
**Alternative rejected:** Keep the publish pipeline dormant/unused in case this ships to npm later.
**Why it lost:** A dormant release workflow referencing files that no longer exist (`CONTRIBUTING.md`, `.changeset/*`) doesn't fail loudly when it should — the exact failure mode `.claude/commands/build-authz-service.md` rule 9's spirit warns against elsewhere in this project's lineage (a tool that doesn't fail loudly on a broken assumption is worse than one that does). If this project is ever meant to ship as an installable library rather than a deployed service, that's a real, deliberate scope change worth its own decision entry — not a leftover.
**Revisit if:** A decision is made to publish a client SDK or CLI as an installable package — re-add the publish scaffolding fresh against that package's actual shape, don't resurrect this entry's deleted files.

## D-003 — Build with plain `tsc`, not `tsup`

**Date:** 2026-08-15 · **Phase:** 0 (pre) · **Status:** settled
**Decision:** `npm run build` is `tsc -p tsconfig.json`. `tsup.config.ts` is removed.
**Alternative rejected:** Keep `tsup`'s dual ESM/CJS + per-file compilation setup.
**Why it lost:** The previous identity's `tsup` config existed specifically to solve dual-package-hazard problems for a library with six independently-importable subpath exports sharing a module-level singleton (see that config's own removed comment, and `docs/versioning-policy.md`, also removed). None of that applies to a service with one deployment target and no public subpath API. `tsc` is simpler, already a dependency, and sufficient.
**Revisit if:** The project grows a published client package that needs dual-format output — evaluate `tsup` fresh against that package's actual constraints then, don't restore this config blind.

## D-004 — No ORM for the tuple store; hand-written SQL over `pg`

**Date:** 2026-08-15 · **Phase:** 0 (pre) · **Status:** settled
**Decision:** The Phase 2 tuple store and Phase 4 production check engine will query Postgres directly via `pg`, with hand-written SQL (including recursive CTEs for the graph walk), not an ORM/query builder.
**Alternative rejected:** Drizzle ORM (already a dependency of this repo's previous identity, for RLS-related type examples).
**Why it lost:** Mirrors the reasoning `.claude/commands/build-authz-service.md` §2 records for keeping soundness statistics in-repo rather than from a library: the recursive graph walk is the part of this project that must be exactly right and independently verifiable, and a query builder's abstraction over recursive CTEs is exactly the kind of layer that makes "what SQL actually ran" harder to audit, not easier — for the one query in this codebase where that audit matters most.
**Revisit if:** A concrete query-builder limitation blocks something the raw approach genuinely can't express cleanly — write that limitation down here before reaching for an ORM, don't reach for it first.

## D-005 — Soundness is proven by differential testing against a naive reference resolver, not asserted from the production resolver's own logic

**Date:** 2026-08-15 · **Phase:** 0 (pre) · **Status:** settled
**Decision:** Phase 3 builds a deliberately slow, deliberately naive in-memory BFS resolver whose only job is to be obviously correct. Phase 5 fuzzes random schemas/tuple graphs/queries and asserts the production (Phase 4) resolver agrees with it on every one — see `test/isolation/differential-soundness.fuzz.test.ts` and build spec §6.2.
**Alternative rejected:** Hand-derive a fixed set of expected results (from the Zanzibar paper's own worked examples, or authored by hand) and assert the production resolver matches them.
**Why it lost:** A fixed example set only proves the engine is correct on the examples someone thought to write down — exactly the "commodity eval script" failure mode a sibling project in this org's own build spec calls out for a different domain (a 30-prompt pass-rate script). Differential fuzzing against an independent, structurally different implementation finds the graph shapes nobody thought to hand-author, the same reason property-based fuzzing replaced hand-picked cases as the primary tool in this repo's own inherited `test/isolation/` suite.
**Revisit if:** Never, for the differential harness itself. Hand-derived examples still have a place (Phase 3's own exit criteria use a handful to sanity-check the reference resolver before it's trusted as an oracle) — they are a floor under the fuzz harness, not a substitute for it.

## D-006 — `false_grant` and `false_deny` are reported as distinct, asymmetric outcomes, never collapsed into one "mismatch" count

**Date:** 2026-08-15 · **Phase:** 0 (pre) · **Status:** settled
**Decision:** A differential-fuzzing divergence is classified as `false_grant` (production engine allowed, no path exists — a security bug, blocking) or `false_deny` (production engine denied, a path exists — a correctness bug, non-blocking). See build spec §6.5.
**Alternative rejected:** Report a single "divergence rate" and let a threshold decide pass/fail.
**Why it lost:** The two failure modes have entirely different consequences — one is an unauthorized permission grant, the other is an availability/correctness annoyance — and a threshold on a blended rate can pass a run that hides a real false grant behind a larger number of harmless false denies. This is the same reasoning a sibling project in this org's build spec applies to keeping `no_detectable_difference` and `insufficient_data` as distinct verdicts rather than one "inconclusive" bucket.
**Revisit if:** Never.

## D-007 — Environment loading uses `zod` + `dotenv`, not a dependency-free hand-rolled parser

**Date:** 2026-08-15 · **Phase:** 0 (pre) · **Status:** settled
**Decision:** `src/config/env.ts` parses `process.env` through a `zod` schema (coercion, enums, defaults, required-field messages) after `dotenv.config()`.
**Alternative rejected:** A small dependency-free `.env` line parser (the pattern a sibling project in this org uses for its CLI, where the env footprint is much smaller and dependency-freedom was itself the point for a tool meant to be trusted end to end).
**Why it lost:** This project's env footprint has real structure to validate — numeric coercion with bounds, enums, a mix of required and defaulted fields — that a line parser would either not validate at all or would re-implement `zod` poorly to cover. This is a service in the same shape as this org's other Postgres-backed services, which already use exactly this `zod` + `dotenv` pattern; matching it is the more defensible default than re-deriving a different one for no stated reason.
**Revisit if:** Never, absent a concrete reason `zod` itself becomes a liability (it is not in the soundness-critical path D-005 protects).

## D-008 — `DATABASE_URL` (and other blank-placeholder env vars) are optional at the schema layer; required at the point of use

**Date:** 2026-08-15 · **Phase:** 0 · **Status:** settled
**Decision:** `DATABASE_URL`, `ADMIN_API_KEY`, and `SOUNDNESS_FUZZ_SEED` are validated as optional, non-empty-if-present strings (empty string from a blank `KEY=` line in `.env` is treated as absent, not as a validation failure — see `optionalString()` in `src/config/env.ts`). Each command that actually needs `DATABASE_URL` (starting with `authz doctor`) checks for it itself and reports a command-specific, actionable error before touching Postgres.
**Alternative rejected:** Required, eagerly validated at module-import time (this repo's own original Phase 0 scaffolding, before Phase 0's own CLI work).
**Why it lost:** Caught live building `authz doctor`: eager validation crashes `authz --help` on a fresh clone with no `.env` at all, before commander even parses argv — directly contradicting this project's own Phase 0 exit criterion ("`authz --help` runs"). A CLI's help output must not depend on infrastructure the command being asked about doesn't need. Separately, `.env.example`'s own blank-value convention (`ADMIN_API_KEY=`) parses via `dotenv` as an empty string, not an absent key — a plain `z.string().min(1).optional()` rejects that exact shape, which is `.env.example`'s own placeholder convention rejecting itself. Both bugs were caught by actually running the CLI against a real `.env`, not by inspection.
**Revisit if:** Never for the optional-at-schema-layer shape. If a future command needs `DATABASE_URL` before argument parsing (unlikely — commander parses first by design), reconsider then, not preemptively.

## D-009 — `build` uses its own `tsconfig.build.json` with `rootDir: src`, separate from `typecheck`'s `tsconfig.json`

**Date:** 2026-08-15 · **Phase:** 0 · **Status:** settled
**Decision:** `npm run build` runs `tsc -p tsconfig.build.json` (`include: ["src/**/*.ts"]`, `rootDir: "src"`). `npm run typecheck` keeps using `tsconfig.json` (`include` covers both `src/**/*.ts` and `test/**/*.ts`, no emit) so tests still get full type-checking.
**Alternative rejected:** One `tsconfig.json` for both, as originally scaffolded.
**Why it lost:** Caught live running the built CLI (`node dist/cli/index.js`) during Phase 0's doctor CHECKPOINT: without an explicit `rootDir`, `tsc` infers the common root across every file `include` reaches — once `test/**/*.ts` is in that set alongside `src/**/*.ts`, the common root becomes the repo root itself, so `build` emitted to `dist/src/...` and `dist/test/...` instead of `dist/...`. That silently compiled the entire test suite into the distributable output (dead weight, never intended to ship) and broke `package.json`'s own `bin` entry (`./dist/cli/index.js`, which didn't exist — the real file was at `./dist/src/cli/index.js`). A single shared tsconfig for a project with both a `build` step and a `test` directory needs an explicit `rootDir` on whichever config emits, or this class of bug is silent until someone runs the built output directly.
**Revisit if:** Never.

## D-010 — Postgres hosting is Railway, in the org's existing `Upwork Portfolio` project, matching its `Postgres-<Service>` convention

**Date:** 2026-08-15 · **Phase:** 0/1 boundary · **Status:** settled
**Decision:** Provisioned a dedicated `Postgres-RBA` service inside the same Railway project (`Upwork Portfolio`) this org's other services already live in, using the identical `ghcr.io/railwayapp-templates/postgres-ssl:18` image and env-var shape (`POSTGRES_*`/`PG*`/`DATABASE_URL`/`DATABASE_PUBLIC_URL`) as `Postgres-ERP` — confirmed by reading that service's actual config rather than guessing. A TCP proxy (`yamanote.proxy.rlwy.net:36306`) exposes it publicly for CI and any dev machine with normal network access; the private `postgres-rba.railway.internal:5432` address is for anything eventually deployed inside the same Railway project.
**Alternative rejected:** A new, separate Railway project for this service; or a different Postgres provider entirely (Supabase, Neon, a managed RDS instance).
**Why it lost:** Build spec §2 states plainly that Postgres hosting only needs to be "any reachable Postgres" — the deciding factor is matching this org's own established pattern absent a stated reason to diverge, the same reasoning D-007 already applied to the env-loading library choice. A new project would fragment where this org's infrastructure lives for no benefit this repo needs.
**A real bug found provisioning it, not by inspection:** the raw image-based service didn't get the Railway-managed persistent volume the `postgres-ssl` entrypoint expects at `/var/lib/postgresql/data` — its own template flow provisions one automatically, but a service created directly via the image (bypassing that flow) doesn't. The container looped indefinitely logging `Railway volume not mounted to the correct path` instead of ever starting Postgres; the deployment reported `SUCCESS` the whole time, which would have looked fine from status alone. Fixed by explicitly creating and attaching a volume at that mount path before redeploying, then confirming via the deployment's own runtime logs that Postgres actually reached `database system is ready to accept connections` — not just that the deployment's status field said `SUCCESS`.
**Verification note:** this interactive session's own network policy proxies outbound HTTP(S) only — raw TCP to the Postgres wire protocol port is not reachable directly from here (confirmed: DNS resolves, `/dev/tcp` connect times out). `DATABASE_URL` was verified for real — actual auth, actual `select version()` — from a Railway-hosted sandbox (`sandboxCreate`/`sandboxExec` with `networkIsolation: PRIVATE`) instead, which reaches both the private and public-proxy addresses directly. This means later phases' own "verify by actually running it" standard (§0 rule 9, D-008/D-009's precedent) needs a real execution environment with outbound DB access — this session's shell isn't one — see the open question in `PROGRESS.md`.
**Revisit if:** This ever becomes a real production deployment with its own billing/ownership boundary separate from the org's other demo/portfolio services — reprovision fresh against that boundary, don't just relabel this one.

## D-011 — Rewrite-rule grammar: `&` binds tighter than `|`/`-`, left-associative, parentheses for explicit grouping

**Date:** 2026-08-15 · **Phase:** 1 · **Status:** settled
**Decision:** `permission edit = a | b & c` parses as `a | (b & c)`, matching the common SpiceDB/Zanzibar-adjacent convention. `|` and `-` share precedence and associate left-to-right (`a - b | c` is `(a - b) | c`). Parenthesized subexpressions are always allowed.
**Alternative rejected:** Equal precedence for all three operators, left-to-right only (no implicit `&` binding); or requiring parentheses whenever more than one operator kind appears in one expression.
**Why it lost:** §5's worked examples never mix operators in one expression, so nothing in the spec forces either choice — but implicit equal-precedence chaining of `&`/`|`/`-` left-to-right would make `a | b & c` mean `(a | b) & c`, which reads backwards to anyone who has used a boolean expression in any mainstream language. Matching the wider ecosystem's convention (intersection binds like AND, tighter than OR) is the more defensible default absent a spec-stated reason to diverge, the same reasoning D-007/D-010 already apply elsewhere in this project.
**Revisit if:** A real schema surfaces a rewrite rule where this precedence produces a result someone finds surprising in practice — parentheses are always available as an escape hatch in the meantime, so this is a low-cost decision to revisit.

## D-012 — Tuple-to-userset's target namespace check is strict; a plain relation subject type's is soft

**Date:** 2026-08-15 · **Phase:** 1 · **Status:** settled
**Decision:** `parent->view` (tuple-to-userset) always requires every namespace `parent`'s subject types can point to be present in the same compilation unit, or the compiler rejects it with `tuple_to_userset_unknown_namespace` — no exceptions. A plain relation subject type (`relation editor: user | group#member`) is checked only when `group` happens to be present in the same compilation unit; if it isn't, the `#member` suffix goes unverified rather than rejected.
**Alternative rejected:** Symmetric strictness — either both checks always require the target namespace present, or both skip the check when it's absent.
**Why it lost:** The two constructs have different jobs. Tuple-to-userset is compiled into a `RewriteRule` a resolver will *walk at runtime* (§6.2/§6.4) — an unresolvable namespace reference baked into that tree is a defect the compiler can and must catch before it ever reaches a resolver. A relation's subject type is declaring what a *future tuple write* is allowed to store; namespaces in this DSL are meant to be authored and compiled independently (this is exactly what lets `document.authz` and `org.authz` each compile standalone while only referencing `group#member`, without requiring every schema file in one compilation call) — so always requiring every referenced namespace to already exist in the same call would break that independence for no correctness benefit, since a tuple write against an actually-missing namespace is Phase 2's problem to reject at write time, not Phase 1's to reject at compile time.
**Revisit if:** Phase 2's tuple-write validation reveals that deferring this check creates a real gap (e.g. a subject type that's silently never checked against anything, ever) — tie the two phases' checks together explicitly then, rather than assuming Phase 2 alone closes it.

## D-013 — Circular-permission detection is a static compile-time graph check, not a per-branch liveness proof

**Date:** 2026-08-15 · **Phase:** 1 · **Status:** settled
**Decision:** The compiler rejects a permission whose definition depends, in a cycle, only on itself and other same-namespace permissions with no `relation` anywhere in the cycle to ground it (`permission view = view`; `permission a = b; permission b = a`). This is a static graph check over permission-to-permission `computedUserset` edges only — a `tupleToUserset` edge never counts toward a cycle, and a permission that has *any* non-cyclic branch reaching a real relation (e.g. `permission x = a | y` where `a` is a relation and `y` cycles back to `x`) is still rejected as a whole, even though a runtime walk could resolve `x` via the `a` branch alone.
**Alternative rejected:** A per-branch liveness proof — reject only if *every* path through the rewrite tree is unreachable, rather than rejecting the whole permission because *some* path cycles.
**Why it lost:** A per-branch proof is real, extra graph analysis for a case the DSL author almost certainly didn't intend on purpose — a rewrite rule with a live, reachable branch and a dead, cyclic one sitting next to each other in the same `union` is far more likely a mistake (a copy-paste leftover, a typo'd permission name in the "wrong" branch) than a deliberate design, and staying conservative costs nothing but requiring the author to remove the dead branch explicitly. `tupleToUserset` edges are excluded from the cycle graph entirely because they're fundamentally different: following a real relation always makes progress against the actual tuple graph at runtime, and is already bounded by `CHECK_MAX_DEPTH` and cycle detection at the *data* level (§6.4) — a compile-time graph over rewrite-rule *structure* has nothing meaningful to say about a bound that only exists once real tuples are involved.
**Revisit if:** A real schema hits a legitimate, intentional case this rejects that a per-branch proof would allow — write down that concrete case here before loosening this, since the conservative default is deliberate, not an oversight.
