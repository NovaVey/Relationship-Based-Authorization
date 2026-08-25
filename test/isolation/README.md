# The isolation suite

This directory is inherited, not new. It started as this repo's previous
identity — a multi-tenant security kit — proving one property against a real
Postgres: **tenant A can never read, write, or see the existence of tenant
B's rows.** That property was proven three ways: an integration suite
running real cross-tenant queries against real row-level-security policies,
a property-based fuzz suite throwing generated and hand-picked
injection-shaped input at the SQL-generation layer, and hand-picked
exact-string regression tests locking in specific past bugs.

None of that mechanism survives here — row-level security and a
`tenant_id` column are the wrong tool for relationship-based authorization.
What survives is the property, restated for a permission graph instead of a
tenant column:

> **No relation path from subject to object resolves to a permission it
> shouldn't have.**

That is the same claim, one level more general. "Tenant B's row" was always
just the simplest possible object a subject has no path to. A `viewer` edge
that doesn't exist is the same absence of a path that a missing `tenant_id`
match used to represent — the check engine either finds a real, walkable
chain of relation tuples from subject to object, or it must say no, and
proving that exhaustively is this suite's entire job.

The three files here carry the three original proof strategies forward
under their new names, plus a fourth that later split off one of them for a
reason specific to this project's own fast/integration test split:

| This suite                                                                                             | Was                                                                     | Proves                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`permission-resolution.integration.test.ts`](./permission-resolution.integration.test.ts)             | `test/integration/rls-postgres.integration.test.ts`                     | Against a real Postgres-backed tuple store: fails closed, a subject's own tuples never leak into another subject's check, revocation is immediately effective, cycles terminate.                                                                                                                                                                                                                 |
| [`differential-soundness.fuzz.test.ts`](./differential-soundness.fuzz.test.ts)                         | `test/rls/postgres.fuzz.test.ts` (fuzzing) reframed around a new oracle | Random schemas + tuple graphs + queries, checked against a slow-but-obviously-correct reference resolver, on DB-free/mocked paths. This is the single most important file in the repo — see `.claude/commands/build-authz-service.md` §6.2 and §9 Phase 5.                                                                                                                                       |
| [`differential-soundness.fuzz.integration.test.ts`](./differential-soundness.fuzz.integration.test.ts) | (split out of the file above)                                           | The same §9 Phase 5 / §10 exit criterion, but run for real: `runSoundnessFuzz` against a real ephemeral Postgres, the real production engine, and the real reference oracle — split into its own `.integration.test.ts` file so it runs via `npm run test:integration`, not the fast `npm test` suite, exactly like `test/unit/resolve/production/cross-resolver-agreement.integration.test.ts`. |
| [`identifier-and-tuple-validation.fuzz.test.ts`](./identifier-and-tuple-validation.fuzz.test.ts)       | `test/rls/postgres.test.ts` + `test/tenant/tenant-id.fuzz.test.ts`      | Namespace, relation, and subject/object identifiers reject the same injection-shaped and malformed corpus the old tenant-id and SQL-identifier validators did — the schema DSL and tuple writer are new code, but the shape of "what a bad identifier looks like" didn't change.                                                                                                                 |

Every test below **was** an `it.todo(...)` placeholder when this suite was
first written — the specification Phase 1 through Phase 5 of the build spec
had to satisfy, written before the code it tests existed, exactly per
`.claude/commands/build-authz-service.md` §14's delegation rules and the
`test-author` subagent's own discipline: tests are derived from the spec,
not from the implementation, and are written first. None remain `.todo()`
today — every phase they specified has landed, and each was un-skipped into
a real, passing assertion as its phase shipped (see each file's own header
comment for the specific commit/decision that did so). Add new tests the
same way going forward: as `.todo()` in the same commit as the spec section
that demands them, then implement and un-skip.
