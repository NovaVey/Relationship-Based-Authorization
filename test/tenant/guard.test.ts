import { describe, expect, it } from 'vitest';

import { CrossTenantAccessError, TenantContextError } from '../../src/errors.js';
import { runWithTenant } from '../../src/tenant/context.js';
import { assertSameTenant, assertTenantMatches, scopeToTenant } from '../../src/tenant/guard.js';

describe('assertSameTenant', () => {
  it('does not throw when ids match', () => {
    expect(() => assertSameTenant('acme', 'acme')).not.toThrow();
  });

  it('throws CrossTenantAccessError when ids differ', () => {
    expect(() => assertSameTenant('acme', 'globex')).toThrow(CrossTenantAccessError);
  });

  it('includes both ids on the thrown error', () => {
    try {
      assertSameTenant('acme', 'globex');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CrossTenantAccessError);
      const error = err as CrossTenantAccessError;
      expect(error.expectedTenantId).toBe('acme');
      expect(error.actualTenantId).toBe('globex');
      expect(error.code).toBe('CROSS_TENANT_ACCESS_DENIED');
    }
  });
});

describe('assertTenantMatches', () => {
  it('throws TenantContextError outside of a tenant context', () => {
    expect(() => assertTenantMatches({ tenantId: 'acme' })).toThrow(TenantContextError);
  });

  it('passes when the resource belongs to the current tenant', () => {
    runWithTenant({ tenantId: 'acme' }, () => {
      expect(() => assertTenantMatches({ tenantId: 'acme' })).not.toThrow();
    });
  });

  it("blocks access to another tenant's resource", () => {
    runWithTenant({ tenantId: 'acme' }, () => {
      expect(() => assertTenantMatches({ tenantId: 'globex' })).toThrow(CrossTenantAccessError);
    });
  });

  // Regression (HIGH, compile-time): assertTenantMatches used to take
  // TenantScoped directly, which carries an index signature (needed so
  // scopeToTenant, below, can accept a plain object literal). TypeScript
  // only lets a *declared* type (a named interface/class — exactly what a
  // real ORM model or domain type is) satisfy a target type that has an
  // index signature if the declared type also has a matching one, and real
  // domain types essentially never do — the same footgun this package
  // already hit once for MinimalRequest (see src/http/types.ts and
  // test/tenant/middleware.test.ts / test/rbac/middleware.test.ts's own
  // guards for that one). This test's only job is to fail `npm run
  // typecheck` if that regresses: a named interface with EXTRA fields
  // beyond tenantId, passed with no cast, must compile.
  it('accepts a named interface (not just a fresh object literal) with no cast', () => {
    interface Invoice {
      id: string;
      tenantId: string;
      amountCents: number;
    }
    const invoice: Invoice = { id: 'inv-1', tenantId: 'acme', amountCents: 4200 };

    runWithTenant({ tenantId: 'acme' }, () => {
      expect(() => assertTenantMatches(invoice)).not.toThrow();
    });
    runWithTenant({ tenantId: 'globex' }, () => {
      expect(() => assertTenantMatches(invoice)).toThrow(CrossTenantAccessError);
    });
  });
});

describe('scopeToTenant', () => {
  it('throws TenantContextError outside of a tenant context', () => {
    expect(() => scopeToTenant({ status: 'open' })).toThrow(TenantContextError);
  });

  // This (and every other call below passing a fresh `{ ... }` literal) is
  // also a compile-time regression guard, the other half of the tension
  // assertTenantMatches's own regression test above documents: scopeToTenant
  // needs TenantScoped's index signature to accept a plain object literal
  // like this one — the fix for assertTenantMatches deliberately did NOT
  // touch TenantScoped itself, specifically so this keeps compiling.
  it('injects the current tenant id into the query', () => {
    runWithTenant({ tenantId: 'acme' }, () => {
      expect(scopeToTenant({ status: 'open' })).toEqual({ status: 'open', tenantId: 'acme' });
    });
  });

  it('is a no-op when the query already targets the current tenant', () => {
    runWithTenant({ tenantId: 'acme' }, () => {
      expect(scopeToTenant({ tenantId: 'acme', status: 'open' })).toEqual({
        tenantId: 'acme',
        status: 'open',
      });
    });
  });

  it('throws if the query targets a different tenant than the active one', () => {
    runWithTenant({ tenantId: 'acme' }, () => {
      expect(() => scopeToTenant({ tenantId: 'globex' })).toThrow(CrossTenantAccessError);
    });
  });
});
