/**
 * Audit logging module: a pluggable, tenant-aware record of security- and
 * business-relevant events (logins, RBAC denials, rate limit hits, tenant
 * isolation violations, and anything else an application chooses to log).
 *
 * Import from this barrel rather than reaching into individual files.
 */

export type { AuditOutcome, AuditEvent, AuditSink } from './types.js';
export { AuditAction } from './types.js';

export { ConsoleAuditSink, InMemoryAuditSink, callbackAuditSink } from './sinks.js';

export { AuditLogger } from './logger.js';
export type { AuditEventInput, AuditLoggerOptions } from './logger.js';

export { openTelemetrySink, traceContextTransform } from './otel.js';
export type { OtelSpanLike, OtelHookOptions } from './otel.js';

// Re-exported so consumers importing only this subpath can catch/narrow on
// the error type `AuditLoggerOptions.onSinkError` receives, without also
// importing from the package root.
export { SecurityKitError, AuditSinkError } from '../errors.js';
