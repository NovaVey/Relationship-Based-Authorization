# Auth provider integrations

This kit has no opinion about authentication — `tenant`'s resolvers and
`rbac`'s `subjectFromRequestRoles` only ever consume claims/roles that
something else already verified. This page shows the adapter code for three
common providers: **Auth.js**, **Clerk**, and **Auth0**. All three reduce to
the same two-step pattern:

1. Decode the provider's session/token into a `{ tenantId, roles }` shape.
2. Feed `tenantId` to [`claimTenantResolver`](./tenant-isolation.md) and set
   `roles` on the request so [`subjectFromRequestRoles`](./rbac.md) can read
   it.

Mount the provider's own middleware, then a small adapter middleware, then
`createTenantMiddleware` — in that order, before any route.

Every example below assigns `req.roles` (and, for Auth.js, `req.session`)
directly — neither is a property `express.Request` declares. If you're using
TypeScript, add this once, anywhere it's picked up by your `tsconfig.json`
(e.g. `types/express.d.ts`), so those assignments type-check with no cast:

```ts
declare global {
  namespace Express {
    interface Request {
      roles?: string[];
      session?: unknown; // only needed for the Auth.js example below
    }
  }
}
export {};
```

## Auth.js (`@auth/express`)

Auth.js has no built-in concept of a tenant, so bake `tenantId` and `roles`
into the session yourself, once, via its `jwt`/`session` callbacks — the
same pattern used for any custom session field:

```ts
import type { ExpressAuthConfig } from '@auth/express';

// auth.config.ts
export const authConfig: ExpressAuthConfig = {
  providers: [/* ... */],
  callbacks: {
    async jwt({ token, user }) {
      // `user` is only present on sign-in — look tenantId/roles up from
      // your own user record then, so every later request just decodes
      // the token instead of hitting a database.
      if (user) {
        token.tenantId = (user as { tenantId?: string }).tenantId;
        token.roles = (user as { roles?: string[] }).roles;
      }
      return token;
    },
    async session({ session, token }) {
      (session as typeof session & { tenantId?: unknown; roles?: unknown }).tenantId =
        token.tenantId;
      (session as typeof session & { tenantId?: unknown; roles?: unknown }).roles = token.roles;
      return session;
    },
  },
};
```

Then, ahead of `createTenantMiddleware`, decode the session once per request
and bridge it onto `req.roles`:

```ts
import { getSession } from '@auth/express';
import {
  createTenantMiddleware,
  claimTenantResolver,
} from '@novavey/multi-tenant-security-kit/tenant';

app.use(async (req, _res, next) => {
  const session = await getSession(req, authConfig);
  const roles = (session as { roles?: unknown } | null)?.roles;
  req.roles = Array.isArray(roles) ? roles : [];
  req.session = session;
  next();
});

app.use(
  createTenantMiddleware({
    resolver: claimTenantResolver((req) => {
      // req.session is `unknown` (see the augmentation above) — Auth.js's
      // own `Session` type carries no index signature, so claimTenantResolver
      // (which needs to read an arbitrary claim off it) can't accept it
      // directly. Narrow with a real runtime check rather than an unchecked
      // cast: `getSession` already re-verified the session, so by the time
      // this resolver runs `req.session` is trusted — this check exists for
      // TypeScript, not because the value is actually suspect.
      const session = req.session;
      return typeof session === 'object' && session !== null
        ? (session as Record<string, unknown>)
        : undefined;
    }, 'tenantId'),
  }),
);
```

`claimTenantResolver` never verifies anything itself — `getSession` already
did that (it re-verifies the session cookie/token against `authConfig`), so
by the time the resolver runs, `req.session` is trusted.

## Clerk (`@clerk/express`)

Clerk's [Organizations](https://clerk.com/docs/organizations/overview)
feature maps onto this kit's tenant model directly: an organization **is**
a tenant. `clerkMiddleware()` attaches an `Auth` object to `req.auth`
carrying `orgId` and the caller's `orgRole` (a single string, e.g.
`"org:admin"`) for whichever organization is currently active — no custom
claims to configure.

```ts
import { clerkMiddleware, getAuth } from '@clerk/express';
import {
  createTenantMiddleware,
  claimTenantResolver,
} from '@novavey/multi-tenant-security-kit/tenant';

app.use(clerkMiddleware()); // must run before getAuth() is called anywhere

app.use((req, _res, next) => {
  const { orgRole } = getAuth(req);
  req.roles = orgRole ? [orgRole] : [];
  next();
});

app.use(
  createTenantMiddleware({
    resolver: claimTenantResolver((req) => getAuth(req), 'orgId'),
  }),
);
```

If your RBAC policy needs finer-grained permissions than Clerk's single
`orgRole` string, `getAuth(req).orgPermissions` (an array) is also
available — map it onto `req.roles` instead, or extend the roles array with
both.

## Auth0 (`express-oauth2-jwt-bearer`)

Auth0 access tokens don't carry app-specific claims by default — an
[Action](https://auth0.com/docs/customize/actions) on the Login flow adds
them, **namespaced** to avoid colliding with Auth0's own claims:

```js
// Auth0 Dashboard -> Actions -> Library -> Post Login trigger
const NAMESPACE = 'https://yourapp.example.com';

exports.onExecutePostLogin = async (event, api) => {
  api.accessToken.setCustomClaim(`${NAMESPACE}/tenant_id`, event.user.app_metadata.tenant_id);
  api.accessToken.setCustomClaim(`${NAMESPACE}/roles`, event.user.app_metadata.roles ?? []);
};
```

`express-oauth2-jwt-bearer`'s `auth()` middleware verifies the bearer token
against your Auth0 tenant and attaches the decoded payload to
`req.auth.payload` — read the namespaced claims back off it the same way:

```ts
import { auth } from 'express-oauth2-jwt-bearer';
import {
  createTenantMiddleware,
  claimTenantResolver,
} from '@novavey/multi-tenant-security-kit/tenant';

const NAMESPACE = 'https://yourapp.example.com';

app.use(auth()); // 401s unverified/missing tokens before anything below runs

app.use((req, _res, next) => {
  const roles = req.auth?.payload?.[`${NAMESPACE}/roles`];
  req.roles = Array.isArray(roles) ? roles : [];
  next();
});

app.use(
  createTenantMiddleware({
    resolver: claimTenantResolver((req) => req.auth?.payload, `${NAMESPACE}/tenant_id`),
  }),
);
```

Use the same namespace string in the Action and in the middleware — it's
just a URL used as a prefix, not a real endpoint Auth0 calls.

## Wiring the result into RBAC

All three providers end at the same place: `req.roles` set, tenant context
active. `subjectFromRequestRoles()` (default property `"roles"`) picks both
up unmodified — see [RBAC](./rbac.md) for `requirePermission` and policy
setup:

```ts
import {
  subjectFromRequestRoles,
  requirePermission,
} from '@novavey/multi-tenant-security-kit/rbac';

app.use(
  '/invoices',
  requirePermission({
    policy,
    permission: 'invoices:read',
    getSubject: subjectFromRequestRoles(),
  }),
);
```

Because `subjectFromRequestRoles` takes the tenant id from the active
tenant context (set by `createTenantMiddleware`) rather than from anything
on the request itself, it's structurally impossible for a forged or stale
role claim to grant access scoped to the wrong tenant — see
[`rbac`'s docs](./rbac.md#middleware) for why that matters.
