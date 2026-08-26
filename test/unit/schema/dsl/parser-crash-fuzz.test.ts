/**
 * Continuous crash-fuzzing of the schema DSL parser/compiler against
 * MALFORMED and adversarial input — the one thing nothing else in this
 * package's test suite provides on an ongoing basis.
 *
 * `src/schema/dsl/random.ts` (D-114) fuzzes VALID schemas: every schema it
 * emits is built to satisfy `compiler.ts`'s semantic rules by construction
 * and is fed through the real `compileSchema` only as a correctness check
 * on itself, never as an adversarial input — see that file's own "generator
 * bug, not an expected outcome" framing. `test/unit/schema/recursion-depth-
 * guards.test.ts` is the opposite extreme: exact, deterministic, hand-
 * picked regression tests pinned to specific, already-diagnosed bugs (D-067's
 * Bug A/B, D-132's Bug C, and this file's own Bug D — see that file's header
 * comment). Neither one throws genuinely random garbage, or randomly
 * corrupted real schema bytes, at the parser/compiler and checks that
 * nothing crashes or hangs on the *unknown* cases — which is exactly the
 * gap docs/DECISIONS.md D-132 closed by a one-off manual audit rather than
 * any repeatable proof mechanism: a confirmed, unauthenticated CPU-
 * exhaustion DoS reachable through `POST /schema/compile` (`src/api/
 * server.ts` — one of only two routes that deliberately skip
 * `requireAdminAuth`, calling `compileSchema()` synchronously with no
 * `await`, so a single slow/hanging compile freezes the whole event loop
 * for every other in-flight request on that instance).
 *
 * Three properties are checked, via `fast-check`, across every generated
 * and mutated input below:
 *
 *   (a) `compileSchema` never throws an unhandled, uncategorized exception.
 *       Every real syntax/semantic problem must come back as a normal
 *       `SchemaCompileResult` (`{ ok: false, errors: SchemaError[] }`) —
 *       never a raw `RangeError`/`TypeError`/anything else escaping
 *       `parseSchema`'s own single catch site. (`errors.ts`'s own doc
 *       comment on `SchemaParseError`, and `parseSchema`'s own comment on
 *       why a *truly* unexpected failure is deliberately left to propagate
 *       rather than being swallowed, both describe the contract this
 *       property is checking — a real throw here means adversarial input
 *       reached that "should never happen" path for real.) Enforced simply
 *       by never catching `compileSchema`'s own call inside
 *       `compileWithinBudget` below — a real throw fails the property
 *       naturally, and `fast-check`'s shrinker narrows it to a minimal
 *       reproducing input.
 *   (b) Every call completes inside `CRASH_FUZZ_BUDGET_MS`. Chosen from
 *       real measurements taken while building this file: every byte-cap-
 *       sized (65,536-byte) flat operator chain compiles in well under
 *       100ms post-fix, and thousands of mutation/generation sweeps across
 *       every strategy below never exceeded that either — 2 seconds is
 *       roughly 20-2000x that, generous the same way
 *       `MAX_EXPRESSION_NESTING_DEPTH` is, while staying far below anything
 *       resembling D-132's own confirmed 8.3-second hang.
 *   (c) Every schema that DID compile successfully has no dangling or
 *       unresolved reference in its `CompiledSchema` — checked directly
 *       against the compiled output (`assertNoDanglingReferences` below),
 *       independent of whatever internal bookkeeping `compileSchema` used
 *       to decide `ok: true`. Only meaningful for `ok: true` results,
 *       obviously — an `ok: false` rejection has no compiled schema to
 *       check.
 *
 * Four independent input sources, mixing raw generators with targeted
 * mutation of real schema source (schema/example.authz, and D-114's
 * `generateRandomSchema`-produced sources, byte-mutated) per this file's
 * own build brief:
 *
 *   1. Raw adversarial strings (`fc.string`, full Unicode) fed directly to
 *      `compileSchema` — "this isn't a schema at all."
 *   2. Strings built from the DSL's own token vocabulary in random order
 *      and quantity (braces, operators, keywords, real identifiers) —
 *      "looks schema-shaped but almost certainly isn't," far more likely
 *      than fully random bytes to get past the tokenizer and exercise real
 *      parser/compiler code paths.
 *   3. Byte-level mutation (flip / truncate / duplicate / insert / delete)
 *      of REAL, already-valid schema source — `schema/example.authz`
 *      itself, plus several `generateRandomSchema` (D-114) outputs —
 *      "almost a real schema, but corrupted," which is what an attacker
 *      chipping away at a schema that's known to work is actually likely
 *      to send.
 *   4. A dedicated flat-chain sweep: one operator (`|`, `&`, or `-`, picked
 *      at random) repeated a random number of times with no parentheses
 *      anywhere. This is a direct, general form of the exact shape that
 *      produced both D-132's Bug C (`|`/`&`, algorithmic — fixed by
 *      `flattenChildren`'s in-place extension) and this file's own Bug D
 *      (`-`, unbounded native recursion — fixed in `parser.ts`/`types.ts`).
 *      It's what gives this harness real teeth rather than green-by-
 *      accident: rerunning it with Bug D's fix reverted reliably fails
 *      (see docs/DECISIONS.md's own record of that live fail-check).
 *
 * **A genuine finding from building this file:** a flat, unparenthesized
 * `-` (exclusion) chain had *no* depth ceiling at all before this effort —
 * confirmed live, a ~5,000-term chain (well inside the real request-body
 * byte cap) threw a raw, unhandled `RangeError` straight out of
 * `checkCircularPermissions`'s `collectPermissionDeps`, with zero `(`
 * characters anywhere in the source, so Bug A's existing
 * `MAX_EXPRESSION_NESTING_DEPTH` guard (paren-nesting only) never saw it.
 * Fixed in `src/schema/dsl/parser.ts`/`src/schema/dsl/types.ts` — see
 * `test/unit/schema/recursion-depth-guards.test.ts`'s "Bug D" section for
 * the deterministic regression tests and the full writeup, and
 * `docs/DECISIONS.md` for the audit entry. Property 4 above (and, less
 * reliably, property 3's mutation sweep) independently rediscover it.
 *
 * Beyond Bug D, an extensive exploratory run of everything below (several
 * thousand raw-string/token-soup/mutation/flat-chain cases, run standalone
 * before this file was finalized, well beyond the iteration counts wired
 * into the properties here for normal CI runtime) found nothing else: no
 * other throw, no other call anywhere near the 2-second budget, and no
 * dangling reference in any schema that compiled. That absence is reported
 * honestly, not implied away — see this task's own write-up for the exact
 * counts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { array, assert, constantFrom, integer, property, string } from 'fast-check';

import { compileSchema } from '../../../../src/schema/dsl/compiler.js';
import { generateRandomSchema } from '../../../../src/schema/dsl/random.js';
import type { SchemaCompileResult } from '../../../../src/schema/dsl/errors.js';
import type { CompiledSchema, RewriteRule } from '../../../../src/schema/dsl/types.js';

// ---------------------------------------------------------------------------
// Shared budget + properties (a)/(b)/(c)
// ---------------------------------------------------------------------------

/** See this file's own header comment for how this number was chosen. */
const CRASH_FUZZ_BUDGET_MS = 2000;

