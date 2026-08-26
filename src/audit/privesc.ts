/**
 * `authz audit privesc <object> <relation> [--expected subj1,subj2,...]` —
 * a policy-drift detector for a security reviewer, post-audit improvement
 * (not part of the original phased build in `.claude/commands/build-authz-
 * service.md`). Given a specific, presumably-sensitive `(object,
 * relation-or-permission)` pair, `privescScan` reports EVERY real subject
 * currently able to reach it, each with its own real, freshly-computed
 * resolution path — the reverse-and-report-everything sibling of `authz
 * check`'s "is this ONE subject allowed" question, and a close cousin of
 * `src/audit/list.ts`'s `listUsers`, built the same way for the same reason
 * (see below for exactly how it differs from `listUsers` and why that
 * difference is deliberate).
 *
 * **This file implements NO new reachability/resolver logic of its own —
 * every single allow/deny decision below is a real, live
 * `productionCheck` call.** The only code that belongs to this file is
 * candidate enumeration (which subjects are even worth asking about) and
 * result aggregation (collect, keep the allowed ones, sort by depth) —
 * exactly `list.ts`'s own "coarse-candidate-then-real-check" discipline,
 * read in full before writing this file, and followed here without
 * modification.
 *
 * ---
 *
 * **The candidate-gathering strategy, and why it's safe and complete —
 * independently re-verified against `resolver.ts`, not assumed just
 * because `list.ts` made a structurally similar claim for objects.**
 * `fetchCandidateSubjects` below runs `select distinct subject_ns,
 * subject_id from relation_tuples` — every distinct `(ns, id)` pair this
 * database has EVER recorded as a subject, of ANY type, in ANY relation,
 * ignoring the `subject_relation` column entirely (unlike this file's own
 * sibling test oracle in `list.integration.test.ts`'s
 * `fetchAllPlainSubjects`, which filters `where subject_relation is
 * null` — deliberately not filtered here, see "on not filtering
 * `subject_relation`" below).
 *
 * This is a safe, complete candidate universe because of exactly one fact,
 * confirmed by reading `resolver.ts`'s `resolve`/`evalRewrite`/
 * `sqlRelationMembershipWithWitness` in full: **every real `allowed: true`
 * outcome, for any subject, on any object/relation/permission, ultimately
 * requires a real `relation_tuples` row with `subject_relation is null`
 * and `subject_ns`/`subject_id` matching the checked subject exactly.**
 * Concretely:
 *
 *  - `resolve`/`evalRewrite` (the TypeScript-level combinator/tuple-to-
 *    userset walk) pass `subject` down completely unchanged through every
 *    branch — `union`, `intersection`, `exclusion`, `computedUserset`,
 *    `tupleToUserset` all recurse with the exact same `subject` reference
 *    the outermost call started with. The subject identity itself never
 *    changes mid-walk; only `object`/`name` do.
 *  - The only place `resolve` ever produces `allowed: true` is by handing
 *    off to `sqlRelationMembershipWithWitness` for a storable relation leaf
 *    (`resolve`'s own `if (relation) { ... }` branch) — permissions never
 *    resolve to `allowed: true` on their own, only by eventually reaching
 *    a relation leaf through `evalRewrite`.
 *  - `sqlRelationMembershipWithWitness`'s own winning condition, read
 *    directly from its source: `t.subject_relation === null &&
 *    t.subject_ns === subject.ns && t.subject_id === subject.id` — a real,
 *    currently-stored tuple row, naming this exact subject as a PLAIN
 *    (non-userset) subject, is the only way this function ever returns
 *    `allowed: true`.
 *
 * So a subject with zero rows anywhere in `relation_tuples` — as
 * `subject_ns`/`subject_id`, regardless of `subject_relation` — can never
 * satisfy that winning condition for any object/relation/permission this
 * engine could ever be asked about, and is therefore correctly excluded
 * from every candidate set this function could ever enumerate. No
 * candidate outside `fetchCandidateSubjects`'s own result set could ever be
 * `allowed: true` (nothing missed).
 *
 * **On not filtering `subject_relation is null` in the candidate query
 * itself.** The winning condition above only ever matches a row with
 * `subject_relation is null` — so restricting the candidate scan to
 * exactly those rows (as `list.integration.test.ts`'s own brute-force
 * oracle does) would already be sufficient and slightly tighter. This file
 * deliberately scans EVERY distinct `subject_ns`/`subject_id` pair
 * regardless of `subject_relation` instead — a strict superset, per this
 * project's own build spec, chosen for the same reason `list.ts`'s own
 * `listObjects` candidate scan favors "never wrongly omit" over "tightest
 * possible query" (§6.5's asymmetry, applied here to candidate
 * completeness rather than consistency): a subject that appears ONLY as a
 * userset pointer's own base entity today (e.g. `group:eng` referenced as
 * `group:eng#member` somewhere) is harmless, wasted work as a candidate —
 * its own `productionCheck` will simply come back denied unless some OTHER
 * tuple also names it as a plain subject — never a missed finding. The
 * superset costs some number of guaranteed-denied `productionCheck` calls
 * on a live database with many userset-only entities; it never costs
 * correctness.
 *
 * ---
 *
 * **A disclosed, NOT-optimized scale limitation — read this before running
 * `privescScan` against a large, established database.** Unlike
 * `list.ts`'s `listObjects`, whose candidate scan is scoped to one
 * namespace and capped at `LIST_OBJECTS_MAX_CANDIDATES` (with a
 * `truncated` flag the caller must check), `fetchCandidateSubjects` below
 * has NO namespace scope and NO cap: it is a plain, unbounded `select
 * distinct` over the ENTIRE `relation_tuples` table, and every single
 * distinct subject it finds gets one real, full graph-walk
 * `productionCheck` call (`Math.max(1, env.MAX_CONCURRENCY)` at a time).
 * On a database with a very large number of distinct subjects, this is
 * genuinely slow — potentially thousands of sequential batches of real
 * checks, each batch bounded by whatever the slowest check in it costs.
 * This is a deliberate choice, not an oversight: `authz audit privesc` is
 * an operator-run, on-demand security-review tool (mirroring `authz audit
 * verify`'s own "reads everything into memory, fine for a periodic
 * operator-run check" precedent, `src/cli/commands/audit.ts`), not a
 * paginated bulk API with a latency budget — and unlike `listObjects`
 * (which answers "does subject X have access to ANY of these objects,"
 * where a namespace-scoped cap is a natural boundary), there is no
 * similarly natural, non-arbitrary scope to cap "every subject this whole
 * database has ever recorded" by without risking exactly the kind of
 * silent, incomplete-looking-complete security answer this tool exists to
 * avoid. Revisit with real pagination (a cursor over `(subject_ns,
 * subject_id)`, since the candidate scan can trivially be made
 * deterministically ordered) only if a real deployment's tuple count makes
 * this tool's own runtime a problem in practice — not preemptively here.
 *
 * **Never touches the `checks` audit table** — calls `productionCheck`
 * directly, never `performCheck` (`src/audit/checks.ts`), for the
 * identical reason `list.ts`'s own top-of-file doc comment gives for
 * `listObjects`/`listUsers`: a bulk discovery/reporting scan across
 * potentially thousands of synthetic per-candidate checks is a
 * structurally different kind of question than the one named "is this one
 * (subject, object) pair allowed" question `performCheck`'s own contract
 * was written to log. No `privescScan` call, and therefore no individual
 * per-candidate check it performs, is ever recorded in the `checks` table.
 *
 * **No `atToken` support** — `privescScan`'s signature has no consistency-
 * token option at all, matching `listUsers`'s own deliberate omission
 * (`list.ts`) rather than silently accepting one that would do nothing.
 * Revisit only alongside a real, stated need, the same condition `list.ts`
 * states for its own equivalent gap.
 */
