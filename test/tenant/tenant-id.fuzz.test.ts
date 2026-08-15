/**
 * Property-based tests for tenant-id validation as it's actually exercised
 * in practice: through createTenantMiddleware()'s default validateTenantId,
 * using DEFAULT_TENANT_ID_PATTERN (exported from src/tenant/middleware.ts
 * for exactly this purpose - see the comment there) as the oracle.
 *
 * Non-printable/control characters below are built with
 * String.fromCharCode() rather than embedded as literal source bytes or
 * backslash escapes, so this file stays plain, unambiguous ASCII text.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  DEFAULT_TENANT_ID_PATTERN,
  createTenantMiddleware,
  headerTenantResolver,
} from '../../src/tenant/middleware.js';
import { getCurrentTenantId } from '../../src/tenant/context.js';
import type { MinimalRequest, MinimalResponse } from '../../src/http/types.js';

const NUL = String.fromCharCode(0);
const NEWLINE = String.fromCharCode(10);

const INJECTION_HEADER_PAYLOADS = [
  'acme; DROP TABLE tenants; --',
  "acme' OR '1'='1",
  '../../etc/passwd',
  '<script>alert(1)</script>',
  'acme' + NUL,
  'acme' + NEWLINE,
  ' ',
  'a'.repeat(1000), // well over the 64-char cap
];

function mockReq(headerValue: string): MinimalRequest {
  return { headers: { 'x-tenant-id': headerValue } };
}

function mockRes(): MinimalResponse & { statusCode?: number; body?: unknown } {
  const res: Partial<MinimalResponse> & { statusCode?: number; body?: unknown } = {};
  res.status = (code: number) => {
    res.statusCode = code;
    return res as MinimalResponse;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res as MinimalResponse;
  };
  res.setHeader = () => res as MinimalResponse;
  return res as MinimalResponse & { statusCode?: number; body?: unknown };
}

const middleware = createTenantMiddleware({ resolver: headerTenantResolver('x-tenant-id') });

/**
 * createTenantMiddleware's body is a fire-and-forget `void (async () =>
 * {...})()`, and its two exit paths behave differently: the success/invalid
 * paths always call `next()`, but the default `onMissing` (reached only for
 * an *empty* header, since headerTenantResolver treats '' as "absent") never
 * calls `next()` at all — it just writes the response. Waiting on `next()`
 * would hang forever for that one input. headerTenantResolver is
 * synchronous and there's no real I/O involved, so a handful of microtask
 * flushes is enough for either path to fully settle; this checks final
 * state directly instead of depending on which path fired.
 */
async function runMiddleware(headerValue: string) {
  const req = mockReq(headerValue);
  const res = mockRes();
  let nextCalled = false;
  let seenTenantId: string | undefined;
  middleware(req, res, () => {
    nextCalled = true;
    seenTenantId = getCurrentTenantId();
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return { res, nextCalled, seenTenantId };
}

describe('tenant id validation — fuzzing against DEFAULT_TENANT_ID_PATTERN', () => {
  it('never throws synchronously for any header value, including the injection-payload corpus', () => {
    for (const bad of INJECTION_HEADER_PAYLOADS) {
      expect(() => middleware(mockReq(bad), mockRes(), () => {})).not.toThrow();
    }
  });

  it('the injection-payload corpus is always rejected, never accepted as a tenant id', async () => {
    for (const bad of INJECTION_HEADER_PAYLOADS) {
      const { seenTenantId } = await runMiddleware(bad);
      expect(seenTenantId).toBeUndefined();
    }
  });

  it('an empty header is treated as absent: no hang, no crash, no tenant id set', async () => {
    const { res, nextCalled, seenTenantId } = await runMiddleware('');
    expect(nextCalled).toBe(false); // onMissing path, by design
    expect(seenTenantId).toBeUndefined();
    expect(res.statusCode).toBe(400);
  });

  it('accepts iff the header value matches DEFAULT_TENANT_ID_PATTERN, and the accepted value round-trips exactly', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 200 }), async (headerValue) => {
        // '' is covered by its own dedicated test above (the onMissing
        // path, not the validation path this property is about) — and
        // DEFAULT_TENANT_ID_PATTERN's {1,64} quantifier rejects '' anyway,
        // so skipping it here doesn't hide a validation-path gap.
        if (headerValue === '') return;

        const shouldAccept = DEFAULT_TENANT_ID_PATTERN.test(headerValue);
        const { seenTenantId } = await runMiddleware(headerValue);
        if (shouldAccept) {
          expect(seenTenantId).toBe(headerValue);
        } else {
          expect(seenTenantId).toBeUndefined();
        }
      }),
      { numRuns: 1000 },
    );
  });
});
