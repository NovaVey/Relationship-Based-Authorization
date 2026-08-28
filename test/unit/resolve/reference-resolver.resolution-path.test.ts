/**
 * Reference resolver (Phase 3/6) — resolution-path independent
 * re-verification. `.claude/commands/build-authz-service.md` §6.7, §9
 * Phase 6's exit criterion ("an allowed check's log entry contains a path
 * that independently re-verifies"), and §8's worked chain example.
 *
 * **This file is the actual proof, not a shape assertion.** Everything
 * below — `verifyResolutionStep`/`verifyDisproofStep` and their
 * `verifyAgainstRule`/`verifyDisproofAgainstRule` helpers — is written
 * from `src/resolve/reference/resolver.ts`'s own EXPORTED types and doc
 * comments only (never its private helpers, never its recursion
 * structure), exactly the same discipline §14 delegation rule 5 already
 * holds every other reference-resolver test file to. The verifier never
 * *searches* for a path (it never asks "does any path exist") — it only
 * *validates* the specific chain of tuple/rewrite-rule claims a given
 * `ResolutionStep`/`DisproofStep` makes, against the real compiled schema
 * and the real tuple array, structurally. That's what makes this an
 * independent re-verification rather than a second copy of the resolver:
 * a bug in `referenceCheck`'s own search logic that fabricated a path
 * pointing at tuples that don't exist, or a union branch the schema
 * doesn't actually declare, is caught here — a bug that only affects
 * *which* branch is chosen (but still produces internally-consistent,
 * real evidence) is not this file's concern, since any real chain is a
 * valid proof of `allowed: true` regardless of which one the resolver
 * happened to find.
 *
 * The "tamper" tests at the bottom are what prove this verifier has power
 * (mirrors this project's own standing discipline — D-024/D-027/D-029 — of
 * never trusting a test that has never been observed failing): a valid
 * path is mutated one field at a time and the verifier must reject every
 * mutation.
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { formatSchemaError } from '../../../src/schema/dsl/errors.js';
import type { CompiledSchema, RewriteRule } from '../../../src/schema/dsl/types.js';
import { referenceCheck } from '../../../src/resolve/reference/resolver.js';
import type {
  DisproofStep,
  EntityRef,
  ReferenceTuple,
  ResolutionStep,
} from '../../../src/resolve/reference/resolver.js';

function compileOk(source: string): CompiledSchema {
  const result = compileSchema(source);
  if (!result.ok) {
    throw new Error(
      `expected schema to compile, got errors:\n${result.errors.map(formatSchemaError).join('\n')}`,
    );
  }
  return result.schema;
}

function ref(ns: string, id: string): EntityRef {
  return { ns, id };
}

function tuple(
  objectNs: string,
  objectId: string,
  relation: string,
  subjectNs: string,
  subjectId: string,
  subjectRelation?: string,
): ReferenceTuple {
  return {
    objectNs,
    objectId,
    relation,
    subjectNs,
    subjectId,
    ...(subjectRelation !== undefined ? { subjectRelation } : {}),
  };
}

function entityEq(a: EntityRef, b: EntityRef): boolean {
  return a.ns === b.ns && a.id === b.id;
}

// ---------------------------------------------------------------------------
// The independent verifier. See this file's own top-of-file doc comment for
// why this is a *validator*, never a *searcher*.
// ---------------------------------------------------------------------------

interface VState {
  visiting: ReadonlySet<string>;
  depth: number;
  maxDepth: number;
}

function vkey(object: EntityRef, name: string): string {
  return `${object.ns}\0${object.id}\0${name}`;
}

/** `state` extended with `object#name` added to `visiting` — never mutates `state.visiting`. */
function enter(state: VState, object: EntityRef, name: string): VState {
  const next = new Set(state.visiting);
  next.add(vkey(object, name));
  return { visiting: next, depth: state.depth, maxDepth: state.maxDepth };
}

function tuplesOn(
  tuples: readonly ReferenceTuple[],
  object: EntityRef,
  relation: string,
): ReferenceTuple[] {
  return tuples.filter(
    (t) => t.objectNs === object.ns && t.objectId === object.id && t.relation === relation,
  );
}

