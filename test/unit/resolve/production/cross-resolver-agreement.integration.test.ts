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
import { fileURLToPath } from 'node:url';
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

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../src/store/migrations', import.meta.url));

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

describe('depth-budget accounting parity — deep fixtures the earlier 3-level fixtures above cannot catch', () => {
  // The fixtures above top out at three levels, which is nowhere near deep
  // enough to exercise `resolve()`'s depth-budget bookkeeping in
  // `src/resolve/production/resolver.ts`. The three fixtures below each
  // reproduce a real, previously-live cross-resolver disagreement found by
  // auditing that bookkeeping line by line against the reference resolver's
  // own (`src/resolve/reference/resolver.ts`'s `resolveMembership`/
  // `evalRewrite`), confirmed live against real Postgres before the fix and
  // re-confirmed clean after it. See `docs/DECISIONS.md` for the full
  // writeup (the entry documenting this fix).

  describe('a false_grant: the SQL-level relation lookup must charge for TS-level depth already spent, not the full ceiling', () => {
    // Before the fix, `resolve()`'s relation branch always handed
    // `sqlRelationMembershipWithWitness` the FULL `ctx.maxDepth` ceiling,
    // regardless of how much TS-level `depth` a prior computedUserset hop
    // had already spent reaching that call — so one relation-membership
    // lookup could walk the *entire* configured budget on its own, on top
    // of whatever it cost to get there. Reproduced live: at `maxDepth: 3`,
    // `referenceCheck` denied and `productionCheck` allowed — a real
    // `false_grant` per build spec §6.5 (allowed-with-no-real-path), not a
    // mere disagreement.
    function fixtureSource(gns: string, dns: string): string {
      return [
        `namespace ${gns} {`,
        `  relation member: user | ${gns}#member`,
        '}',
        `namespace ${dns} {`,
        `  relation viewer: user | ${gns}#member`,
        '  permission view = viewer',
        '}',
      ].join('\n');
    }

    it('both-resolvers-deny-a-subject-reachable-only-past-a-three-level-nested-group-chain-once-a-permission-hop-has-already-spent-part-of-the-depth-budget', async () => {
      const gns = uniqueName('grp');
      const dns = uniqueName('doc');
      const schema = await setUpSchema(fixtureSource(gns, dns));
      const d1 = uniqueName('d1');
      const g0 = uniqueName('g0');
      const g1 = uniqueName('g1');
      const g2 = uniqueName('g2');

      // doc:d1 --viewer--> group:g0#member --member--> group:g1#member
      //   --member--> group:g2#member --member--> user:alice (direct grant)
      // Hand-derived cost to reach alice: 1 hop for the `viewer`
      // computedUserset leaf, plus 3 nested `member` userset crossings = 4
      // total. At `maxDepth: 3` that's one hop past budget on both engines.
      const tuples: TupleKey[] = [
        tuple(dns, d1, 'viewer', gns, g0, 'member'),
        tuple(gns, g0, 'member', gns, g1, 'member'),
        tuple(gns, g1, 'member', gns, g2, 'member'),
        tuple(gns, g2, 'member', 'user', 'alice'),
      ];
      for (const t of tuples) await writeOk(t);

      const referenceResult = referenceCheck(
        schema,
        tuples,
        ref('user', 'alice'),
        ref(dns, d1),
        'view',
        { maxDepth: 3 },
      );
      const productionResult = await productionCheck(
        pool,
        ref('user', 'alice'),
        ref(dns, d1),
        'view',
        {
          maxDepth: 3,
        },
      );

      expect(referenceResult.allowed).toBe(false);
      // The regression this guards: before the fix this was `true` — a
      // false_grant, not merely a false_deny — because the SQL-level
      // lookup for `viewer` received the full `maxDepth: 3` budget instead
      // of the 2 remaining after the computedUserset hop already spent 1,
      // which was enough slack to walk all three nested `member` crossings
      // undetected.
      expect(productionResult.allowed).toBe(false);
      expect(productionResult.allowed).toBe(referenceResult.allowed);
    });

    it('the-identical-chain-is-allowed-by-both-resolvers-once-maxDepth-is-raised-enough-to-cover-the-real-cost', async () => {
      // Control: same fixture, budget raised to the real cost (4) — proves
      // the denial above was genuinely about the budget, not a mistake
      // elsewhere in the fixture.
      const gns = uniqueName('grp');
      const dns = uniqueName('doc');
      const schema = await setUpSchema(fixtureSource(gns, dns));
      const d1 = uniqueName('d1');
      const g0 = uniqueName('g0');
      const g1 = uniqueName('g1');
      const g2 = uniqueName('g2');

      const tuples: TupleKey[] = [
        tuple(dns, d1, 'viewer', gns, g0, 'member'),
        tuple(gns, g0, 'member', gns, g1, 'member'),
        tuple(gns, g1, 'member', gns, g2, 'member'),
        tuple(gns, g2, 'member', 'user', 'alice'),
      ];
      for (const t of tuples) await writeOk(t);

      const referenceResult = referenceCheck(
        schema,
        tuples,
        ref('user', 'alice'),
        ref(dns, d1),
        'view',
        { maxDepth: 4 },
      );
      const productionResult = await productionCheck(
        pool,
        ref('user', 'alice'),
        ref(dns, d1),
        'view',
        {
          maxDepth: 4,
        },
      );

      expect(referenceResult.allowed).toBe(true);
      expect(productionResult.allowed).toBe(true);
      expect(productionResult.allowed).toBe(referenceResult.allowed);
    });
  });

  describe('a false_deny: tupleToUserset must cost exactly what computedUserset costs, never double, all the way to the real ceiling', () => {
    // Before the fix, `tupleToUserset` in `evalRewrite` passed `depth + 1`
    // to `resolve()` on top of the `+1` already spent entering `evalRewrite`
    // from `resolve()`'s own permission branch — double the cost
    // `computedUserset` charges for the same conceptual one-hop crossing.
    // Reproduced live on a 25-level `folder` parent chain (`view = editor |
    // parent->view`) with the grant on the deepest node and `maxDepth: 25`:
    // the reference resolver allows all the way out to 24 hops of distance
    // (denying only at the true ceiling, 25); before the fix, production
    // started denying around 11-12 hops — roughly half its real capacity.
    function folderChainSource(fns: string): string {
      return [
        `namespace ${fns} {`,
        `  relation parent: ${fns}`,
        '  relation editor: user',
        '',
        '  permission view = editor | parent->view',
        '}',
      ].join('\n');
    }

    it('both-resolvers-allow-a-subject-at-the-farthest-distance-the-real-ceiling-permits-on-a-25-level-parent-chain', async () => {
      const fns = uniqueName('folder');
      const schema = await setUpSchema(folderChainSource(fns));
      const N = 25;
      const nodeIds = Array.from({ length: N + 1 }, (_, i) => uniqueName(`f${i}`));
      const tuples: TupleKey[] = [];
      for (let i = 0; i < N; i++) {
        tuples.push(tuple(fns, nodeIds[i]!, 'parent', fns, nodeIds[i + 1]!));
      }
      tuples.push(tuple(fns, nodeIds[N]!, 'editor', 'user', 'alice'));
      for (const t of tuples) await writeOk(t);

      // Query object is 24 parent-hops away from the grant (nodeIds[1]) —
      // the deepest point the reference resolver's own `depth > maxDepth`
      // ceiling still allows at `maxDepth: 25`.
      const referenceResult = referenceCheck(
        schema,
        tuples,
        ref('user', 'alice'),
        ref(fns, nodeIds[1]!),
        'view',
        { maxDepth: N },
      );
      const productionResult = await productionCheck(
        pool,
        ref('user', 'alice'),
        ref(fns, nodeIds[1]!),
        'view',
        { maxDepth: N },
      );

      // Hand-derived: reference allows at exactly 24 hops of distance (see
      // this describe block's own comment). Before the fix, production
      // denied here — both from the tupleToUserset double-counting bug and,
      // independently, from a residual off-by-one in `resolve()`'s own
      // ceiling comparator found while re-deriving this fixture's expected
      // boundary (see `docs/DECISIONS.md`) — this single assertion catches
      // either regression on its own.
      expect(referenceResult.allowed).toBe(true);
      expect(productionResult.allowed).toBe(true);
      expect(productionResult.allowed).toBe(referenceResult.allowed);
    });

    it('both-resolvers-deny-the-same-chains-query-object-itself-25-hops-away-genuinely-past-the-ceiling', async () => {
      // Control at the other edge: one hop farther out (the full chain,
      // nodeIds[0]) is genuinely past `maxDepth: 25` on both engines — the
      // allow above is not "always allow," it tracks the real ceiling.
      const fns = uniqueName('folder');
      const schema = await setUpSchema(folderChainSource(fns));
      const N = 25;
      const nodeIds = Array.from({ length: N + 1 }, (_, i) => uniqueName(`f${i}`));
      const tuples: TupleKey[] = [];
      for (let i = 0; i < N; i++) {
        tuples.push(tuple(fns, nodeIds[i]!, 'parent', fns, nodeIds[i + 1]!));
      }
      tuples.push(tuple(fns, nodeIds[N]!, 'editor', 'user', 'alice'));
      for (const t of tuples) await writeOk(t);

      const referenceResult = referenceCheck(
        schema,
        tuples,
        ref('user', 'alice'),
        ref(fns, nodeIds[0]!),
        'view',
        { maxDepth: N },
      );
      const productionResult = await productionCheck(
        pool,
        ref('user', 'alice'),
        ref(fns, nodeIds[0]!),
        'view',
        { maxDepth: N },
      );

      expect(referenceResult.allowed).toBe(false);
      expect(productionResult.allowed).toBe(false);
      expect(productionResult.allowed).toBe(referenceResult.allowed);
    });
  });

  describe('a false_deny: the ceiling comparator itself (a node reached at depth exactly maxDepth must still be checked, not skipped)', () => {
    // Found independently while re-deriving depth costs for every
    // rewrite-rule kind per this fix's own verification step (not one of
    // the two originally reported bugs). `resolve()` denied at
    // `depth >= ctx.maxDepth`; the reference resolver's `resolveMembership`
    // denies only at `depth > ctx.maxDepth` — a node reached at depth
    // exactly `maxDepth` must still execute (and can still resolve a direct
    // grant with zero further recursion) on both engines.
    //
    // This fixture is smaller and faster than the 25-level chain above, but
    // it is NOT isolated from the tupleToUserset double-counting bug fixed
    // in the previous `describe` block — confirmed directly, by
    // reintroducing only that bug (with this comparator fix still applied)
    // and observing this test fail too, since doubling the per-hop cost
    // exhausts even this small a budget well before the real ceiling.
    // What this fixture DOES do, confirmed the same way, is fail on its own
    // when *only* the comparator regresses (`>` reverted to `>=`) with the
    // other fix left in place — so it's still a genuine, independent
    // regression guard for the comparator specifically, just not a fixture
    // that cleanly attributes a failure to one bug over the other by
    // itself; that attribution came from the fail-check process (see
    // `docs/DECISIONS.md`), not from this fixture's own shape.
    function folderChainSource(fns: string): string {
      return [
        `namespace ${fns} {`,
        `  relation parent: ${fns}`,
        '  relation editor: user',
        '',
        '  permission view = editor | parent->view',
        '}',
      ].join('\n');
    }

    it('both-resolvers-allow-a-subject-reached-exactly-at-the-configured-ceiling-not-one-hop-short-of-it', async () => {
      const fns = uniqueName('folder');
      const schema = await setUpSchema(folderChainSource(fns));
      const M = 6;
      const nodeIds = Array.from({ length: M + 1 }, (_, i) => uniqueName(`n${i}`));
      const tuples: TupleKey[] = [];
      for (let i = 0; i < M; i++) {
        tuples.push(tuple(fns, nodeIds[i]!, 'parent', fns, nodeIds[i + 1]!));
      }
      tuples.push(tuple(fns, nodeIds[M]!, 'editor', 'user', 'alice'));
      for (const t of tuples) await writeOk(t);

      // nodeIds[1] is 5 parent-hops from the grant — exactly `maxDepth - 1`
      // at `maxDepth: 6` — the last point the reference resolver's `>`
      // comparator still allows.
      const referenceResult = referenceCheck(
        schema,
        tuples,
        ref('user', 'alice'),
        ref(fns, nodeIds[1]!),
        'view',
        { maxDepth: M },
      );
      const productionResult = await productionCheck(
        pool,
        ref('user', 'alice'),
        ref(fns, nodeIds[1]!),
        'view',
        { maxDepth: M },
      );

      expect(referenceResult.allowed).toBe(true);
      // Before this fix, production denied here even though the direct
      // editor grant needed zero further SQL recursion once reached — the
      // TS-level `resolve()` entry for the `editor` relation check was
      // rejected by the `>=` comparator alone, one hop earlier than the
      // reference resolver's own `>` comparator would deny.
      expect(productionResult.allowed).toBe(true);
      expect(productionResult.allowed).toBe(referenceResult.allowed);
    });

    it('both-resolvers-deny-a-subject-one-hop-farther-out-genuinely-past-the-ceiling', async () => {
      const fns = uniqueName('folder');
      const schema = await setUpSchema(folderChainSource(fns));
      const M = 6;
      const nodeIds = Array.from({ length: M + 1 }, (_, i) => uniqueName(`n${i}`));
      const tuples: TupleKey[] = [];
      for (let i = 0; i < M; i++) {
        tuples.push(tuple(fns, nodeIds[i]!, 'parent', fns, nodeIds[i + 1]!));
      }
      tuples.push(tuple(fns, nodeIds[M]!, 'editor', 'user', 'alice'));
      for (const t of tuples) await writeOk(t);

      const referenceResult = referenceCheck(
        schema,
        tuples,
        ref('user', 'alice'),
        ref(fns, nodeIds[0]!),
        'view',
        { maxDepth: M },
      );
      const productionResult = await productionCheck(
        pool,
        ref('user', 'alice'),
        ref(fns, nodeIds[0]!),
        'view',
        { maxDepth: M },
      );

      expect(referenceResult.allowed).toBe(false);
      expect(productionResult.allowed).toBe(false);
      expect(productionResult.allowed).toBe(referenceResult.allowed);
    });
  });

  describe('a combined chain mixing tuple-to-userset AND nested-group membership in the same fixture, at a small explicit ceiling — full-repo audit finding #10', () => {
    // The three describe blocks above (this file's own pre-existing
    // depth-budget-accounting-parity section, added for D-069) each
    // exercise ONE of the two mechanisms D-069's bugs lived in, never both
    // together in a single fixture: the first sub-block's fixture is a
    // computedUserset hop + nested-group `subject_relation` chain (no `->`
    // anywhere); the second and third sub-blocks' fixtures are pure
    // `parent->view` tuple-to-userset chains (no nested-group membership at
    // all). Full-repo audit finding #10: no fixture anywhere in this file
    // forces BOTH mechanisms to contribute to the SAME boundary at once —
    // a future regression that only manifested when a tuple-to-userset hop
    // was immediately followed by a nested-group SQL walk (rather than
    // either in isolation) could ship undetected the same way D-069's own
    // bugs did before this file grew a 3-level-deep-fixture ceiling.
    //
    // doc:d1 --parent->view--> folder:f1 (tuple-to-userset)
    //   folder:f1's `view = viewer`, viewer: user | grp#member
    //   folder:f1 --viewer--> grp:g0#member (nested-group membership starts)
    //     grp:g0 --member--> grp:g1#member
    //       grp:g1 --member--> user:alice (direct grant)
    //
    // The exact allow/deny boundary below (denied at `maxDepth: 3`, allowed
    // at `maxDepth: 4`) was confirmed empirically against this project's
    // own real local Postgres fixture, with BOTH resolvers, before being
    // trusted — this project's own established "verify by actually running
    // it" standard (`docs/DECISIONS.md` D-008/D-009/D-070) — rather than
    // hand-counted from the informal per-hop cost language in D-069's own
    // writeup, which is about a budget threshold, not a promise that every
    // possible mixed-mechanism fixture costs the same as a same-shaped
    // single-mechanism one.
    function combinedFixtureSource(gns: string, fns: string, dns: string): string {
      return [
        `namespace ${gns} {`,
        `  relation member: user | ${gns}#member`,
        '}',
        `namespace ${fns} {`,
        `  relation viewer: user | ${gns}#member`,
        '  permission view = viewer',
        '}',
        `namespace ${dns} {`,
        `  relation parent: ${fns}`,
        '  permission view = parent->view',
        '}',
      ].join('\n');
    }

    it('both-resolvers-deny-the-combined-tuple-to-userset-plus-nested-group-chain-at-maxDepth-3-one-hop-short-of-its-real-cost', async () => {
      const gns = uniqueName('grp');
      const fns = uniqueName('fld');
      const dns = uniqueName('doc');
      const schema = await setUpSchema(combinedFixtureSource(gns, fns, dns));
      const d1 = uniqueName('d1');
      const f1 = uniqueName('f1');
      const g0 = uniqueName('g0');
      const g1 = uniqueName('g1');

      const tuples: TupleKey[] = [
        tuple(dns, d1, 'parent', fns, f1),
        tuple(fns, f1, 'viewer', gns, g0, 'member'),
        tuple(gns, g0, 'member', gns, g1, 'member'),
        tuple(gns, g1, 'member', 'user', 'alice'),
      ];
      for (const t of tuples) await writeOk(t);

      const referenceResult = referenceCheck(
        schema,
        tuples,
        ref('user', 'alice'),
        ref(dns, d1),
        'view',
        { maxDepth: 3 },
      );
      const productionResult = await productionCheck(
        pool,
        ref('user', 'alice'),
        ref(dns, d1),
        'view',
        {
          maxDepth: 3,
        },
      );

      expect(referenceResult.allowed).toBe(false);
      expect(productionResult.allowed).toBe(false);
      expect(productionResult.allowed).toBe(referenceResult.allowed);
    });

    it('both-resolvers-allow-the-identical-combined-chain-once-maxDepth-is-raised-by-exactly-one-to-cover-its-real-cost', async () => {
      const gns = uniqueName('grp');
      const fns = uniqueName('fld');
      const dns = uniqueName('doc');
      const schema = await setUpSchema(combinedFixtureSource(gns, fns, dns));
      const d1 = uniqueName('d1');
      const f1 = uniqueName('f1');
      const g0 = uniqueName('g0');
      const g1 = uniqueName('g1');

      const tuples: TupleKey[] = [
        tuple(dns, d1, 'parent', fns, f1),
        tuple(fns, f1, 'viewer', gns, g0, 'member'),
        tuple(gns, g0, 'member', gns, g1, 'member'),
        tuple(gns, g1, 'member', 'user', 'alice'),
      ];
      for (const t of tuples) await writeOk(t);

      const referenceResult = referenceCheck(
        schema,
        tuples,
        ref('user', 'alice'),
        ref(dns, d1),
        'view',
        { maxDepth: 4 },
      );
      const productionResult = await productionCheck(
        pool,
        ref('user', 'alice'),
        ref(dns, d1),
        'view',
        {
          maxDepth: 4,
        },
      );

      expect(referenceResult.allowed).toBe(true);
      expect(productionResult.allowed).toBe(true);
      expect(productionResult.allowed).toBe(referenceResult.allowed);
    });

    it('both-resolvers-deny-a-subject-absent-from-the-combined-chain-entirely-a-plain-denial-control-not-just-a-depth-boundary-one', async () => {
      // Control distinct from the two boundary tests above: proves the
      // combined fixture's "allowed" result genuinely depends on alice's
      // real membership, not on the mixed-mechanism shape alone always
      // resolving true regardless of subject.
      const gns = uniqueName('grp');
      const fns = uniqueName('fld');
      const dns = uniqueName('doc');
      const schema = await setUpSchema(combinedFixtureSource(gns, fns, dns));
      const d1 = uniqueName('d1');
      const f1 = uniqueName('f1');
      const g0 = uniqueName('g0');
      const g1 = uniqueName('g1');

      const tuples: TupleKey[] = [
        tuple(dns, d1, 'parent', fns, f1),
        tuple(fns, f1, 'viewer', gns, g0, 'member'),
        tuple(gns, g0, 'member', gns, g1, 'member'),
        tuple(gns, g1, 'member', 'user', 'alice'),
      ];
      for (const t of tuples) await writeOk(t);

      const referenceResult = referenceCheck(
        schema,
        tuples,
        ref('user', 'henry'),
        ref(dns, d1),
        'view',
      );
      const productionResult = await productionCheck(
        pool,
        ref('user', 'henry'),
        ref(dns, d1),
        'view',
      );

      expect(referenceResult.allowed).toBe(false);
      expect(productionResult.allowed).toBe(false);
      expect(productionResult.allowed).toBe(referenceResult.allowed);
    });
  });
});
