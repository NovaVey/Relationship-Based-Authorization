/**
 * Schema DSL compiler tests — rewrite-rule shapes.
 *
 * Written from `.claude/commands/build-authz-service.md` §5 (the grammar)
 * and §10's "Schema DSL" test plan, and from `src/schema/dsl/types.ts` /
 * `src/schema/dsl/errors.ts` (the interface contract only). Per §14
 * delegation rule 5, `src/schema/dsl/parser.ts` and `src/schema/dsl/
 * compiler.ts` were deliberately NOT read while writing these tests — the
 * expected shapes below are derived from the spec and hand-reasoning about
 * the grammar, not from the implementation.
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { formatSchemaError } from '../../../src/schema/dsl/errors.js';
import type {
  CompiledSchema,
  ExclusionRule,
  RewriteRule,
  UnionRule,
} from '../../../src/schema/dsl/types.js';

/** Compiles `source` and fails the test (with the formatted errors) if it doesn't compile. */
function compileOk(source: string): CompiledSchema {
  const result = compileSchema(source);
  if (!result.ok) {
    throw new Error(
      `expected schema to compile, got errors:\n${result.errors.map(formatSchemaError).join('\n')}`,
    );
  }
  return result.schema;
}

describe('a-schema-with-every-rewrite-rule-kind-compiles', () => {
  // One schema, four namespaces' worth of permissions, each exercising a
  // different rewrite-rule kind from §5: union (|), intersection (&),
  // exclusion (-), tuple-to-userset (->). Kept as separate permissions
  // (rather than one big mixed expression) because §5 never states an
  // operator-precedence table for combining |, &, -, -> in a single
  // expression — asserting a precedence the spec doesn't document would be
  // testing an assumption, not the spec.
  const source = [
    'namespace group {',
    '  relation member: user',
    '}',
    '',
    'namespace folder {',
    '  relation viewer: user | group#member',
    '',
    '  permission view = viewer',
    '}',
    '',
    'namespace document {',
    '  relation owner: user',
    '  relation editor: user | group#member',
    '  relation viewer: user | group#member',
    '  relation banned: user',
    '  relation parent: folder',
    '',
    '  permission any_access = viewer | editor',
    '  permission trusted_edit = editor & owner',
    '  permission unbanned_view = viewer - banned',
    '  permission inherited_view = parent->view',
    '}',
  ].join('\n');

  it('a-schema-with-every-rewrite-rule-kind-compiles', () => {
    const schema = compileOk(source);
    const document = schema.namespaces['document'];
    expect(document).toBeDefined();

    const unionExpected: RewriteRule = {
      kind: 'union',
      children: [
        { kind: 'computedUserset', name: 'viewer' },
        { kind: 'computedUserset', name: 'editor' },
      ],
    };
    expect(document?.permissions['any_access']?.rewrite).toEqual(unionExpected);

    const intersectionExpected: RewriteRule = {
      kind: 'intersection',
      children: [
        { kind: 'computedUserset', name: 'editor' },
        { kind: 'computedUserset', name: 'owner' },
      ],
    };
    expect(document?.permissions['trusted_edit']?.rewrite).toEqual(intersectionExpected);

    const exclusionExpected: RewriteRule = {
      kind: 'exclusion',
      base: { kind: 'computedUserset', name: 'viewer' },
      subtract: { kind: 'computedUserset', name: 'banned' },
    };
    expect(document?.permissions['unbanned_view']?.rewrite).toEqual(exclusionExpected);

    const tupleToUsersetExpected: RewriteRule = {
      kind: 'tupleToUserset',
      relation: 'parent',
      computedUserset: 'view',
    };
    expect(document?.permissions['inherited_view']?.rewrite).toEqual(tupleToUsersetExpected);
  });

  it('a-compiled-namespace-never-lists-the-same-member-name-in-both-its-relations-and-permissions-maps', () => {
    // §5: "only a relation can be the target of a tuple write" — the
    // structural mechanism per types.ts is that `relations` and
    // `permissions` are separate maps on NamespaceConfig. Direct proof that
    // every permission name is absent from `relations` and vice versa.
    const schema = compileOk(source);
    for (const ns of Object.values(schema.namespaces)) {
      const relationNames = new Set(Object.keys(ns.relations));
      const permissionNames = new Set(Object.keys(ns.permissions));
      for (const name of permissionNames) {
        expect(relationNames.has(name)).toBe(false);
      }
      for (const name of relationNames) {
        expect(permissionNames.has(name)).toBe(false);
      }
    }
  });
});

