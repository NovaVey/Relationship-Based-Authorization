/**
 * `../../src/frontends/spicedb/parser.ts` in isolation — small,
 * hand-written `.zed` snippets, one grammar rule per test. The real
 * upstream regression sweep lives in
 * `spicedb-thirdparty-regression.test.ts`; this file's job is pinning
 * *why* each rule exists with a minimal, readable input, and the one
 * genuinely surprising rule (union binds tighter than intersection/
 * exclusion — the opposite of this project's own DSL) gets its own
 * dedicated round-trip case.
 */
import { describe, expect, it } from 'vitest';

import { parseSpicedbSchema, type ParsedDefinition } from '../../src/frontends/spicedb/parser.js';

function parseOne(zed: string): ParsedDefinition {
  const result = parseSpicedbSchema(zed);
  if (!result.ok)
    throw new Error(`fixture failed to parse: line ${result.error.line}: ${result.error.message}`);
  return result.definitions[0]!;
}

describe('parseSpicedbSchema — lexical basics', () => {
  it('accepts both // line comments and /* ... */ block comments, including multi-line doc comments', () => {
    const zed = `
      // a line comment
      /**
       * a multi-line doc comment
       */
      definition user {}
      definition doc {
        relation viewer: user // trailing comment
      }
    `;
    const result = parseSpicedbSchema(zed);
    expect(result.ok).toBe(true);
  });

  it('an unterminated block comment is a real parse error, not a silent success', () => {
    const result = parseSpicedbSchema('definition user {} /* never closed');
    expect(result.ok).toBe(false);
  });

  it("a top-level 'use IDENT' directive is recognized and discarded", () => {
    const result = parseSpicedbSchema(
      'use typechecking\ndefinition user {}\ndefinition doc { relation viewer: user }',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.definitions).toHaveLength(2);
  });

  it("a permission's optional ': TYPE | TYPE' result-type annotation is recognized and discarded", () => {
    const zed =
      'definition user {}\ndefinition doc { relation viewer: user\npermission view: user = viewer }';
    const result = parseSpicedbSchema(zed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const permission = result.definitions[1]!.members.find((m) => m.name === 'view');
      expect(permission?.kind).toBe('permission');
      if (permission?.kind === 'permission') {
        expect(permission.rewrite).toEqual({
          kind: 'ref',
          name: 'viewer',
          line: expect.any(Number),
        });
      }
    }
  });
});

describe('parseSpicedbSchema — grammar', () => {
  it('a bare definition with no relations/permissions at all parses (a terminal principal type)', () => {
    const def = parseOne('definition user {}');
    expect(def.members).toHaveLength(0);
  });

  it('a relation with a wildcard subject type (":*")', () => {
    const def = parseOne('definition doc { relation viewer: user | user:* }');
    const relation = def.members[0]!;
    expect(relation.kind).toBe('relation');
    if (relation.kind === 'relation') {
      expect(relation.subjectTypes).toEqual([
        { namespace: 'user', line: expect.any(Number) },
        { namespace: 'user', wildcard: true, line: expect.any(Number) },
      ]);
    }
  });

  it('a nested-userset subject type ("type#relation")', () => {
    const def = parseOne('definition doc { relation viewer: user | group#member }');
    const relation = def.members[0]!;
    if (relation.kind === 'relation') {
      expect(relation.subjectTypes[1]).toEqual({
        namespace: 'group',
        relation: 'member',
        line: expect.any(Number),
      });
    }
  });

  it("an arrow term ('X->Y') parses as tupleToUserset", () => {
    const def = parseOne('definition doc { relation parent: doc\npermission view = parent->view }');
    const permission = def.members[1]!;
    expect(permission.kind).toBe('permission');
    if (permission.kind === 'permission') {
      expect(permission.rewrite).toEqual({
        kind: 'tupleToUserset',
        relation: 'parent',
        computedUserset: 'view',
        line: expect.any(Number),
      });
    }
  });

  it("'self' parses as its own distinct node kind, never conflated with a plain reference", () => {
    const def = parseOne(
      'definition doc { relation viewer: user\npermission view = viewer + self }',
    );
    const permission = def.members[1]!;
    if (permission.kind === 'permission') {
      expect(permission.rewrite).toEqual({
        kind: 'union',
        children: [
          { kind: 'ref', name: 'viewer', line: expect.any(Number) },
          { kind: 'self', line: expect.any(Number) },
        ],
        line: expect.any(Number),
      });
    }
  });

  it("union ('+') flattens a same-operator chain into one flat n-ary node, mirroring this project's own DSL", () => {
    const def = parseOne(
      'definition doc { relation a: user\nrelation b: user\nrelation c: user\npermission view = a + b + c }',
    );
    const permission = def.members[3]!;
    if (permission.kind === 'permission') {
      expect(permission.rewrite.kind).toBe('union');
      if (permission.rewrite.kind === 'union') expect(permission.rewrite.children).toHaveLength(3);
    }
  });

  it('a real exclusion chain ("a - b - c") — never flattened, each link nests one level deeper', () => {
    const def = parseOne(
      'definition doc { relation a: user\nrelation b: user\nrelation c: user\npermission view = a - b - c }',
    );
    const permission = def.members[3]!;
    if (permission.kind === 'permission') {
      expect(permission.rewrite).toEqual({
        kind: 'exclusion',
        base: {
          kind: 'exclusion',
          base: { kind: 'ref', name: 'a', line: expect.any(Number) },
          subtract: { kind: 'ref', name: 'b', line: expect.any(Number) },
          line: expect.any(Number),
        },
        subtract: { kind: 'ref', name: 'c', line: expect.any(Number) },
        line: expect.any(Number),
      });
    }
  });
});

