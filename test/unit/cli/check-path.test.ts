/**
 * `renderResolutionPath` (`src/cli/commands/check.ts`) — full-repo audit
 * finding #8 (MEDIUM, 2026-08-16): the README's own headline example states
 * `authz check user:dana edit document:eng_handbook` "returns this exact
 * path" (a 5-hop diagram), and its "try it yourself" walkthrough runs
 * exactly that command — but before `--path` existed, plain `check` never
 * printed anything resembling it. This file pins the renderer's own
 * correctness directly, DB-free, with hand-built `ResolutionStep` trees —
 * `test/unit/cli/check-path.integration.test.ts` proves the same thing
 * end-to-end against the real seeded example graph.
 *
 * **Why this needs its own DB-free test, not just the integration one.**
 * The first version of this renderer had a real bug, caught during live
 * verification against the seeded example graph: it printed the trailing
 * label for a `tupleToUserset` hop using `step.relation` (the *tuple*
 * relation followed, e.g. `"parent"`) instead of the *outer* permission
 * name actually being satisfied at that object (e.g. `"edit"`) — producing
 * `document:eng_handbook#parent` where the README's own diagram says
 * `document:eng_handbook#edit`. The fix threads that name down explicitly
 * as a parameter (`renderResolutionPath`'s own doc comment explains why
 * none of `union`/`intersection`/`exclusion`/`tupleToUserset` carry it on
 * the step itself). `schema/example.authz`'s own rewrite rule happens to
 * make `step.computedUserset` differ from both the outer name AND the
 * followed relation for its one `tupleToUserset` case, which is exactly
 * what caught the bug live — but nothing stops a *future* change to that
 * schema (or to this renderer) from reintroducing it for a case the
 * example graph no longer happens to exercise. These hand-built trees make
 * `name`, `relation`, and `computedUserset` three genuinely different
 * strings on purpose, so this test fails for the right reason regardless
 * of what any real schema currently looks like.
 *
 * `test/unit/cli/check.integration.test.ts`'s own
 * "a-real-cli-check-invocation-with---path-prints-the-real-resolution-path"
 * case proves the same flag end-to-end against the real seeded example
 * graph and the README's own quoted diagram, rather than a second new
 * file — this repo's own established convention (`check.integration.test.ts`
 * already exists specifically for real-CLI-command-function proof).
 */
import { describe, expect, it } from 'vitest';

import { renderResolutionPath } from '../../../src/cli/commands/check.js';
import type { DisproofStep, ResolutionStep } from '../../../src/resolve/production/resolver.js';

const e = (ns: string, id: string) => ({ ns, id });

describe('renderResolutionPath', () => {
  it('a-direct-grant-renders-subject-then-object-hash-relation', () => {
    const step: ResolutionStep = {
      kind: 'directGrant',
      object: e('document', 'readme'),
      relation: 'viewer',
      subject: e('user', 'alice'),
    };
    expect(renderResolutionPath(step, 'view')).toEqual([
      'user:alice',
      '  → document:readme#viewer',
    ]);
  });

  it('a-userset-membership-chain-appends-its-own-real-relation-name-not-the-threaded-name', () => {
    const step: ResolutionStep = {
      kind: 'usersetMembership',
      object: e('document', 'readme'),
      relation: 'viewer',
      userset: e('group', 'eng'),
      usersetRelation: 'member',
      member: {
        kind: 'directGrant',
        object: e('group', 'eng'),
        relation: 'member',
        subject: e('user', 'alice'),
      },
    };
    // Threaded `name` is deliberately something else entirely ('view') —
    // usersetMembership must ignore it and use its own `step.relation`.
    expect(renderResolutionPath(step, 'view')).toEqual([
      'user:alice',
      '  → group:eng#member',
      '  → document:readme#viewer',
    ]);
  });

  it('a-union-is-transparent-and-passes-the-threaded-name-through-unchanged', () => {
    const step: ResolutionStep = {
      kind: 'union',
      object: e('document', 'readme'),
      branchIndex: 0,
      branch: {
        kind: 'directGrant',
        object: e('document', 'readme'),
        relation: 'editor',
        subject: e('user', 'alice'),
      },
    };
    // The union node itself contributes no line of its own.
    expect(renderResolutionPath(step, 'edit')).toEqual([
      'user:alice',
      '  → document:readme#editor',
    ]);
  });

  it('a-tuple-to-userset-hop-labels-its-own-object-with-the-threaded-outer-name-not-the-followed-relation-or-the-computed-userset', () => {
    // The exact bug caught live: `relation` ('parent'), `computedUserset'
    // ('editor'), and the threaded outer `name` ('edit') are all three
    // different strings on purpose.
    const step: ResolutionStep = {
      kind: 'tupleToUserset',
      object: e('document', 'eng_handbook'),
      relation: 'parent',
      computedUserset: 'editor',
      through: e('folder', 'eng_docs'),
      member: {
        kind: 'directGrant',
        object: e('folder', 'eng_docs'),
        relation: 'editor',
        subject: e('user', 'dana'),
      },
    };
    const lines = renderResolutionPath(step, 'edit');
    // The recursive member's own trailing line must use `computedUserset`
    // ('editor'), reached because directGrant always uses its own
    // `step.relation` — this assertion exists specifically so a future
    // change that stops threading `computedUserset` into the recursive
    // call doesn't silently pass by accident (directGrant would still
    // print 'editor' regardless of what name was threaded to it).
    expect(lines).toEqual([
      'user:dana',
      '  → folder:eng_docs#editor',
      // The outer hop must be #edit (the threaded name) — NOT #parent
      // (step.relation) and NOT #editor (step.computedUserset). This line
      // is the one that was wrong before the fix.
      '  → document:eng_handbook#edit',
    ]);
  });

  it('an-intersection-renders-every-branch-as-an-indented-sub-list-under-the-threaded-name', () => {
    const step: ResolutionStep = {
      kind: 'intersection',
      object: e('folder', 'finance_docs'),
      branches: [
        {
          kind: 'directGrant',
          object: e('folder', 'finance_docs'),
          relation: 'viewer',
          subject: e('user', 'carol'),
        },
        {
          kind: 'directGrant',
          object: e('folder', 'finance_docs'),
          relation: 'sensitive_reviewer',
          subject: e('user', 'carol'),
        },
      ],
    };
    expect(renderResolutionPath(step, 'sensitive_review')).toEqual([
      'folder:finance_docs#sensitive_review — ALL of:',
      '  user:carol',
      '    → folder:finance_docs#viewer',
      '  user:carol',
      '    → folder:finance_docs#sensitive_reviewer',
    ]);
  });

  it('an-exclusion-renders-its-base-branch-under-a-not-excluded-header-and-ignores-the-negative-witness-entirely', () => {
    const subtractDisproof: DisproofStep = {
      kind: 'undeclared',
      object: e('org', 'acme'),
      name: 'banned',
    };
    const step: ResolutionStep = {
      kind: 'exclusion',
      object: e('org', 'acme'),
      base: {
        kind: 'directGrant',
        object: e('org', 'acme'),
        relation: 'member',
        subject: e('user', 'alice'),
      },
      subtractDisproof,
    };
    expect(renderResolutionPath(step, 'view')).toEqual([
      'org:acme#view — granted, and not excluded:',
      '  user:alice',
      '    → org:acme#member',
    ]);
  });
});