/** Verifies a POSITIVE `ResolutionStep` proves `subject` resolves for `name` on `object`. */
function verifyResolutionStep(
  schema: CompiledSchema,
  tuples: readonly ReferenceTuple[],
  subject: EntityRef,
  object: EntityRef,
  name: string,
  step: ResolutionStep,
  state: VState,
): boolean {
  if (state.depth > state.maxDepth) return false;
  if (state.visiting.has(vkey(object, name))) return false;

  const nsConfig = schema.namespaces[object.ns];
  if (!nsConfig) return false;
  const nextState = enter(state, object, name);

  const relation = nsConfig.relations[name];
  if (relation) {
    if (step.kind === 'directGrant') {
      if (!entityEq(step.object, object) || step.relation !== name) return false;
      if (!entityEq(step.subject, subject)) return false;
      return tuplesOn(tuples, object, name).some(
        (t) =>
          t.subjectRelation === undefined &&
          t.subjectNs === subject.ns &&
          t.subjectId === subject.id,
      );
    }
    if (step.kind === 'usersetMembership') {
      if (!entityEq(step.object, object) || step.relation !== name) return false;
      const tupleExists = tuplesOn(tuples, object, name).some(
        (t) =>
          t.subjectRelation === step.usersetRelation &&
          t.subjectNs === step.userset.ns &&
          t.subjectId === step.userset.id,
      );
      if (!tupleExists) return false;
      return verifyResolutionStep(
        schema,
        tuples,
        subject,
        step.userset,
        step.usersetRelation,
        step.member,
        { visiting: nextState.visiting, depth: state.depth + 1, maxDepth: state.maxDepth },
      );
    }
    return false;
  }

  const permission = nsConfig.permissions[name];
  if (permission) {
    return verifyAgainstRule(schema, tuples, subject, object, permission.rewrite, step, nextState);
  }
  return false;
}

function verifyAgainstRule(
  schema: CompiledSchema,
  tuples: readonly ReferenceTuple[],
  subject: EntityRef,
  object: EntityRef,
  rule: RewriteRule,
  step: ResolutionStep,
  state: VState,
): boolean {
  switch (rule.kind) {
    case 'computedUserset':
      return verifyResolutionStep(schema, tuples, subject, object, rule.name, step, {
        visiting: state.visiting,
        depth: state.depth + 1,
        maxDepth: state.maxDepth,
      });
    case 'union': {
      if (step.kind !== 'union' || !entityEq(step.object, object)) return false;
      const child = rule.children[step.branchIndex];
      if (!child) return false;
      return verifyAgainstRule(schema, tuples, subject, object, child, step.branch, state);
    }
    case 'intersection': {
      if (step.kind !== 'intersection' || !entityEq(step.object, object)) return false;
      if (step.branches.length !== rule.children.length) return false;
      return rule.children.every((child, i) => {
        const branch = step.branches[i];
        return (
          branch !== undefined &&
          verifyAgainstRule(schema, tuples, subject, object, child, branch, state)
        );
      });
    }
    case 'exclusion': {
      if (step.kind !== 'exclusion' || !entityEq(step.object, object)) return false;
      const baseOk = verifyAgainstRule(
        schema,
        tuples,
        subject,
        object,
        rule.base,
        step.base,
        state,
      );
      if (!baseOk) return false;
      return verifyDisproofAgainstRule(
        schema,
        tuples,
        subject,
        object,
        rule.subtract,
        step.subtractDisproof,
        state,
      );
    }
    case 'tupleToUserset': {
      if (step.kind !== 'tupleToUserset' || !entityEq(step.object, object)) return false;
      if (step.relation !== rule.relation || step.computedUserset !== rule.computedUserset)
        return false;
      const tupleExists = tuples.some(
        (t) =>
          t.objectNs === object.ns &&
          t.objectId === object.id &&
          t.relation === rule.relation &&
          t.subjectNs === step.through.ns &&
          t.subjectId === step.through.id,
      );
      if (!tupleExists) return false;
      return verifyResolutionStep(
        schema,
        tuples,
        subject,
        step.through,
        rule.computedUserset,
        step.member,
        {
          visiting: state.visiting,
          depth: state.depth + 1,
          maxDepth: state.maxDepth,
        },
      );
    }
    default:
      return false;
  }
}