describe('tuple-to-userset-syntax-parses-the-followed-relation-and-the-recursed-permission-separately', () => {
  // Uses §5's own worked example verbatim: `permission view = editor |
  // parent->view` on `folder`. `parent->view` follows the `parent`
  // relation, then recurses into `view` (a *permission*, referring to
  // itself on whatever object `parent` points to — this is legitimate
  // tuple-driven recursion onto a different object, not the same kind of
  // static self-reference `permission view = view` would be).
  const source = [
    'namespace folder {',
    '  relation parent: folder',
    '  relation editor: user',
    '',
    '  permission view = editor | parent->view',
    '}',
  ].join('\n');

  it('tuple-to-userset-syntax-parses-the-followed-relation-and-the-recursed-permission-separately', () => {
    const schema = compileOk(source);
    const view = schema.namespaces['folder']?.permissions['view'];
    expect(view).toBeDefined();
    expect(view?.rewrite.kind).toBe('union');

    const union = view?.rewrite as UnionRule;
    expect(union.children).toHaveLength(2);

    const ttu = union.children.find((c) => c.kind === 'tupleToUserset');
    expect(ttu).toBeDefined();

    // The load-bearing assertion: two distinct fields, not one combined
    // "parent->view" string.
    expect(ttu?.relation).toBe('parent');
    expect(ttu?.computedUserset).toBe('view');
    expect(Object.keys(ttu ?? {}).sort()).toEqual(['computedUserset', 'kind', 'relation']);
  });
});

describe('every rewrite-rule kind compiles correctly in isolation, with no other operator present in the schema', () => {
  // Separate, deliberately minimal schemas — each one exercises exactly one
  // rewrite-rule kind and nothing else, proving each operator works on its
  // own rather than only as part of a larger expression.

  it('a-union-rewrite-rule-compiles-to-a-two-child-union-node-naming-both-branches', () => {
    const source = [
      'namespace document {',
      '  relation owner: user',
      '  relation editor: user',
      '',
      '  permission any_access = owner | editor',
      '}',
    ].join('\n');
    const schema = compileOk(source);
    const expected: RewriteRule = {
      kind: 'union',
      children: [
        { kind: 'computedUserset', name: 'owner' },
        { kind: 'computedUserset', name: 'editor' },
      ],
    };
    expect(schema.namespaces['document']?.permissions['any_access']?.rewrite).toEqual(expected);
  });

  it('an-intersection-rewrite-rule-compiles-to-a-two-child-intersection-node-not-a-union', () => {
    const source = [
      'namespace document {',
      '  relation owner: user',
      '  relation editor: user',
      '',
      '  permission trusted = owner & editor',
      '}',
    ].join('\n');
    const schema = compileOk(source);
    const rewrite = schema.namespaces['document']?.permissions['trusted']?.rewrite;
    expect(rewrite?.kind).toBe('intersection');
    const expected: RewriteRule = {
      kind: 'intersection',
      children: [
        { kind: 'computedUserset', name: 'owner' },
        { kind: 'computedUserset', name: 'editor' },
      ],
    };
    expect(rewrite).toEqual(expected);
  });

  it('an-exclusion-rewrite-rule-keeps-base-and-subtract-as-distinct-asymmetric-fields-not-a-symmetric-child-list', () => {
    const source = [
      'namespace document {',
      '  relation viewer: user',
      '  relation banned: user',
      '',
      '  permission unbanned_view = viewer - banned',
      '}',
    ].join('\n');
    const schema = compileOk(source);
    const rewrite = schema.namespaces['document']?.permissions['unbanned_view']
      ?.rewrite as ExclusionRule;
    expect(rewrite.kind).toBe('exclusion');
    // "a - b" means "in a, not in b" (§5) — base must be `viewer`
    // (the term before `-`), subtract must be `banned` (the term after).
    // Asserting this ordering, not just membership, is the point: an
    // exclusion rule that had base/subtract swapped would be a silent
    // over-grant (denies too little) rather than a symmetric no-op.
    expect(rewrite.base).toEqual({ kind: 'computedUserset', name: 'viewer' });
    expect(rewrite.subtract).toEqual({ kind: 'computedUserset', name: 'banned' });
  });

  it('a-tuple-to-userset-rewrite-rule-compiles-standalone-with-no-union-wrapping-it', () => {
    const source = [
      'namespace folder {',
      '  relation parent: folder',
      '  relation editor: user',
      '',
      '  permission view = parent->editor',
      '}',
    ].join('\n');
    const schema = compileOk(source);
    const expected: RewriteRule = {
      kind: 'tupleToUserset',
      relation: 'parent',
      computedUserset: 'editor',
    };
    expect(schema.namespaces['folder']?.permissions['view']?.rewrite).toEqual(expected);
  });
});

