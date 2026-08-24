/**
 * `src/api/responses.ts` — pure, DB-free response shaping for the five
 * operations §9 Phase 8 exposes over HTTP. Every test here calls a response
 * builder directly with a hand-built domain result and inspects
 * `{ status, body }` — no Fastify, no mocked pool, nothing this file's own
 * top-of-file doc comment says is out of scope for it. Written from
 * `responses.ts`'s own exported types and doc comments — "always 200",
 * "present iff allowed", "passed through verbatim, never reshaped",
 * "namespace listing forced to a not-attempted failure when unreachable"
 * (full-repo audit finding #22) — not from a separate re-derivation of what
 * the shapes "should" be.
 *
 * This file was flagged as a real, un-covered gap by Phase 8's own
 * `server.test.ts` top-of-file doc comment ("no `responses.test.ts`/
 * `errors.test.ts` exists yet in this repo ... that is a real, separate gap,
 * not something this file's wiring-only tests substitute for").
 */
import { describe, expect, it } from 'vitest';

import {
  checkResponse,
  expandResponse,
  listObjectsResponse,
  listUsersResponse,
  tupleWriteResponse,
  tupleDeleteResponse,
  schemaCompileResponse,
  schemaPublishResponse,
  healthResponse,
} from '../../../src/api/responses.js';
import { encodeToken, decodeToken } from '../../../src/store/tokens.js';
import type {
  ApiEntityRef,
  HealthDatabaseStatus,
  HealthNamespaceListStatus,
} from '../../../src/api/responses.js';
import {
  tupleValidationError,
  schemaCompileError,
  schemaPublishError,
} from '../../../src/api/errors.js';
import type { PerformCheckResult } from '../../../src/audit/checks.js';
import type { ResolutionStep } from '../../../src/resolve/production/resolver.js';
import type { ExpandNode } from '../../../src/audit/expand.js';
import type { ListObjectsResult, ListUsersResult } from '../../../src/audit/list.js';
import type { WriteTupleResult, DeleteTupleResult, TupleError } from '../../../src/store/tuples.js';
import type { SchemaCompileResult } from '../../../src/schema/dsl/errors.js';
import type { SchemaError } from '../../../src/schema/dsl/errors.js';
import type { CompiledSchema } from '../../../src/schema/dsl/types.js';
import type { PublishResult, PublishedNamespace } from '../../../src/schema/publish.js';

const subject: ApiEntityRef = { ns: 'user', id: 'alice' };
const object: ApiEntityRef = { ns: 'document', id: 'readme' };

const grantPath: ResolutionStep = {
  kind: 'directGrant',
  object,
  relation: 'viewer',
  subject,
};

// ---------------------------------------------------------------------------
// 1. checkResponse
// ---------------------------------------------------------------------------

describe('checkResponse — status is always 200, whether allowed or denied', () => {
  it('checkresponse-status-is-200-when-allowed-is-true', () => {
    const result: PerformCheckResult = { allowed: true, path: grantPath, depth: 1 };
    expect(checkResponse(subject, 'viewer', object, result).status).toBe(200);
  });

  it('checkresponse-status-is-200-when-allowed-is-false', () => {
    const result: PerformCheckResult = { allowed: false, depth: 0 };
    expect(checkResponse(subject, 'viewer', object, result).status).toBe(200);
  });
});

describe('checkResponse — path is present, and equal to result.path, if and only if allowed is true', () => {
  it('checkresponse-includes-a-path-key-equal-to-result-path-when-allowed-is-true', () => {
    const result: PerformCheckResult = { allowed: true, path: grantPath, depth: 1 };
    const response = checkResponse(subject, 'viewer', object, result);
    expect(response.body.path).toEqual(grantPath);
    expect(Object.prototype.hasOwnProperty.call(response.body, 'path')).toBe(true);
  });

  it('checkresponse-omits-the-path-key-entirely-when-allowed-is-false-not-a-present-but-undefined-key', () => {
    const result: PerformCheckResult = { allowed: false, depth: 4 };
    const response = checkResponse(subject, 'viewer', object, result);
    expect(response.body.path).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(response.body, 'path')).toBe(false);
  });
});

