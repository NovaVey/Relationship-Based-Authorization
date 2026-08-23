/**
 * Pins README.md's own worked example (build spec §11: "a schema with a
 * three-hop leak, the invariant, the counterexample tuples, the engine
 * confirming them") against the exact fixture files `examples/run.ts`
 * runs. If this test ever fails, the README's worked example is no
 * longer true and needs to be re-run and rewritten — that's the whole
 * point: every README claim here is backed by something that fails if
 * the claim stops being true.
 */
import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import { parseInvariants } from '../src/invariants/index.js';
import type { Invariant } from '../src/invariants/index.js';
import { checkAndValidate } from '../src/validate/index.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXAMPLE_DIR = fileURLToPath(new URL('../examples/', import.meta.url));

const SCHEMA_SOURCE = readFileSync(EXAMPLE_DIR + 'three-hop-leak.authz', 'utf8');
const INVARIANT: Invariant = (() => {
  const result = parseInvariants(readFileSync(EXAMPLE_DIR + 'three-hop-leak.invariant', 'utf8'));
  if (!result.ok) throw new Error('example invariant failed to parse');
  return result.invariants[0]!;
})();

describe('README worked example (§11): three-hop leak via private_document.linked_doc', () => {
  it('flips to VIOLATED with a 3-edge witness, self-validated against the real engine', async () => {
    const compiled = compileSchema(SCHEMA_SOURCE);
    if (!compiled.ok) throw new Error('example schema failed to compile');
    const graph = buildSchemaGraph(compiled.schema);

    const { result, validation } = await checkAndValidate(graph, compiled.schema, INVARIANT);

    expect(result.verdict).toBe('VIOLATED');
    expect(result.fragment).toBe('monotone');
    expect(result.witness).toHaveLength(3);

    // The exact counterexample tuples README.md quotes — pinned here so
    // the two can never silently drift apart.
    expect(result.witness).toEqual([
      expect.objectContaining({
        objectType: 'private_document',
        relation: 'linked_doc',
        subjectType: 'document',
      }),
      expect.objectContaining({
        objectType: 'document',
        relation: 'tenant',
        subjectType: 'organization',
      }),
      expect.objectContaining({
        objectType: 'organization',
        relation: 'member',
        subjectType: 'user',
      }),
    ]);

    // §6 self-validation: the real, unmodified production engine agrees.
    expect(validation.kind).toBe('confirmed');
    if (validation.kind === 'confirmed') {
      expect(validation.engineResult.allowed).toBe(true);
    }
  });
});
