/**
 * Unit tests for `src/schema/diff.ts`'s `diffNamespace`/`narrowingWarnings`
 * — DB-free, pure, plain `vitest run` (no Postgres). These pin down
 * `diffNamespace`'s own stated contract before `authz schema diff`
 * (`src/cli/commands/schema.ts`) is ever trusted to warn a real caller
 * about a real candidate schema — the same "trust the classifier via
 * hand-derived examples before anything downstream relies on it"
 * discipline `test/unit/metamorphic/monotonicity.test.ts` already
 * established for `classifyMonotone`.
 *
 * Schemas are hand-built `CompiledSchema` object literals throughout
 * (never routed through `compileSchema`) — `diffNamespace`'s own public
 * contract operates on the `CompiledSchema`/`NamespaceConfig` *shape*
 * (`src/schema/dsl/types.ts`), and hand-building it directly lets each
 * test isolate exactly one rewrite-rule-kind change at a time, matching
 * `monotonicity.test.ts`'s own precedent and stated reasoning for the
 * identical choice.
 */
import { describe, expect, it } from 'vitest';

import { diffNamespace, narrowingWarnings, type MemberDiff } from '../../../src/schema/diff.js';
import type {
  CompiledSchema,
  NamespaceConfig,
  RewriteRule,
} from '../../../src/schema/dsl/types.js';

// ---------------------------------------------------------------------------
// Small hand-built-schema helpers, matching monotonicity.test.ts's own.
// ---------------------------------------------------------------------------

function userRelation(name: string): NamespaceConfig['relations'][string] {
  return { kind: 'relation', name, subjectTypes: [{ namespace: 'user' }] };
}

function permission(name: string, rewrite: RewriteRule): NamespaceConfig['permissions'][string] {
  return { kind: 'permission', name, rewrite };
}

function computed(name: string): RewriteRule {
  return { kind: 'computedUserset', name };
}

function union(...children: RewriteRule[]): RewriteRule {
  return { kind: 'union', children };
}

function intersection(...children: RewriteRule[]): RewriteRule {
  return { kind: 'intersection', children };
}

function exclusion(base: RewriteRule, subtract: RewriteRule): RewriteRule {
  return { kind: 'exclusion', base, subtract };
}

function ns(namespace: string, config: Partial<NamespaceConfig> = {}): NamespaceConfig {
  return { namespace, relations: {}, permissions: {}, ...config };
}

/** Wraps a single `NamespaceConfig` as the one-namespace `CompiledSchema` `diffNamespace` accepts on each side — exactly the shape `src/cli/commands/schema.ts`'s `diffSchemaFile` builds from `getLatestNamespaceConfig`'s own single-`NamespaceConfig` result. */
function schemaOf(config: NamespaceConfig): CompiledSchema {
  return { namespaces: { [config.namespace]: config } };
}

function findMember(diff: { members: MemberDiff[] }, name: string): MemberDiff {
  const member = diff.members.find((m) => m.name === name);
  if (!member) throw new Error(`no member named '${name}' in diff result`);
  return member;
}

// ---------------------------------------------------------------------------
// unchanged / added / removed
// ---------------------------------------------------------------------------