describe('a-permission-expression-mixing-and-with-or-parses-with-and-binding-tighter-per-docs-decisions-md-d-011', () => {
  // docs/DECISIONS.md D-011, read directly against `src/schema/dsl/
  // parser.ts`'s own grammar comment before writing this test (per this
  // task's explicit instruction, since the operator-precedence choice is a
  // deliberate design decision §5 itself is silent on — the sibling
  // describe block above ("a-schema-with-every-rewrite-rule-kind-compiles")
  // explicitly declined to test any mixed-operator expression for exactly
  // that reason, before D-011 existed to pin it down): `&` binds tighter
  // than `|`/`-`, which share precedence and associate left-to-right.
  // `a & b | c` must therefore parse as `(a & b) | c` — a top-level union
  // of an intersection and a plain reference — never `a & (b | c)`.
  const source = [
    'namespace document {',
    '  relation a: user',
    '  relation b: user',
    '  relation c: user',
    '',
    '  permission p = a & b | c',
    '}',
  ].join('\n');

  it('a-permission-expression-mixing-and-with-or-parses-with-and-binding-tighter-per-docs-decisions-md-d-011', () => {
    const schema = compileOk(source);
    const rewrite = schema.namespaces['document']?.permissions['p']?.rewrite;

    // Pin the exact tree shape, not just "it compiles" — a compiler that
    // silently inverted precedence to `intersection(a, union(b, c))` would
    // still compile this source successfully, so `toEqual` on the whole
    // structure is the load-bearing assertion here, not a `.kind` check
    // alone.
    const expected: RewriteRule = {
      kind: 'union',
      children: [
        {
          kind: 'intersection',
          children: [
            { kind: 'computedUserset', name: 'a' },
            { kind: 'computedUserset', name: 'b' },
          ],
        },
        { kind: 'computedUserset', name: 'c' },
      ],
    };
    expect(rewrite).toEqual(expected);

    // Belt-and-suspenders against the specific wrong answer D-011 names as
    // the rejected alternative: this must NOT be an intersection at the
    // top level.
    expect(rewrite?.kind).not.toBe('intersection');
  });

  it('the-mirror-case-or-then-and-also-binds-and-tighter-regardless-of-which-side-it-appears-on', () => {
    // `a | b & c` must parse as `a | (b & c)` — confirms the precedence
    // isn't an artifact of `&` appearing textually first in the fixture
    // above.
    const mirrorSource = [
      'namespace document {',
      '  relation a: user',
      '  relation b: user',
      '  relation c: user',
      '',
      '  permission p = a | b & c',
      '}',
    ].join('\n');
    const schema = compileOk(mirrorSource);
    const rewrite = schema.namespaces['document']?.permissions['p']?.rewrite;
    const expected: RewriteRule = {
      kind: 'union',
      children: [
        { kind: 'computedUserset', name: 'a' },
        {
          kind: 'intersection',
          children: [
            { kind: 'computedUserset', name: 'b' },
            { kind: 'computedUserset', name: 'c' },
          ],
        },
      ],
    };
    expect(rewrite).toEqual(expected);
  });
});

describe('compiling-the-same-source-twice-produces-identical-output', () => {
  // §5 doesn't say this explicitly, but the build spec's broader
  // reproducibility culture (§6.8: every fuzz/soundness run is seeded and
  // reproducible byte-for-byte) makes determinism a reasonable spec-level
  // expectation for a pure, I/O-free compiler — noted as an assumption
  // rather than a literal §5/§10 requirement.
  it('compiling-the-same-source-twice-produces-identical-output', () => {
    const source = [
      'namespace document {',
      '  relation owner: user',
      '  relation editor: user | group#member',
      '',
      '  permission edit = editor | owner',
      '}',
      '',
      'namespace group {',
      '  relation member: user',
      '}',
    ].join('\n');

    const first = compileSchema(source);
    const second = compileSchema(source);
    expect(first).toEqual(second);
  });
});