/**
 * Property (a) + (b): calls `compileSchema` exactly once and returns its
 * result. Deliberately does NOT wrap the call in a try/catch — a genuine
 * throw here is precisely what property (a) forbids, so letting it
 * propagate fails the enclosing `fast-check` property naturally, with the
 * shrinker narrowing to a minimal reproducing input, which is far more
 * useful than a caught-and-rethrown generic assertion failure would be.
 */
function compileWithinBudget(source: string): SchemaCompileResult {
  const start = performance.now();
  const result = compileSchema(source);
  const elapsedMs = performance.now() - start;
  expect(elapsedMs).toBeLessThan(CRASH_FUZZ_BUDGET_MS);
  return result;
}

/**
 * Property (c): independently re-derives, by walking the compiled output
 * directly, the exact invariant `compiler.ts`'s own `compileRewriteRule`/
 * `compileRelations` are supposed to guarantee by construction — every
 * name a rewrite rule references actually exists where it's expected to.
 * Never consults `compileSchema`'s own error list or any other internal
 * bookkeeping; it only ever sees the final `CompiledSchema` shape, the same
 * thing every downstream consumer (the tuple store, both resolvers) reads.
 *
 * Deliberately iterative (an explicit work-list stack), never native
 * recursion — this checker walks output produced from adversarial/mutated
 * input by design (see this file's own header), so it must never itself
 * become a second place vulnerable to the exact unbounded-AST-depth DoS
 * class this file's Bug D closed in the production compiler. Confirmed
 * live: an earlier, straightforwardly-recursive version of this function
 * passed every test in this file right up until the live fail-check below
 * (Bug D's fix reverted) — the *checker's own* recursion, not
 * `compileSchema`, was what actually overflowed first for one shrunk
 * counterexample, muddying exactly what the fail-check was supposed to
 * demonstrate. Rewritten to this iterative form specifically so this
 * checker's own robustness never depends on whatever depth guarantee
 * `compileSchema` happens to currently provide — the same reasoning
 * `compiler.ts`'s own `checkCircularPermissions` rewrite (D-067) already
 * established for exactly this situation.
 */
