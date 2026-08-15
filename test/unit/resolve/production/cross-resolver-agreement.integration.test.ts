/**
 * Cross-resolver agreement — the actual Phase 4 exit criterion.
 * `.claude/commands/build-authz-service.md` §9 Phase 4: "agrees with the
 * Phase 3 reference resolver on the same hand-derived examples; the cyclic
 * case terminates within `CHECK_MAX_DEPTH` and resolves denied." §6.2
 * ("no shared code" between the two resolvers is what makes their agreement
 * meaningful evidence, not two coats of paint on one algorithm) and §6.4
 * (cycle detection and the depth budget are correctness requirements).
 *
 * Every fixture below is built once, per test, as a plain schema-DSL source
 * string and a set of `TupleKey`s. Those exact tuples are (a) written for
 * real via `writeTuple` into the live Postgres instance `productionCheck`
 * reads, and (b) passed unmodified as the in-memory `ReferenceTuple[]`
 * `referenceCheck` walks — same fields, same values, two independent
 * resolvers. Every expected `allowed` value is derived by hand from §5's
 * rewrite-rule grammar and the constructed graph, exactly as the Phase 3
 * delegation's own tests were (see `test/unit/resolve/reference-resolver
 * .rewrite-rules.test.ts`, `.graph-shape.test.ts`) — so a fixture can't pass
 * merely because both resolvers happen to agree on the same wrong answer.
 *
 * Per the task's explicit instruction: `src/resolve/reference/resolver.ts`
 * and `src/resolve/production/resolver.ts` were read ONLY for their
 * exported interfaces (types, function signatures, and the doc comments
 * directly attached to them) — never their private helpers, SQL bodies, or
 * recursion structure.
 *
 * Runs against a real, ephemeral Postgres container (`@testcontainers/
 * postgresql`, already a devDependency), with the Phase 2 migrations
 * applied via this project's own `runMigrations` — the same mechanism
 * `test/unit/store/tuple-store.integration.test.ts` uses (see
 * `docs/DECISIONS.md` D-019 for why: a connection string hardcoded to any
 * one development sandbox's own local Postgres doesn't exist in
 * `.github/workflows/ci.yml`'s `test-integration` job, which provisions no
 * Postgres of its own and expects the suite to start one itself).
 * `ubuntu-latest` GitHub Actions runners have Docker preinstalled, so this
 * needs no extra CI setup. The shared-database, no-truncation-between-tests
 * discipline `tuple-store.integration.test.ts` established still applies:
 * every fixture uses a `uniqueName`-generated namespace/object/subject so
 * tests are safe in any order and never see another test's tuples.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../../../src/store/tuples.js';
import { publishSchema } from '../../../../src/schema/publish.js';
import { compileSchema } from '../../../../src/schema/dsl/compiler.js';
import { formatSchemaError } from '../../../../src/schema/dsl/errors.js';
import type { CompiledSchema } from '../../../../src/schema/dsl/types.js';
import { referenceCheck } from '../../../../src/resolve/reference/resolver.js';
import { productionCheck } from '../../../../src/resolve/production/resolver.js';
import { runMigrations } from '../../../../src/store/migrate.js';

const MIGRATIONS_DIR = new URL('../../../../src/store/migrations', import.meta.url).pathname;

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool, MIGRATIONS_DIR);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

let uniqueCounter = 0;
// A random salt generated once when this file's test worker starts —
// `Date.now()` alone collides across sibling `*.integration.test.ts` files
// that vitest runs in parallel worker threads (all starting within the same
// wall-clock millisecond, each with its own `uniqueCounter` restarting at
// 0), which is a real defect this file's own first `npm run test:integration`
// run surfaced live: two different files independently generated the exact
// same `doc_<timestamp>_1` namespace name and collided on
// `namespace_configs`'s `(namespace, version)` unique constraint.
const processSalt = Math.random().toString(36).slice(2, 10);
/** A fresh lowercase identifier, unique across this and sibling test files/workers, matching IDENTIFIER_PATTERN. */
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
}

interface Ref {
  ns: string;
  id: string;
}

function ref(ns: string, id: string): Ref {
  return { ns, id };
}

function tuple(
  objectNs: string,
  objectId: string,
  relation: string,
  subjectNs: string,
  subjectId: string,
  subjectRelation?: string,
): TupleKey {
  return {
    objectNs,
    objectId,
    relation,
    subjectNs,
    subjectId,
    ...(subjectRelation !== undefined ? { subjectRelation } : {}),
  };
}

