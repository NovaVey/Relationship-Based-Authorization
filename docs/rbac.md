# Role-based access control (RBAC)

`@novavey/multi-tenant-security-kit/rbac`

A small, fast, in-memory RBAC engine: define roles once, check permissions
everywhere. It's deliberately independent of _how_ you determine a subject's
roles (that's your auth layer's job) — this module only resolves and
enforces permissions once it has a `{ tenantId, roles }` pair.

## Defining a policy

```ts
import { RbacPolicy } from '@novavey/multi-tenant-security-kit/rbac';

const policy = new RbacPolicy([
  { name: 'viewer', permissions: ['invoices:read', 'reports:read'] },
  { name: 'billing_admin', permissions: ['invoices:*'], inherits: ['viewer'] },
  { name: 'owner', permissions: ['*'] },
]);
```

`RbacPolicy` instances are immutable — build one from your role catalog at
startup (typically a module-level singleton) and share it across every
`requirePermission` middleware and any manual `.can()` / `.assert()` checks.
The constructor defensively copies (and freezes) each `permissions`/
`inherits` array rather than storing your own array by reference, so
mutating the `roleDefinitions` array you passed in — even one you're still
holding onto — never affects an already-built policy.

**Validation happens eagerly, in the constructor.** A duplicate role name, an
`inherits` reference to a role that doesn't exist, or an inheritance cycle
(`a` inherits `b` inherits `a`) all throw `RbacConfigurationError`
immediately, naming the problem — a broken role hierarchy fails at boot,
not as a confusing authorization bug three requests later.

## Permission matching

A granted permission matches a requested permission in three ways:

1. **Exact match** — `invoices:read` grants exactly `invoices:read`.
2. **Namespaced wildcard** — a grant ending in `:*` (e.g. `invoices:*`)
   matches any requested permission sharing that prefix (`invoices:read`,
   `invoices:write`, `invoices:eu:read`, ...).
3. **Superuser wildcard** — a bare `*` grant matches everything.

**Inheritance** is transitive: `owner` inheriting `billing_admin` inheriting
`viewer` gets every permission all three define, resolved once and memoized
(the policy is immutable, so this is safe to cache for the policy's
lifetime).

```ts
policy.can({ tenantId: 'acme', roles: ['billing_admin'] }, 'invoices:write'); // true, via invoices:*
policy.can({ tenantId: 'acme', roles: ['viewer'] }, 'invoices:write'); // false
```

`can()` is a pure boolean query. Prefer `assert()` at actual enforcement
points, since it throws rather than returning a value a caller could
accidentally ignore:

```ts
policy.assert(subject, 'invoices:write'); // throws ForbiddenError if denied
```

Note: `permissionsFor`/`can`/`assert` are lenient about role _names_ that
don't exist in the policy (they contribute no permissions rather than
throwing) — a subject can legitimately carry a role that was retired from
the catalog without every call site needing to update in lockstep. Only the
constructor is strict about `inherits` referencing a real role.

## Middleware

```ts
import {
  requirePermission,
  subjectFromRequestRoles,
} from '@novavey/multi-tenant-security-kit/rbac';

app.get(
  '/invoices',
  requirePermission({
    policy,
    permission: 'invoices:read',
    getSubject: subjectFromRequestRoles(), // reads req.roles, tenantId from the active tenant context
  }),
  handler,
);
```

`permission` can also be a function of the request, for routes where the
required permission depends on e.g. the HTTP method:

```ts
requirePermission({
  policy,
  permission: (req) => (req.method === 'GET' ? 'invoices:read' : 'invoices:write'),
  getSubject: subjectFromRequestRoles(),
});
```

