/**
 * SpiceDB's own adapter — the official `@authzed/authzed-node` client,
 * real gRPC calls (Node's grpc-js under the hood) against a running
 * `spicedb serve` instance, default port 50051. SpiceDB's OSS gRPC API
 * has no bundled REST/JSON equivalent this harness could reach with
 * plain `fetch` the way the authz/OpenFGA adapters do (SpiceDB does ship
 * an HTTP gateway, `--http-enabled`, but it fronts the identical gRPC
 * service — using it instead would add a translation hop the other two
 * adapters don't pay, not remove one), so this is the one adapter that
 * genuinely needs a client library rather than a hand-rolled HTTP call.
 *
 * Every check below requests `fullyConsistent: true` — SpiceDB defaults
 * to `minimizeLatency` (may read a stale, cached revision) otherwise,
 * which would silently make SpiceDB the only engine of the three
 * permitted to answer from something other than its current data. This
 * repo's own engine and OpenFGA have no such switch to begin with (see
 * docs/BENCHMARK-PROPOSAL.md's consistency-defaults note) — pinning
 * SpiceDB to its strongest setting is the fair three-way baseline, not a
 * handicap.
 */
import { v1 } from '@authzed/authzed-node';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { CanonicalCheckQuery, CanonicalSubject, CanonicalTuple, EngineAdapter } from '../types.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const COMBINED_SCHEMA_PATH = path.resolve(moduleDir, '../../workloads/spicedb-combined.zed');

function subjectRef(s: CanonicalSubject): v1.SubjectReference {
  return v1.SubjectReference.create({
    object: v1.ObjectReference.create({ objectType: s.type, objectId: s.id }),
    ...(s.relation !== undefined ? { optionalRelation: s.relation } : {}),
  });
}

export interface SpicedbAdapterOptions {
  readonly endpoint: string;
  readonly presharedKey: string;
}

type SpiceDbClient = ReturnType<typeof v1.NewClient>;

export class SpicedbAdapter implements EngineAdapter {
  readonly name = 'spicedb' as const;
  private readonly endpoint: string;
  private readonly presharedKey: string;
  private client!: SpiceDbClient;

  constructor(opts: SpicedbAdapterOptions) {
    this.endpoint = opts.endpoint;
    this.presharedKey = opts.presharedKey;
  }

  // Not `async` — `v1.NewClient` is synchronous (it opens a gRPC channel
  // lazily, not at construction time), and `EngineAdapter.init` only
  // needs to return a `Promise<void>`, not actually await anything here.
  init(): Promise<void> {
    this.client = v1.NewClient(this.presharedKey, this.endpoint, v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED);
    return Promise.resolve();
  }

  async loadSchema(): Promise<void> {
    const schema = readFileSync(COMBINED_SCHEMA_PATH, 'utf8');
    await new Promise<void>((resolve, reject) => {
      this.client.writeSchema(v1.WriteSchemaRequest.create({ schema }), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * `TOUCH` (idempotent upsert), not `CREATE` — SpiceDB OSS has no
   * per-run store/tenant to isolate a run's own writes the way
   * OpenFGA's `createStore` gives the OpenFGA adapter (`init()`'s own
   * doc comment), so re-running this harness against one long-lived
   * `spicedb serve` process (the realistic case: a benchmark is run more
   * than once against the datastore that was already seeded) hits a
   * genuine `ALREADY_EXISTS` on `CREATE` — confirmed live. `TOUCH` is
   * the same write for a relationship that doesn't yet exist and a
   * harmless no-op for one that already does, matching how a real
   * seeding script (this repo's own `scripts/seed-example.ts` uses plain
   * `writeTuple`, ordinary-insert semantics with no such re-run hazard,
   * only because a fresh Postgres database starts genuinely empty) would
   * be written for repeatable use.
   */
  async writeTuple(t: CanonicalTuple): Promise<void> {
    const request = v1.WriteRelationshipsRequest.create({
      updates: [
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.TOUCH,
          relationship: v1.Relationship.create({
            resource: v1.ObjectReference.create({ objectType: t.objectType, objectId: t.objectId }),
            relation: t.relation,
            subject: subjectRef(t.subject),
          }),
        }),
      ],
    });
    await new Promise<void>((resolve, reject) => {
      this.client.writeRelationships(request, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async check(q: CanonicalCheckQuery): Promise<{ allowed: boolean; latencyMs: number }> {
    const request = v1.CheckPermissionRequest.create({
      resource: v1.ObjectReference.create({ objectType: q.objectType, objectId: q.objectId }),
      permission: q.permission,
      subject: subjectRef(q.subject),
      consistency: v1.Consistency.create({
        requirement: { oneofKind: 'fullyConsistent', fullyConsistent: true },
      }),
    });
    const start = performance.now();
    const response = await new Promise<v1.CheckPermissionResponse>((resolve, reject) => {
      this.client.checkPermission(request, (err, res) => {
        if (err) reject(err);
        else resolve(res!);
      });
    });
    const latencyMs = performance.now() - start;
    return {
      allowed: response.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
      latencyMs,
    };
  }

  /**
   * The one method not on `EngineAdapter` — used ONLY by the
   * write-then-check consistency probe (`runner.ts`), never by the
   * latency/cross-validation benchmarks above, which always call
   * `check()`'s `fullyConsistent` path. No `consistency` requirement set
   * at all here, matching what a caller gets by leaving SpiceDB's own
   * default in place — `minimizeLatency`, real revision quantization
   * (`--datastore-revision-quantization-interval`, 5s default), and the
   * one place this harness deliberately does NOT normalize away a real
   * default difference between the three engines, because that
   * difference is exactly what this probe measures. See
   * docs/BENCHMARK-PROPOSAL.md's consistency-defaults note.
   */
  async checkDefaultConsistency(q: CanonicalCheckQuery): Promise<boolean> {
    const request = v1.CheckPermissionRequest.create({
      resource: v1.ObjectReference.create({ objectType: q.objectType, objectId: q.objectId }),
      permission: q.permission,
      subject: subjectRef(q.subject),
    });
    const response = await new Promise<v1.CheckPermissionResponse>((resolve, reject) => {
      this.client.checkPermission(request, (err, res) => {
        if (err) reject(err);
        else resolve(res!);
      });
    });
    return response.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION;
  }

  // Not `async` — same reason as `init` above: `close` is synchronous.
  close(): Promise<void> {
    this.client.close?.();
    return Promise.resolve();
  }
}
