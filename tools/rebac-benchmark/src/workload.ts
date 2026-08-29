/**
 * The identical logical operation sequence every engine adapter replays —
 * generated ONCE here, as plain data (`CanonicalTuple`/`CanonicalCheckQuery`
 * from `./types.ts`), with zero engine-specific knowledge. `runner.ts`
 * feeds this same data to all three adapters; each adapter alone knows
 * how to turn it into that engine's real wire calls. This is what makes
 * "identical workload" a property of the code, not a claim about it.
 *
 * Two independent workloads, matching the two things
 * `docs/BENCHMARK-PROPOSAL.md` argues are the fair, defensible things to
 * measure:
 *
 * 1. `exampleGraphWorkload()` — this repo's own real demo graph
 *    (`schema/example.authz`, `scripts/seed-example.ts`), translated
 *    tuple-for-tuple, plus the 8 canonical checks the README already
 *    documents the expected answer to. Running this against all three
 *    engines is a CORRECTNESS cross-check first (do all three agree on
 *    the identical graph?) and only secondarily a latency sample — it's
 *    small and not perfectly one-shape, so it is not the harness's
 *    latency-distribution workload.
 * 2. `depthChainWorkload(seed, depths, runsPerDepth)` — the actual
 *    latency-distribution workload, deliberately ONE repeated shape
 *    (a pure nested-membership chain) at controlled depths, mirroring
 *    `scripts/benchmark-check-depth.ts`. Every one of the `runsPerDepth`
 *    checks at a given depth targets a DISTINCT, freshly-generated chain
 *    (unique object ids, seeded and reproducible) rather than repeating
 *    one identical query — see README.md's "Why distinct chains, not one
 *    repeated query" for why: it's the only way to compare the three
 *    engines' uncached graph-walk cost without SpiceDB's on-by-default
 *    dispatch cache (or a future cache in either of the other two)
 *    quietly turning "check latency" into "cache-hit latency" after the
 *    first call.
 */
import { mulberry32 } from './prng.js';
import type { CanonicalCheckQuery, CanonicalTuple } from './types.js';

export interface ExampleGraphWorkload {
  readonly tuples: readonly CanonicalTuple[];
  readonly checks: readonly {
    readonly query: CanonicalCheckQuery;
    readonly expected: boolean;
    readonly note: string;
  }[];
}

function subject(type: string, id: string, relation?: string) {
  return relation !== undefined ? { type, id, relation } : { type, id };
}

function tuple(
  objectType: string,
  objectId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
  subjectRelation?: string,
): CanonicalTuple {
  return {
    objectType,
    objectId,
    relation,
    subject: subject(subjectType, subjectId, subjectRelation),
  };
}

/**
 * `schema/example.authz` + `scripts/seed-example.ts`, translated
 * tuple-for-tuple (see workloads/openfga-example.fga and
 * workloads/spicedb-example.zed for the two engine-native schemas this
 * exact tuple set is written against). Every tuple below has a named
 * counterpart in `scripts/seed-example.ts`'s own doc comment.
 */
