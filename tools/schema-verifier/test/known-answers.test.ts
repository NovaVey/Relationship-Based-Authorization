/**
 * §8c — the known-answer corpus: every fixture invariant this project
 * ships, its schema, and its exact expected result, gathered into one
 * table and swept in a single loop. Not a duplicate of
 * `validate.test.ts`/`bounded.test.ts` (which exist for a different job
 * — proving specific mechanisms, like self-validation or the given-tuple
 * fix, actually work, often with a live `console.log` of the real
 * engine's own response). This file's only job is being the one place a
 * reader can see, at a glance, every answer this project has ever
 * committed to as correct, forever — the reference a future change gets
 * checked against, not a place new behavior gets explored. Every row
 * cites the `docs/DECISIONS.md` entry that reasoned out *why* that
 * answer is the one true answer — this table asserts the result, it
 * doesn't re-derive it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import type { CompiledSchema } from '../../../src/schema/dsl/types.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import { parseInvariants } from '../src/invariants/index.js';
import type { Invariant } from '../src/invariants/index.js';
import type { Fragment, Verdict } from '../src/reachability/index.js';
import { checkAndValidate } from '../src/validate/index.js';

const SCHEMA_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/schemas/', import.meta.url));
const INVARIANT_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/invariants/', import.meta.url));

function loadSchema(filename: string): CompiledSchema {
  const result = compileSchema(readFileSync(SCHEMA_FIXTURE_DIR + filename, 'utf8'));
  if (!result.ok) {
    throw new Error(
      `schema ${filename} did not compile: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return result.schema;
}

function loadInvariant(filename: string): Invariant {
  const result = parseInvariants(readFileSync(INVARIANT_FIXTURE_DIR + filename, 'utf8'));
  if (!result.ok) {
    throw new Error(
      `invariant ${filename} did not parse: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return result.invariants[0]!;
}

interface KnownAnswer {
  readonly schema: string;
  readonly invariant: string;
  readonly verdict: Verdict;
  readonly fragment: Fragment;
  /** Only meaningful — and only checked — for a non-monotone `HOLDS`/`VIOLATED`. */
  readonly bound?: number;
  /** The `docs/DECISIONS.md` entry that reasoned out why this is the answer — this table asserts it, it doesn't re-derive it. */
  readonly why: string;
}

const CORPUS: readonly KnownAnswer[] = [
  {
    schema: 'tenancy.authz',
    invariant: 'tenant-isolation.invariant',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    why: "D-116: a relationEquals constraint pins user.tenant, but document.view's own rewrite rule never consults it — a real, unconstrained cross-tenant path exists.",
  },
  {
    schema: 'tenancy.authz',
    invariant: 'positive-control.invariant',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    why: 'D-115/D-116: deliberately satisfiable — proves the search can find a witness when one plainly exists, not just default to reporting none.',
  },
  {
    schema: 'tenancy.authz',
    invariant: 'no-public-path-to-private-document.invariant',
    verdict: 'HOLDS',
    fragment: 'monotone',
    why: "D-116: private_document#view's entire rewrite closure never accepts a user subject, directly or transitively — type-level unreachability, true regardless of any tuples ever written.",
  },
  {
    schema: 'non-monotone.authz',
    invariant: 'intersection-approve.invariant',
    verdict: 'VIOLATED',
    fragment: 'non-monotone',
    // No `bound` here — `CheckResult.bound` is only ever set alongside a
    // non-monotone `HOLDS` (D-118); a `VIOLATED` witness needs no bound
    // caveat, it's a real counterexample the real engine already confirmed.
    why: 'D-118: approve = editor & reviewer, no constraints — nothing stops the same user from being both at once.',
  },
  {
    schema: 'non-monotone.authz',
    invariant: 'exclusion-blocked-cannot-publish.invariant',
    verdict: 'HOLDS',
    fragment: 'non-monotone',
    bound: 1,
    why: 'D-118: publish = editor - blocked, blocked(o) = s given and held fixed — exclusion means a blocked subject stays blocked regardless of any other candidate tuple.',
  },
];

describe('the known-answer corpus — every fixture this project ships, swept against its exact committed answer', () => {
  it.each(CORPUS)(
    '$invariant on $schema → $verdict (fragment: $fragment)',
    async ({ schema, invariant, verdict, fragment, bound }) => {
      const compiled = loadSchema(schema);
      const graph = buildSchemaGraph(compiled);
      const loaded = loadInvariant(invariant);

      const { result } = await checkAndValidate(graph, compiled, loaded);

      expect(result.verdict).toBe(verdict);
      expect(result.fragment).toBe(fragment);
      if (bound !== undefined) expect(result.bound).toBe(bound);
    },
  );

  it('the corpus itself covers both fragments and both verdicts — a corpus that only ever exercised one shape would be a false sense of coverage', () => {
    const fragments = new Set(CORPUS.map((c) => c.fragment));
    const verdicts = new Set(CORPUS.map((c) => c.verdict));
    expect(fragments).toEqual(new Set<Fragment>(['monotone', 'non-monotone']));
    expect(verdicts).toEqual(new Set<Verdict>(['VIOLATED', 'HOLDS']));
  });
});