/** Verifies a NEGATIVE `DisproofStep` proves `subject` does NOT resolve for `name` on `object`. */
function verifyDisproofStep(
  schema: CompiledSchema,
  tuples: readonly ReferenceTuple[],
  subject: EntityRef,
  object: EntityRef,
  name: string,
  disproof: DisproofStep,
  state: VState,
): boolean {
  if (disproof.kind === 'boundReached') {
    if (!entityEq(disproof.object, object) || disproof.name !== name) return false;
    if (disproof.reason === 'depth') return state.depth > state.maxDepth;
    return state.visiting.has(vkey(object, name));
  }
  // Reaching any other disproof kind implies resolveMembership's own guards
  // did NOT trip at this node — verify that's actually consistent.
  if (state.depth > state.maxDepth) return false;
  if (state.visiting.has(vkey(object, name))) return false;

  const nsConfig = schema.namespaces[object.ns];
  if (disproof.kind === 'undeclared') {
    if (!entityEq(disproof.object, object) || disproof.name !== name) return false;
    if (!nsConfig) return true;
    return !nsConfig.relations[name] && !nsConfig.permissions[name];
  }
  if (!nsConfig) return false;
  const nextState = enter(state, object, name);

  const relation = nsConfig.relations[name];
  if (relation) {
    if (disproof.kind !== 'relationDisproof') return false;
    if (!entityEq(disproof.object, object) || disproof.relation !== name) return false;
    const real = tuplesOn(tuples, object, name);
    if (disproof.tupleDisproofs.length !== real.length) return false;
    return real.every((t) => {
      if (t.subjectRelation === undefined) {
        return disproof.tupleDisproofs.some(
          (d) =>
            d.kind === 'subjectMismatch' &&
            d.subject.ns === t.subjectNs &&
            d.subject.id === t.subjectId &&
            !(t.subjectNs === subject.ns && t.subjectId === subject.id),
        );
      }
      return disproof.tupleDisproofs.some(
        (d) =>
          d.kind === 'usersetNotMember' &&
          d.userset.ns === t.subjectNs &&
          d.userset.id === t.subjectId &&
          d.usersetRelation === t.subjectRelation &&
          verifyDisproofStep(
            schema,
            tuples,
            subject,
            { ns: t.subjectNs, id: t.subjectId },
            t.subjectRelation,
            d.disproof,
            {
              visiting: nextState.visiting,
              depth: state.depth + 1,
              maxDepth: state.maxDepth,
            },
          ),
      );
    });
  }
  const permission = nsConfig.permissions[name];
  if (permission) {
    return verifyDisproofAgainstRule(
      schema,
      tuples,
      subject,
      object,
      permission.rewrite,
      disproof,
      nextState,
    );
  }
  return false;
}