describe('diffNamespace — unchanged, added, removed', () => {
  it('an identical relation and an identical permission both report unchanged', () => {
    const oldConfig = ns('doc', {
      relations: { viewer: userRelation('viewer') },
      permissions: { view: permission('view', computed('viewer')) },
    });
    const newConfig = ns('doc', {
      relations: { viewer: userRelation('viewer') },
      permissions: { view: permission('view', computed('viewer')) },
    });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');

    expect(findMember(diff, 'viewer').status).toBe('unchanged');
    expect(findMember(diff, 'view').status).toBe('unchanged');
    expect(narrowingWarnings(diff)).toHaveLength(0);
  });

  it('a relation/permission present only in the new config reports added, and never warns', () => {
    const oldConfig = ns('doc', { relations: { viewer: userRelation('viewer') } });
    const newConfig = ns('doc', {
      relations: { viewer: userRelation('viewer'), editor: userRelation('editor') },
      permissions: { edit: permission('edit', computed('editor')) },
    });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');

    expect(findMember(diff, 'editor').status).toBe('added');
    expect(findMember(diff, 'edit').status).toBe('added');
    expect(narrowingWarnings(diff)).toHaveLength(0);
  });

  it('a relation/permission present only in the old config reports removed, and IS a warning — the clearest possible silent-revocation case', () => {
    const oldConfig = ns('doc', {
      relations: { viewer: userRelation('viewer'), editor: userRelation('editor') },
      permissions: { edit: permission('edit', computed('editor')) },
    });
    const newConfig = ns('doc', { relations: { viewer: userRelation('viewer') } });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');

    expect(findMember(diff, 'editor').status).toBe('removed');
    expect(findMember(diff, 'edit').status).toBe('removed');

    const warnings = narrowingWarnings(diff);
    const warnedNames = warnings.map((w) => w.name).sort();
    expect(warnedNames).toEqual(['edit', 'editor']);
  });

  it('a name that switches from a relation to a permission (or back) is changed/possibly-narrowing unconditionally — no sound containment argument applies across a kind change', () => {
    const oldConfig = ns('doc', { relations: { thing: userRelation('thing') } });
    const newConfig = ns('doc', {
      permissions: { thing: permission('thing', computed('nonexistent-but-unused-in-this-test')) },
    });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');
    const member = findMember(diff, 'thing');
    expect(member.status).toBe('changed');
    expect(member.classification).toBe('possibly-narrowing');
  });
});

// ---------------------------------------------------------------------------
// Relations — subject-type set changes.
// ---------------------------------------------------------------------------

