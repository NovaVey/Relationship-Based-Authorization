/**
 * `checkAndValidate` — build spec §6 exit criteria: "self-validation
 * runs automatically on every VIOLATED result; a deliberately corrupted
 * IR edge causes the mismatch path to fire and report clearly." Also
 * CHECKPOINT 4's own ask: "show a real counterexample, its tuples, and
 * the engine's response to them" — the `tenant_isolation` test below
 * does exactly that and logs it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import type { CompiledSchema } from '../../../src/schema/dsl/types.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import type { DirectEdge, GraphEdge, SchemaGraph } from '../src/ir/index.js';
import { parseInvariants } from '../src/invariants/index.js';
import type { Invariant } from '../src/invariants/index.js';
import { checkAndValidate } from '../src/validate/index.js';

const SCHEMA_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/schemas/', import.meta.url));
const INVARIANT_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/invariants/', import.meta.url));
const REAL_SCHEMA_DIR = fileURLToPath(new URL('../../../schema/', import.meta.url));

function loadSchema(dir: string, filename: string): CompiledSchema {
  const source = readFileSync(dir + filename, 'utf8');
  const result = compileSchema(source);
  if (!result.ok) {
    throw new Error(
      `schema ${filename} did not compile: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return result.schema;
}

function loadInvariant(filename: string): Invariant {
  const source = readFileSync(INVARIANT_FIXTURE_DIR + filename, 'utf8');
  const result = parseInvariants(source);
  if (!result.ok) {
    throw new Error(
      `invariant ${filename} did not parse: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  expect(result.invariants).toHaveLength(1);
  return result.invariants[0]!;
}

describe('checkAndValidate — self-validation runs automatically on every VIOLATED result', () => {
  const tenancy = loadSchema(SCHEMA_FIXTURE_DIR, 'tenancy.authz');
  const graph = buildSchemaGraph(tenancy);

  it('CHECKPOINT 4: tenant_isolation — a real counterexample, its tuples, and the real engine allowing it', async () => {
    const invariant = loadInvariant('tenant-isolation.invariant');
    const { result, validation } = await checkAndValidate(graph, tenancy, invariant);

    expect(result.verdict).toBe('VIOLATED');
    expect(validation.kind).toBe('confirmed');
    if (validation.kind !== 'confirmed') throw new Error('unreachable');

    // The exact ask: real tuples, a real check, a real `allow`.
    console.log(
      'tenant_isolation VIOLATED — witness tuples:',
      validation.witness.map(
        (t) => `${t.objectType}:${t.object}#${t.relation}@${t.subjectType}:${t.subject}`,
      ),
      '— real engine response:',
      validation.engineResult,
    );
    expect(validation.engineResult.allowed).toBe(true);
    expect(validation.witness.length).toBeGreaterThan(0);
  });

  it('positive_control — also confirmed against the real engine', async () => {
    const invariant = loadInvariant('positive-control.invariant');
    const { result, validation } = await checkAndValidate(graph, tenancy, invariant);
    expect(result.verdict).toBe('VIOLATED');
    expect(validation.kind).toBe('confirmed');
    if (validation.kind !== 'confirmed') throw new Error('unreachable');
    expect(validation.engineResult.allowed).toBe(true);
  });

  it('no_public_path_to_private_document — HOLDS, and empirical fuzzing against the real engine finds no counterexample', async () => {
    const invariant = loadInvariant('no-public-path-to-private-document.invariant');
    const { result, validation } = await checkAndValidate(graph, tenancy, invariant, {
      fuzz: { trials: 25, seed: 7 },
    });
    expect(result.verdict).toBe('HOLDS');
    expect(validation).toEqual({ kind: 'empirically-clean', sampled: 25 });
  });

  it('an UNKNOWN verdict gets no self-validation attempt at all', async () => {
    // Written before §7 existed, when checkAndValidate had no fallback for
    // an intersection/exclusion goal and every such goal was UNKNOWN by
    // construction. §7 now routes this to boundedSearch instead — real
    // folder-schema growth (viewer | edit) & sensitive_reviewer reaches 25
    // candidate tuples even at k = 1, over MAX_BOUNDED_CANDIDATES, so this
    // is still UNKNOWN, but now for a disclosed, bound-specific reason
    // (see `result.reason`), not because intersection is unhandled — this
    // fixture is kept as the "still UNKNOWN, still no validation attempt"
    // regression case for whichever of the two reasons currently applies.
    const example = loadSchema(REAL_SCHEMA_DIR, 'example.authz');
    const exampleGraph = buildSchemaGraph(example);
    const source = [
      'invariant reaches_sensitive_review {',
      '  s: user',
      '  o: folder',
      '  goal: sensitive_review(s, o)',
      '}',
    ].join('\n');
    const parsed = parseInvariants(source);
    if (!parsed.ok) throw new Error('fixture invariant failed to parse');
    const { result, validation } = await checkAndValidate(
      exampleGraph,
      example,
      parsed.invariants[0]!,
    );
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.fragment).toBe('non-monotone');
    expect(result.reason).toContain('candidate');
    expect(validation).toEqual({ kind: 'not-applicable' });
  });
});

describe('checkAndValidate — a deliberately corrupted IR edge makes the mismatch path fire', () => {
  it("private_document#owner's subject-type restriction, widened to also accept a bare user, is caught: the search finds a witness the real engine flatly rejects", async () => {
    const tenancy = loadSchema(SCHEMA_FIXTURE_DIR, 'tenancy.authz');
    const realGraph = buildSchemaGraph(tenancy);
    const invariant = loadInvariant('no-public-path-to-private-document.invariant');

    // Sanity: the real, uncorrupted graph genuinely holds (already covered
    // above, re-asserted here so the corruption below is proven to be the
    // one and only thing that flips the verdict).
    const real = await checkAndValidate(realGraph, tenancy, invariant);
    expect(real.result.verdict).toBe('HOLDS');

    // Corrupt exactly one edge: private_document#owner really only
    // accepts `service_account` (tenancy.authz's own declaration) — widen
    // it to also accept a bare `user`, simulating the class of IR bug §3
    // warned about ("type restrictions bound the witness... carry the
    // restrictions on every edge and honor them, or a witness naming an
    // out-of-type subject is a bug in the verifier, not a counterexample").
    const ownerNodeId = 'private_document#owner';
    const originalEdges = realGraph.edgesFrom.get(ownerNodeId) ?? [];
    const originalDirect = originalEdges.find((e): e is DirectEdge => e.kind === 'direct');
    if (!originalDirect) throw new Error('fixture assumption broken: expected a direct edge here');
    const corruptedDirect: DirectEdge = {
      kind: 'direct',
      from: ownerNodeId,
      subjectTypes: [...originalDirect.subjectTypes, { namespace: 'user' }],
    };
    const corruptedEdgesFrom = new Map<string, readonly GraphEdge[]>(realGraph.edgesFrom);
    corruptedEdgesFrom.set(ownerNodeId, [corruptedDirect]);
    const corruptedGraph: SchemaGraph = {
      nodes: realGraph.nodes,
      edges: realGraph.edges,
      edgesFrom: corruptedEdgesFrom,
    };

    const { result, validation } = await checkAndValidate(corruptedGraph, tenancy, invariant);

    // The corrupted IR now (wrongly) thinks a witness exists.
    expect(result.verdict).toBe('VIOLATED');
    expect(result.witness).toEqual([
      {
        objectType: 'private_document',
        object: 'o',
        relation: 'owner',
        subjectType: 'user',
        subject: 's',
      },
    ]);

    // Self-validation catches it: the real, uncorrupted schema rejects
    // that exact tuple outright (private_document.owner really only
    // accepts service_account), so the mismatch path fires clearly.
    expect(validation.kind).toBe('mismatch');
    if (validation.kind !== 'mismatch') throw new Error('unreachable');
    expect(validation.reason).toContain('rejected by the real schema');
    expect(validation.reason).toContain('owner');
  });
});
