/**
 * Fragment detection — build spec §7: "if the schema uses only the
 * monotone fragment, the verifier is exact — sound and complete. Say
 * that." Reused for the same traversal §7's bounded search needs to know
 * which relations are even worth generating candidate tuples for
 * (`../bounded/candidates.ts`) — both questions are "walk everything
 * reachable from the goal, regardless of edge kind."
 */
import type { GraphEdge, NodeId, SchemaGraph } from '../ir/types.js';
import type { Fragment } from './types.js';

export type { Fragment } from './types.js';

interface ReachabilityScan {
  readonly fragment: Fragment;
  /** Every relation (never permission) node reached, in visitation order — §7's bounded search draws its candidate tuples from exactly this set. */
  readonly relations: readonly NodeId[];
}

/**
 * Every child a graph edge can lead to, regardless of kind — walking this
 * is deliberately edge-kind-agnostic: unlike §5's search, this never stops
 * at an intersection/exclusion edge, it just keeps going. Exported for
 * `../smt/recursion.ts`, which needs the identical edge-kind-agnostic
 * child function to walk the exact same reachable subgraph this scan
 * does, for a different question (is there a real cycle, not just "what's
 * reachable") — reusing this rather than re-deriving a second "what does
 * this edge lead to" mapping that could quietly drift from this one.
 */
export function childrenOf(edge: GraphEdge): readonly NodeId[] {
  switch (edge.kind) {
    case 'direct':
      return edge.subjectTypes.flatMap((st) => (st.target !== undefined ? [st.target] : []));
    case 'computedUserset':
    case 'unionChild':
    case 'intersectionChild':
    case 'exclusionBase':
    case 'exclusionSubtract':
      return [edge.to];
    case 'tupleToUserset':
      return edge.targets.map((t) => t.target);
    default: {
      const _never: never = edge;
      throw new Error(`fragment scan: unhandled edge kind ${JSON.stringify(_never)}`);
    }
  }
}

/**
 * Walks every node reachable from `goalNodeId`, over every edge kind,
 * with no early stop at intersection/exclusion (that's exactly what
 * distinguishes this from §5's search). Returns `'non-monotone'` the
 * moment any `intersectionChild`/`exclusionBase`/`exclusionSubtract`
 * edge is found anywhere in the reachable subgraph, plus every relation
 * node reached along the way (deduplicated, cycle-safe via a visited set
 * — same "cycles are legal, never re-explore a visited node" discipline
 * as §5's own search).
 */
export function scanReachability(graph: SchemaGraph, goalNodeId: NodeId): ReachabilityScan {
  let fragment: Fragment = 'monotone';
  const relations: NodeId[] = [];
  const relationsSeen = new Set<NodeId>();
  const visited = new Set<NodeId>();
  const queue: NodeId[] = [goalNodeId];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = graph.nodes.get(nodeId);
    if (node?.kind === 'named' && node.nodeKind === 'relation' && !relationsSeen.has(nodeId)) {
      relationsSeen.add(nodeId);
      relations.push(nodeId);
    }

    for (const edge of graph.edgesFrom.get(nodeId) ?? []) {
      if (
        edge.kind === 'intersectionChild' ||
        edge.kind === 'exclusionBase' ||
        edge.kind === 'exclusionSubtract'
      ) {
        fragment = 'non-monotone';
      }
      for (const child of childrenOf(edge)) {
        if (!visited.has(child)) queue.push(child);
      }
    }
  }

  return { fragment, relations };
}