function verifyDisproofAgainstRule(
  schema: CompiledSchema,
  tuples: readonly ReferenceTuple[],
  subject: EntityRef,
  object: EntityRef,
  rule: RewriteRule,
  disproof: DisproofStep,
  state: VState,
): boolean {
  switch (rule.kind) {
    case 'computedUserset':
      return verifyDisproofStep(schema, tuples, subject, object, rule.name, disproof, {
        visiting: state.visiting,
        depth: state.depth + 1,
        maxDepth: state.maxDepth,
      });
    case 'union': {
      if (disproof.kind !== 'unionDisproof' || !entityEq(disproof.object, object)) return false;
      if (disproof.branches.length !== rule.children.length) return false;
      return rule.children.every((child, i) => {
        const branch = disproof.branches[i];
        return (
          branch !== undefined &&
          verifyDisproofAgainstRule(schema, tuples, subject, object, child, branch, state)
        );
      });
    }
    case 'intersection': {
      if (disproof.kind !== 'intersectionDisproof' || !entityEq(disproof.object, object))
        return false;
      const child = rule.children[disproof.branchIndex];
      if (!child) return false;
      return verifyDisproofAgainstRule(
        schema,
        tuples,
        subject,
        object,
        child,
        disproof.branch,
        state,
      );
    }
    case 'exclusion': {
      if (disproof.kind !== 'exclusionDisproof' || !entityEq(disproof.object, object)) return false;
      if (disproof.reason.kind === 'baseDisproven') {
        return verifyDisproofAgainstRule(
          schema,
          tuples,
          subject,
          object,
          rule.base,
          disproof.reason.base,
          state,
        );
      }
      if (disproof.reason.kind === 'subtractProven') {
        return verifyAgainstRule(
          schema,
          tuples,
          subject,
          object,
          rule.subtract,
          disproof.reason.subtract,
          state,
        );
      }
      // `subtractUnprovable` — the exclusion/cycle-guard soundness fix (see
      // the resolver's own `ExclusionDisproof` doc comment). Structurally
      // unreachable here: this function only ever walks a WINNING proof's
      // own `subtractDisproof` field, and anything that taints `subtract`
      // also taints the containing exclusion itself, which then can't be
      // `allowed: true` (and so can never be embedded in a winning proof)
      // either — see `MembershipOutcome.certain`'s own doc comment for why.
      // A verifier reaching this branch at all means that invariant broke;
      // fail the verification rather than silently accept it.
      return false;
    }
    case 'tupleToUserset': {
      if (disproof.kind !== 'tupleToUsersetDisproof' || !entityEq(disproof.object, object))
        return false;
      if (disproof.relation !== rule.relation) return false;
      const real = tuples.filter(
        (t) => t.objectNs === object.ns && t.objectId === object.id && t.relation === rule.relation,
      );
      if (disproof.followed.length !== real.length) return false;
      return real.every((t) =>
        disproof.followed.some(
          (f) =>
            f.through.ns === t.subjectNs &&
            f.through.id === t.subjectId &&
            verifyDisproofStep(
              schema,
              tuples,
              subject,
              f.through,
              rule.computedUserset,
              f.disproof,
              {
                visiting: state.visiting,
                depth: state.depth + 1,
                maxDepth: state.maxDepth,
              },
            ),
        ),
      );
    }
    default:
      return false;
  }
}

/** Top-level entry point matching `referenceCheck`'s own top-level call shape. */
function verifyPath(
  schema: CompiledSchema,
  tuples: readonly ReferenceTuple[],
  subject: EntityRef,
  object: EntityRef,
  name: string,
  path: ResolutionStep,
  maxDepth: number,
): boolean {
  return verifyResolutionStep(schema, tuples, subject, object, name, path, {
    visiting: new Set(),
    depth: 0,
    maxDepth,
  });
}

// ---------------------------------------------------------------------------
// Positive cases: real allowed:true results, independently re-verified.
// ---------------------------------------------------------------------------

describe('a direct grant produces a path that independently re-verifies', () => {
  const source = [
    'namespace doc {',
    '  relation viewer: user',
    '  relation editor: user',
    '',
    '  permission view = viewer | editor',
    '}',
  ].join('\n');

  it('direct-grant-path-reverifies', () => {
    const schema = compileOk(source);
    const tuples = [tuple('doc', 'readme', 'viewer', 'user', 'alice')];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'alice'),
      ref('doc', 'readme'),
      'view',
    );

    expect(result.allowed).toBe(true);
    expect(result.path).toBeDefined();
    if (!result.path) return;

    // The shape §8 names: alice's grant is direct, so the path bottoms out
    // in a `union` (view = viewer | editor) wrapping a `directGrant`.
    expect(result.path.kind).toBe('union');

    expect(
      verifyPath(
        schema,
        tuples,
        ref('user', 'alice'),
        ref('doc', 'readme'),
        'view',
        result.path,
        1000,
      ),
    ).toBe(true);
  });
});