import { env } from '../config/env.js';
import type { ConnectionSource } from '../store/query-executor.js';
import {
  productionCheck,
  type EntityRef,
  type ResolutionStep,
} from '../resolve/production/resolver.js';

export type { EntityRef };

/**
 * One real subject this database currently, actually grants
 * `relationOrPermission` on `object` to — every field backed by a real
 * `productionCheck` call, never inferred or approximated.
 */
export interface PrivescFinding {
  subject: EntityRef;
  allowed: true;
  /** The real resolution path this specific subject was reached through — `ProductionCheckResult.path`, present because `allowed` is always `true` for a `PrivescFinding` (never constructed for a denied candidate). */
  path: ResolutionStep;
  /** The real maximum recursion depth this specific subject's own check reached — `ProductionCheckResult.depth`. Findings are sorted by this field ascending (shallowest/most-easily-reached first), see `privescScan`'s own doc comment. */
  depth: number;
}

interface CandidateSubjectRow {
  subject_ns: string;
  subject_id: string;
}

/**
 * The candidate scan itself — see this file's own top-of-file doc comment
 * for the soundness argument this depends on and for why this is
 * deliberately NOT scoped to one namespace and NOT capped. `order by
 * subject_ns asc, subject_id asc` makes iteration order deterministic and
 * reproducible across repeated calls against the same data, matching
 * `list.ts`'s own `fetchCandidateObjectIds` precedent — not load-bearing
 * for correctness (the final result is sorted by depth, not by this
 * order), purely for a reproducible batch assignment.
 */
