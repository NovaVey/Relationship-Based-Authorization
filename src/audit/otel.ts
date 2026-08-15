/**
 * Optional OpenTelemetry integration for the audit module.
 *
 * This package has zero runtime dependencies and this file never imports
 * `@opentelemetry/api` — {@link OtelSpanLike} is a structural subset of its
 * real `Span` interface, so any real `@opentelemetry/api` `Span` (e.g. from
 * `trace.getActiveSpan()`) satisfies it with no adapter or cast required.
 * Bring your own `@opentelemetry/api`; this module just knows the shape.
 */
import type { AuditEvent, AuditSink } from './types.js';

/**
 * Structural subset of OpenTelemetry's `Span` interface this module needs.
 * A real `@opentelemetry/api` `Span` satisfies this automatically.
 */
export interface OtelSpanLike {
  spanContext(): { traceId: string; spanId: string };
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
}

/** Shared by {@link openTelemetrySink} and {@link traceContextTransform}. */
export interface OtelHookOptions {
  /**
   * Returns the span the current audit event should be attached to, or
   * `undefined` outside any span (no tracer configured, or the event
   * happened off the request path). Typically
   * `() => trace.getActiveSpan()` from `@opentelemetry/api`.
   */
  getActiveSpan: () => OtelSpanLike | undefined;
}

// OpenTelemetry's stable SpanStatusCode.ERROR value (`@opentelemetry/api`,
// stable since v1.0.0: UNSET = 0, OK = 1, ERROR = 2) — hardcoded so this
// package doesn't need `@opentelemetry/api` as a dependency just to set it.
const SPAN_STATUS_CODE_ERROR = 2;

/**
 * Calls `options.getActiveSpan()` and, if it returned a span, that span's
 * own `spanContext()`, defensively: either call throwing (a malformed or
 * version-incompatible span/tracer — this module only knows `OtelSpanLike`'s
 * *shape*, not that any given implementation actually behaves per spec) is
 * treated the same as no active span at all, rather than escaping to the
 * caller. Used by {@link traceContextTransform} — see its own doc comment
 * for why swallowing this particular failure matters more there than it
 * would look like at a glance.
 */
function safeSpanContext(
  options: OtelHookOptions,
): { traceId: string; spanId: string } | undefined {
  try {
    const span = options.getActiveSpan();
    return span?.spanContext();
  } catch {
    return undefined;
  }
}

function eventAttributes(event: AuditEvent): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = { outcome: event.outcome };
  if (event.tenantId !== undefined) attributes.tenantId = event.tenantId;
  if (event.actorId !== undefined) attributes.actorId = event.actorId;
  if (event.targetId !== undefined) attributes.targetId = event.targetId;
  if (event.metadata) {
    for (const [key, value] of Object.entries(event.metadata)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        attributes[`metadata.${key}`] = value;
      }
    }
  }
  return attributes;
}

/**
 * Builds an {@link AuditSink} that records every audit event as a span
 * event (`span.addEvent`) on the currently active OpenTelemetry span,
 * correlating audit events with the trace/request that produced them.
 * Events with an outcome other than `'success'` also mark the span's
 * status as an error, so a denied or failed action surfaces in trace
 * views (span lists, error rate dashboards) without extra instrumentation.
 *
 * A no-op — not an error — when `getActiveSpan()` returns `undefined`,
 * e.g. no tracer is configured, or the event happened outside any span.
 * Use alongside your other sinks; this doesn't replace them.
 *
 * Only `metadata` values that are `string | number | boolean` are attached
 * as span attributes — OpenTelemetry attributes can't hold arbitrary
 * objects. Richer metadata is silently dropped from the span event only;
 * every other configured sink still receives it in full.
 */
export function openTelemetrySink(options: OtelHookOptions): AuditSink {
  return {
    write(event: AuditEvent): void {
      const span = options.getActiveSpan();
      if (!span) return;
      span.addEvent(event.action, eventAttributes(event));
      if (event.outcome !== 'success') {
        span.setStatus({ code: SPAN_STATUS_CODE_ERROR, message: event.action });
      }
    },
  };
}

/**
 * Builds a transform compatible with {@link AuditLoggerOptions.redact} that
 * stamps `traceId`/`spanId` from the active span onto every event's
 * `metadata`, so sinks with no OpenTelemetry awareness at all (a plain
 * JSON log line, a webhook, a database row) can still be correlated back
 * to the trace that produced them, not just sinks built on
 * {@link openTelemetrySink}.
 *
 * A no-op — returns `event` unchanged — when `getActiveSpan()` returns
 * `undefined`, *or* when `getActiveSpan()`/`spanContext()` throws. The
 * throwing case matters more here than it would for an ordinary sink: this
 * function is meant to be passed as {@link AuditLoggerOptions.redact}
 * (see below), and `AuditLogger.log()` treats a throwing `redact` as a
 * reason to drop the *entire* event — not just skip trace-context
 * enrichment — since it can't tell a redaction failure from "this
 * transform doesn't work right now" and has to fail closed either way. A
 * malformed or version-incompatible span object (this module only knows
 * `OtelSpanLike`'s shape, not that a given implementation actually honors
 * it) would otherwise silently take out every audit event for the rest of
 * that trace, for sinks that have nothing to do with OpenTelemetry at all —
 * a correctness bug entirely disproportionate to what this transform is
 * for. {@link openTelemetrySink} never had this failure mode: a throwing
 * span there only takes out that one sink (isolated by `AuditLogger`
 * itself), never the whole event.
 *
 * Compose with your own redaction if you need both:
 * `redact: (event) => myRedact(traceContextTransform(options)(event))`.
 */
export function traceContextTransform(options: OtelHookOptions): (event: AuditEvent) => AuditEvent {
  return (event: AuditEvent): AuditEvent => {
    const spanContext = safeSpanContext(options);
    if (!spanContext) return event;
    return {
      ...event,
      metadata: { ...event.metadata, traceId: spanContext.traceId, spanId: spanContext.spanId },
    };
  };
}
