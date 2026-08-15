import { describe, expect, it, vi } from 'vitest';

import { callbackAuditSink, ConsoleAuditSink, InMemoryAuditSink } from '../../src/audit/sinks.js';
import type { AuditEvent } from '../../src/audit/types.js';

const makeEvent = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  action: 'auth.login.succeeded',
  outcome: 'success',
  timestamp: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('ConsoleAuditSink', () => {
  it('logs the event as a single valid JSON line via console.log', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sink = new ConsoleAuditSink();
    const event = makeEvent({ tenantId: 'acme', actorId: 'user-1', metadata: { ip: '1.2.3.4' } });

    sink.write(event);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const [line] = consoleSpy.mock.calls[0] as [string];
    expect(typeof line).toBe('string');
    expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(JSON.parse(line) as unknown).toEqual(event);

    consoleSpy.mockRestore();
  });

  it('emits one line per write call', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sink = new ConsoleAuditSink();

    sink.write(makeEvent({ action: 'first' }));
    sink.write(makeEvent({ action: 'second' }));

    expect(consoleSpy).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });
});

describe('InMemoryAuditSink', () => {
  it('starts empty', () => {
    const sink = new InMemoryAuditSink();
    expect(sink.events).toEqual([]);
  });

  it('accumulates every written event, in order', () => {
    const sink = new InMemoryAuditSink();
    const first = makeEvent({ action: 'first' });
    const second = makeEvent({ action: 'second' });

    sink.write(first);
    sink.write(second);

    expect(sink.events).toEqual([first, second]);
  });

  it('clear() empties the accumulated events', () => {
    const sink = new InMemoryAuditSink();
    sink.write(makeEvent());
    expect(sink.events.length).toBe(1);

    sink.clear();

    expect(sink.events).toEqual([]);
  });

  it('remains usable after clear()', () => {
    const sink = new InMemoryAuditSink();
    sink.write(makeEvent({ action: 'before-clear' }));
    sink.clear();
    sink.write(makeEvent({ action: 'after-clear' }));

    expect(sink.events).toEqual([makeEvent({ action: 'after-clear' })]);
  });
});

describe('callbackAuditSink', () => {
  it('delegates write() to the wrapped function', () => {
    const fn = vi.fn();
    const sink = callbackAuditSink(fn);
    const event = makeEvent();

    void sink.write(event);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(event);
  });

  it('passes through the wrapped function’s async return value', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const sink = callbackAuditSink(fn);

    const result = sink.write(makeEvent());

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });
});
