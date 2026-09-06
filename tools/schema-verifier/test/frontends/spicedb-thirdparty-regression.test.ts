/**
 * The strongest test the SpiceDB front end has — mirrors `openfga-
 * thirdparty-regression.test.ts` exactly, one ecosystem over: translates
 * the REAL, raw upstream schema for every SpiceDB entry in the §10
 * third-party schema survey (`tools/schema-verifier/thirdparty/upstream/
 * *.zed` — extracted verbatim from each real fetched `schema-and-data.yaml`
 * / schema-language-reference `.mdx`, the exact same source URLs each
 * hand-translated `thirdparty/spicedb-*.authz` file's own header comment
 * already cites) through the real, unmodified `parseSpicedbSchema` →
 * `translateSpicedb` → `printSchema` → `compileSchema` →
 * `checkAndValidate` pipeline, and asserts the verdict matches the SAME
 * published `docs/FINDINGS.md` row the hand-translated fixture is already
 * pinned to (`../thirdparty-survey.test.ts`).
 *
 * **Five of the seven reuse the existing hand-translated `.invariant`
 * file unchanged** — this front end's own generated relation/permission
 * names for those five happen to match the hand translation exactly (or,
 * for `spicedb-github`'s own case-2 expansion, never introduce a new name
 * at all). **Two don't**: `spicedb-superuser` and `spicedb-docs-style-
 * sharing` both hit case-3 restructuring (`../../src/frontends/spicedb/
 * translate.ts`'s own module doc comment, point 2) and point 3's own
 * arrow-type-split respectively, and this front end's own synthesized
 * relation names (`owner_organization`, `viewer_via_group_with_parent_
 * view`) are real but different from the names a human happened to pick
 * by hand (`owner_org`, `viewer_group`) — a naming difference, not a
 * translation bug (`compileSchema` never cares what a synthesized name is
 * called, only what it computes). Both fixtures below use a small,
 * locally-adapted copy of the real published invariant — same variables,
 * same `given` constraints, same goal, only the one now-differently-named
 * relation swapped in — never a different question being asked.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseSpicedbSchema } from '../../src/frontends/spicedb/parser.js';
import { translateSpicedb } from '../../src/frontends/spicedb/translate.js';
import { printSchema } from '../../src/frontends/common/dsl-print.js';
import { compileSchema } from '../../../../src/schema/dsl/compiler.js';
import type { CompiledSchema } from '../../../../src/schema/dsl/types.js';
import { buildSchemaGraph } from '../../src/ir/index.js';
import { parseInvariants } from '../../src/invariants/index.js';
import type { Invariant } from '../../src/invariants/index.js';
import type { Fragment, Verdict } from '../../src/reachability/index.js';
import type { Proof } from '../../src/reachability/types.js';
import { checkAndValidate } from '../../src/validate/index.js';

const UPSTREAM_DIR = fileURLToPath(new URL('../../thirdparty/upstream/', import.meta.url));
const THIRDPARTY_DIR = fileURLToPath(new URL('../../thirdparty/', import.meta.url));

function translateUpstream(basename: string): CompiledSchema {
  const zed = readFileSync(`${UPSTREAM_DIR}${basename}.zed`, 'utf8');
  const parsed = parseSpicedbSchema(zed);
  if (!parsed.ok) {
    throw new Error(
      `upstream fixture ${basename}.zed failed to parse: line ${parsed.error.line}: ${parsed.error.message}`,
    );
  }
  const { schema } = translateSpicedb(parsed.definitions);
  const dsl = printSchema(schema);
  const compiled = compileSchema(dsl);
  if (!compiled.ok) {
    throw new Error(
      `translated ${basename}.zed failed to compile:\n${dsl}\n\n${compiled.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return compiled.schema;
}

function loadInvariantFile(basename: string): Invariant {
  const filename = `${basename}.invariant`;
  const result = parseInvariants(readFileSync(THIRDPARTY_DIR + filename, 'utf8'));
  if (!result.ok) {
    throw new Error(
      `invariant ${filename} did not parse: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return result.invariants[0]!;
}

function loadInvariantText(name: string, source: string): Invariant {
  const result = parseInvariants(source);
  if (!result.ok) {
    throw new Error(
      `inline invariant '${name}' did not parse: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return result.invariants[0]!;
}

// Adapted from the real `thirdparty/spicedb-superuser.invariant` — same
// variables, same givens, same goal; only `owner_org` (the hand-
// translation's own chosen name) swapped for `owner_organization` (this
// front end's own `${relationName}_${subjectTypeNamespace}` naming for a
// split-by-type relation — see `translate.ts`'s own arrow-type-split).
const SUPERUSER_INVARIANT_ADAPTED = `
invariant document_admin_requires_ownership_chain {
  u: user
  o: organization
  d: document

  owner_organization(d) = o

  goal: admin(u, d)
}
`;

// Adapted from the real `thirdparty/spicedb-docs-style-sharing.invariant`
// — same variables, same givens, same goal; only `viewer_group` swapped
// for `viewer_via_group_with_parent_view` (this front end's own
// restructuring-relation name for the one case-3 nested-userset target in
// this schema — see `translate.ts`'s own module doc comment, point 2).
const DOCS_STYLE_SHARING_INVARIANT_ADAPTED = `
invariant sibling_group_member_cannot_view_other_group_document {
  a: user
  analysis: group_with_parent
  engineering: group_with_parent
  d: document

  member(analysis) = a
  viewer_via_group_with_parent_view(d) = engineering
  distinct(analysis, engineering)

  goal: view(a, d)
}
`;

interface KnownAnswer {
  readonly basename: string;
  readonly verdict: Verdict;
  readonly fragment: Fragment;
  readonly proof: Proof;
  readonly loadInvariant: () => Invariant;
}

const CORPUS: readonly KnownAnswer[] = [
  {
    basename: 'spicedb-ai-agents',
    verdict: 'HOLDS',
    fragment: 'monotone',
    proof: 'exact',
    loadInvariant: () => loadInvariantFile('spicedb-ai-agents'),
  },
  {
    basename: 'spicedb-entitlements',
    verdict: 'HOLDS',
    fragment: 'monotone',
    proof: 'exact',
    loadInvariant: () => loadInvariantFile('spicedb-entitlements'),
  },
  {
    basename: 'spicedb-github',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    proof: 'exact',
    loadInvariant: () => loadInvariantFile('spicedb-github'),
  },
  {
    basename: 'spicedb-userdefined-roles',
    verdict: 'VIOLATED',
    fragment: 'non-monotone',
    proof: 'exact',
    loadInvariant: () => loadInvariantFile('spicedb-userdefined-roles'),
  },
  {
    basename: 'spicedb-googledocs-typecheck-bug',
    verdict: 'HOLDS',
    fragment: 'non-monotone',
    proof: 'exact',
    loadInvariant: () => loadInvariantFile('spicedb-googledocs-typecheck-bug'),
  },
  {
    basename: 'spicedb-superuser',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    proof: 'exact',
    loadInvariant: () =>
      loadInvariantText('spicedb-superuser (adapted)', SUPERUSER_INVARIANT_ADAPTED),
  },
  {
    basename: 'spicedb-docs-style-sharing',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    proof: 'exact',
    loadInvariant: () =>
      loadInvariantText(
        'spicedb-docs-style-sharing (adapted)',
        DOCS_STYLE_SHARING_INVARIANT_ADAPTED,
      ),
  },
];

describe('SpiceDB front end — real upstream .zed source, translated automatically, matches every published thirdparty-survey verdict', () => {
  it.each(CORPUS)(
    '$basename.zed → $verdict (fragment: $fragment)',
    async ({ basename, verdict, fragment, proof, loadInvariant }) => {
      const compiled = translateUpstream(basename);
      const graph = buildSchemaGraph(compiled);
      const invariant = loadInvariant();

      const { result, validation } = await checkAndValidate(graph, compiled, invariant);

      expect(result.verdict).toBe(verdict);
      expect(result.fragment).toBe(fragment);
      expect(result.proof).toBe(proof);
      expect(validation.kind).toBe(verdict === 'HOLDS' ? 'empirically-clean' : 'confirmed');
    },
  );

  it("covers every SpiceDB entry in the survey — seven, matching thirdparty/README.md's own source count", () => {
    expect(CORPUS).toHaveLength(7);
  });
});
