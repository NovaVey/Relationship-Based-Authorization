// Mirrors docs/audit-logging.md's code samples. Keep these in sync — see
// doc-examples/README.md for the convention this file is part of.
import express from 'express';
import { trace } from '@opentelemetry/api';
import {
  AuditLogger,
  ConsoleAuditSink,
  InMemoryAuditSink,
  callbackAuditSink,
  AuditAction,
  openTelemetrySink,
  traceContextTransform,
} from '@novavey/multi-tenant-security-kit/audit';
import type {
  AuditEvent,
  AuditSink,
  AuditSinkError,
} from '@novavey/multi-tenant-security-kit/audit';

declare const app: express.Express;
declare const user: { id: string };
declare const invoice: { id: string };
declare const auditLog: AuditLogger;
declare function sendToLogPipeline(event: AuditEvent): Promise<void>;

// "Basic usage"
auditLog.log({
  action: AuditAction.RbacPermissionDenied,
  actorId: user.id,
  targetId: invoice.id,
  outcome: 'denied',
  metadata: { permission: 'invoices:write' },
});

// "Composing multiple sinks"
const auditLog2 = new AuditLogger({
  sinks: [
    new ConsoleAuditSink(), // one JSON line per event, via console.log
    callbackAuditSink(async (event) => {
      await sendToLogPipeline(event); // your own webhook, queue, SIEM, etc.
    }),
  ],
});
void auditLog2;

const inMem = new InMemoryAuditSink();
void inMem;

// "onSinkError"
declare const webhookSink: AuditSink;
declare const consoleSink: AuditSink;
declare const alerting: { notify(message: string, opts: { cause?: unknown }): void };
new AuditLogger({
  sinks: [webhookSink, consoleSink],
  onSinkError: (error: AuditSinkError) =>
    alerting.notify(`audit sink failed: ${error.sinkName}`, { cause: error.cause }),
});

// "Redacting sensitive data"
new AuditLogger({
  sinks: [new ConsoleAuditSink()],
  redact: (event) => {
    if (!event.metadata) return event;
    return { ...event, metadata: { ...event.metadata, password: undefined } };
  },
});

// "Child loggers"
declare module 'express-serve-static-core' {
  interface Request {
    auditLog?: AuditLogger;
    user?: { id: string };
  }
}
app.use((req, res, next) => {
  void res;
  req.auditLog = req.user ? auditLog.child({ actorId: req.user.id }) : auditLog;
  next();
});

// later, in a route:
declare const req: express.Request & { auditLog: AuditLogger };
req.auditLog.log({ action: 'invoices.exported', outcome: 'success' });

// "OpenTelemetry integration"
{
  const getActiveSpan = () => trace.getActiveSpan();

  const auditLog3 = new AuditLogger({
    sinks: [
      new ConsoleAuditSink(),
      openTelemetrySink({ getActiveSpan }), // records each event as a span event
    ],
    redact: traceContextTransform({ getActiveSpan }), // stamps traceId/spanId onto every sink's event
  });
  void auditLog3;
}
