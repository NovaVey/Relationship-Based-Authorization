/**
 * `buildSchemaGraph` — turns an already-compiled `CompiledSchema` into the
 * schema-graph IR (`./types.ts`). Imports the real parser/compiler's
 * output type; never re-implements or re-validates schema semantics — a
 * caller passes in whatever `compileSchema` (`src/schema/dsl/compiler.ts`)
 * already accepted, and every "this should be impossible" branch below
 * exists only to fail loudly if that premise is ever violated, never as
 * real, expected control flow.
 */
import type {
  CompiledPermission,
  CompiledRelation,
  CompiledSchema,
  RewriteRule,
} from '../../../../src/schema/dsl/types.js';
import type {
  DirectEdge,
  GraphEdge,
  GraphNode,
  NodeId,
  SchemaGraph,
} from './types.js';

function namedNodeId(namespace: string, name: string): NodeId {
  return `${namespace}#${name}`;
}

/** Builds the schema graph for one compiled schema (one or more namespaces, already validated). */
export function buildSchemaGraph(schema: CompiledSchema): SchemaGraph {
  const nodes = new Map<NodeId, GraphNode>();
  const edges: GraphEdge[] = [];

  // Pass 1: register every relation and permission as a NamedNode, up
  // front, so cross-namespace and forward references (this DSL's own
  // compiler resolves both — see `buildLookup`'s two-pass design) always
  // find a real node id waiting for them in pass 2, regardless of which
  // namespace or member ordering the source declared them in.
  for (const ns of Object.values(schema.namespaces)) {
    for (const relation of Object.values(ns.relations)) {
      const id = namedNodeId(ns.namespace, relation.name);
      nodes.set(id, { kind: 'named', id, namespace: ns.namespace, name: relation.name, nodeKind: 'relation' });
    }
    for (const permission of Object.values(ns.permissions)) {
      const id = namedNodeId(ns.namespace, permission.name);
      nodes.set(id, { kind: 'named', id, namespace: ns.namespace, name: permission.name, nodeKind: 'permission' });
    }
  }

  // Pass 2: edges. Relations first (simple, no recursion), then every
  // permission's rewrite tree.
  for (const ns of Object.values(schema.namespaces)) {
    for (const relation of Object.values(ns.relations)) {
      edges.push(buildDirectEdge(ns.namespace, relation, nodes));
    }
    for (const permission of Object.values(ns.permissions)) {
      buildPermissionEdges(ns.namespace, permission, ns.relations, nodes, edges);
    }
  }

  const edgesFrom = new Map<NodeId, GraphEdge[]>();
  for (const edge of edges) {
    const bucket = edgesFrom.get(edge.from);
    if (bucket) {
      bucket.push(edge);
    } else {
      edgesFrom.set(edge.from, [edge]);
    }
  }

  return { nodes, edges, edgesFrom };
}

function buildDirectEdge(
  namespace: string,
  relation: CompiledRelation,
  nodes: ReadonlyMap<NodeId, GraphNode>,
): DirectEdge {
  const subjectTypes = relation.subjectTypes.map((st) => {
    if (st.relation === undefined) {
      return { namespace: st.namespace };
    }
    const target = namedNodeId(st.namespace, st.relation);
    // `exactOptionalPropertyTypes` (this repo's own strict-by-default
    // convention — see `makeSchemaError`, `src/schema/dsl/errors.ts`, for
    // the same pattern): `target` is omitted entirely when unresolved,
    // never explicitly set to `undefined`.
    return {
      namespace: st.namespace,
      relation: st.relation,
      ...(nodes.has(target) ? { target } : {}),
    };
  });
  return { kind: 'direct', from: namedNodeId(namespace, relation.name), subjectTypes };
}

function buildPermissionEdges(
  namespace: string,
  permission: CompiledPermission,
  relations: Readonly<Record<string, CompiledRelation>>,
  nodes: Map<NodeId, GraphNode>,
  edges: GraphEdge[],
): void {
  const permissionId = namedNodeId(namespace, permission.name);
  let opCounter = 0;
  const freshSyntheticId = (): NodeId => {
    opCounter += 1;
    return `${namespace}#${permission.name}$op${opCounter}`;
  };

  /** Gives `id` (already registered) its own outgoing edges, matching `rule`'s top-level shape exactly — no extra hop. */
  function defineNode(id: NodeId, rule: RewriteRule): void {
    switch (rule.kind) {
      case 'computedUserset': {
        // `rule.name` may name a relation or a permission on this same
        // namespace (`ComputedUsersetRule`'s own contract) — both were
        // registered as NamedNodes in pass 1, so no branching needed here.
        edges.push({ kind: 'computedUserset', from: id, to: namedNodeId(namespace, rule.name) });
        return;
      }
      case 'tupleToUserset': {
        const relation = relations[rule.relation];
        if (!relation) {
          // Unreachable for a real CompiledSchema: compiler.ts's own
          // compileRewriteRule rejects a tupleToUserset naming an
          // undeclared or non-relation target before this schema could
          // ever have compiled. buildSchemaGraph only ever accepts an
          // already-compiled schema — it does not re-validate one.
          throw new Error(
            `buildSchemaGraph: permission '${permission.name}' on namespace '${namespace}' follows undeclared relation '${rule.relation}' — this schema should never have compiled`,
          );
        }
        const targetsByNamespace = new Map<string, NodeId>();
        for (const st of relation.subjectTypes) {
          targetsByNamespace.set(st.namespace, namedNodeId(st.namespace, rule.computedUserset));
        }
        edges.push({
          kind: 'tupleToUserset',
          from: id,
          viaRelation: rule.relation,
          hopSubjectTypes: relation.subjectTypes,
          computedUserset: rule.computedUserset,
          targets: [...targetsByNamespace].map(([ns, target]) => ({ namespace: ns, target })),
        });
        return;
      }
      case 'union': {
        for (const child of rule.children) {
          edges.push({ kind: 'unionChild', from: id, to: resolve(child) });
        }
        return;
      }
      case 'intersection': {
        for (const child of rule.children) {
          edges.push({ kind: 'intersectionChild', from: id, to: resolve(child) });
        }
        return;
      }
      case 'exclusion': {
        edges.push({ kind: 'exclusionBase', from: id, to: resolve(rule.base) });
        edges.push({ kind: 'exclusionSubtract', from: id, to: resolve(rule.subtract) });
        return;
      }
      default: {
        const _never: never = rule;
        throw new Error(`buildSchemaGraph: unhandled rewrite-rule kind ${JSON.stringify(_never)}`);
      }
    }
  }

  /**
   * Returns the `NodeId` whose truth value equals `rule`'s — the id to
   * put on a parent edge's `to`. A bare `computedUserset` child needs no
   * new node at all; it points straight at the existing target. Every
   * other kind (a nested combinator, or a `tupleToUserset` in non-top-
   * level position) gets a fresh `SyntheticNode`, defined recursively by
   * `defineNode`.
   */
  function resolve(rule: RewriteRule): NodeId {
    if (rule.kind === 'computedUserset') {
      return namedNodeId(namespace, rule.name);
    }
    const id = freshSyntheticId();
    nodes.set(id, { kind: 'synthetic', id, namespace, rule: rule.kind, owner: permission.name });
    defineNode(id, rule);
    return id;
  }

  defineNode(permissionId, permission.rewrite);
}
