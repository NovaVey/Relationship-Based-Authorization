/**
 * `../../src/frontends/openfga/{parse,translate}.ts` in isolation — small,
 * hand-written `.fga` snippets (run through the real `@openfga/syntax-
 * transformer`, never a hand-built JSON model, so parsing itself is
 * exercised too) covering one translation rule each. The full, real-
 * upstream-source regression sweep lives in
 * `openfga-thirdparty-regression.test.ts`; this file's job is pinning
 * *why* each rule exists with a minimal, readable input.
 */
import { describe, expect, it } from 'vitest';

import { parseOpenfgaModel } from '../../src/frontends/openfga/parse.js';
import { translateOpenfga } from '../../src/frontends/openfga/translate.js';
import { printSchema } from '../../src/frontends/common/dsl-print.js';
import { compileSchema } from '../../../../src/schema/dsl/compiler.js';

function translate(fga: string, options?: { bestEffort?: boolean }) {
  const parsed = parseOpenfgaModel(fga);
  if (!parsed.ok) throw new Error(`fixture failed to parse: ${parsed.error.message}`);
  return translateOpenfga(parsed.model, options);
}

function translateAndCompile(fga: string, options?: { bestEffort?: boolean }) {
  const { schema, notes } = translate(fga, options);
  const dsl = printSchema(schema);
  const compiled = compileSchema(dsl);
  if (!compiled.ok) {
    throw new Error(
      `translated DSL failed to compile:\n${dsl}\n\n${compiled.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return { dsl, compiled: compiled.schema, notes };
}

describe('parseOpenfgaModel', () => {
  it('accepts real .fga DSL text (via the real @openfga/syntax-transformer, not a hand-built JSON stand-in)', () => {
    const result = parseOpenfgaModel(
      'model\n  schema 1.1\ntype user\ntype doc\n  relations\n    define viewer: [user]\n',
    );
    expect(result.ok).toBe(true);
  });

  it('accepts the JSON AuthorizationModel shape directly', () => {
    const model = {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    };
    const result = parseOpenfgaModel(JSON.stringify(model));
    expect(result.ok).toBe(true);
  });

  it('rejects malformed .fga text with a real parse error, not a silent empty model', () => {
    const result = parseOpenfgaModel('this is not a valid fga model at all {{{');
    expect(result.ok).toBe(false);
  });

  it('rejects JSON that is not an authorization model (no type_definitions)', () => {
    const result = parseOpenfgaModel(JSON.stringify({ hello: 'world' }));
    expect(result.ok).toBe(false);
  });
});

describe('translateOpenfga — one rule per test', () => {
  it('a bare define with only a type list (no "or" terms) → a bare relation, no wrapper permission', () => {
    const { dsl } = translateAndCompile(
      'model\n  schema 1.1\ntype user\ntype group\n  relations\n    define member: [user]\n',
    );
    expect(dsl).toContain('relation member: user');
    expect(dsl).not.toContain('permission member');
  });

  it('a define with a type list AND "or" terms → splits into "<name>_direct" + a wrapper permission', () => {
    const { compiled } = translateAndCompile(
      'model\n  schema 1.1\ntype user\ntype organization\n  relations\n    define owner: [user]\n    define member: [user] or owner\n',
    );
    expect(compiled.namespaces['organization']?.relations['member_direct']).toBeDefined();
    expect(compiled.namespaces['organization']?.permissions['member']).toBeDefined();
    expect(compiled.namespaces['organization']?.relations['member']).toBeUndefined();
  });

  it('a define with no type list at all ("X from Y" only) → a bare permission, no relation of its own', () => {
    const { compiled } = translateAndCompile(
      'model\n  schema 1.1\ntype user\ntype employee\n  relations\n    define manager: [employee]\n    define can_manage: manager or can_manage from manager\n',
    );
    expect(compiled.namespaces['employee']?.permissions['can_manage']).toBeDefined();
    expect(compiled.namespaces['employee']?.relations['can_manage']).toBeUndefined();
  });

  it('"X from Y" (tupleToUserset) reorders to this DSL\'s own "Y->X"', () => {
    const { compiled } = translateAndCompile(
      'model\n  schema 1.1\ntype user\ntype folder\n  relations\n    define parent: [folder]\n    define viewer: [user] or viewer from parent\n',
    );
    expect(compiled.namespaces['folder']?.permissions['viewer']?.rewrite).toEqual({
      kind: 'union',
      children: [
        { kind: 'computedUserset', name: 'viewer_direct' },
        { kind: 'tupleToUserset', relation: 'parent', computedUserset: 'viewer' },
      ],
    });
  });

  it('a wildcard type restriction ("[user:*]") translates to a real wildcard subject type (D-171) — no longer a disclosed drop', () => {
    const { dsl, compiled } = translateAndCompile(
      'model\n  schema 1.1\ntype user\ntype doc\n  relations\n    define viewer: [user, user:*]\n',
    );
    expect(dsl).toContain('user:*');
    expect(compiled.namespaces['doc']?.relations['viewer']?.subjectTypes).toEqual(
      expect.arrayContaining([{ namespace: 'user', wildcard: true }]),
    );
  });

  it('a terminal principal type ("type user" with no relations block) never gets its own namespace', () => {
    const { dsl } = translateAndCompile(
      'model\n  schema 1.1\ntype user\ntype group\n  relations\n    define member: [user]\n',
    );
    expect(dsl).not.toMatch(/namespace user\b/);
  });

  it('a nested-userset subject type ("type#relation") targeting a member that gets split is narrowed to "<relation>_direct", disclosed', () => {
    const fga =
      'model\n  schema 1.1\ntype user\ntype organization\n  relations\n    define owner: [user]\n    define member: [user] or owner\ntype repo\n  relations\n    define admin: [organization#member]\n';
    const { schema, notes } = translate(fga);
    const dsl = printSchema(schema);
    expect(dsl).toContain('organization#member_direct');
    expect(dsl).not.toMatch(/organization#member(?!_direct)/);
    expect(notes.some((n) => n.kind === 'nested-userset-narrowed')).toBe(true);
  });

  it('a nested-userset subject type targeting a bare (never-split) relation is left unchanged', () => {
    const fga =
      'model\n  schema 1.1\ntype user\ntype team\n  relations\n    define member: [user, team#member]\n';
    const { schema } = translate(fga);
    const dsl = printSchema(schema);
    expect(dsl).toContain('team#member');
  });

  it('an ABAC condition throws by default (matching thirdparty/README.md\'s own "excluded, not best-effort" policy)', () => {
    const fga =
      'model\n  schema 1.1\ntype user\ntype doc\n  relations\n    define viewer: [user with in_range]\ncondition in_range(x: int) {\n  x < 10\n}\n';
    expect(() => translate(fga)).toThrow(/ABAC/);
  });

  it('--best-effort drops an ABAC condition instead of throwing, disclosing the drop', () => {
    const fga =
      'model\n  schema 1.1\ntype user\ntype doc\n  relations\n    define viewer: [user with in_range]\ncondition in_range(x: int) {\n  x < 10\n}\n';
    const { schema, notes } = translate(fga, { bestEffort: true });
    expect(notes.some((n) => n.kind === 'condition-dropped')).toBe(true);
    const dsl = printSchema(schema);
    expect(dsl).toContain('relation viewer: user');
  });

  it('a model with no disclosed gaps at all reports an empty notes array', () => {
    const { notes } = translate(
      'model\n  schema 1.1\ntype user\ntype group\n  relations\n    define member: [user]\n',
    );
    expect(notes).toEqual([]);
  });
});
