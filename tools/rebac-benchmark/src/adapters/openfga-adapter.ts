/**
 * OpenFGA's own adapter — the official `@openfga/sdk` `OpenFgaClient`
 * (real HTTP calls to a running `openfga run` instance's REST API,
 * default port 8080), plus `@openfga/syntax-transformer` to compile the
 * checked-in `.fga` DSL text (`workloads/*.fga`) into the JSON shape
 * `POST /stores/{id}/authorization-models` actually accepts — the exact
 * two-step "write DSL by hand, transform at load time" flow the
 * `fga`/playground tooling itself uses; this harness reimplements neither
 * the DSL grammar nor the transform, it calls OpenFGA's own published
 * package for both.
 *
 * One structural fact worth naming up front: OpenFGA is multi-tenant by
 * design (a "store" holds one model + its tuples), so `init()` below
 * creates a fresh store per run — there is no equivalent step for
 * this repo's own engine (a namespace publish IS the model) or for
 * SpiceDB (a schema write against the one, already-running datastore).
 * That's a real API-shape difference, not a benchmark artifact — see
 * docs/BENCHMARK-PROPOSAL.md's "What's fair to compare."
 */
import { OpenFgaClient } from '@openfga/sdk';
import { transformer } from '@openfga/syntax-transformer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type {
  CanonicalCheckQuery,
  CanonicalSubject,
  CanonicalTuple,
  EngineAdapter,
} from '../types.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const COMBINED_MODEL_PATH = path.resolve(moduleDir, '../../workloads/openfga-combined.fga');

function subjectRef(s: CanonicalSubject): string {
  return s.relation !== undefined ? `${s.type}:${s.id}#${s.relation}` : `${s.type}:${s.id}`;
}

export interface OpenfgaAdapterOptions {
  readonly apiUrl: string;
}

export class OpenfgaAdapter implements EngineAdapter {
  readonly name = 'openfga' as const;
  private readonly apiUrl: string;
  private client!: OpenFgaClient;
  private storeId!: string;
  private authorizationModelId!: string;

  constructor(opts: OpenfgaAdapterOptions) {
    this.apiUrl = opts.apiUrl;
  }

  async init(): Promise<void> {
    // A bare, storeless client first, purely to call createStore — the
    // real client (with storeId set) is built right after, since the SDK
    // binds storeId at construction time.
    const bootstrap = new OpenFgaClient({ apiUrl: this.apiUrl });
    const store = await bootstrap.createStore({ name: `rebac-benchmark-${Date.now()}` });
    this.storeId = store.id;
    this.client = new OpenFgaClient({ apiUrl: this.apiUrl, storeId: this.storeId });
  }

  async loadSchema(): Promise<void> {
    const dsl = readFileSync(COMBINED_MODEL_PATH, 'utf8');
    const model = transformer.transformDSLToJSONObject(dsl) as Parameters<
      OpenFgaClient['writeAuthorizationModel']
    >[0];
    const written = await this.client.writeAuthorizationModel(model);
    this.authorizationModelId = written.authorization_model_id;
  }

  async writeTuple(t: CanonicalTuple): Promise<void> {
    await this.client.write(
      {
        writes: [
          {
            user: subjectRef(t.subject),
            relation: t.relation,
            object: `${t.objectType}:${t.objectId}`,
          },
        ],
      },
      { authorizationModelId: this.authorizationModelId },
    );
  }

  async check(q: CanonicalCheckQuery): Promise<{ allowed: boolean; latencyMs: number }> {
    const start = performance.now();
    const res = await this.client.check(
      {
        user: subjectRef(q.subject),
        relation: q.permission,
        object: `${q.objectType}:${q.objectId}`,
      },
      { authorizationModelId: this.authorizationModelId },
    );
    const latencyMs = performance.now() - start;
    return { allowed: res.allowed === true, latencyMs };
  }

  async close(): Promise<void> {
    // No persistent connection to tear down — the SDK is HTTP/axios
    // under the hood, one request at a time.
  }
}