describe('diffNamespace — relation subject-type changes', () => {
  it('gaining a new allowed subject type (existing types untouched) classifies widen', () => {
    const oldConfig = ns('doc', { relations: { viewer: userRelation('viewer') } });
    const newConfig = ns('doc', {
      relations: {
        viewer: {
          kind: 'relation',
          name: 'viewer',
          subjectTypes: [{ namespace: 'user' }, { namespace: 'group', relation: 'member' }],
        },
      },
    });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');
    const member = findMember(diff, 'viewer');
    expect(member.status).toBe('changed');
    expect(member.classification).toBe('widen');
    expect(narrowingWarnings(diff)).toHaveLength(0);
  });

  it('losing a previously-allowed subject type classifies possibly-narrowing', () => {
    const oldConfig = ns('doc', {
      relations: {
        viewer: {
          kind: 'relation',
          name: 'viewer',
          subjectTypes: [{ namespace: 'user' }, { namespace: 'group', relation: 'member' }],
        },
      },
    });
    const newConfig = ns('doc', { relations: { viewer: userRelation('viewer') } });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');
    const member = findMember(diff, 'viewer');
    expect(member.status).toBe('changed');
    expect(member.classification).toBe('possibly-narrowing');
    expect(narrowingWarnings(diff)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Permissions — the real widen/narrow cases the task explicitly asks for.
// ---------------------------------------------------------------------------

describe('diffNamespace — permission rewrite-rule changes: real union-widening case', () => {
  it('view = viewer, changed to view = viewer | editor (a union gaining a new branch), classifies widen', () => {
    const oldConfig = ns('doc', {
      relations: { viewer: userRelation('viewer'), editor: userRelation('editor') },
      permissions: { view: permission('view', computed('viewer')) },
    });
    const newConfig = ns('doc', {
      relations: { viewer: userRelation('viewer'), editor: userRelation('editor') },
      permissions: { view: permission('view', union(computed('viewer'), computed('editor'))) },
    });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');
    const member = findMember(diff, 'view');
    expect(member.status).toBe('changed');
    expect(member.classification).toBe('widen');
    expect(narrowingWarnings(diff)).toHaveLength(0);
  });

  it('view = viewer | editor, changed to view = viewer | editor | owner (an ALREADY-union gaining a further branch), classifies widen', () => {
    const relations = {
      viewer: userRelation('viewer'),
      editor: userRelation('editor'),
      owner: userRelation('owner'),
    };
    const oldConfig = ns('doc', {
      relations,
      permissions: { view: permission('view', union(computed('viewer'), computed('editor'))) },
    });
    const newConfig = ns('doc', {
      relations,
      permissions: {
        view: permission('view', union(computed('viewer'), computed('editor'), computed('owner'))),
      },
    });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');
    expect(findMember(diff, 'view').classification).toBe('widen');
  });
});

describe('diffNamespace — permission rewrite-rule changes: real exclusion-narrowing case', () => {
  it('view = viewer, changed to view = viewer - banned (an exclusion GAINING a subtract side), classifies possibly-narrowing', () => {
    const oldConfig = ns('doc', {
      relations: { viewer: userRelation('viewer'), banned: userRelation('banned') },
      permissions: { view: permission('view', computed('viewer')) },
    });
    const newConfig = ns('doc', {
      relations: { viewer: userRelation('viewer'), banned: userRelation('banned') },
      permissions: {
        view: permission('view', exclusion(computed('viewer'), computed('banned'))),
      },
    });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');
    const member = findMember(diff, 'view');
    expect(member.status).toBe('changed');
    expect(member.classification).toBe('possibly-narrowing');

    const warnings = narrowingWarnings(diff);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.name).toBe('view');
    expect(warnings[0]?.kind).toBe('permission');
  });

  it("an exclusion's subtract side GROWING (viewer - banned, changed to viewer - (banned | flagged)) classifies possibly-narrowing", () => {
    const relations = {
      viewer: userRelation('viewer'),
      banned: userRelation('banned'),
      flagged: userRelation('flagged'),
    };
    const oldConfig = ns('doc', {
      relations,
      permissions: { view: permission('view', exclusion(computed('viewer'), computed('banned'))) },
    });
    const newConfig = ns('doc', {
      relations,
      permissions: {
        view: permission(
          'view',
          exclusion(computed('viewer'), union(computed('banned'), computed('flagged'))),
        ),
      },
    });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');
    expect(findMember(diff, 'view').classification).toBe('possibly-narrowing');
  });
});

describe('diffNamespace — the "exclusion losing its subtract side" widen case the task explicitly names', () => {
  it('view = viewer - banned, changed to view = viewer (the exclusion removed entirely), classifies widen', () => {
    const oldConfig = ns('doc', {
      relations: { viewer: userRelation('viewer'), banned: userRelation('banned') },
      permissions: {
        view: permission('view', exclusion(computed('viewer'), computed('banned'))),
      },
    });
    const newConfig = ns('doc', {
      relations: { viewer: userRelation('viewer'), banned: userRelation('banned') },
      permissions: { view: permission('view', computed('viewer')) },
    });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');
    const member = findMember(diff, 'view');
    expect(member.status).toBe('changed');
    expect(member.classification).toBe('widen');
    expect(narrowingWarnings(diff)).toHaveLength(0);
  });

  it("an exclusion's subtract side SHRINKING (viewer - (banned | flagged), changed to viewer - banned) classifies widen", () => {
    const relations = {
      viewer: userRelation('viewer'),
      banned: userRelation('banned'),
      flagged: userRelation('flagged'),
    };
    const oldConfig = ns('doc', {
      relations,
      permissions: {
        view: permission(
          'view',
          exclusion(computed('viewer'), union(computed('banned'), computed('flagged'))),
        ),
      },
    });
    const newConfig = ns('doc', {
      relations,
      permissions: { view: permission('view', exclusion(computed('viewer'), computed('banned'))) },
    });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');
    expect(findMember(diff, 'view').classification).toBe('widen');
  });
});

describe('diffNamespace — intersection: gaining a conjunct narrows, losing one widens', () => {
  it('edit = editor, changed to edit = editor & owner (an intersection GAINING a conjunct), classifies possibly-narrowing', () => {
    const relations = { editor: userRelation('editor'), owner: userRelation('owner') };
    const oldConfig = ns('doc', {
      relations,
      permissions: { edit: permission('edit', computed('editor')) },
    });
    const newConfig = ns('doc', {
      relations,
      permissions: {
        edit: permission('edit', intersection(computed('editor'), computed('owner'))),
      },
    });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');
    expect(findMember(diff, 'edit').classification).toBe('possibly-narrowing');
  });

  it('edit = editor & owner, changed to edit = editor (an intersection LOSING a conjunct), classifies widen', () => {
    const relations = { editor: userRelation('editor'), owner: userRelation('owner') };
    const oldConfig = ns('doc', {
      relations,
      permissions: {
        edit: permission('edit', intersection(computed('editor'), computed('owner'))),
      },
    });
    const newConfig = ns('doc', {
      relations,
      permissions: { edit: permission('edit', computed('editor')) },
    });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');
    expect(findMember(diff, 'edit').classification).toBe('widen');
  });
});

describe('diffNamespace — a leaf reference changing to a DIFFERENT, unrelated reference cannot be proven either way', () => {
  it('view = viewer, changed to view = editor (a completely different relation, not layered via union) classifies possibly-narrowing', () => {
    const relations = { viewer: userRelation('viewer'), editor: userRelation('editor') };
    const oldConfig = ns('doc', {
      relations,
      permissions: { view: permission('view', computed('viewer')) },
    });
    const newConfig = ns('doc', {
      relations,
      permissions: { view: permission('view', computed('editor')) },
    });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');
    // Deliberately NOT asserting this "should" be narrowing or widening in
    // reality — swapping to an entirely unrelated relation could go either
    // way depending on real tuple data, which is exactly why this
    // classifier — comparing rewrite trees only, never tuples (see
    // diff.ts's own top doc comment) — can prove neither and must fall
    // back to the safe default.
    expect(findMember(diff, 'view').classification).toBe('possibly-narrowing');
  });

  it('a tupleToUserset rule changing which relation it follows classifies possibly-narrowing', () => {
    const oldConfig = ns('doc', {
      relations: {
        parent_a: { kind: 'relation', name: 'parent_a', subjectTypes: [{ namespace: 'folder' }] },
        parent_b: { kind: 'relation', name: 'parent_b', subjectTypes: [{ namespace: 'folder' }] },
      },
      permissions: {
        view: permission('view', {
          kind: 'tupleToUserset',
          relation: 'parent_a',
          computedUserset: 'view',
        }),
      },
    });
    const newConfig = ns('doc', {
      relations: oldConfig.relations,
      permissions: {
        view: permission('view', {
          kind: 'tupleToUserset',
          relation: 'parent_b',
          computedUserset: 'view',
        }),
      },
    });
    const diff = diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc');
    expect(findMember(diff, 'view').classification).toBe('possibly-narrowing');
  });
});

describe('diffNamespace — throws on a mismatched (schema, namespace) pair, matching classifyMonotone convention', () => {
  it('throws when the old schema does not declare the requested namespace', () => {
    const oldConfig = ns('other');
    const newConfig = ns('doc');
    expect(() => diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc')).toThrow(
      /old schema/,
    );
  });

  it('throws when the new schema does not declare the requested namespace', () => {
    const oldConfig = ns('doc');
    const newConfig = ns('other');
    expect(() => diffNamespace(schemaOf(oldConfig), schemaOf(newConfig), 'doc')).toThrow(
      /new schema/,
    );
  });
});
