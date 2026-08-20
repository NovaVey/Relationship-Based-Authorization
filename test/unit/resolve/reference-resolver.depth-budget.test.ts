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
import {
  referenceCheck,
  DEFAULT_REFERENCE_MAX_DEPTH,
} from '../../../src/resolve/reference/resolver.js';
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

describe('a genuinely omitted maxDepth falls back to DEFAULT_REFERENCE_MAX_DEPTH, not some other implicit ceiling', () => {
  // Every other test in this file passes an explicit `maxDepth` (by this
  // file's own top-of-file doc comment, deliberately, "so the test runs
  // fast and is unambiguously testing the ceiling itself"). None of them
  // proves the *fallback* actually works — a `referenceCheck` call with
  // the whole 6th argument left out entirely (not `{}`, not
  // `{ maxDepth: DEFAULT_REFERENCE_MAX_DEPTH }` spelled out — genuinely
  // absent) exercises `ReferenceCheckOptions`'s own default value
  // (`options: ReferenceCheckOptions = {}`) composing correctly with
  // `options.maxDepth ?? DEFAULT_REFERENCE_MAX_DEPTH`'s own fallback. A
  // regression that broke either default (e.g. the parameter default
  // silently becoming required, or the `??` becoming `||` and treating
  // `maxDepth: 0` as "unset") would only show up on a call site that
  // truly omits the option, which is exactly what this test is.
  it('a-check-with-maxDepth-genuinely-omitted-from-the-call-still-resolves-a-grant-well-past-any-of-this-files-own-small-explicit-ceilings', () => {
    const schema = compileOk(SOURCE);
    // Reuses this file's own 14-hop chain (CHAIN_LENGTH = 15) — deep enough
    // to exceed every small explicit `maxDepth` used elsewhere in this file
    // (5), while remaining trivially within `DEFAULT_REFERENCE_MAX_DEPTH`
    // (1000) — so an allowed result here can only be explained by the
    // fallback actually landing on the real default, not on some smaller
    // implicit ceiling silently substituted in the option's absence.
    const tuples = buildChainTuples('priya');

    // The literal point of the test: no 6th argument at all.
    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'priya'),
      ref('folder', 'f0'),
      'view',
    );

    expect(result.allowed).toBe(true);
  });

  it('the-fallback-genuinely-is-DEFAULT_REFERENCE_MAX_DEPTH-a-chain-built-to-sit-exactly-one-hop-past-it-is-denied-with-the-option-omitted', () => {
    // The positive case above alone can't rule out an accidentally-huge
    // fallback (e.g. `Infinity`) standing in for the real, finite default —
    // it would also resolve this fixture allowed. This control pins the
    // fallback to the *exact* documented constant: a chain one hop longer
    // than `DEFAULT_REFERENCE_MAX_DEPTH` must be denied, with `maxDepth`
    // still genuinely omitted from the call.
    const schema = compileOk(SOURCE);
    const overLength = DEFAULT_REFERENCE_MAX_DEPTH + 1;
    const tuples: ReferenceTuple[] = [];
    for (let i = 0; i < overLength; i++) {
      tuples.push(tuple('folder', `g${i}`, 'parent', 'folder', `g${i + 1}`));
    }
    tuples.push(tuple('folder', `g${overLength}`, 'editor', 'user', 'quinn'));

    const result = referenceCheck(
      schema,
      tuples,
      ref('user', 'quinn'),
      ref('folder', 'g0'),
      'view',
    );

    expect(result.allowed).toBe(false);
  });
});

