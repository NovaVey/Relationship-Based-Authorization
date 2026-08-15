import { describe, expect, it } from 'vitest';

import { TenantContextError } from '../../src/errors.js';
import {
  getCurrentTenant,
  getCurrentTenantId,
  requireCurrentTenant,
  requireCurrentTenantId,
  runWithTenant,
} from '../../src/tenant/context.js';

describe('tenant context', () => {
  it('returns undefined outside of any tenant context', () => {
    expect(getCurrentTenant()).toBeUndefined();
    expect(getCurrentTenantId()).toBeUndefined();
  });

  it('throws from the require* variants outside of any tenant context', () => {
    expect(() => requireCurrentTenant()).toThrow(TenantContextError);
    expect(() => requireCurrentTenantId()).toThrow(TenantContextError);
  });

  it('exposes the active tenant within runWithTenant', () => {
    runWithTenant({ tenantId: 'acme' }, () => {
      expect(getCurrentTenant()).toEqual({ tenantId: 'acme' });
      expect(getCurrentTenantId()).toBe('acme');
      expect(requireCurrentTenant()).toEqual({ tenantId: 'acme' });
      expect(requireCurrentTenantId()).toBe('acme');
    });
  });

  it('propagates the tenant across awaits scheduled inside the callback', async () => {
    await runWithTenant({ tenantId: 'acme' }, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getCurrentTenantId()).toBe('acme');
    });
  });

  it('isolates concurrent tenant contexts from each other', async () => {
    const results: string[] = [];
    await Promise.all([
      runWithTenant({ tenantId: 'acme' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push(getCurrentTenantId() ?? 'none');
      }),
      runWithTenant({ tenantId: 'globex' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        results.push(getCurrentTenantId() ?? 'none');
      }),
    ]);
    expect(results.sort()).toEqual(['acme', 'globex']);
  });

  it('clears the context once runWithTenant returns', () => {
    runWithTenant({ tenantId: 'acme' }, () => undefined);
    expect(getCurrentTenant()).toBeUndefined();
  });

  it('preserves extra claims alongside tenantId', () => {
    runWithTenant({ tenantId: 'acme', extra: { plan: 'enterprise' } }, () => {
      expect(getCurrentTenant()).toEqual({ tenantId: 'acme', extra: { plan: 'enterprise' } });
    });
  });

  // Regression (MEDIUM): runWithTenant used to store the exact object it
  // was given, unfrozen. TenantContext's fields are declared `readonly` in
  // TypeScript, but that's compile-time only — anything holding a reference
  // obtained via getCurrentTenant() (a logging wrapper, a middleware further
  // down the chain) could reassign `.tenantId` in place, silently changing
  // what every *other* getCurrentTenantId() call sees for the rest of that
  // async scope. A mutation attempt on a security boundary this central
  // should fail loudly, not succeed silently.
  describe('active tenant context immutability', () => {
    it('freezes the object returned by getCurrentTenant()', () => {
      runWithTenant({ tenantId: 'acme' }, () => {
        expect(Object.isFrozen(getCurrentTenant())).toBe(true);
      });
    });

    it('throws (rather than silently succeeding) when something tries to mutate the active context', () => {
      runWithTenant({ tenantId: 'acme' }, () => {
        const context = getCurrentTenant() as { tenantId: string };
        expect(() => {
          context.tenantId = 'globex';
        }).toThrow(TypeError);
        // The mutation attempt must not have partially applied, either.
        expect(getCurrentTenantId()).toBe('acme');
      });
    });

    it('does not freeze or otherwise mutate the caller-supplied context object itself', () => {
      // runWithTenant freezes a *copy* it stores internally — the object
      // the caller passed in stays exactly as mutable as it always was,
      // since the caller may still legitimately own and reuse it outside
      // this call.
      const original = { tenantId: 'acme' };
      runWithTenant(original, () => undefined);
      expect(Object.isFrozen(original)).toBe(false);
      expect(() => {
        original.tenantId = 'still-mutable';
      }).not.toThrow();
    });
  });
});
