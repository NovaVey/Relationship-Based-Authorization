/**
 * Regression tests for three independent, unauthenticated denial-of-service
 * paths found by full-repo audits: unbounded native (JS call-stack)
 * recursion, and unbounded algorithmic complexity, with no guard against
 * either, reachable from `POST /schema/compile` (`src/api/server.ts`,
 * unauthenticated by design — see that file's own doc comment — but never
 * itself reasoned about either DoS class until these fixes).
 *
 * Bug A: `src/schema/dsl/parser.ts`'s `parseAtom`/`parseTerm`/
 * `parseExpression` are mutually recursive with one native call-stack frame
 * consumed per level of `(` nesting in a permission expression — no depth
 * counter existed before this fix, so a source string with a few thousand
 * nested parens around a trivial expression (a handful of KB) drove that
 * recursion past Node's default call-stack size and threw a raw, unhandled
 * `RangeError` instead of a clean, located `SchemaError`.
 *
 * Bug B: `src/schema/dsl/compiler.ts`'s `checkCircularPermissions` walked
 * its permission-dependency graph via native recursion (one stack frame per
 * `permission pN = pN+1` edge in a chain) with no bound at all — reachable
 * with a long, *flat*, non-nested chain of permissions (no `(` anywhere),
 * so a fix that only bounds Bug A's paren-nesting does not close this path.
 * This is now an iterative worklist traversal (see that file's own doc
 * comment on `checkCircularPermissions` for the rewrite and how it was
 * verified against the original recursive version), which sidesteps the
 * native-recursion depth problem entirely rather than merely capping it.
 *
 * Bug C (`docs/DECISIONS.md`, the entry documenting this fix):
 * `parser.ts`'s `flattenChildren` rebuilt the *entire* accumulated
 * children array via array-spread on every step of a flat, unparenthesized
 * same-operator chain (`a1 & a2 & ... & aN`) — genuine O(N^2) work, with no
 * recursion involved at all, so neither Bug A's nor Bug B's fix touches it.
 * A confirmed, independently-reproduced ~32,700-term chain (the largest
 * that fits the real 65,536-byte request-body cap) took 8+ seconds of pure
 * synchronous CPU to compile before this fix — enough to freeze the
 * server's entire single-threaded event loop for every caller. Fixed by
 * extending the accumulated array in place instead of always copying it.
 *
 * Bug D — found by continuous crash-fuzzing (`test/unit/schema/dsl/
 * parser-crash-fuzz.test.ts`), not a manual audit: `flattenChildren` (Bug
 * C, above) merges a flat, unparenthesized `|`/`&` chain into one flat
 * n-ary node regardless of length, because union/intersection are
 * associative. Exclusion (`-`) is not associative (`(a-b)-c != a-(b-c)` in
 * general), so `parseExpression` never flattens it — each `-` genuinely
 * nests a new `{kind:'exclusion', base:left, ...}` node one level deeper
 * than the last, with *nothing* bounding that depth before this fix: Bug
 * A's `MAX_EXPRESSION_NESTING_DEPTH` counter only charged for `(` nesting,
 * never for this. A flat chain of ~5,000 `-` operators (`a - a - a - ...`,
 * zero `(` characters, comfortably inside the real request-body byte cap)
 * threw a raw, unhandled `RangeError` straight out of `checkCircular
 * Permissions`'s `collectPermissionDeps` — confirmed live, with a captured
 * stack trace showing the crash entirely inside that function's own
 * `node.subtract`/`node.base` recursion, before any fix. `compileRewriteRule`
 * has the identical structural recursion over the same tree and would
 * crash the same way for the same input if `collectPermissionDeps` (which
 * always runs first) didn't crash first. Fixed by charging exclusion-chain
 * links against the *same* counter and ceiling `(` nesting already used
 * (renamed `ParserState.parenDepth` -> `nestingDepth` to describe what it
 * now actually tracks) — the two compose additively, so e.g. 60 levels of
 * `(` wrapped around a 60-link `-` chain is rejected at the combined 100,
 * never allowed to reach 120 real AST levels. See `ParserState.nestingDepth`'s
 * and `MAX_EXPRESSION_NESTING_DEPTH`'s own doc comments for the full
 * reasoning, and `docs/DECISIONS.md` for the audit this closes.
 *
 * Per §14 delegation rule 5, these tests were written with only
 * `src/schema/dsl/types.ts` and `src/schema/dsl/errors.ts` read for their
 * public interface (`MAX_EXPRESSION_NESTING_DEPTH`, `SchemaErrorCode`) —
 * `parser.ts`/`compiler.ts`'s own implementations were read only to
 * diagnose and fix the bugs this file guards against, same as any other
 * bug-fix in this codebase.
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { MAX_EXPRESSION_NESTING_DEPTH } from '../../../src/schema/dsl/types.js';
import type { SchemaCompileResult } from '../../../src/schema/dsl/errors.js';

function nestedParenSource(depth: number): string {
  const open = '('.repeat(depth);
  const close = ')'.repeat(depth);
  return [
    'namespace document {',
    '  relation owner: user',
    `  permission p = ${open}owner${close}`,
    '}',
  ].join('\n');
}

function longAcyclicChainSource(n: number): string {
  const lines = ['namespace document {', '  relation owner: user'];
  for (let i = 0; i < n; i++) {
    lines.push(`  permission p${i} = p${i + 1}`);
  }
  // Grounded by a real relation — a legitimate, if unusually long, acyclic
  // permission chain, not an adversarial cycle.
  lines.push(`  permission p${n} = owner`);
  lines.push('}');
  return lines.join('\n');
}

function longFlatCycleSource(n: number): string {
  const lines = ['namespace document {', '  relation owner: user'];
  for (let i = 0; i < n; i++) {
    lines.push(`  permission p${i} = p${(i + 1) % n}`);
  }
  lines.push('}');
  return lines.join('\n');
}

function longFlatOperatorChainSource(n: number, op: '&' | '|'): string {
  const chain = Array.from({ length: n }, () => 'owner').join(op);
  return ['namespace document {', '  relation owner: user', `  permission p = ${chain}`, '}'].join(
    '\n',
  );
}

/** `n` terms joined by `n - 1` unparenthesized `-` (exclusion) operators — see Bug D below. */
function longFlatExclusionChainSource(n: number): string {
  const chain = Array.from({ length: n }, () => 'owner').join(' - ');
  return ['namespace document {', '  relation owner: user', `  permission p = ${chain}`, '}'].join(
    '\n',
  );
}

