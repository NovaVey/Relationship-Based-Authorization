/**
 * `../../src/frontends/spicedb/translate.ts` in isolation — one rule per
 * test, small hand-written `.zed` snippets. The full real-upstream sweep
 * lives in `spicedb-thirdparty-regression.test.ts`; this file's job is
 * pinning *why* each rule exists with a minimal, readable input, and
 * covering shapes the real seven-fixture corpus happens not to need (the
 * "every subject type needs restructuring, none stay direct" edge case;
 * `self` refused outside a union).
 */
import { describe, expect, it } from 'vitest';

import { parseSpicedbSchema } from '../../src/frontends/spicedb/parser.js';
import { translateSpicedb } from '../../src/frontends/spicedb/translate.js';
import { printSchema } from '../../src/frontends/common/dsl-print.js';
import { compileSchema } from '../../../../src/schema/dsl/compiler.js';

function translate(zed: string, options?: { bestEffort?: boolean }) {
  const parsed = parseSpicedbSchema(zed);
  if (!parsed.ok) throw new Error(`fixture failed to parse: ${parsed.error.message}`);
  return translateSpicedb(parsed.definitions, options);
}

function translateAndCompile(zed: string, options?: { bestEffort?: boolean }) {
  const { schema, notes } = translate(zed, options);
  const dsl = printSchema(schema);
  const compiled = compileSchema(dsl);
  if (!compiled.ok) {
    throw new Error(
      `translated DSL failed to compile:\n${dsl}\n\n${compiled.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return { dsl, compiled: compiled.schema, notes };
}

describe('translateSpicedb — terminal principal types and basics', () => {
  it('a bare "definition user {}" never gets its own namespace', () => {
    const { dsl } = translateAndCompile(
      'definition user {}\ndefinition doc { relation viewer: user }',
    );
    expect(dsl).not.toMatch(/namespace user\b/);
  });

  it('a relation with no computed logic stays a bare relation, no wrapper permission', () => {
    const { compiled } = translateAndCompile(
      'definition user {}\ndefinition doc { relation viewer: user }',
    );
    expect(compiled.namespaces['doc']?.relations['viewer']).toBeDefined();
    expect(compiled.namespaces['doc']?.permissions['viewer']).toBeUndefined();
  });

  it('a wildcard subject type translates directly', () => {
    const { compiled } = translateAndCompile(
      'definition user {}\ndefinition doc { relation viewer: user | user:* }',
    );
    expect(compiled.namespaces['doc']?.relations['viewer']?.subjectTypes).toEqual(
      expect.arrayContaining([{ namespace: 'user', wildcard: true }]),
    );
  });
});

describe('translateSpicedb — nested-userset resolution (three cases)', () => {
  it('case 1: a nested-userset subject type targeting a genuine relation is left unchanged', () => {
    const { dsl } = translateAndCompile(
      'definition user {}\ndefinition team { relation member: user | team#member }',
    );
    expect(dsl).toContain('team#member');
  });

  it('case 2: a nested-userset subject type targeting a permission that is exactly a union of bare relations expands losslessly', () => {
    const { compiled } = translateAndCompile(
      'definition user {}\ndefinition team { relation a: user\nrelation b: user\npermission member = a + b }\ndefinition repo { relation reader: user | team#member }',
    );
    const subjectTypes = compiled.namespaces['repo']?.relations['reader']?.subjectTypes;
    expect(subjectTypes).toEqual(
      expect.arrayContaining([
        { namespace: 'team', relation: 'a' },
        { namespace: 'team', relation: 'b' },
      ]),
    );
    expect(subjectTypes?.some((t) => t.relation === 'member')).toBe(false);
  });

  it('case 3: a nested-userset subject type targeting a genuinely computed permission (an arrow) is restructured', () => {
    const { compiled } = translateAndCompile(
      'definition user {}\ndefinition team { relation parent: team\nrelation member: user\npermission view = member + parent->view }\ndefinition doc { relation viewer: user | team#view }',
    );
    // 'viewer' had one direct type (user) plus one restructured type (team#view)
    // -> splits into viewer_direct + a synthesized via-relation + a wrapper permission.
    expect(compiled.namespaces['doc']?.relations['viewer_direct']?.subjectTypes).toEqual([
      { namespace: 'user' },
    ]);
    expect(compiled.namespaces['doc']?.permissions['viewer']).toBeDefined();
    expect(compiled.namespaces['doc']?.relations['viewer']).toBeUndefined();
  });

  it('case 3, the all-restructured edge case: every subject type needs restructuring, none stay direct — no real corpus fixture hits this, but it must still translate correctly', () => {
    const { compiled } = translateAndCompile(
      'definition user {}\ndefinition team { relation parent: team\nrelation member: user\npermission view = member + parent->view }\ndefinition doc { relation viewer: team#view }',
    );
    // No direct types survive at all -> 'viewer' becomes a pure computed
    // permission, no '_direct' relation synthesized (nothing to grant
    // directly), and no bare 'viewer' relation either.
    expect(compiled.namespaces['doc']?.relations['viewer']).toBeUndefined();
    expect(compiled.namespaces['doc']?.relations['viewer_direct']).toBeUndefined();
    expect(compiled.namespaces['doc']?.permissions['viewer']).toBeDefined();
  });
});

describe('translateSpicedb — arrow-type-split (an arrow whose followed relation has an incompatible subject type)', () => {
  it("splits a multi-typed relation by subject type when one type doesn't define the arrow's target", () => {
    const { compiled, notes } = translateAndCompile(
      'definition user {}\ndefinition org { relation admin_user: user\npermission admin = admin_user }\ndefinition doc { relation owner: user | org\npermission admin = owner + owner->admin }',
    );
    expect(compiled.namespaces['doc']?.relations['owner_user']).toBeDefined();
    expect(compiled.namespaces['doc']?.relations['owner_org']).toBeDefined();
    expect(compiled.namespaces['doc']?.permissions['owner']).toBeDefined();
    expect(compiled.namespaces['doc']?.relations['owner']).toBeUndefined();
    expect(notes.some((n) => n.kind === 'arrow-type-split')).toBe(true);
  });

  it('a single-typed relation followed by an arrow never needs splitting (the common case)', () => {
    const { compiled, notes } = translateAndCompile(
      'definition user {}\ndefinition org { relation admin_user: user\npermission admin = admin_user }\ndefinition doc { relation owner: org\npermission admin = owner->admin }',
    );
    expect(compiled.namespaces['doc']?.relations['owner']).toBeDefined();
    expect(notes.some((n) => n.kind === 'arrow-type-split')).toBe(false);
  });
});

describe("translateSpicedb — 'self'", () => {
  it("'self' throws by default, matching this survey's own 'excluded, not best-effort' policy", () => {
    const zed =
      'definition user {}\ndefinition doc { relation viewer: user\npermission view = viewer + self }';
    expect(() => translate(zed)).toThrow(/'self'/);
  });

  it("--best-effort drops 'self' from a union, disclosing the drop", () => {
    const zed =
      'definition user {}\ndefinition doc { relation viewer: user\npermission view = viewer + self }';
    const { compiled, notes } = translateAndCompile(zed, { bestEffort: true });
    expect(notes.some((n) => n.kind === 'self-dropped')).toBe(true);
    expect(compiled.namespaces['doc']?.permissions['view']?.rewrite).toEqual({
      kind: 'computedUserset',
      name: 'viewer',
    });
  });

  it("--best-effort still throws when 'self' is the entire rewrite alone (no union to drop it from at all)", () => {
    const zed =
      'definition user {}\ndefinition doc { relation viewer: user\npermission view = self }';
    expect(() => translate(zed, { bestEffort: true })).toThrow(/no well-defined meaning/);
  });

  it("--best-effort throws with a 'nothing left' message when a union collapses entirely to dropped 'self' terms", () => {
    const zed =
      'definition user {}\ndefinition doc { relation viewer: user\npermission view = self + self }';
    expect(() => translate(zed, { bestEffort: true })).toThrow(/nothing left/);
  });

  it("--best-effort still throws when 'self' is a lone intersection/exclusion operand (no well-defined drop)", () => {
    const zed =
      'definition user {}\ndefinition doc { relation viewer: user\npermission view = self & viewer }';
    expect(() => translate(zed, { bestEffort: true })).toThrow(/no well-defined meaning/);
  });
});

describe('translateSpicedb — disclosure', () => {
  it('a model with no disclosed gaps at all reports an empty notes array', () => {
    const { notes } = translate('definition user {}\ndefinition doc { relation viewer: user }');
    expect(notes).toEqual([]);
  });
});
