/**
 * `GET /watch` (`src/api/server.ts`, D-174) against a real, ephemeral
 * Postgres, through the real Fastify HTTP surface — no mocks. Real schema
 * publishes, real `writeTuple`/`deleteTuple` calls, real DB-backed scoped
 * API keys (`src/api/db-api-keys.ts`), and a real live poll loop reading
 * real `write_log` rows.
 *
 * **Why this file needs one thing no other `*.integration.test.ts` file in
 * this repo does: a way to manually end an injected connection.**
 * `app.inject({ payloadAsStream: true })` (`light-my-request`) resolves
 * almost immediately and hands back a real, incrementally-readable
 * `Readable` (confirmed live before writing this file: a handler that
 * writes several chunks on a timer, streamed via `reply.hijack()` +
 * `reply.raw`, delivers them to `res.stream()` over real time, not
 * accumulated into one final payload). But `/watch`'s own per-connection
 * loop only exits once `request.raw` fires a real `'close'` event
 * (`src/api/server.ts`'s own `request.raw.once('close', ...)`) — and
 * confirmed live, separately, that a *simulated* injected request/response
 * pair never fires that event on its own, even when the client-side stream
 * is destroyed (a real difference from a genuine socket, which does).
 * Left alone, every `/watch` connection this file opens would loop
 * forever in the background, polling `write_log` on every tick even after
 * its own test finished — a real resource leak across this whole file,
 * not a cosmetic one.
 *
 * The fix, `openWatch`'s own returned `close()` below: `res.raw.res.req` is, confirmed
 * live via `===`, the exact same object instance `request.raw` refers to
 * inside the route handler — so manually calling `.emit('close')` on it
 * flips the same flag the handler's own listener sets, letting its loop
 * exit and its `finally` block run (decrementing `openWatchConnections`,
 * clearing its heartbeat timer) exactly as it would for a real disconnect.
 * Every test in this file that opens a `/watch` connection closes it this
 * way before finishing, precisely to avoid that leak.
 *
 * `env.WATCH_POLL_INTERVAL_MS` is lowered for this whole file (restored in
 * `afterAll`) so catch-up-to-live transitions and post-close cleanup don't
 * each cost a real `WATCH_POLL_INTERVAL_MS`-sized wait at its production
 * default.
 *
 * One test, in its own final describe block, goes further still: it calls
 * `app.listen()` on this same `app` instance — the one deliberate
 * exception, in this whole repo, to `buildServer`'s own doc comment ("does
 * NOT call `app.listen()`"). The manual-`'close'`-emit workaround above
 * proves the *rest* of `/watch`'s cleanup works once `'close'` fires; it
 * cannot prove `'close'` would ever genuinely fire for a real client — see
 * that block's own doc comment for why a real socket is what that
 * specifically needs.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../../src/api/server.js';
import { runMigrations } from '../../../src/store/migrate.js';
import { writeTuple, deleteTuple } from '../../../src/store/tuples.js';
import { createApiKey } from '../../../src/api/db-api-keys.js';
import { decodeToken } from '../../../src/store/tokens.js';
import { env } from '../../../src/config/env.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));
const ADMIN_KEY = 'watch-integration-test-admin-key';
const ORIGINAL_ADMIN_API_KEY = env.ADMIN_API_KEY;
const ORIGINAL_WATCH_POLL_INTERVAL_MS = env.WATCH_POLL_INTERVAL_MS;
const ORIGINAL_WATCH_MAX_CONNECTIONS = env.WATCH_MAX_CONNECTIONS;
const ORIGINAL_WATCH_HEARTBEAT_INTERVAL_MS = env.WATCH_HEARTBEAT_INTERVAL_MS;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on('error', (err) => {
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);
  env.ADMIN_API_KEY = ADMIN_KEY;
  // Fast catch-up/cleanup ticks for this file's own tests — production's
  // own default (250ms) would make every catch-up-to-live transition and
  // every post-close cleanup cost a real quarter-second for no benefit
  // here.
  env.WATCH_POLL_INTERVAL_MS = 20;
  app = await buildServer(pool, { logger: false });
}, 120_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
  env.ADMIN_API_KEY = ORIGINAL_ADMIN_API_KEY;
  env.WATCH_POLL_INTERVAL_MS = ORIGINAL_WATCH_POLL_INTERVAL_MS;
  env.WATCH_MAX_CONNECTIONS = ORIGINAL_WATCH_MAX_CONNECTIONS;
  env.WATCH_HEARTBEAT_INTERVAL_MS = ORIGINAL_WATCH_HEARTBEAT_INTERVAL_MS;
});

let uniqueCounter = 0;
const processSalt = Math.random().toString(36).slice(2, 10);
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
}

function authHeaders(key = ADMIN_KEY): { authorization: string } {
  return { authorization: `Bearer ${key}` };
}

async function publishNamespace(ns: string, relation = 'viewer'): Promise<void> {
  const source = [`namespace ${ns} {`, `  relation ${relation}: user`, '}'].join('\n');
  const res = await app.inject({
    method: 'POST',
    url: '/schema/publish',
    payload: { source },
    headers: authHeaders(),
  });
  expect(res.statusCode).toBe(200);
}

interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** Parses one complete, `\n\n`-terminated SSE block into its named fields. */
function parseSseBlock(block: string): SseFrame {
  const frame: SseFrame = {};
  for (const line of block.split('\n')) {
    if (line.startsWith('id: ')) frame.id = line.slice(4);
    else if (line.startsWith('event: ')) frame.event = line.slice(7);
    else if (line.startsWith('data: ')) frame.data = line.slice(6);
    else if (line.startsWith(':')) frame.comment = line.slice(1).trim();
  }
  return frame;
}

