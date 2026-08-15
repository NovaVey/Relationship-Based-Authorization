/**
 * Reference resolver (Phase 3) tests — the independent depth budget.
 *
 * Written from `.claude/commands/build-authz-service.md` §6.4 ("CHECK_MAX_DEPTH
 * is a hard ceiling independent of cycle detection, so a very deep but
 * acyclic chain still terminates") and the `ReferenceCheckOptions`
 * interface (`maxDepth?: number`, default 1000 exported as
 * `DEFAULT_REFERENCE_MAX_DEPTH`) handed down for this task. Per §14
 * delegation rule 5, `src/resolve/reference/resolver.ts` was deliberately
 * NOT read while writing this test.
 *
 * An explicit small `maxDepth` is passed rather than relying on the
 * default of 1000, so the test runs fast and is unambiguously testing the
 * ceiling itself rather than incidentally exercising the default.
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { formatSchemaError } from '../../../src/schema/dsl/errors.js';
import type { CompiledSchema } from '../../../src/schema/dsl/types.js';
import { referenceCheck } from '../../../src/resolve/reference/resolver.js';
import type { EntityRef, ReferenceTuple } from '../../../src/resolve/reference/resolver.js';

function compileOk(source: string): CompiledSchema {
  const result = compileSchema(source);
  if (!result.ok) {
    throw new Error(
      `expected schema to compile, got errors:\n${result.errors.map(formatSchemaError).join('\n')}`,
    );
  }
  return result.schema;
}

function ref(ns: string, id: string): EntityRef {
  return { ns, id };
}

function tuple(
  objectNs: string,
  objectId: string,
  relation: string,
  subjectNs: string,
  subjectId: string,
): ReferenceTuple {
  return { objectNs, objectId, relation, subjectNs, subjectId };
}

const SOURCE = [
  'namespace folder {',
  '  relation parent: folder',
  '  relation editor: user',
  '',
  '  permission view = editor | parent->view',
  '}',
].join('\n');

// A genuinely deep, acyclic chain: folder:f0 -> parent -> f1 -> ... -> f14
// (14 hops, 15 nodes), with the only grant sitting at the very end. This is
// not a cycle — cycle detection alone must not be what's relied on to stop
// it; the depth budget must.
const CHAIN_LENGTH = 15;
function buildChainTuples(grantedSubjectId: string): ReferenceTuple[] {
  const tuples: ReferenceTuple[] = [];
  for (let i = 0; i < CHAIN_LENGTH - 1; i++) {
    tuples.push(tuple('folder', `f${i}`, 'parent', 'folder', `f${i + 1}`));
  }
  tuples.push(tuple('folder', `f${CHAIN_LENGTH - 1}`, 'editor', 'user', grantedSubjectId));
  return tuples;
}

describe('the-depth-budget-bounds-an-acyclic-but-very-deep-chain', () => {
  it('a-check-at-a-small-explicit-maxDepth-denies-a-subject-only-reachable-past-the-ceiling', () => {
    const schema = compileOk(SOURCE);
    const tuples = buildChainTuples('mona');
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'mona'),
      ref('folder', 'f0'),
      'view',
      { maxDepth: 5 },
    );
    expect(result.allowed).toBe(false);
  });

  it('the-identical-graph-allows-once-maxDepth-is-raised-enough-to-cover-the-whole-chain', () => {
    const schema = compileOk(SOURCE);
    const tuples = buildChainTuples('mona');
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'mona'),
      ref('folder', 'f0'),
      'view',
      { maxDepth: 200 },
    );
    expect(result.allowed).toBe(true);
  });

  it('a-shallow-maxDepth-does-not-deny-a-grant-that-sits-well-within-the-budget', () => {
    // Control in the other direction: a grant sitting at hop 1 (not the
    // far end of the chain) must still be found even at the small
    // maxDepth used above — proving that test isn't denying everything
    // regardless of reachability, only the genuinely-too-deep case.
    const schema = compileOk(SOURCE);
    const tuples: ReferenceTuple[] = [
      tuple('folder', 'f0', 'parent', 'folder', 'f1'),
      tuple('folder', 'f1', 'editor', 'user', 'nadia'),
    ];
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'nadia'),
      ref('folder', 'f0'),
      'view',
      { maxDepth: 5 },
    );
    expect(result.allowed).toBe(true);
  });
});
