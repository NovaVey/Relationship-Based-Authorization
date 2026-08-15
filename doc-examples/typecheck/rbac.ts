// Mirrors docs/rbac.md's code samples. Keep these in sync — see
// doc-examples/README.md for the convention this file is part of.
import express from 'express';
import type { Request } from 'express';
import {
  RbacPolicy,
  requirePermission,
  subjectFromRequestRoles,
} from '@novavey/multi-tenant-security-kit/rbac';
import type { AccessSubject, SubjectResolver } from '@novavey/multi-tenant-security-kit/rbac';
import { requireCurrentTenantId } from '@novavey/multi-tenant-security-kit/tenant';

declare const app: express.Express;
declare const handler: express.RequestHandler;
declare const db: { userRoles: { find(userId: string): Promise<string[]> } };
declare const policy: RbacPolicy;

// "assert()" usage
declare const subject: AccessSubject;
policy.assert(subject, 'invoices:write'); // throws ForbiddenError if denied

// "Middleware"
app.get(
  '/invoices',
  requirePermission({
    policy,
    permission: 'invoices:read',
    getSubject: subjectFromRequestRoles(), // reads req.roles, tenantId from the active tenant context
  }),
  handler,
);

// "permission can also be a function of the request"
requirePermission({
  policy,
  permission: (req) => (req.method === 'GET' ? 'invoices:read' : 'invoices:write'),
  getSubject: subjectFromRequestRoles(),
});

// "Write your own SubjectResolver"
const getSubject: SubjectResolver<Request & { user: { id: string } }> = async (req) => {
  const roles = await db.userRoles.find(req.user.id);
  return { tenantId: requireCurrentTenantId(), roles };
};
void getSubject;

// "Customizing the denial response"
requirePermission({
  policy,
  permission: 'invoices:read',
  getSubject: subjectFromRequestRoles(),
  onDenied: (req, res, next, error) => {
    void req;
    void next;
    res.status(403).json({ code: 'FORBIDDEN', detail: error.message });
  },
});