**`subjectFromRequestRoles(rolesProperty = 'roles')`** is a ready-made
`SubjectResolver`: it reads `req[rolesProperty]` (set by an earlier auth
middleware) as the roles, and takes the tenant id from
[the active tenant context](./tenant-isolation.md) via
`requireCurrentTenantId()` — never from anything on the request itself. This
is deliberate defense-in-depth: it's structurally impossible for this
helper to build a subject scoped to a tenant other than the one the
request's tenant middleware already established, even if something else on
`req` (a stale field, a forged header) disagrees. Mount
`createTenantMiddleware` before this one.

Write your own `SubjectResolver` when roles come from somewhere else (a
database lookup, a decoded token) — it can be async. Note that
`requireCurrentTenantId()` comes from the [`/tenant`](./tenant-isolation.md)
subpath, not `/rbac` — and, like the `points`/`getTenantId` callbacks in
[rate limiting](./rate-limiting.md#variable-request-cost),
`SubjectResolver` is generic over the request type, so give it your
framework's request type (extended with whatever an earlier auth middleware
attaches, e.g. `req.user`) to get that property back:

```ts
import type { Request } from 'express';
import { requireCurrentTenantId } from '@novavey/multi-tenant-security-kit/tenant';
import type { SubjectResolver } from '@novavey/multi-tenant-security-kit/rbac';

const getSubject: SubjectResolver<Request & { user: { id: string } }> = async (req) => {
  const roles = await db.userRoles.find(req.user.id);
  return { tenantId: requireCurrentTenantId(), roles };
};
```

A `getSubject` that resolves to `undefined` is treated as a denial —
`requirePermission` calls `onDenied` the same way it would for a real
permission failure. A `getSubject` that _throws_ is different: that's
forwarded to `next(err)` instead, not `onDenied`, since collapsing a real
error (a downstream auth service being unreachable, say) into an ordinary
403 would hide an outage behind what looks like a routine denial. Catch
your own errors inside `getSubject` and resolve to `undefined` if you want
them treated as a denial instead.

### Customizing the denial response

```ts
requirePermission({
  policy,
  permission: 'invoices:read',
  getSubject: subjectFromRequestRoles(),
  onDenied: (req, res, next, error) => {
    res.status(403).json({ code: 'FORBIDDEN', detail: error.message });
  },
});
```

Default `onDenied` responds `403 { error: 'forbidden', message, permission }`.

## API reference

| Export                                    | Kind     | Summary                                                                                                |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `Role`, `Permission`                      | type     | Both plain `string` aliases                                                                            |
| `RoleDefinition`                          | type     | `{ name, permissions, inherits? }`                                                                     |
| `AccessSubject`                           | type     | `{ tenantId: string; roles: Role[] }`                                                                  |
| `RbacPolicy`                              | class    | `new RbacPolicy(roleDefinitions)`; throws `RbacConfigurationError`                                     |
| `RbacPolicy#permissionsFor(roles)`        | method   | Resolved permission set (own + inherited) for a set of roles                                           |
| `RbacPolicy#can(subject, permission)`     | method   | Boolean permission check                                                                               |
| `RbacPolicy#assert(subject, permission)`  | method   | Throws `ForbiddenError` if denied                                                                      |
| `SubjectResolver<Req>`                    | type     | `(req) => AccessSubject \| undefined \| Promise<...>`                                                  |
| `RequirePermissionOptions<Req>`           | type     | Options for `requirePermission`                                                                        |
| `requirePermission(options)`              | function | Builds the enforcement middleware                                                                      |
| `subjectFromRequestRoles(rolesProperty?)` | function | Ready-made `SubjectResolver` reading `req.roles` + the active tenant                                   |
| `SecurityKitError`                        | class    | Base class every error in this package extends; carries a stable `.code`                               |
| `ForbiddenError`                          | class    | Thrown by `RbacPolicy#assert()`, denied via `onDenied`; `code: 'FORBIDDEN'`, carries `.permission`     |
| `RbacConfigurationError`                  | class    | Thrown by the `RbacPolicy` constructor for an invalid role graph; `code: 'RBAC_CONFIGURATION_INVALID'` |
