/**
 * DST D3's own required proof (`docs/DST-PROPOSAL.md`'s phased plan,
 * `docs/DECISIONS.md` D-100): `fetchReachableFrontierVia`
 * (`src/store/dst/frontier.ts`) is not trusted because it looks right — it
 * is proven the same way this project already proved the SQL it's
 * replacing (D-092's own `DISTINCT ON` fix, verified against 3,000 random
 * graphs before it shipped). This file generates a large, deterministic
 * batch of random userset-subject-edge graphs (reusing `src/soundness/
 * generators.ts`'s own seeded `fast-check`/`pure-rand` machinery —
 * `SeededRng`/`hashSeedToInt31`, exported from that file for exactly this
 * reuse — never a new PRNG), runs the *real* `fetchReachableFrontier`
 * (`src/resolve/production/resolver.ts`, exported for exactly this
 * purpose — see that export's own doc comment) against a real Postgres
 * testcontainer and the in-memory `fetchReachableFrontierVia` against an
 * identical fixture, and compares the *set* of reached identities and the
 * *minimum* depth at which each identity is first reached — never raw
 * per-row paths, and, importantly, never the raw/undeduped maximum depth
 * either. D-092's own reachability argument (restated in `frontier.ts`'s
 * own doc comment) establishes only that a differing per-iteration
 * `DISTINCT ON` tie-break can never change the reached-identity *set* or
 * each identity's own *minimum* depth. It does NOT establish that the raw,
 * undeduped maximum depth is invariant — an earlier draft of this suite
 * compared that quantity directly and was caught, before ever running
 * against a real database, by this phase's own adversarial review: see
 * `docs/DECISIONS.md` D-100 for the concrete counterexample (a
 * reconvergent node whose dedup winner determines whether its own cycle
 * guard blocks a later back-edge, which changes how many rounds of
 * legitimate re-discovery fire). Plus a direct replay of D-092's own
 * hardest known case, the 12-level branching-3 reconvergent-diamond chain
 * — a strictly layered DAG with no back-edges, where no such divergence is
 * possible, so its own raw max-depth comparison is safe.
 *
 * Runs against a real, ephemeral Postgres container, same convention as
 * every other `*.integration.test.ts` file in this directory.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { integer, sample } from 'fast-check';

import { runMigrations } from '../../../../src/store/migrate.js';
import {
  fetchReachableFrontier,
  dedupeFrontier,
  type FrontierRow,
} from '../../../../src/resolve/production/resolver.js';
import { createFakeStoreState } from '../../../../src/store/dst/state.js';
import { fetchReachableFrontierVia } from '../../../../src/store/dst/frontier.js';
import { SeededRng, hashSeedToInt31 } from '../../../../src/soundness/generators.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on('error', (err) => {
    // pg's own documented contract — see every other *.integration.test.ts
    // file in this repo's own identical comment (docs/DECISIONS.md D-096).
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

// ---------------------------------------------------------------------------
// Random userset-subject-edge graph generation — reusing generators.ts's own
// seeded fast-check/pure-rand machinery, sized for this generator's own
// needs (this file's own draw pool, not the fixture generator's).
// ---------------------------------------------------------------------------

interface GraphEdge {
  fromId: string;
  toId: string;
}

interface GeneratedGraph {
  nodeIds: string[];
  edges: GraphEdge[];
  rootId: string;
  maxDepth: number;
}

const MIN_NODES = 6;
const MAX_NODES = 25;
const MAX_OUT_DEGREE = 5;
/** Generous headroom: worst case draws one int for nodeCount, one for maxDepth, plus (out-degree draw + full shuffle draws) per node at MAX_NODES. */
const DRAW_POOL_SIZE = 4_000;

function buildRng(seed: string): SeededRng {
  const numericSeed = hashSeedToInt31(seed);
  const pool = sample(integer({ min: 0, max: 0x7fffffff }), {
    seed: numericSeed,
    numRuns: DRAW_POOL_SIZE,
  });
  return new SeededRng(pool);
}

/**
 * A random directed graph over `nodeCount` abstract nodes (6–25, out-degree
 * 0–5) — deliberately allows self-loops, cycles, and reconvergence (many
 * nodes pointing at the same target), matching D-092's own precedent for
 * what this equivalence suite needs to stress. `nodeIds` are process-unique
 * (`uniqueName`) so two different seeds' graphs, and two different runs of
 * this same file, never collide inside the shared `relation_tuples` table.
 */
