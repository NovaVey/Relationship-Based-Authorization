// Mirrors docs/audit-logging.md's redact example (and basic usage, via
// InMemoryAuditSink for assertions). Keep in sync — see
// doc-examples/README.md for the convention this file is part of.
import assert from 'node:assert/strict';
import { trace } from '@opentelemetry/api';
import {
  AuditLogger,
  InMemoryAuditSink,
  AuditAction,
  openTelemetrySink,
  traceContextTransform,
} from '@novavey/multi-tenant-security-kit/audit';

// "Basic usage"
const sink = new InMemoryAuditSink();
const auditLog = new AuditLogger({ sinks: [sink] });

auditLog.log({
  action: AuditAction.RbacPermissionDenied,
  actorId: 'user_1',
  targetId: 'invoice_1',
  outcome: 'denied',
  metadata: { permission: 'invoices:write' },
});

assert.equal(sink.events.length, 1);
assert.equal(sink.events[0].action, AuditAction.RbacPermissionDenied);
assert.equal(typeof sink.events[0].timestamp, 'string'); // stamped automatically

// "Redacting sensitive data"
const redactedSink = new InMemoryAuditSink();
const redactedLog = new AuditLogger({
  sinks: [redactedSink],
  redact: (event) => ({
    ...event,
    metadata: event.metadata ? { ...event.metadata, password: undefined } : event.metadata,
  }),
});

redactedLog.log({
  action: 'auth.login',
  outcome: 'success',
  metadata: { username: 'alice', password: 'hunter2' },
});

assert.equal(redactedSink.events[0].metadata.username, 'alice');
// `password: undefined` still leaves the *key* present (the redact example
// overwrites the value, not the key) — checking the value is what actually
// matters for "did this stop leaking the password".
assert.equal(redactedSink.events[0].metadata.password, undefined);

// "Child loggers": defaults merge underneath each call's own fields.
const childSink = new InMemoryAuditSink();
const childLog = new AuditLogger({ sinks: [childSink] }).child({ actorId: 'user_2' });
childLog.log({ action: 'invoices.exported', outcome: 'success' });
assert.equal(childSink.events[0].actorId, 'user_2');
// An explicit field on the call always wins over the child's defaults.
childLog.log({ action: 'invoices.exported', outcome: 'success', actorId: 'user_3' });
assert.equal(childSink.events[1].actorId, 'user_3');

// "OpenTelemetry integration": no SDK is registered in this script, so
// trace.getActiveSpan() genuinely returns undefined — real proof of the
// documented no-op behavior, not a mock standing in for one.
const otelNoopSink = openTelemetrySink({ getActiveSpan: () => trace.getActiveSpan() });
assert.doesNotThrow(() => {
  otelNoopSink.write({
    action: 'auth.login.succeeded',
    outcome: 'success',
    timestamp: new Date().toISOString(),
  });
});

// A minimal hand-rolled span (not `@opentelemetry/api`'s own) proves the
// structural OtelSpanLike contract for real, at runtime, not just at the
// type level: anything shaped like a Span works, no SDK required.
const spanCalls = { addEvent: [], setStatus: [] };
const fakeSpan = {
  addEvent: (name, attributes) => spanCalls.addEvent.push({ name, attributes }),
  setStatus: (status) => spanCalls.setStatus.push(status),
  spanContext: () => ({ traceId: 't-1', spanId: 's-1' }),
};

const otelSink = openTelemetrySink({ getActiveSpan: () => fakeSpan });
otelSink.write({
  action: AuditAction.RbacPermissionDenied,
  outcome: 'denied',
  timestamp: new Date().toISOString(),
  metadata: { permission: 'invoices:write' },
});
assert.equal(spanCalls.addEvent.length, 1);
assert.equal(spanCalls.addEvent[0].name, AuditAction.RbacPermissionDenied);
assert.equal(spanCalls.addEvent[0].attributes.outcome, 'denied');
assert.deepEqual(spanCalls.setStatus[0], { code: 2, message: AuditAction.RbacPermissionDenied });

const transform = traceContextTransform({ getActiveSpan: () => fakeSpan });
const transformed = transform({
  action: 'auth.login.succeeded',
  outcome: 'success',
  timestamp: new Date().toISOString(),
  metadata: { foo: 'bar' },
});
assert.deepEqual(transformed.metadata, { foo: 'bar', traceId: 't-1', spanId: 's-1' });

console.log(
  'OK audit-logging.md: basic usage + redact + child logger + OpenTelemetry integration examples',
);
