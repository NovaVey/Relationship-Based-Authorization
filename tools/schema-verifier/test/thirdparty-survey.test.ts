/**
 * The third-party schema survey (`docs/FINDINGS.md`, build spec §10,
 * `CHECKPOINT 6`) — the permanent regression guard `docs/CAPABILITY-
 * GAPS.md` and `docs/FINDINGS.md`'s own correction note both name as
 * missing: "no test in `tools/schema-verifier/test/` pins this fixture's
 * verdict, so nothing would have caught the flip." Mirrors
 * `known-answers.test.ts`'s own corpus-sweep shape exactly, but points at
 * `tools/schema-verifier/thirdparty/*.authz`/`*.invariant` — the real,
 * hand-translated third-party schemas — rather than this tool's own
 * internal `fixtures/`. Deliberately a separate file, not an extension of
 * `known-answers.test.ts`'s own loader: that file's own scope is this
 * project's internal fixture corpus; these are schemas this project
 * didn't write, translated from real published sources, and worth a
 * dedicated home a reader can find by asking "does this file's own claims
 * in `docs/FINDINGS.md` have a test behind them" — until now, the answer
 * was no.
 *
 * **A real, live-confirmed correction this file's own creation caught,
 * not merely restated from prose.** `docs/FINDINGS.md` published `7
 * VIOLATED, 5 HOLDS` — but running the real, current `verify-schema` CLI
 * against all twelve fixtures today (the same run this file's own corpus
 * below pins) returns `8 VIOLATED, 4 HOLDS`: `spicedb-userdefined-roles`
 * had flipped from `HOLDS up to k = 1` (`boundedSearch`'s own limited
 * candidate budget, never a proof) to a confirmed, exact `VIOLATED` once
 * D-151's SMT tier started deciding this goal ahead of bounded search —
 * nothing had re-run the survey against that tier until this file's own
 * author did, live, before writing a single assertion below. See
 * `docs/FINDINGS.md`'s own "Correction" note (in "The recurring finding"
 * section) for the full account, including the witness and why it's a
 * structurally distinct escape shape from every other entry in this
 * corpus.
 *
 * Every row's `why` cites `docs/FINDINGS.md`'s own results table — this
 * file asserts the published verdict, it doesn't re-derive it.
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
import type { Proof } from '../src/reachability/types.js';
import { checkAndValidate } from '../src/validate/index.js';

const THIRDPARTY_DIR = fileURLToPath(new URL('../thirdparty/', import.meta.url));

function loadSchema(basename: string): CompiledSchema {
  const filename = `${basename}.authz`;
  const result = compileSchema(readFileSync(THIRDPARTY_DIR + filename, 'utf8'));
  if (!result.ok) {
    throw new Error(
      `schema ${filename} did not compile: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return result.schema;
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

/** `kind` alone (never the whole `ValidationOutcome` shape) — the corpus's own job is pinning the published VERDICT, not re-deriving self-validation's own internal details (witness/allowed/depth for `'confirmed'`, `sampled` for `'empirically-clean'`) a second time; `validate.test.ts`/`fuzz.test.ts` already own proving those mechanisms themselves work. */
interface KnownThirdPartyAnswer {
  readonly schema: string;
  readonly invariant: string;
  readonly verdict: Verdict;
  readonly fragment: Fragment;
  readonly proof: Proof;
  readonly validationKind: 'confirmed' | 'empirically-clean';
  /** The `docs/FINDINGS.md` results-table row this assertion pins. */
  readonly why: string;
}