async function fetchCandidateSubjects(pool: ConnectionSource): Promise<EntityRef[]> {
  const { rows } = await pool.query<CandidateSubjectRow>(
    `select distinct subject_ns, subject_id
     from relation_tuples
     order by subject_ns asc, subject_id asc`,
  );
  return rows.map((row) => ({ ns: row.subject_ns, id: row.subject_id }));
}

/**
 * Runs a real `productionCheck(pool, subject, object, relationOrPermission)`
 * for every candidate, `Math.max(1, env.MAX_CONCURRENCY)` at a time — the
 * identical slice-into-batches/`Promise.all`-each-batch shape `list.ts`'s
 * own `checkCandidatesConcurrently` already establishes for `listObjects`.
 * Independently written here, not imported — `checkCandidatesConcurrently`
 * is module-private in `list.ts`, and even if it were exported, its own
 * per-candidate work unit varies `object` across a fixed `subject`, the
 * exact opposite of what this function needs (a fixed `object`, varying
 * `subject`) — sharing would mean bending one call shape to fit the other
 * for a three-line loop, not a real simplification.
 *
 * Batch order is preserved for the same reason `list.ts` preserves it
 * (determinism of which batch a given candidate lands in); the RETURNED
 * array's own order is not meaningful on its own — `privescScan` sorts the
 * final result by depth before returning it.
 */
async function scanCandidatesConcurrently(
  pool: ConnectionSource,
  candidates: readonly EntityRef[],
  object: EntityRef,
  relationOrPermission: string,
): Promise<PrivescFinding[]> {
  const concurrency = Math.max(1, env.MAX_CONCURRENCY);
  const findings: PrivescFinding[] = [];
  for (let start = 0; start < candidates.length; start += concurrency) {
    const batch = candidates.slice(start, start + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (subject): Promise<PrivescFinding | null> => {
        const result = await productionCheck(pool, subject, object, relationOrPermission);
        if (!result.allowed) return null;
        if (result.path === undefined) {
          // Defends `ProductionCheckResult`'s own documented "present if
          // and only if allowed is true" contract (resolver.ts) — never
          // silently drop a real grant into a pathless finding just
          // because this is stated to be unreachable; fail loudly instead,
          // matching this codebase's own "defended but disclosed" style
          // for a should-be-impossible case (e.g. `assertNeverRewriteRule`).
          throw new Error(
            `privescScan: productionCheck reported allowed=true with no path for subject ` +
              `${subject.ns}:${subject.id} on ${object.ns}:${object.id}#${relationOrPermission} ` +
              `— this violates ProductionCheckResult's own documented contract`,
          );
        }
        return { subject, allowed: true, path: result.path, depth: result.depth };
      }),
    );
    for (const finding of batchResults) {
      if (finding !== null) findings.push(finding);
    }
  }
  return findings;
}

/**
 * Every real subject this database currently grants `relationOrPermission`
 * on `object` to, each with its own real resolution path and depth, sorted
 * by depth ascending (shallowest/most-easily-reached first — the subjects
 * a reviewer most likely wants to see first, since a short path is
 * typically the easiest one for an attacker to also find and the easiest
 * for a reviewer to verify by hand). See this file's own top-of-file doc
 * comment for the candidate-gathering strategy, its soundness argument, and
 * its disclosed, un-optimized scale limitation.
 *
 * Never throws for an ordinary "nobody has access" case — returns `[]`. A
 * genuinely unreachable database, or a `productionCheck` call that itself
 * throws (e.g. a schema/config lookup failure), propagates unchanged; this
 * function catches nothing of its own.
 */
export async function privescScan(
  pool: ConnectionSource,
  object: EntityRef,
  relationOrPermission: string,
): Promise<PrivescFinding[]> {
  const candidates = await fetchCandidateSubjects(pool);
  const findings = await scanCandidatesConcurrently(pool, candidates, object, relationOrPermission);
  return findings.sort((a, b) => a.depth - b.depth);
}
