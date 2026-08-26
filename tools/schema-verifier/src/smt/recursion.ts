/**
 * Recursion detection for the SMT tier — new work, not part of the build
 * spec's own five phases (§5–§9). The SMT sketch (`docs/DECISIONS.md`,
 * the entry documenting §7's bounded search) is explicit about why
 * recursion is the real obstacle: "a relation whose rewrite tree refers
 * back to itself (directly, or via a cycle through other relations)
 * makes 'recursively expand into a formula' not terminate as plain
 * first-order logic." `../smt/encode.ts` inlines a permission's rewrite
 * tree directly into a quantifier-free formula — a genuine cycle in the
 * reachable subgraph would make that inlining recurse forever. This
 * module answers, up front, per invariant goal: does the subgraph
 * reachable from this goal contain one?
 *
 * **Why this is a new cycle-detection function, not a reuse of an
 * existing one — checked directly, not assumed.** Two things in this
 * codebase already detect "a cycle" and both were considered first:
 *
 * 1. `src/schema/dsl/compiler.ts`'s `checkCircularPermissions` — the
 *    compiler's own static cycle check. Deliberately narrower than what
 *    this module needs: it only flags a permission cycle with "no
 *    relation ... anywhere in the cycle to ground it," and explicitly
 *    excludes any `tupleToUserset` edge from its own cycle graph (that
 *    file's own doc comment: "tuple_to_userset edges never contribute to
 *    this graph"). That exclusion is *correct* for the compiler's own
 *    question (a `tupleToUserset`-mediated cycle is always resolvable at
 *    runtime by the real engine's own `CHECK_MAX_DEPTH`/cycle-guard, so
 *    it's not a compile-time error) but *wrong* for this one: a
 *    `tupleToUserset` self-reference (`folder.edit = editor | owner |
 *    parent->edit`, found live against this repo's own
 *    `schema/example.authz` while grounding this very module — see
 *    `docs/DECISIONS.md`) is exactly the shape that makes naive formula
 *    inlining non-terminating, and the compiler's own detector would
 *    call that schema acyclic. Reusing it here would silently mis-scope
 *    this tier onto schemas it cannot actually handle.
 * 2. `../reachability/fragment.ts`'s `scanReachability` — a BFS with a
 *    visited-once set. Correct for "what's reachable" (its own job), but
 *    a visited-once BFS cannot distinguish a genuine back-edge (a real
 *    cycle) from benign multi-path convergence (a diamond: two branches
 *    of a union both reaching the same downstream relation is not a
 *    cycle, and must not be flagged as one). Detecting an actual cycle
 *    needs a DFS with a *recursion-stack* (which nodes are ancestors of
 *    the current path, not just "seen at all") — a different algorithm
 *    shape, not a parameterization of the same one.
 *
 * What *is* reused: `scanReachability`'s own `childrenOf` (this file's
 * sibling, `../reachability/fragment.ts`, now exported for exactly this
 * reuse) — the edge-kind-agnostic "what does this edge lead to" mapping,
 * so this module's own traversal can never quietly disagree with
 * `scanReachability`'s about what counts as a graph edge.
 *
 * The algorithm itself (white/grey/black DFS coloring, iterative via an
 * explicit worklist stack rather than native recursion) deliberately
 * follows `checkCircularPermissions`'s own established discipline
 * (`src/schema/dsl/compiler.ts`'s own doc comment: a long flat chain
 * drove a previous *recursive* version of that exact algorithm to
 * overflow Node's real call stack) — the same technique, applied to a
 * different graph, not a second graph-walking implementation invented
 * from scratch.
 */
import { childrenOf } from '../reachability/fragment.js';
import type { NodeId, SchemaGraph } from '../ir/types.js';

const WHITE = 0;
const GREY = 1;
const BLACK = 2;

interface DfsFrame {
  readonly nodeId: NodeId;
  childIndex: number;
  children: readonly NodeId[];
}

/**
 * True iff some node reachable from `goalNodeId` (over every edge kind,
 * matching `scanReachability`'s own edge-agnostic walk) is reachable from
 * itself — i.e. the reachable subgraph contains a genuine cycle, not
 * merely a diamond. Iterative DFS with grey (on-path)/black (fully
 * explored) coloring: a grey node reached again is a real back-edge.
 */
export function isRecursive(graph: SchemaGraph, goalNodeId: NodeId): boolean {
  const color = new Map<NodeId, 0 | 1 | 2>();
  const stack: DfsFrame[] = [];

  function pushFrame(nodeId: NodeId): void {
    color.set(nodeId, GREY);
    const children = (graph.edgesFrom.get(nodeId) ?? []).flatMap((e) => childrenOf(e));
    stack.push({ nodeId, childIndex: 0, children });
  }

  if (!graph.nodes.has(goalNodeId)) return false; // unreachable for a real invariant already validated by checkInvariant — defensive only.
  pushFrame(goalNodeId);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.childIndex < frame.children.length) {
      const child = frame.children[frame.childIndex]!;
      frame.childIndex += 1;
      const childColor = color.get(child) ?? WHITE;
      if (childColor === GREY) {
        return true; // a genuine back-edge: `child` is an ancestor of the current path.
      } else if (childColor === WHITE) {
        pushFrame(child);
      }
      // BLACK: already fully explored with no cycle found through it — never re-enter.
    } else {
      color.set(frame.nodeId, BLACK);
      stack.pop();
    }
  }

  return false;
}
