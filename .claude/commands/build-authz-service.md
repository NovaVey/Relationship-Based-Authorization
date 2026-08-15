---
description: Build the Relationship-Based Authorization service — a Zanzibar-style schema DSL, relation tuple store, graph-walking check engine, and a soundness proof that no unauthorized permission path ever resolves
---

# /build-authz-service

Target repo: `NovaVey/Relationship-Based-Authorization` — **confirm this matches the repo you actually created before running. If the name differs, this line is the only place it needs changing.**

## 0. Rules for this workflow

Read the whole file before writing any code.

1. One phase at a time. Exit criteria must pass before moving on.
2. Stop at every `CHECKPOINT`, report what you built, what you ran, and the actual output. Wait for a reply.
3. Keep `PROGRESS.md` current after each phase: files touched, decisions, open questions.
4. Maintain `docs/DECISIONS.md`. Whenever a real alternative was considered and rejected — a data model shape, a consistency mechanism, a rewrite-rule semantics, a library — write one entry: the decision, the alternative, why it lost. Write it when the choice is made, never reconstructed later. `PROGRESS.md` records state and goes stale; `DECISIONS.md` records reasoning and stays true. On this project it carries extra weight: this is an authorization system, and every non-obvious call here is a call about who can see or change what — "it seemed reasonable" is not an answer a security reviewer will accept, and it shouldn't be one you accept from yourself either.
5. Never invent a connection string, API key, or secret. Ask.
6. Ask before adding a dependency outside §2.
7. Commit per phase: `feat(phase-N): <summary>`. Never commit `.env`.
8. Windows is the dev environment. One command per line, no `&&` chaining, forward slashes in code.
9. **Every soundness claim this system makes must be verified by differential testing against an independent reference implementation.** Phase 3 and Phase 5 exist entirely for this. A check engine that reports "allowed" without that claim having been fuzzed against an independent oracle is worse than one that reports nothing, because it launders an unverified graph walk into a security decision someone will actually rely on.
10. **This system never says a permission is granted because it seems like it should be.** It grants only when a concrete, walkable chain of relation tuples proves it, and it says so — every `allow` decision must be able to produce the path that justified it (§6.7, the audit trail). No implicit grants, no "probably fine."
11. **Delegate to the four subagents per §14.** They exist because four parts of this build have different failure modes and benefit from separate context. The main agent owns scaffolding, the schema-config plumbing that isn't Phase 1's own compiler work, the tuple store, the API/CLI/CI surface, docs, and **every CHECKPOINT** — checkpoints are reported to me directly and are never delegated.

## 1. What this is and why it's expert-tier

Every application that grows past "everyone with an account can see everything" reinvents authorization, badly, in the same order: a `role` enum, then a `role` enum plus a handful of special-cased `if` statements for the exceptions, then a table of exceptions nobody fully trusts, then an incident where someone could see something they shouldn't have been able to — because the actual rule ("you can see this because you're in the group that owns the folder it's in, unless you've been explicitly removed") was never expressed anywhere as data, only scattered across application code as a series of individually-plausible checks that nobody has ever verified agree with each other.

The commodity version of the fix is a permissions table and a `can(user, action, resource)` helper that queries it. That's the version that gets teams into trouble the moment "can see this document" needs to mean "is this document's owner, OR is a member of a group with editor access to its parent folder, OR is a member of the org and the document is marked public, AND is not on the folder's ban list" — because a permissions table has no native way to express a rule that recurses through groups, parents, and exceptions, and the helper function that tries ends up as untested, ad hoc graph code embedded in application logic.

The expert version is defined by what it refuses to do:

- **Relationships are data, not code.** Every fact — `user:alice` is a `viewer` on `document:readme`, `group:eng` is an `editor` on `folder:design` — is a row in a tuple store, never a conditional in application code. The set of rules for how those facts combine (union, intersection, exclusion, tuple-to-userset) is a compiled schema, also data, versioned.
- **A single check engine, walked the same way for every namespace.** No route re-implements its own authorization logic. Every permission question goes through the same recursive graph walk, so a bug fixed once is fixed everywhere, and a property proven once (§6.2) is proven everywhere.
- **Soundness is proven, not asserted.** The claim "this engine never grants a permission with no real path" is checked by differential fuzzing against an independent reference implementation (§6.2), the same way a claim about statistical significance in this org's other projects is checked by simulation rather than taken on faith.
- **A consistency model that's stated, not assumed.** Every write returns a token; a check can pin to it. What happens when a check _isn't_ pinned — the staleness window — is a stated, tested bound (§6.3), not an unexamined "eventually."
- **Every `allow` decision can show its work.** The resolution path that justified a grant is part of the audit trail (§6.7), not thrown away once the boolean is returned.

