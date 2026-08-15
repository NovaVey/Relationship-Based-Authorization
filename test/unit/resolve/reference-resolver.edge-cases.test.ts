/**
 * Reference resolver (Phase 3) tests — fail-closed edge cases.
 *
 * Written from `.claude/commands/build-authz-service.md` §10's
 * `an-object-with-zero-tuples-resolves-denied-for-every-subject`, the
 * behavioral contract handed down for this task ("never throws. An
 * undeclared namespace, an undeclared relation/permission name, an object
 * with zero tuples of any kind, and a cyclic tuple graph all resolve
 * `{ allowed: false }` — never an exception, never a hang"), and §5's
 * definition of a `subjectRelation`-bearing tuple ("`document:readme#editor
 * @group:eng#member` means membership requires resolving `member` on
 * `group:eng` recursively, not comparing ids directly"). Per §14 delegation
 * rule 5, `src/resolve/reference/resolver.ts` was deliberately NOT read
 * while writing these tests.
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { formatSchemaError } from '../../../src/schema/dsl/errors.js';
import type { CompiledSchema } from '../../../src/schema/dsl/types.js';
import {
  referenceCheck,
  type ReferenceCheckResult,
} from '../../../src/resolve/reference/resolver.js';
import type { EntityRef, ReferenceTuple } from '../../../src/resolve/reference/resolver.js';

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

const SOURCE = [
  'namespace group {',
  '  relation member: user',
  '}',
  '',
  'namespace document {',
  '  relation owner: user',
  '  relation editor: user',
  '  relation viewer: user | group#member',
  '',
  '  permission any_access = viewer | editor',
  '}',
].join('\n');

describe('an-object-with-zero-tuples-resolves-denied-for-every-subject', () => {
  const subjects: EntityRef[] = [ref('user', 'alice'), ref('user', 'bob'), ref('group', 'eng')];
  const relationsAndPermissions = ['viewer', 'any_access'];

  interface Case {
    subject: EntityRef;
    relationOrPermission: string;
  }

  const cases: Case[] = subjects.flatMap((subject) =>
    relationsAndPermissions.map((relationOrPermission) => ({ subject, relationOrPermission })),
  );

  it.each(cases)(
    'an-object-with-zero-tuples-resolves-denied-for-every-subject (subject=$subject.ns:$subject.id, name=$relationOrPermission)',
    ({ subject, relationOrPermission }) => {
      const schema = compileOk(SOURCE);
      const result = referenceCheck(
        schema,
        [],
        subject,
        ref('document', 'empty'),
        relationOrPermission,
      );
      expect(result.allowed).toBe(false);
    },
  );
});

describe('an-undeclared-namespace-or-relation-resolves-denied-rather-than-throwing', () => {
  it('checking-against-an-undeclared-namespace-resolves-denied-without-throwing', () => {
    const schema = compileOk(SOURCE);
    let result: ReferenceCheckResult | undefined;
    expect(() => {
      result = referenceCheck(schema, [], ref('user', 'alice'), ref('no_such_ns', 'x'), 'viewer');
    }).not.toThrow();
    expect(result?.allowed).toBe(false);
  });

  it('checking-an-undeclared-relation-or-permission-name-resolves-denied-without-throwing-even-when-the-object-has-other-tuples', () => {
    const schema = compileOk(SOURCE);
    // A viewer tuple genuinely exists for alice on this exact object — the
    // denial below must be because `no_such_permission` isn't a declared
    // relation or permission at all, not because of an empty graph.
    const tuples = [tuple('document', 'readme', 'viewer', 'user', 'alice')];
    let result: ReferenceCheckResult | undefined;
    expect(() => {
      result = referenceCheck(
        schema,
        tuples,
        ref('user', 'alice'),
        ref('document', 'readme'),
        'no_such_permission',
      );
    }).not.toThrow();
    expect(result?.allowed).toBe(false);
  });
});

describe('a-stored-tuple-userset-subject-is-resolved-by-recursing-into-the-named-relation-not-by-string-matching-the-tuple-subject-id', () => {
  it('a-stored-tuple-userset-subject-is-resolved-by-recursing-into-the-named-relation-not-by-string-matching-the-tuple-subject-id', () => {
    const schema = compileOk(SOURCE);
    // document:x's viewer relation is granted to "group:eng#member" — the
    // set of subjects who are *members* of group:eng, not to the literal
    // entity (group, eng) itself. Checking (group, eng) as the subject
    // directly matches this tuple's subjectNs/subjectId string-for-string,
    // which is exactly the shape of bug this test exists to catch: a
    // resolver that short-circuits on subjectNs===queried.ns &&
    // subjectId===queried.id without regard for subjectRelation would
    // incorrectly grant here, because there is no tuple making group:eng a
    // member of itself. The second assertion proves recursion genuinely
    // works using the same tuple set: iris really is a member of group:eng,
    // so iris (and only iris, not group:eng itself) must resolve allowed.
    const tuples = [
      tuple('document', 'x', 'viewer', 'group', 'eng', 'member'),
      tuple('group', 'eng', 'member', 'user', 'iris'),
    ];

    const trapResult = referenceCheck(
      schema,
      tuples,
      ref('group', 'eng'),
      ref('document', 'x'),
      'viewer',
    );
    expect(trapResult.allowed).toBe(false);

    const realMemberResult = referenceCheck(
      schema,
      tuples,
      ref('user', 'iris'),
      ref('document', 'x'),
      'viewer',
    );
    expect(realMemberResult.allowed).toBe(true);
  });
});
