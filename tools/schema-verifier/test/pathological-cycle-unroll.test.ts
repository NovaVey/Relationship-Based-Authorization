/**
 * §8c's hardest pathological fixture: "a schema where the leak requires
 * unrolling a cycle exactly once." `cycle-unroll-once.authz`'s own
 * `view = grant | (next->view - block_next)`, with a genuine mutual
 * `next` cycle (`node1.next = node2`, `node2.next = node1`).
 *
 * Explored and rejected first: framing this as a `boundedSearch` k = 1
 * vs. k = 2 split (matching D-118's own "bound must reach 2" framing for
 * the exclusion fixture). It doesn't apply here — `boundedSearch` tries
 * every subset of every type-valid candidate, and a direct, unconditional
 * `grant(o) = s` candidate is always type-valid and always wins
 * immediately, at any k, regardless of the cycle. Bounded search's own
 * `k` bounds *instance count per type*, not path depth or cycle
 * traversal, so it was never the right tool to demonstrate a genuinely
 * cyclic property with — full account in `docs/DECISIONS.md`.
 *
 * What actually demonstrates it: the real production engine's own
 * cycle-guard, directly. `node1` and `node2` reference each other
 * (`next`); `node1.grant = alice` (direct); `node2.block_next = alice`
 * (protects what `node2` passes along from its own `next`, never its own
 * direct grant — the schema's own local-scoping design). Computing
 * `node2.view(alice)` requires the resolver to follow `node2.next`
 * (`node1`), evaluate `node1.view(alice)` — which in turn needs
 * `node1.next->view` (`node2.view` again!) — and *that* second lookback
 * is exactly where the resolver's own cycle guard fires
 * (`entityNameKey`-based, `src/resolve/production/resolver.ts`).
 * `node1.view(alice)` therefore resolves, as seen from *inside* the
 * `node2` computation, to just its own direct grant (the cycle-denied
 * recursive part contributes nothing) — alice — which `node2`'s own
 * `block_next` then correctly excludes. The real engine's own reported
 * `depth: 2` is the empirical proof the cycle was actually traversed
 * once, not skipped.
 *
 * This exercises exactly the same DST-fake-store + `productionCheck`
 * seam `replayWitness`/`boundedSearch` already use in production
 * (`createFakeStoreState`/`createFakeConnectionSource`/`writeTuple`,
 * `src/store/dst/`) — this file calls it directly rather than through
 * `checkAndValidate`, since the property under test is about the real
 * engine's own cycle-unrolling behavior, not about this tool's own
 * static search or bounded search.
 */
import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { productionCheck } from '../../../src/resolve/production/resolver.js';
import {
  createFakeConnectionSource,
  createFakeStoreState,
  seedNamespaceConfig,
} from '../../../src/store/dst/index.js';
import { writeTuple } from '../../../src/store/tuples.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/schemas/', import.meta.url));

describe('§8c — a leak that requires unrolling a real cycle exactly once, against the real engine directly', () => {
  it("node2's own block_next correctly excludes a subject that node1 (its mutual-cycle neighbor) directly grants — resolved by traversing the cycle once, not zero times", async () => {
    const source = readFileSync(SCHEMA_FIXTURE_DIR + 'cycle-unroll-once.authz', 'utf8');
    const compiled = compileSchema(source);
    if (!compiled.ok) throw new Error('cycle-unroll-once.authz failed to compile');
    const schema = compiled.schema;

    const state = createFakeStoreState();
    for (const ns of Object.values(schema.namespaces)) seedNamespaceConfig(state, ns);
    const dbSource = createFakeConnectionSource(state);

    const tuples = [
      {
        objectNs: 'node',
        objectId: 'node1',
        relation: 'next',
        subjectNs: 'node',
        subjectId: 'node2',
      },
      {
        objectNs: 'node',
        objectId: 'node2',
        relation: 'next',
        subjectNs: 'node',
        subjectId: 'node1',
      },
      {
        objectNs: 'node',
        objectId: 'node1',
        relation: 'grant',
        subjectNs: 'user',
        subjectId: 'alice',
      },
      {
        objectNs: 'node',
        objectId: 'node2',
        relation: 'block_next',
        subjectNs: 'user',
        subjectId: 'alice',
      },
    ];
    for (const t of tuples) {
      const write = await writeTuple(dbSource, t);
      if (!write.ok) throw new Error(`fixture tuple write failed: ${JSON.stringify(write.errors)}`);
    }

    const node1Result = await productionCheck(
      dbSource,
      { ns: 'user', id: 'alice' },
      { ns: 'node', id: 'node1' },
      'view',
    );
    const node2Result = await productionCheck(
      dbSource,
      { ns: 'user', id: 'alice' },
      { ns: 'node', id: 'node2' },
      'view',
    );

    // node1 grants alice directly — unaffected by node2's own block_next,
    // which only ever applies to what node2 itself passes along.
    expect(node1Result.allowed).toBe(true);
    expect(node1Result.depth).toBe(1);

    // node2 correctly excludes alice — but only by actually resolving
    // node1.view as a sub-question (depth 2), which in turn tries to
    // recurse back into node2.view a second time and is denied by the
    // resolver's own cycle guard. depth > 1 is the direct evidence the
    // cycle was traversed once, not short-circuited or skipped.
    expect(node2Result.allowed).toBe(false);
    expect(node2Result.depth).toBeGreaterThan(1);
  });
});