/**
 * `parenCount` levels of real `(` nesting wrapped around an inner flat
 * exclusion chain of `exclusionOps` operators — Bug D's fix charges both
 * against the same `nestingDepth` counter, so this is what proves the two
 * compose additively rather than each getting an independent 100-deep
 * budget.
 */
function nestedParenAroundExclusionChainSource(parenCount: number, exclusionOps: number): string {
  const open = '('.repeat(parenCount);
  const close = ')'.repeat(parenCount);
  const inner = Array.from({ length: exclusionOps + 1 }, () => 'owner').join(' - ');
  return [
    'namespace document {',
    '  relation owner: user',
    `  permission p = ${open}${inner}${close}`,
    '}',
  ].join('\n');
}

describe('deeply-nested-parenthesized-permission-expressions-are-rejected-with-a-clean-schema-error-not-a-rangeerror', () => {
  it('an-expression-nested-exactly-to-the-documented-ceiling-is-accepted', () => {
    const result = compileSchema(nestedParenSource(MAX_EXPRESSION_NESTING_DEPTH));
    expect(result.ok).toBe(true);
  });

  it('an-expression-nested-one-level-past-the-ceiling-is-rejected-with-expression-nesting-too-deep-not-a-crash', () => {
    const result = compileSchema(nestedParenSource(MAX_EXPRESSION_NESTING_DEPTH + 1));
    expect(result.ok).toBe(false);
    if (result.ok) return; // narrows for TS; unreachable given the assertion above
    expect(result.errors.length).toBe(1);
    const [error] = result.errors;
    expect(error).toBeDefined();
    expect(error?.code).toBe('expression_nesting_too_deep');
    expect(error?.message).toContain(String(MAX_EXPRESSION_NESTING_DEPTH));
    expect(error?.line).toBe(3);
  });

  it('a-source-with-thousands-of-nested-parens-well-past-the-auditors-reported-3000-to-5000-level-crash-range-is-rejected-cleanly-rather-than-throwing-a-raw-rangeerror', () => {
    // The audit reported reproducing `RangeError: Maximum call stack size
    // exceeded` at roughly 3,000-5,000 nesting levels before this fix.
    // Compiling must never throw here — it must return a normal,
    // structured rejection, same as any other malformed schema.
    let result: SchemaCompileResult | undefined;
    expect(() => {
      result = compileSchema(nestedParenSource(6000));
    }).not.toThrow();
    expect(result!.ok).toBe(false);
    if (result!.ok) return;
    expect(result!.errors.every((e) => e.code === 'expression_nesting_too_deep')).toBe(true);
  });
});

