# Audit logging

`@novavey/multi-tenant-security-kit/audit`

Structured, multi-sink audit event logging with one hard guarantee: **`log()`
never throws, and one failing sink never blocks or affects another.** Audit
logging is inherently best-effort side work — a webhook timeout or a queue
outage should never take down the request it's describing.

## Basic usage

```ts
import {
  AuditLogger,
  ConsoleAuditSink,
  AuditAction,
} from '@novavey/multi-tenant-security-kit/audit';

const auditLog = new AuditLogger({ sinks: [new ConsoleAuditSink()] });

auditLog.log({
  action: AuditAction.RbacPermissionDenied,
  actorId: user.id,
  targetId: invoice.id,
  outcome: 'denied',
  metadata: { permission: 'invoices:write' },
});
```

`AuditAction` is a small set of recommended action-name constants for
consistency across an application (`TenantIsolationViolation`,
`RbacPermissionDenied`, `RateLimitExceeded`, `AuthLoginSucceeded`,
`AuthLoginFailed`) — it's not a closed enum, `action` accepts any string.

## What gets filled in automatically

- **`timestamp`** — always stamped as `new Date().toISOString()` at call
  time. Callers can't accidentally omit or backdate it.
- **`tenantId`** — resolution order is: an explicit value on the event you
  pass to `log()`, then a `child()` logger's defaults (see below), then the
  ambient [tenant context](./tenant-isolation.md) via `getCurrentTenantId()`.
  It's left `undefined` if none apply — audit events outside any tenant
  context (e.g. platform-level actions) are still valid events.

## Composing multiple sinks

`AuditLogger` fans every event out to every configured sink. Ship your own
by implementing the one-method `AuditSink` interface, or use the built-ins:

```ts
import {
  AuditLogger,
  ConsoleAuditSink,
  InMemoryAuditSink,
  callbackAuditSink,
} from '@novavey/multi-tenant-security-kit/audit';

const auditLog = new AuditLogger({
  sinks: [
    new ConsoleAuditSink(), // one JSON line per event, via console.log
    callbackAuditSink(async (event) => {
      await sendToLogPipeline(event); // your own webhook, queue, SIEM, etc.
    }),
  ],
});
```

`InMemoryAuditSink` (accumulates events in `.events`, `.clear()` to reset)
is meant for tests and short-lived debugging, not production use.

A sink that throws synchronously or returns a rejected promise never
escapes `log()` or blocks sibling sinks — its error is wrapped in
`AuditSinkError` (carrying `sinkName` and the original error as `cause`) and
handed to `onSinkError` (default: `console.error`):

```ts
new AuditLogger({
  sinks: [webhookSink, consoleSink],
  onSinkError: (error) =>
    alerting.notify(`audit sink failed: ${error.sinkName}`, { cause: error.cause }),
});
```

## Redacting sensitive data

```ts
new AuditLogger({
  sinks: [new ConsoleAuditSink()],
  redact: (event) => {
    // Not a ternary building `{ ...event, metadata: event.metadata ? ... :
    // event.metadata }`: under `exactOptionalPropertyTypes` (this package's
    // own tsconfig uses it, and yours might too), explicitly assigning
    // `metadata: undefined` doesn't satisfy `metadata?: Record<string,
    // unknown>` — only *omitting* the key does. Returning `event` unchanged
    // when there's nothing to redact sidesteps that entirely.
    if (!event.metadata) return event;
    return { ...event, metadata: { ...event.metadata, password: undefined } };
  },
});
```

`redact` runs once per `log()` call, before any sink sees the event — every
sink gets the same redacted version, so you never have to duplicate
redaction logic per sink.

## Child loggers

`child()` returns a new logger sharing the same sinks/`onSinkError`/`redact`,
whose `log()` merges the given defaults _underneath_ each call's own fields
— useful for a per-request logger that should always stamp a fixed
`actorId` without every call site repeating it:

```ts
app.use((req, res, next) => {
  // Not `auditLog.child({ actorId: req.user?.id })`: req.user is realistically
  // optional (unauthenticated routes, or this middleware running before auth
  // does), and under `exactOptionalPropertyTypes` (this package's own tsconfig
  // uses it, and yours might too) explicitly passing `actorId: undefined`
  // doesn't satisfy `actorId?: string` — only omitting the key does. Skipping
  // child() entirely when there's nothing to default sidesteps that.
  req.auditLog = req.user ? auditLog.child({ actorId: req.user.id }) : auditLog;
  next();
});

