/**
 * This repo's own adapter — real HTTP calls against a running `authz
 * serve` instance (`POST /schema/publish`, `POST /tuples`, `POST /check`,
 * per README.md's own "API and CLI" table), never `performCheck` called
 * in-process. That distinction matters: `scripts/benchmark-check-depth.ts`
 * deliberately measures the in-process engine cost alone because network
 * transit is "a property of where a caller is calling from, not a
 * property of this engine" (that script's own doc comment) — but THIS
 * harness is comparing three engines' real, deployed APIs against each
 * other, so all three must pay the identical class of cost (HTTP round
 * trip to a localhost server), or the comparison silently favors
 * whichever adapter was measured closer to the metal. See
 * docs/BENCHMARK-PROPOSAL.md's "What's fair to compare" section.
 *
 * **A real, disclosed constraint this adapter has to work around:**
 * `POST /tuples` is rate-limited to 20 requests/minute by default
 * (README.md's own "API and CLI" table), a deliberate anti-abuse default
 * with no environment-variable override (`src/api/server.ts`'s
 * `writeRateLimit`, hardcoded) — confirmed live: even this harness's own
 * 22-tuple demo graph alone exceeds it. Neither OpenFGA nor SpiceDB's
 * default configuration imposes an equivalent write-throughput ceiling.
 * `writeTuple` below retries on a `429` using the real
 * `x-ratelimit-reset` response header (seconds until the window clears)
 * rather than failing the run — this makes a full run slow (real
 * wall-clock minutes, not an engine cost), which is exactly why
 * docs/BENCHMARK-PROPOSAL.md does NOT report tuple-write throughput as a
 * comparable metric at all: doing so here would measure this project's
 * own safety default against the other two engines' absence of one, not
 * the three check engines against each other.
 */
import type { CanonicalCheckQuery, CanonicalTuple, EngineAdapter } from '../types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_SCHEMA_PATH = path.resolve(moduleDir, '../../../../schema/example.authz');
// A plain tuple-to-userset chain (`parent: bench_node`), matching
// workloads/{openfga,spicedb}-*.{fga,zed}'s own identical shape — see
// src/workload.ts's `depthChainWorkload` doc comment for why this is a
// plain-pointer chain, not a nested-group-membership chain, across all
// three engines' depth-chain schemas.
const DEPTH_CHAIN_SCHEMA = `
namespace bench_node {
  relation viewer: user
  relation parent: bench_node
  permission view = viewer | parent->view
}
`;

export interface AuthzAdapterOptions {
  readonly baseUrl: string;
  readonly adminApiKey: string;
}

export class AuthzAdapter implements EngineAdapter {
  readonly name = 'authz' as const;
  private readonly baseUrl: string;
  private readonly adminApiKey: string;

  constructor(opts: AuthzAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.adminApiKey = opts.adminApiKey;
  }

  private async post(
    path: string,
    body: unknown,
  ): Promise<{ status: number; json: unknown; headers: Headers }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.adminApiKey}`,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => undefined);
    return { status: res.status, json, headers: res.headers };
  }

  /**
   * `post`, but retries a `429 rate_limited` response by sleeping for
   * this project's own `x-ratelimit-reset` header (seconds until the
   * window clears) rather than surfacing it as a run-ending error — see
   * this file's own top-of-file doc comment for why this exists at all.
   * Every other status code (2xx or a genuine 4xx/5xx) is returned
   * immediately, unretried — only rate-limiting itself is treated as
   * "wait, don't fail."
   */
  private async postWithBackoff(
    path: string,
    body: unknown,
  ): Promise<{ status: number; json: unknown }> {
    for (;;) {
      const { status, json, headers } = await this.post(path, body);
      if (status !== 429) return { status, json };
      const resetSeconds = Number(headers.get('x-ratelimit-reset') ?? '60');
      const waitMs = Math.max(
        1000,
        (Number.isFinite(resetSeconds) ? resetSeconds : 60) * 1000 + 250,
      );
      console.error(
        `authz: 429 rate_limited on ${path} — waiting ${(waitMs / 1000).toFixed(1)}s (x-ratelimit-reset)`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  async init(): Promise<void> {
    // Nothing to provision up front — `/schema/publish` below both
    // creates and versions a namespace in one call, and this repo's own
    // engine has no separate "store" concept to create first (the one
    // real structural asymmetry against OpenFGA's stores/SpiceDB's
    // datastore — see the design doc).
  }

  /**
   * Two `/schema/publish` calls, not one — this repo's own namespace
   * registry is additive and per-namespace (D-149), so publishing the
   * real `schema/example.authz` (org/group/folder/document) and then the
   * separate `bench_node` namespace right after is completely ordinary
   * usage, not a workaround. Unlike SpiceDB (see types.ts's own doc
   * comment on `loadSchema`), there is no "drops a live definition"
   * hazard here to design around.
   */
  async loadSchema(): Promise<void> {
    const source = readFileSync(EXAMPLE_SCHEMA_PATH, 'utf8');
    const example = await this.postWithBackoff('/schema/publish', { source });
    if (example.status !== 200) {
      throw new Error(
        `authz: /schema/publish (example) failed: ${example.status} ${JSON.stringify(example.json)}`,
      );
    }
    const chain = await this.postWithBackoff('/schema/publish', { source: DEPTH_CHAIN_SCHEMA });
    if (chain.status !== 200) {
      throw new Error(
        `authz: /schema/publish (depth-chain) failed: ${chain.status} ${JSON.stringify(chain.json)}`,
      );
    }
  }

  async writeTuple(t: CanonicalTuple): Promise<void> {
    const body: Record<string, unknown> = {
      objectNs: t.objectType,
      objectId: t.objectId,
      relation: t.relation,
      subjectNs: t.subject.type,
      subjectId: t.subject.id,
    };
    if (t.subject.relation !== undefined) body.subjectRelation = t.subject.relation;
    const { status, json } = await this.postWithBackoff('/tuples', body);
    if (status !== 200) {
      throw new Error(`authz: /tuples write failed: ${status} ${JSON.stringify(json)}`);
    }
  }

  async check(q: CanonicalCheckQuery): Promise<{ allowed: boolean; latencyMs: number }> {
    const body = {
      subject: { ns: q.subject.type, id: q.subject.id },
      relation: q.permission,
      object: { ns: q.objectType, id: q.objectId },
    };
    const start = performance.now();
    const { status, json } = await this.post('/check', body);
    const latencyMs = performance.now() - start;
    if (status !== 200) {
      throw new Error(`authz: /check failed: ${status} ${JSON.stringify(json)}`);
    }
    return { allowed: (json as { allowed: boolean }).allowed, latencyMs };
  }

  async close(): Promise<void> {
    // The harness owns starting/stopping `authz serve` itself (see
    // runner.ts) — nothing per-adapter to tear down.
  }
}
