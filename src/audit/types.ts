/**
 * Shared types for the audit logging module.
 *
 * Kept separate from the sink implementations and the {@link AuditLogger}
 * itself so alternative sinks (a webhook, a queue producer, a database
 * writer) can depend on just this file without pulling in any concrete
 * implementation.
 */

/**
 * The result of the action being audited.
 *
 * `'denied'` is distinct from `'failure'` so security-relevant rejections
 * (an RBAC check, a rate limit, a tenant isolation guard) can be filtered
 * or alerted on separately from ordinary application errors.
 */
export type AuditOutcome = 'success' | 'failure' | 'denied';

/**
 * A single audit record, as it is written to a sink.
 *
 * This is the fully-resolved shape — `timestamp` is always present and
 * `tenantId` has already been defaulted from the ambient tenant context
 * where applicable — by the time a sink sees it. See {@link AuditLogger}
 * in `logger.ts` for the input shape callers actually construct.
 */
export interface AuditEvent {
  /** What happened, e.g. `'auth.login.failed'`. See {@link AuditAction} for recommended names. */
  action: string;
  /** The tenant this event is scoped to, if any. */
  tenantId?: string;
  /** The identity (user, service account, API key, ...) that performed the action, if known. */
  actorId?: string;
  /** The identity of the resource the action was performed on, if applicable. */
  targetId?: string;
  /** Whether the action succeeded, failed, or was denied. */
  outcome: AuditOutcome;
  /** Free-form structured context. Keep secrets out of here — use `redact` (see `logger.ts`) if a sink might leak this. */
  metadata?: Record<string, unknown>;
  /** ISO-8601 timestamp of when the event occurred, e.g. `new Date().toISOString()`. */
  timestamp: string;
}

/**
 * A destination for audit events: a log stream, a webhook, a queue, a
 * database table, and so on.
 *
 * Kept deliberately tiny — one method — so implementing a custom sink never
 * requires more than wrapping whatever transport a caller already has.
 * `write` may be synchronous or return a `Promise`; {@link AuditLogger}
 * (see `logger.ts`) awaits either form and isolates failures per-sink so one
 * broken sink can never block or crash the others.
 */
export interface AuditSink {
  write(event: AuditEvent): void | Promise<void>;
}

/**
 * Recommended `action` name constants for consistency across an
 * application.
 *
 * This is *not* a closed enum: {@link AuditEvent.action} is a plain
 * `string`, and callers are free to log any action name that makes sense
 * for their domain (e.g. `'billing.invoice.voided'`). These constants exist
 * so the handful of actions this kit itself cares about (tenant isolation,
 * RBAC, rate limiting, auth) are spelled consistently everywhere they're
 * used, rather than each call site inventing its own string.
 */
export const AuditAction = {
  /** A request attempted to read or write data belonging to a different tenant. */
  TenantIsolationViolation: 'tenant.isolation.violation',
  /** An RBAC policy denied a permission check. */
  RbacPermissionDenied: 'rbac.permission.denied',
  /** A tenant (or other rate-limited key) exceeded its allotted budget. */
  RateLimitExceeded: 'rate_limit.exceeded',
  /** A login attempt succeeded. */
  AuthLoginSucceeded: 'auth.login.succeeded',
  /** A login attempt failed. */
  AuthLoginFailed: 'auth.login.failed',
} as const;
