/**
 * Proves, against a real Postgres-backed tuple store, that the check engine
 * never resolves a permission for which no relation path actually exists.
 *
 * This is the direct descendant of this repo's previous identity's
 * `test/integration/rls-postgres.integration.test.ts`, which proved "a
 * tenant only sees its own rows" against real row-level-security policies.
 * See `test/isolation/README.md` for the full lineage. The property is the
 * same at one more level of generality: a `tenant_id` match was always just
 * the simplest possible relation path (one hop, one column). A graph walk
 * over relation tuples is the general case; "no path" replaces "no
 * matching tenant_id" as the thing that must always deny.
 *
 * Needs Docker; will run in its own vitest project (see
 * vitest.integration.config.ts) via `npm run test:integration`, kept
 * separate from the default `npm test` so contributors without Docker
 * aren't blocked on the fast unit suite — same reasoning as the file this
 * replaces.
 *
 * Every test below is `.todo()` until the tuple store (Phase 2) and the
 * production check engine (Phase 4) exist — see
 * `.claude/commands/build-authz-service.md`. Un-skip a test only once the
 * phase that implements what it needs has landed; a `.todo()` staying red
 * past its phase's exit criteria is a sign the phase isn't actually done.
 */
import { describe, it } from 'vitest';

describe('a subject only resolves permissions reachable through an actual relation-tuple path', () => {
  // Setup this suite will need once it's implemented, carried over from the
  // predecessor's own beforeAll: a real PostgreSqlContainer, a schema
  // compiled from a small example namespace config (see Phase 9's example
  // schema), and a handful of relation tuples seeded as an admin connection
  // — analogous to the old file seeding tenant-tagged rows as the
  // superuser role before testing what an app-scoped role can see.

  it.todo(
    'checking (user:alice, viewer, document:readme) returns allowed when a viewer tuple exists directly',
  );

  it.todo(
    'checking (user:bob, viewer, document:readme) returns denied when no tuple or rewrite path reaches bob at all — the direct analog of "a tenant only sees its own rows"',
  );

  it.todo(
    "a relation tuple granting user:alice on document:readme is never used to resolve a check for user:bob on the same object, even though both share the object — the core invariant, restated: alice's edge is not a substitute for bob's own",
  );

  it.todo(
    'checking a different subject against the same object, same connection, changes the resolution — the analog of "switching the session tenant id changes what is visible, same connection"',
  );

  it.todo(
    'fails closed: check() returns denied when the object has zero relation tuples of any kind — the analog of "no rows are visible when no tenant context has been set"',
  );

  it.todo(
    'revoking (deleting) the one tuple a check depended on makes the very next check on the same subject/object deny — no caching layer may serve a stale grant past the write that removed it',
  );

  it.todo(
    "writing a tuple for one namespace's relation never grants a permission in an unrelated namespace that happens to share subject or object ids — cross-namespace bleed is the multi-tenant-kit failure mode, restated",
  );

  it.todo(
    'group nesting resolves transitively: user:alice in group:eng, group:eng granted editor on folder:design, alice checks as editor on folder:design with no direct tuple to alice at all — tuple-to-userset, the mechanism a flat tenant_id column had no equivalent of',
  );

  it.todo(
    'a cyclic group nesting (group:a nests group:b nests group:a) terminates the walk and resolves denied rather than hanging or crashing — a genuinely new failure mode a single-hop tenant check never had to face',
  );

  it.todo(
    'a check pinned to the consistency token returned by a just-completed write observes that write — the token/write ordering the old suite never had to model, because a single-row RLS check has no equivalent staleness window',
  );

  it.todo(
    'a check NOT pinned to a token, issued concurrently with a revoking write, never observes a permission strictly newer than its own start — bounded staleness, not an unbounded one; see docs/DECISIONS.md for the consistency model chosen',
  );
});

/**
 * Regression coverage carried over in spirit from the predecessor's
 * per-command (SELECT/INSERT/DELETE-only) policy suite: narrow, specific
 * rewrite-rule shapes each get their own real-database proof rather than
 * being asserted only against the reference resolver (differential-
 * soundness.fuzz.test.ts) or the SQL/config text a compiler emits.
 */
describe('rewrite-rule shapes execute correctly against a real Postgres-backed tuple store', () => {
  it.todo(
    'a union rewrite rule (viewer := owner | editor | viewer) grants via any one of its branches independently',
  );

  it.todo(
    'an intersection rewrite rule (must satisfy two relations at once) denies when only one branch resolves',
  );

  it.todo(
    'an exclusion rewrite rule (viewer but not banned) denies a subject who would otherwise resolve via the positive branch once the exclusion tuple is present',
  );

  it.todo(
    'a tuple-to-userset rewrite rule (this#viewer := parent#editor) resolves through a real parent-folder tuple chain of depth 3',
  );
});
