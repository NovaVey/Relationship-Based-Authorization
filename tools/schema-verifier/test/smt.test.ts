/**
 * The new SMT tier (`../src/smt/`, `docs/DECISIONS.md`) — DB-free unit
 * tests for the encoder itself, against the same small, hand-built,
 * non-recursive intersection/exclusion schema `test/bounded.test.ts`
 * already trusts (`fixtures/schemas/non-monotone.authz`) rather than a
 * new one: a known `HOLDS` case and a known `VIOLATED` case, confirming
 * the exact verdict and, for `VIOLATED`, that a real witness was
 * produced and independently confirmed through the real engine — not
 * just that z3 itself said `sat`. "DB-free" matches this whole tool's
 * own convention throughout: `replayWitness`/`fuzzHolds` both run
 * against the DST in-memory fake store, never a real Postgres instance.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import type { CompiledSchema } from '../../../src/schema/dsl/types.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import { parseInvariants } from '../src/invariants/index.js';
import type { Invariant } from '../src/invariants/index.js';
import { checkAndValidate } from '../src/validate/index.js';
import { trySmtTier } from '../src/smt/index.js';
import { isRecursive } from '../src/smt/recursion.js';

const SCHEMA_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/schemas/', import.meta.url));
const INVARIANT_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/invariants/', import.meta.url));

function loadSchema(filename: string): CompiledSchema {
  const result = compileSchema(readFileSync(SCHEMA_FIXTURE_DIR + filename, 'utf8'));
  if (!result.ok) {
    throw new Error(
      `schema ${filename} did not compile: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return result.schema;
}

function loadInvariant(filename: string): Invariant {
  const result = parseInvariants(readFileSync(INVARIANT_FIXTURE_DIR + filename, 'utf8'));
  if (!result.ok) {
    throw new Error(
      `invariant ${filename} did not parse: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  expect(result.invariants).toHaveLength(1);
  return result.invariants[0]!;
}

describe('trySmtTier — the encoder itself, against a small hand-built non-recursive schema', () => {
  const nonMonotone = loadSchema('non-monotone.authz');
  const graph = buildSchemaGraph(nonMonotone);

  it('is never asked to apply to a recursive goal in this fixture — sanity check that the fixture this file relies on is genuinely non-recursive', () => {
    expect(isRecursive(graph, 'document#approve')).toBe(false);
    expect(isRecursive(graph, 'document#publish')).toBe(false);
  });

  it('known VIOLATED case: approve = editor & reviewer, no constraints — SAT, and the reconstructed witness is independently confirmed through the real engine', async () => {
    const invariant = loadInvariant('intersection-approve.invariant');
    const tier = await trySmtTier(graph, nonMonotone, invariant);

    expect(tier).toBeDefined();
    expect(tier!.result.verdict).toBe('VIOLATED');
    expect(tier!.result.fragment).toBe('non-monotone');
    expect(tier!.result.proof).toBe('exact');
    expect(tier!.result.witness).toBeDefined();
    expect(tier!.result.witness!.length).toBeGreaterThan(0);
    // Not just "z3 said sat" — an independent confirmation through the
    // real, unmodified production engine, on a fresh scratch store.
    expect(tier!.validation.kind).toBe('confirmed');
    if (tier!.validation.kind === 'confirmed') {
      expect(tier!.validation.engineResult.allowed).toBe(true);
    }
    // Every witness tuple actually appears in the two relations the
    // intersection names — not some unrelated artifact of the encoding.
    const relations = new Set(tier!.result.witness!.map((t) => t.relation));
    expect(relations).toEqual(new Set(['editor', 'reviewer']));
  });

  it('known HOLDS case: publish = editor - blocked, blocked(o) = s given and held fixed — UNSAT, a real unconditional proof (no bound)', async () => {
    const invariant = loadInvariant('exclusion-blocked-cannot-publish.invariant');
    const tier = await trySmtTier(graph, nonMonotone, invariant);

    expect(tier).toBeDefined();
    expect(tier!.result.verdict).toBe('HOLDS');
    expect(tier!.result.fragment).toBe('non-monotone');
    expect(tier!.result.proof).toBe('exact');
    expect(tier!.result.bound).toBeUndefined();
    expect(tier!.result.witness).toBeUndefined();
    // The exact prover's own HOLDS gets the same empirical
    // belt-and-suspenders fuzz check — this tier's own HOLDS gets it too.
    expect(['empirically-clean', 'empirical-counterexample']).toContain(tier!.validation.kind);
    expect(tier!.validation.kind).toBe('empirically-clean');
  });

  it('the real engine confirms the witness via a genuine intersection path — proof the encoder compiled AND, not OR', async () => {
    // Direct check that intersection really did compile to AND, not OR:
    // the real engine's own confirmed path (`engineResult.path.kind`)
    // must literally be `'intersection'`, not e.g. a union branch that
    // happened to also be true — checked against the real engine's own
    // reported structure, not re-derived here.
    const invariant = loadInvariant('intersection-approve.invariant');
    const tier = await trySmtTier(graph, nonMonotone, invariant);
    expect(tier).toBeDefined();
    if (tier!.validation.kind === 'confirmed') {
      expect(tier!.validation.engineResult.path?.kind).toBe('intersection');
    }
  });
});

describe('self-validation is load-bearing, not decorative — a genuine SAT-but-real-engine-denies case', () => {
  // `fixtures/schemas/smt-mismatch-deep-intersection.authz` — a
  // deliberately non-monotone (trivial `& gate` at the top) 30-level
  // `next->view` chain (this tool's own established §8c "depth exceeds
  // the limit" pathological shape, D-120, given a second, independent
  // copy here because that one is purely monotone and never reaches this
  // tier at all). This encoder has no notion of the real engine's own
  // `CHECK_MAX_DEPTH` (`src/config/env.ts`, default 25) — it happily
  // finds a genuine SAT (a real, if very deep, witness) — so this is a
  // real, reproducible case where the reconstructed witness does NOT
  // independently confirm, and `trySmtTier` must not report VIOLATED.
  //
  // This exact case is what a live fail-check (deliberately commenting
  // out `../src/smt/index.ts`'s own `if (validation.kind !== 'confirmed')
  // return undefined;` line, rerunning, and reverting) was run against
  // directly while building this tier: with that gate removed, this case
  // was wrongly reported `VIOLATED` (z3's own `sat` result reported
  // outright, un-replayed); with the gate restored (the code as shipped,
  // exercised by this test), it is correctly `undefined`. See
  // `docs/DECISIONS.md` for the full, dated account of that exercise.
  const schema = loadSchema('smt-mismatch-deep-intersection.authz');
  const graph = buildSchemaGraph(schema);
  const invariant = loadInvariant('smt-mismatch-deep-intersection.invariant');

  it('is genuinely non-recursive (a long chain of distinct namespaces, no back-edge) — so the tier actually attempts this, rather than declining for an unrelated reason', () => {
    expect(isRecursive(graph, 'level0#view')).toBe(false);
  });

  it('trySmtTier declines (undefined) — the reconstructed witness fails real-engine confirmation, so nothing is ever reported', async () => {
    const tier = await trySmtTier(graph, schema, invariant);
    expect(tier).toBeUndefined();
  });

  it('checkAndValidate falls through to bounded search for the same goal, exactly as it would for any other tier-inapplicable case', async () => {
    // Bounded search's own `scanReachability`-driven candidate generation
    // never produces a `next` tuple at all (`tupleToUserset`'s own
    // `childrenOf` jumps straight to each target *permission* node —
    // `level1#view`, `level2#view`, ... — never to the intermediate
    // `next` *relation* node itself, so `next` never appears in
    // `scan.relations`) — an existing, orthogonal property of bounded
    // search's own candidate generation, unrelated to this tier. With no
    // way to ever generate a `next` tuple, no candidate subset can ever
    // satisfy `next->view`, so bounded search correctly reports `HOLDS`
    // from its own necessarily narrower candidate universe — a genuine,
    // if narrow, bounded result, not a crash or a hang. This test's own
    // claim is only that the SMT tier's decline doesn't disrupt that.
    const { result } = await checkAndValidate(graph, schema, invariant);
    expect(result.verdict).toBe('HOLDS');
    expect(result.proof).toBe('bounded');
    expect(result.bound).toBe(1);
  }, 10_000);
});
