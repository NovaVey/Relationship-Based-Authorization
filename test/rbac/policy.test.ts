import { describe, expect, it } from 'vitest';

import { ForbiddenError, RbacConfigurationError } from '../../src/errors.js';
import { RbacPolicy } from '../../src/rbac/policy.js';
import type { AccessSubject } from '../../src/rbac/types.js';

function subject(roles: string[], tenantId = 'tenant-a'): AccessSubject {
  return { tenantId, roles };
}

describe('RbacPolicy construction', () => {
  it('accepts a well-formed set of role definitions', () => {
    expect(
      () =>
        new RbacPolicy([
          { name: 'viewer', permissions: ['invoices:read'] },
          { name: 'admin', permissions: ['*'] },
        ]),
    ).not.toThrow();
  });

  it('throws RbacConfigurationError on a duplicate role name', () => {
    expect(
      () =>
        new RbacPolicy([
          { name: 'viewer', permissions: ['invoices:read'] },
          { name: 'viewer', permissions: ['invoices:write'] },
        ]),
    ).toThrow(RbacConfigurationError);
  });

  it('duplicate role name error message names the offending role', () => {
    try {
      new RbacPolicy([
        { name: 'viewer', permissions: [] },
        { name: 'viewer', permissions: [] },
      ]);
      expect.unreachable('constructor should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RbacConfigurationError);
      expect((err as RbacConfigurationError).message).toContain('viewer');
    }
  });

  it('throws RbacConfigurationError when inherits references an unknown role', () => {
    expect(
      () => new RbacPolicy([{ name: 'editor', permissions: [], inherits: ['ghost-role'] }]),
    ).toThrow(RbacConfigurationError);
  });

  it('unknown-inherited-role error message names both roles', () => {
    try {
      new RbacPolicy([{ name: 'editor', permissions: [], inherits: ['ghost-role'] }]);
      expect.unreachable('constructor should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RbacConfigurationError);
      const message = (err as RbacConfigurationError).message;
      expect(message).toContain('editor');
      expect(message).toContain('ghost-role');
    }
  });

  it('throws RbacConfigurationError on a direct two-role inheritance cycle', () => {
    expect(
      () =>
        new RbacPolicy([
          { name: 'a', permissions: [], inherits: ['b'] },
          { name: 'b', permissions: [], inherits: ['a'] },
        ]),
    ).toThrow(RbacConfigurationError);
  });

  it('cycle error message names the roles involved in the cycle', () => {
    try {
      new RbacPolicy([
        { name: 'a', permissions: [], inherits: ['b'] },
        { name: 'b', permissions: [], inherits: ['a'] },
      ]);
      expect.unreachable('constructor should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RbacConfigurationError);
      const message = (err as RbacConfigurationError).message;
      expect(message).toContain('a');
      expect(message).toContain('b');
    }
  });

  it('throws RbacConfigurationError on a self-inheriting role', () => {
    expect(() => new RbacPolicy([{ name: 'a', permissions: [], inherits: ['a'] }])).toThrow(
      RbacConfigurationError,
    );
  });

  it('throws RbacConfigurationError on a longer three-role cycle', () => {
    expect(
      () =>
        new RbacPolicy([
          { name: 'a', permissions: [], inherits: ['b'] },
          { name: 'b', permissions: [], inherits: ['c'] },
          { name: 'c', permissions: [], inherits: ['a'] },
        ]),
    ).toThrow(RbacConfigurationError);
  });

  it('does not throw for a diamond inheritance shape (no cycle)', () => {
    expect(
      () =>
        new RbacPolicy([
          { name: 'base', permissions: ['base:read'] },
          { name: 'left', permissions: ['left:read'], inherits: ['base'] },
          { name: 'right', permissions: ['right:read'], inherits: ['base'] },
          { name: 'top', permissions: [], inherits: ['left', 'right'] },
        ]),
    ).not.toThrow();
  });

  // Regression (LOW): the constructor used to store each RoleDefinition by
  // reference — mutating the *original* array a caller passed in (still
  // held onto after construction) silently changed an already-built
  // policy's behavior, contradicting this class's own "instances are
  // immutable" docs. Verified live before this fix: pushing a new
  // permission onto the original array, before that role's first
  // resolution, changed what .can() returned for it with no error at all.
  it('is unaffected by a caller mutating the original roleDefinitions array/permissions after construction', () => {
    // Declared with an explicitly *mutable* local type — RoleDefinition's
    // own fields are `readonly` (documenting that RbacPolicy copies them),
    // but a real caller's own array, before ever handing it to RbacPolicy,
    // is naturally still mutable like this.
    const roleDefs: { name: string; permissions: string[] }[] = [
      { name: 'viewer', permissions: ['invoices:read'] },
    ];
    const policy = new RbacPolicy(roleDefs);

    // Mutate the original array's permissions (not a copy) after
    // construction, before ever resolving this role.
    roleDefs[0]!.permissions.push('invoices:write');
    // Also try appending an entirely new role definition to the array.
    roleDefs.push({ name: 'admin', permissions: ['*'] });

    expect(policy.can(subject(['viewer']), 'invoices:write')).toBe(false);
    expect(policy.can(subject(['admin']), 'invoices:read')).toBe(false); // 'admin' was never really added
  });

  it('the stored permissions/inherits arrays are frozen', () => {
    const policy = new RbacPolicy([
      { name: 'viewer', permissions: ['invoices:read'], inherits: [] },
    ]);
    // permissionsFor's result Set is a fresh copy either way; this asserts
    // the *internal* storage is frozen by reaching into it the same way
    // the unbounded-cache regression test above does.
    const internals = policy as unknown as {
      definitions: ReadonlyMap<string, { permissions: unknown; inherits: unknown }>;
    };
    const stored = internals.definitions.get('viewer')!;
    expect(Object.isFrozen(stored.permissions)).toBe(true);
    expect(Object.isFrozen(stored.inherits)).toBe(true);
  });
});

describe('RbacPolicy.permissionsFor', () => {
  it("returns a role's own permissions", () => {
    const policy = new RbacPolicy([
      { name: 'viewer', permissions: ['invoices:read', 'invoices:list'] },
    ]);
    expect(policy.permissionsFor(['viewer'])).toEqual(new Set(['invoices:read', 'invoices:list']));
  });

  it('resolves multi-level inheritance transitively', () => {
    const policy = new RbacPolicy([
      { name: 'base', permissions: ['base:read'] },
      { name: 'mid', permissions: ['mid:read'], inherits: ['base'] },
      { name: 'top', permissions: ['top:read'], inherits: ['mid'] },
    ]);
    expect(policy.permissionsFor(['top'])).toEqual(new Set(['top:read', 'mid:read', 'base:read']));
  });

  it('unions permissions across multiple roles, deduplicating overlaps', () => {
    const policy = new RbacPolicy([
      { name: 'a', permissions: ['shared:x', 'a:only'] },
      { name: 'b', permissions: ['shared:x', 'b:only'] },
    ]);
    expect(policy.permissionsFor(['a', 'b'])).toEqual(new Set(['shared:x', 'a:only', 'b:only']));
  });

  it('ignores unknown role names, contributing no permissions', () => {
    const policy = new RbacPolicy([{ name: 'viewer', permissions: ['invoices:read'] }]);
    expect(policy.permissionsFor(['viewer', 'nonexistent-role'])).toEqual(
      new Set(['invoices:read']),
    );
  });

  it('returns an empty set for an empty roles array', () => {
    const policy = new RbacPolicy([{ name: 'viewer', permissions: ['invoices:read'] }]);
    expect(policy.permissionsFor([])).toEqual(new Set());
  });

  it('returns an empty set when every role passed is unknown', () => {
    const policy = new RbacPolicy([{ name: 'viewer', permissions: ['invoices:read'] }]);
    expect(policy.permissionsFor(['ghost'])).toEqual(new Set());
  });

  // Regression (MEDIUM): unknown role names used to be memoized in the same
  // cache as known ones, with no bound on the key space. `can`/`assert` are
  // reachable with arbitrary caller-controlled role strings via
  // `subjectFromRequestRoles`, which passes request-derived roles straight
  // through with no validation against the policy's catalog — an attacker
  // sending a fresh, never-before-seen role name on every request could grow
  // that cache without limit, an unbounded-memory-growth DoS shaped exactly
  // like `MemoryRateLimitStore`'s pre-`maxBuckets` bucket map. The fix
  // simply never caches the not-found case (there's no recursive work there
  // worth memoizing anyway), so the cache's size is now provably bounded by
  // the number of *known* roles regardless of how many distinct unknown
  // roles are ever queried.
  it('never grows its internal cache past the number of known roles, however many distinct unknown roles are queried', () => {
    const policy = new RbacPolicy([{ name: 'viewer', permissions: ['invoices:read'] }]);
    const internals = policy as unknown as {
      resolvedPermissionsByRole: ReadonlyMap<string, unknown>;
    };

    for (let i = 0; i < 5000; i++) {
      policy.permissionsFor([`ghost-role-${i}`]);
    }

    // Only unknown roles were ever queried — the known role ("viewer") was
    // never resolved, so the cache should be completely empty, not just
    // "small". Before the fix, this would have grown to 5000 entries.
    expect(internals.resolvedPermissionsByRole.size).toBe(0);
  });

  it('does not duplicate permissions shared across a diamond inheritance shape', () => {
    const policy = new RbacPolicy([
      { name: 'base', permissions: ['base:read'] },
      { name: 'left', permissions: [], inherits: ['base'] },
      { name: 'right', permissions: [], inherits: ['base'] },
      { name: 'top', permissions: [], inherits: ['left', 'right'] },
    ]);
    expect(policy.permissionsFor(['top'])).toEqual(new Set(['base:read']));
  });
});

describe('RbacPolicy.can', () => {
  const policy = new RbacPolicy([
    { name: 'viewer', permissions: ['invoices:read'] },
    { name: 'billing-admin', permissions: ['billing:*'] },
    { name: 'superuser', permissions: ['*'] },
    { name: 'nested-viewer', permissions: [], inherits: ['viewer'] },
  ]);

  it('grants an exact permission match', () => {
    expect(policy.can(subject(['viewer']), 'invoices:read')).toBe(true);
  });

  it('denies a permission the subject does not hold', () => {
    expect(policy.can(subject(['viewer']), 'invoices:write')).toBe(false);
  });

  it('grants via a namespaced wildcard permission', () => {
    expect(policy.can(subject(['billing-admin']), 'billing:read')).toBe(true);
    expect(policy.can(subject(['billing-admin']), 'billing:write')).toBe(true);
  });

  it('a namespaced wildcard does not grant a different namespace', () => {
    expect(policy.can(subject(['billing-admin']), 'invoices:read')).toBe(false);
  });

  it('grants any permission via the bare "*" superuser wildcard', () => {
    expect(policy.can(subject(['superuser']), 'anything:goes')).toBe(true);
    expect(policy.can(subject(['superuser']), 'invoices:read')).toBe(true);
  });

  it('grants an inherited permission through a role with no permissions of its own', () => {
    expect(policy.can(subject(['nested-viewer']), 'invoices:read')).toBe(true);
  });

  it('denies when the subject has no roles', () => {
    expect(policy.can(subject([]), 'invoices:read')).toBe(false);
  });

  it('denies when the subject only holds unknown roles', () => {
    expect(policy.can(subject(['ghost']), 'invoices:read')).toBe(false);
  });

  // Regression coverage: subject.roles is typed as Role[], but a caller can
  // still hand this a malformed value at runtime (a decoded-token claim
  // that turned out not to be an array, `roles: 'admin'` instead of
  // `roles: ['admin']`, etc.). Before this was validated, a string value
  // didn't throw here at all — strings are iterable, so it silently
  // iterated character-by-character — which could coincidentally grant
  // permissions from a single-character role name; other non-array values
  // (null, a number, a plain object) threw a raw TypeError out of `can()`.
  // Every one of these must now cleanly resolve to `false` instead.
  describe('malformed subject.roles (not an array)', () => {
    const malformed: unknown[] = ['viewer', null, undefined, 42, {}, { length: 1, 0: 'viewer' }];

    for (const roles of malformed) {
      it(`denies (does not throw) for roles = ${JSON.stringify(roles)}`, () => {
        const malformedSubject = { tenantId: 'tenant-a', roles } as unknown as AccessSubject;
        expect(() => policy.can(malformedSubject, 'invoices:read')).not.toThrow();
        expect(policy.can(malformedSubject, 'invoices:read')).toBe(false);
      });
    }

    // Regression (MEDIUM): the malformed-roles cases above all covered
    // subject.roles being wrong; this covers `subject` *itself* being
    // missing. `can()` used to read `subject.roles` unconditionally before
    // checking `Array.isArray`, so `can(null, ...)` / `can(undefined, ...)`
    // threw a raw, unbranded TypeError ("Cannot read properties of null
    // (reading 'roles')") straight out of a function whose own doc comment
    // promises it "never throws" — reachable any time a non-TS consumer, an
    // `as` cast, or a lookup that legitimately came up empty hands this a
    // missing subject.
    for (const missingSubject of [null, undefined]) {
      it(`denies (does not throw) for subject = ${String(missingSubject)}`, () => {
        expect(() =>
          policy.can(missingSubject as unknown as AccessSubject, 'invoices:read'),
        ).not.toThrow();
        expect(policy.can(missingSubject as unknown as AccessSubject, 'invoices:read')).toBe(false);
      });
    }

    it('a single-character role name string does not coincidentally grant anything', () => {
      // Regression for the specific silent-wrong-ALLOW shape: if a role
      // literally named "v" existed and roles were iterated
      // character-by-character, subject.roles = 'viewer' would grant it.
      const policyWithShortRole = new RbacPolicy([
        { name: 'v', permissions: ['invoices:read'] },
        { name: 'viewer', permissions: ['invoices:read'] },
      ]);
      const malformedSubject = {
        tenantId: 'tenant-a',
        roles: 'viewer',
      } as unknown as AccessSubject;
      expect(policyWithShortRole.can(malformedSubject, 'invoices:read')).toBe(false);
    });
  });
});

describe('RbacPolicy.assert', () => {
  const policy = new RbacPolicy([{ name: 'viewer', permissions: ['invoices:read'] }]);

  it('does not throw when the subject has the permission', () => {
    expect(() => policy.assert(subject(['viewer']), 'invoices:read')).not.toThrow();
  });

  it('throws ForbiddenError when the subject lacks the permission', () => {
    expect(() => policy.assert(subject(['viewer']), 'invoices:delete')).toThrow(ForbiddenError);
  });

  it('the thrown ForbiddenError names the missing permission in its message and .permission field', () => {
    try {
      policy.assert(subject(['viewer']), 'invoices:delete');
      expect.unreachable('assert should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      const forbidden = err as ForbiddenError;
      expect(forbidden.permission).toBe('invoices:delete');
      expect(forbidden.message).toContain('invoices:delete');
      expect(forbidden.code).toBe('FORBIDDEN');
    }
  });

  // Regression: assert() used to build its error message with
  // `subject.roles.join(', ')` unconditionally — for a non-array roles
  // value (e.g. a string), `.join` doesn't exist and that threw a raw,
  // unbranded TypeError instead of ForbiddenError, which
  // `requirePermission`'s middleware doesn't recognize as a denial (it
  // isn't `instanceof ForbiddenError`), silently skipping `onDenied`.
  it('throws ForbiddenError, not a raw TypeError, when subject.roles is not an array', () => {
    const malformedSubject = {
      tenantId: 'tenant-a',
      roles: 'viewer',
    } as unknown as AccessSubject;
    expect(() => policy.assert(malformedSubject, 'invoices:read')).toThrow(ForbiddenError);
  });

  // Regression (MEDIUM): same class of bug as the previous test, but for
  // `subject` itself being missing rather than just `subject.roles`. Before
  // the fix, `assert()`'s error-message-building fallback
  // (`String(subject.roles)`) still dereferenced `.roles` off a possibly-
  // null/undefined `subject` unconditionally, so this threw the same raw
  // TypeError `can()` did — even though `can()` itself had already been
  // fixed to treat a missing subject as "no permissions" rather than
  // throwing.
  for (const missingSubject of [null, undefined]) {
    it(`throws ForbiddenError, not a raw TypeError, when subject is ${String(missingSubject)}`, () => {
      expect(() =>
        policy.assert(missingSubject as unknown as AccessSubject, 'invoices:read'),
      ).toThrow(ForbiddenError);
    });
  }
});
