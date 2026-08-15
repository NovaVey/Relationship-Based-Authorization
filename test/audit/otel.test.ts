import { describe, expect, it, vi } from 'vitest';

import { openTelemetrySink, traceContextTransform } from '../../src/audit/otel.js';
import type { OtelSpanLike } from '../../src/audit/otel.js';
import { AuditLogger } from '../../src/audit/logger.js';
import type { AuditEvent } from '../../src/audit/types.js';

function fakeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    action: 'auth.login.succeeded',
    outcome: 'success',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeSpan() {
  return {
    addEvent: vi.fn<OtelSpanLike['addEvent']>(),
    setStatus: vi.fn<OtelSpanLike['setStatus']>(),
    spanContext: vi.fn<OtelSpanLike['spanContext']>(() => ({ traceId: 't-1', spanId: 's-1' })),
  } satisfies OtelSpanLike;
}

describe('openTelemetrySink', () => {
  it('is a no-op when there is no active span', () => {
    const sink = openTelemetrySink({ getActiveSpan: () => undefined });
    expect(() => void sink.write(fakeEvent())).not.toThrow();
  });

  it('records the event as a span event on the active span', () => {
    const span = fakeSpan();
    const sink = openTelemetrySink({ getActiveSpan: () => span });

    void sink.write(
      fakeEvent({ action: 'rbac.permission.denied', tenantId: 'acme', actorId: 'user-1' }),
    );

    expect(span.addEvent).toHaveBeenCalledWith(
      'rbac.permission.denied',
      expect.objectContaining({ outcome: 'success', tenantId: 'acme', actorId: 'user-1' }),
    );
  });

  it('only attaches primitive-valued metadata as span attributes', () => {
    const span = fakeSpan();
    const sink = openTelemetrySink({ getActiveSpan: () => span });

    void sink.write(
      fakeEvent({
        metadata: { reason: 'bad password', attempt: 3, locked: false, nested: { a: 1 } },
      }),
    );

    const [, attributes] = span.addEvent.mock.calls[0] as [string, Record<string, unknown>];
    expect(attributes).toMatchObject({
      'metadata.reason': 'bad password',
      'metadata.attempt': 3,
      'metadata.locked': false,
    });
    expect(attributes).not.toHaveProperty('metadata.nested');
  });

  it('marks the span status as an error for non-success outcomes', () => {
    const span = fakeSpan();
    const sink = openTelemetrySink({ getActiveSpan: () => span });

    void sink.write(fakeEvent({ action: 'rbac.permission.denied', outcome: 'denied' }));

    expect(span.setStatus).toHaveBeenCalledWith({ code: 2, message: 'rbac.permission.denied' });
  });

  it('does not touch span status for a successful outcome', () => {
    const span = fakeSpan();
    const sink = openTelemetrySink({ getActiveSpan: () => span });

    void sink.write(fakeEvent({ outcome: 'success' }));

    expect(span.setStatus).not.toHaveBeenCalled();
  });

  it('composes with other sinks through AuditLogger without affecting them', () => {
    const span = fakeSpan();
    const events: AuditEvent[] = [];
    const logger = new AuditLogger({
      sinks: [
        openTelemetrySink({ getActiveSpan: () => span }),
        {
          write: (e) => {
            events.push(e);
          },
        },
      ],
    });

    logger.log({ action: 'auth.login.succeeded', outcome: 'success' });

    expect(span.addEvent).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });
});

describe('traceContextTransform', () => {
  it('returns the event unchanged when there is no active span', () => {
    const transform = traceContextTransform({ getActiveSpan: () => undefined });
    const event = fakeEvent();

    expect(transform(event)).toBe(event);
  });

  it('stamps traceId/spanId onto metadata from the active span', () => {
    const span = fakeSpan();
    const transform = traceContextTransform({ getActiveSpan: () => span });

    const result = transform(fakeEvent({ metadata: { foo: 'bar' } }));

    expect(result.metadata).toEqual({ foo: 'bar', traceId: 't-1', spanId: 's-1' });
  });

  it('works as an AuditLoggerOptions.redact value', () => {
    const span = fakeSpan();
    const events: AuditEvent[] = [];
    const logger = new AuditLogger({
      sinks: [
        {
          write: (e) => {
            events.push(e);
          },
        },
      ],
      redact: traceContextTransform({ getActiveSpan: () => span }),
    });

    logger.log({ action: 'auth.login.succeeded', outcome: 'success' });

    expect(events[0]?.metadata).toEqual({ traceId: 't-1', spanId: 's-1' });
  });

  // Regression (MEDIUM): a throwing getActiveSpan()/spanContext() used to
  // propagate straight out of the returned function. That's tolerable for
  // an ordinary sink (AuditLogger isolates each sink's own failure), but
  // catastrophic for this function specifically, since it's meant to be
  // used as `redact` — and AuditLogger.log() treats a throwing `redact` as
  // a reason to drop the *entire* event, not just skip trace-context
  // enrichment. A malformed or version-incompatible span (this module only
  // knows OtelSpanLike's shape, not that any given implementation actually
  // honors it) used to silently take out every audit event for the rest of
  // that trace, for sinks that have nothing to do with OpenTelemetry at
  // all. Must now degrade to a no-op passthrough, the same as "no active
  // span at all".
  describe('degrades to a no-op on a throwing span (does not drop the event)', () => {
    it('when getActiveSpan() itself throws', () => {
      const transform = traceContextTransform({
        getActiveSpan: () => {
          throw new Error('tracer not initialized');
        },
      });
      const event = fakeEvent();

      expect(() => transform(event)).not.toThrow();
      expect(transform(event)).toBe(event);
    });

    it('when span.spanContext() throws', () => {
      const brokenSpan: OtelSpanLike = {
        ...fakeSpan(),
        spanContext: vi.fn(() => {
          throw new Error('span already ended');
        }),
      };
      const transform = traceContextTransform({ getActiveSpan: () => brokenSpan });
      const event = fakeEvent();

      expect(() => transform(event)).not.toThrow();
      expect(transform(event)).toBe(event);
    });

    it('as AuditLoggerOptions.redact: a throwing span degrades to logging the unenriched event, not dropping it', () => {
      const events: AuditEvent[] = [];
      const onSinkError = vi.fn();
      const logger = new AuditLogger({
        sinks: [
          {
            write: (e) => {
              events.push(e);
            },
          },
        ],
        onSinkError,
        redact: traceContextTransform({
          getActiveSpan: () => {
            throw new Error('tracer not initialized');
          },
        }),
      });

      logger.log({ action: 'auth.login.succeeded', outcome: 'success' });

      expect(events).toHaveLength(1);
      expect(events[0]?.metadata).toBeUndefined();
      expect(onSinkError).not.toHaveBeenCalled();
    });
  });
});
