/**
 * The residual D-158 risk, confirmed real and fixed: mechanism 2
 * (`sqlRelationMembershipWithWitness` in `src/resolve/production/
 * resolver.ts`) is reachable from an exclusion's own `subtract` branch
 * whenever `subtract` is a plain `computedUserset` naming a declared
 * *relation* (not a permission) — `evalRewrite`'s `computedUserset` case
 * calls `resolve()`, which hands the whole remaining question to
 * `sqlRelationMembershipWithWitness` the moment `config.relations[name]`
 * exists. D-158 fixed the identical algebraic shape for mechanism 1 (the
 * TS-level `resolve`/`evalRewrite` walk's own cycle guard and depth
 * ceiling) but explicitly disclosed mechanism 2's own depth ceiling as a
 * distinct, not-yet-confirmed-or-fixed risk sharing the same shape — this
 * file is the confirmation and the fix's own regression coverage.
 *
 * **The concrete bug, confirmed live before this fix existed (not just
 * derived):** `permission view = grant - blocked`, where `blocked` is a
 * plain relation whose own userset-membership chain (`group#member`
 * nesting) is real and tuple-reachable, but deeper than the *effective*
 * depth budget `sqlRelationMembershipWithWitness`'s own recursive CTE gets
 * for that specific call (`ctx.maxDepth - depth`, same accounting D-069
 * already established). At `maxDepth: 3` in the fixture below, the SQL
 * frontier scan for `blocked` truncates one hop short of the group node
 * carrying the real `user:alice` grant — `alice` genuinely IS blocked, but
 * the truncated scan never reads that tuple, and (before this fix)
 * unconditionally reported its own `false` as `certain: true`. Consumed
 * inside `evalRewrite`'s `exclusion` case, that `certain: true` "no path
 * found" was wrongly treated as "subtract exhaustively disproven" —
 * `view = grant - blocked` resolved `allowed: true`, a real `false_grant`:
 * production granted access to a subject the reference resolver (given the
 * identical `maxDepth`, and already carrying the D-158 fix for its own,
 * structurally different mechanism) correctly denies, fail-closed, because
 * it cannot prove `blocked` false within budget either.
 *
 * The fix: `sqlRelationMembershipWithWitness`'s own `false` outcome now
 * carries a real `certain` signal (`depthCeilingGenuinelyBinding`), true
 * only when the frontier scan's own `depth < maxDepth` ceiling actually cut
 * off a real, unread edge — not merely "the ceiling number was reached."
 * See that function's own doc comment in `resolver.ts` for the full
 * reasoning.
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
  pool.on('error', (err) => {
    // pg's own documented contract — see this repo's every other
    // integration test's identical note.
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

let uniqueCounter = 0;
const processSalt = Math.random().toString(36).slice(2, 10);
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

function compileOk(source: string): CompiledSchema {
  const result = compileSchema(source);
  if (!result.ok) {
    throw new Error(
      `expected schema to compile, got errors:\n${result.errors.map(formatSchemaError).join('\n')}`,
    );
  }
  return result.schema;
}

async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(pool, source);
  if (!result.ok) {
    throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
  }
}

async function writeOk(t: TupleKey): Promise<void> {
  const result = await writeTuple(pool, t);
  if (!result.ok) {
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
  }
}

async function setUpSchema(source: string): Promise<CompiledSchema> {
  const schema = compileOk(source);
  await publishOk(source);
  return schema;
}

describe('an exclusion whose subtract branch is a plain relation with a real userset-membership chain deeper than the effective depth budget', () => {
  /**
   * `groupNs#member` nests `user | groupNs#member` — a plain relation, never
   * a permission, so `blocked` (also a plain relation) routes straight into
   * mechanism 2 the moment `evalRewrite`'s `computedUserset` case resolves
   * it. `docNs#view = grant - blocked` is the exclusion whose `subtract` is
   * exactly that relation.
   */
  function fixtureSource(groupNs: string, docNs: string): string {
    return [
      `namespace ${groupNs} {`,
      `  relation member: user | ${groupNs}#member`,
      '}',
      '',
      `namespace ${docNs} {`,
      '  relation grant: user',
      `  relation blocked: user | ${groupNs}#member`,
      '  permission view = grant - blocked',
      '}',
    ].join('\n');
  }

  /**
   * Builds the fixture's own tuple graph: `alice` has a direct `grant`, and
   * is ALSO a real, transitive member of `blocked` via a 3-hop group chain
   * (`doc:d#blocked@group:g0#member`, `g0->g1`, `g1->g2`, and a plain grant
   * to `alice` on `g2`). `g2` sits at production frontier depth 3 from
   * `doc:d`'s own `blocked` relation (depth 0), so `alice`'s real grant is
   * only found once `sqlRelationMembershipWithWitness`'s own remaining
   * budget (`ctx.maxDepth - 1`, since `view`'s exclusion combinator forwards
   * `depth` unchanged and `resolve()`'s `computedUserset` leaf spends
   * exactly one level entering `blocked`) reaches at least 3 — i.e.
   * `maxDepth >= 4`.
   */
  async function buildGraph(
    groupNs: string,
    docNs: string,
    docId: string,
  ): Promise<{ schema: CompiledSchema; tuples: TupleKey[] }> {
    const schema = await setUpSchema(fixtureSource(groupNs, docNs));
    const tuples: TupleKey[] = [
      tuple(docNs, docId, 'grant', 'user', 'alice'),
      tuple(docNs, docId, 'blocked', groupNs, 'g0', 'member'),
      tuple(groupNs, 'g0', 'member', groupNs, 'g1', 'member'),
      tuple(groupNs, 'g1', 'member', groupNs, 'g2', 'member'),
      tuple(groupNs, 'g2', 'member', 'user', 'alice'),
    ];
    for (const t of tuples) await writeOk(t);
    return { schema, tuples };
  }

  it('both-resolvers-deny-at-a-generous-max-depth-confirming-alice-is-genuinely-blocked-not-a-phantom-chain', async () => {
    const groupNs = uniqueName('grp');
    const docNs = uniqueName('doc');
    const docId = uniqueName('d');
    const { schema, tuples } = await buildGraph(groupNs, docNs, docId);

    const referenceResult = referenceCheck(
      schema,
      tuples,
      ref('user', 'alice'),
      ref(docNs, docId),
      'view',
      {
        maxDepth: 1000,
      },
    );
    const productionResult = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(docNs, docId),
      'view',
      {
        maxDepth: 1000,
      },
    );

    // Hand-derived: alice has `grant` (base true) AND is a real transitive
    // member of `blocked` via g0->g1->g2 (subtract true) — the exclusion
    // must deny. Both resolvers have ample budget here, so this is a real,
    // findable chain, not a phantom the depth ceiling coincidentally hides.
    expect(referenceResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(false);
  });

  it('production-no-longer-false-grants-when-mechanism-2s-depth-ceiling-truncates-inside-an-exclusions-subtract-branch — the exact D-158-residual reproduction', async () => {
    const groupNs = uniqueName('grp');
    const docNs = uniqueName('doc');
    const docId = uniqueName('d');
    const { schema, tuples } = await buildGraph(groupNs, docNs, docId);

    // Pinned to both resolvers identically (matching D-071's own established
    // discipline) — remainingDepth for `blocked` is `maxDepth - 1 = 2`,
    // strictly less than the 3 hops needed to reach g2's real grant to
    // alice. Before this fix: production wrongly reported the truncated
    // scan's own `false` as `certain: true`, so `evalRewrite`'s `exclusion`
    // case treated it as an exhaustive disproof of `blocked` and granted
    // `view` — a real false_grant, confirmed live against this exact
    // fixture and this exact `maxDepth` before this fix existed.
    const MAX_DEPTH = 3;
    const referenceResult = referenceCheck(
      schema,
      tuples,
      ref('user', 'alice'),
      ref(docNs, docId),
      'view',
      { maxDepth: MAX_DEPTH },
    );
    const productionResult = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(docNs, docId),
      'view',
      {
        maxDepth: MAX_DEPTH,
      },
    );

    // Reference denies fail-closed (it cannot prove `blocked` false within
    // budget either — `subtractUnprovable`, not `subtractProven`).
    expect(referenceResult.allowed).toBe(false);
    // The actual soundness assertion: production must ALSO deny — not grant
    // on the strength of an uncertain, depth-truncated "no."
    expect(productionResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(referenceResult.allowed);
  });

  it('production-correctly-proves-the-exclusion-once-the-budget-covers-the-real-3-hop-chain', async () => {
    const groupNs = uniqueName('grp');
    const docNs = uniqueName('doc');
    const docId = uniqueName('d');
    const { schema, tuples } = await buildGraph(groupNs, docNs, docId);

    // remainingDepth for `blocked` = maxDepth - 1 = 3, exactly enough to
    // reach g2 (frontier depth 3) and find alice's real grant there — a
    // genuine, certain proof of `blocked`, not merely "budget exhausted."
    const MAX_DEPTH = 4;
    const referenceResult = referenceCheck(
      schema,
      tuples,
      ref('user', 'alice'),
      ref(docNs, docId),
      'view',
      { maxDepth: MAX_DEPTH },
    );
    const productionResult = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(docNs, docId),
      'view',
      {
        maxDepth: MAX_DEPTH,
      },
    );

    expect(referenceResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(false);
    // The frontier scan itself must have actually reached g2 (depth 3), not
    // merely have run out of budget one hop earlier — confirms this case is
    // a genuine proof, distinguishing it from the truncated case above.
    expect(productionResult.depth).toBe(3);
  });

  it('production-denies-well-short-of-the-real-chain-too-not-just-exactly-one-hop-short', async () => {
    const groupNs = uniqueName('grp');
    const docNs = uniqueName('doc');
    const docId = uniqueName('d');
    const { schema, tuples } = await buildGraph(groupNs, docNs, docId);

    const MAX_DEPTH = 2;
    const referenceResult = referenceCheck(
      schema,
      tuples,
      ref('user', 'alice'),
      ref(docNs, docId),
      'view',
      { maxDepth: MAX_DEPTH },
    );
    const productionResult = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(docNs, docId),
      'view',
      {
        maxDepth: MAX_DEPTH,
      },
    );

    expect(referenceResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(false);
    expect(productionResult.allowed).toBe(referenceResult.allowed);
  });
});
