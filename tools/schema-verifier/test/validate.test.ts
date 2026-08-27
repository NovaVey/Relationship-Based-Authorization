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
import type { WitnessTuple } from '../src/reachability/index.js';
import { checkAndValidate, fuzzHolds, replayWitness } from '../src/validate/index.js';

const SCHEMA_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/schemas/', import.meta.url));
const INVARIANT_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/invariants/', import.meta.url));

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

  it('fuzzHolds actually detects a real counterexample when one exists — not a no-op that always reports clean', async () => {
    // §8a's own mutation-testing exercise (docs/DECISIONS.md D-119,
    // mutation M9) found that nothing in this suite would notice
    // fuzzHolds silently never reporting a counterexample: every fixture
    // that reaches it via checkAndValidate (no_public_path_to_private_
    // document, above) is one where HOLDS is genuinely, structurally
    // true, so an honest fuzzer and a broken always-clean one behave
    // identically there. This calls fuzzHolds directly — bypassing
    // checkAndValidate's own HOLDS-gated routing — against
    // positive_control (trivially satisfiable, D-116's own "positive
    // control" fixture) to prove the fuzzer itself has real teeth: with
    // enough trials it does find `allow`, not just "no assertion ever
    // ran against a real gap." Seed 1 (this module's own default)
    // reliably finds it at the default trial/tuple count.
    const invariant = loadInvariant('positive-control.invariant');

    const validation = await fuzzHolds(tenancy, invariant, { seed: 1 });

    expect(validation.kind).toBe('empirical-counterexample');
    if (validation.kind !== 'empirical-counterexample') throw new Error('unreachable');
    expect(validation.engineResult.allowed).toBe(true);
  });

  it('an UNKNOWN verdict gets no self-validation attempt at all', async () => {
    // Written before §7 existed, when checkAndValidate had no fallback for
    // an intersection/exclusion goal and every such goal was UNKNOWN by
    // construction. §7 routed this to boundedSearch instead, and — once
    // `docs/DECISIONS.md`'s entry adding `src/smt/chc.ts` landed — the new
    // CHC tier now decides a *recursive* intersection goal exactly (see
    // `test/smt-live-example.test.ts`'s own updated first describe block:
    // this exact fixture, `schema/example.authz`'s own
    // `folder#sensitive_review`, is `VIOLATED, proof: exact` now, not
    // UNKNOWN). This test's own fixture moved to
    // `fixtures/schemas/sensitive-review-recursive-exclusion.authz`: the
    // same shape, deliberately sized past `MAX_BOUNDED_CANDIDATES`, but
    // with the goal reaching an *exclusion* (`viewer | edit) - blocked`)
    // rather than an intersection — the CHC tier's own disclosed scope
    // boundary (`src/smt/chc-encode.ts`'s own header comment: Horn-clause
    // negation is confirmed unusable in this z3-solver build) means it
    // declines here too, so the verdict genuinely stays UNKNOWN, for a
    // disclosed, bound-specific reason — the "still UNKNOWN, still no
    // validation attempt" regression case this test exists to pin.
    const schema = loadSchema(SCHEMA_FIXTURE_DIR, 'sensitive-review-recursive-exclusion.authz');
    const graph = buildSchemaGraph(schema);
    const source = [
      'invariant reaches_sensitive_review {',
      '  s: user',
      '  o: docx',
      '  goal: sensitive_review(s, o)',
      '}',
    ].join('\n');
    const parsed = parseInvariants(source);
    if (!parsed.ok) throw new Error('fixture invariant failed to parse');
    const { result, validation } = await checkAndValidate(graph, schema, parsed.invariants[0]!);
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

  it('replayWitness reports mismatch when every witness tuple writes successfully but the real engine still denies the goal — a wrong/incomplete witness, not a rejected tuple', async () => {
    // §8a's own mutation-testing exercise (docs/DECISIONS.md D-119,
    // mutation M8) found that the fail-check above only ever exercises
    // replayWitness's *first* mismatch branch (a witness tuple the real
    // schema rejects outright) — nothing in the suite reached the
    // *second* branch (every tuple writes fine, but the real engine's own
    // rewrite-rule logic still denies the goal). A mutation that always
    // reported `confirmed` once every write succeeded went completely
    // uncaught. This directly unit-tests replayWitness against a
    // hand-built witness that's individually type-valid (a real
    // `tenancy.authz` relation, a real subject type) but deliberately
    // incomplete: `document:o#tenant@organization:org1` alone never
    // grants `view`, since `document.view = tenant->member` also needs a
    // tuple granting `s` membership in that same org — a genuine
    // `checkInvariant` witness would never omit it, so this is
    // replayWitness's own behavior in isolation, the same "test the
    // module directly" approach `generateCandidateTuples`'s own probe
    // test (bounded.test.ts) already uses.
    const tenancy = loadSchema(SCHEMA_FIXTURE_DIR, 'tenancy.authz');
    const invariant = loadInvariant('positive-control.invariant');
    const incompleteWitness: WitnessTuple[] = [
      {
        objectType: 'document',
        object: 'o',
        relation: 'tenant',
        subjectType: 'organization',
        subject: 'org1',
      },
    ];

    const validation = await replayWitness(incompleteWitness, tenancy, invariant);

    expect(validation.kind).toBe('mismatch');
    if (validation.kind !== 'mismatch') throw new Error('unreachable');
    expect(validation.reason).toContain('real engine denied');
  });
});