export function exampleGraphWorkload(): ExampleGraphWorkload {
  const tuples: CanonicalTuple[] = [
    // org:acme membership + the one banned member (org.view = member - banned)
    tuple('org', 'acme', 'member', 'user', 'alice'),
    tuple('org', 'acme', 'member', 'user', 'bob'),
    tuple('org', 'acme', 'member', 'user', 'carol'),
    tuple('org', 'acme', 'member', 'user', 'dana'),
    tuple('org', 'acme', 'member', 'user', 'erin'),
    tuple('org', 'acme', 'member', 'user', 'mallory'),
    tuple('org', 'acme', 'banned', 'user', 'mallory'),
    // group:eng, two levels of nesting; dana's only path to `eng` is
    // through eng_backend_interns -> eng_backend -> eng (the "non-obvious
    // case" this repo's own README names by name).
    tuple('group', 'eng', 'member', 'user', 'alice'),
    tuple('group', 'eng', 'member', 'group', 'eng_backend', 'member'),
    tuple('group', 'eng_backend', 'member', 'group', 'eng_backend_interns', 'member'),
    tuple('group', 'eng_backend_interns', 'member', 'user', 'dana'),
    tuple('group', 'finance', 'member', 'user', 'carol'),
    tuple('group', 'finance', 'member', 'user', 'erin'),
    // folder hierarchy — eng_backend_docs has NO direct grants of its
    // own; everything on it is inherited via parent->edit/parent->view.
    tuple('folder', 'eng_docs', 'editor', 'group', 'eng', 'member'),
    tuple('folder', 'eng_backend_docs', 'parent', 'folder', 'eng_docs'),
    tuple('folder', 'finance_docs', 'viewer', 'group', 'finance', 'member'),
    tuple('folder', 'finance_docs', 'sensitive_reviewer', 'user', 'carol'),
    // documents
    tuple('document', 'eng_handbook', 'parent', 'folder', 'eng_docs'),
    tuple('document', 'eng_backend_runbook', 'parent', 'folder', 'eng_backend_docs'),
    tuple('document', 'roadmap', 'viewer', 'user', 'bob'),
    tuple('document', 'roadmap', 'owner', 'user', 'alice'),
    tuple('document', 'financials', 'parent', 'folder', 'finance_docs'),
  ];

  const checks: ExampleGraphWorkload['checks'] = [
    {
      query: {
        subject: subject('user', 'dana'),
        permission: 'edit',
        objectType: 'document',
        objectId: 'eng_handbook',
      },
      expected: true,
      note: 'dana -> eng_backend_interns#member -> eng_backend#member -> eng#member -> eng_docs#editor -> eng_handbook#edit (5 hops, two-level group nesting)',
    },
    {
      query: {
        subject: subject('user', 'alice'),
        permission: 'edit',
        objectType: 'document',
        objectId: 'eng_handbook',
      },
      expected: true,
      note: 'alice is a direct eng#member -> eng_docs#editor -> eng_handbook#edit (3 hops)',
    },
    {
      query: {
        subject: subject('user', 'mallory'),
        permission: 'view',
        objectType: 'org',
        objectId: 'acme',
      },
      expected: false,
      note: 'org.view = member - banned; mallory is a member but also banned (exclusion)',
    },
    {
      query: {
        subject: subject('user', 'carol'),
        permission: 'sensitive_review',
        objectType: 'folder',
        objectId: 'finance_docs',
      },
      expected: true,
      note: 'sensitive_review = (viewer|edit) & sensitive_reviewer; carol has both (intersection, positive case)',
    },
    {
      query: {
        subject: subject('user', 'erin'),
        permission: 'sensitive_review',
        objectType: 'folder',
        objectId: 'finance_docs',
      },
      expected: false,
      note: 'erin has viewer via group:finance but not sensitive_reviewer (intersection, negative case)',
    },
    {
      query: {
        subject: subject('user', 'bob'),
        permission: 'view',
        objectType: 'document',
        objectId: 'roadmap',
      },
      expected: true,
      note: 'document:roadmap has no parent folder — direct viewer grant only, depth 0',
    },
    {
      query: {
        subject: subject('user', 'dana'),
        permission: 'edit',
        objectType: 'document',
        objectId: 'eng_backend_runbook',
      },
      expected: true,
      note: 'compounds 2 group-nesting hops with 2 folder-inheritance hops (eng_backend_docs has no direct grants of its own)',
    },
    {
      query: {
        subject: subject('user', 'mallory'),
        permission: 'edit',
        objectType: 'document',
        objectId: 'eng_handbook',
      },
      expected: false,
      note: 'negative control on the union side: mallory has no path into group:eng at all',
    },
  ];

  return { tuples, checks };
}

export interface DepthChainCase {
  readonly depth: number;
  /** Unique per (seed, depth, run index) — never reused across or within a run. */
  readonly runId: string;
  readonly tuples: readonly CanonicalTuple[];
  readonly check: CanonicalCheckQuery;
}

