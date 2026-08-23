/**
 * §7's non-monotone fragment: intersection and exclusion, via bounded
 * search. Build spec's own exit bar: "if the schema uses only the
 * monotone fragment, the verifier is exact — sound and complete. Say
 * that. Otherwise... report `HOLDS up to k = N` — never bare `HOLDS`."
 * These tests cover: `scanReachability` correctly telling the two
 * fragments apart, `checkAndValidate` routing a non-monotone goal to
 * `boundedSearch` and reporting it with `fragment`/`bound` set, the
 * monotone fixtures still routing through §5/§6 unchanged (now labeled
 * `fragment: 'monotone'`), and `MAX_BOUNDED_CANDIDATES` refusing to run
 * rather than hang.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import type { CompiledSchema } from '../../../src/schema/dsl/types.js';
import {
  boundedSearch,
  generateCandidateTuples,
  MAX_BOUNDED_CANDIDATES,
} from '../src/bounded/index.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import { parseInvariants } from '../src/invariants/index.js';
import type { Invariant } from '../src/invariants/index.js';
import { scanReachability } from '../src/reachability/index.js';
import type { WitnessTuple } from '../src/reachability/index.js';
import { checkAndValidate } from '../src/validate/index.js';

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

describe('scanReachability — telling the monotone and non-monotone fragments apart', () => {
  it('tenancy.authz — document#view never crosses an intersection/exclusion edge: monotone', () => {
    const tenancy = loadSchema(SCHEMA_FIXTURE_DIR, 'tenancy.authz');
    const graph = buildSchemaGraph(tenancy);
    const scan = scanReachability(graph, 'document#view');
    expect(scan.fragment).toBe('monotone');
  });

  it('non-monotone.authz — document#approve crosses an intersectionChild edge: non-monotone', () => {
    const schema = loadSchema(SCHEMA_FIXTURE_DIR, 'non-monotone.authz');
    const graph = buildSchemaGraph(schema);
    const scan = scanReachability(graph, 'document#approve');
    expect(scan.fragment).toBe('non-monotone');
    expect(scan.relations).toEqual(
      expect.arrayContaining(['document#editor', 'document#reviewer']),
    );
  });

  it('non-monotone.authz — document#publish crosses an exclusion edge: non-monotone', () => {
    const schema = loadSchema(SCHEMA_FIXTURE_DIR, 'non-monotone.authz');
    const graph = buildSchemaGraph(schema);
    const scan = scanReachability(graph, 'document#publish');
    expect(scan.fragment).toBe('non-monotone');
    expect(scan.relations).toEqual(expect.arrayContaining(['document#editor', 'document#blocked']));
  });
});

describe('checkAndValidate — §7 routes the non-monotone fragment to bounded search', () => {
  const nonMonotone = loadSchema(SCHEMA_FIXTURE_DIR, 'non-monotone.authz');
  const graph = buildSchemaGraph(nonMonotone);

  it('approve_reachable_via_intersection — VIOLATED up to k = 1: the real engine allows the same user as both editor and reviewer', async () => {
    const invariant = loadInvariant('intersection-approve.invariant');
    const { result, validation } = await checkAndValidate(graph, nonMonotone, invariant);

    expect(result.fragment).toBe('non-monotone');
    expect(result.verdict).toBe('VIOLATED');
    expect(result.witness).toBeDefined();
    expect(result.witness!.length).toBeGreaterThan(0);
    // Every verdict boundedSearch returns already came from the real
    // engine directly — no separate replay/fuzz step to run.
    expect(validation).toEqual({ kind: 'not-applicable' });
  });

  it('blocked_user_cannot_publish — HOLDS up to k = 1: exclusion keeps a blocked subject blocked regardless of any other candidate tuple', async () => {
    const invariant = loadInvariant('exclusion-blocked-cannot-publish.invariant');
    const { result, validation } = await checkAndValidate(graph, nonMonotone, invariant);

    expect(result.fragment).toBe('non-monotone');
    expect(result.verdict).toBe('HOLDS');
    expect(result.bound).toBe(1);
    expect(validation).toEqual({ kind: 'not-applicable' });
  });

  it("blocked_user_cannot_publish's blocked(o) = s is honored as a fixed given fact, not merely one enumerable candidate — proven by a candidate set that would otherwise force VIOLATED", async () => {
    // A direct, cheap unit test of generateGivenTuples/boundedSearch's own
    // plumbing (docs/DECISIONS.md D-118), not just the end-to-end verdict
    // above: hand a single candidate tuple that makes s an editor of o. If
    // `blocked(o) = s` were left to the enumeration instead of always
    // given, the subset {editor(o) = s} alone would satisfy
    // `publish = editor - blocked` and this would wrongly report VIOLATED.
    // Because generateGivenTuples always writes blocked(o) = s first, even
    // this one-candidate, two-subset search still correctly reports
    // HOLDS — proving the given fact overrides what would otherwise be an
    // obvious counterexample, not just that no counterexample happened to
    // turn up.
    const invariant = loadInvariant('exclusion-blocked-cannot-publish.invariant');
    const oneCandidate: WitnessTuple[] = [
      {
        objectType: 'document',
        object: 'o',
        relation: 'editor',
        subjectType: 'user',
        subject: 's',
      },
    ];

    const result = await boundedSearch(nonMonotone, invariant, oneCandidate, 1);

    expect(result.verdict).toBe('HOLDS');
    expect(result.bound).toBe(1);
  });
});

describe('checkAndValidate — monotone fixtures still route through §5/§6, now labeled fragment: "monotone"', () => {
  it('tenant_isolation — VIOLATED, fragment: monotone, self-validation still runs', async () => {
    const tenancy = loadSchema(SCHEMA_FIXTURE_DIR, 'tenancy.authz');
    const graph = buildSchemaGraph(tenancy);
    const invariant = loadInvariant('tenant-isolation.invariant');
    const { result, validation } = await checkAndValidate(graph, tenancy, invariant);

    expect(result.fragment).toBe('monotone');
    expect(result.verdict).toBe('VIOLATED');
    expect(result.bound).toBeUndefined();
    expect(validation.kind).toBe('confirmed');
  });

  it('no_public_path_to_private_document — HOLDS, fragment: monotone, no bound set (bound is a §7-only concept)', async () => {
    const tenancy = loadSchema(SCHEMA_FIXTURE_DIR, 'tenancy.authz');
    const graph = buildSchemaGraph(tenancy);
    const invariant = loadInvariant('no-public-path-to-private-document.invariant');
    const { result, validation } = await checkAndValidate(graph, tenancy, invariant, {
      fuzz: { trials: 10, seed: 3 },
    });

    expect(result.fragment).toBe('monotone');
    expect(result.verdict).toBe('HOLDS');
    expect(result.bound).toBeUndefined();
    expect(validation).toEqual({ kind: 'empirically-clean', sampled: 10 });
  });
});

describe('boundedSearch — MAX_BOUNDED_CANDIDATES refuses to run rather than hang', () => {
  it('an oversized candidate list returns UNKNOWN with a clear reason, deliberately, without trying a single subset', async () => {
    const schema = loadSchema(SCHEMA_FIXTURE_DIR, 'non-monotone.authz');
    const invariant = loadInvariant('intersection-approve.invariant');
    const tooMany: WitnessTuple[] = Array.from({ length: MAX_BOUNDED_CANDIDATES + 1 }, (_, i) => ({
      objectType: 'document',
      object: 'o',
      relation: 'editor',
      subjectType: 'user',
      subject: `user_${i}`,
    }));

    const result = await boundedSearch(schema, invariant, tooMany, 1);

    expect(result.verdict).toBe('UNKNOWN');
    expect(result.fragment).toBe('non-monotone');
    expect(result.reason).toContain(String(MAX_BOUNDED_CANDIDATES));
    expect(result.reason).toContain('ceiling');
  });
});

describe("generateCandidateTuples — collectPoolNamespaces pools a relation's own subject type, independent of the invariant's own goal types", () => {
  it("still generates candidates for a subject-only type (`user`, not declared as its own namespace) when the invariant's own goal subject/object types are something else entirely", () => {
    // §8a's own mutation-testing exercise (docs/DECISIONS.md D-119,
    // mutation M7) found that a naive version of this test — reusing
    // `intersection-approve.invariant` (`s: user, o: document`) — doesn't
    // actually isolate `collectPoolNamespaces`'s own contribution: since
    // that invariant's own goal subject type already happens to be
    // `user`, `buildInstancePools`'s separate, unconditional
    // `namespaces.add(subjectType)` line masks a completely broken
    // `collectPoolNamespaces` and the test still passes for the wrong
    // reason. This probe instead declares goal subject/object types that
    // don't correspond to anything in the schema at all — so the only
    // way `user` can end up with a pool, and `editor`'s own candidate
    // tuples exist at all, is `collectPoolNamespaces` itself walking
    // `editor`'s real declared `subjectTypes`.
    const schema = loadSchema(SCHEMA_FIXTURE_DIR, 'non-monotone.authz');
    const source = [
      'invariant probe {',
      '  s: nonexistent_subject_type',
      '  o: nonexistent_object_type',
      '  goal: editor(s, o)',
      '}',
    ].join('\n');
    const parsed = parseInvariants(source);
    if (!parsed.ok) throw new Error('probe invariant failed to parse');
    const invariant = parsed.invariants[0]!;

    const candidates = generateCandidateTuples(schema, ['document#editor'], invariant, 1);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.subjectType === 'user')).toBe(true);
  });
});
