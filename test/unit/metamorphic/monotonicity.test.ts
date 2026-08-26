/**
 * Unit tests for `src/metamorphic/monotonicity.ts`'s `classifyMonotone` —
 * DB-free, pure, plain `vitest run` (no Postgres, no resolver, no
 * generator-runner). These tests exist to establish trust in the
 * classifier BEFORE anything downstream (PROPERTY 4's own metamorphic test)
 * is allowed to rely on its verdicts — matching this project's own
 * discipline of never trusting a new piece of oracle-adjacent machinery
 * before it's independently checked against hand-derived examples (see
 * `.claude/commands/build-authz-service.md` §6 non-negotiables and the
 * reference resolver's own Phase 3 exit criteria for the same discipline
 * applied to a different piece of machinery).
 *
 * Six cases, each targeting one distinct part of `classifyMonotone`'s own
 * stated contract (see `monotonicity.ts`'s top doc comment for the full
 * algorithm this mirrors):
 *
 *   1. plain relation -> monotone (the base case, unconditional).
 *   2. union of two relations -> monotone.
 *   3. intersection of two relations -> monotone (the case a naive
 *      "exclusion OR intersection bans monotonicity" reading gets WRONG).
 *   4. exclusion -> NOT monotone (the one genuinely non-monotone
 *      rewrite-rule kind).
 *   5. `generateFixture`'s own guaranteed schema shapes, exercising the
 *      classifier against real (compiler-produced, not hand-built)
 *      `CompiledPermission`/`CompiledRelation` values, including the
 *      disclosed conservative-on-cycles behavior on hier's self-referential
 *      `view = editor | parent->view`.
 *   6. a deliberately adversarial cycle, constructed specifically to catch
 *      an "optimistic memoization" regression: an exclusion reachable
 *      through a cycle's closure via a leaf OTHER than the cycle's own
 *      back-edge.
 *
 * Cases 1-4 and 6 hand-build a `CompiledSchema` object literal directly
 * (bypassing `compileSchema`/the DSL parser entirely) — this is
 * deliberate, not a shortcut: `classifyMonotone`'s own public contract
 * operates on the `CompiledSchema` *shape* (`src/schema/dsl/types.ts`),
 * and hand-building the shape directly lets each test isolate exactly one
 * rewrite-rule kind at a time, with no dependency on DSL surface syntax or
 * the compiler's own correctness. Case 5 instead drives the real
 * `compileSchema` + `generateFixture` pipeline, so at least one test in
 * this file exercises the classifier against the same `CompiledSchema`
 * shape the rest of this project's own machinery actually produces, not
 * only hand-built stand-ins.
 *
 * **A second block, below, tests `findFlippableExclusion`** — the small,
 * focused extension of this same file's own AST-walk shape that locates a
 * real `ExclusionRule` (and its base/subtract relation names) rather than
 * only classifying monotonicity as a boolean. This is what
 * `test/metamorphic/monotonicity.integration.test.ts`'s general Property 5
 * sweep uses to generalize its own witness construction across whichever
 * arbitrary, randomly-generated exclusion shape a given schema happens to
 * contain, instead of the narrow, single hand-verified shape the ORIGINAL
 * Property 5 (also in that file) is deliberately scoped to. Every case here
 * is DB-free and hand-built, same reasoning as cases 1-4/6 above — this
 * function's own contract is a pure schema-shape question, with no
 * dependency on real tuples or Postgres at all (constructing a real tuple
 * graph from what it finds is entirely the integration test's own job).
 */
import { describe, expect, it } from 'vitest';

import { classifyMonotone, findFlippableExclusion } from '../../../src/metamorphic/monotonicity.js';
import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { formatSchemaError } from '../../../src/schema/dsl/errors.js';
import { generateFixture } from '../../../src/soundness/generators.js';
import type { CompiledSchema, NamespaceConfig } from '../../../src/schema/dsl/types.js';

// ---------------------------------------------------------------------------
// Small hand-built-schema helpers — kept local to this test file
// deliberately (not imported from src/soundness/generators.ts or anywhere
// else): these tests need FULL control over exactly which rewrite-rule
// kind appears where, which a shared "build me a schema" helper tuned for
// a different purpose (fuzzing broad coverage) would not give cleanly.
// ---------------------------------------------------------------------------