/** Accumulates raw stream chunks across calls, yielding only complete (`\n\n`-terminated) frames — chunk boundaries never align with frame boundaries, so this can't just parse each chunk in isolation. */
function makeSseCollector(): { push: (chunk: string) => void; frames: SseFrame[] } {
  let buffer = '';
  const frames: SseFrame[] = [];
  return {
    push(chunk: string) {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (block.trim() !== '') frames.push(parseSseBlock(block));
      }
    },
    frames,
  };
}

interface WatchTupleData {
  objectNs: string;
  objectId: string;
  relation: string;
  subjectNs: string;
  subjectId: string;
  subjectRelation?: string;
  expiresAt?: string;
}

/** The shape `watchEventFrame` (`src/api/responses.ts`) serializes into every real `data:` line. */
interface WatchEventData {
  token: string;
  tuple: WatchTupleData;
  writtenAt: string;
}

/** The shape `watchConnectedFrame` (`src/api/responses.ts`) serializes into the one synthetic `event: connected` frame. */
interface WatchConnectedData {
  since: string;
}

function parseEventData(frame: SseFrame): WatchEventData {
  return JSON.parse(frame.data!) as WatchEventData;
}

function parseConnectedData(frame: SseFrame): WatchConnectedData {
  return JSON.parse(frame.data ?? '{}') as WatchConnectedData;
}