describe('a-long-flat-unparenthesized-exclusion-chain-is-rejected-with-a-clean-schema-error-not-a-rangeerror (Bug D)', () => {
  // Deliberately no `(` anywhere — the structurally new thing Bug D found:
  // `-` is the one expression-level operator `flattenChildren` never
  // flattens (exclusion is not associative), so a flat chain of `-`
  // operators builds a genuinely deep AST with zero paren nesting at all.
  // Before this fix, nothing charged that depth against
  // `MAX_EXPRESSION_NESTING_DEPTH` — only real `(` characters did.

  it('a-chain-with-exactly-the-documented-ceiling-worth-of-exclusion-operators-is-accepted', () => {
    // MAX_EXPRESSION_NESTING_DEPTH terms means MAX_EXPRESSION_NESTING_DEPTH - 1
    // operators; +1 term gives exactly the ceiling's worth of operators.
    const result = compileSchema(longFlatExclusionChainSource(MAX_EXPRESSION_NESTING_DEPTH + 1));
    expect(result.ok).toBe(true);
  });

  it('one-more-exclusion-operator-past-the-ceiling-is-rejected-with-expression-nesting-too-deep-not-a-crash', () => {
    const result = compileSchema(longFlatExclusionChainSource(MAX_EXPRESSION_NESTING_DEPTH + 2));
    expect(result.ok).toBe(false);
    if (result.ok) return; // narrows for TS; unreachable given the assertion above
    expect(result.errors.length).toBe(1);
    const [error] = result.errors;
    expect(error).toBeDefined();
    expect(error?.code).toBe('expression_nesting_too_deep');
    expect(error?.message).toContain(String(MAX_EXPRESSION_NESTING_DEPTH));
    expect(error?.line).toBe(3);
  });

  it('a-chain-of-thousands-of-exclusion-operators-well-past-the-confirmed-~5000-operator-live-crash-point-is-rejected-cleanly-rather-than-throwing-a-raw-rangeerror', () => {
    // Confirmed live, before this fix: a ~5,000-term flat `-` chain threw
    // `RangeError: Maximum call stack size exceeded` straight out of
    // `checkCircularPermissions`'s `collectPermissionDeps` — with zero `(`
    // characters anywhere in the source, so Bug A's own ceiling never saw
    // it. 6,000 is chosen the same way Bug A's own "well past the crash
    // range" case is (see above): comfortably past the confirmed live
    // crash point.
    let result: SchemaCompileResult | undefined;
    expect(() => {
      result = compileSchema(longFlatExclusionChainSource(6000));
    }).not.toThrow();
    expect(result!.ok).toBe(false);
    if (result!.ok) return;
    expect(result!.errors.every((e) => e.code === 'expression_nesting_too_deep')).toBe(true);
  });

  it('a-non-adversarial-real-world-shaped-exclusion-nested-a-handful-of-levels-deep-still-compiles-fine', () => {
    // Sanity check in the other direction: the fix must not have made any
    // ordinary, real-world exclusion usage stricter. `org.view = member -
    // banned` (schema/example.authz) is one operator; this checks a few
    // more still compile, since nothing about a legitimate schema's actual
    // shape changed.
    const result = compileSchema(longFlatExclusionChainSource(5));
    expect(result.ok).toBe(true);
  });

  it('paren-nesting-depth-and-unparenthesized-exclusion-chain-depth-compose-additively-against-one-shared-ceiling', () => {
    // The fix charges both `(` nesting and `-` chaining against the same
    // `ParserState.nestingDepth` counter specifically so this composition
    // holds — two independent 100-deep budgets (one per mechanism) would
    // still let a schema reach ~200 real AST levels by combining both,
    // which is not comfortably safe headroom below the confirmed ~5,000-
    // level crash point the way a single, shared 100-level ceiling is.
    const exactlyAtCeiling = compileSchema(nestedParenAroundExclusionChainSource(50, 50));
    expect(exactlyAtCeiling.ok).toBe(true);

    const onePastCeiling = compileSchema(nestedParenAroundExclusionChainSource(60, 60));
    expect(onePastCeiling.ok).toBe(false);
    if (onePastCeiling.ok) return;
    expect(onePastCeiling.errors.every((e) => e.code === 'expression_nesting_too_deep')).toBe(true);
  });
});

