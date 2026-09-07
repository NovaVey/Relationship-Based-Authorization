/**
 * `neverRelation` — the invariant language's `never <namespace>#<relation>
 * (<var>)` primitive (`docs/DECISIONS.md`, the entry adding
 * `NeverRelationConstraint`), closing the gap `NotRelationEqualsConstraint`'s
 * own doc comment names as deliberately out of its scope: "this relation
 * can never be satisfied via any object, anywhere." Unlike
 * `notRelationEquals` (excludes one already-known triple, bare-principal
 * only), this excludes the *entire* declared relation from ever resolving
 * the invariant's own goal subject — via its bare-principal branch, a
 * wildcard-declared branch, or any userset-subject branch it declares —
 * at any object, named or freshly introduced mid-search, at any recursion
 * depth.
 *
 * **Namespace-qualified by design, not just convention** — a real,
 * adversarially-found unsoundness the design process behind this
 * primitive caught before shipping: two unrelated namespaces routinely
 * declare a same-named relation (this project's own third-party fixture
 * corpus has `team.member` and `group.member`, both real and unrelated).
 * A bare-relation-name match would silently block both whenever they
 * share a name — see the "cross-namespace collision" describe block
 * below for the live counter-example this exact design flaw was caught
 * with, and why the grammar requires `<namespace>#<relation>` (reusing
 * the schema DSL's own `type#relation` userset-subject notation) rather
 * than a bare relation name.
 *
 * Enforced at three sites, all covered below:
 *
 * - The exact search's `direct`-edge dispatch (`../src/reachability/
 *   search.ts`) — checked ONCE per dispatch, before either subject-type
 *   branch is tried, since a match means the whole node can never grant
 *   the fixed goal subject, via any of its own declared branches.
 * - The bounded search's candidate generation (`../src/bounded/
 *   candidates.ts`) — drops bare-principal candidates matching the
 *   constraint's own subject, and userset-subject/wildcard candidates
 *   for the blocked relation unconditionally.
 * - The SMT and CHC tiers (`../src/smt/{encode,chc}.ts`) both decline
 *   outright whenever a `neverRelation` constraint is present — a real,
 *   disclosed scope boundary (see the "SMT/CHC tiers decline" describe
 *   block), not silently mis-encoded.
 *
 * Real-world value: closes 6 of the 8 `VIOLATED` third-party survey
 * entries `notRelationEquals` (D-131) could not — see
 * `thirdparty-survey.test.ts` for the corpus-wide tally (now 2 VIOLATED,
 * 10 HOLDS) and this file's own "Integration" describe block below for
 * each entry closed end to end, against the real, committed fixture
 * files.
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
import { trySmtTier } from '../src/smt/index.js';
import { tryChcTier } from '../src/smt/chc.js';

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

describe('parseInvariants — never <namespace>#<relation>(<var>) syntax', () => {
  it('a well-formed line parses into a neverRelation constraint', () => {
    const result = parseInvariants(
      [
        'invariant valid_never {',
        '  s: user',
        '  o: org',
        '  never team#member(s)',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invariants[0]!.constraints).toContainEqual({
      kind: 'neverRelation',
      namespace: 'team',
      relation: 'member',
      subject: 's',
    });
  });

  it('a bare, unqualified relation name (no "#") is rejected as unparseable — the unsound form is structurally inexpressible', () => {
    const result = parseInvariants(
      [
        'invariant bare_never {',
        '  s: user',
        '  o: org',
        '  never member(s)',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes('unrecognized line'))).toBe(true);
  });

  it('an undeclared variable is rejected', () => {
    const result = parseInvariants(
      [
        'invariant undeclared_never {',
        '  s: user',
        '  o: org',
        '  never team#member(x)',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes("undeclared variable 'x'"))).toBe(true);
  });

  it('"never" is reserved and cannot be used as a variable name', () => {
    const result = parseInvariants(
      ['invariant reserved_never {', '  never: user', '  goal: admin(never, never)', '}'].join(
        '\n',
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.message.includes('reserved word'))).toBe(true);
  });
});

describe('checkInvariant — neverRelation blocks the whole relation, both branches, at the exact search', () => {
  it('baseline: a bare-principal direct grant is a plain VIOLATED with no constraint', () => {
    const { schema, graph } = inlineGraph(`
      namespace org {
        relation admin: user
      }
    `);
    const inv = inlineInvariant(
      ['invariant no_never {', '  s: user', '  o: org', '  goal: admin(s, o)', '}'].join('\n'),
    );
    const result = checkInvariant(graph, schema, inv);
    expect(result.verdict).toBe('VIOLATED');
  });

  it('"never org#admin(s)" removes the bare-principal escape — VIOLATED flips to HOLDS', () => {
    const { schema, graph } = inlineGraph(`
      namespace org {
        relation admin: user
      }
    `);
    const inv = inlineInvariant(
      [
        'invariant with_never {',
        '  s: user',
        '  o: org',
        '  never org#admin(s)',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );
    expect(checkInvariant(graph, schema, inv)).toEqual({ verdict: 'HOLDS' });
  });

  it('"never repo#admin_direct(s)" also closes the sibling userset-subject branch — the escape notRelationEquals cannot reach', () => {
    // Mirrors openfga-github's own real shape: admin_direct accepts EITHER
    // a bare user grant OR a team#member userset-subject grant. Blocking
    // only the bare form (D-131's own notRelationEquals) leaves this
    // second escape wide open — this is exactly the gap neverRelation
    // exists to close.
    const { schema, graph } = inlineGraph(`
      namespace team {
        relation member: user | team#member
      }
      namespace repo {
        relation admin_direct: user | team#member
        permission admin = admin_direct
      }
    `);
    const withNotOnly = inlineInvariant(
      [
        'invariant not_only {',
        '  s: user',
        '  r: repo',
        '  not admin_direct(r) = s',
        '  goal: admin(s, r)',
        '}',
      ].join('\n'),
    );
    const stillViolated = checkInvariant(graph, schema, withNotOnly);
    expect(stillViolated.verdict).toBe('VIOLATED');
    expect(stillViolated.witness).toEqual([
      {
        objectType: 'repo',
        object: 'r',
        relation: 'admin_direct',
        subjectType: 'team',
        subject: 'obj1',
        subjectRelation: 'member',
      },
      { objectType: 'team', object: 'obj1', relation: 'member', subjectType: 'user', subject: 's' },
    ]);

    const withNever = inlineInvariant(
      [
        'invariant with_never {',
        '  s: user',
        '  r: repo',
        '  never repo#admin_direct(s)',
        '  goal: admin(s, r)',
        '}',
      ].join('\n'),
    );
    expect(checkInvariant(graph, schema, withNever)).toEqual({ verdict: 'HOLDS' });
  });

  it('the recursive team#member chain is closed at every depth by the same single line — never needs to name team#member separately', () => {
    const { schema, graph } = inlineGraph(`
      namespace team {
        relation member: user | team#member
      }
      namespace repo {
        relation admin_direct: user | team#member
        permission admin = admin_direct
      }
    `);
    const inv = inlineInvariant(
      [
        'invariant recursive_check {',
        '  s: user',
        '  r: repo',
        '  never repo#admin_direct(s)',
        '  goal: admin(s, r)',
        '}',
      ].join('\n'),
    );
    // Even though team#member is itself recursive, blocking admin_direct's
    // own userset-subject branch means the search never even descends
    // into team#member's own reachability at all.
    expect(checkInvariant(graph, schema, inv)).toEqual({ verdict: 'HOLDS' });
  });
});

describe('checkInvariant — given-fact exemption: a relationEquals given is honored, not silently contradicted', () => {
  const { schema, graph } = inlineGraph(`
    namespace group {
      relation member: user
    }
    namespace doc {
      relation viewer: user
    }
  `);

  it('without exemption logic this would be a contradiction — confirmed it is NOT: HOLDS, not UNKNOWN', () => {
    const inv = inlineInvariant(
      [
        'invariant exempted {',
        '  a: user',
        '  g: group',
        '  d: doc',
        '  member(g) = a',
        '  never group#member(a)',
        '  never doc#viewer(a)',
        '  goal: viewer(a, d)',
        '}',
      ].join('\n'),
    );
    const result = checkInvariant(graph, schema, inv);
    // The given member(g) = a is exempted from "never group#member(a)"
    // (it's the invariant's own legitimate premise, not an adversarial
    // extra grant) — but doc#viewer has no given at all, so its own
    // bare-principal escape is fully blocked. Neither UNKNOWN
    // (self-contradiction) nor VIOLATED (over-permissive) — HOLDS.
    expect(result).toEqual({ verdict: 'HOLDS' });
  });

  it('negative control — pinning the given to the SAME object the goal would need does not silently suppress a real violation', () => {
    const inv = inlineInvariant(
      [
        'invariant not_over_blocked {',
        '  a: user',
        '  g: group',
        '  d: doc',
        '  member(g) = a',
        '  never group#member(a)',
        // No `never doc#viewer(a)` here — viewer is left open, so a
        // direct grant on it should still be found.
        '  goal: viewer(a, d)',
        '}',
      ].join('\n'),
    );
    const result = checkInvariant(graph, schema, inv);
    expect(result.verdict).toBe('VIOLATED');
  });
});

describe("checkInvariant — cross-namespace collision: the real, adversarially-found design defect this primitive's grammar closes", () => {
  // Two different, unrelated relations sharing the bare name "member" —
  // exactly the shape this project's own thirdparty corpus already has
  // (team.member, group.member). A namespace-UNqualified "never member(s)"
  // would have blocked both, silently discarding a genuine violation
  // through the unrelated one. The namespace-qualified grammar makes that
  // shape unparseable in the first place (see the parser describe block
  // above) — this proves the QUALIFIED form correctly distinguishes them.
  const { schema, graph } = inlineGraph(`
    namespace team {
      relation member: user | team#member
    }
    namespace group {
      relation member: user
    }
    namespace repo {
      relation admin_direct: user | team#member
      relation viewer_direct: group#member
      permission view = admin_direct | viewer_direct
    }
  `);

  it('blocking team#member specifically leaves the unrelated group#member escape correctly VIOLATED', () => {
    const inv = inlineInvariant(
      [
        'invariant collision_check {',
        '  s: user',
        '  r: repo',
        '  not admin_direct(r) = s',
        '  never team#member(s)',
        '  goal: view(s, r)',
        '}',
      ].join('\n'),
    );
    const result = checkInvariant(graph, schema, inv);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.witness).toEqual([
      {
        objectType: 'repo',
        object: 'r',
        relation: 'viewer_direct',
        subjectType: 'group',
        subject: 'obj1',
        subjectRelation: 'member',
      },
      {
        objectType: 'group',
        object: 'obj1',
        relation: 'member',
        subjectType: 'user',
        subject: 's',
      },
    ]);
  });

  it('blocking BOTH team#member and group#member correctly reaches HOLDS — proving the collision test above genuinely distinguishes the two relations, not merely fails to find any witness at all', () => {
    const inv = inlineInvariant(
      [
        'invariant both_blocked {',
        '  s: user',
        '  r: repo',
        '  not admin_direct(r) = s',
        '  never team#member(s)',
        '  never group#member(s)',
        '  goal: view(s, r)',
        '}',
      ].join('\n'),
    );
    expect(checkInvariant(graph, schema, inv)).toEqual({ verdict: 'HOLDS' });
  });
});

describe('generateCandidateTuples — neverRelation drops bare-principal, userset-subject, and wildcard candidates for the blocked relation', () => {
  it("drops the bare-principal candidate matching the constraint's own subject, leaving every other combination untouched", () => {
    const { schema } = inlineGraph(`
      namespace org {
        relation admin: user
      }
    `);
    const withNever = inlineInvariant(
      [
        'invariant with_never {',
        '  s: user',
        '  o: org',
        '  never org#admin(s)',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );
    const withoutNever = inlineInvariant(
      ['invariant no_never {', '  s: user', '  o: org', '  goal: admin(s, o)', '}'].join('\n'),
    );

    // k = 0: pools contain only the goal's own subject/object labels (no
    // generic instances), so there is exactly one candidate to drop —
    // keeps this test's arithmetic simple and unambiguous.
    const baseline = generateCandidateTuples(schema, ['org#admin'], withoutNever, 0);
    const blocked = generateCandidateTuples(schema, ['org#admin'], withNever, 0);

    const droppedTuple = {
      objectType: 'org',
      object: 'o',
      relation: 'admin',
      subjectType: 'user',
      subject: 's',
    };
    expect(baseline).toEqual([droppedTuple]);
    expect(blocked).toEqual([]);
  });

  it("drops every userset-subject candidate for the blocked relation unconditionally, while leaving the userset target relation's own candidates untouched", () => {
    const { schema } = inlineGraph(`
      namespace team {
        relation member: user
      }
      namespace repo {
        relation admin_direct: user | team#member
      }
    `);
    const inv = inlineInvariant(
      [
        'invariant blocked {',
        '  s: user',
        '  r: repo',
        '  never repo#admin_direct(s)',
        '  goal: admin_direct(s, r)',
        '}',
      ].join('\n'),
    );

    const candidates = generateCandidateTuples(
      schema,
      ['repo#admin_direct', 'team#member'],
      inv,
      1,
    );

    expect(
      candidates.some((c) => c.relation === 'admin_direct' && c.subjectRelation === 'member'),
    ).toBe(false);
    expect(candidates.some((c) => c.relation === 'admin_direct' && c.subject === 's')).toBe(false);
    // team#member's own candidates are completely unaffected — this
    // primitive blocks admin_direct's own userset-subject branch, never
    // chases into the target relation itself.
    expect(
      candidates.some(
        (c) => c.relation === 'member' && c.objectType === 'team' && c.subjectType === 'user',
      ),
    ).toBe(true);
  });

  it('drops every wildcard candidate for the blocked relation unconditionally', () => {
    const { schema } = inlineGraph(`
      namespace org {
        relation admin: user:*
      }
    `);
    const inv = inlineInvariant(
      [
        'invariant blocked_wildcard {',
        '  s: user',
        '  o: org',
        '  never org#admin(s)',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );

    const candidates = generateCandidateTuples(schema, ['org#admin'], inv, 1);
    expect(candidates).toHaveLength(0);
  });
});

describe('SMT/CHC tiers decline outright whenever a neverRelation constraint is present — a disclosed scope boundary, not a mis-encoding', () => {
  it('trySmtTier returns undefined (declines) for an invariant carrying a neverRelation constraint, even a non-recursive intersection it would otherwise decide', async () => {
    const { schema, graph } = inlineGraph(`
      namespace doc {
        relation editor: user
        relation viewer: user
        relation banned: user
        permission approve = editor & viewer
      }
    `);
    const withoutNever = inlineInvariant(
      [
        'invariant control {',
        '  s: user',
        '  o: doc',
        '  editor(o) = s',
        '  goal: approve(s, o)',
        '}',
      ].join('\n'),
    );
    const withNever = inlineInvariant(
      [
        'invariant with_never {',
        '  s: user',
        '  o: doc',
        '  editor(o) = s',
        '  never doc#banned(s)',
        '  goal: approve(s, o)',
        '}',
      ].join('\n'),
    );

    const controlTier = await trySmtTier(graph, schema, withoutNever);
    expect(controlTier).toBeDefined();
    expect(controlTier?.result.verdict).toBe('VIOLATED');

    const declinedTier = await trySmtTier(graph, schema, withNever);
    expect(declinedTier).toBeUndefined();

    // The invariant is still correctly decided end to end — declining
    // this tier routes it on to bounded search instead, never a silently
    // wrong verdict.
    const { result } = await checkAndValidate(graph, schema, withNever);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.proof).toBe('bounded');
  });

  it('tryChcTier returns undefined (declines) for a genuinely recursive goal that would otherwise decide it, when a neverRelation constraint is present', async () => {
    const { schema, graph } = inlineGraph(`
      namespace groupx {
        relation member: user | groupx#member
        permission view = member
      }
      namespace docx2 {
        relation viewer: user | groupx#member
        relation sensitive_reviewer: user | groupx#member
        permission sensitive_review = viewer & sensitive_reviewer
      }
    `);
    const withoutNever = inlineInvariant(
      [
        'invariant control {',
        '  s: user',
        '  o: docx2',
        '  goal: sensitive_review(s, o)',
        '}',
      ].join('\n'),
    );
    const withNever = inlineInvariant(
      [
        'invariant with_never {',
        '  s: user',
        '  o: docx2',
        '  never docx2#sensitive_reviewer(s)',
        '  goal: sensitive_review(s, o)',
        '}',
      ].join('\n'),
    );

    const controlTier = await tryChcTier(graph, schema, withoutNever);
    expect(controlTier).toBeDefined();

    const declinedTier = await tryChcTier(graph, schema, withNever);
    expect(declinedTier).toBeUndefined();
  });
});

describe('Integration — all 6 previously-VIOLATED third-party survey entries close end to end (docs/DECISIONS.md, the entry adding NeverRelationConstraint)', () => {
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

  it.each([
    'openfga-github',
    'spicedb-superuser',
    'spicedb-docs-style-sharing',
    'openfga-gdrive',
    'openfga-slack',
    'spicedb-github',
  ])('%s now HOLDS (exact) with its never lines added', async (basename) => {
    const { schema, graph, invariant } = loadFixture(basename);
    const { result, validation } = await checkAndValidate(graph, schema, invariant, {
      fuzz: { trials: 10, seed: 3 },
    });

    expect(result.verdict).toBe('HOLDS');
    expect(result.fragment).toBe('monotone');
    expect(result.proof).toBe('exact');
    expect(validation).toEqual({ kind: 'empirically-clean', sampled: 10 });
  });
});