/** Compiles `source` and fails the test (with the formatted errors) if it doesn't compile. */
function compileOk(source: string): CompiledSchema {
  const result = compileSchema(source);
  if (!result.ok) {
    throw new Error(
      `expected schema to compile, got errors:\n${result.errors.map(formatSchemaError).join('\n')}`,
    );
  }
  return result.schema;
}

/** Publishes `source` into the real Postgres instance and fails the test if it doesn't. */
async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(pool, source);
  if (!result.ok) {
    throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
  }
}

/** Writes `t` for real and fails the test if the store rejects it. */
async function writeOk(t: TupleKey): Promise<void> {
  const result = await writeTuple(pool, t);
  if (!result.ok) {
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
  }
}

/**
 * Publishes `source`, compiles it independently for the reference resolver,
 * and returns both — the two resolvers never share this compilation step at
 * runtime (the production resolver re-fetches its own copy from
 * `namespace_configs` inside `productionCheck`), but both are compiled from
 * the identical source text so a divergence can only come from the walk
 * itself, never from two different schemas being tested.
 */
async function setUpSchema(source: string): Promise<CompiledSchema> {
  const schema = compileOk(source);
  await publishOk(source);
  return schema;
}

describe('a direct grant and a denial with zero tuples', () => {
  function documentSource(ns: string): string {
    return [
      `namespace ${ns} {`,
      '  relation owner: user',
      '  relation editor: user',
      '  relation viewer: user',
      '',
      '  permission view = viewer | editor | owner',
      '}',
    ].join('\n');
  }

  it('both-resolvers-allow-a-direct-viewer-grant', async () => {
    const ns = uniqueName('doc');
    const schema = await setUpSchema(documentSource(ns));
    const objectId = uniqueName('obj');
    const grant = tuple(ns, objectId, 'viewer', 'user', 'alice');
    await writeOk(grant);

    const referenceResult = referenceCheck(
      schema,
      [grant],
      ref('user', 'alice'),
      ref(ns, objectId),
      'view',
    );
    const productionResult = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(ns, objectId),
      'view',
    );

    // Hand-derived: alice has a direct `viewer` tuple; `view = viewer | editor | owner`.
    expect(referenceResult.allowed).toBe(true);
    expect(productionResult.allowed).toBe(true);
    expect(productionResult.allowed).toBe(referenceResult.allowed);
  });

  it('both-resolvers-deny-a-subject-with-zero-relation-tuples-anywhere-on-the-object', async () => {
    const ns = uniqueName('doc');
    const schema = await setUpSchema(documentSource(ns));
    // Never written to by anything.
    const objectId = uniqueName('obj');

    const referenceResult = referenceCheck(
      schema,
      [],
      ref('user', 'bob'),
      ref(ns, objectId),
      'view',
    );
    const productionResult = await productionCheck(
      pool,
      ref('user', 'bob'),
      ref(ns, objectId),
      'view',
    );

    // Hand-derived: zero tuples anywhere on this object → no path exists for
    // any subject, `view` must be false.
    expect(referenceResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(referenceResult.allowed);
  });
});

