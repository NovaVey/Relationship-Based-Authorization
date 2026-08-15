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
under their new names:

| This suite                                                                                       | Was                                                                     | Proves                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`permission-resolution.integration.test.ts`](./permission-resolution.integration.test.ts)       | `test/integration/rls-postgres.integration.test.ts`                     | Against a real Postgres-backed tuple store: fails closed, a subject's own tuples never leak into another subject's check, revocation is immediately effective, cycles terminate.                                                                                                 |
| [`differential-soundness.fuzz.test.ts`](./differential-soundness.fuzz.test.ts)                   | `test/rls/postgres.fuzz.test.ts` (fuzzing) reframed around a new oracle | Random schemas + tuple graphs + queries, checked against a slow-but-obviously-correct reference resolver. This is the single most important file in the repo — see `.claude/commands/build-authz-service.md` §6.2 and §9 Phase 5.                                                |
| [`identifier-and-tuple-validation.fuzz.test.ts`](./identifier-and-tuple-validation.fuzz.test.ts) | `test/rls/postgres.test.ts` + `test/tenant/tenant-id.fuzz.test.ts`      | Namespace, relation, and subject/object identifiers reject the same injection-shaped and malformed corpus the old tenant-id and SQL-identifier validators did — the schema DSL and tuple writer are new code, but the shape of "what a bad identifier looks like" didn't change. |

Every `it.todo(...)` below is a real assertion, not a placeholder — it is
the specification Phase 1 through Phase 5 of the build spec must satisfy,
written before the code it tests exists, exactly per that spec's rule 4 and
its `test-author` subagent's discipline: tests are derived from the spec,
not from the implementation, and are written first. Un-skip them as the
corresponding phase lands; a phase is not done until its named tests here
pass for real. Do not add new tests directly as passing — add them as
`.todo()` in the same commit as the spec section that demands them, then
implement.