/**
 * `runsPerDepth` independent, structurally-identical chains per requested
 * depth — see this file's own top comment for why independent chains,
 * not one repeated query. `bench_node:node_<runId>_D#view` requires
 * walking exactly `D` `parent->view` tuple-to-userset hops to reach
 * `bench_node:node_<runId>_0`, the chain's only direct `viewer` grant
 * (`user:bench_subject_<runId>`) — the identical `parent->edit`/
 * `parent->view` shape `schema/example.authz`'s own `folder`/`document`
 * namespaces already use, at a controlled depth, translated against
 * `workloads/{openfga,spicedb}-depth-chain.{fga,zed}`.
 *
 * This is a **plain tuple-to-userset chain** (`parent: bench_node`, a
 * PLAIN, non-userset-typed relation), not the nested-group-membership
 * shape (`member: bench_node#member`, a userset-typed subject)
 * `scripts/benchmark-check-depth.ts` uses against this repo's own engine
 * alone. The two are different rewrite-rule shapes in Zanzibar's model,
 * and the switch is not cosmetic: OpenFGA's schema validator rejects a
 * relation used as a tupleToUserset *tupleset* (the left side of
 * `X from Y`) from having any userset-typed subject option at all —
 * confirmed live against this harness's own OpenFGA instance ("the
 * relation type 'bench_node#member' on 'member' in object type
 * 'bench_node' is not valid"), and documented in
 * `docs/BENCHMARK-PROPOSAL.md`'s disclosed-gaps section. The nested-
 * membership shape itself is not lost from this harness — it's exactly
 * what `exampleGraphWorkload()` above already exercises (dana's two-level
 * `group#member` nesting) and cross-validates across all three engines;
 * it just isn't also the depth-scaling workload's own shape, because that
 * specific combination has no OpenFGA equivalent to compare against.
 *
 * Deterministic in `seed` alone: the same seed, depths, and
 * runsPerDepth always produce byte-identical tuples and checks,
 * independent of engine, host, or run order — the "workload generation
 * seeded/reproducible" bar `docs/BENCHMARK-PROPOSAL.md` names as a
 * requirement for a citable result.
 */
export function depthChainWorkload(
  seed: number,
  depths: readonly number[],
  runsPerDepth: number,
): DepthChainCase[] {
  const rng = mulberry32(seed);
  const cases: DepthChainCase[] = [];
  for (const depth of depths) {
    for (let run = 0; run < runsPerDepth; run++) {
      // rng is drawn from (even though a runId could instead be derived
      // deterministically from depth/run alone, with no PRNG at all) so
      // that "the same seed always produces byte-identical output" is a
      // real, checkable property of this function's actual behavior, not
      // just of its inputs — verified directly by test/workload.test.ts.
      // Appending a new depth to the END of `depths` (same seed,
      // runsPerDepth) leaves every earlier depth's own cases unchanged;
      // changing `runsPerDepth` itself reflows every draw after the
      // first depth, same as any sequential PRNG consumer.
      const salt = Math.floor(rng() * 1e9);
      const runId = `d${depth}_r${run}_${salt.toString(36)}`;
      const subjectUser = `bench_subject_${runId}`;
      const tuples: CanonicalTuple[] = [];
      for (let i = 1; i <= depth; i++) {
        tuples.push(
          tuple(
            'bench_node',
            `node_${runId}_${i}`,
            'parent',
            'bench_node',
            `node_${runId}_${i - 1}`,
          ),
        );
      }
      tuples.push(tuple('bench_node', `node_${runId}_0`, 'viewer', 'user', subjectUser));
      cases.push({
        depth,
        runId,
        tuples,
        check: {
          subject: subject('user', subjectUser),
          permission: 'view',
          objectType: 'bench_node',
          objectId: `node_${runId}_${depth}`,
        },
      });
    }
  }
  return cases;
}