describe('tuple-to-userset through a three-level parent chain', () => {
  function folderChainSource(ns: string): string {
    return [
      `namespace ${ns} {`,
      `  relation parent: ${ns}`,
      '  relation editor: user',
      '',
      '  permission view = editor | parent->view',
      '}',
    ].join('\n');
  }

  it('both-resolvers-allow-a-subject-reachable-only-at-the-end-of-a-three-level-parent-chain', async () => {
    const ns = uniqueName('folder');
    const schema = await setUpSchema(folderChainSource(ns));
    const a = uniqueName('a');
    const b = uniqueName('b');
    const c = uniqueName('c');

    // a --parent--> b --parent--> c, editor granted only on c.
    const chain: TupleKey[] = [
      tuple(ns, a, 'parent', ns, b),
      tuple(ns, b, 'parent', ns, c),
      tuple(ns, c, 'editor', 'user', 'grace'),
    ];
    for (const t of chain) await writeOk(t);

    const referenceResult = referenceCheck(schema, chain, ref('user', 'grace'), ref(ns, a), 'view');
    const productionResult = await productionCheck(pool, ref('user', 'grace'), ref(ns, a), 'view');

    // Hand-derived: view(a) = editor(a) | parent(a)->view(b). editor(a) is
    // false (no tuple). parent(a) = b, so recurse into view(b) = editor(b) |
    // parent(b)->view(c). editor(b) false, parent(b) = c, recurse into
    // view(c) = editor(c) | ... ; editor(c) has grace directly → true,
    // propagates all the way back up. Allowed.
    expect(referenceResult.allowed).toBe(true);
    expect(productionResult.allowed).toBe(true);
    expect(productionResult.allowed).toBe(referenceResult.allowed);
  });

  it('both-resolvers-deny-a-subject-not-reachable-through-any-hop-of-the-chain', async () => {
    const ns = uniqueName('folder');
    const schema = await setUpSchema(folderChainSource(ns));
    const a = uniqueName('a');
    const b = uniqueName('b');
    const c = uniqueName('c');

    const chain: TupleKey[] = [
      tuple(ns, a, 'parent', ns, b),
      tuple(ns, b, 'parent', ns, c),
      tuple(ns, c, 'editor', 'user', 'grace'),
    ];
    for (const t of chain) await writeOk(t);

    const referenceResult = referenceCheck(schema, chain, ref('user', 'henry'), ref(ns, a), 'view');
    const productionResult = await productionCheck(pool, ref('user', 'henry'), ref(ns, a), 'view');

    // Hand-derived: henry appears nowhere in the chain — denied.
    expect(referenceResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(referenceResult.allowed);
  });
});

describe('a cyclic group nesting both resolvers deny without hanging', () => {
  // §6.4's own worked example: group:a nests group:b nests group:a. Neither
  // node grants real membership to anyone inside the cycle — the
  // hand-derived answer for any subject only reachable via the cycle is
  // unambiguously "denied," and the property under test is that BOTH
  // resolvers terminate rather than looping or hanging.
  function groupCycleSource(ns: string): string {
    return [`namespace ${ns} {`, `  relation member: user | ${ns}#member`, '}'].join('\n');
  }

  // `maxDepth` is forced to an explicit, very large value on BOTH calls —
  // per docs/DECISIONS.md D-024 (reference resolver) and this task's own
  // instruction: a cyclic-termination test run at either resolver's
  // *default* depth budget can pass even with cycle detection completely
  // disabled, because the independent depth ceiling silently absorbs the
  // infinite recursion first. This value has to be large enough that the
  // depth ceiling alone could not plausibly be what terminates the walk —
  // mirrors `test/unit/resolve/reference-resolver.graph-shape.test.ts`'s own
  // `a-cyclic-group-nesting-terminates-and-resolves-denied` test exactly.
  const FORCED_MAX_DEPTH = 1_000_000;

  it('both-resolvers-deny-a-cyclic-group-nesting-and-terminate-with-an-explicit-depth-budget-that-cannot-be-absorbed-by-the-depth-ceiling-alone', async () => {
    const ns = uniqueName('grp');
    const schema = await setUpSchema(groupCycleSource(ns));
    const a = uniqueName('a');
    const b = uniqueName('b');
    const decoyObject = uniqueName('decoy');

    // The cycle itself: a's members include b's members, and vice versa.
    const cycle: TupleKey[] = [
      tuple(ns, a, 'member', ns, b, 'member'),
      tuple(ns, b, 'member', ns, a, 'member'),
    ];
    // The decoy tuple per docs/DECISIONS.md D-027 / this task's own
    // instruction: a real, unrelated grant naming the checked subject
    // (`zoe`) elsewhere in `relation_tuples`. Without this, Postgres's query
    // planner can prune the recursive CTE's join entirely — because `zoe`
    // never appears anywhere in the table at all — passing "fast" even with
    // zero cycle protection, which would make this test unable to actually
    // distinguish working cycle detection from none. `zoe` is a real member
    // of an object structurally unrelated to the cycle being tested.
    const decoy = tuple(ns, decoyObject, 'member', 'user', 'zoe');

    for (const t of [...cycle, decoy]) await writeOk(t);

    const referenceTuples = [...cycle, decoy];

    const refStart = performance.now();
    const referenceResult = referenceCheck(
      schema,
      referenceTuples,
      ref('user', 'zoe'),
      ref(ns, a),
      'member',
      { maxDepth: FORCED_MAX_DEPTH },
    );
    const refElapsedMs = performance.now() - refStart;

    const prodStart = performance.now();
    const productionResult = await productionCheck(pool, ref('user', 'zoe'), ref(ns, a), 'member', {
      maxDepth: FORCED_MAX_DEPTH,
    });
    const prodElapsedMs = performance.now() - prodStart;

    // Hand-derived: zoe is never a member of group:a or group:b through any
    // real path — the only edges naming zoe at all are the decoy tuple on a
    // structurally unrelated object. Denied.
    expect(referenceResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(referenceResult.allowed);

    // "Did not hang" assertions, not performance assertions — a resolver
    // whose cycle detection is broken would, at `maxDepth: 1_000_000`,
    // either blow the call stack (reference) or spend the whole depth
    // budget growing a path-tracking structure by one element per iteration
    // (production's SQL-side recursive CTE) — orders of magnitude slower
    // than the sub-second return a working two-node cycle guard produces.
    expect(refElapsedMs).toBeLessThan(4000);
    expect(prodElapsedMs).toBeLessThan(8000);
  });

  it('both-resolvers-deny-the-same-cyclic-group-nesting-at-the-standard-default-depth-budget-too', async () => {
    // Phase 4's own exit criterion, read literally: "the cyclic case
    // terminates within CHECK_MAX_DEPTH." The test above forces a huge
    // budget specifically to isolate cycle detection from the depth
    // ceiling; this one additionally confirms the ordinary, undecorated
    // call (no maxDepth override — CHECK_MAX_DEPTH=25 per .env) also
    // terminates and denies, which is the literal exit-criterion wording.
    const ns = uniqueName('grp');
    const schema = await setUpSchema(groupCycleSource(ns));
    const a = uniqueName('a');
    const b = uniqueName('b');
    const decoyObject = uniqueName('decoy');

    const cycle: TupleKey[] = [
      tuple(ns, a, 'member', ns, b, 'member'),
      tuple(ns, b, 'member', ns, a, 'member'),
    ];
    const decoy = tuple(ns, decoyObject, 'member', 'user', 'zoe');
    for (const t of [...cycle, decoy]) await writeOk(t);

    const referenceResult = referenceCheck(
      schema,
      [...cycle, decoy],
      ref('user', 'zoe'),
      ref(ns, a),
      'member',
    );
    const productionResult = await productionCheck(pool, ref('user', 'zoe'), ref(ns, a), 'member');

    expect(referenceResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(false);
  });

  it('a-cyclic-group-nesting-with-a-real-grant-outside-the-cycle-still-resolves-allowed-on-both-resolvers', async () => {
    // The cycle itself must not poison an otherwise-real, non-cyclic grant
    // reachable through the same object: group:a nests group:b nests
    // group:a (the cycle, ungrounded), AND group:a directly grants
    // membership to user:mabel outside the cycle entirely.
    const ns = uniqueName('grp');
    const schema = await setUpSchema(groupCycleSource(ns));
    const a = uniqueName('a');
    const b = uniqueName('b');

    const tuples: TupleKey[] = [
      tuple(ns, a, 'member', ns, b, 'member'),
      tuple(ns, b, 'member', ns, a, 'member'),
      tuple(ns, a, 'member', 'user', 'mabel'),
    ];
    for (const t of tuples) await writeOk(t);

    const referenceResult = referenceCheck(
      schema,
      tuples,
      ref('user', 'mabel'),
      ref(ns, a),
      'member',
    );
    const productionResult = await productionCheck(
      pool,
      ref('user', 'mabel'),
      ref(ns, a),
      'member',
    );

    expect(referenceResult.allowed).toBe(true);
    expect(productionResult.allowed).toBe(true);
    expect(productionResult.allowed).toBe(referenceResult.allowed);
  });
});

describe('union, intersection, and exclusion each resolving denied by the combinator itself', () => {
  // Mirrors test/unit/resolve/reference-resolver.rewrite-rules.test.ts's own
  // rigor: each combinator gets a case where the combinator itself is the
  // reason for denial (only one branch of an intersection satisfied; an
  // exclusion tuple added on top of an otherwise-satisfied base; a subject
  // satisfying neither union branch even though tuples exist for others on
  // the same object) — never just "no tuple exists anywhere."
  function combinatorSource(ns: string): string {
    return [
      `namespace ${ns} {`,
      '  relation owner: user',
      '  relation editor: user',
      '  relation viewer: user',
      '  relation banned: user',
      '',
      '  permission any_access = viewer | editor',
      '  permission trusted_edit = editor & owner',
      '  permission unbanned_view = viewer - banned',
      '}',
    ].join('\n');
  }

  it('both-resolvers-deny-a-union-permission-for-a-subject-satisfying-neither-branch-while-other-subjects-tuples-exist-on-the-same-object', async () => {
    const ns = uniqueName('doc');
    const schema = await setUpSchema(combinatorSource(ns));
    const objectId = uniqueName('obj');
    const tuples: TupleKey[] = [tuple(ns, objectId, 'viewer', 'user', 'alice')];
    for (const t of tuples) await writeOk(t);

    const referenceResult = referenceCheck(
      schema,
      tuples,
      ref('user', 'bob'),
      ref(ns, objectId),
      'any_access',
    );
    const productionResult = await productionCheck(
      pool,
      ref('user', 'bob'),
      ref(ns, objectId),
      'any_access',
    );

    // Hand-derived: bob has neither a viewer nor an editor tuple, even
    // though alice's viewer tuple exists on the same object — bob's edge is
    // not a substitute for alice's.
    expect(referenceResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(referenceResult.allowed);
  });

  it('both-resolvers-deny-an-intersection-permission-when-only-the-editor-branch-is-satisfied', async () => {
    const ns = uniqueName('doc');
    const schema = await setUpSchema(combinatorSource(ns));
    const objectId = uniqueName('obj');
    const tuples: TupleKey[] = [tuple(ns, objectId, 'editor', 'user', 'dave')];
    for (const t of tuples) await writeOk(t);

    const referenceResult = referenceCheck(
      schema,
      tuples,
      ref('user', 'dave'),
      ref(ns, objectId),
      'trusted_edit',
    );
    const productionResult = await productionCheck(
      pool,
      ref('user', 'dave'),
      ref(ns, objectId),
      'trusted_edit',
    );

    // Hand-derived: dave is an editor but never an owner — a union would
    // grant this; the intersection must not.
    expect(referenceResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(referenceResult.allowed);
  });

  it('both-resolvers-allow-an-intersection-permission-once-both-branches-are-independently-satisfied', async () => {
    const ns = uniqueName('doc');
    const schema = await setUpSchema(combinatorSource(ns));
    const objectId = uniqueName('obj');
    const tuples: TupleKey[] = [
      tuple(ns, objectId, 'editor', 'user', 'dave'),
      tuple(ns, objectId, 'owner', 'user', 'dave'),
    ];
    for (const t of tuples) await writeOk(t);

    const referenceResult = referenceCheck(
      schema,
      tuples,
      ref('user', 'dave'),
      ref(ns, objectId),
      'trusted_edit',
    );
    const productionResult = await productionCheck(
      pool,
      ref('user', 'dave'),
      ref(ns, objectId),
      'trusted_edit',
    );

    expect(referenceResult.allowed).toBe(true);
    expect(productionResult.allowed).toBe(true);
    expect(productionResult.allowed).toBe(referenceResult.allowed);
  });

  it('both-resolvers-deny-an-exclusion-permission-once-the-subtracted-branch-tuple-is-added-even-though-the-base-tuple-still-grants', async () => {
    const ns = uniqueName('doc');
    const schema = await setUpSchema(combinatorSource(ns));
    const objectId = uniqueName('obj');
    // frank is still a viewer — the base branch alone would grant this
    // under a union. Adding the `banned` tuple must flip the answer: this
    // is the combinator doing the work, not an absence of tuples.
    const tuples: TupleKey[] = [
      tuple(ns, objectId, 'viewer', 'user', 'frank'),
      tuple(ns, objectId, 'banned', 'user', 'frank'),
    ];
    for (const t of tuples) await writeOk(t);

    const referenceResult = referenceCheck(
      schema,
      tuples,
      ref('user', 'frank'),
      ref(ns, objectId),
      'unbanned_view',
    );
    const productionResult = await productionCheck(
      pool,
      ref('user', 'frank'),
      ref(ns, objectId),
      'unbanned_view',
    );

    expect(referenceResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(referenceResult.allowed);
  });

  it('both-resolvers-allow-an-exclusion-permission-for-a-subject-in-the-base-set-who-is-not-in-the-subtracted-set', async () => {
    const ns = uniqueName('doc');
    const schema = await setUpSchema(combinatorSource(ns));
    const objectId = uniqueName('obj');
    const tuples: TupleKey[] = [tuple(ns, objectId, 'viewer', 'user', 'frank')];
    for (const t of tuples) await writeOk(t);

    const referenceResult = referenceCheck(
      schema,
      tuples,
      ref('user', 'frank'),
      ref(ns, objectId),
      'unbanned_view',
    );
    const productionResult = await productionCheck(
      pool,
      ref('user', 'frank'),
      ref(ns, objectId),
      'unbanned_view',
    );

    expect(referenceResult.allowed).toBe(true);
    expect(productionResult.allowed).toBe(true);
    expect(productionResult.allowed).toBe(referenceResult.allowed);
  });
});

describe('a diamond-shaped graph (the same node reachable via two non-cyclic branches) resolves correctly on both resolvers', () => {
  // folder:start reaches folder:shared via two distinct edges (`parent` and
  // `sibling_link`), each recursing into a *different* computed permission
  // on folder:shared (`view` vs `edit`). folder:shared has no `viewer`
  // tuple (so `view` on it is false) but does have an `editor` tuple for
  // lee (so `edit` on it is true) — mirrors test/unit/resolve/reference-
  // resolver.graph-shape.test.ts's own diamond fixture exactly, run here
  // against both resolvers on identical seeded Postgres data.
  function diamondSource(ns: string): string {
    return [
      `namespace ${ns} {`,
      `  relation parent: ${ns}`,
      `  relation sibling_link: ${ns}`,
      '  relation viewer: user',
      '  relation editor: user',
      '',
      '  permission view = viewer',
      '  permission edit = editor',
      '  permission access = parent->view | sibling_link->edit',
      '}',
    ].join('\n');
  }

  it('both-resolvers-allow-a-subject-reachable-only-through-the-diamonds-second-branch', async () => {
    const ns = uniqueName('folder');
    const schema = await setUpSchema(diamondSource(ns));
    const start = uniqueName('start');
    const shared = uniqueName('shared');

    const tuples: TupleKey[] = [
      tuple(ns, start, 'parent', ns, shared),
      tuple(ns, start, 'sibling_link', ns, shared),
      tuple(ns, shared, 'editor', 'user', 'lee'),
      // deliberately no `viewer` tuple on folder:shared — the parent->view
      // branch must fail on its own merits, not because of a dedup bug.
    ];
    for (const t of tuples) await writeOk(t);

    const referenceResult = referenceCheck(
      schema,
      tuples,
      ref('user', 'lee'),
      ref(ns, start),
      'access',
    );
    const productionResult = await productionCheck(
      pool,
      ref('user', 'lee'),
      ref(ns, start),
      'access',
    );

    // Hand-derived: access(start) = parent(start)->view(shared) |
    // sibling_link(start)->edit(shared) = view(shared) | edit(shared) =
    // false | true = true.
    expect(referenceResult.allowed).toBe(true);
    expect(productionResult.allowed).toBe(true);
    expect(productionResult.allowed).toBe(referenceResult.allowed);
  });

  it('both-resolvers-deny-once-the-diamonds-second-branch-is-removed-proving-the-allowed-result-above-genuinely-depended-on-it', async () => {
    // Control: remove the sibling_link edge entirely. Now the only route to
    // folder:shared is parent->view, which is false (no viewer tuple). If
    // the previous test only passed because a resolver treats any reach of
    // folder:shared as an automatic grant, this control would incorrectly
    // also pass — it must not.
    const ns = uniqueName('folder');
    const schema = await setUpSchema(diamondSource(ns));
    const start = uniqueName('start');
    const shared = uniqueName('shared');

    const tuples: TupleKey[] = [
      tuple(ns, start, 'parent', ns, shared),
      tuple(ns, shared, 'editor', 'user', 'lee'),
    ];
    for (const t of tuples) await writeOk(t);

    const referenceResult = referenceCheck(
      schema,
      tuples,
      ref('user', 'lee'),
      ref(ns, start),
      'access',
    );
    const productionResult = await productionCheck(
      pool,
      ref('user', 'lee'),
      ref(ns, start),
      'access',
    );

    expect(referenceResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(referenceResult.allowed);
  });
});