function generateRandomGraph(seed: string): GeneratedGraph {
  const rng = buildRng(seed);
  const nodeCount = rng.nextIntBetween(MIN_NODES, MAX_NODES);
  const nodeIds = Array.from({ length: nodeCount }, () => uniqueName('n'));
  const edges: GraphEdge[] = [];
  for (const fromId of nodeIds) {
    const outDegree = rng.nextIntBetween(0, MAX_OUT_DEGREE);
    const targets = rng.shuffle(nodeIds).slice(0, outDegree);
    for (const toId of targets) edges.push({ fromId, toId });
  }
  const rootId = nodeIds[0];
  if (rootId === undefined) throw new Error('unreachable: nodeCount >= MIN_NODES > 0');
  // 0–12: exercises the depth-cap boundary itself (including 0, the exact
  // boundary D2's own review found a real bug at, D-099) as often as it
  // exercises "generous enough to reach everything reachable."
  const maxDepth = rng.nextIntBetween(0, 12);
  return { nodeIds, edges, rootId, maxDepth };
}

/** One real Postgres round trip per graph — a single set-returning `unnest` insert, not one row at a time. */
async function insertGraphEdges(
  ns: string,
  relation: string,
  edges: readonly GraphEdge[],
): Promise<void> {
  if (edges.length === 0) return;
  const fromIds = edges.map((e) => e.fromId);
  const toIds = edges.map((e) => e.toId);
  await pool.query(
    `insert into relation_tuples (object_ns, object_id, relation, subject_ns, subject_id, subject_relation)
     select $1, e.f, $2, $1, e.t, $2
     from unnest($3::text[], $4::text[]) as e(f, t)
     on conflict (object_ns, object_id, relation, subject_ns, subject_id, coalesce(subject_relation, ''))
     do nothing`,
    [ns, relation, fromIds, toIds],
  );
}

function seedFakeGraph(
  state: ReturnType<typeof createFakeStoreState>,
  ns: string,
  relation: string,
  edges: readonly GraphEdge[],
): void {
  let nextId = 1;
  for (const edge of edges) {
    state.relationTuples.push({
      id: String(nextId++),
      objectNs: ns,
      objectId: edge.fromId,
      relation,
      subjectNs: ns,
      subjectId: edge.toId,
      subjectRelation: relation,
      createdAt: new Date(0),
      commitSeq: 1,
      expiresAt: null, // D-144 — this differential suite doesn't test expiry
    });
  }
}

function identitySet(rows: ReadonlyMap<string, FrontierRow>): Set<string> {
  return new Set(rows.keys());
}

/**
 * The max depth reached, computed over the DEDUPED (min-depth-per-identity)
 * rows — never the raw, undeduped row list. The raw maximum is NOT
 * invariant under `DISTINCT ON`'s unspecified tie-break (see this file's
 * own top-of-file doc comment and `docs/DECISIONS.md` D-100 for the
 * concrete counterexample this fixes); the deduped, per-identity *minimum*
 * depth is what `dedupeFrontier` already establishes as invariant, so its
 * own max is the only max-depth quantity safe to compare across two
 * independent implementations.
 */
function maxDepthReached(rows: ReadonlyMap<string, { depth: number }>): number {
  let max = 0;
  for (const row of rows.values()) max = Math.max(max, row.depth);
  return max;
}

// ---------------------------------------------------------------------------
// The equivalence sweep.
// ---------------------------------------------------------------------------

/**
 * 300 random graphs — proportionate to an ordinary "every PR" CI job (this
 * suite has no nightly/PR-tiered split yet; that's D5's own job per
 * `docs/DST-PROPOSAL.md`'s phased plan), not D-092's own 3,000-graph
 * throwaway-script figure, which verified a narrower, one-time question
 * (does `DISTINCT ON` ever silently drop real reachability) rather than
 * this suite's own broader, permanently-committed equivalence claim across
 * every combination this generator can produce. See `docs/DECISIONS.md`
 * D-100 for the full reasoning on this count.
 */
const GRAPH_COUNT = 300;

