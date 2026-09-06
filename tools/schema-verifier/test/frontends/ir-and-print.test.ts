/**
 * `../../src/frontends/common/ir.ts` (`splitMember`) and `dsl-print.ts`
 * (`printSchema`) in isolation — no OpenFGA/SpiceDB involved at all, small
 * hand-built `IrSchema` values only. The OpenFGA-specific translation
 * rules (`this` conversion, nested-userset narrowing, wildcard mapping)
 * are covered separately in `openfga-translate.test.ts`; this file's own
 * job is the ecosystem-neutral splitting/printing logic both front ends
 * share.
 */
import { describe, expect, it } from 'vitest';

import {
  splitMember,
  type IrMember,
  type IrRewrite,
  type IrSchema,
} from '../../src/frontends/common/ir.js';
import { printSchema } from '../../src/frontends/common/dsl-print.js';
import { compileSchema } from '../../../../src/schema/dsl/compiler.js';

describe('splitMember', () => {
  it('a member with direct types and no rewrite at all → a bare relation, no permission', () => {
    const member: IrMember = { name: 'owner', directTypes: [{ namespace: 'user' }] };
    const result = splitMember(member);
    expect(result.relation).toEqual({ name: 'owner', subjectTypes: [{ namespace: 'user' }] });
    expect(result.permission).toBeUndefined();
  });

  it("a member whose rewrite is exactly `{ kind: 'this' }` alone → same as no rewrite: a bare relation", () => {
    const member: IrMember = {
      name: 'owner',
      directTypes: [{ namespace: 'user' }],
      rewrite: { kind: 'this' },
    };
    const result = splitMember(member);
    expect(result.relation).toEqual({ name: 'owner', subjectTypes: [{ namespace: 'user' }] });
    expect(result.permission).toBeUndefined();
  });

  it('a member with a rewrite containing no direct types at all → a bare permission, no relation', () => {
    const rewrite: IrRewrite = { kind: 'ref', name: 'owner' };
    const member: IrMember = { name: 'view', directTypes: [], rewrite };
    const result = splitMember(member);
    expect(result.permission).toEqual({ name: 'view', rewrite });
    expect(result.relation).toBeUndefined();
  });

  it("a member with both direct types and a rewrite referencing 'this' → splits into '<name>_direct' + a permission with every 'this' replaced by a ref to it", () => {
    const member: IrMember = {
      name: 'admin',
      directTypes: [{ namespace: 'user' }, { namespace: 'team', relation: 'member' }],
      rewrite: {
        kind: 'union',
        children: [
          { kind: 'this' },
          { kind: 'tupleToUserset', relation: 'owner', computedUserset: 'repo_admin' },
        ],
      },
    };
    const result = splitMember(member);
    expect(result.relation).toEqual({
      name: 'admin_direct',
      subjectTypes: [{ namespace: 'user' }, { namespace: 'team', relation: 'member' }],
    });
    expect(result.permission).toEqual({
      name: 'admin',
      rewrite: {
        kind: 'union',
        children: [
          { kind: 'ref', name: 'admin_direct' },
          { kind: 'tupleToUserset', relation: 'owner', computedUserset: 'repo_admin' },
        ],
      },
    });
  });

  it("replaces every occurrence of 'this', even nested inside an intersection/exclusion, not just a top-level union child", () => {
    const member: IrMember = {
      name: 'sensitive',
      directTypes: [{ namespace: 'user' }],
      rewrite: {
        kind: 'exclusion',
        base: {
          kind: 'intersection',
          children: [{ kind: 'this' }, { kind: 'ref', name: 'reviewer' }],
        },
        subtract: { kind: 'ref', name: 'banned' },
      },
    };
    const result = splitMember(member);
    expect(result.permission?.rewrite).toEqual({
      kind: 'exclusion',
      base: {
        kind: 'intersection',
        children: [
          { kind: 'ref', name: 'sensitive_direct' },
          { kind: 'ref', name: 'reviewer' },
        ],
      },
      subtract: { kind: 'ref', name: 'banned' },
    });
  });

  it('a member with neither direct types nor a rewrite throws', () => {
    const member: IrMember = { name: 'nothing', directTypes: [] };
    expect(() => splitMember(member)).toThrow(/declares no direct subject types/);
  });

  it("a rewrite referencing 'this' with no direct types declared throws", () => {
    const member: IrMember = { name: 'broken', directTypes: [], rewrite: { kind: 'this' } };
    expect(() => splitMember(member)).toThrow(/declares no direct subject types/);
  });
});