describe('checkResponse — atToken is present, opaque-encoded, and decodes back to the caller-supplied value, if and only if a token was passed', () => {
  it('checkresponse-includes-an-attoken-key-that-decodes-back-to-the-supplied-token-when-a-token-was-passed', () => {
    const result: PerformCheckResult = { allowed: false, depth: 0 };
    const response = checkResponse(subject, 'viewer', object, result, 987654);
    expect(response.body.atToken).toBe(encodeToken(987654));
    expect(decodeToken(response.body.atToken as string)).toBe(987654);
    expect(Object.prototype.hasOwnProperty.call(response.body, 'atToken')).toBe(true);
  });

  it('checkresponse-omits-the-attoken-key-entirely-when-no-token-was-passed-not-a-present-but-undefined-key', () => {
    const result: PerformCheckResult = { allowed: false, depth: 0 };
    const response = checkResponse(subject, 'viewer', object, result);
    expect(response.body.atToken).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(response.body, 'atToken')).toBe(false);
  });

  it('checkresponse-includes-attoken-0-when-the-caller-explicitly-passes-token-0-not-treating-it-as-absent', () => {
    // 0 is a legitimate token value — a `atToken !== undefined` check
    // (correct) vs. a falsy check (`atToken ?` — a bug) would only diverge
    // at exactly this value.
    const result: PerformCheckResult = { allowed: false, depth: 0 };
    const response = checkResponse(subject, 'viewer', object, result, 0);
    expect(response.body.atToken).toBe(encodeToken(0));
    expect(decodeToken(response.body.atToken as string)).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(response.body, 'atToken')).toBe(true);
  });

  it('checkresponse-attoken-is-not-parseable-as-a-plain-integer-the-opacity-property', () => {
    // The whole point of encodeToken: a caller must not be able to treat
    // this as a raw number to compare/increment/decrement.
    const result: PerformCheckResult = { allowed: false, depth: 0 };
    const response = checkResponse(subject, 'viewer', object, result, 42);
    expect(Number.isNaN(Number(response.body.atToken))).toBe(true);
  });
});

