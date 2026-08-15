import { AuditSinkError } from '../errors.js';
import { getCurrentTenantId } from '../tenant/context.js';
import type { AuditEvent, AuditSink } from './types.js';

/**
 * What a caller provides to {@link AuditLogger.log}.
 *
 * Omits `timestamp` (always stamped by the logger, so callers can never
 * accidentally backdate or forget it) and re-declares `tenantId` as
 * optional-and-defaultable: when omitted, {@link AuditLogger.log} falls back
 * to {@link getCurrentTenantId}, so call sites inside a tenant-scoped
 * request don't need to thread the tenant id through manually.
 */
export type AuditEventInput = Omit<AuditEvent, 'timestamp' | 'tenantId'> & { tenantId?: string };

/** Configuration for an {@link AuditLogger}. */
export interface AuditLoggerOptions {
  /** Every sink this logger writes each event to. */
  sinks: AuditSink[];
  /**
   * Called when a sink fails to write an event (synchronous throw or
   * rejected promise), instead of throwing out of {@link AuditLogger.log}.
   * Defaults to `console.error(error)`. Wire this up to your own alerting
   * if audit-delivery failures need to page someone.
   */
  onSinkError?: (error: AuditSinkError) => void;
  /**
   * Optional transform applied to every event before it reaches any sink,
   * e.g. to strip secrets or PII out of `metadata`. Runs once per `log()`
   * call (not once per sink), so all sinks see the same redacted event.
   */
  redact?: (event: AuditEvent) => AuditEvent;
}

const defaultOnSinkError = (error: AuditSinkError): void => {
  console.error(error);
};

/**
 * Best-effort, never-throwing name for a sink, used only for error
 * reporting. `AuditSink` is a structural interface — a valid implementation
 * doesn't have to be built from a `class`, so `sink.constructor` isn't
 * guaranteed to exist (e.g. an object created via `Object.create(null)`),
 * and a bare `null`/`undefined` slipping into the `sinks` array is a real,
 * easy mistake (a conditional-sink expression evaluating to `undefined`).
 * This function runs from inside {@link AuditLogger.writeToSink}'s own
 * catch/rejection handlers — the exact place a second, unhandled throw
 * would defeat the whole point of catching the first one, so it must never
 * itself throw regardless of what `sink` turns out to be at runtime.
 */
function describeSink(sink: unknown): string {
  if (sink !== null && typeof sink === 'object') {
    const ctor = (sink as { constructor?: unknown }).constructor;
    if (typeof ctor === 'function' && typeof ctor.name === 'string' && ctor.name.length > 0) {
      return ctor.name;
    }
  }
  return 'sink';
}

/**
 * Duck-types "is this a promise" via `.then`, deliberately not `value
 * instanceof Promise` — see {@link AuditLogger.writeToSink} for why that
 * distinction matters (a cross-realm promise is a genuine thenable that
 * still fails `instanceof Promise` in the current realm).
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Fans a single audit event out to every configured {@link AuditSink}.
 *
 * The core guarantee this class exists to provide is isolation: a bug or
 * outage in one sink (a webhook timing out, a queue being unreachable) must
 * never prevent other sinks from receiving the event, and must never
 * propagate an exception back to whatever business logic called
 * {@link log} — audit logging is inherently best-effort side work, and a
 * failure in it should never take down the request it's describing.
 */
export class AuditLogger {
  private readonly sinks: readonly AuditSink[];
  private readonly onSinkError: (error: AuditSinkError) => void;
  private readonly redact: ((event: AuditEvent) => AuditEvent) | undefined;

  /**
   * Fields merged underneath every event passed to `log()`, set by
   * {@link child}. Not part of the public constructor contract — always
   * empty for loggers created directly via `new AuditLogger(options)`.
   */
  private readonly defaults: Partial<AuditEventInput>;

  /**
   * @param options Sinks, `onSinkError`, and `redact` — see {@link AuditLoggerOptions}.
   * @param defaults @internal Set by {@link child}; not part of the public
   * constructor contract. TypeScript has no real access-control mechanism
   * for a single constructor's own parameters short of a separate factory
   * function — this `@internal` tag (recognized by TypeDoc and similar
   * tooling) plus this doc comment are how that intent is communicated:
   * always empty for a logger created directly via `new AuditLogger(options)`.
   */
  constructor(options: AuditLoggerOptions, defaults: Partial<AuditEventInput> = {}) {
    this.sinks = options.sinks;
    this.onSinkError = options.onSinkError ?? defaultOnSinkError;
    this.redact = options.redact;
    this.defaults = defaults;
  }