**Honest positioning, and it goes in the README.** [SpiceDB](https://authzed.com/spicedb), [OpenFGA](https://openfga.dev/), and [Ory Keto](https://www.ory.sh/keto/) are production Zanzibar-inspired systems, used at real scale, and this project is not a competitor to them — say so plainly. What it demonstrates is the ability to design, build, and _prove correct_ relationship-based authorization infrastructure end to end, which is the actual consulting engagement (§13). Overclaiming here is the fastest way to lose a technical buyer who already knows this space.

**Non-goals:** not a distributed/globally-consistent system (single Postgres, token-based consistency, not multi-region consensus — see §6.3); not an ABAC/policy-language engine (relationships only, no attribute rules, no Rego/Cedar-style evaluation); not a general graph database; not an authentication system (subjects are opaque ids — who authenticates them is out of scope).

## 2. Stack and prerequisites

- Node 22 LTS + TypeScript (strict)
- Postgres via `pg`, hand-written SQL and migrations (no ORM — see `docs/DECISIONS.md` D-004: the recursive graph walk is the part of this project that must be exactly right and auditable, and a query builder is the wrong place to hide that)
- Fastify for the API
- Vitest, `fast-check` for property-based fuzzing
- **The differential-soundness oracle (Phase 3) is hand-written in-repo**, not derived from the production resolver's own code. It exists to be independently, obviously correct — see `docs/DECISIONS.md` D-005.
- `commander` for the CLI
- GitHub Actions for CI; the soundness report is posted to PRs with the built-in `GITHUB_TOKEN`

Env (`.env.example` already committed at the repo root — Phase 0 scaffolding, see `docs/DECISIONS.md` D-007):

```
DATABASE_URL=
PORT=3000
NODE_ENV=development
LOG_LEVEL=info
CHECK_MAX_DEPTH=25
CHECK_CACHE_TTL_MS=0
SOUNDNESS_FUZZ_QUERIES=5000
SOUNDNESS_FUZZ_SEED=
MAX_CONCURRENCY=8
ADMIN_API_KEY=
```

**On the reference resolver (Phase 3):** it must never share code with the production resolver (Phase 4) — not a shared traversal function, not a shared rewrite-rule evaluator. A test that derives its oracle from the thing it's checking proves nothing; see the `test-author` subagent's rule against exactly this in §14. It is allowed, and expected, to be slow — it exists to be right, never to be fast.

**On the consistency token:** every write returns one (a monotonic marker). A check pinned to it observes that write and everything before it, guaranteed. A check that isn't pinned is a best-effort read of the latest committed state — bounded by ordinary transaction visibility, not by any additional staleness this project introduces. §6.3 and its own `docs/DECISIONS.md` entry cover the reasoning; don't reinvent Spanner-style external consistency here, state the simpler guarantee this project actually provides and prove it.

**On billing/hosting:** Postgres via Railway (or any reachable Postgres — `DATABASE_URL` is the only requirement) is the only paid dependency this project has. No LLM API, no third-party auth provider.

## 3. Repo layout

```
/src
  /config        env.ts (Phase 0, already present)
  /schema        dsl/parser.ts, dsl/compiler.ts, dsl/types.ts, dsl/errors.ts   (Phase 1)
  /store         migrations/, client.ts, tuples.ts, tokens.ts                 (Phase 2)
  /resolve
    /reference   resolver.ts (Phase 3 — the oracle, isolated, no shared code with /production)
    /production  resolver.ts, cache.ts, cycles.ts                            (Phase 4)
  /soundness     fuzz.ts, generators.ts, classify.ts, runner.ts               (Phase 5)
  /audit         checks.ts, expand.ts                                        (Phase 6)
  /report        markdown.ts, json.ts, exitCodes.ts                          (Phase 7)
  /api           server.ts, routes/                                          (Phase 7)
  /cli           index.ts, commands/                                          (Phase 0 stub, filled in per phase)
/schema           example namespace DSL files (Phase 9)
/test
  /isolation     inherited, repurposed proof suite — already present, `.todo()` until its phase lands
  /unit          per-module unit tests, added per phase
/docs            DECISIONS.md (present), github-governance.md (present), RELATIONS.md, CONSISTENCY.md, DELIVERY.md (added per phase)
/.github/workflows  ci.yml (present), soundness.yml (Phase 7)
/.claude
  /agents        schema-compiler.md, soundness-engineer.md, test-author.md, report-designer.md (present)
  /commands      build-authz-service.md (this file)
PROGRESS.md
README.md
```

## 4. Data model

```sql
create table namespace_configs (
  id           uuid primary key default gen_random_uuid(),
  namespace    text not null,          -- "document", "folder", "group", "org"
  version      int not null,
  config       jsonb not null,         -- compiled relation + rewrite-rule definitions (Phase 1 output)
  source_dsl   text not null,          -- the original schema DSL source, for audit/diff
  created_at   timestamptz not null default now(),
  unique (namespace, version)
);

create table relation_tuples (
  id                bigint generated always as identity primary key,
  object_ns         text not null,          -- "document"
  object_id         text not null,          -- "readme"
  relation          text not null,          -- "viewer"
  subject_ns        text not null,          -- "user" | "group" | ...
  subject_id        text not null,          -- "alice" | "eng"
  subject_relation  text,                   -- null for a plain subject; set for tuple-to-userset ("group:eng#member")
  created_at        timestamptz not null default now(),
  -- a tuple is a fact; there is no "updated" — revocation deletes the row
  unique (object_ns, object_id, relation, subject_ns, subject_id, subject_relation)
);
-- the two directions a graph walk needs: "who has R on O" and "what does S have"
create index relation_tuples_by_object on relation_tuples (object_ns, object_id, relation);
create index relation_tuples_by_subject on relation_tuples (subject_ns, subject_id);

create table write_log (
  id            bigint generated always as identity primary key,
  -- the consistency token: a monotonic marker every write advances; a check
  -- can pin its read snapshot to it via WHERE id <= token
  token         bigint not null,
  operation     text not null,          -- "write" | "delete"
  tuple         jsonb not null,
  written_at    timestamptz not null default now()
);

create table checks (                   -- audit trail — see §6.7
  id                uuid primary key default gen_random_uuid(),
  subject_ns        text not null,
  subject_id        text not null,
  relation          text not null,
  object_ns         text not null,
  object_id         text not null,
  allowed           boolean not null,
  consistency_token  bigint,             -- token the check was pinned to, if any
  resolution_path    jsonb,              -- the tuple/rewrite chain that produced the answer, when allowed
  depth              int not null,       -- recursion depth actually used
  duration_ms         int,
  checked_at          timestamptz not null default now()
);

create table soundness_runs (           -- the differential-fuzzing report — see §6.2, §7
  id                    uuid primary key default gen_random_uuid(),
  trigger               text not null,     -- cli|ci|api
  pr_number             int,
  graph_seed            text not null,     -- RNG seed — any run is exactly reproducible
  namespace_count       int not null,
  tuple_count            int not null,
  query_count             int not null,
  false_grant_count       int not null default 0,   -- CRITICAL: engine allowed with no path
  false_deny_count        int not null default 0,   -- engine denied despite a path existing
  critical_namespace_false_grants int not null default 0,
  verdict                text not null,     -- sound|unsound|insufficient_coverage
  divergences             jsonb not null default '[]',  -- each entry: query + expected + actual + resolution path
  computed_at             timestamptz not null default now()
);
```

## 5. Schema DSL — the shape Phase 1 compiles

```
namespace document {
  relation owner: user
  relation editor: user | group#member
  relation viewer: user | group#member

  permission view = viewer | editor | owner
  permission edit = editor | owner
}

namespace folder {
  relation parent: folder
  relation editor: user | group#member

  permission view = editor | parent->view
}
```

- `relation` lines declare storable edges — what a tuple write is allowed to create.
- `permission` lines declare **computed** relations via rewrite rules: `|` is union, `&` is intersection, `-` is exclusion (`a - b` means "in `a`, not in `b`"), `parent->view` is tuple-to-userset (follow the `parent` relation, then recurse into `view` on whatever it points to).
- A `permission` is never itself the target of a tuple write — only a `relation` can be. The compiler rejects a schema that tries.

## 6. Core mechanics — the parts that make this expert work

Each gets a plain-language section in `docs/RELATIONS.md` or `docs/CONSISTENCY.md`, and each is backed by the fuzz harness in Phase 5.

**6.1 Tuples are facts; permissions are computed.** A `relation_tuples` row never expires or gets edited — it exists or it's deleted. Every `permission` is derived by walking rewrite rules over the tuples that do exist. There is no cached, precomputed "user X can do Y" anywhere that isn't provably derivable from current tuples on demand — a cache (§6.6) may exist for latency, but it is never the source of truth, and correctness must hold with it disabled (`CHECK_CACHE_TTL_MS=0`).

**6.2 Soundness is proven by differential testing against an independent oracle, and this is the single most important mechanic in the repo.** The reference resolver (Phase 3) is a deliberately naive, deliberately slow, in-memory BFS over a fully materialized snapshot — no cache, no query planner, no recursion budget beyond the tuple count, and **no shared code with the production resolver**. Phase 5 generates random schemas, random tuple graphs, and random queries, runs both resolvers, and asserts agreement on every single one. Disagreement is classified per §6.5. This is the mechanism that makes every other claim in this README checkable rather than asserted — see `docs/DECISIONS.md` D-005.

**6.3 Consistency tokens bound staleness, they don't eliminate it, and the bound is stated.** Every write returns a token (`write_log.id`, monotonic). A check that supplies a token observes that write and every write before it — implemented by having the check's read transaction assert `write_log` has advanced to at least that token before reading tuples, not by hoping replication has caught up (this runs on one Postgres; there is no replica lag to hide, but the token mechanism is what lets a client _express_ "read-your-writes" instead of just getting whatever the latest commit happens to be). A check with no token is a plain read of current committed state. The property this must never violate: a check pinned to token T never returns a result that ignores a write with token ≤ T. This is Zanzibar's "new enemy" problem in miniature, and it gets a named test (§10) rather than a hand-wave.

**6.4 Cycle detection and a depth budget are correctness requirements, not performance optimizations.** Group nesting can cycle (`group:a` nests `group:b` nests `group:a`). The walk tracks visited `(namespace, id, relation)` triples per branch and terminates instead of looping; `CHECK_MAX_DEPTH` is a hard ceiling independent of cycle detection, so a very deep but acyclic chain still terminates. Both the reference resolver and the production resolver must handle this — an oracle that hangs on the hard case isn't a valid oracle for it (see the fuzz-power tests in `test/isolation/differential-soundness.fuzz.test.ts`).

**6.5 The verdict is asymmetric, deliberately.** Two divergence classes from Phase 5's differential fuzzing:

| Class         | Condition                                        | Report behavior                                                    |
| ------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| `false_grant` | production says allowed, reference finds no path | **fails the check, always** — a security bug                       |
| `false_deny`  | production says denied, reference finds a path   | reported, counted, **never blocks on its own** — a correctness bug |

A `false_grant` on a namespace flagged `critical` in its schema fails the run regardless of the aggregate rate across the rest of the graph — one unauthorized path is one too many, the same way one critical-case regression fails a sibling project's check regardless of its own aggregate statistic. See `docs/DECISIONS.md` D-006.

**6.6 The cache, if enabled, must be invalidated by writes it depends on, never by time alone.** `CHECK_CACHE_TTL_MS` bounds staleness as a ceiling, but a write that touches a tuple a cached result depended on must invalidate that entry immediately, not wait out the TTL — a permission revoked but still served from cache is exactly the kind of bug this project's whole isolation lineage (`test/isolation/README.md`) exists to catch. Default is `0` (disabled) until this is implemented and proven correct under fuzzing with caching turned on.

**6.7 Every `allow` decision records the path that justified it.** `checks.resolution_path` stores the tuple/rewrite chain the engine actually walked to reach `allowed = true`. This isn't just debugging convenience — it's what makes a `false_grant` report in Phase 5 actionable ("here is the exact bogus chain the engine thought it found") instead of a bare disagreement, mirroring the "show the diff, not the score" principle this org's build specs apply elsewhere.

**6.8 Every fuzz and soundness run is seeded and the seed is recorded.** A divergence found in CI must be reproducible byte-for-byte from `soundness_runs.graph_seed` alone, locally, without needing CI's own state.

## 7. CLI and CI surface

```
authz schema compile <file>           parse + compile a namespace DSL file, print the config or the error
authz schema publish <file>           compile and write a new namespace_configs version
authz tuple write <object> <relation> <subject>   write a tuple, prints the returned consistency token
authz tuple delete <object> <relation> <subject>
authz check <subject> <relation> <object> [--at-token <n>]
authz expand <object> <relation>      print the resolved subject tree
authz soundness run [--queries N] [--seed S]      run Phase 5's differential fuzz, print/store the report
authz serve                           API server
```

Exit codes: `0` sound / no issues, `1` a `false_grant` (or any `checks` audit failure), `2` insufficient fuzz coverage or a schema/tuple validation failure, `3` infrastructure failure (DB unreachable, etc.). CI distinguishes all four — mirrors the exit-code discipline this org's other build specs use, adapted to this project's own asymmetric verdicts (§6.5).

GitHub Action / workflow (`.github/workflows/soundness.yml`), run on every PR:

```yaml
- run: npm run build
- run: node dist/cli/index.js soundness run --queries $SOUNDNESS_FUZZ_QUERIES
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

— posts a PR comment per §9 Phase 7, in place on new commits, never stacking.

## 8. Screens (lower priority — after the engine and its proof are real)

Design direction — **an instrument panel, not a dashboard.** The reader is deciding whether to trust a permission decision or a soundness claim; nothing should look more certain than it is.

- Palette: paper background, ink text, one hard alert color reserved _only_ for `false_grant` — never reused for anything else, so its appearance is unambiguous — and one muted tone for `false_deny` and any non-blocking finding. This is the mirror image of a sibling project in this org, which mutes the _uncertain_ case; here the _dangerous_ case must be the loud one, because the asymmetry (§6.5) runs the opposite direction.
- Type: monospace with tabular figures for every id, token, and count.
- Signature element: **the resolution path.** Rendered as a chain — `user:alice → group:eng#member → folder:design#editor → document:readme#view` — collapsible, the exact evidence behind every `allow`.
- Copy: never says a permission "should" resolve. It resolved because of a specific path, or it didn't. Errors name the fix.

Screens: **Namespaces** (schema versions, diff between them) · **Tuple browser** (filter by object/subject) · **Check playground** (run a check, see the resolution path or the reason it's denied) · **Soundness runs** (verdict, false_grant/false_deny counts, seed, replay button) · **Expand tree** (the full subject tree for an object#relation).

## 9. Phases

### Phase 0 — Scaffold

**Already substantially done** (see `docs/DECISIONS.md` D-001 through D-007, `PROGRESS.md`): CI, lint/format, `src/config/env.ts`, `.env.example`, `test/isolation/` repurposed as `.todo()` specs. Remaining Phase 0 work: `src/cli/index.ts` (`authz --help`, `authz doctor` reporting DB reachability), Postgres migrations runner wiring (empty migration set is fine).
Exit: `authz --help` runs; `authz doctor` reports `DATABASE_URL` reachable or a specific connection error.
**CHECKPOINT: confirm the Postgres connection string / hosting choice (Railway or otherwise) before Phase 2 needs it for real.**

### Phase 1 — Schema DSL, before anything else

Parser + compiler for the grammar in §5: relations, permissions, union/intersection/exclusion/tuple-to-userset. Pure functions, zero I/O, no database.
Building this first is deliberate, mirroring this org's own precedent: it's the part every later phase depends on being right, and it's far easier to verify in isolation than once it's entangled with the store.
Exit: the example schemas in §9 Phase 9 (document/folder/group/org) compile; a malformed schema is rejected with an error naming the exact line/construct.
**CHECKPOINT: show me three hand-written schemas compiling correctly and one malformed one failing with a specific error.**

### Phase 2 — Tuple store

Migrations for §4's tables, `tuple write`/`tuple delete` with the consistency-token issuance from §6.3, `tuple read`/list.
Exit: writing and reading round-trips; a write returns a strictly increasing token; deleting a tuple is immediately invisible to a read pinned to a token issued after the delete.

### Phase 3 — Reference resolver (the oracle)

Naive in-memory BFS per §6.2. No shared code with Phase 4. Verified against hand-derived examples before it is trusted as an oracle for anything.
Exit: matches every hand-derived example from the schemas in §5/§9, including tuple-to-userset through a 3-level parent chain and a cyclic group nesting that correctly resolves denied rather than hanging.
**CHECKPOINT: show me the reference resolver matching 5 hand-derived examples, including the cyclic one.**

### Phase 4 — Production check engine

Recursive SQL-backed resolver, cycle detection and depth budget per §6.4, consistency-token pinning per §6.3.
Exit: agrees with the Phase 3 reference resolver on the same hand-derived examples; the cyclic case terminates within `CHECK_MAX_DEPTH` and resolves denied.

### Phase 5 — Differential soundness fuzzing

The credibility phase. Random schema/tuple-graph/query generator (must exercise every rewrite-rule kind and at least one cycle per run — see `test/isolation/differential-soundness.fuzz.test.ts`), classification per §6.5, `soundness_runs` persistence.
Exit: 0 `false_grant` across `SOUNDNESS_FUZZ_QUERIES` (default 5,000) random queries; `false_deny` rate reported even at zero; a deliberately introduced bug (skip an intersection branch, remove cycle detection) is caught within the standard budget — proving the fuzzer has power, not just that it currently reports clean.
**CHECKPOINT: this is the credibility of the whole repo. Walk me through a clean run, then the deliberately-broken run that the fuzzer catches.**

### Phase 6 — Expand + audit trail

`expand()` per §7, `checks` table population with `resolution_path` per §6.7.
Exit: `expand()` returns the exact subject tree for an object#relation, including tuple-to-userset members; every check, allowed or denied, is logged, and an allowed check's log entry contains a path that independently re-verifies.

### Phase 7 — Report + CI surface

Markdown/JSON reporters for a `soundness_runs` row, exit codes per §7, `.github/workflows/soundness.yml`, PR comment posting (in place on new commits).
Exit: a comment rendered from a real run against this repo's own example schema, readable on mobile, showing the resolution path for any reported `false_grant`.
**CHECKPOINT: screenshot of the bot comment on a real PR in this repo. This is the demo.**

### Phase 8 — API + GitHub checks-and-balances

Fastify server exposing `check`/`expand`/`write`/`schema` per the CLI's own operations, `ADMIN_API_KEY`-gated writes, `/health` reporting DB connectivity and the current namespace config versions. On the GitHub side: confirm `docs/github-governance.md`'s checklist has actually been applied (branch protection, required status checks, Dependabot auto-merge, CODEOWNERS) — this is manual, admin-side GitHub configuration that no commit can apply; treat it as a real exit criterion, not a formality.
Exit: `/health` reports green; an unauthenticated write attempt is rejected; `docs/github-governance.md`'s steps are confirmed applied (or explicitly deferred with a stated reason) and the PR for this phase says which.

### Phase 9 — Screens, example schema, docs, demo

Report UI per §8. Example schema: `document`/`folder`/`group`/`org` per §5, populated with a realistic tuple graph (nested groups, a folder hierarchy, a mix of direct and inherited grants) — including at least one deliberately-included non-obvious case (a user who has access only through two levels of group nesting) so the demo proves tuple-to-userset actually works, not just direct grants. `docs/RELATIONS.md` (the DSL and rewrite rules, plain language), `docs/CONSISTENCY.md` (the token model, plain language), README per §11.
Exit: a stranger clones, runs `authz soundness run`, and sees a clean report against the example schema in under 10 minutes.

## 10. Test plan

**Schema DSL (pure, fast)**

- `a-schema-with-every-rewrite-rule-kind-compiles`
- `a-permission-referencing-an-undeclared-relation-is-rejected-with-the-relation-name`
- `only-a-relation-not-a-permission-can-be-the-target-of-a-tuple-write`
- `tuple-to-userset-syntax-parses-the-followed-relation-and-the-recursed-permission-separately`

**Reference resolver (Phase 3)**

- `matches-the-hand-derived-examples-for-every-rewrite-rule-kind`
- `a-cyclic-group-nesting-terminates-and-resolves-denied`
- `an-object-with-zero-tuples-resolves-denied-for-every-subject`

**Production engine vs. reference resolver (Phase 4/5) — see `test/isolation/`**

- Every `it.todo` currently in `test/isolation/permission-resolution.integration.test.ts` and `test/isolation/differential-soundness.fuzz.test.ts`, un-skipped as its phase lands.
- `a-check-pinned-to-a-token-observes-every-write-at-or-before-that-token` — §6.3
- `an-unpinned-check-never-blocks-waiting-for-a-write-that-hasnt-committed` — §6.3

**Tuple store (Phase 2)**

- `deleting-a-tuple-is-immediately-invisible-to-a-read-pinned-to-a-post-delete-token`
- `writing-the-same-tuple-twice-is-idempotent-not-a-duplicate-row`
- `a-malformed-namespace-relation-or-id-is-rejected-before-it-reaches-the-database` — see `test/isolation/identifier-and-tuple-validation.fuzz.test.ts`

**Soundness harness (Phase 5) — see `test/isolation/differential-soundness.fuzz.test.ts`**

- `zero-false-grants-across-the-standard-fuzz-budget`
- `a-false-grant-on-a-critical-namespace-fails-the-run-regardless-of-aggregate-rate`
- `a-false-deny-never-fails-the-run-on-its-own`
- `a-deliberately-broken-engine-is-caught-within-the-standard-fuzz-budget`

**CI**

- `a-false-grant-exits-one-and-an-infrastructure-failure-exits-three`
- `the-soundness-pr-comment-updates-in-place-instead-of-posting-twice`
- `an-unreachable-database-fails-the-check-rather-than-passing-it`

## 11. Definition of done

- [ ] Zero `false_grant` across the standard fuzz budget (5,000 queries), reported even at zero
- [ ] A deliberately introduced unsoundness bug is caught by the fuzz harness within that same budget — proving it has power, not just that it currently reports clean
- [ ] Reference resolver (Phase 3) verified against hand-derived examples, including a cyclic case, before being trusted as an oracle
- [ ] Every rewrite-rule kind (union, intersection, exclusion, tuple-to-userset) has a real-Postgres integration test, not just a differential-fuzz pass
- [ ] Consistency-token pinning tested: a check pinned to a token observes every write at or before it
- [ ] Every `allow` decision's resolution path is logged and independently re-verifiable
- [ ] Working GitHub Action posting a real soundness report to a PR in this repo, in place on new commits
- [ ] `docs/github-governance.md`'s checklist confirmed applied (or explicitly, visibly deferred)
- [ ] `authz soundness run` runnable by a stranger against the example schema in under 10 minutes from clone
- [ ] `docs/DECISIONS.md` has an entry for every data-model, consistency, and rewrite-rule design choice
- [ ] README states plainly what this is not, and names SpiceDB, OpenFGA, and Ory Keto
- [ ] Every `it.todo()` in `test/isolation/` is either un-skipped and passing, or the phase that would implement it is explicitly still open in `PROGRESS.md`

## 12. README requirements

Open with the failure, not the feature: authorization logic scattered across application code as individually-plausible checks nobody has verified agree with each other, until an incident proves they didn't. Then the resolution-path example — showing the exact tuple chain behind a real `allow` decision does more to establish trust than a paragraph of description.

Then, immediately and before any feature list, the **soundness result**: "Fuzzed against an independent reference resolver across 5,000 random (schema, tuple graph, query) triples: 0 false grants." A system that states its own false-grant rate under adversarial random testing is making a claim almost nothing in this space states this plainly, and it belongs above the fold.

Then how the graph walk and the consistency model work, in plain language, linking `docs/RELATIONS.md` and `docs/CONSISTENCY.md`. Then the honest positioning paragraph naming SpiceDB, OpenFGA, and Ory Keto and stating plainly what this is not (§1). Stack last.

Say plainly that this project's contribution is the proof methodology (differential fuzzing against an independent oracle, asymmetric verdicts, resolution-path audit trails) applied carefully to a well-understood model (Zanzibar), not a novel authorization model. Overclaiming novelty here is the one thing that would sink this repo with the audience it's aimed at.

## 13. Packaging this as a fixed-scope offer

`docs/DELIVERY.md`:

- **Deliverables:** a namespace schema modeled from your actual product's object/permission structure, a tuple store migrated onto your infrastructure, the check engine wired into your API (or exposed as its own service your API calls), the soundness fuzz harness run against your real schema so you know its own false-grant rate under adversarial testing, CI integration, handover session.
- **Timeline:** 2–3 weeks, of which week 1 is schema modeling with your team — this is almost always the actual bottleneck, not the engine.
- **What I need from you:** your current permission model (however informal), a list of the object types and the relationships that should grant access to each, repo/infra access for the CI and database integration.
- **Out of scope:** authentication (who a subject _is_ is assumed solved before this project starts), a distributed/multi-region deployment, an ABAC/policy-language layer, migrating existing permission data without your team's involvement in mapping it (the mapping IS the product — outsourcing it defeats the purpose).
- **Acceptance:** the soundness harness reports its false-grant rate on your real schema (target: zero, always reported even when non-zero), CI runs it on every PR, and your team can read a resolution path and understand why a specific `allow` happened.

The opener on a first call, small and free: ask how they currently prove that a permission change didn't accidentally overgrant something. Almost nobody has an answer better than "we tested the cases we thought of." Naming that gap, concretely, in the first five minutes reframes the conversation from "we need better authorization" to "we need a way to know our authorization is actually right."

## 14. Subagents

Four subagents live in `.claude/agents/`. They exist because four parts of this build fail in different ways, and because each carries enough context to crowd out the rest if handled in one window.

| Agent                | Owns                                                                                | Why it's separate                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema-compiler`    | Phase 1 DSL parser/compiler                                                         | Pure, self-contained, and everything else depends on its output shape being right before anything else is built against it.                               |
| `soundness-engineer` | Phase 3 reference resolver, Phase 4 production engine, Phase 5 differential fuzzing | The correctness of the whole repo rests here. Needs a mindset of "prove it against an independent oracle," not "ship it."                                 |
| `test-author`        | The §10 test plan, including un-skipping `test/isolation/`'s `.todo()` tests        | Writes tests from the **spec**, without reading the implementation first. The mind that wrote the code writes tests that agree with its own mistakes.     |
| `report-designer`    | Phase 7 reporters/PR comment, Phase 8 API surface, Phase 9 screens                  | The soundness report is the product's credibility. Presentation decisions here are load-bearing and deserve undivided attention against the §8 direction. |

**Delegation rules for the main agent:**

1. **Subagents cannot see this conversation or this file.** Every delegation prompt must include the absolute path to `.claude/commands/build-authz-service.md`, the phase being worked, and the specific section numbers that govern the task. A subagent invoked with "build the schema compiler" and nothing else will invent its own spec.
2. **Subagents cannot talk to each other.** If `test-author` needs an interface `soundness-engineer` defined, the main agent carries it across. Sequence the work so that never becomes a loop.
3. **Never delegate a CHECKPOINT.** The main agent reports to me directly, with the subagent's actual output — not a summary of a summary.
4. **Review before accepting.** A subagent returns work; the main agent reads it against the phase exit criteria before committing. Delegation moves the work, not the responsibility.
5. **`test-author` runs after the spec exists, not after the implementation.** For Phase 1 in particular: the test for `a-permission-referencing-an-undeclared-relation-is-rejected` is written from §5 and this file, not from whatever `parser.ts` happens to do.
6. **Record delegations in `PROGRESS.md`** — which agent did which phase, and anything the main agent had to correct. Corrections are the most useful line in that file.

**Anti-pattern to avoid:** do not delegate a whole phase and accept the result unread because it came back green. `test-author` and `soundness-engineer` are both specifically adversarial to the rest of the build; the value only materializes if their findings are allowed to be inconvenient — a `soundness-engineer` who reports zero `false_grant` on the first try without ever having demonstrated the harness can catch a planted bug (Phase 5's exit criteria) has not actually shown the number means anything.
