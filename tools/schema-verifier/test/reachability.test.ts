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

describe('checkInvariant — cycle revisits are scoped per instance variable, not per node (docs/DECISIONS.md)', () => {
  // Confirmed false HOLDS before this fix: checkInvariant's own cycle
  // guard used to key its visited-set on the schema NodeId alone, so
  // once org#admin was visited via 'o' (the goal's own object), a
  // second, legitimate visit via a fresh, freely-choosable parent
  // object was refused as if it were a redundant cycle. It isn't — 'o'
  // is constrained (its own top_admin is pinned away from s by the
  // invariant's relationEquals below); a fresh parent is not. I
  // confirmed the pre-fix behavior by hand-writing this exact witness
  // and running it through the real, unmodified productionCheck engine
  // directly: allowed: true. The fixed search must find it too, not
  // just avoid crashing.
  const source = `
    namespace org {
      relation parent: org
      relation top_admin: user
      relation supervisor: service_account
      permission admin = top_admin | parent->admin
      permission chain = supervisor | parent->chain
    }
  `;
  const compiled = compileSchema(source);
  if (!compiled.ok) throw new Error('inline org-admin-chain schema failed to compile');
  const graph = buildSchemaGraph(compiled.schema);

  it("a relationEquals constraint pinning the goal object's own top_admin away from the goal subject does not block reaching admin through a fresh parent org", () => {
    const parsed = parseInvariants(
      [
        'invariant admin_reachable_via_parent_chain {',
        '  s: user',
        '  x: user',
        '  o: org',
        '  distinct(s, x)',
        '  top_admin(o) = x',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );
    if (!parsed.ok) throw new Error('fixture invariant failed to parse');
    const result = checkInvariant(graph, compiled.schema, parsed.invariants[0]!);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.witness).toEqual([
      { objectType: 'org', object: 'o', relation: 'parent', subjectType: 'org', subject: 'obj1' },
      {
        objectType: 'org',
        object: 'obj1',
        relation: 'top_admin',
        subjectType: 'user',
        subject: 's',
      },
    ]);
  });

  it('negative control — a permission that only ever terminates at a type disjoint from the goal subject still correctly reports HOLDS through the very same recursive node (the fix must not over-explore into a false VIOLATED)', () => {
    const parsed = parseInvariants(
      [
        'invariant chain_never_reaches_user {',
        '  s: user',
        '  o: org',
        '  goal: chain(s, o)',
        '}',
      ].join('\n'),
    );
    if (!parsed.ok) throw new Error('fixture invariant failed to parse');
    const result = checkInvariant(graph, compiled.schema, parsed.invariants[0]!);
    expect(result).toEqual({ verdict: 'HOLDS' });
  });

  it("two of the invariant's own named variables (o and p, chained by parent(o) = p) each get an independent visit into the same recursive node", () => {
    const parsed = parseInvariants(
      [
        'invariant two_named_vars_same_node {',
        '  s: user',
        '  x: user',
        '  o: org',
        '  p: org',
        '  distinct(s, x)',
        '  top_admin(o) = x',
        '  parent(o) = p',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );
    if (!parsed.ok) throw new Error('fixture invariant failed to parse');
    const result = checkInvariant(graph, compiled.schema, parsed.invariants[0]!);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.witness).toEqual([
      { objectType: 'org', object: 'o', relation: 'parent', subjectType: 'org', subject: 'p' },
      { objectType: 'org', object: 'p', relation: 'top_admin', subjectType: 'user', subject: 's' },
    ]);
  });

  it('two DIFFERENT named variables the search has since unified via two relationEquals lines on the same slot share one visit key, not two — no internally-inconsistent witness', () => {
    // p and q are both pinned, by two separate relationEquals lines, to
    // be org.o's own parent — i.e. the invariant itself asserts p === q.
    // Before resolving UnionFind.bindSlot/slotValue and search.ts's own
    // instanceKey through find() (this fix's own companion change,
    // union-find.ts), the raw-string keys 'p' and 'q' were treated as
    // two independent instances, letting the search revisit org#admin a
    // third time under an identity ('q') that's actually just 'p' again
    // — reachable only because this fix's own relaxation (visiting a
    // node once per named variable, not once ever) exists at all. That
    // third visit could produce a witness that's internally
    // self-contradictory (see docs/DECISIONS.md for the concrete trace)
    // even though, in this specific case, it never flips the overall
    // verdict. Resolving through find() collapses p/q to one shared key,
    // so no such extra visit — or the witness it could produce — is
    // ever reachable at all.
    const parsed = parseInvariants(
      [
        'invariant two_relation_equals_on_the_same_slot_are_one_identity {',
        '  s: user',
        '  x: user',
        '  o: org',
        '  p: org',
        '  q: org',
        '  distinct(s, x)',
        '  top_admin(o) = x',
        '  parent(o) = p',
        '  parent(o) = q',
        '  parent(p) = q',
        '  top_admin(p) = x',
        '  goal: admin(s, o)',
        '}',
      ].join('\n'),
    );
    if (!parsed.ok) throw new Error('fixture invariant failed to parse');
    const result = checkInvariant(graph, compiled.schema, parsed.invariants[0]!);
    expect(result).toEqual({ verdict: 'HOLDS' });
  });

  it('exhausting the exploration budget reports UNKNOWN, honestly, rather than hanging or guessing — never a silent HOLDS', () => {
    // A closed cycle (every org's parent/parent2 eventually loops back to
    // org:o0, no fresh/unconstrained escape anywhere) with every org's
    // own top_admin pinned away from s: the union of parent->admin and
    // parent2->admin at every level means both branches are eagerly
    // explored (search.ts's own established discipline — first success
    // wins, but every branch still runs), and since both hops resolve to
    // the *same* next org, this is exactly the shape that made a first
    // draft of this fix blow up combinatorially with named-variable
    // count (confirmed empirically before this budget existed: 1.5M+
    // search steps at 50 named variables). This schema is genuinely
    // HOLDS if the search could run to completion, but it must not be
    // allowed to try — MAX_ATTEMPT_CALLS must trip first, honestly.
    const branchySource = `
      namespace org {
        relation parent: org
        relation parent2: org
        relation top_admin: user
        permission admin = top_admin | parent->admin | parent2->admin
      }
    `;
    const branchyCompiled = compileSchema(branchySource);
    if (!branchyCompiled.ok) throw new Error('inline branchy-cycle schema failed to compile');
    const branchyGraph = buildSchemaGraph(branchyCompiled.schema);

    const N = 16;
    const lines = ['invariant fully_closed_blocked_chain {', '  s: user'];
    for (let i = 0; i < N; i++) {
      lines.push(`  x${i}: user`, `  o${i}: org`);
    }
    lines.push(
      `  distinct(${Array.from({ length: N }, (_, i) => `x${i}`)
        .concat('s')
        .join(', ')})`,
    );
    for (let i = 0; i < N; i++) lines.push(`  top_admin(o${i}) = x${i}`);
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      lines.push(`  parent(o${i}) = o${j}`, `  parent2(o${i}) = o${j}`);
    }
    lines.push('  goal: admin(s, o0)', '}');

    const parsed = parseInvariants(lines.join('\n'));
    if (!parsed.ok) throw new Error('generated stress invariant failed to parse');
    const result = checkInvariant(branchyGraph, branchyCompiled.schema, parsed.invariants[0]!);
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.reason).toContain('exploration budget');
  }, 10_000);
});

