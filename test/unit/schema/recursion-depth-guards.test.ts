/**
 * Regression tests for two independent, unauthenticated denial-of-service
 * paths found by a full-repo audit: unbounded native (JS call-stack)
 * recursion, with no depth guard, reachable from `POST /schema/compile`
 * (`src/api/server.ts`, unauthenticated by design — see that file's own
 * doc comment — but never itself reasoned about recursion-depth DoS until
 * now).
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