// later, in a route:
req.auditLog.log({ action: 'invoices.exported', outcome: 'success' });
// -> actorId is already set from the child's defaults
```

An explicit field on a given `log()` call always wins over the child's
defaults, and `child()` can itself be chained.

## OpenTelemetry integration

This package has zero runtime dependencies, so it never imports
`@opentelemetry/api` itself — `openTelemetrySink` and `traceContextTransform`
instead accept a `getActiveSpan` callback you provide (typically
`() => trace.getActiveSpan()`), typed against a small structural interface
(`OtelSpanLike`) that a real OpenTelemetry `Span` satisfies with no adapter
or cast needed:

```ts
import { trace } from '@opentelemetry/api';
import {
  AuditLogger,
  ConsoleAuditSink,
  openTelemetrySink,
  traceContextTransform,
} from '@novavey/multi-tenant-security-kit/audit';

const getActiveSpan = () => trace.getActiveSpan();

const auditLog = new AuditLogger({
  sinks: [
    new ConsoleAuditSink(),
    openTelemetrySink({ getActiveSpan }), // records each event as a span event
  ],
  redact: traceContextTransform({ getActiveSpan }), // stamps traceId/spanId onto every sink's event
});
```

**`openTelemetrySink({ getActiveSpan })`** — an `AuditSink` that calls
`span.addEvent(action, attributes)` on the currently active span for every
audit event, and marks the span's status as an error for any outcome other
than `'success'`. A no-op (not an error) when there's no active span. Only
`metadata` values that are `string | number | boolean` become span
attributes — OpenTelemetry attributes can't hold arbitrary objects; richer
metadata is silently dropped from the span event only, every other
configured sink still receives it in full.

**`traceContextTransform({ getActiveSpan })`** — builds a function
compatible with `AuditLoggerOptions.redact` that stamps `traceId`/`spanId`
from the active span onto every event's `metadata`, so sinks with no
OpenTelemetry awareness at all (a plain JSON log, a webhook, a database
row) can still be correlated back to the trace that produced them. Compose
with your own redaction if you need both:
`redact: (event) => myRedact(traceContextTransform({ getActiveSpan })(event))`.

Both are plain functions returning a sink/transform — nothing about them is
OpenTelemetry-SDK-specific beyond the shape of the object `getActiveSpan`
returns, so a test double or any other tracer satisfying `OtelSpanLike` (see
the API reference below) works too, no `@opentelemetry/api` install
required just to use this module.

## API reference

| Export                           | Kind      | Summary                                                                                                                        |
| -------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `AuditOutcome`                   | type      | `'success' \| 'failure' \| 'denied'`                                                                                           |
| `AuditEvent`                     | type      | `{ action, tenantId?, actorId?, targetId?, outcome, metadata?, timestamp }`                                                    |
| `AuditEventInput`                | type      | What you pass to `log()` — `AuditEvent` minus `timestamp`, optional `tenantId`                                                 |
| `AuditSink`                      | interface | `write(event): void \| Promise<void>`                                                                                          |
| `AuditAction`                    | const     | Recommended action-name constants (not a closed set)                                                                           |
| `ConsoleAuditSink`               | class     | Writes one JSON line per event via `console.log`                                                                               |
| `InMemoryAuditSink`              | class     | Accumulates events; `.events`, `.clear()` — tests/debugging only                                                               |
| `callbackAuditSink(fn)`          | function  | Wraps an arbitrary function as a sink                                                                                          |
| `AuditLoggerOptions`             | type      | `{ sinks, onSinkError?, redact? }`                                                                                             |
| `AuditLogger`                    | class     | `new AuditLogger(options)`; `.log(event)`; `.child(defaults)`                                                                  |
| `OtelSpanLike`                   | type      | Structural subset of `@opentelemetry/api`'s `Span` this module needs                                                           |
| `OtelHookOptions`                | type      | `{ getActiveSpan: () => OtelSpanLike \| undefined }`                                                                           |
| `openTelemetrySink(options)`     | function  | `AuditSink` recording events as span events on the active span                                                                 |
| `traceContextTransform(options)` | function  | `redact`-compatible transform stamping `traceId`/`spanId` onto `metadata`                                                      |
| `SecurityKitError`               | class     | Base class every error in this package extends; carries a stable `.code`                                                       |
| `AuditSinkError`                 | class     | Wraps a sink's (or `redact`'s) thrown/rejected error passed to `onSinkError`; `code: 'AUDIT_SINK_FAILED'`, carries `.sinkName` |