describe('checkInvariant — regression: the real schema/example.authz folder cycle is unaffected by the instance-keyed visited set', () => {
  const example = loadSchema(REAL_SCHEMA_DIR, 'example.authz');
  const graph = buildSchemaGraph(example);

  it('folder.view (viewer | edit | parent->view, self-referential via folder.parent: folder) still resolves to the minimal one-tuple witness, unconstrained', () => {
    const parsed = parseInvariants(
      [
        'invariant folder_view_reachable_real_schema {',
        '  s: user',
        '  o: folder',
        '  goal: view(s, o)',
        '}',
      ].join('\n'),
    );
    if (!parsed.ok) throw new Error('fixture invariant failed to parse');
    const result = checkInvariant(graph, example, parsed.invariants[0]!);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.witness).toEqual([
      { objectType: 'folder', object: 'o', relation: 'viewer', subjectType: 'user', subject: 's' },
    ]);
  });

  it('folder.edit (editor | owner | parent->edit, same self-reference) still resolves to the minimal one-tuple witness, unconstrained', () => {
    const parsed = parseInvariants(
      [
        'invariant folder_edit_reachable_real_schema {',
        '  s: user',
        '  o: folder',
        '  goal: edit(s, o)',
        '}',
      ].join('\n'),
    );
    if (!parsed.ok) throw new Error('fixture invariant failed to parse');
    const result = checkInvariant(graph, example, parsed.invariants[0]!);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.witness).toEqual([
      { objectType: 'folder', object: 'o', relation: 'editor', subjectType: 'user', subject: 's' },
    ]);
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

  it('bindSlot/slotValue resolve through find() — a slot pinned via one alias is visible via a different alias later unioned into the same class', () => {
    // Closes a real, disclosed witness-integrity gap (docs/DECISIONS.md,
    // found alongside search.ts's own cycle-guard fix): before this,
    // slots were keyed on the raw VarId string, so a slot pinned via 'p'
    // was invisible to a query via 'q' even after union('p','q') made
    // them the same object.
    const uf = UnionFind.empty();
    expect(uf.bindSlot('p', 'top_admin', 'x')).toBe(true);
    expect(uf.union('p', 'q')).toBe(true);
    expect(uf.slotValue('q', 'top_admin')).toBe('x');
    expect(uf.slotValue('p', 'top_admin')).toBe('x');
  });

  it('binding the same logical slot via two different aliases unions their values together, rather than silently creating two independent slots', () => {
    // Deliberately binds two DIFFERENT values (x, y) through the two
    // aliases — a weaker version of this test that bound the same value
    // through both aliases would pass even with the raw-string-keyed bug
    // (confirmed live: reverting the fix left an earlier draft of this
    // test green by coincidence, since a slot value that happens to be
    // identical either way can't tell "one shared slot" apart from "two
    // independent slots that happen to agree").
    const uf = UnionFind.empty();
    uf.union('p', 'q'); // p and q are the same object
    expect(uf.bindSlot('p', 'top_admin', 'x')).toBe(true);
    // Binding via q, the OTHER alias, to a DIFFERENT value must find p's
    // existing binding and union x/y together — not silently create a
    // second, independent 'q#top_admin' slot with no relationship to x.
    expect(uf.bindSlot('q', 'top_admin', 'y')).toBe(true);
    expect(uf.same('x', 'y')).toBe(true);
  });
});
