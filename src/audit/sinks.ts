import type { AuditEvent, AuditSink } from './types.js';

/**
 * Writes each event as a single JSON line via `console.log`.
 *
 * One `JSON.stringify`d line per event (no pretty-printing) so output stays
 * machine-parseable by log collectors (e.g. anything that tails stdout and
 * expects one JSON object per line), which matters more for audit trails
 * than human readability at the point of emission.
 */
export class ConsoleAuditSink implements AuditSink {
  write(event: AuditEvent): void {
    console.log(JSON.stringify(event));
  }
}

/**
 * Accumulates events in memory instead of writing them anywhere durable.
 *
 * Intended for tests (assert on `events`) and short-lived debugging
 * sessions — it has no eviction, retention, or persistence, so it is not
 * appropriate for production audit trails, which should use a durable sink
 * (a file, database, or log pipeline) instead.
 */
export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  write(event: AuditEvent): void {
    this.events.push(event);
  }

  /** Empties the accumulated events, e.g. between test cases sharing one sink instance. */
  clear(): void {
    this.events.length = 0;
  }
}

/**
 * Wraps an arbitrary function as an {@link AuditSink}.
 *
 * Lets a caller plug in a one-off destination (a webhook POST, a queue
 * publish, a metrics increment) without declaring a whole class for it.
 */
export function callbackAuditSink(fn: (event: AuditEvent) => void | Promise<void>): AuditSink {
  return { write: fn };
}
