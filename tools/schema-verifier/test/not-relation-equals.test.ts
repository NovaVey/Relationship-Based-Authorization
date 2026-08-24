/**
 * `notRelationEquals` — the invariant language's `not <relation>(<var>) =
 * <var>` primitive (`docs/DECISIONS.md` D-131, extending build spec §4).
 * Deliberately narrow: `subject` and `value` must both already be
 * declared invariant variables (no fresh/existential form), and `value`
 * is always a bare principal (no userset-subject form) — see
 * `NotRelationEqualsConstraint`'s own doc comment
 * (`src/invariants/types.ts`) for the full scope statement.
 *
 * Enforced independently at two sites, both covered below:
 *
 * - The exact search's bare-principal direct-edge dispatch
 *   (`src/reachability/search.ts`, `attempt()`'s site 1 — NOT the
 *   sibling userset-subject branch, NOT `tupleToUserset`'s dispatch).
 * - The bounded search's candidate generation
 *   (`src/bounded/candidates.ts`, bare-principal candidates only).
 *
 * Real-world value, honestly scoped (D-131): closes exactly 2 of the 9
 * `VIOLATED` entries `docs/FINDINGS.md` disclosed before this primitive
 * existed — `spicedb-entitlements` and `openfga-entitlements`, both a
 * single-chain closure with no alternate union branch offering a second
 * escape. The other 6 "same shape" entries have a structurally
 * different, unbounded escape (a second, userset-subject or recursive
 * path this narrow primitive was never designed to reach) and stay
 * `VIOLATED` — this file does NOT assert `HOLDS` for any of them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { generateCandidateTuples } from '../src/bounded/index.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import { parseInvariants } from '../src/invariants/index.js';
import { checkInvariant } from '../src/reachability/index.js';
import { checkAndValidate } from '../src/validate/index.js';

function inlineGraph(source: string) {
  const compiled = compileSchema(source);
  if (!compiled.ok) {
    throw new Error(`inline schema failed to compile: ${JSON.stringify(compiled.errors)}`);
  }
  return { schema: compiled.schema, graph: buildSchemaGraph(compiled.schema) };
}

function inlineInvariant(source: string) {
  const parsed = parseInvariants(source);
  if (!parsed.ok) {
    throw new Error(`inline invariant failed to parse: ${JSON.stringify(parsed.errors)}`);
  }
  return parsed.invariants[0]!;
}

describe('checkInvariant — notRelationEquals excludes exactly the named triple at the bare-principal direct edge', () => {
  const { schema, graph } = inlineGraph(`
    namespace org {
      relation admin: user
    }
  `);

  it('without the exclusion, a bare direct grant is a plain VIOLATED (baseline)', () => {
    const inv = inlineInvariant(
      ['invariant no_exclusion {', '  s: user', '  o: org', '  goal: admin(s, o)', '}'].join('\n'),
    );
    const result = checkInvariant(graph, schema, inv);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.witness).toEqual([
      { objectType: 'org', object: 'o', relation: 'admin', subjectType: 'user', subject: 's' },
    ]);
  });

  it('"not admin(o) = s" removes the only witness — VIOLATED flips to HOLDS', () => {
    const inv = inlineInvariant(
      [
        'invariant with_exclusion {',
        '  s: user',
        '  o: org',
        '  not admin(o) = s',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );
    expect(checkInvariant(graph, schema, inv)).toEqual({ verdict: 'HOLDS' });
  });

  it("negative control — excluding a DIFFERENT subject variable does not block the goal subject's own grant", () => {
    const inv = inlineInvariant(
      [
        'invariant sibling_subject_not_excluded {',
        '  s: user',
        '  x: user',
        '  o: org',
        '  distinct(s, x)',
        '  not admin(o) = x',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );
    const result = checkInvariant(graph, schema, inv);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.witness).toEqual([
      { objectType: 'org', object: 'o', relation: 'admin', subjectType: 'user', subject: 's' },
    ]);
  });

  it("negative control — excluding the same relation/value on a DIFFERENT object variable does not block the goal object's own grant", () => {
    const inv = inlineInvariant(
      [
        'invariant sibling_object_not_excluded {',
        '  s: user',
        '  o: org',
        '  o2: org',
        '  distinct(o, o2)',
        '  not admin(o2) = s',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );
    const result = checkInvariant(graph, schema, inv);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.witness).toEqual([
      { objectType: 'org', object: 'o', relation: 'admin', subjectType: 'user', subject: 's' },
    ]);
  });
});

describe('checkInvariant — upfront contradiction detection between relationEquals and notRelationEquals', () => {
  const { schema, graph } = inlineGraph(`
    namespace org {
      relation admin: user
    }
  `);

  it('a literal, direct contradiction ("admin(o) = s" and "not admin(o) = s" on the same names) is UNKNOWN, never a search', () => {
    const inv = inlineInvariant(
      [
        'invariant self_contradictory {',
        '  s: user',
        '  o: org',
        '  admin(o) = s',
        '  not admin(o) = s',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );
    const result = checkInvariant(graph, schema, inv);
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.reason).toContain('conflicts with a relationEquals');
  });

  it('an ALIASED contradiction — two relationEquals lines on the same slot unify y and s before "not admin(o) = s" is checked — is still caught', () => {
    // Mirrors the D-129 aliasing fix's own pattern (reachability.test.ts):
    // two relationEquals lines pinning the SAME (object, relation) slot
    // to two different declared names merges those names via
    // `UnionFind.bindSlot`'s own `union()` call. The slot's own raw
    // stored value stays the literal string 'y' (whichever name bound
    // first) — this test exists specifically to confirm the
    // contradiction check resolves 'y' and 's' as the same object
    // through `slotEquals`'s own `same()` call, not by literal string
    // match, so an aliased conflict isn't silently missed.
    const inv = inlineInvariant(
      [
        'invariant aliased_contradiction {',
        '  s: user',
        '  y: user',
        '  o: org',
        '  admin(o) = y',
        '  admin(o) = s',
        '  not admin(o) = s',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );
    const result = checkInvariant(graph, schema, inv);
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.reason).toContain('conflicts with a relationEquals');
  });
});

describe('generateCandidateTuples — notRelationEquals excludes exactly the named bare-principal candidate', () => {
  it('drops only the (o, admin, s) candidate, leaving every other type-valid combination untouched', () => {
    const { schema } = inlineGraph(`
      namespace org {
        relation admin: user
      }
    `);
    const withExclusion = inlineInvariant(
      [
        'invariant with_exclusion {',
        '  s: user',
        '  o: org',
        '  not admin(o) = s',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );
    const withoutExclusion = inlineInvariant(
      ['invariant no_exclusion {', '  s: user', '  o: org', '  goal: admin(s, o)', '}'].join('\n'),
    );

    const baseline = generateCandidateTuples(schema, ['org#admin'], withoutExclusion, 1);
    const excluded = generateCandidateTuples(schema, ['org#admin'], withExclusion, 1);

    const droppedTuple = {
      objectType: 'org',
      object: 'o',
      relation: 'admin',
      subjectType: 'user',
      subject: 's',
    };
    expect(baseline).toContainEqual(droppedTuple);
    expect(excluded).not.toContainEqual(droppedTuple);
    // Exactly one candidate dropped — every other (object, subject) pair
    // this small pool produces is untouched.
    expect(excluded.length).toBe(baseline.length - 1);
  });

  it('never filters a userset-subject candidate sharing the same object/relation/subject labels — bare-principal-only guard', () => {
    // `user#follower` and a bare `user` subject share one pool (both
    // resolve to the `user` namespace's own instance labels), so this is
    // the one schema shape where a userset-subject candidate can
    // literally share every label with an excluded bare-principal triple
    // — exactly the case `generateCandidateTuples`'s own `st.relation ===
    // undefined` guard exists to protect.
    const { schema } = inlineGraph(`
      namespace user {
        relation follower: user
      }
      namespace org {
        relation admin: user | user#follower
      }
    `);
    const inv = inlineInvariant(
      [
        'invariant admin_userset_guard {',
        '  s: user',
        '  o: org',
        '  not admin(o) = s',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );

    const candidates = generateCandidateTuples(schema, ['org#admin'], inv, 1);

    expect(candidates).not.toContainEqual({
      objectType: 'org',
      object: 'o',
      relation: 'admin',
      subjectType: 'user',
      subject: 's',
    });
    expect(candidates).toContainEqual({
      objectType: 'org',
      object: 'o',
      relation: 'admin',
      subjectType: 'user',
      subject: 's',
      subjectRelation: 'follower',
    });
  });
});

describe('Integration — the two disclosed entitlements fixtures close end to end (docs/DECISIONS.md D-131)', () => {
  const THIRDPARTY_DIR = fileURLToPath(new URL('../thirdparty/', import.meta.url));

  function loadFixture(basename: string) {
    const source = readFileSync(THIRDPARTY_DIR + `${basename}.authz`, 'utf8');
    const compiled = compileSchema(source);
    if (!compiled.ok) throw new Error(`${basename}.authz failed to compile`);
    const graph = buildSchemaGraph(compiled.schema);
    const parsed = parseInvariants(readFileSync(THIRDPARTY_DIR + `${basename}.invariant`, 'utf8'));
    if (!parsed.ok) throw new Error(`${basename}.invariant failed to parse`);
    return { schema: compiled.schema, graph, invariant: parsed.invariants[0]! };
  }

  it('spicedb-entitlements: feature_access_requires_membership_in_entitled_org now HOLDS (exact) with "not member(o2) = u" added', async () => {
    const { schema, graph, invariant } = loadFixture('spicedb-entitlements');
    const { result, validation } = await checkAndValidate(graph, schema, invariant, {
      fuzz: { trials: 10, seed: 3 },
    });

    expect(result.verdict).toBe('HOLDS');
    expect(result.fragment).toBe('monotone');
    expect(result.proof).toBe('exact');
    expect(validation).toEqual({ kind: 'empirically-clean', sampled: 10 });
  });

  it('openfga-entitlements: feature_access_requires_subscription_in_associated_org now HOLDS (exact) with "not member(o2) = u" added', async () => {
    const { schema, graph, invariant } = loadFixture('openfga-entitlements');
    const { result, validation } = await checkAndValidate(graph, schema, invariant, {
      fuzz: { trials: 10, seed: 3 },
    });

    expect(result.verdict).toBe('HOLDS');
    expect(result.fragment).toBe('monotone');
    expect(result.proof).toBe('exact');
    expect(validation).toEqual({ kind: 'empirically-clean', sampled: 10 });
  });
});

describe('Regression — the other 7 disclosed VIOLATED entries are untouched (not over-claimed as closed)', () => {
  const THIRDPARTY_DIR = fileURLToPath(new URL('../thirdparty/', import.meta.url));

  it.each([
    'openfga-github',
    'openfga-expenses',
    'spicedb-superuser',
    'spicedb-docs-style-sharing',
    'openfga-gdrive',
    'openfga-slack',
    'spicedb-github',
  ])(
    '%s stays VIOLATED — this primitive does not (and was never claimed to) close it',
    (basename) => {
      const source = readFileSync(THIRDPARTY_DIR + `${basename}.authz`, 'utf8');
      const compiled = compileSchema(source);
      if (!compiled.ok) throw new Error(`${basename}.authz failed to compile`);
      const graph = buildSchemaGraph(compiled.schema);
      const parsed = parseInvariants(
        readFileSync(THIRDPARTY_DIR + `${basename}.invariant`, 'utf8'),
      );
      if (!parsed.ok) throw new Error(`${basename}.invariant failed to parse`);

      const result = checkInvariant(graph, compiled.schema, parsed.invariants[0]!);
      expect(result.verdict).toBe('VIOLATED');
    },
  );
});