const CORPUS: readonly KnownThirdPartyAnswer[] = [
  {
    schema: 'openfga-github',
    invariant: 'openfga-github',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    proof: 'exact',
    validationKind: 'confirmed',
    why: 'docs/FINDINGS.md: plain_org_member_never_gets_repo_admin — a direct repo-admin grant unrelated to the org-membership path the invariant meant to probe.',
  },
  {
    schema: 'openfga-expenses',
    invariant: 'openfga-expenses',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    proof: 'exact',
    validationKind: 'confirmed',
    why: "docs/FINDINGS.md: employee_never_approves_own_report — a self-referential manager loop; the one original-nine entry that isn't the 'directly-grantable relation' shape.",
  },
  {
    schema: 'spicedb-entitlements',
    invariant: 'spicedb-entitlements',
    verdict: 'HOLDS',
    fragment: 'monotone',
    proof: 'exact',
    validationKind: 'empirically-clean',
    why: "docs/FINDINGS.md: feature_access_requires_membership_in_entitled_org — closed by D-131's `not member(o2) = u`, ruling out the extra, unconstrained org membership the original witness relied on.",
  },
  {
    schema: 'openfga-entitlements',
    invariant: 'openfga-entitlements',
    verdict: 'HOLDS',
    fragment: 'monotone',
    proof: 'exact',
    validationKind: 'empirically-clean',
    why: 'docs/FINDINGS.md: feature_access_requires_subscription_in_associated_org — closed the same way as spicedb-entitlements, confirming the fix is language-level, not one-schema-specific.',
  },
  {
    schema: 'spicedb-superuser',
    invariant: 'spicedb-superuser',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    proof: 'exact',
    validationKind: 'confirmed',
    why: "docs/FINDINGS.md: document_admin_requires_ownership_chain — a direct owner grant, cheaper for the search to find than the schema's own deliberate site-wide superuser backdoor.",
  },
  {
    schema: 'spicedb-docs-style-sharing',
    invariant: 'spicedb-docs-style-sharing',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    proof: 'exact',
    validationKind: 'confirmed',
    why: 'docs/FINDINGS.md: sibling_group_member_cannot_view_other_group_document — document.viewer accepts a plain user directly, so any invariant about it is trivially escapable regardless of the group logic.',
  },
  {
    schema: 'openfga-gdrive',
    invariant: 'openfga-gdrive',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    proof: 'exact',
    validationKind: 'confirmed',
    why: 'docs/FINDINGS.md: sibling_folder_viewer_cannot_read_document — a direct viewer grant on the document itself.',
  },
  {
    schema: 'openfga-slack',
    invariant: 'openfga-slack',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    proof: 'exact',
    validationKind: 'confirmed',
    why: 'docs/FINDINGS.md: workspace_guest_never_becomes_channel_writer — a direct writer grant unrelated to the guest relation, which has no rewrite path into writer/commenter at all.',
  },
  {
    schema: 'spicedb-github',
    invariant: 'spicedb-github',
    verdict: 'VIOLATED',
    fragment: 'monotone',
    proof: 'exact',
    validationKind: 'confirmed',
    why: 'docs/FINDINGS.md: org_member_never_gets_repo_admin_without_role — a direct admin grant, the same shape as openfga-github despite a structurally different schema.',
  },
  {
    schema: 'spicedb-userdefined-roles',
    invariant: 'spicedb-userdefined-roles',
    verdict: 'VIOLATED',
    fragment: 'non-monotone',
    proof: 'exact',
    validationKind: 'confirmed',
    why: "docs/FINDINGS.md's own correction note: built_in_role_never_deletable — CORRECTED from the earlier, superseded `HOLDS up to k = 1`. The SMT tier (D-151) now decides this goal exactly and finds a real, self-validated counterexample (an unconstrained second tuple reaching a different role manager's own delegated membership than the one the invariant pinned) that bounded search's own limited candidate budget never happened to construct. THIS is the exact row this file's own top-of-file doc comment describes finding live.",
  },
  {
    schema: 'spicedb-ai-agents',
    invariant: 'spicedb-ai-agents',
    verdict: 'HOLDS',
    fragment: 'monotone',
    proof: 'exact',
    validationKind: 'empirically-clean',
    why: 'docs/FINDINGS.md: ai_agent_never_edits_document — the goal permission has no direct grant term of the tested (agent) type anywhere in its closure.',
  },
  {
    schema: 'spicedb-googledocs-typecheck-bug',
    invariant: 'spicedb-googledocs-typecheck-bug',
    verdict: 'HOLDS',
    fragment: 'non-monotone',
    proof: 'exact',
    validationKind: 'empirically-clean',
    why: 'docs/FINDINGS.md: edit_always_unreachable_for_any_user — document#edit = viewer & admin is unreachable because viewer/admin are disjoint subject types; the AND-infeasibility short-circuit proves it directly.',
  },
];

describe('the third-party schema survey — every published docs/FINDINGS.md verdict, swept against the real, committed thirdparty fixtures', () => {
  it.each(CORPUS)(
    '$invariant.invariant on $schema.authz → $verdict (fragment: $fragment)',
    async ({ schema, invariant, verdict, fragment, proof, validationKind }) => {
      const compiled = loadSchema(schema);
      const graph = buildSchemaGraph(compiled);
      const loaded = loadInvariant(invariant);

      const { result, validation } = await checkAndValidate(graph, compiled, loaded);

      expect(result.verdict).toBe(verdict);
      expect(result.fragment).toBe(fragment);
      expect(result.proof).toBe(proof);
      expect(validation.kind).toBe(validationKind);
    },
  );

  it("the corpus itself matches docs/FINDINGS.md's own published tally — 8 VIOLATED, 4 HOLDS, twelve entries total", () => {
    expect(CORPUS).toHaveLength(12);
    const violated = CORPUS.filter((c) => c.verdict === 'VIOLATED');
    const holds = CORPUS.filter((c) => c.verdict === 'HOLDS');
    expect(violated).toHaveLength(8);
    expect(holds).toHaveLength(4);
  });
});
