/**
 * Shared error hierarchy for the Multi-Tenant Security Kit.
 *
 * Every error the kit throws extends {@link SecurityKitError} and carries a
 * stable machine-readable `code`, so callers (and audit-log sinks) can branch
 * on `error.code` instead of parsing messages or using `instanceof` chains
 * across module boundaries.
 */

export interface SecurityKitErrorOptions {
  cause?: unknown;
}

/** Base class for every error thrown by this package. */
export class SecurityKitError extends Error {
  /** Stable, machine-readable identifier for this error type. */
  readonly code: string;

  constructor(message: string, code: string, options?: SecurityKitErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Thrown when tenant-scoped code runs outside of any tenant context. */
export class TenantContextError extends SecurityKitError {
  constructor(message = 'No tenant context is active for the current execution.') {
    super(message, 'TENANT_CONTEXT_MISSING');
  }
}

/** Thrown when an operation would read or write data belonging to a different tenant. */
export class CrossTenantAccessError extends SecurityKitError {
  readonly expectedTenantId: string;
  readonly actualTenantId: string;

  constructor(expectedTenantId: string, actualTenantId: string, message?: string) {
    super(
      message ??
        `Cross-tenant access blocked: current tenant is "${expectedTenantId}" but the ` +
          `resource belongs to "${actualTenantId}".`,
      'CROSS_TENANT_ACCESS_DENIED',
    );
    this.expectedTenantId = expectedTenantId;
    this.actualTenantId = actualTenantId;
  }
}

/**
 * Thrown by the `rls` module when a value that must be a safe, allowlisted
 * SQL identifier (a table/column/policy/role/session-setting name) isn't
 * one — e.g. `generateEnableRlsSql('users; DROP TABLE users;--')`.
 *
 * Every value this error can be thrown for is developer-supplied at
 * migration-authoring time, never end-user request input (see
 * `src/rls/postgres.ts`'s own security-model doc comment for why that
 * distinction matters) — this error means a mistake in code generating a
 * migration, not a caught attack.
 */
export class InvalidSqlIdentifierError extends SecurityKitError {
  /** Which parameter (`table`, `tenantColumn`, `sessionSetting`, ...) rejected the value. */
  readonly paramName: string;

  constructor(value: unknown, paramName: string, message?: string) {
    super(
      message ?? `Invalid SQL identifier for "${paramName}": ${JSON.stringify(value)}.`,
      'INVALID_SQL_IDENTIFIER',
    );
    this.paramName = paramName;
  }
}

/**
 * Thrown when an RBAC policy denies a permission check.
 *
 * Constructor order is `(message, permission?)` — `message` first, required
 * — deliberately unlike this file's other data-carrying errors (which take
 * their defining value first and an *optional* `message` last, e.g.
 * {@link CrossTenantAccessError}, {@link InvalidRateLimitPointsError}).
 * Those can all synthesize a sensible default message from their one
 * required value alone; `ForbiddenError` can't, because it's thrown from
 * more than one place with genuinely different messages that don't reduce
 * to a single derivable value — `RbacPolicy.assert()` has a specific
 * permission and a list of the subject's roles to describe, while
 * `requirePermission`'s "no subject could be resolved" denial has no
 * permission at all yet still needs a message. A required `message` first
 * is the deliberate fit for that, not an oversight.
 */
export class ForbiddenError extends SecurityKitError {
  readonly permission?: string | undefined;

  constructor(message: string, permission?: string) {
    super(message, 'FORBIDDEN');
    this.permission = permission;
  }
}

/** Thrown when a tenant has exceeded its allotted rate limit. */
export class RateLimitExceededError extends SecurityKitError {
  /** Milliseconds until the caller may retry. */
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number, message?: string) {
    super(message ?? `Rate limit exceeded. Retry after ${retryAfterMs}ms.`, 'RATE_LIMIT_EXCEEDED');
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Thrown when a caller passes a `points` value to {@link TenantRateLimiter.consume}
 * that isn't a positive, finite number. A zero, negative, `NaN`, or infinite
 * `points` would otherwise unconditionally succeed regardless of a tenant's
 * actual remaining budget (zero/negative never exceeds the bucket; `NaN`
 * comparisons are always `false`) — a real bypass risk given this library's
 * own "variable request cost" feature explicitly invites deriving `points`
 * from request data.
 */
export class InvalidRateLimitPointsError extends SecurityKitError {
  readonly points: unknown;

  constructor(points: unknown, message?: string) {
    super(
      message ??
        `Invalid rate-limit points: ${JSON.stringify(points)}. Must be a positive, finite number.`,
      'INVALID_RATE_LIMIT_POINTS',
    );
    this.points = points;
  }
}

/** Thrown for malformed or missing tenant identifiers. */
export class InvalidTenantIdError extends SecurityKitError {
  constructor(tenantId: unknown, message?: string) {
    super(message ?? `Invalid tenant id: ${JSON.stringify(tenantId)}`, 'INVALID_TENANT_ID');
  }
}

/** Thrown by the crypto module when decryption fails (bad key, tampered payload, wrong tenant). */
export class DecryptionError extends SecurityKitError {
  constructor(message = 'Failed to decrypt payload.', options?: SecurityKitErrorOptions) {
    super(message, 'DECRYPTION_FAILED', options);
  }
}

/**
 * Thrown by the crypto module when encryption itself fails — a low-level
 * `node:crypto` failure inside `cipher.update()`/`cipher.final()`, not a
 * policy decision this module makes. Unlike `decrypt()` (which routinely
 * fails on ordinary bad input: a wrong key, a tampered payload), `encrypt()`
 * has no comparable authentication step and essentially never fails under
 * normal use — this exists so a genuine failure here (a pathological input,
 * an unexpected environment/`node:crypto` error) still comes out as a typed
 * `SecurityKitError` instead of an unwrapped, inconsistent-with-the-rest-of-
 * this-module raw error.
 */
export class EncryptionError extends SecurityKitError {
  constructor(message = 'Failed to encrypt payload.', options?: SecurityKitErrorOptions) {
    super(message, 'ENCRYPTION_FAILED', options);
  }
}

/**
 * Thrown by the `crypto` module when a key or key-derivation input has the
 * wrong byte length — an {@link EnvKeyProvider} master secret shorter than
 * its required minimum, or a {@link KeyProvider}-returned data key that
 * isn't exactly the 32 bytes AES-256-GCM requires. Previously a plain
 * `TypeError` in both cases, which broke this package's "every error
 * extends `SecurityKitError`" guarantee for a module whose extension point
 * (a custom `KeyProvider`, e.g. for a real KMS) makes this a genuinely
 * reachable, not merely theoretical, failure.
 */
export class InvalidKeyError extends SecurityKitError {
  /** The actual byte length that was rejected. */
  readonly actualLength: number;

  constructor(message: string, actualLength: number) {
    super(message, 'INVALID_KEY');
    this.actualLength = actualLength;
  }
}

/** Thrown when an {@link RbacPolicy} (see `rbac/policy.ts`) is constructed with invalid role definitions. */
export class RbacConfigurationError extends SecurityKitError {
  constructor(message: string) {
    super(message, 'RBAC_CONFIGURATION_INVALID');
  }
}

/**
 * Thrown when a {@link TenantRateLimiter} or {@link MemoryRateLimitStore} is
 * constructed with an invalid `limit`, `windowMs`, or `maxBuckets`. A
 * non-positive `limit`/`windowMs` isn't just a bad config value — it's a
 * full rate-limit bypass (a `windowMs` of `0` refills every bucket to full
 * capacity on every call), so this is validated once at construction time
 * rather than left to fail unpredictably deep inside the store's own
 * arithmetic.
 */
export class RateLimitConfigurationError extends SecurityKitError {
  constructor(message: string) {
    super(message, 'RATE_LIMIT_CONFIGURATION_INVALID');
  }
}

/** Wraps an error thrown by an audit sink so callers can distinguish "audit delivery failed" from other errors. */
export class AuditSinkError extends SecurityKitError {
  readonly sinkName: string;

  constructor(sinkName: string, options?: SecurityKitErrorOptions) {
    super(`Audit sink "${sinkName}" failed to write an event.`, 'AUDIT_SINK_FAILED', options);
    this.sinkName = sinkName;
  }
}