function assertNoDanglingReferences(schema: CompiledSchema): void {
  for (const [nsName, ns] of Object.entries(schema.namespaces)) {
    for (const [permName, permission] of Object.entries(ns.permissions)) {
      const stack: RewriteRule[] = [permission.rewrite];
      while (stack.length > 0) {
        const node = stack.pop()!;
        switch (node.kind) {
          case 'computedUserset':
            if (!ns.relations[node.name] && !ns.permissions[node.name]) {
              throw new Error(
                `dangling reference: '${nsName}.${permName}' computedUserset names '${node.name}', which is neither a relation nor a permission on namespace '${nsName}'`,
              );
            }
            break;
          case 'union':
          case 'intersection':
            for (const child of node.children) stack.push(child);
            break;
          case 'exclusion':
            stack.push(node.base);
            stack.push(node.subtract);
            break;
          case 'tupleToUserset': {
            const relation = ns.relations[node.relation];
            if (!relation) {
              throw new Error(
                `dangling reference: '${nsName}.${permName}' follows relation '${node.relation}', which is not a relation on namespace '${nsName}'`,
              );
            }
            for (const subjectType of relation.subjectTypes) {
              const targetNs = schema.namespaces[subjectType.namespace];
              if (!targetNs) {
                throw new Error(
                  `dangling reference: '${nsName}.${permName}' follows '${node.relation}' into namespace '${subjectType.namespace}', which is not in the compiled schema`,
                );
              }
              if (
                !targetNs.relations[node.computedUserset] &&
                !targetNs.permissions[node.computedUserset]
              ) {
                throw new Error(
                  `dangling reference: '${nsName}.${permName}' follows '${node.relation}' into namespace '${subjectType.namespace}' and recurses into '${node.computedUserset}', which is neither a relation nor a permission there`,
                );
              }
            }
            break;
          }
          default: {
            // Exhaustive per `RewriteRule`'s discriminated union — a
            // `never` check at the type level, same discipline as
            // `compiler.ts`'s own `assertNeverRewriteRule`.
            const unreachable: never = node;
            throw new Error(
              `unreachable rewrite-rule kind in assertNoDanglingReferences: ${JSON.stringify(unreachable)}`,
            );
          }
        }
      }
    }
  }
}

