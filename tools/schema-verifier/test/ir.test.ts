/**
 * `buildSchemaGraph`/`printSchemaGraph` — the schema verifier's own build
 * spec, §3 exit criteria: "IR builds for every schema in the repo's
 * fixtures; a printer dumps the graph in a readable form; round-trip test
 * proves the IR loses nothing the analysis needs."
 *
 * The round-trip check reconstructs each permission's `RewriteRule` (and
 * each relation's `subjectTypes`) purely by walking the built graph's own
 * edges, then deep-equals the result against the original `CompiledSchema`
 * this project's own real `compileSchema` produced — never against this
 * module's own internal state. If `buildSchemaGraph` silently dropped an
 * edge, mislabeled an operator, or lost a type restriction, this is what
 * would catch it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { generateRandomSchema } from '../../../src/schema/dsl/random.js';
import type {
  CompiledSchema,
  RewriteRule,
  SubjectTypeRef,
} from '../../../src/schema/dsl/types.js';
import { buildSchemaGraph, printSchemaGraph } from '../src/ir/index.js';
import type {
  ComputedUsersetEdge,
  ExclusionBaseEdge,
  ExclusionSubtractEdge,
  IntersectionChildEdge,
  NodeId,
  SchemaGraph,
  TupleToUsersetEdge,
  UnionChildEdge,
} from '../src/ir/index.js';

const FIXTURE_DIR = fileURLToPath(new URL('../../../schema/', import.meta.url));

/** Every real `.authz` fixture in the repo except the deliberately-invalid one — see the "malformed fixture" test below for why it's excluded. */
const REAL_FIXTURES = ['document.authz', 'example.authz', 'folder.authz', 'group.authz', 'org.authz'];

function loadFixture(filename: string): CompiledSchema {
  const source = readFileSync(FIXTURE_DIR + filename, 'utf8');
  const result = compileSchema(source);
  if (!result.ok) {
    throw new Error(`fixture ${filename} did not compile: ${result.errors.map((e) => e.message).join('; ')}`);
  }
  return result.schema;
}

// ---------------------------------------------------------------------------
// Round-trip reconstruction — test-only. Never part of the shipped IR API;
// this exists purely to prove the graph the builder produces is faithful.
// ---------------------------------------------------------------------------

/** A node reached as a union/intersection/exclusion child, or a tupleToUserset target: if it's a named node, the original rule at that position was a bare `computedUserset` reference (`resolve()`'s own shortcut — see `build.ts`); a synthetic node means real nested structure to recurse into. */
function reconstructReference(graph: SchemaGraph, id: NodeId): RewriteRule {
  const node = graph.nodes.get(id);
  if (!node) throw new Error(`reconstructReference: no such node ${id}`);
  if (node.kind === 'named') {
    return { kind: 'computedUserset', name: node.name };
  }
  return reconstructDefinition(graph, id);
}

/** Reconstructs the `RewriteRule` a node's own outgoing edges define. */
function reconstructDefinition(graph: SchemaGraph, id: NodeId): RewriteRule {
  const edges = graph.edgesFrom.get(id) ?? [];

  const computedUserset = edges.find((e): e is ComputedUsersetEdge => e.kind === 'computedUserset');
  if (computedUserset) {
    const target = graph.nodes.get(computedUserset.to);
    if (!target || target.kind !== 'named') {
      throw new Error(`reconstructDefinition: computedUserset edge from ${id} must target a named node`);
    }
    return { kind: 'computedUserset', name: target.name };
  }

  const tupleToUserset = edges.find((e): e is TupleToUsersetEdge => e.kind === 'tupleToUserset');
  if (tupleToUserset) {
    return {
      kind: 'tupleToUserset',
      relation: tupleToUserset.viaRelation,
      computedUserset: tupleToUserset.computedUserset,
    };
  }

  const unionChildren = edges.filter((e): e is UnionChildEdge => e.kind === 'unionChild');
  if (unionChildren.length > 0) {
    return { kind: 'union', children: unionChildren.map((e) => reconstructReference(graph, e.to)) };
  }

  const intersectionChildren = edges.filter((e): e is IntersectionChildEdge => e.kind === 'intersectionChild');
  if (intersectionChildren.length > 0) {
    return { kind: 'intersection', children: intersectionChildren.map((e) => reconstructReference(graph, e.to)) };
  }

  const base = edges.find((e): e is ExclusionBaseEdge => e.kind === 'exclusionBase');
  const subtract = edges.find((e): e is ExclusionSubtractEdge => e.kind === 'exclusionSubtract');
  if (base && subtract) {
    return {
      kind: 'exclusion',
      base: reconstructReference(graph, base.to),
      subtract: reconstructReference(graph, subtract.to),
    };
  }

  throw new Error(`reconstructDefinition: node ${id} has no recognizable rewrite-rule-shaped edges`);
}

