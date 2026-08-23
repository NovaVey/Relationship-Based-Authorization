/**
 * The schema-graph intermediate representation — see this project's own
 * scoped build spec, §3 ("Schema graph IR"). This is the structure every
 * later phase (reachability, witness construction, fragment detection)
 * walks; nothing downstream ever re-reads `CompiledSchema` directly.
 *
 * Nodes are `(namespace, relation-or-permission)` pairs — a `NamedNode` —
 * plus a second kind, `SyntheticNode`, for a rewrite-rule position that
 * isn't itself an addressable relation/permission but still needs its own
 * node identity to hang edges off of: a `union`/`intersection`/`exclusion`
 * combinator (which may have several children, each needing its own
 * outgoing-edge scope distinct from its siblings), and a `tupleToUserset`
 * hop that appears anywhere other than a permission's own top-level rule
 * (it carries real metadata — `viaRelation`, `computedUserset`, per-
 * namespace targets — that only fits on an edge *from* some node, and a
 * nested `tupleToUserset` has no pre-existing named node to be that edge's
 * source).
 *
 * A permission's own `NamedNode` gets edges built directly from its
 * top-level rewrite rule, whatever kind that rule is — never a redundant
 * "delegate to a fresh node" hop for the common case
 * (`permission view = member`, a bare `computedUserset`). A synthetic node
 * is created only where the tree genuinely branches or carries extra
 * metadata a plain node reference can't.
 */
import type { SubjectTypeRef } from '../../../../src/schema/dsl/types.js';

/**
 * `${namespace}#${name}` for a `NamedNode` (matching this DSL's own
 * `namespace#relation` convention for referring to one member of one
 * namespace — see `SubjectTypeRef`); `${namespace}#${permission}$op${n}`
 * for a `SyntheticNode`, scoped and numbered per permission so ids are
 * deterministic and stable across rebuilds of the identical schema. The
 * `$` can never collide with a real identifier — `IDENTIFIER_PATTERN`
 * (`src/schema/dsl/types.ts`) only ever allows `[a-z][a-z0-9_]*`.
 */
export type NodeId = string;

export interface NamedNode {
  readonly kind: 'named';
  readonly id: NodeId;
  readonly namespace: string;
  readonly name: string;
  readonly nodeKind: 'relation' | 'permission';
}

export interface SyntheticNode {
  readonly kind: 'synthetic';
  readonly id: NodeId;
  readonly namespace: string;
  /** Which rewrite-rule kind this node stands in for. */
  readonly rule: 'union' | 'intersection' | 'exclusion' | 'tupleToUserset';
  /** The permission whose rewrite tree this node was created while walking — for printing only, never load-bearing for analysis. */
  readonly owner: string;
}

export type GraphNode = NamedNode | SyntheticNode;

/**
 * A relation's own subject-type list, exactly as declared — the "terminal
 * edge; carries the type restriction list" the build spec calls for. One
 * `DirectEdge` per relation, not one per subject type: the whole
 * restriction list is the edge's payload, since a witness only ever needs
 * to pick *one* satisfying entry from it, not treat each as independently
 * reachable. A bare (principal) entry has no `target` — nothing further to
 * walk, satisfied directly by naming an object of that type. A userset
 * entry (`namespace#relation`) has a `target` *only* when that namespace
 * is declared in this compilation unit — `compiler.ts`'s own relation
 * subject-type check is a *soft* one (an undeclared target namespace is
 * left unchecked, not rejected — see `compileRelations`), so an edge with
 * no resolvable target is a real, disclosed possibility, not a bug.
 */
export interface DirectEdge {
  readonly kind: 'direct';
  readonly from: NodeId;
  readonly subjectTypes: ReadonlyArray<{
    readonly namespace: string;
    readonly relation?: string;
    readonly target?: NodeId;
  }>;
}

/** `editor implies viewer` — same object, zero cost. `to` may name a relation or a permission (`ComputedUsersetRule`'s own contract). */
export interface ComputedUsersetEdge {
  readonly kind: 'computedUserset';
  readonly from: NodeId;
  readonly to: NodeId;
}

/**
 * `viewer from parent` — the edge the build spec calls out by name as "the
 * one to get exactly right." Two-part: `viaRelation` must be walked as a
 * real tuple to a second object, and `computedUserset` must hold on that
 * object's own namespace. `hopSubjectTypes` is `viaRelation`'s own subject-
 * type list (the type restriction bounding which namespaces the hop can
 * actually land in); `targets` resolves `computedUserset` against each
 * *distinct* namespace among them — `compiler.ts`'s tupleToUserset check is
 * strict (unlike a plain relation subject type's soft check): every one of
 * `viaRelation`'s subject-type namespaces must both be declared in this
 * compilation unit and declare `computedUserset` as a relation or
 * permission, or the schema would never have compiled — so `targets` is
 * always fully resolved, one entry per distinct namespace in
 * `hopSubjectTypes`, never partial.
 */
export interface TupleToUsersetEdge {
  readonly kind: 'tupleToUserset';
  readonly from: NodeId;
  readonly viaRelation: string;
  readonly hopSubjectTypes: ReadonlyArray<SubjectTypeRef>;
  readonly computedUserset: string;
  readonly targets: ReadonlyArray<{ readonly namespace: string; readonly target: NodeId }>;
}

/** One branch of a `union` — satisfied if `to` is satisfied. Multiple `UnionChildEdge`s from the same `from` are OR'd together. */
export interface UnionChildEdge {
  readonly kind: 'unionChild';
  readonly from: NodeId;
  readonly to: NodeId;
}

/** One branch of an `intersection` — every `IntersectionChildEdge` from the same `from` must be satisfied (AND). */
export interface IntersectionChildEdge {
  readonly kind: 'intersectionChild';
  readonly from: NodeId;
  readonly to: NodeId;
}

/** The positive branch of an `exclusion` (`base - subtract`) — exactly one per `from`. */
export interface ExclusionBaseEdge {
  readonly kind: 'exclusionBase';
  readonly from: NodeId;
  readonly to: NodeId;
}

/** The subtracted branch of an `exclusion` — exactly one per `from`, paired with that same `from`'s `ExclusionBaseEdge`. */
export interface ExclusionSubtractEdge {
  readonly kind: 'exclusionSubtract';
  readonly from: NodeId;
  readonly to: NodeId;
}

export type GraphEdge =
  | DirectEdge
  | ComputedUsersetEdge
  | TupleToUsersetEdge
  | UnionChildEdge
  | IntersectionChildEdge
  | ExclusionBaseEdge
  | ExclusionSubtractEdge;

export interface SchemaGraph {
  readonly nodes: ReadonlyMap<NodeId, GraphNode>;
  readonly edges: readonly GraphEdge[];
  /** Every edge, grouped by `from` — O(1) outgoing-edge lookup for traversal, never recomputed by a caller. */
  readonly edgesFrom: ReadonlyMap<NodeId, readonly GraphEdge[]>;
}
