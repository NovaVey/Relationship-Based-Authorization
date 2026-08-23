/**
 * §8c's pathological fixture: "a schema where the only path exceeds the
 * depth limit." `depth-exceeds-limit.authz` is a chain of 30 distinct
 * namespaces (`level0` through `level29`), each deferring `view` to the
 * next via a real `tupleToUserset` hop — only `level29` has a direct
 * `viewer` grant, so the minimum witness is 30 tuples deep (29 `next`
 * hops plus the final `viewer` grant).
 *
 * This tool's own search (§5) has no depth cap at all — a plain
 * exhaustive walk, cycle-safety only (§1: "cycles are legal... track
 * visited (type, relation) pairs") — so it finds this witness easily and
 * reports `VIOLATED`. The real production engine, by contrast,
 * genuinely does enforce a depth budget: `CHECK_MAX_DEPTH`
 * (`src/config/env.ts`, default 25) caps how many rewrite-rule hops
 * `resolve()` will follow before refusing and denying
 * (`src/resolve/production/resolver.ts`). A 30-hop witness exceeds that
 * budget.
 *
 * The result is a genuine, confirmed disagreement between the static
 * claim and the runtime engine — not a bug in either one, a real
 * consequence of the static verifier reasoning about the schema's
 * *type-level* structure with no awareness of a *runtime resource
 * limit* the real engine imposes for its own operational reasons. This
 * is exactly the class of gap §6 self-validation exists to catch: the
 * search's own `VIOLATED` claim is confirmed, tuple by tuple, against
 * the real engine before it's ever reported — and here, that
 * confirmation correctly fails, loudly, as `mismatch`, rather than the
 * tool ever claiming a counterexample nobody could actually reproduce
 * against a real deployment running with the real engine's real limits.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import { parseInvariants } from '../src/invariants/index.js';
import { checkAndValidate } from '../src/validate/index.js';

const SCHEMA_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/schemas/', import.meta.url));
const INVARIANT_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/invariants/', import.meta.url));

describe('§8c — the depth limit pathological fixture: a real static/runtime disagreement, correctly caught by self-validation', () => {
  it('the static search finds a real 30-hop witness — unbounded, no depth cap of its own', async () => {
    const source = readFileSync(SCHEMA_FIXTURE_DIR + 'depth-exceeds-limit.authz', 'utf8');
    const compiled = compileSchema(source);
    if (!compiled.ok) throw new Error('depth-exceeds-limit.authz failed to compile');
    const graph = buildSchemaGraph(compiled.schema);
    // `deep-chain-view.invariant`: a real fixture file (§9's own CLI test
    // loads this exact file too), not an inline string — was inline here
    // until §9 needed a real `.invariant` file on disk to exercise the CLI
    // end-to-end against a genuine `mismatch` outcome; promoted to a shared
    // fixture rather than duplicated, so the two can't silently drift apart.
    const invariant = parseInvariants(
      readFileSync(INVARIANT_FIXTURE_DIR + 'deep-chain-view.invariant', 'utf8'),
    );
    if (!invariant.ok) throw new Error('deep-chain-view.invariant failed to parse');

    const { result, validation } = await checkAndValidate(
      graph,
      compiled.schema,
      invariant.invariants[0]!,
    );

    // The static claim: a real witness, unbounded by any depth cap.
    expect(result.verdict).toBe('VIOLATED');
    expect(result.fragment).toBe('monotone');
    expect(result.witness).toHaveLength(30);

    // Self-validation catches the runtime disagreement instead of
    // reporting a confident VIOLATED nobody could actually reproduce: the
    // real engine's CHECK_MAX_DEPTH (default 25, src/config/env.ts) cuts
    // this witness's own resolution off, so the real engine denies it.
    expect(validation.kind).toBe('mismatch');
    if (validation.kind !== 'mismatch') throw new Error('unreachable');
    expect(validation.reason).toContain('real engine denied');
    expect(validation.engineResult?.allowed).toBe(false);
    // depthReached (src/resolve/production/resolver.ts) confirms *why*:
    // the walk actually ran into the real depth ceiling, not some other
    // unrelated denial.
    expect(validation.engineResult?.depth).toBeGreaterThan(25);
  });
});
