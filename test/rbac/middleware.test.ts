import { describe, expect, it, vi } from 'vitest';

import { ForbiddenError, TenantContextError } from '../../src/errors.js';
import type { MinimalRequest, MinimalResponse } from '../../src/http/types.js';
import { requirePermission, subjectFromRequestRoles } from '../../src/rbac/middleware.js';
import { RbacPolicy } from '../../src/rbac/policy.js';
import type { AccessSubject } from '../../src/rbac/types.js';
import { runWithTenant } from '../../src/tenant/context.js';

function mockReq(
  overrides: Partial<MinimalRequest> & Record<string, unknown> = {},
): MinimalRequest {
  return { headers: {}, ...overrides };
}

function mockRes(): MinimalResponse & { statusCode?: number; body?: unknown } {
  const res: Partial<MinimalResponse> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as MinimalResponse;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res as MinimalResponse;
  });
  res.setHeader = vi.fn(() => res as MinimalResponse);
  return res as MinimalResponse & { statusCode?: number; body?: unknown };
}

const policy = new RbacPolicy([
  { name: 'viewer', permissions: ['invoices:read'] },
  { name: 'admin', permissions: ['*'] },
]);

describe('requirePermission', () => {
  it('calls next() with no error on the allow path', async () => {
    const middleware = requirePermission({
      policy,
      permission: 'invoices:read',
      getSubject: () => ({ tenantId: 't1', roles: ['viewer'] }),
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('supports an async getSubject resolver', async () => {
    const middleware = requirePermission({
      policy,
      permission: 'invoices:read',
      getSubject: async () => ({ tenantId: 't1', roles: ['viewer'] }),
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeUndefined();
  });

  it('responds with the default 403 JSON shape when denied', async () => {
    const middleware = requirePermission({
      policy,
      permission: 'invoices:delete',
      getSubject: () => ({ tenantId: 't1', roles: ['viewer'] }),
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'forbidden',
      message: expect.stringContaining('invoices:delete'),
      permission: 'invoices:delete',
    });
  });

  it('treats an unresolved subject as denied instead of throwing', async () => {
    const middleware = requirePermission({
      policy,
      permission: 'invoices:read',
      getSubject: () => undefined,
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'forbidden', permission: undefined }),
    );
  });

  // Regression: a getSubject that resolves to a subject with a malformed
  // (non-array) roles field used to reach RbacPolicy.assert()'s error-message
  // construction (`subject.roles.join(...)`), which threw a raw TypeError.
  // That TypeError isn't `instanceof ForbiddenError`, so it skipped
  // onDenied entirely and went to next(err) instead — silently breaking
  // any app relying on onDenied for audit-logging denied requests. It must
  // now be a normal, onDenied-routed denial, same as any other.
  it('treats a resolved subject with a malformed (non-array) roles field as a denial via onDenied, not next(err)', async () => {
    const onDenied = vi.fn();
    const middleware = requirePermission({
      policy,
      permission: 'invoices:read',
      getSubject: () => ({ tenantId: 't1', roles: 'viewer' }) as unknown as AccessSubject,
      onDenied,
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(next).not.toHaveBeenCalled();
    expect(onDenied).toHaveBeenCalledTimes(1);
    const [, , , error] = onDenied.mock.calls[0] as [unknown, unknown, unknown, ForbiddenError];
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it('invokes a custom onDenied handler instead of the default response', async () => {
    const onDenied = vi.fn((_req, res: MinimalResponse, _next, error: ForbiddenError) => {
      res.status(451).json({ custom: true, permission: error.permission });
    });
    const middleware = requirePermission({
      policy,
      permission: 'invoices:delete',
      getSubject: () => ({ tenantId: 't1', roles: ['viewer'] }),
      onDenied,
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(onDenied).toHaveBeenCalledTimes(1);
    expect(onDenied.mock.calls[0]?.[3]).toBeInstanceOf(ForbiddenError);
    expect(res.status).toHaveBeenCalledWith(451);
    expect(res.json).toHaveBeenCalledWith({ custom: true, permission: 'invoices:delete' });
    expect(next).not.toHaveBeenCalled();
  });

  it('resolves the permission from a function of the request', async () => {
    const permissionFn = vi.fn((req: MinimalRequest) =>
      req.method === 'GET' ? 'invoices:read' : 'invoices:write',
    );
    const middleware = requirePermission({
      policy,
      permission: permissionFn,
      getSubject: () => ({ tenantId: 't1', roles: ['viewer'] }),
    });

    const readReq = mockReq({ method: 'GET' });
    const readRes = mockRes();
    const readNext = vi.fn();
    middleware(readReq, readRes, readNext);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(readNext).toHaveBeenCalledTimes(1);
    expect(readNext.mock.calls[0]?.[0]).toBeUndefined();

    const writeReq = mockReq({ method: 'POST' });
    const writeRes = mockRes();
    const writeNext = vi.fn();
    middleware(writeReq, writeRes, writeNext);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(writeNext).not.toHaveBeenCalled();
    expect(writeRes.status).toHaveBeenCalledWith(403);

    expect(permissionFn).toHaveBeenCalledTimes(2);
  });

  it('an admin with the "*" wildcard is granted any permission', async () => {
    const middleware = requirePermission({
      policy,
      permission: 'anything:goes',
      getSubject: () => ({ tenantId: 't1', roles: ['admin'] }),
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeUndefined();
  });

  it('forwards unrelated errors thrown while resolving the subject to next(err) instead of onDenied', async () => {
    const boom = new Error('database exploded');
    const onDenied = vi.fn();
    const middleware = requirePermission({
      policy,
      permission: 'invoices:read',
      getSubject: () => {
        throw boom;
      },
      onDenied,
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(onDenied).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('forwards unrelated errors thrown from a permission-resolver function to next(err)', async () => {
    const boom = new Error('bad resolver');
    const onDenied = vi.fn();
    const middleware = requirePermission({
      policy,
      permission: () => {
        throw boom;
      },
      getSubject: () => ({ tenantId: 't1', roles: ['viewer'] }),
      onDenied,
    });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(onDenied).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(boom);
  });

  // Regression (MEDIUM): next() used to be invoked from inside the inner
  // try/catch (right after `options.policy.assert(...)` succeeded). This
  // package's `NextFunction` is framework-agnostic — it's whatever the
  // caller supplies, with no guarantee of Express-router-style internal
  // exception isolation for a downstream handler that throws synchronously
  // — so a throw reaching back through that call used to be caught right
  // there and re-forwarded via a *second* call to `next(err)`, violating
  // the "call next at most once" contract every middleware chain depends
  // on. `next()` is now called strictly outside both try/catch blocks, so a
  // throw from `next()` itself surfaces as-is instead of silently becoming
  // a second call.
  it('calls next() at most once, even if next() itself throws synchronously', async () => {
    const middleware = requirePermission({
      policy,
      permission: 'invoices:read',
      getSubject: () => ({ tenantId: 't1', roles: ['viewer'] }),
    });
    const req = mockReq();
    const res = mockRes();
    const boom = new Error('downstream handler blew up');
    const next = vi.fn(() => {
      throw boom;
    });

    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.once('unhandledRejection', onUnhandledRejection);
    try {
      middleware(req, res, next);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
    }

    expect(next).toHaveBeenCalledTimes(1);
    expect(rejections).toEqual([boom]);
  });
});

describe('subjectFromRequestRoles', () => {
  it('reads roles from the default "roles" request property and tenant id from the active tenant context', async () => {
    const resolver = subjectFromRequestRoles();
    const req = mockReq({ roles: ['viewer', 'admin'] });

    const subject = await runWithTenant({ tenantId: 'tenant-xyz' }, () => resolver(req));

    expect(subject).toEqual({
      tenantId: 'tenant-xyz',
      roles: ['viewer', 'admin'],
    } satisfies AccessSubject);
  });

  it('reads roles from a custom request property name', async () => {
    const resolver = subjectFromRequestRoles('permissionsRoles');
    const req = mockReq({ permissionsRoles: ['billing-admin'] });

    const subject = await runWithTenant({ tenantId: 'tenant-xyz' }, () => resolver(req));

    expect(subject).toEqual({ tenantId: 'tenant-xyz', roles: ['billing-admin'] });
  });

  it('filters out non-string entries from the roles array', async () => {
    const resolver = subjectFromRequestRoles();
    const req = mockReq({ roles: ['viewer', 42, null, { name: 'admin' }, 'admin'] });

    const subject = await runWithTenant({ tenantId: 'tenant-xyz' }, () => resolver(req));

    expect(subject).toEqual({ tenantId: 'tenant-xyz', roles: ['viewer', 'admin'] });
  });

  it('defaults to an empty roles array when the property is absent', async () => {
    const resolver = subjectFromRequestRoles();
    const req = mockReq();

    const subject = await runWithTenant({ tenantId: 'tenant-xyz' }, () => resolver(req));

    expect(subject).toEqual({ tenantId: 'tenant-xyz', roles: [] });
  });

  it('defaults to an empty roles array when the property is not an array', async () => {
    const resolver = subjectFromRequestRoles();
    const req = mockReq({ roles: 'viewer' });

    const subject = await runWithTenant({ tenantId: 'tenant-xyz' }, () => resolver(req));

    expect(subject).toEqual({ tenantId: 'tenant-xyz', roles: [] });
  });

  it('throws TenantContextError when called with no active tenant context', () => {
    const resolver = subjectFromRequestRoles();
    const req = mockReq({ roles: ['viewer'] });

    expect(() => resolver(req)).toThrow(TenantContextError);
  });
});
