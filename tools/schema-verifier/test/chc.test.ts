/**
 * `../src/smt/chc.ts`'s own `tryChcTier` — the Horn-clause/CHC tier
 * (docs/DECISIONS.md, the entry adding `src/smt/chc.ts`) that decides the
 * fragment `../src/smt/index.ts`'s own `trySmtTier` declines on outright:
 * a genuinely recursive goal. DB-free unit tests, matching `test/
 * smt.test.ts`'s own convention throughout (`replayWitness`/`fuzzHolds`
 * both run against the DST in-memory fake store, never a real Postgres
 * instance) — small, dedicated fixtures here; the real, committed,
 * executable live proof against `schema/example.authz` itself lives in
 * `test/smt-live-example.test.ts` (updated in the same entry that added
 * this tier) and `test/smt-recursion.test.ts` (the exclusion-scope
 * confirmation against `banned_member_never_views_org`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import type { CompiledSchema } from '../../../src/schema/dsl/types.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import { parseInvariants } from '../src/invariants/index.js';
import type { Invariant } from '../src/invariants/index.js';
import { checkInvariant } from '../src/reachability/index.js';
import { checkAndValidate } from '../src/validate/index.js';
import { tryChcTier } from '../src/smt/chc.js';
import { isRecursive } from '../src/smt/recursion.js';

const SCHEMA_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/schemas/', import.meta.url));
const REAL_SCHEMA_DIR = fileURLToPath(new URL('../../../schema/', import.meta.url));

function loadSchema(dir: string, filename: string): CompiledSchema {
  const result = compileSchema(readFileSync(dir + filename, 'utf8'));
  if (!result.ok) {
    throw new Error(
      `schema ${filename} did not compile: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return result.schema;
}

function loadInvariant(source: string): Invariant {
  const result = parseInvariants(source);
  if (!result.ok) {
    throw new Error(`invariant did not parse: ${result.errors.map((e) => e.message).join('; ')}`);
  }
  expect(result.invariants).toHaveLength(1);
  return result.invariants[0]!;
}

describe('tryChcTier — VIOLATED direction, against a small hand-built recursive+intersection schema', () => {
  const schema = loadSchema(SCHEMA_FIXTURE_DIR, 'chc-recursive-intersection.authz');
  const graph = buildSchemaGraph(schema);
  const invariant = loadInvariant(
    [
      'invariant sr_reachable {',
      '  s: user',
      '  o: docx2',
      '  goal: sensitive_review(s, o)',
      '}',
    ].join('\n'),
  );

  it('is genuinely recursive — sanity check that this fixture actually exercises this tier, not the non-recursive one', () => {
    expect(isRecursive(graph, 'docx2#sensitive_review')).toBe(true);
  });

  it("checkInvariant itself cannot decide it (UNKNOWN) — confirms this genuinely reaches the new tier through checkAndValidate's real routing, not only a direct call", () => {
    const exact = checkInvariant(graph, schema, invariant);
    expect(exact.verdict).toBe('UNKNOWN');
  });

  it('known VIOLATED case: sensitive_review = viewer & sensitive_reviewer, no constraints — SAT, and the reconstructed witness is independently confirmed through the real engine', async () => {
    const tier = await tryChcTier(graph, schema, invariant);

    expect(tier).toBeDefined();
    expect(tier!.result.verdict).toBe('VIOLATED');
    expect(tier!.result.fragment).toBe('non-monotone');
    expect(tier!.result.proof).toBe('exact');
    expect(tier!.result.witness).toBeDefined();
    expect(tier!.result.witness!.length).toBeGreaterThan(0);
    expect(tier!.validation.kind).toBe('confirmed');
    if (tier!.validation.kind === 'confirmed') {
      expect(tier!.validation.engineResult.allowed).toBe(true);
      expect(tier!.validation.engineResult.path?.kind).toBe('intersection');
    }
    const relations = new Set(tier!.result.witness!.map((t) => t.relation));
    expect(relations).toEqual(new Set(['viewer', 'sensitive_reviewer']));
  });

  it('checkAndValidate end to end agrees — the full router, not merely trySmtTier called in isolation', async () => {
    const { result, validation } = await checkAndValidate(graph, schema, invariant);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.proof).toBe('exact');
    expect(validation.kind).toBe('confirmed');
  });
});

describe('tryChcTier — HOLDS direction: a genuine cycle with no base case anywhere', () => {
  const schema = loadSchema(SCHEMA_FIXTURE_DIR, 'chc-recursive-no-base-case.authz');
  const graph = buildSchemaGraph(schema);
  const invariant = loadInvariant(
    ['invariant x_reachable {', '  s: user', '  o: folderx', '  goal: x(s, o)', '}'].join('\n'),
  );

  it('is genuinely recursive', () => {
    expect(isRecursive(graph, 'folderx#x')).toBe(true);
  });

  it("agrees with checkInvariant's own exact monotone answer (HOLDS) — cross-checked against a second, independent implementation, not merely self-consistent", () => {
    const exact = checkInvariant(graph, schema, invariant);
    expect(exact.verdict).toBe('HOLDS');
  });

  it('HOLDS, proof: exact, no bound — a real, unconditional proof through a genuine cycle, not "up to k"', async () => {
    const tier = await tryChcTier(graph, schema, invariant);

    expect(tier).toBeDefined();
    expect(tier!.result.verdict).toBe('HOLDS');
    expect(tier!.result.fragment).toBe('non-monotone');
    expect(tier!.result.proof).toBe('exact');
    expect(tier!.result.bound).toBeUndefined();
    expect(tier!.result.witness).toBeUndefined();
    expect(['empirically-clean', 'empirical-counterexample']).toContain(tier!.validation.kind);
    expect(tier!.validation.kind).toBe('empirically-clean');
  });
});

describe('scope: a non-recursive goal is not this tier’s fragment', () => {
  it('trySmtTier’s own fixture (non-monotone.authz, non-recursive) — tryChcTier declines, this is entirely the non-recursive tier’s job', async () => {
    const schema = loadSchema(SCHEMA_FIXTURE_DIR, 'non-monotone.authz');
    const graph = buildSchemaGraph(schema);
    expect(isRecursive(graph, 'document#approve')).toBe(false);
    const invariant = loadInvariant(
      [
        'invariant approve_reachable {',
        '  s: user',
        '  o: document',
        '  goal: approve(s, o)',
        '}',
      ].join('\n'),
    );
    const tier = await tryChcTier(graph, schema, invariant);
    expect(tier).toBeUndefined();
  });
});

describe('scope: exclusion is out of this tier’s own disclosed boundary — confirmed unsupported Horn-clause negation, not merely unattempted', () => {
  it("the real schema/example.authz's own banned_member_never_views_org (org.view = member - banned, recursive via nested groups AND exclusion) — tryChcTier declines even though the goal is genuinely recursive", async () => {
    const schema = loadSchema(REAL_SCHEMA_DIR, 'example.authz');
    const graph = buildSchemaGraph(schema);
    const parsed = parseInvariants(readFileSync(REAL_SCHEMA_DIR + 'example.invariant', 'utf8'));
    if (!parsed.ok) throw new Error('schema/example.invariant failed to parse');
    const invariant = parsed.invariants[0]!;
    expect(invariant.name).toBe('banned_member_never_views_org');
    expect(isRecursive(graph, 'org#view')).toBe(true);

    const tier = await tryChcTier(graph, schema, invariant);
    expect(tier).toBeUndefined();
  });
});

describe('scope: notRelationEquals is also out of this tier’s own disclosed boundary — same Horn-clause negation limitation', () => {
  it('the same recursive+intersection fixture above, with a "not sensitive_reviewer(o) = s" constraint added — tryChcTier declines rather than mis-encode the negation', async () => {
    const schema = loadSchema(SCHEMA_FIXTURE_DIR, 'chc-recursive-intersection.authz');
    const graph = buildSchemaGraph(schema);
    const invariant = loadInvariant(
      [
        'invariant sr_reachable_excluded {',
        '  s: user',
        '  o: docx2',
        '  not sensitive_reviewer(o) = s',
        '  goal: sensitive_review(s, o)',
        '}',
      ].join('\n'),
    );
    expect(isRecursive(graph, 'docx2#sensitive_review')).toBe(true);

    const tier = await tryChcTier(graph, schema, invariant);
    expect(tier).toBeUndefined();
  });
});

describe('self-validation is load-bearing, not decorative — a genuine SAT-but-real-engine-denies case, the CHC tier’s own counterpart to test/smt.test.ts’s equivalent fixture', () => {
  // `fixtures/schemas/chc-mismatch-deep-recursive.authz` — a genuine
  // cycle (isRecursive true, via a deliberately unused self-loop at the
  // very last level) wrapped around the same "30-level `next->view`
  // chain, no notion of the real engine's own `CHECK_MAX_DEPTH`" shape
  // `smt-mismatch-deep-intersection.authz` already established for the
  // non-recursive tier. This encoder's own witness reconstruction
  // (`../src/smt/chc-witness.ts`) prefers the shallowest available
  // derivation at every branch point (declaration order, base cases
  // first) — which is exactly why this fixture's own base case is
  // declared *last*, forcing the reconstructed witness through the full
  // 29-hop chain before it ever reaches `owner`, past `CHECK_MAX_DEPTH`
  // (default 25).
  //
  // This exact case is what a live fail-check (deliberately commenting
  // out `../src/smt/chc.ts`'s own `if (validation.kind !== 'confirmed')
  // return undefined;` line, rerunning, and reverting) was run against
  // directly while building this tier: with that gate removed, this case
  // was wrongly reported `VIOLATED` (z3's own `sat` result reported
  // outright, un-replayed — the real engine's own denial, `depth: 26`,
  // confirmed live); with the gate restored (the code as shipped,
  // exercised by this test), it is correctly `undefined`. See
  // `docs/DECISIONS.md` for the full, dated account of that exercise.
  const schema = loadSchema(SCHEMA_FIXTURE_DIR, 'chc-mismatch-deep-recursive.authz');
  const graph = buildSchemaGraph(schema);
  const invariant = loadInvariant(
    ['invariant deep_view_reachable {', '  s: user', '  o: level0', '  goal: view(s, o)', '}'].join(
      '\n',
    ),
  );

  it('is genuinely recursive (the deliberately-unused self-loop at level29) — so the tier actually attempts this, rather than declining for an unrelated reason', () => {
    expect(isRecursive(graph, 'level0#view')).toBe(true);
  });

  it('tryChcTier declines (undefined) — the reconstructed witness fails real-engine confirmation, so nothing is ever reported', async () => {
    const tier = await tryChcTier(graph, schema, invariant);
    expect(tier).toBeUndefined();
  });

  it('checkAndValidate falls through to bounded search for the same goal, exactly as it would for any other tier-inapplicable case', async () => {
    const { result } = await checkAndValidate(graph, schema, invariant);
    expect(result.verdict).toBe('HOLDS');
    expect(result.proof).toBe('bounded');
    expect(result.bound).toBe(1);
  }, 10_000);
});