describe('fetchReachableFrontierVia matches the real fetchReachableFrontier — a seeded differential sweep (D-100)', () => {
  it(`${GRAPH_COUNT} random graphs each produce the identical reached-identity set and max depth on both sides`, async () => {
    const runSalt = uniqueName('sweep');
    for (let i = 0; i < GRAPH_COUNT; i += 1) {
      const seed = `${runSalt}-${i}`;
      const graph = generateRandomGraph(seed);
      const ns = uniqueName('grp');
      const relation = 'member';

      await insertGraphEdges(ns, relation, graph.edges);
      const realRows = await fetchReachableFrontier(
        pool,
        { ns, id: graph.rootId },
        relation,
        graph.maxDepth,
      );

      const state = createFakeStoreState();
      seedFakeGraph(state, ns, relation, graph.edges);
      const fakeRows = fetchReachableFrontierVia(
        state,
        ns,
        graph.rootId,
        relation,
        graph.maxDepth,
        undefined,
      );

      const realDeduped = dedupeFrontier(realRows);
      const fakeDeduped = dedupeFrontier(fakeRows);
      const realIdentities = identitySet(realDeduped);
      const fakeIdentities = identitySet(fakeDeduped);

      expect(
        fakeIdentities,
        `seed ${seed} (maxDepth ${graph.maxDepth}, ${graph.nodeIds.length} nodes, ${graph.edges.length} edges): reached-identity set mismatch`,
      ).toEqual(realIdentities);
      // Compared over the DEDUPED (min-depth-per-identity) rows, never the
      // raw ones — see maxDepthReached's own doc comment for why.
      expect(maxDepthReached(fakeDeduped), `seed ${seed}: max depth reached mismatch`).toBe(
        maxDepthReached(realDeduped),
      );
    }
  }, 120_000); // Real Postgres round trips, 300 of them — generous but not unbounded.
});

describe("D-092's own hardest known case, replayed directly: the 12-level branching-3 reconvergent-diamond chain (D-100)", () => {
  it('both the real query and the in-memory BFS reach exactly 1+36 nodes, in well under a second, matching each other', async () => {
    const ns = uniqueName('diamond');
    const relation = 'member';
    const LEVELS = 12;
    const BRANCHING = 3;
    const rootId = uniqueName('root');
    let previousLevelIds = [rootId];
    const edges: GraphEdge[] = [];
    for (let level = 1; level <= LEVELS; level += 1) {
      const thisLevelIds = Array.from({ length: BRANCHING }, () => uniqueName(`L${level}`));
      for (const fromId of previousLevelIds) {
        for (const toId of thisLevelIds) {
          edges.push({ fromId, toId });
        }
      }
      previousLevelIds = thisLevelIds;
    }

    await insertGraphEdges(ns, relation, edges);

    const startedAt = Date.now();
    const realRows = await fetchReachableFrontier(pool, { ns, id: rootId }, relation, 25);
    const realElapsedMs = Date.now() - startedAt;

    const state = createFakeStoreState();
    seedFakeGraph(state, ns, relation, edges);
    const fakeRows = fetchReachableFrontierVia(state, ns, rootId, relation, 25, undefined);

    // The exponential-blowup regression D-092 itself found and fixed: an
    // unfixed query never returned within a 20-second timeout for this
    // exact shape. 5 seconds is a generous, still-meaningful upper bound
    // confirming the real DISTINCT ON fix is still in effect today.
    expect(realElapsedMs).toBeLessThan(5_000);

    expect(realRows).toHaveLength(1 + LEVELS * BRANCHING);
    expect(fakeRows).toHaveLength(1 + LEVELS * BRANCHING);
    const realDeduped = dedupeFrontier(realRows);
    const fakeDeduped = dedupeFrontier(fakeRows);
    expect(identitySet(fakeDeduped)).toEqual(identitySet(realDeduped));
    // Safe to compare raw or deduped here — this graph is a strictly
    // layered DAG with no back-edges, so no tie-break-dependent
    // re-discovery divergence is possible either way (see this file's own
    // top-of-file doc comment). Deduped for consistency with the sweep
    // above regardless.
    expect(maxDepthReached(fakeDeduped)).toBe(LEVELS);
    expect(maxDepthReached(realDeduped)).toBe(LEVELS);
  }, 30_000);
});