describe('a tuple-to-userset chain through a nested group produces a path that independently re-verifies', () => {
  // §8's own worked example shape: user:alice -> group:eng#member ->
  // folder:design#editor -> document:readme#view.
  const source = [
    'namespace group {',
    '  relation member: user | group#member',
    '}',
    '',
    'namespace folder {',
    '  relation editor: user | group#member',
    '',
    '  permission view = editor',
    '}',
    '',
    'namespace document {',
    '  relation parent: folder',
    '',
    '  permission view = parent->view',
    '}',
  ].join('\n');

  it('nested-group-tuple-to-userset-path-reverifies', () => {
    const schema = compileOk(source);
    const tuples: ReferenceTuple[] = [
      tuple('group', 'eng', 'member', 'user', 'alice'),
      tuple('folder', 'design', 'editor', 'group', 'eng', 'member'),
      tuple('document', 'readme', 'parent', 'folder', 'design'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'alice'),
      ref('document', 'readme'),
      'view',
    );

    expect(result.allowed).toBe(true);
    expect(result.path).toBeDefined();
    if (!result.path) return;

    expect(result.path.kind).toBe('tupleToUserset');
    expect(
      verifyPath(
        schema,
        tuples,
        ref('user', 'alice'),
        ref('document', 'readme'),
        'view',
        result.path,
        1000,
      ),
    ).toBe(true);
  });
});

describe('an intersection produces a path recording every branch, which independently re-verifies', () => {
  const source = [
    'namespace doc {',
    '  relation owner: user',
    '  relation editor: user',
    '',
    '  permission trusted_edit = editor & owner',
    '}',
  ].join('\n');

  it('intersection-both-branches-path-reverifies', () => {
    const schema = compileOk(source);
    const tuples: ReferenceTuple[] = [
      tuple('doc', 'readme', 'editor', 'user', 'dave'),
      tuple('doc', 'readme', 'owner', 'user', 'dave'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'dave'),
      ref('doc', 'readme'),
      'trusted_edit',
    );

    expect(result.allowed).toBe(true);
    expect(result.path).toBeDefined();
    if (!result.path || result.path.kind !== 'intersection') {
      throw new Error('expected an intersection step');
    }
    expect(result.path.branches).toHaveLength(2);
    expect(
      verifyPath(
        schema,
        tuples,
        ref('user', 'dave'),
        ref('doc', 'readme'),
        'trusted_edit',
        result.path,
        1000,
      ),
    ).toBe(true);
  });
});

describe('an exclusion produces a path with a base proof and a subtract disproof, both of which independently re-verify', () => {
  const source = [
    'namespace doc {',
    '  relation viewer: user',
    '  relation banned: user',
    '',
    '  permission unbanned_view = viewer - banned',
    '}',
  ].join('\n');

  it('exclusion-path-with-disproof-reverifies', () => {
    const schema = compileOk(source);
    // frank is a viewer, NOT banned, and a decoy 'gina' is banned (so the
    // relationDisproof inside subtractDisproof has real content to account
    // for, not just an empty tuple list).
    const tuples: ReferenceTuple[] = [
      tuple('doc', 'readme', 'viewer', 'user', 'frank'),
      tuple('doc', 'readme', 'banned', 'user', 'gina'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'frank'),
      ref('doc', 'readme'),
      'unbanned_view',
    );

    expect(result.allowed).toBe(true);
    expect(result.path).toBeDefined();
    if (!result.path || result.path.kind !== 'exclusion') {
      throw new Error('expected an exclusion step');
    }
    expect(result.path.subtractDisproof.kind).toBe('relationDisproof');
    if (result.path.subtractDisproof.kind === 'relationDisproof') {
      // gina's ban tuple is a real tuple examined and shown to be a subject
      // mismatch, not simply absent — the disproof is exhaustive, not empty.
      expect(result.path.subtractDisproof.tupleDisproofs).toHaveLength(1);
    }
    expect(
      verifyPath(
        schema,
        tuples,
        ref('user', 'frank'),
        ref('doc', 'readme'),
        'unbanned_view',
        result.path,
        1000,
      ),
    ).toBe(true);
  });

  it('exclusion-subtract-disproof-through-a-userset-reverifies', () => {
    // A harder subtract branch: `banned` is itself satisfiable via a group
    // userset reference, and the disproof must recurse through it (a
    // `usersetNotMember` tuple disproof wrapping a nested relationDisproof),
    // not just handle the flat case.
    const nested = [
      'namespace group {',
      '  relation member: user',
      '}',
      '',
      'namespace doc {',
      '  relation viewer: user',
      '  relation banned: user | group#member',
      '',
      '  permission unbanned_view = viewer - banned',
      '}',
    ].join('\n');
    const schema = compileOk(nested);
    const tuples: ReferenceTuple[] = [
      tuple('doc', 'readme', 'viewer', 'user', 'frank'),
      tuple('doc', 'readme', 'banned', 'group', 'exiled', 'member'),
      // exiled group members: someone other than frank, so the nested
      // relationDisproof has to account for a real, non-matching tuple.
      tuple('group', 'exiled', 'member', 'user', 'gina'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'frank'),
      ref('doc', 'readme'),
      'unbanned_view',
    );

    expect(result.allowed).toBe(true);
    expect(result.path).toBeDefined();
    if (!result.path) return;
    expect(
      verifyPath(
        schema,
        tuples,
        ref('user', 'frank'),
        ref('doc', 'readme'),
        'unbanned_view',
        result.path,
        1000,
      ),
    ).toBe(true);
  });
});