describe('a malformed maxDepth is rejected synchronously, before any recursion starts — full-repo audit finding #6, docs/DECISIONS.md D-092', () => {
  // `x > NaN` — and every other `>`/`<`/`>=`/`<=` comparison involving
  // `NaN` — is always `false` in JavaScript, never `true`. An unvalidated
  // `{ maxDepth: NaN }` would silently disable `resolveMembership`'s own
  // `depth > ctx.maxDepth` ceiling entirely, leaving branch-local cycle
  // detection (which, by design per D-021, does not fire on a genuinely
  // acyclic-but-deep chain — only a real repeated `(ns,id,relation)` on one
  // root-to-node path does) as the *only* termination guard. Concretely: a
  // long enough acyclic chain with `{ maxDepth: NaN }` would recurse until
  // it blew the real JS call stack — a `RangeError: Maximum call stack size
  // exceeded`, thrown from deep inside `resolveMembership`'s own recursion,
  // not from here — directly contradicting this file's own documented
  // contract on `referenceCheck` ("Never throws ... never an exception,
  // never a hang"). Verified live during this fix (not just argued): with
  // this file's own new guard temporarily commented out, a 20,000-node
  // acyclic chain (well beyond `DEFAULT_REFERENCE_MAX_DEPTH`) called with
  // `{ maxDepth: NaN }` threw exactly that native `RangeError`, confirming
  // the bug was real before landing this guard; restored before this test
  // file's own suite ran again. Matches the exact bug class `docs/
  // DECISIONS.md` D-074 already found and fixed once for
  // `src/store/tokens.ts`'s `assertTokenObserved`.
  const SIMPLE_SOURCE = ['namespace document {', '  relation viewer: user', '}'].join('\n');

  it('maxDepth-NaN-throws-a-plain-clear-error-not-the-confusing-native-RangeError-a-stack-overflow-would-produce', () => {
    const schema = compileOk(SIMPLE_SOURCE);
    expect(() =>
      referenceCheck(schema, [], ref('user', 'alice'), ref('document', 'readme'), 'viewer', {
        maxDepth: NaN,
      }),
    ).toThrow(/maxDepth/);
  });

  it('maxDepth-negative-throws-the-same-clear-error', () => {
    const schema = compileOk(SIMPLE_SOURCE);
    expect(() =>
      referenceCheck(schema, [], ref('user', 'alice'), ref('document', 'readme'), 'viewer', {
        maxDepth: -1,
      }),
    ).toThrow(/maxDepth/);
  });

  it('maxDepth-positive-Infinity-throws-the-same-clear-error', () => {
    // Infinity is not "not a number," but `depth > Infinity` is *always*
    // false too — exactly the same neutralized-ceiling hazard as NaN.
    const schema = compileOk(SIMPLE_SOURCE);
    expect(() =>
      referenceCheck(schema, [], ref('user', 'alice'), ref('document', 'readme'), 'viewer', {
        maxDepth: Infinity,
      }),
    ).toThrow(/maxDepth/);
  });

  it('maxDepth-negative-Infinity-throws-the-same-clear-error', () => {
    const schema = compileOk(SIMPLE_SOURCE);
    expect(() =>
      referenceCheck(schema, [], ref('user', 'alice'), ref('document', 'readme'), 'viewer', {
        maxDepth: -Infinity,
      }),
    ).toThrow(/maxDepth/);
  });

  it('the-thrown-error-is-a-plain-Error-thrown-synchronously-not-a-RangeError-surfacing-from-deep-recursion', () => {
    // Distinguishes "rejected up front, cleanly" from "the bug still
    // happened, we just got lucky and it surfaced as *some* exception" —
    // asserting the exact constructor, not merely `.toThrow()`.
    const schema = compileOk(SIMPLE_SOURCE);
    let caught: unknown;
    try {
      referenceCheck(schema, [], ref('user', 'alice'), ref('document', 'readme'), 'viewer', {
        maxDepth: NaN,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(RangeError);
  });

  it('a-large-but-finite-non-negative-maxDepth-is-not-rejected-the-guard-is-narrow', () => {
    // Control: the new guard must reject only the genuinely malformed
    // shapes above, never an ordinary large, valid ceiling — matches this
    // file's own established discipline (see the two tests immediately
    // preceding this describe block) of pairing a rejection test with a
    // control proving the check isn't simply overbroad.
    const schema = compileOk(SIMPLE_SOURCE);
    const result = referenceCheck(
      schema,
      [tuple('document', 'readme', 'viewer', 'user', 'alice')],
      ref('user', 'alice'),
      ref('document', 'readme'),
      'viewer',
      { maxDepth: 1_000_000 },
    );
    expect(result.allowed).toBe(true);
  });

  it('maxDepth-zero-is-a-valid-non-negative-finite-value-and-is-not-rejected', () => {
    // Control against the `??` vs `||` hazard this file's own fallback
    // tests above already guard elsewhere: `0` is falsy but perfectly
    // valid here too — it must reach the real depth-ceiling logic, not
    // this guard's rejection path.
    const schema = compileOk(SIMPLE_SOURCE);
    const result = referenceCheck(
      schema,
      [tuple('document', 'readme', 'viewer', 'user', 'alice')],
      ref('user', 'alice'),
      ref('document', 'readme'),
      'viewer',
      { maxDepth: 0 },
    );
    expect(result.allowed).toBe(true);
  });
});