/** Runs all three properties against one candidate source string. */
function checkCandidate(source: string): void {
  const result = compileWithinBudget(source);
  if (result.ok) {
    assertNoDanglingReferences(result.schema);
  }
}

// ---------------------------------------------------------------------------
// Seed corpus for mutation — real schema source, never hand-written garbage.
// ---------------------------------------------------------------------------

const EXAMPLE_SCHEMA_PATH = fileURLToPath(
  new URL('../../../../schema/example.authz', import.meta.url),
);
const EXAMPLE_SCHEMA_SOURCE = readFileSync(EXAMPLE_SCHEMA_PATH, 'utf8');

/**
 * A handful of deterministic `generateRandomSchema` (D-114) outputs,
 * generated once at module load — real, non-trivial, `compileSchema`-
 * validated source (every rewrite-rule kind, several namespaces), the
 * "targeted mutation of ... D-114's random.ts-generated valid schemas"
 * half of this task's own brief. Fixed seeds, not derived from any
 * fast-check draw, so a failure here is always reproducible by re-running
 * this file with no special flags.
 */
const RANDOM_SCHEMA_SOURCES = ['a', 'b', 'c', 'd', 'e'].map(
  (suffix) =>
    generateRandomSchema(`parser-crash-fuzz-mutation-seed-${suffix}`, {
      namespaceCount: 4,
      maxRelationsPerNamespace: 4,
      maxPermissionsPerNamespace: 3,
      maxRewriteDepth: 3,
    }).source,
);

const MUTATION_BASES = [EXAMPLE_SCHEMA_SOURCE, ...RANDOM_SCHEMA_SOURCES];

/**
 * Applies exactly one byte-level mutation to `source`, chosen by `kind`,
 * at a position/length derived from `rawA`/`rawB` (arbitrary, unclamped
 * integers from `fast-check` — clamped to a valid range here via modulo,
 * so any generated integer produces a well-defined mutation regardless of
 * `source`'s own length, and `fast-check` is free to shrink them without
 * this function ever needing to reject a candidate).
 */
