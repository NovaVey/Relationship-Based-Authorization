/**
 * The SMT tier's own "genuinely extends real capability, not just passes
 * synthetic tests" live proof — against the exact real fixture named for
 * this purpose: `schema/example.authz`'s own `folder#sensitive_review =
 * (viewer | edit) & sensitive_reviewer`, `docs/DECISIONS.md` D-118's own
 * worked example of a real goal reaching 25 candidates at k = 1, over
 * `MAX_BOUNDED_CANDIDATES`, previously refused with `UNKNOWN`.
 *
 * **A real, disclosed finding, checked directly rather than assumed:**
 * `folder#sensitive_review`'s own reachable subgraph turns out to be
 * genuinely recursive — `edit = editor | owner | parent->edit` is
 * self-referential (`parent->edit` targets `folder#edit` again, a real
 * back-edge, confirmed by `../src/smt/recursion.ts` against the actual
 * built graph — see `test/smt-recursion.test.ts`), and `viewer`/
 * `sensitive_reviewer` are each declared `user | group#member`, itself
 * self-referential via nested group membership. Per this tier's own
 * explicit, non-negotiable scope (recursion is the sketch's own named,
 * out-of-scope obstacle), the SMT tier correctly declines on this exact
 * goal and this exact invariant continues to report `UNKNOWN`, unchanged
 * from before this tier existed — the first test below confirms that
 * directly, rather than silently working around it.
 *
 * The second test demonstrates the same underlying claim — a small,
 * non-recursive intersection whose candidate count exceeds
 * `MAX_BOUNDED_CANDIDATES` is now decided *exactly*, where bounded search
 * alone could only refuse to run — against `fixtures/schemas/sensitive-
 * review-non-recursive.authz`, a new fixture with the identical shape
 * (`(viewer | edit) & sensitive_reviewer`) and the identical
 * over-the-ceiling candidate count, with the two recursion sources
 * removed. See that fixture's own header comment for the full account.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import type { CompiledSchema } from '../../../src/schema/dsl/types.js';
import {
  generateCandidateTuples,
  boundedSearch,
  MAX_BOUNDED_CANDIDATES,
} from '../src/bounded/index.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import { parseInvariants } from '../src/invariants/index.js';
import type { Invariant } from '../src/invariants/index.js';
import { scanReachability } from '../src/reachability/index.js';
import { isRecursive } from '../src/smt/recursion.js';
import { checkAndValidate } from '../src/validate/index.js';

const SCHEMA_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/schemas/', import.meta.url));
const INVARIANT_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/invariants/', import.meta.url));
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

describe('the real, literal fixture named for this proof: schema/example.authz — folder#sensitive_review', () => {
  const schema = loadSchema(REAL_SCHEMA_DIR, 'example.authz');
  const graph = buildSchemaGraph(schema);
  const invariant = loadInvariant(
    [
      'invariant sensitive_review_reachable_real_schema {',
      '  s: user',
      '  o: folder',
      '  goal: sensitive_review(s, o)',
      '}',
    ].join('\n'),
  );

  it('is genuinely recursive, confirmed directly against the built graph — not the assumption the task naming this fixture made', () => {
    expect(isRecursive(graph, 'folder#sensitive_review')).toBe(true);
  });

  it('reaches over MAX_BOUNDED_CANDIDATES at k = 1, exactly as D-118 documented — 25 candidates', () => {
    const scan = scanReachability(graph, 'folder#sensitive_review');
    const candidates = generateCandidateTuples(schema, scan.relations, invariant, 1);
    expect(candidates.length).toBe(25);
    expect(candidates.length).toBeGreaterThan(MAX_BOUNDED_CANDIDATES);
  });

  it('remains UNKNOWN, unchanged — the SMT tier correctly declines on a recursive goal rather than mis-scoping onto it', async () => {
    const { result, validation } = await checkAndValidate(graph, schema, invariant);
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.reason).toContain('25 candidate tuples');
    expect(result.reason).toContain(`${MAX_BOUNDED_CANDIDATES}-candidate ceiling`);
    expect(validation).toEqual({ kind: 'not-applicable' });
  });
});

describe('the same shape, non-recursive: fixtures/schemas/sensitive-review-non-recursive.authz — genuinely new capability', () => {
  const schema = loadSchema(SCHEMA_FIXTURE_DIR, 'sensitive-review-non-recursive.authz');
  const graph = buildSchemaGraph(schema);
  const invariant = loadInvariant(
    readFileSync(INVARIANT_FIXTURE_DIR + 'sensitive-review-reachable.invariant', 'utf8'),
  );

  it('is genuinely non-recursive', () => {
    expect(isRecursive(graph, 'document2#sensitive_review')).toBe(false);
  });

  it('reaches over MAX_BOUNDED_CANDIDATES at k = 1 — the same "bounded search must refuse" shape as the real fixture above', () => {
    const scan = scanReachability(graph, 'document2#sensitive_review');
    const candidates = generateCandidateTuples(schema, scan.relations, invariant, 1);
    expect(candidates.length).toBeGreaterThan(MAX_BOUNDED_CANDIDATES);
  });

  it('bounded search alone, called directly, still refuses to run (the "before this tier existed" behavior, confirmed live, not assumed)', async () => {
    const scan = scanReachability(graph, 'document2#sensitive_review');
    const candidates = generateCandidateTuples(schema, scan.relations, invariant, 1);
    const before = await boundedSearch(schema, invariant, candidates, 1);
    expect(before.verdict).toBe('UNKNOWN');
  });

  it('checkAndValidate now decides this goal exactly, via the new SMT tier — VIOLATED, proof: exact, independently confirmed through the real engine', async () => {
    const { result, validation } = await checkAndValidate(graph, schema, invariant);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.fragment).toBe('non-monotone');
    expect(result.proof).toBe('exact');
    expect(result.witness).toBeDefined();
    expect(result.witness!.length).toBeGreaterThan(0);
    expect(validation.kind).toBe('confirmed');
    if (validation.kind === 'confirmed') {
      expect(validation.engineResult.allowed).toBe(true);
    }
  });
});
