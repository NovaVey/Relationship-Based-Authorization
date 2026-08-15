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
