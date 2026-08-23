/**
 * `checkInvariant` — build spec §5 exit criteria: "all three fixture
 * invariants return the expected verdict; the positive control returns
 * VIOLATED with a witness."
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import type { CompiledSchema } from '../../../src/schema/dsl/types.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import { parseInvariants } from '../src/invariants/index.js';
import type { Invariant } from '../src/invariants/index.js';
import { checkInvariant, UnionFind } from '../src/reachability/index.js';

const SCHEMA_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/schemas/', import.meta.url));
const INVARIANT_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/invariants/', import.meta.url));
const REAL_SCHEMA_DIR = fileURLToPath(new URL('../../../schema/', import.meta.url));

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

describe('checkInvariant — the three shipped fixtures return the expected verdict', () => {
  const tenancy = loadSchema(SCHEMA_FIXTURE_DIR, 'tenancy.authz');
  const graph = buildSchemaGraph(tenancy);

  it('tenant_isolation: VIOLATED — user.tenant and document.view never actually consult each other', () => {
    const invariant = loadInvariant('tenant-isolation.invariant');
    const result = checkInvariant(graph, tenancy, invariant);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.witness).toBeDefined();
    const witness = result.witness!;
    // The witness must use document.tenant to reach some org, then that
    // org's member relation to reach s — the only path document.view
    // actually offers — and must NOT depend on user.tenant at all (the
    // whole point of this fixture, see its own comment).
    expect(witness.some((t) => t.objectType === 'document' && t.relation === 'tenant')).toBe(true);
    expect(witness.some((t) => t.objectType === 'organization' && t.relation === 'member')).toBe(
      true,
    );
    expect(witness.some((t) => t.relation === 'tenant' && t.objectType === 'user')).toBe(false);
    // The org used to reach `s` must be orgB (o's tenant, per the
    // invariant's own constraint) — never orgA (s's own, unrelated,
    // tenant fact) — confirming the witness is honest about *which*
    // relation actually did the work.
    const orgHop = witness.find((t) => t.objectType === 'document' && t.relation === 'tenant')!;
    expect(orgHop.subject).toBe('orgB');
  });

  it('no_public_path_to_private_document: HOLDS — private_document#view never accepts a user subject', () => {
    const invariant = loadInvariant('no-public-path-to-private-document.invariant');
    const result = checkInvariant(graph, tenancy, invariant);
    expect(result).toEqual({ verdict: 'HOLDS' });
  });

  it('positive_control_view_is_reachable: VIOLATED, with a real witness — the search can find one when it plainly exists', () => {
    const invariant = loadInvariant('positive-control.invariant');
    const result = checkInvariant(graph, tenancy, invariant);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.witness).toBeDefined();
    expect(result.witness!.length).toBeGreaterThan(0);
  });
});

describe('checkInvariant — non-monotone constructs report UNKNOWN, never HOLDS', () => {
  it('an intersection reachable from the goal permission yields UNKNOWN', () => {
    const example = loadSchema(REAL_SCHEMA_DIR, 'example.authz');
    const graph = buildSchemaGraph(example);
    const source = [
      'invariant reaches_sensitive_review {',
      '  s: user',
      '  o: folder',
      '  goal: sensitive_review(s, o)',
      '}',
    ].join('\n');
    const parsed = parseInvariants(source);
    if (!parsed.ok) throw new Error('fixture invariant failed to parse');
    const result = checkInvariant(graph, example, parsed.invariants[0]!);
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.reason).toContain('intersection');
  });
});

describe('checkInvariant — nested usersets and cycles', () => {
  const source = `
    namespace group {
      relation member: user | group#member
    }
    namespace resource {
      relation viewer: group#member
      permission view = viewer
    }
  `;
  const compiled = compileSchema(source);
  if (!compiled.ok) throw new Error('inline nested-group schema failed to compile');
  const graph = buildSchemaGraph(compiled.schema);

  it('resolves through two levels of nested group membership', () => {
    const parsed = parseInvariants(
      [
        'invariant reaches_via_nested_group {',
        '  s: user',
        '  o: resource',
        '  goal: view(s, o)',
        '}',
      ].join('\n'),
    );
    if (!parsed.ok) throw new Error('fixture invariant failed to parse');
    const result = checkInvariant(graph, compiled.schema, parsed.invariants[0]!);
    expect(result.verdict).toBe('VIOLATED');
    // Every hop in the witness must be a real, distinctly-typed step —
    // resource.viewer only ever accepts a group#member userset, so the
    // very first tuple must itself name a group as its subject.
    const first = result.witness![0]!;
    expect(first.objectType).toBe('resource');
    expect(first.subjectRelation).toBe('member');
  });

  it("resource.viewer only accepting group#member (never a bare user) still finds a witness — doesn't hang on the self-referential group.member cycle", () => {
    // `resource.viewer: group#member` has no plain-`user` entry at all —
    // the only way in is through a group, and `group.member` is itself
    // cyclic (`user | group#member`). This confirms the search actually
    // walks that recursion to a real, terminal `user` rather than either
    // hanging on the cycle or wrongly bottoming out at the group itself.
    const parsed = parseInvariants(
      [
        'invariant reaches_via_nested_group {',
        '  s: user',
        '  o: resource',
        '  goal: view(s, o)',
        '}',
      ].join('\n'),
    );
    if (!parsed.ok) throw new Error('fixture invariant failed to parse');
    expect(() => checkInvariant(graph, compiled.schema, parsed.invariants[0]!)).not.toThrow();
    const result = checkInvariant(graph, compiled.schema, parsed.invariants[0]!);
    expect(result.verdict).toBe('VIOLATED');
    const last = result.witness![result.witness!.length - 1]!;
    expect(last.subjectType).toBe('user');
    expect(last.subjectRelation).toBeUndefined();
  });
});

describe('UnionFind — the constraint-satisfiability primitive', () => {
  it('union merges two variables into the same representative', () => {
    const uf = UnionFind.empty();
    expect(uf.same('a', 'b')).toBe(false);
    expect(uf.union('a', 'b')).toBe(true);
    expect(uf.same('a', 'b')).toBe(true);
  });

  it('markDistinct then union between the same pair fails and leaves the structure unchanged', () => {
    const uf = UnionFind.empty();
    expect(uf.markDistinct(['a', 'b'])).toBe(true);
    expect(uf.union('a', 'b')).toBe(false);
    expect(uf.same('a', 'b')).toBe(false);
  });

  it('markDistinct on an already-unified pair fails immediately', () => {
    const uf = UnionFind.empty();
    uf.union('a', 'b');
    expect(uf.markDistinct(['a', 'b'])).toBe(false);
  });

  it('distinctness propagates through a later union with a third variable', () => {
    const uf = UnionFind.empty();
    uf.markDistinct(['a', 'b']);
    uf.union('b', 'c'); // c joins b's class
    expect(uf.union('a', 'c')).toBe(false); // a is still distinct from b's whole class, including c
  });

  it('bindSlot reuses an existing binding instead of creating a second, independent one', () => {
    const uf = UnionFind.empty();
    expect(uf.bindSlot('o', 'tenant', 'orgB')).toBe(true);
    expect(uf.slotValue('o', 'tenant')).toBe('orgB');
    expect(uf.bindSlot('o', 'tenant', 'freshVar')).toBe(true); // unions freshVar into orgB's class, doesn't overwrite
    expect(uf.same('orgB', 'freshVar')).toBe(true);
  });

  it('clone is fully independent — mutating the clone never affects the original', () => {
    const uf = UnionFind.empty();
    uf.union('a', 'b');
    const clone = uf.clone();
    clone.union('c', 'd');
    expect(uf.same('c', 'd')).toBe(false);
    expect(clone.same('c', 'd')).toBe(true);
    expect(clone.same('a', 'b')).toBe(true); // the pre-clone state carried over
  });
});
