/**
 * The one canonical shape every adapter speaks — deliberately the
 * smallest common denominator across this repo's own tuple shape
 * (`src/store/tuples.ts`'s `TupleKey`), OpenFGA's relationship tuples,
 * and SpiceDB's relationships. A workload is generated ONCE, as data, in
 * this shape; each adapter's own `writeTuple`/`check` translates it into
 * that engine's real wire format and issues a real network call. No
 * adapter ever sees another engine's request/response types, and the
 * workload generator never imports any engine's SDK — that separation is
 * what makes "identical logical operation sequence" a checkable claim
 * rather than an assertion.
 */

export interface CanonicalSubject {
  readonly type: string;
  readonly id: string;
  /** Present only for a userset subject, e.g. `group:eng#member`. */
  readonly relation?: string;
}

export interface CanonicalTuple {
  readonly objectType: string;
  readonly objectId: string;
  readonly relation: string;
  readonly subject: CanonicalSubject;
}

export interface CanonicalCheckQuery {
  readonly subject: CanonicalSubject;
  readonly permission: string;
  readonly objectType: string;
  readonly objectId: string;
}

/**
 * One engine's thin driver. `init()` provisions a fresh, isolated
 * schema/model/store scoped to this run alone — never shared mutable
 * state a second concurrent run could collide with. Every method's own
 * doc comment on each adapter names exactly which real network transport
 * it uses; none of them ever call into an engine's code in-process.
 */
export interface EngineAdapter {
  readonly name: 'authz' | 'openfga' | 'spicedb';

  init(): Promise<void>;

  /**
   * Loads everything this run's workload needs — the org/group/folder/
   * document demo namespaces AND the bench_node depth-chain type,
   * translated per-engine (see workloads/). A single method, not two
   * separate `loadExampleSchema`/`loadDepthChainSchema` calls, because
   * SpiceDB genuinely cannot support that split: its one live schema
   * rejects any `WriteSchema` that would drop a definition still
   * referenced by an existing relationship, so a second, narrower write
   * after the example graph's tuples exist would simply fail (confirmed
   * live — see workloads/spicedb-combined.zed's own doc comment). authz
   * and OpenFGA have no such restriction (independent namespace versions
   * / independent model versions respectively) but implement this the
   * same one-call way for symmetry across all three adapters.
   */
  loadSchema(): Promise<void>;

  writeTuple(tuple: CanonicalTuple): Promise<void>;

  /**
   * Issues one real check over this engine's real network transport
   * (HTTP for authz/OpenFGA, gRPC for SpiceDB — see each adapter) and
   * returns the allowed/denied verdict plus this call's own
   * wall-clock latency in milliseconds, timed from immediately before
   * the request is sent to immediately after the response resolves.
   */
  check(query: CanonicalCheckQuery): Promise<{ allowed: boolean; latencyMs: number }>;

  close(): Promise<void>;
}