  /**
   * Records one audit event.
   *
   * Resolution order for the fields this method fills in:
   *  - `timestamp` is always set to `new Date().toISOString()` at call time.
   *  - `tenantId` uses, in order: an explicit value on `event`, then this
   *    logger's `child()` defaults, then the ambient tenant context via
   *    {@link getCurrentTenantId}. It's left `undefined` if none apply —
   *    audit events outside any tenant context are still valid (e.g.
   *    platform-level actions).
   *
   * If `redact` was configured, it runs once on the fully-resolved event
   * before any sink sees it. Every sink then receives the same redacted
   * event; a sink that throws synchronously or returns a rejected promise
   * has its error wrapped in {@link AuditSinkError} and handed to
   * `onSinkError` — this method itself never throws and never returns a
   * rejected promise. A throwing `redact` gets the same treatment (also
   * reported via `onSinkError`), but the event is *not* written to any
   * sink in that case — falling back to the unredacted event would defeat
   * the entire purpose of configuring `redact` in the first place, so a
   * broken redact function fails closed (drops the event) rather than
   * open (leaks whatever it was supposed to strip).
   */
  log(event: AuditEventInput): void {
    const { tenantId: explicitTenantId, ...rest } = { ...this.defaults, ...event };
    const tenantId = explicitTenantId ?? getCurrentTenantId();
    const resolvedEvent: AuditEvent = {
      ...rest,
      timestamp: new Date().toISOString(),
      ...(tenantId !== undefined ? { tenantId } : {}),
    };

    let finalEvent: AuditEvent;
    if (this.redact) {
      try {
        finalEvent = this.redact(resolvedEvent);
      } catch (cause) {
        this.reportError('redact', cause);
        return;
      }
    } else {
      finalEvent = resolvedEvent;
    }

    for (const sink of this.sinks) {
      this.writeToSink(sink, finalEvent);
    }
  }

  /**
   * Returns a new `AuditLogger` sharing this logger's sinks, `onSinkError`,
   * and `redact`, whose `log()` merges `defaults` underneath each call's
   * own fields — explicit fields on a given `log()` call always win over
   * the child's defaults. Handy for a per-request logger that should always
   * stamp e.g. a fixed `actorId` without every call site repeating it.
   */
  child(defaults: Partial<AuditEventInput>): AuditLogger {
    return new AuditLogger(
      {
        sinks: [...this.sinks],
        onSinkError: this.onSinkError,
        ...(this.redact ? { redact: this.redact } : {}),
      },
      { ...this.defaults, ...defaults },
    );
  }

  /**
   * Writes to a single sink, converting any synchronous throw or promise
   * rejection into an `onSinkError` call rather than letting it escape.
   *
   * Detects "did `write` return a promise" via {@link isThenable} (duck
   * typing on `.then`) rather than `result instanceof Promise` — `Promise`
   * bindings are per-realm, so a value from a different realm (a `vm.Context`,
   * historically an iframe/Worker in a browser-like environment) that
   * rejects can be a completely genuine, spec-compliant thenable while
   * still failing `instanceof Promise` in *this* realm. `instanceof` would
   * silently treat that as a synchronous return value instead — the
   * rejection is then never awaited or caught by anything, `onSinkError`
   * never fires, and the rejection still surfaces as an unhandled
   * rejection (verified live via `node:vm`), defeating the entire point of
   * this method.
   */
  private writeToSink(sink: AuditSink, event: AuditEvent): void {
    try {
      const result: unknown = sink.write(event);
      if (isThenable(result)) {
        result.then(
          () => {
            // No-op: writeToSink only reports failures.
          },
          (cause: unknown) => {
            this.reportError(describeSink(sink), cause);
          },
        );
      }
    } catch (cause) {
      this.reportError(describeSink(sink), cause);
    }
  }

  /**
   * Reports a failure from either a sink's `write` (via {@link writeToSink})
   * or a throwing `redact` (via {@link log}) through `onSinkError`, wrapped
   * in an {@link AuditSinkError} named after whichever one failed —
   * `sourceName` is a real sink's class name for a sink failure, or the
   * literal string `'redact'` for a redact failure.
   */
  private reportError(sourceName: string, cause: unknown): void {
    const error = new AuditSinkError(sourceName, { cause });
    try {
      this.onSinkError(error);
    } catch {
      // A caller-provided onSinkError must never be able to break the
      // "log() never throws" guarantee either.
    }
  }
}
