/**
 * `checkInvariant`'s intersection/exclusion short-circuits — build spec
 * §5, extended (see `docs/DECISIONS.md`, the entry adding these to
 * `search.ts`): reaching an `intersectionChild`/`exclusionBase`/
 * `exclusionSubtract` edge no longer *unconditionally* yields `UNKNOWN`.
 * Two narrow, sound extensions decide some cases outright:
 *
 * - **Rule A (AND-infeasibility).** An intersection's children are each
 *   tried independently, with the same object/subject and union-find
 *   state the intersection node itself was reached with. If ANY child
 *   is structurally impossible (`attempt()` returns `'fail'`), the
 *   whole intersection is impossible too — AND requires every conjunct.
 * - **Rule B (exclusion reduction).** `A - B`: if `A` itself is
 *   structurally impossible, so is `A - B`, regardless of `B`. If `A`
 *   is not, but `B` is (structurally impossible to ever satisfy),
 *   subtracting an always-empty set changes nothing — `A - B` reduces
 *   exactly to `A`'s own result.
 *
 * Neither rule attempts to decide the general case (combining two
 * independently-successful witnesses into one for VIOLATED, or proving
 * "B is always true whenever A holds" for exclusion) — both remain
 * `UNKNOWN`, falling back to §7's bounded search exactly as before.
 *
 * This closes a real, previously-disclosed gap: `docs/FINDINGS.md`'s
 * `spicedb-googledocs-typecheck-bug` entry (`document#edit = viewer &
 * admin`, `viewer: user` vs `admin: serviceaccount` — disjoint subject
 * types) used to report `HOLDS up to k = 1` even though the
 * unreachability is provable by type-disjointness alone, "a real,
 * disclosable gap between what's true and what this tool currently
 * certifies." The integration test below runs that exact fixture and
 * confirms it now reports an unconditional `HOLDS`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import { parseInvariants } from '../src/invariants/index.js';
import { checkInvariant } from '../src/reachability/index.js';
import { checkAndValidate } from '../src/validate/index.js';

function inlineGraph(source: string) {
  const compiled = compileSchema(source);
  if (!compiled.ok) {
    throw new Error(`inline schema failed to compile: ${JSON.stringify(compiled.errors)}`);
  }
  return { schema: compiled.schema, graph: buildSchemaGraph(compiled.schema) };
}

function inlineInvariant(source: string) {
  const parsed = parseInvariants(source);
  if (!parsed.ok) {
    throw new Error(`inline invariant failed to parse: ${JSON.stringify(parsed.errors)}`);
  }
  return parsed.invariants[0]!;
}

describe('Rule A — AND-infeasibility short-circuit for intersectionChild', () => {
  const { schema, graph } = inlineGraph(`
    namespace document {
      relation alpha: user
      relation beta: user
      relation gamma: serviceaccount
      permission edit = alpha & gamma
      permission ab = alpha & beta
      permission agc = alpha & beta & gamma
      permission gab = gamma & alpha & beta
    }
  `);

  it('one child structurally unreachable (type-disjoint from the goal subject) short-circuits to HOLDS, not UNKNOWN', () => {
    const inv = inlineInvariant(
      'invariant edit_g {\n  s: user\n  d: document\n  goal: edit(s, d)\n}',
    );
    expect(checkInvariant(graph, schema, inv)).toEqual({ verdict: 'HOLDS' });
  });

  it('neither child structurally unreachable still falls through to UNKNOWN — no false-positive HOLDS', () => {
    const inv = inlineInvariant('invariant ab_g {\n  s: user\n  d: document\n  goal: ab(s, d)\n}');
    const result = checkInvariant(graph, schema, inv);
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.reason).toContain('intersection');
  });

  it('3-way intersection, only the LAST child unreachable — short-circuit still fires', () => {
    const inv = inlineInvariant(
      'invariant agc_g {\n  s: user\n  d: document\n  goal: agc(s, d)\n}',
    );
    expect(checkInvariant(graph, schema, inv)).toEqual({ verdict: 'HOLDS' });
  });

  it('3-way intersection, only the FIRST child unreachable — short-circuit fires regardless of position', () => {
    const inv = inlineInvariant(
      'invariant gab_g {\n  s: user\n  d: document\n  goal: gab(s, d)\n}',
    );
    expect(checkInvariant(graph, schema, inv)).toEqual({ verdict: 'HOLDS' });
  });
});

describe('Rule B — exclusion reduction for exclusionBase/exclusionSubtract', () => {
  const { schema, graph } = inlineGraph(`
    namespace document {
      relation editor: user
      relation admin: serviceaccount
      relation owner_sa: serviceaccount
      relation reviewer: user
      permission publish_a = editor - admin
      permission publish_b = owner_sa - admin
      permission publish_c = owner_sa - reviewer
    }
  `);

  it("subtract structurally unreachable, base a success — exclusion reduces to base's own VIOLATED result, unchanged", () => {
    const inv = inlineInvariant(
      'invariant publish_a_g {\n  s: user\n  d: document\n  goal: publish_a(s, d)\n}',
    );
    const result = checkInvariant(graph, schema, inv);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.witness).toEqual([
      {
        objectType: 'document',
        object: 'd',
        relation: 'editor',
        subjectType: 'user',
        subject: 's',
      },
    ]);
  });

  it("subtract structurally unreachable, base ALSO structurally unreachable — exclusion still reduces to base's own HOLDS", () => {
    const inv = inlineInvariant(
      'invariant publish_b_g {\n  s: user\n  d: document\n  goal: publish_b(s, d)\n}',
    );
    expect(checkInvariant(graph, schema, inv)).toEqual({ verdict: 'HOLDS' });
  });

  it('base itself structurally unreachable — exclusion is HOLDS regardless of subtract, even though subtract IS independently reachable here', () => {
    // publish_c's own subtract branch (reviewer: user) is perfectly
    // reachable on its own — proving the base-fail short-circuit's
    // outcome doesn't depend on subtract's own reachability at all.
    const inv = inlineInvariant(
      'invariant publish_c_g {\n  s: user\n  d: document\n  goal: publish_c(s, d)\n}',
    );
    expect(checkInvariant(graph, schema, inv)).toEqual({ verdict: 'HOLDS' });
  });
});

describe('Integration — the disclosed spicedb-googledocs-typecheck-bug fixture, end to end', () => {
  const THIRDPARTY_DIR = fileURLToPath(new URL('../thirdparty/', import.meta.url));

  it('edit_always_unreachable_for_any_user: exact HOLDS via Rule A, reported as fragment: non-monotone / proof: exact, never routed to bounded search', async () => {
    const source = readFileSync(THIRDPARTY_DIR + 'spicedb-googledocs-typecheck-bug.authz', 'utf8');
    const compiled = compileSchema(source);
    if (!compiled.ok) throw new Error('fixture schema failed to compile');
    const graph = buildSchemaGraph(compiled.schema);
    const parsed = parseInvariants(
      readFileSync(THIRDPARTY_DIR + 'spicedb-googledocs-typecheck-bug.invariant', 'utf8'),
    );
    if (!parsed.ok) throw new Error('fixture invariant failed to parse');

    const { result, validation } = await checkAndValidate(
      graph,
      compiled.schema,
      parsed.invariants[0]!,
      {
        fuzz: { trials: 10, seed: 3 },
      },
    );

    expect(result.verdict).toBe('HOLDS');
    // Structurally true — the schema's own edit permission literally is
    // an intersection — but the PROOF is exact, not merely bounded.
    expect(result.fragment).toBe('non-monotone');
    expect(result.proof).toBe('exact');
    expect(result.bound).toBeUndefined();
    expect(result.witness).toBeUndefined();
    expect(result.reason).toBeUndefined();
    // A HOLDS decided by checkInvariant still gets real §6 self-validation,
    // same as the pure-monotone case — never skipped just because the
    // schema happens to contain intersection/exclusion elsewhere.
    expect(validation).toEqual({ kind: 'empirically-clean', sampled: 10 });
  });
});

describe('Regression — the existing same-type-operand non-monotone fixtures are unaffected by Rule A/B', () => {
  // intersection-approve and exclusion-blocked-cannot-publish
  // (fixtures/schemas/non-monotone.authz) both use same-type operands —
  // no structural type-unreachability anywhere — so neither rule can
  // fire on them; both must still route through §7's bounded search
  // exactly as before, `proof: 'bounded'` now made explicit.
  const FIXTURE_SCHEMA_DIR = fileURLToPath(new URL('../fixtures/schemas/', import.meta.url));
  const FIXTURE_INVARIANT_DIR = fileURLToPath(new URL('../fixtures/invariants/', import.meta.url));

  it('intersection-approve stays VIOLATED via bounded search, proof: bounded', async () => {
    const compiled = compileSchema(readFileSync(FIXTURE_SCHEMA_DIR + 'non-monotone.authz', 'utf8'));
    if (!compiled.ok) throw new Error('non-monotone.authz failed to compile');
    const graph = buildSchemaGraph(compiled.schema);
    const parsed = parseInvariants(
      readFileSync(FIXTURE_INVARIANT_DIR + 'intersection-approve.invariant', 'utf8'),
    );
    if (!parsed.ok) throw new Error('fixture invariant failed to parse');

    const { result } = await checkAndValidate(graph, compiled.schema, parsed.invariants[0]!);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.fragment).toBe('non-monotone');
    expect(result.proof).toBe('bounded');
    expect(result.witness).toBeDefined();
  });

  it('exclusion-blocked-cannot-publish stays HOLDS up to k = 1, proof: bounded, never promoted to exact', async () => {
    const compiled = compileSchema(readFileSync(FIXTURE_SCHEMA_DIR + 'non-monotone.authz', 'utf8'));
    if (!compiled.ok) throw new Error('non-monotone.authz failed to compile');
    const graph = buildSchemaGraph(compiled.schema);
    const parsed = parseInvariants(
      readFileSync(FIXTURE_INVARIANT_DIR + 'exclusion-blocked-cannot-publish.invariant', 'utf8'),
    );
    if (!parsed.ok) throw new Error('fixture invariant failed to parse');

    const { result } = await checkAndValidate(graph, compiled.schema, parsed.invariants[0]!);
    expect(result.verdict).toBe('HOLDS');
    expect(result.fragment).toBe('non-monotone');
    expect(result.proof).toBe('bounded');
    expect(result.bound).toBe(1);
  });
});