describe('a-long-flat-non-nested-permission-dependency-chain-is-handled-without-a-native-stack-overflow', () => {
  // Deliberately no `(` anywhere in either schema below — this is the
  // structurally separate path from the paren-nesting cases above: a flat
  // chain of `permission pN = pN+1` statements, which drove the *compiler's*
  // (not the parser's) circular-permission DFS to overflow the native call
  // stack even with Bug A's paren-depth fix already in place. 10,000
  // permissions is chosen to comfortably exceed the audit's own reported
  // 8,500-9,600 crash range for this exact case.

  it('a-10000-permission-legitimate-acyclic-chain-compiles-successfully-and-quickly-not-a-stack-overflow', () => {
    const n = 10_000;
    const start = Date.now();
    let result: SchemaCompileResult | undefined;
    expect(() => {
      result = compileSchema(longAcyclicChainSource(n));
    }).not.toThrow();
    const elapsedMs = Date.now() - start;
    expect(result!.ok).toBe(true);
    if (!result!.ok) return;
    expect(Object.keys(result!.schema.namespaces['document']?.permissions ?? {})).toHaveLength(
      n + 1,
    );
    // A generous ceiling — this genuinely is fast (well under a second in
    // local measurement); a large timeout only guards against this
    // regressing back to the old, effectively-unbounded recursive cost.
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it('a-10000-permission-adversarial-flat-cycle-with-no-nesting-is-rejected-cleanly-not-a-stack-overflow-and-not-a-hang', () => {
    const n = 10_000;
    const start = Date.now();
    let result: SchemaCompileResult | undefined;
    expect(() => {
      result = compileSchema(longFlatCycleSource(n));
    }).not.toThrow();
    const elapsedMs = Date.now() - start;
    expect(result!.ok).toBe(false);
    if (result!.ok) return;
    const circularErrors = result!.errors.filter(
      (e) => e.code === 'circular_permission_definition',
    );
    // Every member of the one big cycle gets its own located error — see
    // D-013 (docs/DECISIONS.md) for why the whole cycle is reported, not
    // just its first-detected edge.
    expect(circularErrors).toHaveLength(n);
    // Also guards against the second, latent quadratic cost found live
    // while verifying this fix (`reportCycle` re-joining the full cycle
    // path once per member instead of once per cycle) — without that fix,
    // this case is a multi-second-to-OOM cost instead of a fast rejection.
    expect(elapsedMs).toBeLessThan(10_000);
  });
});

describe('a-long-flat-same-operator-chain-in-one-permission-expression-compiles-in-roughly-linear-time-not-quadratic (Bug C)', () => {
  // Deliberately no `(` anywhere — this is the third, structurally
  // separate DoS class this file guards against: unlike Bug A/B, there is
  // no recursion here at all (native or otherwise) to overflow. The bug
  // was purely algorithmic complexity inside `flattenChildren`'s own
  // array-spread, on every step of a flat chain of the SAME operator
  // (`a & a & ... & a`, or `a | a | ... | a`) within one expression.
  //
  // 60,000 terms is chosen to comfortably exceed the real request-body
  // byte cap's own worst-case chain length (~32,700 terms at 65,536
  // bytes, per the audit's own binary search) while staying well inside
  // what the fixed, roughly-linear implementation compiles in
  // milliseconds — before this fix, a chain this long would not have
  // finished in any test-suite-reasonable time at all (the O(N^2) cost
  // measured at n=32,000 alone was already ~7.6s; n=60,000 would be
  // several times that, not linearly scaled).

  it.each(['&', '|'] as const)(
    'a-60000-term-flat-%s-chain-compiles-quickly-and-produces-one-correctly-shaped-flat-node',
    (op) => {
      const n = 60_000;
      const start = Date.now();
      let result: SchemaCompileResult | undefined;
      expect(() => {
        result = compileSchema(longFlatOperatorChainSource(n, op));
      }).not.toThrow();
      const elapsedMs = Date.now() - start;
      expect(result!.ok).toBe(true);
      if (!result!.ok) return;
      const rewrite = result!.schema.namespaces['document']?.permissions['p']?.rewrite;
      const expectedKind = op === '&' ? 'intersection' : 'union';
      expect(rewrite?.kind).toBe(expectedKind);
      if (rewrite?.kind !== 'union' && rewrite?.kind !== 'intersection') return;
      // Correctness, not just speed: the fast path must still flatten the
      // entire chain into ONE node with all N children — not, say, quietly
      // truncating or nesting to hit the speed target.
      expect(rewrite.children).toHaveLength(n);
      expect(rewrite.children.every((c) => c.kind === 'computedUserset')).toBe(true);
      // A generous ceiling, same discipline as the two describe blocks
      // above — this genuinely compiles in well under a second locally;
      // the large timeout only guards against regressing back to the old
      // O(N^2)-plus cost.
      expect(elapsedMs).toBeLessThan(10_000);
    },
  );

  it('a-mixed-amp-then-pipe-chain-still-flattens-each-operator-into-its-own-correctly-sized-node', () => {
    // Guards against an in-place-mutation fix accidentally aliasing state
    // across the two independent operators: `&` binds tighter than `|`
    // (see `parseTerm`/`parseExpression`), so `a&a&...&a | a&a&...&a` must
    // compile to a union of exactly two intersection nodes, each with its
    // own, independently-sized children array — not one merged node, and
    // not two nodes secretly sharing one mutated array.
    const half = 15_000;
    const chain = Array.from({ length: half }, () => 'owner').join('&');
    const source = [
      'namespace document {',
      '  relation owner: user',
      `  permission p = ${chain} | ${chain}`,
      '}',
    ].join('\n');
    const result = compileSchema(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rewrite = result.schema.namespaces['document']?.permissions['p']?.rewrite;
    expect(rewrite?.kind).toBe('union');
    if (rewrite?.kind !== 'union') return;
    expect(rewrite.children).toHaveLength(2);
    for (const child of rewrite.children) {
      expect(child.kind).toBe('intersection');
      if (child.kind !== 'intersection') continue;
      expect(child.children).toHaveLength(half);
    }
    // The two intersection children must be genuinely independent arrays
    // — mutating one must never be observable on the other.
    const [first, second] = rewrite.children;
    expect(first === second).toBe(false);
    if (first?.kind === 'intersection' && second?.kind === 'intersection') {
      expect(first.children === second.children).toBe(false);
    }
  });
});