describe("parseSpicedbSchema — the precedence inversion (union binds TIGHTER than intersection/exclusion, the opposite of this project's own DSL)", () => {
  it("'a + b & c' parses as '(a + b) & c' — confirmed directly against SpiceDB's own schema-language reference, not assumed", () => {
    const def = parseOne(
      'definition doc { relation a: user\nrelation b: user\nrelation c: user\npermission view = a + b & c }',
    );
    const permission = def.members[3]!;
    if (permission.kind === 'permission') {
      expect(permission.rewrite).toEqual({
        kind: 'intersection',
        children: [
          {
            kind: 'union',
            children: [
              { kind: 'ref', name: 'a', line: expect.any(Number) },
              { kind: 'ref', name: 'b', line: expect.any(Number) },
            ],
            line: expect.any(Number),
          },
          { kind: 'ref', name: 'c', line: expect.any(Number) },
        ],
        line: expect.any(Number),
      });
    }
  });

  it("'a & b + c' parses as 'a & (b + c)' — the union sub-expression groups around its own operands regardless of position", () => {
    const def = parseOne(
      'definition doc { relation a: user\nrelation b: user\nrelation c: user\npermission view = a & b + c }',
    );
    const permission = def.members[3]!;
    if (permission.kind === 'permission') {
      expect(permission.rewrite).toEqual({
        kind: 'intersection',
        children: [
          { kind: 'ref', name: 'a', line: expect.any(Number) },
          {
            kind: 'union',
            children: [
              { kind: 'ref', name: 'b', line: expect.any(Number) },
              { kind: 'ref', name: 'c', line: expect.any(Number) },
            ],
            line: expect.any(Number),
          },
        ],
        line: expect.any(Number),
      });
    }
  });

  it("explicit parens are honored, matching a real fixture's own real usage (spicedb-userdefined-roles.zed)", () => {
    const def = parseOne(
      'definition doc { relation a: user\nrelation b: user\nrelation c: user\npermission view = (a & b) + c }',
    );
    const permission = def.members[3]!;
    if (permission.kind === 'permission') {
      expect(permission.rewrite.kind).toBe('union');
      if (permission.rewrite.kind === 'union') {
        expect(permission.rewrite.children[0]).toEqual({
          kind: 'intersection',
          children: [
            { kind: 'ref', name: 'a', line: expect.any(Number) },
            { kind: 'ref', name: 'b', line: expect.any(Number) },
          ],
          line: expect.any(Number),
        });
      }
    }
  });
});

describe('parseSpicedbSchema — errors', () => {
  it('empty source is a clean error, not a crash', () => {
    const result = parseSpicedbSchema('   ');
    expect(result.ok).toBe(false);
  });

  it('a syntax error reports a specific line number', () => {
    const result = parseSpicedbSchema('definition doc {\n  relation viewer user\n}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.line).toBe(2);
  });

  it("a deeply nested paren chain is rejected before it can overflow the real call stack, mirroring this project's own DSL protection", () => {
    const deep = '('.repeat(5000) + 'a' + ')'.repeat(5000);
    const result = parseSpicedbSchema(
      `definition doc { relation a: user\npermission view = ${deep} }`,
    );
    expect(result.ok).toBe(false);
  });
});
