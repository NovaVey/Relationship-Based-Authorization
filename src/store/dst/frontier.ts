/**
 * `fetchReachableFrontierVia` — DST D3's own named deliverable
 * (`docs/DST-PROPOSAL.md`'s phased plan, `docs/DECISIONS.md` D-100): a
 * real, multi-level in-memory BFS matching `src/resolve/production/
 * resolver.ts`'s `fetchReachableFrontier` recursive CTE, replacing D2's
 * own deliberately narrow seed-row-only stopgap
 * (`src/store/dst/shapes.ts`'s `fetchReachableFrontierHandler`).
 *
 * This is not trusted because it looks right — see `docs/DECISIONS.md`
 * D-100 for the differential-equivalence suite
 * (`test/unit/resolve/production/frontier-equivalence.integration.test.ts`)
 * that proves it against real Postgres on hundreds of random graphs plus a
 * direct replay of D-092's own hardest known case, mirroring the identical
 * trust discipline that already backs the reference resolver standing in
 * as an oracle for the production one.
 *
 * **Matching Postgres's own `WITH RECURSIVE` semantics precisely — not
 * "a BFS that also happens to find the same nodes."** Three properties of
 * the real recursive CTE (`resolver.ts`'s own `fetchReachableFrontier`,
 * quoted in full in that function's own doc comment) this implementation
 * replicates exactly, not approximately:
 *
 * 1. **Iterative, working-table semantics.** Standard SQL `WITH RECURSIVE`
 *    evaluates in rounds: the recursive term's `join membership m` only
 *    ever sees the rows the *previous* round produced (the "working
 *    table"), never the full accumulated result — a row discovered at
 *    iteration 3 has its own outgoing edges explored only in iteration 4,
 *    not re-joined against edges already resolved in earlier iterations.
 *    This function's own `while` loop mirrors that directly: each pass
 *    expands only `frontier` (last round's own output), appends the
 *    result to the running total, and replaces `frontier` with it for the
 *    next pass — never re-scanning rows from an earlier round.
 * 2. **Per-iteration `DISTINCT ON` dedup, not global.** Within one round,
 *    if two different frontier rows both produce an edge to the identical
 *    `(subject_ns, subject_id, subject_relation)` identity, only one
 *    representative survives into the next round — real Postgres via
 *    `distinct on (rt.subject_ns, rt.subject_id, rt.subject_relation)`
 *    with no `order by` (an *unspecified* representative, per Postgres's
 *    own documented behavior for `DISTINCT ON` without `ORDER BY`);
 *    this function via "first edge discovered wins," a *specific*,
 *    reproducible tie-break rather than Postgres's own unspecified one.
 *    `docs/DECISIONS.md` D-092's own reachability argument is why this
 *    difference is safe *for the reached-identity set*: which
 *    representative gets kept can never change the *set* of identities
 *    eventually reached (every identity that could ever appear in a
 *    chosen representative's own path must, by construction, already have
 *    been discovered as its own row at an earlier or the same round — see
 *    that argument's own full text for why), nor the *minimum* depth at
 *    which each identity is first reached. It does **not** follow that the
 *    raw, undeduped *maximum* depth reached across the whole traversal is
 *    invariant too — a differing tie-break for one node can determine
 *    whether that node's own path happens to include an ancestor that its
 *    outgoing edges would otherwise cycle back to, which determines
 *    whether the per-row cycle guard (property 3) blocks or permits a
 *    further, strictly-deeper *re-discovery* of already-known identities
 *    (property 3's own "reached again at a later unrelated iteration" case
 *    below). That re-discovery is legitimate, expected behavior, but how
 *    many extra rounds of it fire — and therefore the raw maximum depth
 *    seen — depends on which representative won upstream. Confirmed by a
 *    concrete counterexample during D-100's own adversarial review (see
 *    `docs/DECISIONS.md` D-100): the *set* of reached identities and the
 *    *minimum* depth per identity are the only quantities this function's
 *    own equivalence suite may safely compare against real Postgres; the
 *    raw, undeduped maximum depth must never be compared directly between
 *    two independent implementations.
 * 3. **Per-*row* cycle guard (`path`), not a global visited set.** An edge
 *    is excluded only if its target identity already appears in the
 *    *specific frontier row being expanded*'s own root-to-here `path` —
 *    matching the real query's `not (identity = any(m.path))` exactly,
 *    which checks the recursive term's own current row `m`, never a
 *    table-wide accumulator. The real query's own doc comment explains
 *    why: "a true global 'visited' set isn't expressible in a
 *    standard-conforming Postgres recursive CTE without violating its
 *    'the recursive table may be referenced only once' restriction" — an
 *    in-memory implementation has no such restriction, but deliberately
 *    keeps the identical per-row semantics anyway, since diverging here
 *    would make this function answer a *different*, stronger reachability
 *    question than the real query actually asks, defeating the entire
 *    point of an equivalence proof.
 *
 * **Depth cap.** The real query's recursive term only fires for a
 * previous-round row whose own `depth < $4` (`maxDepth`) — at the seed
 * row's own `depth = 0`, `maxDepth <= 0` makes that `false` immediately,
 * so recursion never starts at all (this is the exact boundary D2's own
 * adversarial review caught a bug in — see `docs/DECISIONS.md` D-099's
 * "Two real, distinct findings" — this implementation's own `while
 * (iterationDepth < maxDepth)` loop condition is the direct generalization
 * of that same guard to every round, not just the first).
 *
 * **Termination.** Standard `WITH RECURSIVE` semantics: the recursion
 * stops the moment a round produces zero new rows, or once `maxDepth`
 * rounds have run, whichever comes first — this function's own loop
 * mirrors both conditions exactly (`nextFrontier.length === 0` breaks
 * early; the `while` condition itself bounds total rounds to `maxDepth`).
 */
