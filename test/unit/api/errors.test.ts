/**
 * `src/api/errors.ts` — the API's error-envelope constructors. Pure, DB-free,
 * no Fastify import (this file's own top-of-file doc comment): every test
 * here calls a constructor directly and inspects `{ status, body }`, nothing
 * else. Written from `errors.ts`'s own exported types and doc comments —
 * `API_ERROR_STATUS`'s own doc comment for the status table, each
 * constructor's own doc comment for its message/detail shape — not from a
 * separate re-derivation of what the numbers "should" be.
 *
 * This file was flagged as a real, un-covered gap by Phase 8's own
 * `server.test.ts` top-of-file doc comment ("no `responses.test.ts`/
 * `errors.test.ts` exists yet in this repo ... that is a real, separate gap,
 * not something this file's wiring-only tests substitute for").
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  API_ERROR_STATUS,
  invalidRequestError,
  tupleValidationError,
  schemaCompileError,
  schemaPublishError,
  unauthorizedError,
  infrastructureUnavailableError,
  internalError,
} from '../../../src/api/errors.js';
import type { ApiErrorCode, ApiErrorResponse } from '../../../src/api/errors.js';
import { formatSchemaError } from '../../../src/schema/dsl/errors.js';
import type { SchemaError } from '../../../src/schema/dsl/errors.js';
import type { TupleError } from '../../../src/store/tuples.js';

const ERRORS_SOURCE_PATH = fileURLToPath(new URL('../../../src/api/errors.ts', import.meta.url));

// ---------------------------------------------------------------------------
// 1. API_ERROR_STATUS's own documented table, and every constructor's
//    returned status matching it (not a separately-hardcoded number).
// ---------------------------------------------------------------------------

// Hand-derived from API_ERROR_STATUS's own doc comment
// (`400/400/400/401/503/500` for `invalid_request`/`tuple_validation_failed`/
// `schema_compile_failed`/`unauthorized`/`infrastructure_unavailable`/
// `internal_error`), not read off the table itself.
const DOCUMENTED_STATUS: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  tuple_validation_failed: 400,
  schema_compile_failed: 400,
  unauthorized: 401,
  infrastructure_unavailable: 503,
  internal_error: 500,
};

describe('API_ERROR_STATUS maps every ApiErrorCode to its documented HTTP status', () => {
  it('api-error-status-matches-the-documented-400-400-400-401-503-500-table-for-every-apierrorcode', () => {
    expect(API_ERROR_STATUS).toEqual(DOCUMENTED_STATUS);
  });
});

describe("every constructor's returned status matches API_ERROR_STATUS for its own code, never a separately-hardcoded number that could drift from it", () => {
  it('every-constructors-returned-status-equals-api-error-status-of-the-code-it-actually-produced', () => {
    const cases: Array<{ expectedCode: ApiErrorCode; response: ApiErrorResponse }> = [
      { expectedCode: 'invalid_request', response: invalidRequestError('missing field "subject"') },
      { expectedCode: 'tuple_validation_failed', response: tupleValidationError('write', []) },
      { expectedCode: 'schema_compile_failed', response: schemaCompileError([]) },
      { expectedCode: 'schema_compile_failed', response: schemaPublishError([]) },
      { expectedCode: 'unauthorized', response: unauthorizedError() },
      {
        expectedCode: 'infrastructure_unavailable',
        response: infrastructureUnavailableError('down'),
      },
      { expectedCode: 'internal_error', response: internalError() },
    ];

    for (const { expectedCode, response } of cases) {
      expect(response.body.error.code).toBe(expectedCode);
      expect(response.status).toBe(API_ERROR_STATUS[expectedCode]);
      expect(response.status).toBe(DOCUMENTED_STATUS[expectedCode]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. tupleValidationError
// ---------------------------------------------------------------------------

const oneTupleError: TupleError[] = [
  { code: 'invalid_identifier', message: 'object id is malformed' },
];

const threeTupleErrors: TupleError[] = [
  { code: 'invalid_identifier', message: 'object id is malformed' },
  {
    code: 'undeclared_relation',
    message: 'relation "owner" is not declared on namespace "document"',
  },
  {
    code: 'subject_type_not_allowed',
    message: 'subject type "group" is not allowed on relation "viewer"',
  },
];

describe('tupleValidationError — details.errors is the exact input array, never copied or reshaped', () => {
  it('tuplevalidationerror-details-errors-is-the-exact-same-array-instance-passed-in-not-a-copy-or-a-reshaped-value', () => {
    const response = tupleValidationError('write', threeTupleErrors);
    const details = response.body.error.details as { errors: TupleError[] };
    expect(details.errors).toBe(threeTupleErrors);
  });
});

describe('tupleValidationError — message names the error count and pluralizes correctly', () => {
  it('tuplevalidationerror-message-says-1-error-singular-for-exactly-one-error', () => {
    const response = tupleValidationError('write', oneTupleError);
    expect(response.body.error.message).toBe('tuple write rejected — 1 error, see details');
  });

  it('tuplevalidationerror-message-says-n-errors-plural-for-more-than-one-error', () => {
    const response = tupleValidationError('delete', threeTupleErrors);
    expect(response.body.error.message).toBe('tuple delete rejected — 3 errors, see details');
  });

  it('tuplevalidationerror-message-says-0-errors-plural-for-a-zero-length-error-array', () => {
    const response = tupleValidationError('write', []);
    expect(response.body.error.message).toBe('tuple write rejected — 0 errors, see details');
  });
});

// ---------------------------------------------------------------------------
// 3. schemaCompileError
// ---------------------------------------------------------------------------

const schemaError1: SchemaError = {
  code: 'undeclared_reference',
  message: 'permission `edit` references undeclared relation `admin`',
  line: 4,
  namespace: 'document',
  member: 'edit',
};

const schemaError2: SchemaError = {
  code: 'empty_source',
  message: 'schema source is empty',
  line: 1,
};

describe("schemaCompileError — details.errors carries the full ApiSchemaError shape, and 'formatted' matches formatSchemaError itself", () => {
  it('schemacompileerror-details-errors-carries-every-original-schemaerror-field-plus-a-formatted-field-that-equals-formatschemaerror-applied-to-that-same-input', () => {
    const response = schemaCompileError([schemaError1, schemaError2]);
    const details = response.body.error.details as {
      errors: Array<SchemaError & { formatted: string }>;
    };

    expect(details.errors).toHaveLength(2);
    // Compared against the REAL formatSchemaError output, not a hardcoded
    // string — this file's own doc comment on ApiSchemaError states the
    // two must never drift.
    expect(details.errors[0]).toEqual({
      ...schemaError1,
      formatted: formatSchemaError(schemaError1),
    });
    expect(details.errors[1]).toEqual({
      ...schemaError2,
      formatted: formatSchemaError(schemaError2),
    });
  });

  it('schemacompileerror-details-errors-preserves-a-schemaerror-that-has-no-namespace-or-member-field-without-inventing-either', () => {
    const response = schemaCompileError([schemaError2]);
    const details = response.body.error.details as {
      errors: Array<SchemaError & { formatted: string }>;
    };
    expect(Object.prototype.hasOwnProperty.call(details.errors[0] ?? {}, 'namespace')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(details.errors[0] ?? {}, 'member')).toBe(false);
  });
});

describe('schemaCompileError — message names the error count and pluralizes correctly', () => {
  it('schemacompileerror-message-says-1-error-singular-for-exactly-one-error', () => {
    const response = schemaCompileError([schemaError1]);
    expect(response.body.error.message).toBe('schema failed to compile — 1 error, see details');
  });

  it('schemacompileerror-message-says-n-errors-plural-for-more-than-one-error', () => {
    const response = schemaCompileError([schemaError1, schemaError2]);
    expect(response.body.error.message).toBe('schema failed to compile — 2 errors, see details');
  });
});

// ---------------------------------------------------------------------------
// 4. schemaPublishError
// ---------------------------------------------------------------------------

const publishErrorStrings = [
  'line 4: permission `edit` references undeclared relation `admin`',
  'line 9: namespace `document` is declared twice',
];

describe('schemaPublishError — details.errors is a plain string[], verbatim', () => {
  it('schemapublisherror-details-errors-equals-the-input-string-array-verbatim-element-for-element', () => {
    const response = schemaPublishError(publishErrorStrings);
    expect(response.body.error.details).toEqual({ errors: publishErrorStrings });
  });
});

describe('schemaPublishError — message names the error count, pluralizes correctly, and states nothing was published', () => {
  it('schemapublisherror-message-says-1-error-singular-and-nothing-published-for-exactly-one-error', () => {
    const response = schemaPublishError([publishErrorStrings[0] as string]);
    expect(response.body.error.message).toBe(
      'schema publish rejected — 1 error, nothing published, see details',
    );
  });

  it('schemapublisherror-message-says-n-errors-plural-and-nothing-published-for-more-than-one-error', () => {
    const response = schemaPublishError(publishErrorStrings);
    expect(response.body.error.message).toBe(
      'schema publish rejected — 2 errors, nothing published, see details',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. unauthorizedError
// ---------------------------------------------------------------------------

describe('unauthorizedError — default detail text vs. a caller-supplied detail', () => {
  it('unauthorizederror-with-no-argument-uses-the-default-missing-or-invalid-admin-api-key-detail', () => {
    const response = unauthorizedError();
    expect(response.body.error.message).toBe('unauthorized — missing or invalid admin API key');
  });

  it('unauthorizederror-with-a-supplied-detail-uses-that-detail-verbatim-instead-of-the-default', () => {
    const response = unauthorizedError('Authorization header missing entirely');
    expect(response.body.error.message).toBe(
      'unauthorized — Authorization header missing entirely',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. infrastructureUnavailableError
// ---------------------------------------------------------------------------

describe('infrastructureUnavailableError — message is exactly "Postgres: <detail>"', () => {
  it('infrastructureunavailableerror-message-is-exactly-postgres-colon-space-detail-with-no-extra-wrapping-text', () => {
    const response = infrastructureUnavailableError('connection refused at 127.0.0.1:5432');
    expect(response.body.error.message).toBe('Postgres: connection refused at 127.0.0.1:5432');
  });
});

// ---------------------------------------------------------------------------
// 7. internalError
// ---------------------------------------------------------------------------

describe('internalError — default detail text vs. a caller-supplied detail', () => {
  it('internalerror-with-no-argument-uses-the-default-an-unexpected-error-occurred-handling-this-request-detail', () => {
    const response = internalError();
    expect(response.body.error.message).toBe('an unexpected error occurred handling this request');
  });

  it('internalerror-with-a-supplied-detail-uses-that-detail-verbatim-instead-of-the-default', () => {
    const response = internalError('a truly unanticipated failure with no named category');
    expect(response.body.error.message).toBe(
      'a truly unanticipated failure with no named category',
    );
  });
});

describe("internalError — this file's own doc comment claim that no function in this file ever constructs it", () => {
  it('internalerror-is-never-referenced-by-name-anywhere-in-errorsts-other-than-its-own-declaration', () => {
    const source = readFileSync(ERRORS_SOURCE_PATH, 'utf-8');
    const totalReferences = (source.match(/\binternalError\(/g) ?? []).length;
    const ownDeclaration = (source.match(/export function internalError\(/g) ?? []).length;

    expect(ownDeclaration).toBe(1);
    // Every reference to `internalError(` in this file must be its own
    // declaration — none of this file's other constructors may call it.
    expect(totalReferences - ownDeclaration).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. `details` is absent, not merely undefined, when no structured detail
//    exists — same "present vs. present-but-undefined" discipline
//    test/unit/report/json.test.ts already applies to referencePath/
//    productionPath.
// ---------------------------------------------------------------------------

describe("unauthorizedError/internalError's output has no 'details' key at all when there is no structured detail — not a present-but-undefined key", () => {
  it('unauthorizederror-output-error-object-has-no-details-own-property-at-all', () => {
    const response = unauthorizedError();
    expect(response.body.error.details).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(response.body.error, 'details')).toBe(false);
  });

  it('internalerror-output-error-object-has-no-details-own-property-at-all', () => {
    const response = internalError();
    expect(response.body.error.details).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(response.body.error, 'details')).toBe(false);
  });

  it('by-contrast-tuplevalidationerror-which-always-has-structured-detail-does-carry-an-own-details-property', () => {
    const response = tupleValidationError('write', oneTupleError);
    expect(Object.prototype.hasOwnProperty.call(response.body.error, 'details')).toBe(true);
  });
});