async function waitForFrameCount(
  frames: SseFrame[],
  count: number,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (frames.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out waiting for ${count} SSE frame(s); got ${frames.length}: ${JSON.stringify(frames)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface WatchConnection {
  statusCode: number;
  frames: SseFrame[];
  /** See this file's own top-of-file doc comment for why this is necessary at all, and why it's safe. */
  close: () => Promise<void>;
}

async function openWatch(url: string, key = ADMIN_KEY): Promise<WatchConnection> {
  const res = await app.inject({
    method: 'GET',
    url,
    headers: authHeaders(key),
    payloadAsStream: true,
  });
  const collector = makeSseCollector();
  if (res.statusCode === 200) {
    const stream = res.stream();
    stream.on('data', (chunk: Buffer) => collector.push(chunk.toString('utf8')));
  }
  let closed = false;
  return {
    statusCode: res.statusCode,
    frames: collector.frames,
    async close() {
      if (closed || res.statusCode !== 200) return;
      closed = true;
      const rawReq = (res.raw as unknown as { res: { req: { emit: (event: string) => void } } }).res
        .req;
      rawReq.emit('close');
      // One full poll tick plus headroom for the handler's own `finally`
      // block to actually run before the next test relies on
      // `openWatchConnections` having already decremented.
      await new Promise((resolve) => setTimeout(resolve, env.WATCH_POLL_INTERVAL_MS + 30));
    },
  };
}

describe('GET /watch — the connected frame and basic live delivery', () => {
  it('the-first-frame-is-always-a-connected-event-echoing-the-effective-starting-token', async () => {
    const ns = uniqueName('doc');
    await publishNamespace(ns);
    const conn = await openWatch(`/watch?namespace=${ns}`);
    try {
      expect(conn.statusCode).toBe(200);
      await waitForFrameCount(conn.frames, 1);
      expect(conn.frames[0]?.event).toBe('connected');
      const data = parseConnectedData(conn.frames[0]!);
      expect(typeof data.since).toBe('string');
      expect(() => decodeToken(data.since)).not.toThrow();
    } finally {
      await conn.close();
    }
  });

  it('a-write-made-after-connecting-arrives-live-as-an-event-write-frame-with-the-real-tuple-and-a-decodable-token', async () => {
    const ns = uniqueName('doc');
    await publishNamespace(ns);
    const conn = await openWatch(`/watch?namespace=${ns}`);
    try {
      await waitForFrameCount(conn.frames, 1); // the connected frame

      const objectId = uniqueName('obj');
      const result = await writeTuple(pool, {
        objectNs: ns,
        objectId,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      await waitForFrameCount(conn.frames, 2);
      const frame = conn.frames[1]!;
      expect(frame.event).toBe('write');
      expect(decodeToken(frame.id!)).toBe(result.token);
      const data = parseEventData(frame);
      expect(decodeToken(data.token)).toBe(result.token);
      expect(data.tuple).toMatchObject({
        objectNs: ns,
        objectId,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      });
      expect(typeof data.writtenAt).toBe('string');
    } finally {
      await conn.close();
    }
  });

  it('a-delete-arrives-live-as-an-event-delete-frame', async () => {
    const ns = uniqueName('doc');
    await publishNamespace(ns);
    const objectId = uniqueName('obj');
    const written = await writeTuple(pool, {
      objectNs: ns,
      objectId,
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    const conn = await openWatch(`/watch?namespace=${ns}`);
    try {
      await waitForFrameCount(conn.frames, 1);
      const deleted = await deleteTuple(pool, {
        objectNs: ns,
        objectId,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      });
      expect(deleted.ok).toBe(true);
      if (!deleted.ok) return;
      await waitForFrameCount(conn.frames, 2);
      expect(conn.frames[1]?.event).toBe('delete');
    } finally {
      await conn.close();
    }
  });

  it('multiple-live-writes-arrive-in-real-commit-order', async () => {
    const ns = uniqueName('doc');
    await publishNamespace(ns);
    const conn = await openWatch(`/watch?namespace=${ns}`);
    try {
      await waitForFrameCount(conn.frames, 1);
      const ids = [uniqueName('a'), uniqueName('b'), uniqueName('c')];
      for (const objectId of ids) {
        const result = await writeTuple(pool, {
          objectNs: ns,
          objectId,
          relation: 'viewer',
          subjectNs: 'user',
          subjectId: 'alice',
        });
        expect(result.ok).toBe(true);
      }
      await waitForFrameCount(conn.frames, 4);
      const delivered = conn.frames.slice(1).map((f) => parseEventData(f).tuple.objectId);
      expect(delivered).toEqual(ids);
    } finally {
      await conn.close();
    }
  });
});

describe('GET /watch — ?since catch-up', () => {
  it('reconnecting-with-since-replays-exactly-what-happened-while-disconnected-in-order', async () => {
    const ns = uniqueName('doc');
    await publishNamespace(ns);

    const first = await openWatch(`/watch?namespace=${ns}`);
    await waitForFrameCount(first.frames, 1);
    const sinceToken = parseConnectedData(first.frames[0]!).since;
    await first.close();

    const missedIds = [uniqueName('missed_a'), uniqueName('missed_b')];
    for (const objectId of missedIds) {
      const result = await writeTuple(pool, {
        objectNs: ns,
        objectId,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      });
      expect(result.ok).toBe(true);
    }

    const resumed = await openWatch(`/watch?namespace=${ns}&since=${sinceToken}`);
    try {
      // connected frame + the two missed writes, replayed in order.
      await waitForFrameCount(resumed.frames, 3);
      expect(resumed.frames[0]?.event).toBe('connected');
      const replayed = resumed.frames.slice(1).map((f) => parseEventData(f).tuple.objectId);
      expect(replayed).toEqual(missedIds);
    } finally {
      await resumed.close();
    }
  });

  it('a-malformed-since-is-a-400-invalid-request-not-a-hijacked-connection', async () => {
    const ns = uniqueName('doc');
    await publishNamespace(ns);
    const res = await app.inject({
      method: 'GET',
      url: `/watch?namespace=${ns}&since=not-a-real-token`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('invalid_request');
  });
});

describe('GET /watch — namespace scope and auth, mirroring /list-objects and /metrics', () => {
  it('a-scoped-key-watching-its-own-namespace-only-sees-that-namespace', async () => {
    const inScopeNs = uniqueName('doc');
    const outOfScopeNs = uniqueName('doc');
    await publishNamespace(inScopeNs);
    await publishNamespace(outOfScopeNs);
    const { rawKey } = await createApiKey(pool, {
      name: uniqueName('scoped-watch-key'),
      role: 'admin',
      scopes: [inScopeNs],
    });

    const conn = await openWatch(`/watch?namespace=${inScopeNs}`, rawKey);
    try {
      expect(conn.statusCode).toBe(200);
      await waitForFrameCount(conn.frames, 1);

      const outOfScopeWrite = await writeTuple(pool, {
        objectNs: outOfScopeNs,
        objectId: uniqueName('obj'),
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      });
      expect(outOfScopeWrite.ok).toBe(true);
      const inScopeObjectId = uniqueName('obj');
      const inScopeWrite = await writeTuple(pool, {
        objectNs: inScopeNs,
        objectId: inScopeObjectId,
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      });
      expect(inScopeWrite.ok).toBe(true);

      await waitForFrameCount(conn.frames, 2);
      // Give a would-be leak of the out-of-scope write a real chance to
      // show up before asserting there is exactly one real event frame.
      await new Promise((resolve) => setTimeout(resolve, env.WATCH_POLL_INTERVAL_MS * 3));
      expect(conn.frames).toHaveLength(2);
      expect(parseEventData(conn.frames[1]!).tuple.objectId).toBe(inScopeObjectId);
    } finally {
      await conn.close();
    }
  });

  it('a-scoped-key-watching-an-out-of-scope-namespace-gets-403-forbidden', async () => {
    const ownNs = uniqueName('doc');
    const otherNs = uniqueName('doc');
    await publishNamespace(ownNs);
    await publishNamespace(otherNs);
    const { rawKey } = await createApiKey(pool, {
      name: uniqueName('scoped-watch-key-403'),
      role: 'readonly',
      scopes: [ownNs],
    });
    const res = await app.inject({
      method: 'GET',
      url: `/watch?namespace=${otherNs}`,
      headers: authHeaders(rawKey),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error.code).toBe('forbidden');
  });

  it('a-scoped-key-omitting-namespace-entirely-gets-403-forbidden-mirroring-metrics', async () => {
    const ns = uniqueName('doc');
    await publishNamespace(ns);
    const { rawKey } = await createApiKey(pool, {
      name: uniqueName('scoped-watch-key-no-ns'),
      role: 'readonly',
      scopes: [ns],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/watch',
      headers: authHeaders(rawKey),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error.code).toBe('forbidden');
  });

  it('an-unscoped-admin-key-may-omit-namespace-and-see-writes-across-namespaces', async () => {
    const nsA = uniqueName('doc');
    const nsB = uniqueName('doc');
    await publishNamespace(nsA);
    await publishNamespace(nsB);
    const conn = await openWatch('/watch');
    try {
      await waitForFrameCount(conn.frames, 1);
      const a = await writeTuple(pool, {
        objectNs: nsA,
        objectId: uniqueName('obj'),
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      });
      const b = await writeTuple(pool, {
        objectNs: nsB,
        objectId: uniqueName('obj'),
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: 'alice',
      });
      expect(a.ok && b.ok).toBe(true);
      await waitForFrameCount(conn.frames, 3);
      const namespacesSeen = conn.frames.slice(1).map((f) => parseEventData(f).tuple.objectNs);
      expect(namespacesSeen).toEqual([nsA, nsB]);
    } finally {
      await conn.close();
    }
  });

  it('an-unauthenticated-watch-attempt-is-rejected-401-before-ever-hijacking-the-response', async () => {
    const ns = uniqueName('doc');
    await publishNamespace(ns);
    const res = await app.inject({ method: 'GET', url: `/watch?namespace=${ns}` });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).error.code).toBe('unauthorized');
  });
});

describe('GET /watch — WATCH_MAX_CONNECTIONS', () => {
  it('the-n-plus-first-concurrent-connection-gets-503-and-a-freed-slot-lets-the-next-one-through', async () => {
    const ns = uniqueName('doc');
    await publishNamespace(ns);
    const original = env.WATCH_MAX_CONNECTIONS;
    env.WATCH_MAX_CONNECTIONS = 1;
    try {
      const first = await openWatch(`/watch?namespace=${ns}`);
      expect(first.statusCode).toBe(200);

      const secondRes = await app.inject({
        method: 'GET',
        url: `/watch?namespace=${ns}`,
        headers: authHeaders(),
      });
      expect(secondRes.statusCode).toBe(503);
      expect(JSON.parse(secondRes.payload).error.code).toBe('infrastructure_unavailable');

      await first.close();

      const third = await openWatch(`/watch?namespace=${ns}`);
      try {
        expect(third.statusCode).toBe(200);
      } finally {
        await third.close();
      }
    } finally {
      env.WATCH_MAX_CONNECTIONS = original;
    }
  });
});

describe('GET /watch — heartbeat', () => {
  it('an-idle-connection-with-no-real-events-still-receives-a-heartbeat-comment', async () => {
    const ns = uniqueName('doc');
    await publishNamespace(ns);
    const original = env.WATCH_HEARTBEAT_INTERVAL_MS;
    env.WATCH_HEARTBEAT_INTERVAL_MS = 30;
    try {
      const conn = await openWatch(`/watch?namespace=${ns}`);
      try {
        await waitForFrameCount(conn.frames, 1); // connected
        await waitForFrameCount(conn.frames, 2); // the heartbeat
        expect(conn.frames[1]?.comment).toBe('heartbeat');
      } finally {
        await conn.close();
      }
    } finally {
      env.WATCH_HEARTBEAT_INTERVAL_MS = original;
    }
  });
});

describe('GET /watch — a real socket proves genuine client-disconnect detection', () => {
  /**
   * The one deliberate exception, in this whole repo, to `buildServer`'s
   * own doc comment ("does NOT call `app.listen()`") and to every other
   * `*.integration.test.ts` file's `app.inject()`-only convention.
   * Confirmed live, before writing this block: a *simulated* injected
   * request/response (`payloadAsStream: true`) never fires a real
   * `'close'` event on its own, even once the client-side stream is
   * destroyed — this file's own `openWatch`/`close()` above works around
   * exactly that gap by manually emitting `'close'` on the same object
   * instance. That workaround proves the *rest* of `/watch`'s own
   * disconnect-triggered cleanup works once `'close'` fires — it cannot
   * prove `'close'` itself would ever genuinely fire for a real client.
   * Proving that needs a real listening socket and a real client that can
   * actually hang up — a normal Node HTTP test technique (a real ephemeral
   * port, on this same `app` instance, closed by this file's own
   * `afterAll` `app.close()` like any other listener would be), not an
   * outward-facing action of any kind.
   *
   * Verified black-box, not by inspecting `server.ts`'s own private
   * `openWatchConnections` counter (nothing exports it, deliberately — see
   * that variable's own doc comment): `WATCH_MAX_CONNECTIONS` set to 1
   * makes a freed slot directly observable — a second real connection
   * only succeeds if the first one's real disconnect was actually
   * noticed and actually ran its cleanup.
   */
  it('a-real-clients-disconnect-frees-its-watch-max-connections-slot-for-the-next-real-connection', async () => {
    const ns = uniqueName('doc');
    await publishNamespace(ns);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('expected a real AddressInfo from a real listening socket');
    }
    const base = `http://127.0.0.1:${addr.port}`;

    const original = env.WATCH_MAX_CONNECTIONS;
    env.WATCH_MAX_CONNECTIONS = 1;
    try {
      const firstRes = await fetch(`${base}/watch?namespace=${ns}`, { headers: authHeaders() });
      expect(firstRes.status).toBe(200);
      const reader = firstRes.body!.getReader();
      // Confirm real bytes actually arrived — the connection is genuinely
      // open and hijacked, not merely accepted — before disconnecting it.
      const { value } = await reader.read();
      expect(value).toBeDefined();

      // The cap is genuinely enforced over this real socket too, not only
      // in the app.inject() path every other test in this file uses.
      const blockedRes = await fetch(`${base}/watch?namespace=${ns}`, { headers: authHeaders() });
      expect(blockedRes.status).toBe(503);
      await blockedRes.body?.cancel();

      // A real disconnect — canceling a real fetch reader tears down the
      // real underlying socket, unlike `stream.destroy()` against a
      // simulated `app.inject()` response (confirmed live that does not
      // propagate to the server's own `request.raw`).
      await reader.cancel();
      // The server's own loop notices on its next tick
      // (WATCH_POLL_INTERVAL_MS, lowered for this whole file) — give it a
      // real chance to run its cleanup before asserting the slot freed.
      await new Promise((resolve) => setTimeout(resolve, env.WATCH_POLL_INTERVAL_MS + 50));

      const thirdRes = await fetch(`${base}/watch?namespace=${ns}`, { headers: authHeaders() });
      expect(thirdRes.status).toBe(200);
      await thirdRes.body?.cancel();
    } finally {
      env.WATCH_MAX_CONNECTIONS = original;
    }
  });
});
