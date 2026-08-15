// Mirrors docs/auth-integrations.md's code samples. Keep these in sync — see
// doc-examples/README.md for the convention this file is part of. No
// doc-examples/run/ counterpart: every sample here needs a live session,
// token, or Clerk/Auth0 backend to do anything meaningful, so — like
// readme-quickstart.ts — this is typecheck-only.
import express from 'express';
import { getSession, type ExpressAuthConfig } from '@auth/express';
import { clerkMiddleware, getAuth } from '@clerk/express';
import { auth } from 'express-oauth2-jwt-bearer';
import {
  createTenantMiddleware,
  claimTenantResolver,
} from '@novavey/multi-tenant-security-kit/tenant';
import {
  subjectFromRequestRoles,
  requirePermission,
  type RbacPolicy,
} from '@novavey/multi-tenant-security-kit/rbac';

// "Every example below assigns req.roles ..." augmentation block
declare global {
  namespace Express {
    interface Request {
      roles?: string[];
      session?: unknown; // only needed for the Auth.js example below
    }
  }
}

declare const app: express.Express;
declare const policy: RbacPolicy;
declare const authConfig: ExpressAuthConfig;

// "Auth.js (@auth/express)"
app.use(async (req, _res, next) => {
  const session = await getSession(req, authConfig);
  const roles = (session as { roles?: unknown } | null)?.roles;
  req.roles = Array.isArray(roles) ? (roles as string[]) : [];
  req.session = session;
  next();
});

app.use(
  createTenantMiddleware({
    resolver: claimTenantResolver((req) => {
      const session = req.session;
      return typeof session === 'object' && session !== null
        ? (session as Record<string, unknown>)
        : undefined;
    }, 'tenantId'),
  }),
);

// "Clerk (@clerk/express)"
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

// "Auth0 (express-oauth2-jwt-bearer)"
{
  const NAMESPACE = 'https://yourapp.example.com';

  app.use(auth()); // 401s unverified/missing tokens before anything below runs

  app.use((req, _res, next) => {
    const roles = req.auth?.payload?.[`${NAMESPACE}/roles`];
    req.roles = Array.isArray(roles) ? (roles as string[]) : [];
    next();
  });

  app.use(
    createTenantMiddleware({
      resolver: claimTenantResolver((req) => req.auth?.payload, `${NAMESPACE}/tenant_id`),
    }),
  );
}

// "Wiring the result into RBAC"
app.use(
  '/invoices',
  requirePermission({
    policy,
    permission: 'invoices:read',
    getSubject: subjectFromRequestRoles(),
  }),
);