import type { FakeStoreState } from './state.js';

/** Field-for-field the same shape `resolver.ts`'s own exported `FrontierRow` is — independently declared here rather than imported, matching this project's own established preference (`docs/DECISIONS.md` D-022's precedent for `TupleKey`/`ReferenceTuple`) for a plain-data shape shared across a module boundary that isn't itself resolver-isolation-sensitive, just conventional low coupling. */
export interface DstFrontierRow {
  ns: string;
  id: string;
  relation: string;
  depth: number;
  path: string[];
}

function identityKey(ns: string, id: string, relation: string): string {
  return `${ns}:${id}#${relation}`;
}

/**
 * The real BFS — see this file's own top-of-file doc comment for the full
 * fidelity argument. `visibleAsOf` is threaded through exactly like every
 * other D2 snapshot-aware read (`shapes.ts`'s own `isVisible` rule):
 * `undefined` sees every currently-committed edge, a real `commitSeq`
 * ceiling sees only edges committed at or before that snapshot boundary.
 *
 * `now` (D-144, expiring tuples) mirrors the real `fetchReachableFrontier`'s
 * own added `where (rt.expires_at is null or rt.expires_at > now())`
 * clause: an edge whose tuple has already expired as of `now` is excluded
 * from traversal exactly as if it had been deleted. Defaults to the epoch
 * (`new Date(0)`) — matching this codebase's own "DST is deterministic, no
 * wall-clock reads" convention — so every existing call site that predates
 * this parameter and never sets any tuple's `expiresAt` is completely
 * unaffected: with no non-null `expiresAt` anywhere in their fixtures, the
 * filter is a no-op regardless of what `now` happens to be.
 */
export function fetchReachableFrontierVia(
  state: FakeStoreState,
  ns: string,
  id: string,
  relation: string,
  maxDepth: number,
  visibleAsOf: number | undefined,
  now: Date = new Date(0),
): DstFrontierRow[] {
  const seedRow: DstFrontierRow = {
    ns,
    id,
    relation,
    depth: 0,
    path: [identityKey(ns, id, relation)],
  };
  const allRows: DstFrontierRow[] = [seedRow];
  let frontier: DstFrontierRow[] = [seedRow];
  let iterationDepth = 0;

  while (iterationDepth < maxDepth) {
    // One round: every edge out of every row in the CURRENT frontier only
    // — never re-expanding a row from an earlier round (property 1 above).
    const candidatesByIdentity = new Map<string, DstFrontierRow>();
    for (const row of frontier) {
      const edges = state.relationTuples.filter(
        (t) =>
          t.objectNs === row.ns &&
          t.objectId === row.id &&
          t.relation === row.relation &&
          t.subjectRelation !== null &&
          (visibleAsOf === undefined || t.commitSeq <= visibleAsOf) &&
          // Delete-tombstone visibility — `RelationTupleRow.deletedAtCommitSeq`'s
          // own doc comment (`state.ts`) has the full MVCC argument; the exact
          // same rule `shapes.ts`'s own `isTupleVisible` states once and every
          // handler there reuses, deliberately re-derived inline here instead
          // of imported: this file already independently duplicates the
          // `commitSeq`/`visibleAsOf` line directly above rather than
          // importing `isVisible` from `shapes.ts` (and `shapes.ts` itself
          // imports `fetchReachableFrontierVia` FROM this file, so importing
          // back would be circular) — this is that same established
          // precedent, extended to the tombstone dimension.
          (t.deletedAtCommitSeq === undefined ||
            (visibleAsOf !== undefined && visibleAsOf < t.deletedAtCommitSeq)) &&
          (t.expiresAt === null || t.expiresAt.getTime() > now.getTime()), // D-144
      );
      for (const edge of edges) {
        // subjectRelation is checked !== null above, so this cast is safe
        // — TupleKey/RelationTupleRow types it string | null.
        const targetRelation = edge.subjectRelation as string;
        const key = identityKey(edge.subjectNs, edge.subjectId, targetRelation);
        if (row.path.includes(key)) continue; // per-row cycle guard (property 3)
        if (candidatesByIdentity.has(key)) continue; // per-iteration dedup (property 2) — first wins
        candidatesByIdentity.set(key, {
          ns: edge.subjectNs,
          id: edge.subjectId,
          relation: targetRelation,
          depth: row.depth + 1,
          path: [...row.path, key],
        });
      }
    }
    const nextFrontier = [...candidatesByIdentity.values()];
    if (nextFrontier.length === 0) break; // standard WITH RECURSIVE termination
    allRows.push(...nextFrontier);
    frontier = nextFrontier;
    iterationDepth += 1;
  }

  return allRows;
}