function mutate(
  source: string,
  kind: 'flip' | 'truncate' | 'duplicate' | 'insert-garbage' | 'delete',
  rawA: number,
  rawB: number,
): string {
  const chars = source.split('');
  if (chars.length === 0) return source;
  const posA = Math.abs(rawA) % chars.length;
  const posB = Math.abs(rawB) % chars.length;

  switch (kind) {
    case 'flip': {
      // A printable ASCII replacement — including DSL-meaningful
      // characters (`(`, `-`, `&`, `|`) often enough to matter, since
      // `Math.abs(rawB) % 95` spans the full printable range starting at
      // `!` (0x21).
      chars[posA] = String.fromCharCode(0x21 + (Math.abs(rawB) % 95));
      return chars.join('');
    }
    case 'truncate':
      return chars.slice(0, posA).join('');
    case 'duplicate': {
      const start = Math.min(posA, posB);
      const end = Math.max(posA, posB) + 1;
      const chunk = chars.slice(start, end).join('');
      // A handful of repeats, not one — the whole point is manufacturing
      // exactly the kind of long, repeated-fragment source a flat operator
      // chain looks like (Bug C/D's own shape), not just a single splice.
      const repeats = 2 + (Math.abs(rawB) % 30);
      return chars.join('') + chunk.repeat(repeats);
    }
    case 'insert-garbage': {
      // DSL-operator-heavy garbage, deliberately — a random Unicode blob
      // almost always dies at the tokenizer in a handful of characters;
      // garbage built from the operators/parens this DSL actually cares
      // about is far more likely to reach deeper parser/compiler code.
      const garbageChars = ['-', '|', '&', '(', ')', 'a'];
      const length = 1 + (Math.abs(rawB) % 500);
      const garbage = Array.from(
        { length },
        (_, i) => garbageChars[(rawA + i) % garbageChars.length],
      ).join('');
      chars.splice(posA, 0, garbage);
      return chars.join('');
    }
    default: {
      // 'delete'
      const start = Math.min(posA, posB);
      const end = Math.max(posA, posB) + 1;
      chars.splice(start, end - start);
      return chars.join('');
    }
  }
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('compileSchema never crashes or hangs on adversarial input (D-132 class), and never dangles a reference when it does compile', () => {
  it('2,000 raw, fully-random Unicode strings never crash, never hang, and never dangle a reference when they happen to compile', () => {
    assert(
      property(string({ maxLength: 3000 }), (candidate) => {
        checkCandidate(candidate);
      }),
      { numRuns: 2000 },
    );
  }, 30_000);

  it("1,000 strings built from the DSL's own token vocabulary (braces, operators, keywords) never crash, never hang, and never dangle a reference when they happen to compile", () => {
    // Real DSL tokens in random order/quantity — "looks schema-shaped,"
    // far likelier than raw Unicode to get past the tokenizer and
    // exercise real parser/compiler recursion.
    const TOKEN_VOCABULARY = [
      'namespace',
      'relation',
      'permission',
      'user',
      'a',
      'b',
      'c',
      '{',
      '}',
      '(',
      ')',
      ':',
      '=',
      '|',
      '&',
      '-',
      '->',
      '#',
      '\n',
      ' ',
      '//',
    ] as const;
    assert(
      property(array(constantFrom(...TOKEN_VOCABULARY), { maxLength: 400 }), (tokens) => {
        checkCandidate(tokens.join(''));
      }),
      { numRuns: 1000 },
    );
  }, 30_000);

  it('500 byte-mutated copies of real schema source (schema/example.authz + generateRandomSchema outputs) never crash, never hang, and never dangle a reference when they happen to compile', () => {
    assert(
      property(
        constantFrom(...MUTATION_BASES),
        constantFrom('flip', 'truncate', 'duplicate', 'insert-garbage', 'delete'),
        integer(),
        integer(),
        (base, kind, rawA, rawB) => {
          checkCandidate(mutate(base, kind, rawA, rawB));
        },
      ),
      { numRuns: 500 },
    );
  }, 30_000);

  it("300 flat, unparenthesized single-operator chains at random length and random operator never crash, never hang, and never dangle a reference when they compile — the general shape behind both D-132's Bug C and this file's own Bug D", () => {
    assert(
      property(constantFrom('|', '&', '-'), integer({ min: 1, max: 20_000 }), (op, termCount) => {
        const chain = Array.from({ length: termCount }, () => 'owner').join(` ${op} `);
        const source = [
          'namespace document {',
          '  relation owner: user',
          `  permission p = ${chain}`,
          '}',
        ].join('\n');
        checkCandidate(source);
      }),
      { numRuns: 300 },
    );
  }, 60_000);
});

describe('compileSchema — a few explicit, non-random edge cases worth pinning down by name', () => {
  it('the empty string does not crash (rejected as empty_source, not a parser exception)', () => {
    const result = compileWithinBudget('');
    expect(result.ok).toBe(false);
  });

  it('a lone opening brace does not crash', () => {
    const result = compileWithinBudget('{');
    expect(result.ok).toBe(false);
  });

  it('a source consisting only of operators does not crash', () => {
    const result = compileWithinBudget('| & - -> # : =');
    expect(result.ok).toBe(false);
  });

  it('a single, absurdly long line with no whitespace or DSL structure at all does not crash', () => {
    const result = compileWithinBudget('x'.repeat(200_000));
    expect(result.ok).toBe(false);
  });

  it('every real example schema (schema/example.authz) still compiles cleanly and dangles nothing, unmutated', () => {
    const result = compileWithinBudget(EXAMPLE_SCHEMA_SOURCE);
    expect(result.ok).toBe(true);
    if (result.ok) assertNoDanglingReferences(result.schema);
  });
});
