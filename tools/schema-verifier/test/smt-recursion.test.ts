/**
 * `../src/smt/recursion.ts`'s `isRecursive` — the SMT tier's own,
 * explicit boundary (`docs/DECISIONS.md`'s own SMT sketch names
 * recursion as the real, out-of-scope obstacle: "a relation whose
 * rewrite tree refers back to itself, directly or via a cycle through
 * other relations"). Two things checked here: `isRecursive` itself gives
 * the right answer on both a genuinely cyclic and a genuinely acyclic
 * real graph, and — the more important claim — a genuinely recursive,
 * non-monotone goal correctly makes `trySmtTier` decline entirely, so
 * `checkAndValidate` falls through to bounded search *exactly as it did
 * before this tier existed*, confirmed by bounded search's own
 * pre-existing behavior still firing (not merely "some other tier
 * returned something").
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import type { CompiledSchema } from '../../../src/schema/dsl/types.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import { parseInvariants } from '../src/invariants/index.js';
import { checkAndValidate } from '../src/validate/index.js';
import { trySmtTier } from '../src/smt/index.js';
import { isRecursive } from '../src/smt/recursion.js';

const SCHEMA_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/schemas/', import.meta.url));
const REAL_SCHEMA_DIR = fileURLToPath(new URL('../../../schema/', import.meta.url));

function loadSchema(dir: string, filename: string): CompiledSchema {
  const result = compileSchema(readFileSync(dir + filename, 'utf8'));
  if (!result.ok) {
    throw new Error(
      `schema ${filename} did not compile: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return result.schema;
}

describe('isRecursive — a genuine cycle, not merely a diamond', () => {
  it('non-monotone.authz — document#approve/document#publish are genuinely acyclic (no relation refers back to itself)', () => {
    const schema = loadSchema(SCHEMA_FIXTURE_DIR, 'non-monotone.authz');
    const graph = buildSchemaGraph(schema);
    expect(isRecursive(graph, 'document#approve')).toBe(false);
    expect(isRecursive(graph, 'document#publish')).toBe(false);
  });

  it('self-referential-folder.authz — folder#view is genuinely recursive (parent->view targets folder#view itself, a real back-edge)', () => {
    const schema = loadSchema(SCHEMA_FIXTURE_DIR, 'self-referential-folder.authz');
    const graph = buildSchemaGraph(schema);
    expect(isRecursive(graph, 'folder#view')).toBe(true);
  });

  it("the real schema/example.authz — folder#edit and folder#view are both genuinely recursive via parent->edit/parent->view's own self-reference (confirmed directly against the built graph, not assumed from the DSL text alone)", () => {
    const schema = loadSchema(REAL_SCHEMA_DIR, 'example.authz');
    const graph = buildSchemaGraph(schema);
    expect(isRecursive(graph, 'folder#edit')).toBe(true);
    expect(isRecursive(graph, 'folder#view')).toBe(true);
    // group#member's own nested-group membership (`member: user |
    // group#member`) is a second, independent source of recursion in
    // this same real schema — org#view (`member - banned`) reaches it
    // via org#member, so it's recursive too, for a different reason than
    // folder's own parent hierarchy.
    expect(isRecursive(graph, 'group#member')).toBe(true);
    expect(isRecursive(graph, 'org#view')).toBe(true);
  });

  it("tenancy.authz — private_document#view (owner only, no group nesting anywhere in reach) is not recursive; document#view IS (tenant->member reaches organization.member's own group#member nested-group self-reference, confirmed directly rather than assumed)", () => {
    const schema = loadSchema(SCHEMA_FIXTURE_DIR, 'tenancy.authz');
    const graph = buildSchemaGraph(schema);
    expect(isRecursive(graph, 'private_document#view')).toBe(false);
    expect(isRecursive(graph, 'document#view')).toBe(true);
  });
});

describe('a recursive, non-monotone goal makes the SMT tier decline entirely — bounded search fires exactly as before this tier existed', () => {
  it("the real schema/example.authz's own banned_member_never_views_org (org.view = member - banned, non-monotone AND recursive via nested groups) — trySmtTier returns undefined, checkAndValidate still falls back to bounded search with proof: 'bounded'", async () => {
    const schema = loadSchema(REAL_SCHEMA_DIR, 'example.authz');
    const graph = buildSchemaGraph(schema);
    const parsed = parseInvariants(readFileSync(REAL_SCHEMA_DIR + 'example.invariant', 'utf8'));
    if (!parsed.ok) throw new Error('schema/example.invariant failed to parse');
    const invariant = parsed.invariants[0]!;
    expect(invariant.name).toBe('banned_member_never_views_org');

    // Directly: the tier itself declines, not merely "something else also
    // happened to produce the same answer downstream."
    const direct = await trySmtTier(graph, schema, invariant);
    expect(direct).toBeUndefined();

    // End to end: checkAndValidate's own fallback to bounded search is
    // unaffected — same verdict, same bound, same 'bounded' proof this
    // fixture has always had (docs/DECISIONS.md D-123).
    const { result, validation } = await checkAndValidate(graph, schema, invariant);
    expect(result.verdict).toBe('HOLDS');
    expect(result.fragment).toBe('non-monotone');
    expect(result.proof).toBe('bounded');
    expect(result.bound).toBe(1);
    expect(validation).toEqual({ kind: 'not-applicable' });
  });
});