describe('a cyclic group nesting next to a real grant still produces a path that reverifies, and the cycle never appears on the winning branch', () => {
  const source = ['namespace group {', '  relation member: user | group#member', '}'].join('\n');

  it('cyclic-nesting-real-grant-path-reverifies', () => {
    const schema = compileOk(source);
    const tuples: ReferenceTuple[] = [
      tuple('group', 'a', 'member', 'group', 'b', 'member'),
      tuple('group', 'b', 'member', 'group', 'a', 'member'),
      tuple('group', 'a', 'member', 'user', 'mabel'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'mabel'),
      ref('group', 'a'),
      'member',
    );

    expect(result.allowed).toBe(true);
    expect(result.path).toBeDefined();
    if (!result.path) return;
    // The winning branch is the direct grant, not the cyclic one.
    expect(result.path.kind).toBe('directGrant');
    expect(
      verifyPath(
        schema,
        tuples,
        ref('user', 'mabel'),
        ref('group', 'a'),
        'member',
        result.path,
        1000,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Power check: the verifier must actually be able to fail.
// ---------------------------------------------------------------------------

describe('the independent verifier rejects a tampered path — proving it has power, not just that it accepts what the resolver already produced', () => {
  const source = [
    'namespace group {',
    '  relation member: user | group#member',
    '}',
    '',
    'namespace doc {',
    '  relation viewer: user',
    '  relation editor: user | group#member',
    '  relation banned: user',
    '',
    '  permission view = viewer | editor',
    '  permission unbanned_view = viewer - banned',
    '}',
  ].join('\n');
  const schema = compileOk(source);

  function buildUnionPath(): { tuples: ReferenceTuple[]; path: ResolutionStep } {
    const tuples: ReferenceTuple[] = [tuple('doc', 'readme', 'viewer', 'user', 'alice')];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'alice'),
      ref('doc', 'readme'),
      'view',
    );
    if (!result.allowed || !result.path) throw new Error('fixture setup expected allowed: true');
    return { tuples, path: result.path };
  }

  it('rejects-a-direct-grant-step-naming-a-tuple-that-does-not-exist', () => {
    const { tuples, path } = buildUnionPath();
    if (path.kind !== 'union' || path.branch.kind !== 'directGrant') {
      throw new Error('expected union(directGrant)');
    }
    const tampered: ResolutionStep = {
      ...path,
      branch: { ...path.branch, subject: { ns: 'user', id: 'someone-else-entirely' } },
    };
    expect(
      verifyPath(
        schema,
        tuples,
        ref('user', 'alice'),
        ref('doc', 'readme'),
        'view',
        tampered,
        1000,
      ),
    ).toBe(false);
  });

  it('rejects-a-union-step-pointing-at-an-out-of-range-branch-index', () => {
    const { tuples, path } = buildUnionPath();
    if (path.kind !== 'union') throw new Error('expected a union step');
    const tampered: ResolutionStep = { ...path, branchIndex: 99 };
    expect(
      verifyPath(
        schema,
        tuples,
        ref('user', 'alice'),
        ref('doc', 'readme'),
        'view',
        tampered,
        1000,
      ),
    ).toBe(false);
  });

  it('rejects-a-directgrant-step-whose-object-does-not-match-the-object-being-checked', () => {
    const { tuples, path } = buildUnionPath();
    if (path.kind !== 'union' || path.branch.kind !== 'directGrant') {
      throw new Error('expected union(directGrant)');
    }
    const tampered: ResolutionStep = {
      ...path,
      branch: { ...path.branch, object: { ns: 'doc', id: 'a-different-object' } },
    };
    expect(
      verifyPath(
        schema,
        tuples,
        ref('user', 'alice'),
        ref('doc', 'readme'),
        'view',
        tampered,
        1000,
      ),
    ).toBe(false);
  });

  it('rejects-an-exclusion-path-whose-subtract-disproof-omits-a-real-banning-tuple', () => {
    const tuples: ReferenceTuple[] = [
      tuple('doc', 'readme', 'viewer', 'user', 'frank'),
      tuple('doc', 'readme', 'banned', 'user', 'gina'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'frank'),
      ref('doc', 'readme'),
      'unbanned_view',
    );
    if (!result.allowed || !result.path || result.path.kind !== 'exclusion') {
      throw new Error('fixture setup expected an allowed exclusion');
    }
    if (result.path.subtractDisproof.kind !== 'relationDisproof') {
      throw new Error('expected a relationDisproof');
    }
    // Drop the (only) real tupleDisproof entry — the disproof is no longer
    // exhaustive, and must be rejected even though the top-level boolean
    // claim ("subtract is false") is still, coincidentally, true.
    const tamperedDisproof: DisproofStep = { ...result.path.subtractDisproof, tupleDisproofs: [] };
    const tampered: ResolutionStep = { ...result.path, subtractDisproof: tamperedDisproof };
    expect(
      verifyPath(
        schema,
        tuples,
        ref('user', 'frank'),
        ref('doc', 'readme'),
        'unbanned_view',
        tampered,
        1000,
      ),
    ).toBe(false);
  });

  it('rejects-an-exclusion-path-whose-subtract-disproof-fabricates-a-subject-mismatch-for-the-actual-queried-subject', () => {
    // frank himself is banned; the real result must be denied (no path),
    // but a maliciously-constructed path could still claim frank's own
    // banned tuple is "someone else" to fake an allow. The verifier must
    // catch this by checking the disproof entry's subject actually matches
    // the real tuple's subject, not just that *a* tuple exists.
    const tuples: ReferenceTuple[] = [
      tuple('doc', 'readme', 'viewer', 'user', 'frank'),
      tuple('doc', 'readme', 'banned', 'user', 'frank'),
    ];
    const forgedPath: ResolutionStep = {
      kind: 'exclusion',
      object: ref('doc', 'readme'),
      base: {
        kind: 'directGrant',
        object: ref('doc', 'readme'),
        relation: 'viewer',
        subject: ref('user', 'frank'),
      },
      subtractDisproof: {
        kind: 'relationDisproof',
        object: ref('doc', 'readme'),
        relation: 'banned',
        // Lies: claims frank's own real ban tuple names someone else.
        tupleDisproofs: [{ kind: 'subjectMismatch', subject: ref('user', 'someone-else') }],
      },
    };
    expect(
      verifyPath(
        schema,
        tuples,
        ref('user', 'frank'),
        ref('doc', 'readme'),
        'unbanned_view',
        forgedPath,
        1000,
      ),
    ).toBe(false);
  });

  it('rejects-a-usersetmembership-step-naming-a-tuple-that-does-not-exist', () => {
    const tuples: ReferenceTuple[] = [tuple('group', 'eng', 'member', 'user', 'alice')];
    const forged: ResolutionStep = {
      kind: 'usersetMembership',
      object: ref('doc', 'readme'),
      relation: 'editor',
      // No such tuple: doc:readme's editor never names group:eng#member.
      userset: ref('group', 'eng'),
      usersetRelation: 'member',
      member: {
        kind: 'directGrant',
        object: ref('group', 'eng'),
        relation: 'member',
        subject: ref('user', 'alice'),
      },
    };
    expect(
      verifyPath(
        schema,
        tuples,
        ref('user', 'alice'),
        ref('doc', 'readme'),
        'editor',
        forged,
        1000,
      ),
    ).toBe(false);
  });
});