/** Asserts every permission's rewrite tree, and every relation's subject-type list, round-trips exactly through the built graph. */
function assertRoundTrips(schema: CompiledSchema): void {
  const graph = buildSchemaGraph(schema);
  for (const ns of Object.values(schema.namespaces)) {
    for (const relation of Object.values(ns.relations)) {
      const id = `${ns.namespace}#${relation.name}`;
      const directEdge = graph.edgesFrom.get(id)?.find((e) => e.kind === 'direct');
      if (!directEdge || directEdge.kind !== 'direct') {
        throw new Error(`relation ${id} has no direct edge in the built graph`);
      }
      const reconstructed: SubjectTypeRef[] = directEdge.subjectTypes.map((st) =>
        st.relation === undefined ? { namespace: st.namespace } : { namespace: st.namespace, relation: st.relation },
      );
      expect(reconstructed, `relation ${id}'s subjectTypes`).toEqual(relation.subjectTypes);
    }
    for (const permission of Object.values(ns.permissions)) {
      const id = `${ns.namespace}#${permission.name}`;
      const reconstructed = reconstructDefinition(graph, id);
      expect(reconstructed, `permission ${id}'s rewrite tree`).toEqual(permission.rewrite);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSchemaGraph — builds for every real fixture', () => {
  it.each(REAL_FIXTURES)('%s compiles and builds a graph with no thrown error', (filename) => {
    const schema = loadFixture(filename);
    expect(() => buildSchemaGraph(schema)).not.toThrow();
  });

  it('the deliberately-invalid fixture (malformed-example.authz) never reaches buildSchemaGraph at all — it fails to compile first', () => {
    const source = readFileSync(FIXTURE_DIR + 'malformed-example.authz', 'utf8');
    const result = compileSchema(source);
    expect(result.ok).toBe(false);
    // No CompiledSchema exists for buildSchemaGraph to be handed here —
    // this fixture's own job is to prove the *compiler* rejects it, which
    // `test/unit/schema/schema-validation.test.ts` already covers; this
    // test exists only to document why it's excluded from REAL_FIXTURES
    // above rather than silently missing.
  });
});

describe('buildSchemaGraph — round-trip: the IR loses nothing the analysis needs', () => {
  it.each(REAL_FIXTURES)('%s: every permission and relation round-trips exactly', (filename) => {
    assertRoundTrips(loadFixture(filename));
  });

  it('300 random schemas (src/schema/dsl/random.ts, high option ceilings) all round-trip exactly', () => {
    for (let i = 0; i < 300; i += 1) {
      const { schema } = generateRandomSchema(`ir-roundtrip-${i}`, {
        namespaceCount: 5,
        principalCount: 2,
        maxRelationsPerNamespace: 5,
        maxPermissionsPerNamespace: 4,
        maxRewriteDepth: 4,
      });
      assertRoundTrips(schema);
    }
  }, 30_000);
});

describe('buildSchemaGraph — cycles are legal and represented, not rejected or unrolled away', () => {
  it("folder.edit's tupleToUserset edge is a genuine self-loop (folder#edit -> via parent -> folder#edit)", () => {
    // folder.edit = editor | owner | parent->edit (schema/example.authz) —
    // a top-level union, so per build.ts's own `resolve()` shortcut the
    // bare `editor`/`owner` children point straight at their named nodes,
    // but the `parent->edit` child is a `tupleToUserset` in *non*-top-level
    // position, which always gets a fresh synthetic node. The real
    // tupleToUserset edge lives on *that* node's own `edgesFrom`, not
    // directly on `folder#edit`.
    const graph = buildSchemaGraph(loadFixture('example.authz'));
    const unionChildren = (graph.edgesFrom.get('folder#edit') ?? []).filter(
      (e): e is UnionChildEdge => e.kind === 'unionChild',
    );
    const syntheticChild = unionChildren.find((e) => graph.nodes.get(e.to)?.kind === 'synthetic');
    expect(syntheticChild).toBeDefined();
    expect(graph.nodes.get(syntheticChild!.to)).toMatchObject({ kind: 'synthetic', rule: 'tupleToUserset' });

    const hop = (graph.edgesFrom.get(syntheticChild!.to) ?? []).find(
      (e): e is TupleToUsersetEdge => e.kind === 'tupleToUserset',
    );
    expect(hop).toBeDefined();
    expect(hop!.viaRelation).toBe('parent');
    expect(hop!.computedUserset).toBe('edit');
    expect(hop!.targets).toEqual([{ namespace: 'folder', target: 'folder#edit' }]);
  });

  it("group.member's own relation subject type is a genuine self-loop (a group's member set may itself be a group's member)", () => {
    const graph = buildSchemaGraph(loadFixture('group.authz'));
    const directEdge = graph.edgesFrom.get('group#member')?.find((e) => e.kind === 'direct');
    expect(directEdge).toBeDefined();
    if (directEdge?.kind !== 'direct') throw new Error('unreachable');
    const usersetEntry = directEdge.subjectTypes.find((st) => st.relation !== undefined);
    expect(usersetEntry).toEqual({ namespace: 'group', relation: 'member', target: 'group#member' });
  });

  it('buildSchemaGraph does not hang or recurse infinitely on a real self-referential schema (both folder.authz and the full four-namespace example.authz)', () => {
    // No explicit timeout needed beyond vitest's own default — a hang here
    // would fail this test by timing out, which is exactly the signal
    // that matters; an infinite loop during *construction* would mean
    // buildSchemaGraph itself walks a cycle rather than merely
    // representing one as data, which the design in build.ts's own doc
    // comment says never happens (RewriteRule trees are always finite —
    // only the resulting *graph*, across separate nodes, can cycle).
    expect(() => buildSchemaGraph(loadFixture('folder.authz'))).not.toThrow();
    expect(() => buildSchemaGraph(loadFixture('example.authz'))).not.toThrow();
  });
});

describe('buildSchemaGraph — nesting: synthetic nodes only where the tree genuinely branches', () => {
  it("folder.sensitive_review = (viewer | edit) & sensitive_reviewer builds one synthetic union node nested inside the top-level intersection, never a redundant hop for either bare leaf", () => {
    const graph = buildSchemaGraph(loadFixture('example.authz'));
    const topEdges = graph.edgesFrom.get('folder#sensitive_review') ?? [];
    const intersectionChildren = topEdges.filter((e): e is IntersectionChildEdge => e.kind === 'intersectionChild');
    expect(intersectionChildren).toHaveLength(2);

    // One child is the bare `sensitive_reviewer` relation, reached
    // directly — no synthetic node for it.
    const bareChild = intersectionChildren.find((e) => graph.nodes.get(e.to)?.kind === 'named');
    expect(bareChild).toBeDefined();
    expect(graph.nodes.get(bareChild!.to)).toMatchObject({ kind: 'named', name: 'sensitive_reviewer' });

    // The other child is the nested `(viewer | edit)` union, and *does*
    // get its own synthetic node — it has two union children of its own.
    const nestedChild = intersectionChildren.find((e) => graph.nodes.get(e.to)?.kind === 'synthetic');
    expect(nestedChild).toBeDefined();
    const nestedNode = graph.nodes.get(nestedChild!.to);
    expect(nestedNode).toMatchObject({ kind: 'synthetic', rule: 'union' });
    const nestedUnionChildren = (graph.edgesFrom.get(nestedChild!.to) ?? []).filter(
      (e): e is UnionChildEdge => e.kind === 'unionChild',
    );
    const nestedUnionChildNames = nestedUnionChildren.map((e) => {
      const node = graph.nodes.get(e.to);
      if (node?.kind !== 'named') throw new Error('expected a named node');
      return node.name;
    });
    expect(nestedUnionChildNames.sort()).toEqual(['edit', 'viewer']);
  });
});

describe('printSchemaGraph — readable, deterministic output', () => {
  it('is non-empty and stable across two calls on the same graph', () => {
    const graph = buildSchemaGraph(loadFixture('example.authz'));
    const first = printSchemaGraph(graph);
    const second = printSchemaGraph(graph);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  it('is stable across two independently-built graphs from the same schema (not just the same graph object)', () => {
    const schemaA = loadFixture('example.authz');
    const schemaB = loadFixture('example.authz');
    expect(printSchemaGraph(buildSchemaGraph(schemaA))).toBe(printSchemaGraph(buildSchemaGraph(schemaB)));
  });

  it('names every real node and every real edge kind from a schema exercising all five rewrite-rule kinds (example.authz, per its own header comment)', () => {
    const output = printSchemaGraph(buildSchemaGraph(loadFixture('example.authz')));
    // Nodes named by (namespace, member) exactly:
    for (const id of ['org#view', 'org#member', 'org#banned', 'folder#sensitive_review', 'group#member']) {
      expect(output).toContain(id);
    }
    // Every edge kind this fixture is documented to exercise:
    expect(output).toMatch(/exclusionBase:/); // org.view = member - banned
    expect(output).toMatch(/exclusionSubtract:/);
    expect(output).toMatch(/intersectionChild:/); // folder.sensitive_review
    expect(output).toMatch(/tupleToUserset:/); // parent->edit / parent->view
    expect(output).toMatch(/unionChild:/); // every view/edit permission
    expect(output).toMatch(/computedUserset:/); // e.g. folder.edit's `editor` leaf
    expect(output).toMatch(/direct:/); // every relation
  });
});
