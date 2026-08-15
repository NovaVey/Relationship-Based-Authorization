import { createContext, runInContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuditSinkError } from '../../src/errors.js';
import { AuditLogger } from '../../src/audit/logger.js';
import { InMemoryAuditSink } from '../../src/audit/sinks.js';
import type { AuditEvent, AuditSink } from '../../src/audit/types.js';
import { runWithTenant } from '../../src/tenant/context.js';

/** A sink whose `write` always throws synchronously. */
class ThrowingSink implements AuditSink {
  write(): void {
    throw new Error('synchronous sink failure');
  }
}

/** A sink whose `write` returns a promise that always rejects. */
class RejectingSink implements AuditSink {
  write(): Promise<void> {
    return Promise.reject(new Error('async sink failure'));
  }
}

describe('AuditLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fills in timestamp automatically as an ISO-8601 string', () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger({ sinks: [sink] });

    logger.log({ action: 'auth.login.succeeded', outcome: 'success' });

    expect(sink.events).toHaveLength(1);
    const [event] = sink.events;
    expect(event?.timestamp).toEqual(expect.any(String));
    expect(new Date(event!.timestamp).toISOString()).toBe(event!.timestamp);
  });

  it('falls back to the active tenant context for tenantId when not explicitly provided', () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger({ sinks: [sink] });

    runWithTenant({ tenantId: 'acme' }, () => {
      logger.log({ action: 'auth.login.succeeded', outcome: 'success' });
    });

    expect(sink.events[0]?.tenantId).toBe('acme');
  });

  it('leaves tenantId undefined when neither an explicit value nor an ambient context is available', () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger({ sinks: [sink] });

    logger.log({ action: 'auth.login.succeeded', outcome: 'success' });

    expect(sink.events[0]?.tenantId).toBeUndefined();
  });

  it('prefers an explicit tenantId on the event over the ambient tenant context', () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger({ sinks: [sink] });

    runWithTenant({ tenantId: 'acme' }, () => {
      logger.log({ action: 'auth.login.succeeded', outcome: 'success', tenantId: 'globex' });
    });

    expect(sink.events[0]?.tenantId).toBe('globex');
  });

  it('applies redact to the event before it reaches any sink', () => {
    const sink = new InMemoryAuditSink();
    const redact = vi.fn((event: AuditEvent): AuditEvent => ({
      ...event,
      metadata: { redacted: true },
    }));
    const logger = new AuditLogger({ sinks: [sink], redact });

    logger.log({
      action: 'auth.login.succeeded',
      outcome: 'success',
      metadata: { password: 'hunter2' },
    });

    expect(redact).toHaveBeenCalledTimes(1);
    expect(sink.events[0]?.metadata).toEqual({ redacted: true });
  });

  // Regression: log()'s own JSDoc (and this class's top-level JSDoc)
  // promise it "never throws" — but the redact call used to be the one
  // unprotected step in the pipeline, unlike every sink write. A throwing
  // redact must not escape log(), and — since redact's entire purpose is
  // stripping secrets/PII before a sink sees the event — must not fall
  // back to delivering the unredacted event either; it should be reported
  // and dropped.
  it('does not throw when redact itself throws, and does not deliver the unredacted event to any sink', () => {
    const onSinkError = vi.fn();
    const sink = new InMemoryAuditSink();
    const boom = new Error('redact blew up');
    const logger = new AuditLogger({
      sinks: [sink],
      onSinkError,
      redact: () => {
        throw boom;
      },
    });

    expect(() => {
      logger.log({
        action: 'auth.login.succeeded',
        outcome: 'success',
        metadata: { password: 'hunter2' },
      });
    }).not.toThrow();

    expect(sink.events).toHaveLength(0);
    expect(onSinkError).toHaveBeenCalledTimes(1);
    const [error] = onSinkError.mock.calls[0] as [AuditSinkError];
    expect(error).toBeInstanceOf(AuditSinkError);
    expect(error.sinkName).toBe('redact');
    expect(error.cause).toBe(boom);
  });

  it('does not throw out of log() even if onSinkError itself throws in response to a redact failure', () => {
    const logger = new AuditLogger({
      sinks: [new InMemoryAuditSink()],
      onSinkError: () => {
        throw new Error('onSinkError blew up too');
      },
      redact: () => {
        throw new Error('redact blew up');
      },
    });

    expect(() => {
      logger.log({ action: 'auth.login.succeeded', outcome: 'success' });
    }).not.toThrow();
  });

  it('writes the same event to every configured sink', () => {
    const sinkA = new InMemoryAuditSink();
    const sinkB = new InMemoryAuditSink();
    const logger = new AuditLogger({ sinks: [sinkA, sinkB] });

    logger.log({ action: 'auth.login.succeeded', outcome: 'success' });

    expect(sinkA.events).toHaveLength(1);
    expect(sinkB.events).toHaveLength(1);
    expect(sinkA.events[0]).toEqual(sinkB.events[0]);
  });

  it('calls onSinkError (wrapping in AuditSinkError) and does not throw when a sink throws synchronously, without stopping other sinks', () => {
    const onSinkError = vi.fn();
    const goodSink = new InMemoryAuditSink();
    const logger = new AuditLogger({
      sinks: [new ThrowingSink(), goodSink],
      onSinkError,
    });

    expect(() => {
      logger.log({ action: 'auth.login.succeeded', outcome: 'success' });
    }).not.toThrow();

    expect(goodSink.events).toHaveLength(1);
    expect(onSinkError).toHaveBeenCalledTimes(1);
    const [error] = onSinkError.mock.calls[0] as [AuditSinkError];
    expect(error).toBeInstanceOf(AuditSinkError);
    expect(error.sinkName).toBe('ThrowingSink');
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe('synchronous sink failure');
  });

  it('calls onSinkError (wrapping in AuditSinkError) and does not throw when a sink rejects asynchronously, without stopping other sinks', async () => {
    const onSinkError = vi.fn();
    const goodSink = new InMemoryAuditSink();
    const logger = new AuditLogger({
      sinks: [new RejectingSink(), goodSink],
      onSinkError,
    });

    expect(() => {
      logger.log({ action: 'auth.login.succeeded', outcome: 'success' });
    }).not.toThrow();

    expect(goodSink.events).toHaveLength(1);

    // The rejection is handled asynchronously; give the microtask queue a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onSinkError).toHaveBeenCalledTimes(1);
    const [error] = onSinkError.mock.calls[0] as [AuditSinkError];
    expect(error).toBeInstanceOf(AuditSinkError);
    expect(error.sinkName).toBe('RejectingSink');
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe('async sink failure');
  });

  // Regression (HIGH): writeToSink's error-handling path used to read
  // `sink.constructor.name` unconditionally to build the AuditSinkError's
  // sinkName. AuditSink is a structural interface — a valid implementation
  // doesn't have to be a real `class` instance — so a sink built via
  // `Object.create(null)` has no `.constructor` at all, and that access
  // threw a *second*, unhandled TypeError. For a synchronously-throwing
  // sink that escaped straight out of log(), directly contradicting its
  // "never throws" guarantee; for an asynchronously-rejecting sink it
  // became an unhandled promise rejection, which crashes the whole Node
  // process by default (verified with a real `node -e` invocation of the
  // built package before this fix, in the audit that found this).
  it('does not throw when a synchronously-throwing sink has no .constructor (e.g. Object.create(null))', () => {
    const onSinkError = vi.fn();
    const protoLessSink: AuditSink = Object.assign(Object.create(null), {
      write: () => {
        throw new Error('boom from a proto-less sink');
      },
    });
    const logger = new AuditLogger({ sinks: [protoLessSink], onSinkError });

    expect(() => {
      logger.log({ action: 'auth.login.succeeded', outcome: 'success' });
    }).not.toThrow();

    expect(onSinkError).toHaveBeenCalledTimes(1);
    const [error] = onSinkError.mock.calls[0] as [AuditSinkError];
    expect(error).toBeInstanceOf(AuditSinkError);
    expect(error.sinkName).toBe('sink'); // no real class name available — falls back, doesn't throw
  });

  it('does not throw and still reports via onSinkError when an asynchronously-rejecting sink has no .constructor', async () => {
    const onSinkError = vi.fn();
    const protoLessSink: AuditSink = Object.assign(Object.create(null), {
      write: () => Promise.reject(new Error('async boom from a proto-less sink')),
    });
    const logger = new AuditLogger({ sinks: [protoLessSink], onSinkError });

    expect(() => {
      logger.log({ action: 'auth.login.succeeded', outcome: 'success' });
    }).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onSinkError).toHaveBeenCalledTimes(1);
    const [error] = onSinkError.mock.calls[0] as [AuditSinkError];
    expect(error).toBeInstanceOf(AuditSinkError);
    expect(error.sinkName).toBe('sink');
  });

  // Regression (LOW): writeToSink used `result instanceof Promise` to
  // decide whether to await/catch a sink's return value — but `Promise`
  // bindings are per-realm, so a genuine, spec-compliant thenable from a
  // *different* realm (here, a real node:vm context — historically also an
  // iframe/Worker in a browser-like environment) fails `instanceof Promise`
  // in this realm even though it's a real promise. That used to make
  // writeToSink treat the rejecting thenable as a synchronous return value
  // — onSinkError never fired, and the rejection still surfaced as a
  // genuinely unhandled rejection (able to crash the process), defeating
  // the entire point of this method. Fixed by duck-typing on `.then`
  // instead of `instanceof Promise`.
  it('reports a cross-realm promise rejection via onSinkError instead of missing it entirely', async () => {
    const onSinkError = vi.fn();
    const crossRealmRejectingSink: AuditSink = {
      write: () => {
        const ctx = createContext({});
        return runInContext(
          'Promise.reject(new Error("cross-realm sink failure"))',
          ctx,
        ) as Promise<void>;
      },
    };
    const logger = new AuditLogger({ sinks: [crossRealmRejectingSink], onSinkError });

    expect(() => {
      logger.log({ action: 'auth.login.succeeded', outcome: 'success' });
    }).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onSinkError).toHaveBeenCalledTimes(1);
    const [error] = onSinkError.mock.calls[0] as [AuditSinkError];
    expect(error).toBeInstanceOf(AuditSinkError);
    // Not `error.cause instanceof Error` — the cross-realm Error instance
    // fails that check for the exact same per-realm-binding reason, even
    // once correctly caught. Reading `.message` is realm-agnostic.
    expect((error.cause as Error).message).toBe('cross-realm sink failure');
  });

  it('does not throw when a bare null/undefined entry reaches the sinks array', () => {
    const onSinkError = vi.fn();
    const goodSink = new InMemoryAuditSink();
    // Simulates a real-world mistake: a conditional-sink expression (e.g.
    // `featureFlag ? someSink : undefined`) evaluating to `undefined` and
    // ending up in the array, rather than being filtered out.
    const logger = new AuditLogger({
      sinks: [null as unknown as AuditSink, goodSink],
      onSinkError,
    });

    expect(() => {
      logger.log({ action: 'auth.login.succeeded', outcome: 'success' });
    }).not.toThrow();

    expect(goodSink.events).toHaveLength(1); // the other sink is unaffected
    expect(onSinkError).toHaveBeenCalledTimes(1);
    const [error] = onSinkError.mock.calls[0] as [AuditSinkError];
    expect(error.sinkName).toBe('sink');
  });

  it('defaults onSinkError to console.error when not provided', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logger = new AuditLogger({ sinks: [new ThrowingSink()] });

    logger.log({ action: 'auth.login.succeeded', outcome: 'success' });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0]?.[0]).toBeInstanceOf(AuditSinkError);
  });

  it('does not throw out of log() even if a caller-provided onSinkError itself throws', () => {
    const logger = new AuditLogger({
      sinks: [new ThrowingSink()],
      onSinkError: () => {
        throw new Error('onSinkError blew up too');
      },
    });

    expect(() => {
      logger.log({ action: 'auth.login.succeeded', outcome: 'success' });
    }).not.toThrow();
  });

  describe('child()', () => {
    it('merges defaults underneath fields the call does not override', () => {
      const sink = new InMemoryAuditSink();
      const logger = new AuditLogger({ sinks: [sink] });
      const child = logger.child({ actorId: 'service-account-1' });

      child.log({ action: 'auth.login.succeeded', outcome: 'success' });

      expect(sink.events[0]?.actorId).toBe('service-account-1');
    });

    it('lets an explicit field on the call win over a child default', () => {
      const sink = new InMemoryAuditSink();
      const logger = new AuditLogger({ sinks: [sink] });
      const child = logger.child({ actorId: 'service-account-1' });

      child.log({ action: 'auth.login.succeeded', outcome: 'success', actorId: 'user-42' });

      expect(sink.events[0]?.actorId).toBe('user-42');
    });

    it('returns a distinct AuditLogger instance that shares sinks with the parent', () => {
      const sink = new InMemoryAuditSink();
      const logger = new AuditLogger({ sinks: [sink] });
      const child = logger.child({ actorId: 'service-account-1' });

      expect(child).toBeInstanceOf(AuditLogger);
      expect(child).not.toBe(logger);

      logger.log({ action: 'parent-event', outcome: 'success' });
      child.log({ action: 'child-event', outcome: 'success' });

      expect(sink.events.map((event) => event.action)).toEqual(['parent-event', 'child-event']);
    });

    it('propagates onSinkError and redact from the parent to the child', () => {
      const onSinkError = vi.fn();
      const redact = vi.fn((event: AuditEvent): AuditEvent => event);
      const logger = new AuditLogger({ sinks: [new ThrowingSink()], onSinkError, redact });
      const child = logger.child({ actorId: 'service-account-1' });

      child.log({ action: 'auth.login.succeeded', outcome: 'success' });

      expect(onSinkError).toHaveBeenCalledTimes(1);
      expect(redact).toHaveBeenCalledTimes(1);
    });

    it('lets a grandchild layer its own defaults on top of the child’s', () => {
      const sink = new InMemoryAuditSink();
      const logger = new AuditLogger({ sinks: [sink] });
      const child = logger.child({ actorId: 'service-account-1', targetId: 'default-target' });
      const grandchild = child.child({ actorId: 'more-specific-actor' });

      grandchild.log({ action: 'auth.login.succeeded', outcome: 'success' });

      expect(sink.events[0]).toMatchObject({
        actorId: 'more-specific-actor',
        targetId: 'default-target',
      });
    });
  });
});
