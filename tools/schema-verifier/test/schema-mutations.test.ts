/**
 * §8a — build spec's own words: "Take a schema whose invariant holds.
 * Mutate it — add a rewrite rule, widen a type restriction, add a
 * tuple-to-userset edge across a boundary — and confirm the verifier
 * flips to VIOLATED. Do this for at least eight mutations, at least two
 * of which are subtle (widening a type restriction by one type; adding
 * an edge that only leaks at depth 3)."
 *
 * Not to be confused with `docs/DECISIONS.md` D-119's own mutation
 * testing (nine hand-curated changes to this *tool's own source code*,
 * confirming the shipped test suite catches each one) — that's a real,
 * valuable exercise, but it answers a different question ("do our tests
 * have teeth against a broken verifier?") than this file does ("does the
 * verifier itself actually notice when a *schema* changes to introduce a
 * real leak?"). Both are needed; only this file is what §8a itself asks
 * for.
 *
 * Every mutation starts from `no_public_path_to_private_document`
 * (`tenancy.authz`) — a genuinely, structurally `HOLDS` invariant
 * (D-116): `private_document#view`'s entire rewrite closure never
 * accepts a `user` subject, directly or transitively. Each mutation
 * widens that closure by exactly one real schema construct and confirms
 * the verdict is no longer `HOLDS`. Because every resulting verdict here
 * is `VIOLATED` in the monotone fragment, `checkAndValidate` also runs
 * self-validation automatically (§6) — every flip is independently
 * confirmed against the real, unmodified engine, not just the static
 * search's own opinion.
 */
import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import type { CompiledSchema } from '../../../src/schema/dsl/types.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import { parseInvariants } from '../src/invariants/index.js';
import type { Invariant } from '../src/invariants/index.js';
import { checkAndValidate } from '../src/validate/index.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/schemas/', import.meta.url));
const INVARIANT_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/invariants/', import.meta.url));

const BASE_SCHEMA = readFileSync(SCHEMA_FIXTURE_DIR + 'tenancy.authz', 'utf8');
const INVARIANT: Invariant = (() => {
  const result = parseInvariants(
    readFileSync(INVARIANT_FIXTURE_DIR + 'no-public-path-to-private-document.invariant', 'utf8'),
  );
  if (!result.ok) throw new Error('fixture invariant failed to parse');
  return result.invariants[0]!;
})();

const PRIVATE_DOCUMENT_BLOCK_RE = /namespace private_document \{[\s\S]*?\n\}/;

/** Splices a replacement `namespace private_document { ... }` block into the base schema — every other namespace (organization/group/user/document/service_account) is untouched, so each mutation isolates exactly one structural change. */
function mutate(privateDocumentBlock: string): CompiledSchema {
  if (!PRIVATE_DOCUMENT_BLOCK_RE.test(BASE_SCHEMA)) {
    throw new Error(
      'mutate(): base schema fixture no longer matches the expected private_document block shape',
    );
  }
  const source = BASE_SCHEMA.replace(PRIVATE_DOCUMENT_BLOCK_RE, privateDocumentBlock);
  const result = compileSchema(source);
  if (!result.ok) {
    throw new Error(
      `mutated schema did not compile: ${result.errors.map((e) => e.message).join('; ')}\n${source}`,
    );
  }
  return result.schema;
}

interface Mutation {
  readonly name: string;
  readonly subtle: string | undefined;
  readonly block: string;
  /** Number of tuple-graph edges the resulting witness needs — asserted directly for the depth-3 subtle case, to prove it's genuinely deep, not just claimed to be. */
  readonly expectedWitnessEdges?: number;
}

const MUTATIONS: readonly Mutation[] = [
  {
    name: 'widen owner by exactly one type (bare user)',
    subtle: 'widening a type restriction by one type',
    block: `namespace private_document {
  relation owner: service_account | user

  permission view = owner
}`,
  },
  {
    name: 'add a union branch granting a bare user relation directly',
    subtle: undefined,
    block: `namespace private_document {
  relation owner: service_account
  relation shared_with: user

  permission view = owner | shared_with
}`,
  },
  {
    name: 'add a tuple-to-userset edge across a boundary into document (leaks only at depth 3)',
    subtle:
      'an edge that only leaks at depth 3 — private_document.linked_doc -> document.tenant -> organization.member -> user',
    block: `namespace private_document {
  relation owner: service_account
  relation linked_doc: document

  permission view = owner | linked_doc->view
}`,
    expectedWitnessEdges: 3,
  },
  {
    name: 'add a tuple-to-userset edge directly into organization',
    subtle: undefined,
    block: `namespace private_document {
  relation owner: service_account
  relation tenant: organization

  permission view = owner | tenant->member
}`,
  },
  {
    name: 'add a union branch with a nested-userset subject type (group#member)',
    subtle: undefined,
    block: `namespace private_document {
  relation owner: service_account
  relation shared_group: group#member

  permission view = owner | shared_group
}`,
  },
  {
    name: 'widen owner by exactly one type (nested userset, not bare user)',
    subtle: undefined,
    block: `namespace private_document {
  relation owner: service_account | group#member

  permission view = owner
}`,
  },
  {
    name: 'add a computedUserset chain (permission delegates to another permission)',
    subtle: undefined,
    block: `namespace private_document {
  relation owner: service_account
  relation editor: user

  permission internal_edit = editor
  permission view = owner | internal_edit
}`,
  },
  {
    name: 'add a tuple-to-userset edge via group (distinct edge kind from the nested-userset union branch above)',
    subtle: undefined,
    block: `namespace private_document {
  relation owner: service_account
  relation shared_group2: group

  permission view = owner | shared_group2->member
}`,
  },
];

describe('§8a — schema-level mutation testing: a schema whose invariant HOLDS, mutated, must flip to VIOLATED', () => {
  it('sanity: the unmutated fixture genuinely HOLDS', async () => {
    const compiled = compileSchema(BASE_SCHEMA);
    if (!compiled.ok) throw new Error('base schema failed to compile');
    const graph = buildSchemaGraph(compiled.schema);
    const { result } = await checkAndValidate(graph, compiled.schema, INVARIANT);
    expect(result.verdict).toBe('HOLDS');
  });

  it.each(MUTATIONS)(
    '$name → VIOLATED, self-validated against the real engine',
    async (mutation) => {
      const schema = mutate(mutation.block);
      const graph = buildSchemaGraph(schema);

      const { result, validation } = await checkAndValidate(graph, schema, INVARIANT);

      expect(result.verdict).toBe('VIOLATED');
      expect(result.fragment).toBe('monotone');
      // Every VIOLATED verdict here is self-validated automatically — the
      // real, unmodified engine confirms the witness, not just the search.
      expect(validation.kind).toBe('confirmed');
      if (mutation.expectedWitnessEdges !== undefined) {
        expect(result.witness).toHaveLength(mutation.expectedWitnessEdges);
      }
    },
  );

  it('at least eight mutations, at least two of them subtle — the exit criteria stated literally, not just satisfied incidentally', () => {
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(8);
    expect(MUTATIONS.filter((m) => m.subtle !== undefined).length).toBeGreaterThanOrEqual(2);
  });
});