describe('printSchema — every printed schema round-trips through the real compileSchema', () => {
  function compileOrThrow(dsl: string) {
    const result = compileSchema(dsl);
    if (!result.ok) {
      throw new Error(
        `generated DSL failed to compile:\n${dsl}\n\n${result.errors.map((e) => e.message).join('; ')}`,
      );
    }
    return result.schema;
  }

  it('a namespace with only bare relations (no permissions) prints and compiles', () => {
    const schema: IrSchema = {
      namespaces: [
        { name: 'group', members: [{ name: 'member', directTypes: [{ namespace: 'user' }] }] },
      ],
    };
    const dsl = printSchema(schema);
    expect(dsl).toContain('namespace group {');
    expect(dsl).toContain('relation member: user');
    const compiled = compileOrThrow(dsl);
    expect(compiled.namespaces['group']?.relations['member']).toBeDefined();
  });

  it('a terminal principal type (no members at all) is silently omitted, matching every hand-translated thirdparty file', () => {
    const schema: IrSchema = {
      namespaces: [
        { name: 'user', members: [] },
        { name: 'group', members: [{ name: 'member', directTypes: [{ namespace: 'user' }] }] },
      ],
    };
    const dsl = printSchema(schema);
    expect(dsl).not.toContain('namespace user');
    compileOrThrow(dsl);
  });

  it("wildcard and nested-userset subject types print as 'namespace:*' / 'namespace#relation'", () => {
    const schema: IrSchema = {
      namespaces: [
        { name: 'group', members: [{ name: 'member', directTypes: [{ namespace: 'user' }] }] },
        {
          name: 'doc',
          members: [
            {
              name: 'viewer',
              directTypes: [
                { namespace: 'user' },
                { namespace: 'user', wildcard: true },
                { namespace: 'group', relation: 'member' },
              ],
            },
          ],
        },
      ],
    };
    const dsl = printSchema(schema);
    expect(dsl).toContain('relation viewer: user | user:* | group#member');
    compileOrThrow(dsl);
  });

  it('an intersection operand that is itself a union is parenthesized (tighter-binds-than rule)', () => {
    // (a | b) & c — without parens, `a | b & c` would parse under this
    // DSL's own grammar (`&` binds tighter than `|`) as `a | (b & c)`, a
    // different tree entirely.
    const schema: IrSchema = {
      namespaces: [
        {
          name: 'doc',
          members: [
            { name: 'a', directTypes: [{ namespace: 'user' }] },
            { name: 'b', directTypes: [{ namespace: 'user' }] },
            { name: 'c', directTypes: [{ namespace: 'user' }] },
            {
              name: 'view',
              directTypes: [],
              rewrite: {
                kind: 'intersection',
                children: [
                  {
                    kind: 'union',
                    children: [
                      { kind: 'ref', name: 'a' },
                      { kind: 'ref', name: 'b' },
                    ],
                  },
                  { kind: 'ref', name: 'c' },
                ],
              },
            },
          ],
        },
      ],
    };
    const dsl = printSchema(schema);
    expect(dsl).toContain('permission view = (a | b) & c');
    const compiled = compileOrThrow(dsl);
    // Re-parsed shape matches the original IR exactly, not e.g. a | (b & c).
    const rewrite = compiled.namespaces['doc']?.permissions['view']?.rewrite;
    expect(rewrite).toEqual({
      kind: 'intersection',
      children: [
        {
          kind: 'union',
          children: [
            { kind: 'computedUserset', name: 'a' },
            { kind: 'computedUserset', name: 'b' },
          ],
        },
        { kind: 'computedUserset', name: 'c' },
      ],
    });
  });

  it('a union whose non-first operand is itself an exclusion is parenthesized (left-associativity rule)', () => {
    // a | (b - c) — without parens, `a | b - c` reparses left-
    // associatively as `(a | b) - c`, a different tree.
    const schema: IrSchema = {
      namespaces: [
        {
          name: 'doc',
          members: [
            { name: 'a', directTypes: [{ namespace: 'user' }] },
            { name: 'b', directTypes: [{ namespace: 'user' }] },
            { name: 'c', directTypes: [{ namespace: 'user' }] },
            {
              name: 'view',
              directTypes: [],
              rewrite: {
                kind: 'union',
                children: [
                  { kind: 'ref', name: 'a' },
                  {
                    kind: 'exclusion',
                    base: { kind: 'ref', name: 'b' },
                    subtract: { kind: 'ref', name: 'c' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const dsl = printSchema(schema);
    expect(dsl).toContain('permission view = a | (b - c)');
    const compiled = compileOrThrow(dsl);
    const rewrite = compiled.namespaces['doc']?.permissions['view']?.rewrite;
    expect(rewrite).toEqual({
      kind: 'union',
      children: [
        { kind: 'computedUserset', name: 'a' },
        {
          kind: 'exclusion',
          base: { kind: 'computedUserset', name: 'b' },
          subtract: { kind: 'computedUserset', name: 'c' },
        },
      ],
    });
  });

  it('a subtract operand that is itself a union is parenthesized (a - (b | c), never a - b | c)', () => {
    const schema: IrSchema = {
      namespaces: [
        {
          name: 'doc',
          members: [
            { name: 'a', directTypes: [{ namespace: 'user' }] },
            { name: 'b', directTypes: [{ namespace: 'user' }] },
            { name: 'c', directTypes: [{ namespace: 'user' }] },
            {
              name: 'view',
              directTypes: [],
              rewrite: {
                kind: 'exclusion',
                base: { kind: 'ref', name: 'a' },
                subtract: {
                  kind: 'union',
                  children: [
                    { kind: 'ref', name: 'b' },
                    { kind: 'ref', name: 'c' },
                  ],
                },
              },
            },
          ],
        },
      ],
    };
    const dsl = printSchema(schema);
    expect(dsl).toContain('permission view = a - (b | c)');
    const compiled = compileOrThrow(dsl);
    const rewrite = compiled.namespaces['doc']?.permissions['view']?.rewrite;
    expect(rewrite).toEqual({
      kind: 'exclusion',
      base: { kind: 'computedUserset', name: 'a' },
      subtract: {
        kind: 'union',
        children: [
          { kind: 'computedUserset', name: 'b' },
          { kind: 'computedUserset', name: 'c' },
        ],
      },
    });
  });

  it('a base that is itself an exclusion chain never needs parens ((a-b)-c reconstructs via plain left-associative printing)', () => {
    const schema: IrSchema = {
      namespaces: [
        {
          name: 'doc',
          members: [
            { name: 'a', directTypes: [{ namespace: 'user' }] },
            { name: 'b', directTypes: [{ namespace: 'user' }] },
            { name: 'c', directTypes: [{ namespace: 'user' }] },
            {
              name: 'view',
              directTypes: [],
              rewrite: {
                kind: 'exclusion',
                base: {
                  kind: 'exclusion',
                  base: { kind: 'ref', name: 'a' },
                  subtract: { kind: 'ref', name: 'b' },
                },
                subtract: { kind: 'ref', name: 'c' },
              },
            },
          ],
        },
      ],
    };
    const dsl = printSchema(schema);
    expect(dsl).toContain('permission view = a - b - c');
    const compiled = compileOrThrow(dsl);
    const rewrite = compiled.namespaces['doc']?.permissions['view']?.rewrite;
    expect(rewrite).toEqual({
      kind: 'exclusion',
      base: {
        kind: 'exclusion',
        base: { kind: 'computedUserset', name: 'a' },
        subtract: { kind: 'computedUserset', name: 'b' },
      },
      subtract: { kind: 'computedUserset', name: 'c' },
    });
  });
});
