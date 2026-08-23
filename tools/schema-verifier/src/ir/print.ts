/**
 * `printSchemaGraph` — dumps a `SchemaGraph` in a stable, readable,
 * deterministic-order text form. Purely diagnostic: nothing else in this
 * tool reads this output back (`buildSchemaGraph` is the only source of
 * truth for the graph itself) — this exists so a human, or a test, can
 * confirm the graph actually looks like the schema it was built from.
 */
import type { GraphEdge, GraphNode, NodeId, SchemaGraph } from './types.js';

function describeNode(node: GraphNode): string {
  if (node.kind === 'named') {
    return `${node.id} (${node.nodeKind})`;
  }
  return `${node.id} (synthetic ${node.rule}, inside ${node.namespace}#${node.owner})`;
}

function describeEdge(edge: GraphEdge): string {
  switch (edge.kind) {
    case 'direct': {
      const types = edge.subjectTypes
        .map((st) => {
          if (st.relation === undefined) return st.namespace;
          const suffix = st.target === undefined ? ' [unresolved: not declared in this unit]' : '';
          return `${st.namespace}#${st.relation}${suffix}`;
        })
        .join(' | ');
      return `  direct: ${edge.from} accepts [${types}]`;
    }
    case 'computedUserset':
      return `  computedUserset: ${edge.from} -> ${edge.to}`;
    case 'tupleToUserset': {
      const targets = edge.targets.map((t) => `${t.namespace} -> ${t.target}`).join(', ');
      return `  tupleToUserset: ${edge.from} via '${edge.viaRelation}' then '${edge.computedUserset}' {${targets}}`;
    }
    case 'unionChild':
      return `  unionChild: ${edge.from} | ${edge.to}`;
    case 'intersectionChild':
      return `  intersectionChild: ${edge.from} & ${edge.to}`;
    case 'exclusionBase':
      return `  exclusionBase: ${edge.from} base=${edge.to}`;
    case 'exclusionSubtract':
      return `  exclusionSubtract: ${edge.from} subtract=${edge.to}`;
    default: {
      const _never: never = edge;
      throw new Error(`printSchemaGraph: unhandled edge kind ${JSON.stringify(_never)}`);
    }
  }
}

/**
 * Deterministic node ordering: named nodes first (namespace, then name,
 * both lexicographic — independent of `Object.values` iteration order,
 * which for a `Record` follows insertion order, itself dependent on
 * source-text declaration order, not something this printer's own output
 * should be sensitive to), then synthetic nodes (owner permission, then
 * numeric suffix). Each node's own edges follow it immediately, in the
 * order `buildSchemaGraph` produced them (children in source order).
 */
function sortedNodeIds(nodes: ReadonlyMap<NodeId, GraphNode>): NodeId[] {
  const named: NodeId[] = [];
  const synthetic: NodeId[] = [];
  for (const node of nodes.values()) {
    (node.kind === 'named' ? named : synthetic).push(node.id);
  }
  named.sort((a, b) => a.localeCompare(b));
  synthetic.sort((a, b) => a.localeCompare(b));
  return [...named, ...synthetic];
}

export function printSchemaGraph(graph: SchemaGraph): string {
  const lines: string[] = [];
  for (const id of sortedNodeIds(graph.nodes)) {
    const node = graph.nodes.get(id);
    if (!node) continue; // unreachable — id came from graph.nodes itself
    lines.push(describeNode(node));
    for (const edge of graph.edgesFrom.get(id) ?? []) {
      lines.push(describeEdge(edge));
    }
  }
  return lines.join('\n') + '\n';
}