function userRelation(name: string): NamespaceConfig['relations'][string] {
  return { kind: 'relation', name, subjectTypes: [{ namespace: 'user' }] };
}

function namespaceConfig(
  namespace: string,
  relations: NamespaceConfig['relations'],
  permissions: NamespaceConfig['permissions'],
): NamespaceConfig {
  return { namespace, relations, permissions };
}

function schemaOf(...namespaces: NamespaceConfig[]): CompiledSchema {
  const byName: Record<string, NamespaceConfig> = {};
  for (const ns of namespaces) byName[ns.namespace] = ns;
  return { namespaces: byName };
}

describe('classifyMonotone — case 1: a plain relation classifies monotone unconditionally', () => {
  it('a bare relation with only a plain `user` subject type is monotone', () => {
    // The base case the whole algorithm is built on: "a stored fact's own
    // membership test is monotone by definition of set growth under
    // insertion-only writes" (monotonicity.ts's own top doc comment).
    // There is no rewrite tree here at all — if this case were ever wrong,
    // every other case built on top of `computedUserset`/`tupleToUserset`
    // leaves recursing into a relation would also be silently wrong, since
    // they all bottom out here.
    const schema = schemaOf(namespaceConfig('doc', { owner: userRelation('owner') }, {}));
    expect(classifyMonotone(schema, 'doc', 'owner')).toBe(true);
  });
});

describe('classifyMonotone — case 2: a union of two relations classifies monotone', () => {
  it('view = editor | viewer, both plain relations, is monotone', () => {
    const schema = schemaOf(
      namespaceConfig(
        'doc',
        { editor: userRelation('editor'), viewer: userRelation('viewer') },
        {
          view: {
            kind: 'permission',
            name: 'view',
            rewrite: {
              kind: 'union',
              children: [
                { kind: 'computedUserset', name: 'editor' },
                { kind: 'computedUserset', name: 'viewer' },
              ],
            },
          },
        },
      ),
    );
    expect(classifyMonotone(schema, 'doc', 'view')).toBe(true);
  });
});

describe('classifyMonotone — case 3: an intersection of two relations classifies monotone (the naive-reading trap)', () => {
  it("trusted_edit = editor & owner, mirroring generateFixture's own trusted_edit shape, is monotone", () => {
    // This is the specific case a naive "exclusion OR intersection bans
    // monotonicity" reading of the spec would get WRONG. Intersection of
    // monotone functions is still monotone: a tuple write can only ever
    // GROW `editor`'s membership and GROW `owner`'s membership, so it can
    // only ever grow (never shrink) their intersection too — there is no
    // way for `editor & owner` to lose a member as a result of an
    // insertion-only write, unlike `viewer - banned` (case 4, below),
    // where growing `banned`'s membership actively shrinks the exclusion's
    // own result. Confirming this here pins down that `classifyMonotone`
    // correctly keeps INTERSECTION in scope as monotone-preserving, not
    // lumped in with exclusion.
    const schema = schemaOf(
      namespaceConfig(
        'doc',
        { editor: userRelation('editor'), owner: userRelation('owner') },
        {
          trusted_edit: {
            kind: 'permission',
            name: 'trusted_edit',
            rewrite: {
              kind: 'intersection',
              children: [
                { kind: 'computedUserset', name: 'editor' },
                { kind: 'computedUserset', name: 'owner' },
              ],
            },
          },
        },
      ),
    );
    expect(classifyMonotone(schema, 'doc', 'trusted_edit')).toBe(true);
  });
});

