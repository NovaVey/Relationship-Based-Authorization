/**
 * The strongest test this front end has: translates the REAL, raw
 * upstream `.fga` source for every OpenFGA entry in the §10 third-party
 * schema survey (`tools/schema-verifier/thirdparty/upstream/*.fga` —
 * fetched verbatim from the exact same `openfga/sample-stores` URLs each
 * hand-translated `thirdparty/openfga-*.authz` file's own header comment
 * already cites; see that directory's own note on how they got there) —
 * not a synthetic stand-in, not the hand-translated file itself — through
 * the real, unmodified `translateOpenfga` → `printSchema` →
 * `compileSchema` → `checkAndValidate` pipeline, and asserts the verdict
 * matches the SAME published `docs/FINDINGS.md` row the hand-translated
 * fixture is already pinned to (`../thirdparty-survey.test.ts`).
 *
 * Two files independently producing the same verdict for the same real-
 * world question is a much stronger signal than either alone: a bug
 * specific to the *hand* translation (a typo, a dropped term) would still
 * show up here since this file never reads the hand-translated `.authz`
 * text at all; a bug specific to the *automated* translator would fail
 * here even though `thirdparty-survey.test.ts` stays green.
 *
 * `openfga-entitlements`/`openfga-expenses`/`openfga-github`/`openfga-
 * slack` were verified by hand, term for term, against their hand-
 * translated counterparts before a single line of `translate.ts` was
 * written — every one matched exactly, modulo declaration order (which
 * `compileSchema` never cares about). `openfga-gdrive` is the one entry
 * where automated and hand translation deliberately *differ*: the hand
 * translation drops `user:*` (written when this DSL had no wildcard
 * concept at all); this front end includes it for real (D-171). The
 * schema is monotone (adding a wildcard grant only ever adds reachable
 * paths, never removes one) and the published witness
 * (`doc:d#viewer@user:u`, a direct grant unrelated to the wildcard) is
 * untouched by that difference — confirmed here, not assumed, by still
 * asserting the exact same `VIOLATED` verdict.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseOpenfgaModel } from '../../src/frontends/openfga/parse.js';
import { translateOpenfga } from '../../src/frontends/openfga/translate.js';
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
  const fga = readFileSync(`${UPSTREAM_DIR}${basename}.fga`, 'utf8');
  const parsed = parseOpenfgaModel(fga);
  if (!parsed.ok) {
    throw new Error(`upstream fixture ${basename}.fga failed to parse: ${parsed.error.message}`);
  }
  const { schema } = translateOpenfga(parsed.model);
  const dsl = printSchema(schema);
  const compiled = compileSchema(dsl);
  if (!compiled.ok) {
    throw new Error(
      `translated ${basename}.fga failed to compile:\n${dsl}\n\n${compiled.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return compiled.schema;
}

function loadInvariant(basename: string): Invariant {
  const filename = `${basename}.invariant`;
  const result = parseInvariants(readFileSync(THIRDPARTY_DIR + filename, 'utf8'));
  if (!result.ok) {
    throw new Error(
      `invariant ${filename} did not parse: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return result.invariants[0]!;
}

interface KnownAnswer {
  readonly basename: string;
  readonly verdict: Verdict;
  readonly fragment: Fragment;
  readonly proof: Proof;
  readonly why: string;
}

const CORPUS: readonly KnownAnswer[] = [
  {
    basename: 'openfga-entitlements',
    verdict: 'HOLDS',
    fragment: 'monotone',
    proof: 'exact',
    why: 'docs/FINDINGS.md: feature_access_requires_subscription_in_associated_org.',
  },
  {
    basename: 'openfga-expenses',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    proof: 'exact',
    why: 'docs/FINDINGS.md: employee_never_approves_own_report — a self-referential manager loop.',
  },
  {
    basename: 'openfga-github',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    proof: 'exact',
    why: 'docs/FINDINGS.md: plain_org_member_never_gets_repo_admin — a direct repo-admin grant.',
  },
  {
    basename: 'openfga-gdrive',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    proof: 'exact',
    why: "docs/FINDINGS.md: sibling_folder_viewer_cannot_read_document — a direct viewer grant, unaffected by this front end now including the wildcard the hand translation dropped (see this file's own top-of-file comment).",
  },
  {
    basename: 'openfga-slack',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    proof: 'exact',
    why: 'docs/FINDINGS.md: workspace_guest_never_becomes_channel_writer — a direct writer grant.',
  },
];

describe('OpenFGA front end — real upstream .fga source, translated automatically, matches every published thirdparty-survey verdict', () => {
  it.each(CORPUS)(
    '$basename.fga → $verdict (fragment: $fragment)',
    async ({ basename, verdict, fragment, proof }) => {
      const compiled = translateUpstream(basename);
      const graph = buildSchemaGraph(compiled);
      const invariant = loadInvariant(basename);

      const { result, validation } = await checkAndValidate(graph, compiled, invariant);

      expect(result.verdict).toBe(verdict);
      expect(result.fragment).toBe(fragment);
      expect(result.proof).toBe(proof);
      expect(validation.kind).toBe(verdict === 'HOLDS' ? 'empirically-clean' : 'confirmed');
    },
  );

  it("covers every OpenFGA entry in the survey — five, matching thirdparty/README.md's own source count", () => {
    expect(CORPUS).toHaveLength(5);
  });
});