describe('checkResponse — depth is passed through verbatim', () => {
  it('checkresponse-depth-equals-result-depth-verbatim-for-a-nonzero-depth', () => {
    const result: PerformCheckResult = { allowed: true, path: grantPath, depth: 6 };
    expect(checkResponse(subject, 'viewer', object, result).body.depth).toBe(6);
  });

  it('checkresponse-depth-equals-result-depth-verbatim-for-a-zero-depth', () => {
    const result: PerformCheckResult = { allowed: false, depth: 0 };
    expect(checkResponse(subject, 'viewer', object, result).body.depth).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. expandResponse
// ---------------------------------------------------------------------------

describe('expandResponse — status is always 200', () => {
  it('expandresponse-status-is-200', () => {
    const tree: ExpandNode = {
      kind: 'relation',
      object,
      relation: 'viewer',
      directSubjects: [subject],
      usersets: [],
    };
    expect(expandResponse(object, 'viewer', tree).status).toBe(200);
  });
});

describe('expandResponse — tree is passed through verbatim (deep-equal, not just truthy), including every leaf/node kind', () => {
  it('expandresponse-tree-passes-through-a-relation-leaf-verbatim', () => {
    const tree: ExpandNode = {
      kind: 'relation',
      object,
      relation: 'viewer',
      directSubjects: [subject, { ns: 'user', id: 'bob' }],
      usersets: [
        {
          userset: { ns: 'group', id: 'eng' },
          relation: 'member',
          expansion: { kind: 'cycleGuard', object: { ns: 'group', id: 'eng' }, name: 'member' },
        },
      ],
    };
    expect(expandResponse(object, 'viewer', tree).body.tree).toEqual(tree);
  });

  it('expandresponse-tree-passes-through-a-cycleguard-leaf-verbatim', () => {
    const tree: ExpandNode = { kind: 'cycleGuard', object, name: 'member' };
    expect(expandResponse(object, 'member', tree).body.tree).toEqual(tree);
  });

  it('expandresponse-tree-passes-through-a-depthlimitreached-leaf-verbatim', () => {
    const tree: ExpandNode = { kind: 'depthLimitReached', object, name: 'member' };
    expect(expandResponse(object, 'member', tree).body.tree).toEqual(tree);
  });

  it('expandresponse-tree-passes-through-an-undeclared-leaf-verbatim', () => {
    const tree: ExpandNode = { kind: 'undeclared', object, name: 'nonexistent_permission' };
    expect(expandResponse(object, 'nonexistent_permission', tree).body.tree).toEqual(tree);
  });

  it('expandresponse-tree-passes-through-a-deeply-nested-union-intersection-exclusion-and-tupletouserset-tree-verbatim', () => {
    const relationLeaf: ExpandNode = {
      kind: 'relation',
      object,
      relation: 'viewer',
      directSubjects: [subject],
      usersets: [],
    };
    const undeclaredLeaf: ExpandNode = { kind: 'undeclared', object, name: 'banned' };
    const depthLimitLeaf: ExpandNode = {
      kind: 'depthLimitReached',
      object: { ns: 'folder', id: 'design' },
      name: 'editor',
    };
    const tupleToUsersetNode: ExpandNode = {
      kind: 'tupleToUserset',
      object,
      relation: 'view',
      computedUserset: 'editor',
      children: [{ through: { ns: 'folder', id: 'design' }, expansion: depthLimitLeaf }],
    };
    const exclusionNode: ExpandNode = {
      kind: 'exclusion',
      object,
      base: relationLeaf,
      subtract: undeclaredLeaf,
    };
    const intersectionNode: ExpandNode = {
      kind: 'intersection',
      object,
      children: [relationLeaf, { kind: 'cycleGuard', object, name: 'viewer' }],
    };
    const tree: ExpandNode = {
      kind: 'union',
      object,
      children: [intersectionNode, exclusionNode, tupleToUsersetNode],
    };

    expect(expandResponse(object, 'view', tree).body.tree).toEqual(tree);
  });
});

// ---------------------------------------------------------------------------
// 2b. listObjectsResponse / listUsersResponse (post-audit improvement —
//     src/audit/list.ts's bulk reverse-lookup operations).
// ---------------------------------------------------------------------------

describe('listObjectsResponse — status is always 200', () => {
  it('listobjectsresponse-status-is-200', () => {
    const result: ListObjectsResult = { objects: [], truncated: false };
    expect(listObjectsResponse(subject, 'view', 'document', result).status).toBe(200);
  });
});

describe('listObjectsResponse — subject, relation, objectNs are echoed verbatim', () => {
  it('listobjectsresponse-echoes-subject-relation-and-objectns-verbatim', () => {
    const result: ListObjectsResult = { objects: [], truncated: false };
    const response = listObjectsResponse(subject, 'view', 'document', result);
    expect(response.body.subject).toEqual(subject);
    expect(response.body.relation).toBe('view');
    expect(response.body.objectNs).toBe('document');
  });
});

describe('listObjectsResponse — objects passes through verbatim, and an empty result renders an empty array, never omitted or null', () => {
  it('listobjectsresponse-objects-equals-result-objects-verbatim-for-a-nonempty-result', () => {
    const objects: ApiEntityRef[] = [
      { ns: 'document', id: 'readme' },
      { ns: 'document', id: 'other' },
    ];
    const result: ListObjectsResult = { objects, truncated: false };
    expect(listObjectsResponse(subject, 'view', 'document', result).body.objects).toEqual(objects);
  });

  it('listobjectsresponse-objects-is-an-empty-array-not-omitted-or-null-when-the-result-has-zero-objects', () => {
    const result: ListObjectsResult = { objects: [], truncated: false };
    const response = listObjectsResponse(subject, 'view', 'document', result);
    expect(Object.prototype.hasOwnProperty.call(response.body, 'objects')).toBe(true);
    expect(response.body.objects).not.toBeNull();
    expect(Array.isArray(response.body.objects)).toBe(true);
    expect(response.body.objects).toEqual([]);
  });
});

describe('listObjectsResponse — truncated passes through verbatim', () => {
  it('listobjectsresponse-truncated-is-true-when-result-truncated-is-true', () => {
    const result: ListObjectsResult = { objects: [], truncated: true };
    expect(listObjectsResponse(subject, 'view', 'document', result).body.truncated).toBe(true);
  });

  it('listobjectsresponse-truncated-is-false-when-result-truncated-is-false', () => {
    const result: ListObjectsResult = { objects: [], truncated: false };
    expect(listObjectsResponse(subject, 'view', 'document', result).body.truncated).toBe(false);
  });
});

describe('listObjectsResponse — atToken is present, opaque-encoded, and decodes back to the caller-supplied value, if and only if a token was passed (mirrors checkResponse)', () => {
  it('listobjectsresponse-includes-an-attoken-key-that-decodes-back-to-the-supplied-token-when-a-token-was-passed', () => {
    const result: ListObjectsResult = { objects: [], truncated: false };
    const response = listObjectsResponse(subject, 'view', 'document', result, 55);
    expect(response.body.atToken).toBe(encodeToken(55));
    expect(decodeToken(response.body.atToken as string)).toBe(55);
    expect(Object.prototype.hasOwnProperty.call(response.body, 'atToken')).toBe(true);
  });

  it('listobjectsresponse-omits-the-attoken-key-entirely-when-no-token-was-passed-not-a-present-but-undefined-key', () => {
    const result: ListObjectsResult = { objects: [], truncated: false };
    const response = listObjectsResponse(subject, 'view', 'document', result);
    expect(response.body.atToken).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(response.body, 'atToken')).toBe(false);
  });

  it('listobjectsresponse-includes-attoken-0-when-the-caller-explicitly-passes-token-0-not-treating-it-as-absent', () => {
    // Same landmine checkResponse's own equivalent test guards against: an
    // `atToken !== undefined` check (correct) vs. a falsy check (a bug)
    // only diverge at exactly this value.
    const result: ListObjectsResult = { objects: [], truncated: false };
    const response = listObjectsResponse(subject, 'view', 'document', result, 0);
    expect(response.body.atToken).toBe(encodeToken(0));
    expect(Object.prototype.hasOwnProperty.call(response.body, 'atToken')).toBe(true);
  });
});

describe('listUsersResponse — status is always 200', () => {
  it('listusersresponse-status-is-200', () => {
    const result: ListUsersResult = { subjects: [] };
    expect(listUsersResponse(object, 'view', result).status).toBe(200);
  });
});

describe('listUsersResponse — object and relation are echoed verbatim', () => {
  it('listusersresponse-echoes-object-and-relation-verbatim', () => {
    const result: ListUsersResult = { subjects: [] };
    const response = listUsersResponse(object, 'view', result);
    expect(response.body.object).toEqual(object);
    expect(response.body.relation).toBe('view');
  });
});

describe('listUsersResponse — subjects passes through verbatim, and an empty result renders an empty array, never omitted or null', () => {
  it('listusersresponse-subjects-equals-result-subjects-verbatim-for-a-nonempty-result', () => {
    const subjects: ApiEntityRef[] = [
      { ns: 'user', id: 'alice' },
      { ns: 'user', id: 'bob' },
    ];
    const result: ListUsersResult = { subjects };
    expect(listUsersResponse(object, 'view', result).body.subjects).toEqual(subjects);
  });

  it('listusersresponse-subjects-is-an-empty-array-not-omitted-or-null-when-the-result-has-zero-subjects', () => {
    const result: ListUsersResult = { subjects: [] };
    const response = listUsersResponse(object, 'view', result);
    expect(Object.prototype.hasOwnProperty.call(response.body, 'subjects')).toBe(true);
    expect(response.body.subjects).not.toBeNull();
    expect(Array.isArray(response.body.subjects)).toBe(true);
    expect(response.body.subjects).toEqual([]);
  });
});

describe('listUsersResponse — the response body never has an atToken field at all, not even as an explicit undefined key — listUsers has no such option to begin with', () => {
  it('listusersresponse-body-has-no-attoken-own-property-under-any-inputs', () => {
    const result: ListUsersResult = {
      subjects: [
        { ns: 'user', id: 'alice' },
        { ns: 'user', id: 'bob' },
      ],
    };
    const response = listUsersResponse(object, 'view', result);
    expect(Object.prototype.hasOwnProperty.call(response.body, 'atToken')).toBe(false);
    expect('atToken' in response.body).toBe(false);
  });

  it('listusersresponse-body-has-exactly-the-three-documented-keys-object-relation-subjects-nothing-else', () => {
    const result: ListUsersResult = { subjects: [] };
    const response = listUsersResponse(object, 'view', result);
    expect(Object.keys(response.body).sort()).toEqual(['object', 'relation', 'subjects']);
  });
});

// ---------------------------------------------------------------------------
// 3. tupleWriteResponse / tupleDeleteResponse
// ---------------------------------------------------------------------------

const writeErrors: TupleError[] = [
  { code: 'no_published_schema', message: 'namespace not published' },
];
const deleteErrors: TupleError[] = [
  { code: 'undeclared_relation', message: 'relation not declared' },
];

describe('tupleWriteResponse — ok:true renders 200 with {token, created}, token opaque-encoded', () => {
  it('tuplewriteresponse-ok-true-with-created-true-renders-200-with-token-and-created-verbatim', () => {
    const result: WriteTupleResult = { ok: true, token: 42, created: true };
    expect(tupleWriteResponse(result)).toEqual({
      status: 200,
      body: { token: encodeToken(42), created: true },
    });
  });

  it('tuplewriteresponse-ok-true-with-created-false-still-renders-200-not-an-error-idempotent-no-op-write', () => {
    const result: WriteTupleResult = { ok: true, token: 42, created: false };
    expect(tupleWriteResponse(result)).toEqual({
      status: 200,
      body: { token: encodeToken(42), created: false },
    });
  });

  it('tuplewriteresponse-token-decodes-back-to-the-real-integer-and-is-not-parseable-as-one-directly', () => {
    const result: WriteTupleResult = { ok: true, token: 1160, created: true };
    const { body } = tupleWriteResponse(result) as { body: { token: string } };
    expect(decodeToken(body.token)).toBe(1160);
    expect(Number.isNaN(Number(body.token))).toBe(true);
  });
});

describe("tupleWriteResponse — ok:false delegates to tupleValidationError('write', errors), never 'delete'", () => {
  it('tuplewriteresponse-ok-false-produces-exactly-what-tuplevalidationerror-write-errors-produces', () => {
    const result: WriteTupleResult = { ok: false, errors: writeErrors };
    expect(tupleWriteResponse(result)).toEqual(tupleValidationError('write', writeErrors));
  });

  it('tuplewriteresponse-ok-false-message-names-the-operation-write-not-delete', () => {
    const result: WriteTupleResult = { ok: false, errors: writeErrors };
    const response = tupleWriteResponse(result);
    expect('error' in response.body ? response.body.error.message : '').toContain(
      'tuple write rejected',
    );
  });
});

describe('tupleDeleteResponse — ok:true renders 200 with {token, deleted}, token opaque-encoded', () => {
  it('tupledeleteresponse-ok-true-with-deleted-true-renders-200-with-token-and-deleted-verbatim', () => {
    const result: DeleteTupleResult = { ok: true, token: 43, deleted: true };
    expect(tupleDeleteResponse(result)).toEqual({
      status: 200,
      body: { token: encodeToken(43), deleted: true },
    });
  });

  it('tupledeleteresponse-ok-true-with-deleted-false-still-renders-200-not-an-error-idempotent-no-op-delete', () => {
    const result: DeleteTupleResult = { ok: true, token: 43, deleted: false };
    expect(tupleDeleteResponse(result)).toEqual({
      status: 200,
      body: { token: encodeToken(43), deleted: false },
    });
  });
});

describe("tupleDeleteResponse — ok:false delegates to tupleValidationError('delete', errors), never 'write'", () => {
  it('tupledeleteresponse-ok-false-produces-exactly-what-tuplevalidationerror-delete-errors-produces', () => {
    const result: DeleteTupleResult = { ok: false, errors: deleteErrors };
    expect(tupleDeleteResponse(result)).toEqual(tupleValidationError('delete', deleteErrors));
  });

  it('tupledeleteresponse-ok-false-message-names-the-operation-delete-not-write', () => {
    const result: DeleteTupleResult = { ok: false, errors: deleteErrors };
    const response = tupleDeleteResponse(result);
    expect('error' in response.body ? response.body.error.message : '').toContain(
      'tuple delete rejected',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. schemaCompileResponse / schemaPublishResponse
// ---------------------------------------------------------------------------

const compiledSchema: CompiledSchema = {
  namespaces: {
    document: {
      namespace: 'document',
      relations: {
        viewer: { kind: 'relation', name: 'viewer', subjectTypes: [{ namespace: 'user' }] },
      },
      permissions: {
        view: {
          kind: 'permission',
          name: 'view',
          rewrite: { kind: 'computedUserset', name: 'viewer' },
        },
      },
    },
  },
};

const compileErrors: SchemaError[] = [
  { code: 'empty_source', message: 'schema source is empty', line: 1 },
];

const publishErrors = ['line 4: permission `edit` references undeclared relation `admin`'];

describe('schemaCompileResponse — ok:true renders 200 with {schema} verbatim', () => {
  it('schemacompileresponse-ok-true-renders-200-with-the-compiled-schema-verbatim', () => {
    const result: SchemaCompileResult = { ok: true, schema: compiledSchema };
    expect(schemaCompileResponse(result)).toEqual({
      status: 200,
      body: { schema: compiledSchema },
    });
  });
});

describe('schemaCompileResponse — ok:false delegates to schemaCompileError, not schemaPublishError', () => {
  it('schemacompileresponse-ok-false-produces-exactly-what-schemacompileerror-errors-produces', () => {
    const result: SchemaCompileResult = { ok: false, errors: compileErrors };
    expect(schemaCompileResponse(result)).toEqual(schemaCompileError(compileErrors));
  });
});

describe('schemaPublishResponse — ok:true renders 200 with {published} verbatim', () => {
  it('schemapublishresponse-ok-true-renders-200-with-the-published-namespace-list-verbatim', () => {
    const published: PublishedNamespace[] = [
      { namespace: 'document', version: 4 },
      { namespace: 'folder', version: 1 },
    ];
    const result: PublishResult = { ok: true, published };
    expect(schemaPublishResponse(result)).toEqual({ status: 200, body: { published } });
  });
});

describe('schemaPublishResponse — ok:false delegates to schemaPublishError, not schemaCompileError', () => {
  it('schemapublishresponse-ok-false-produces-exactly-what-schemapublisherror-errors-produces', () => {
    const result: PublishResult = { ok: false, errors: publishErrors };
    expect(schemaPublishResponse(result)).toEqual(schemaPublishError(publishErrors));
  });

  it('schemapublishresponse-ok-false-details-errors-is-a-plain-string-array-never-the-structured-apischemaerror-shape-schemacompileerror-would-produce', () => {
    const result: PublishResult = { ok: false, errors: publishErrors };
    const response = schemaPublishResponse(result);
    const details = 'error' in response.body ? response.body.error.details : undefined;
    expect(details).toEqual({ errors: publishErrors });
  });
});

// ---------------------------------------------------------------------------
// 5. healthResponse
// ---------------------------------------------------------------------------

describe('healthResponse — reachable:false always forces status:503, body.status:unavailable, and a not-attempted namespace-listing failure', () => {
  it('healthresponse-reachable-false-renders-status-503-and-body-status-unavailable', () => {
    const database: HealthDatabaseStatus = { reachable: false, error: 'connection refused' };
    const response = healthResponse(database, { ok: true, namespaces: [] });
    expect(response.status).toBe(503);
    expect(response.body.status).toBe('unavailable');
  });

  it('healthresponse-reachable-false-discards-a-successful-namespacelist-and-forces-a-not-attempted-failure-instead-not-just-when-the-input-was-already-a-failure', () => {
    const database: HealthDatabaseStatus = { reachable: false, error: 'connection timed out' };
    const suppliedNamespaceList: HealthNamespaceListStatus = {
      ok: true,
      namespaces: [
        { namespace: 'document', version: 3 },
        { namespace: 'folder', version: 1 },
      ],
    };

    const response = healthResponse(database, suppliedNamespaceList);

    expect(response.body.namespaces).toEqual({
      ok: false,
      error: 'not attempted — database unreachable',
    });
  });

  it('healthresponse-reachable-false-still-carries-the-database-field-through-with-its-own-error-detail', () => {
    const database: HealthDatabaseStatus = { reachable: false, error: 'connection refused' };
    const response = healthResponse(database, { ok: true, namespaces: [] });
    expect(response.body.database).toEqual(database);
  });
});

describe('healthResponse — reachable:true renders status:200, body.status:ok, and namespaces passed through verbatim as a defensive copy', () => {
  it('healthresponse-reachable-true-renders-status-200-and-body-status-ok', () => {
    const response = healthResponse({ reachable: true }, { ok: true, namespaces: [] });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('healthresponse-reachable-true-namespaces-equals-the-input-list-verbatim', () => {
    const namespaces: PublishedNamespace[] = [
      { namespace: 'document', version: 3 },
      { namespace: 'org', version: 2 },
    ];
    const response = healthResponse({ reachable: true }, { ok: true, namespaces });
    expect(response.body.namespaces).toEqual({ ok: true, namespaces });
  });

  it('healthresponse-reachable-true-returns-a-defensive-copy-of-namespaces-mutating-the-input-array-after-the-call-does-not-affect-the-returned-body', () => {
    const namespaces: PublishedNamespace[] = [{ namespace: 'document', version: 3 }];
    const response = healthResponse({ reachable: true }, { ok: true, namespaces });

    // Mutate the caller's array AFTER the call — the function's own
    // `[...namespaceList.namespaces]` doc-commented defensive copy must mean
    // this has no effect on the already-returned body.
    namespaces.push({ namespace: 'folder', version: 9 });

    expect(response.body.namespaces).toEqual({
      ok: true,
      namespaces: [{ namespace: 'document', version: 3 }],
    });
    const resultNamespaceList = response.body.namespaces;
    if (resultNamespaceList.ok) {
      expect(resultNamespaceList.namespaces).not.toBe(namespaces);
    } else {
      expect.unreachable('expected the ok:true branch');
    }
  });
});