describe('classifyMonotone — case 4: an exclusion classifies NOT monotone', () => {
  it("unbanned_view = viewer - banned, mirroring generateFixture's own unbanned_view shape, is NOT monotone", () => {
    // The genuinely non-monotone case: writing a NEW `banned` tuple for a
    // subject who currently has `viewer` can flip that subject's
    // `unbanned_view` check from allowed to denied — a real check result
    // changing for the worse purely as a result of an ADDITIONAL write,
    // which is exactly what "monotone under insertion-only writes" rules
    // out. This is the one rewrite-rule kind this classifier treats as
    // unconditionally, unrecoverably non-monotone, regardless of what
    // `base`/`subtract` themselves contain.
    const schema = schemaOf(
      namespaceConfig(
        'doc',
        { viewer: userRelation('viewer'), banned: userRelation('banned') },
        {
          unbanned_view: {
            kind: 'permission',
            name: 'unbanned_view',
            rewrite: {
              kind: 'exclusion',
              base: { kind: 'computedUserset', name: 'viewer' },
              subtract: { kind: 'computedUserset', name: 'banned' },
            },
          },
        },
      ),
    );
    expect(classifyMonotone(schema, 'doc', 'unbanned_view')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 5: generateFixture's own guaranteed schema shapes.
// ---------------------------------------------------------------------------

function compileOk(source: string): CompiledSchema {
  const result = compileSchema(source);
  if (!result.ok) {
    throw new Error(
      `expected generateFixture's own schemaSource to compile, got errors:\n` +
        result.errors.map(formatSchemaError).join('\n'),
    );
  }
  return result.schema;
}

/**
 * Locates the three guaranteed, salted namespaces `generateFixture` always
 * builds, per this task's own shared context ("To find which salted name
 * plays which role for a given fixture..."). Never assumes positional
 * array order or a literal namespace name — every real salted name is
 * seed-derived and looked up structurally instead.
 */
function locateGuaranteedNamespaces(schema: CompiledSchema): {
  resourceNs: string;
  hierNs: string;
  groupNs: string;
} {
  const resourceEntry = Object.entries(schema.namespaces).find(
    ([, config]) => 'trusted_edit' in config.permissions && 'unbanned_view' in config.permissions,
  );
  if (!resourceEntry) {
    throw new Error(
      "locateGuaranteedNamespaces: no namespace declares both 'trusted_edit' and " +
        "'unbanned_view' — generateFixture is expected to always build exactly one " +
        '(the guaranteed resource namespace).',
    );
  }
  const [resourceNs, resourceConfig] = resourceEntry;

  const parentLink = resourceConfig.relations.parent_link;
  const hierSubjectType = parentLink?.subjectTypes[0];
  if (!hierSubjectType) {
    throw new Error(
      `locateGuaranteedNamespaces: resource namespace '${resourceNs}' has no ` +
        "'parent_link' relation with at least one subject type.",
    );
  }
  const hierNs = hierSubjectType.namespace;

  // resource's viewer/editor/owner relations always include the group
  // namespace as a userset subject type alongside `user` — find the
  // userset-typed one (the one WITH a `relation` field) to identify it,
  // per this task's own shared-context lookup method.
  const viewerRelation = resourceConfig.relations.viewer;
  const groupSubjectType = viewerRelation?.subjectTypes.find((st) => st.relation !== undefined);
  if (!groupSubjectType) {
    throw new Error(
      `locateGuaranteedNamespaces: resource namespace '${resourceNs}' has no ` +
        "userset-typed 'viewer' subject type.",
    );
  }
  const groupNs = groupSubjectType.namespace;

  return { resourceNs, hierNs, groupNs };
}

describe("classifyMonotone — case 5: generateFixture's own guaranteed schema shapes", () => {
  it('resource.view is NON-monotone (conservative-on-cycles through hier.view); trusted_edit is monotone; unbanned_view is not; group.member is monotone', () => {
    const fixture = generateFixture('classifier-unit-test-seed-1', 5);
    const schema = compileOk(fixture.schemaSource);
    const { resourceNs, groupNs } = locateGuaranteedNamespaces(schema);

    // resource.view = viewer | editor | owner | parent_link->view. The
    // last child recurses (via tupleToUserset) into hier.view, which is
    // itself `editor | parent->view` — and `parent->view` is a direct
    // self-reference: walking hier.view's own union reaches
    // `parent->view`, which recurses right back into hier.view, which is
    // still grey (on this very call's own DFS stack) at that point. Per
    // monotonicity.ts's own disclosed, deliberate incompleteness (a grey
    // node is conservatively classified `false`, "sound but incomplete" —
    // see that file's top doc comment), hier.view classifies NON-monotone
    // despite being genuinely, semantically monotone (a plain union of a
    // relation and a self-referential tupleToUserset edge, nothing
    // exclusionary anywhere in it) — and that NON-monotone verdict
    // propagates up through parent_link->view into resource.view too.
    // This is the specific, disclosed trade-off this task asked to be
    // confirmed explicitly: the expectation below is `false`, not a typo.
    expect(classifyMonotone(schema, resourceNs, 'view')).toBe(false);

    // trusted_edit = editor & owner — an intersection of two plain
    // relations, no exclusion anywhere and no cyclic leaf — classifies
    // monotone, exactly like case 3 above but now against a real,
    // compiler-produced CompiledPermission rather than a hand-built one.
    expect(classifyMonotone(schema, resourceNs, 'trusted_edit')).toBe(true);

    // unbanned_view = viewer - banned — a real ExclusionRule — classifies
    // NOT monotone, unconditionally, exactly like case 4 above.
    expect(classifyMonotone(schema, resourceNs, 'unbanned_view')).toBe(false);

    // group.member is a RELATION, not a permission — its self-referential
    // subject type (`<self>#member`) is a tuple-write-target declaration,
    // not a rewrite-tree edge, so classifyMonotone never even needs to be
    // called with a relation's own cyclic subject type as a scope concern:
    // `classifyNodeInternal`'s `relation` branch (monotonicity.ts) checks
    // `namespaceConfig.relations[name]` BEFORE it ever looks at
    // `relation.subjectTypes`, and returns `true` immediately without
    // inspecting them at all — so group.member's self-reference is simply
    // never walked, and this assertion exercises exactly that path (as
    // opposed to hier.view above, whose cycle IS a rewrite-tree edge and
    // DOES get walked, with the opposite, conservative outcome).
    expect(classifyMonotone(schema, groupNs, 'member')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 6: a deliberately adversarial cycle.
// ---------------------------------------------------------------------------

describe('classifyMonotone — case 6: an adversarial cycle whose exclusion is reachable via a leaf other than the back-edge', () => {
  it('perm_a -> perm_b -> (exclusion | perm_a): classifies NON-monotone, not fooled by optimistic memoization on the cycle', () => {
    // This test's own graph topology, exactly as specified: two
    // permissions, `perm_a` (namespace `ns_a`) and `perm_b` (namespace
    // `ns_b`), where `perm_a`'s rewrite rule recurses into `perm_b`, and
    // `perm_b`'s rewrite rule is a union of an ExclusionRule and a leaf
    // recursing back into `perm_a` — a cycle whose closure reaches the
    // exclusion through a DIFFERENT leaf than the cycle's own back-edge
    // (the union's other child), not through the back-edge itself.
    //
    // One deliberate, disclosed adaptation from the task's literal
    // wording: the task describes both cross-namespace edges as
    // `computedUserset`. `ComputedUsersetRule` is, by its own type
    // definition (src/schema/dsl/types.ts), resolved "against a namespace
    // declared on the SAME namespace" as the permission that references
    // it — it structurally cannot cross a namespace boundary; only
    // `TupleToUsersetRule` can (that's the entire reason the DSL has two
    // structurally distinct rewrite-rule kinds instead of one — see
    // TupleToUsersetRule's own doc comment: "structurally distinct from
    // ComputedUsersetRule rather than sharing its shape"). Since this test
    // was explicitly asked to place `perm_a`/`perm_b` in TWO DIFFERENT
    // hand-built namespaces, the only way to build a graph that is both
    // (a) faithful to that "different namespaces" requirement and (b)
    // structurally valid per the DSL's own rules (rather than a shape
    // `compileSchema` would reject as `undeclared_reference`, since
    // `perm_b` is not declared on `ns_a` and vice versa) is to use
    // `tupleToUserset` for both cross-namespace hops. This preserves the
    // EXACT adversarial graph topology the task describes (A -> B -> {
    // exclusion, A }) — the specific thing under test — while remaining a
    // shape a real schema could actually compile to. See this file's own
    // module-level doc comment; this substitution and its reasoning is
    // also called out in this delegation's own final report.
    const schema = schemaOf(
      namespaceConfig(
        'ns_a',
        {
          link_to_b: { kind: 'relation', name: 'link_to_b', subjectTypes: [{ namespace: 'ns_b' }] },
        },
        {
          perm_a: {
            kind: 'permission',
            name: 'perm_a',
            rewrite: { kind: 'tupleToUserset', relation: 'link_to_b', computedUserset: 'perm_b' },
          },
        },
      ),
      namespaceConfig(
        'ns_b',
        {
          link_to_a: { kind: 'relation', name: 'link_to_a', subjectTypes: [{ namespace: 'ns_a' }] },
          excluded_base: userRelation('excluded_base'),
          excluded_subtract: userRelation('excluded_subtract'),
        },
        {
          perm_b: {
            kind: 'permission',
            name: 'perm_b',
            rewrite: {
              kind: 'union',
              children: [
                {
                  kind: 'exclusion',
                  base: { kind: 'computedUserset', name: 'excluded_base' },
                  subtract: { kind: 'computedUserset', name: 'excluded_subtract' },
                },
                {
                  kind: 'tupleToUserset',
                  relation: 'link_to_a',
                  computedUserset: 'perm_a',
                },
              ],
            },
          },
        },
      ),
    );

    // Why this specifically catches an "optimistic memoization" bug class:
    // a buggy classifier that (a) special-cases cycle detection by
    // memoizing an in-progress (grey) node's answer as `true` the moment a
    // back-edge is found (rather than leaving it un-cached and letting the
    // ancestor's own full-tree walk finish), or (b) short-circuits a
    // union/intersection's child walk in a way that can skip over a
    // sibling branch once ANY child looks cycle-related, could plausibly
    // answer `true` here — MISSING the real, always-present
    // ExclusionRule sitting right next to the cyclic leaf inside perm_b's
    // own union. This implementation's `union`/`intersection` case
    // deliberately walks EVERY child via `.map` (never short-circuiting;
    // see monotonicity.ts's own comment on that choice), and its grey-node
    // branch deliberately never writes into the shared cache — so
    // regardless of which child is visited first, the exclusion is always
    // found and perm_a/perm_b both classify NON-monotone.
    expect(classifyMonotone(schema, 'ns_a', 'perm_a')).toBe(false);
    expect(classifyMonotone(schema, 'ns_b', 'perm_b')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bonus (not one of the six required cases): memoization sanity check.
// ---------------------------------------------------------------------------

describe('classifyMonotone — memoization does not change the answer across repeated calls on the same schema', () => {
  it('calling classifyMonotone twice on the same (schema, ns, name) — and on an overlapping dependency — returns identical results both times', () => {
    // Not one of the six required cases, but a direct, cheap way to make
    // sure the WeakMap-keyed black-result cache (monotonicity.ts's own
    // "Memoization" section) is genuinely just a performance optimization
    // and never an observable part of the answer — the exact property its
    // own doc comment claims. Calls resource.view (recursively resolves
    // hier.view and caches it) and THEN group.member — a node with no
    // relationship to hier.view at all — on the SAME schema object, and
    // re-asserts resource.view's answer is unchanged by having done so.
    const fixture = generateFixture('classifier-unit-test-seed-1', 5);
    const schema = compileOk(fixture.schemaSource);
    const { resourceNs, groupNs } = locateGuaranteedNamespaces(schema);

    const firstView = classifyMonotone(schema, resourceNs, 'view');
    const firstMember = classifyMonotone(schema, groupNs, 'member');
    const secondView = classifyMonotone(schema, resourceNs, 'view');
    const secondMember = classifyMonotone(schema, groupNs, 'member');

    expect(secondView).toBe(firstView);
    expect(secondMember).toBe(firstMember);
    expect(firstView).toBe(false);
    expect(firstMember).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findFlippableExclusion — the AST-walk extension backing the general
// Property 5 sweep. See this file's own top doc comment for why every case
// below is hand-built and DB-free.
// ---------------------------------------------------------------------------

/** `{ kind: 'exclusion', base: computedUserset(baseName), subtract: computedUserset(subtractName) }` — built once, used across several cases below. */
function exclusionOf(
  baseName: string,
  subtractName: string,
): NamespaceConfig['permissions'][string]['rewrite'] {
  return {
    kind: 'exclusion',
    base: { kind: 'computedUserset', name: baseName },
    subtract: { kind: 'computedUserset', name: subtractName },
  };
}

describe('findFlippableExclusion — case A: a top-level exclusion of two plain relations is located directly', () => {
  it("unbanned_view = viewer - banned locates {baseRelation: 'viewer', subtractRelation: 'banned'}", () => {
    const schema = schemaOf(
      namespaceConfig(
        'doc',
        { viewer: userRelation('viewer'), banned: userRelation('banned') },
        {
          unbanned_view: {
            kind: 'permission',
            name: 'unbanned_view',
            rewrite: exclusionOf('viewer', 'banned'),
          },
        },
      ),
    );
    expect(findFlippableExclusion(schema, 'doc', 'unbanned_view')).toEqual({
      ns: 'doc',
      name: 'unbanned_view',
      baseRelation: 'viewer',
      subtractRelation: 'banned',
    });
  });
});

describe('findFlippableExclusion — case B: a same-namespace computedUserset pass-through is transparent', () => {
  it('perm_outer = perm_inner, perm_inner = viewer - banned: locates the exclusion, but reports the ORIGINAL (ns, name) it was called with, not perm_inner', () => {
    // This is the specific claim LocatedExclusion's own doc comment makes:
    // every edge this walk crosses leaves the checked object/subject
    // unchanged, so `name` in the returned LocatedExclusion is always the
    // caller's own starting point — checking perm_outer directly must
    // reflect perm_inner's own base/subtract state with no further tuples
    // needed for the pass-through itself.
    const schema = schemaOf(
      namespaceConfig(
        'doc',
        { viewer: userRelation('viewer'), banned: userRelation('banned') },
        {
          perm_inner: {
            kind: 'permission',
            name: 'perm_inner',
            rewrite: exclusionOf('viewer', 'banned'),
          },
          perm_outer: {
            kind: 'permission',
            name: 'perm_outer',
            rewrite: { kind: 'computedUserset', name: 'perm_inner' },
          },
        },
      ),
    );
    expect(findFlippableExclusion(schema, 'doc', 'perm_outer')).toEqual({
      ns: 'doc',
      name: 'perm_outer',
      baseRelation: 'viewer',
      subtractRelation: 'banned',
    });
  });
});

describe('findFlippableExclusion — case C: an exclusion nested inside a union is located via its child walk', () => {
  it('view = editor | (viewer - banned) locates the exclusion inside the union', () => {
    const schema = schemaOf(
      namespaceConfig(
        'doc',
        {
          editor: userRelation('editor'),
          viewer: userRelation('viewer'),
          banned: userRelation('banned'),
        },
        {
          view: {
            kind: 'permission',
            name: 'view',
            rewrite: {
              kind: 'union',
              children: [
                { kind: 'computedUserset', name: 'editor' },
                exclusionOf('viewer', 'banned'),
              ],
            },
          },
        },
      ),
    );
    expect(findFlippableExclusion(schema, 'doc', 'view')).toEqual({
      ns: 'doc',
      name: 'view',
      baseRelation: 'viewer',
      subtractRelation: 'banned',
    });
  });
});

describe('findFlippableExclusion — case D: an exclusion nested inside an intersection is NOT walked', () => {
  it('trusted = editor & (viewer - banned) returns undefined — an intersection sibling could need tuples this function never constructs', () => {
    const schema = schemaOf(
      namespaceConfig(
        'doc',
        {
          editor: userRelation('editor'),
          viewer: userRelation('viewer'),
          banned: userRelation('banned'),
        },
        {
          trusted: {
            kind: 'permission',
            name: 'trusted',
            rewrite: {
              kind: 'intersection',
              children: [
                { kind: 'computedUserset', name: 'editor' },
                exclusionOf('viewer', 'banned'),
              ],
            },
          },
        },
      ),
    );
    expect(findFlippableExclusion(schema, 'doc', 'trusted')).toBeUndefined();
  });
});

describe('findFlippableExclusion — case E: an exclusion behind a tupleToUserset hop is NOT walked', () => {
  it("doc.via_parent = parent->excl, folder.excl = a - b: returns undefined for 'doc' (crossing objects needs a hop tuple this function never constructs) but locates it directly for 'folder'", () => {
    const schema = schemaOf(
      namespaceConfig(
        'folder',
        { a: userRelation('a'), b: userRelation('b') },
        {
          excl: { kind: 'permission', name: 'excl', rewrite: exclusionOf('a', 'b') },
        },
      ),
      namespaceConfig(
        'doc',
        { parent: { kind: 'relation', name: 'parent', subjectTypes: [{ namespace: 'folder' }] } },
        {
          via_parent: {
            kind: 'permission',
            name: 'via_parent',
            rewrite: { kind: 'tupleToUserset', relation: 'parent', computedUserset: 'excl' },
          },
        },
      ),
    );
    expect(findFlippableExclusion(schema, 'doc', 'via_parent')).toBeUndefined();
    expect(findFlippableExclusion(schema, 'folder', 'excl')).toEqual({
      ns: 'folder',
      name: 'excl',
      baseRelation: 'a',
      subtractRelation: 'b',
    });
  });
});

describe('findFlippableExclusion — case F: a base/subtract referencing a PERMISSION (not a relation) is rejected', () => {
  it('bad_excl = helper - banned, helper = computedUserset(banned): returns undefined — base resolves to a permission, not something directly tuple-writable', () => {
    const schema = schemaOf(
      namespaceConfig(
        'doc',
        { banned: userRelation('banned') },
        {
          helper: {
            kind: 'permission',
            name: 'helper',
            rewrite: { kind: 'computedUserset', name: 'banned' },
          },
          bad_excl: {
            kind: 'permission',
            name: 'bad_excl',
            rewrite: exclusionOf('helper', 'banned'),
          },
        },
      ),
    );
    expect(findFlippableExclusion(schema, 'doc', 'bad_excl')).toBeUndefined();
  });
});

describe('findFlippableExclusion — case G: base and subtract naming the SAME relation is rejected as unwitnessable', () => {
  it('degenerate = viewer - viewer: returns undefined — no tuple graph can satisfy base without also satisfying subtract', () => {
    const schema = schemaOf(
      namespaceConfig(
        'doc',
        { viewer: userRelation('viewer') },
        {
          degenerate: {
            kind: 'permission',
            name: 'degenerate',
            rewrite: exclusionOf('viewer', 'viewer'),
          },
        },
      ),
    );
    expect(findFlippableExclusion(schema, 'doc', 'degenerate')).toBeUndefined();
  });
});

describe('findFlippableExclusion — case H: a computedUserset cycle with no exclusion anywhere terminates and returns undefined', () => {
  it('loop_a -> loop_b -> loop_a, no ExclusionRule anywhere: returns undefined rather than looping forever', () => {
    const schema = schemaOf(
      namespaceConfig(
        'doc',
        {},
        {
          loop_a: {
            kind: 'permission',
            name: 'loop_a',
            rewrite: { kind: 'computedUserset', name: 'loop_b' },
          },
          loop_b: {
            kind: 'permission',
            name: 'loop_b',
            rewrite: { kind: 'computedUserset', name: 'loop_a' },
          },
        },
      ),
    );
    expect(findFlippableExclusion(schema, 'doc', 'loop_a')).toBeUndefined();
  });
});

describe('findFlippableExclusion — case I: a plain relation name has no rewrite tree to walk', () => {
  it("doc's own 'viewer' relation (not a permission) returns undefined, not a throw", () => {
    const schema = schemaOf(namespaceConfig('doc', { viewer: userRelation('viewer') }, {}));
    expect(findFlippableExclusion(schema, 'doc', 'viewer')).toBeUndefined();
  });
});

describe('findFlippableExclusion — case J: an undeclared namespace throws, matching classifyMonotone', () => {
  it('calling with a namespace absent from schema.namespaces throws, rather than returning undefined', () => {
    const schema = schemaOf(namespaceConfig('doc', { viewer: userRelation('viewer') }, {}));
    expect(() => findFlippableExclusion(schema, 'nonexistent_ns', 'anything')).toThrow(
      /not declared in this schema/,
    );
  });
});

describe("findFlippableExclusion — case K: generateFixture's own real, compiled unbanned_view shape", () => {
  it("locates {baseRelation: 'viewer', subtractRelation: 'banned'} against a real compiler-produced schema, not only hand-built ones", () => {
    const fixture = generateFixture('locator-unit-test-seed-1', 5);
    const schema = compileOk(fixture.schemaSource);
    const { resourceNs } = locateGuaranteedNamespaces(schema);
    expect(findFlippableExclusion(schema, resourceNs, 'unbanned_view')).toEqual({
      ns: resourceNs,
      name: 'unbanned_view',
      baseRelation: 'viewer',
      subtractRelation: 'banned',
    });
  });
});
