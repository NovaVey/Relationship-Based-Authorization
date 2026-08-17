#!/usr/bin/env -S npx tsx
/**
 * `npm run benchmark` — real `performCheck` latency at controlled
 * permission-chain depths (1, 3, 5, 10 by default), against real Postgres.
 * Added so the README's own published numbers are reproducible by anyone
 * who clones this repo, not asserted from a one-off run nobody else can
 * check — the same discipline this project holds every soundness/
 * correctness claim to (see `docs/DECISIONS.md`), applied to a performance
 * claim instead.
 *
 * A `.ts` file run directly via `tsx` (`npm run seed:example`'s own
 * established pattern — see that file's own doc comment on why: no build
 * step required, "clone, install, benchmark" stays a short story), not a
 * plain `.mjs` importing from `dist/` the way `scripts/copy-migrations.mjs`/
 * `scripts/post-soundness-comment.mjs` do — those two run inside CI, after
 * `npm run build`, and have no reason to touch `src/` at all.
 *
 * Deliberately measures `performCheck` directly (the check engine's own
 * graph walk + its Postgres round trips), not an HTTP request against
 * `authz serve` — network transit time is a property of the caller's own
 * location relative to wherever this is deployed, not a property of this
 * system, so publishing it as *the* latency number would be misleading
 * about what it actually measures. This isolates the one thing that's
 * actually a property of the engine: how its own cost scales with
 * permission-chain depth.
 *
 * Builds a pure nested-group-membership chain (`permission view = viewer |
 * member->view`, mirroring `schema/example.authz`'s own real nesting
 * pattern) up to the deepest requested depth, times `performCheck` at each
 * requested depth (a warm-up call first, since the first real query on a
 * connection pays a real, one-time connection-setup cost that would
 * otherwise skew depth 1's own numbers), then deletes every *tuple* it
 * wrote before exiting.
 *
 * Deliberately does NOT delete the benchmark namespace's own
 * `namespace_configs` row — `deletePublishedNamespaceVersion`
 * (`src/schema/publish.ts`) exists for exactly one sanctioned caller
 * (`src/soundness/runner.ts`'s dry-run cleanup, enforced by an ESLint
 * `no-restricted-imports` rule, see that function's own doc comment) for a
 * real reason: every other piece of this system treats a published
 * namespace version as permanent, append-only history, never synthetic
 * fixture data to be erased. A benchmark run's schema is real, if
 * inconsequential, published history — same as `scripts/seed-example.ts`'s
 * own demo schema, which is likewise never deleted. Each run publishes a
 * uniquely-timestamped namespace name specifically so repeat runs never
 * collide.
 */
import { Pool } from 'pg';

import { writeTuple, deleteTuple, type TupleKey } from '../src/store/tuples.js';
import { publishSchema } from '../src/schema/publish.js';
import { performCheck } from '../src/audit/checks.js';
import { env } from '../src/config/env.js';

const DEPTHS = [1, 3, 5, 10] as const;
const RUNS_PER_DEPTH = 50;

function percentile(sortedTimes: number[], p: number): number {
  return sortedTimes[Math.min(sortedTimes.length - 1, Math.floor(sortedTimes.length * p))]!;
}

async function main(): Promise<void> {
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const ns = `benchmark_${Date.now().toString(36)}`;
  const maxDepth = Math.max(...DEPTHS);
  const writtenTuples: TupleKey[] = [];

  try {
    const source = [
      `namespace ${ns} {`,
      '  relation viewer: user',
      `  relation member: ${ns}#member`,
      '  permission view = viewer | member->view',
      '}',
    ].join('\n');
    const published = await publishSchema(pool, source);
    if (!published.ok) {
      throw new Error(`benchmark schema failed to publish: ${published.errors.join('; ')}`);
    }

    // node_0 --member--> node_1 --member--> ... --member--> node_maxDepth,
    // node_0 has the only real (direct) grant. Checking node_D#view walks
    // exactly D `member` hops before reaching it.
    for (let i = 1; i <= maxDepth; i++) {
      const tuple: TupleKey = {
        objectNs: ns,
        objectId: `node_${i}`,
        relation: 'member',
        subjectNs: ns,
        subjectId: `node_${i - 1}`,
        subjectRelation: 'member',
      };
      const result = await writeTuple(pool, tuple);
      if (!result.ok) {
        throw new Error(`chain tuple write failed at depth ${i}: ${JSON.stringify(result.errors)}`);
      }
      writtenTuples.push(tuple);
    }
    const baseTuple: TupleKey = {
      objectNs: ns,
      objectId: 'node_0',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    };
    const baseResult = await writeTuple(pool, baseTuple);
    if (!baseResult.ok)
      throw new Error(`base grant write failed: ${JSON.stringify(baseResult.errors)}`);
    writtenTuples.push(baseTuple);

    console.log(
      `performCheck latency by permission-chain depth (${RUNS_PER_DEPTH} runs/depth, real Postgres):\n`,
    );

    // Warm-up: absorb the connection-pool's own one-time setup cost before
    // depth 1's numbers are recorded, so it isn't mistaken for the engine's
    // own cost.
    await performCheck(pool, { ns: 'user', id: 'alice' }, { ns, id: 'node_1' }, 'view');

    const rows: Array<{ depth: number; p50: number; p95: number; min: number; max: number }> = [];
    for (const depth of DEPTHS) {
      const times: number[] = [];
      for (let run = 0; run < RUNS_PER_DEPTH; run++) {
        const start = performance.now();
        const result = await performCheck(
          pool,
          { ns: 'user', id: 'alice' },
          { ns, id: `node_${depth}` },
          'view',
        );
        const elapsedMs = performance.now() - start;
        if (!result.allowed)
          throw new Error(`benchmark check unexpectedly denied at depth ${depth}`);
        times.push(elapsedMs);
      }
      times.sort((a, b) => a - b);
      const row = {
        depth,
        p50: percentile(times, 0.5),
        p95: percentile(times, 0.95),
        min: times[0]!,
        max: times[times.length - 1]!,
      };
      rows.push(row);
      console.log(
        `depth ${String(depth).padStart(2)}: p50=${row.p50.toFixed(2)}ms  p95=${row.p95.toFixed(2)}ms  ` +
          `min=${row.min.toFixed(2)}ms  max=${row.max.toFixed(2)}ms`,
      );
    }

    console.log('\nMarkdown table:\n');
    console.log('| Depth | p50 | p95 |');
    console.log('|---|---|---|');
    for (const row of rows) {
      console.log(`| ${row.depth} | ${row.p50.toFixed(1)}ms | ${row.p95.toFixed(1)}ms |`);
    }
  } finally {
    // Best-effort tuple cleanup — never left half-done, and never allowed
    // to replace/mask a real error above with a cleanup failure instead.
    // The namespace's own published version is deliberately left in place
    // (see this file's own top-of-file doc comment).
    const errors: unknown[] = [];
    for (const tuple of writtenTuples) {
      try {
        await deleteTuple(pool, tuple);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      console.error(
        `benchmark cleanup: ${errors.length} tuple deletion(s) failed for namespace '${ns}'`,
      );
    }
    await pool.end();
  }
}

await main();
