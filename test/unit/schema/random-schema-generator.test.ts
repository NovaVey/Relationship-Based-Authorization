/**
 * `generateRandomSchema` (`src/schema/dsl/random.ts`) — the shared,
 * general-purpose random *schema* generator landed on `main` as a
 * prerequisite for the schema verifier's own §2b ("both DST's workload
 * generator and the verifier's differential tests need to produce random
 * valid schemas"). Distinct from `src/soundness/generators.ts`'s
 * `generateFixture`, which randomizes tuple *data* over one fixed
 * three-namespace-role schema shape — this module randomizes the schema
 * shape itself.
 *
 * The load-bearing claim under test: every schema this generator can
 * produce is valid by construction (checked here by actually compiling
 * it through the real `compileSchema`, never by inspecting the generator's
 * own internal state) and deterministic given `seed` + `options`.
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { generateRandomSchema } from '../../../src/schema/dsl/random.js';

describe('generateRandomSchema — determinism', () => {
  it('the same seed and options produce byte-identical source, twice', () => {
    const a = generateRandomSchema('determinism-seed-1');
    const b = generateRandomSchema('determinism-seed-1');
    expect(b.source).toBe(a.source);
  });

  it('the same seed and options produce a deep-equal compiled schema, twice', () => {
    const a = generateRandomSchema('determinism-seed-2');
    const b = generateRandomSchema('determinism-seed-2');
    expect(b.schema).toEqual(a.schema);
  });

  it('the same seed with explicit options is still deterministic (resolveOptions draws do not perturb it)', () => {
    const options = {
      namespaceCount: 4,
      principalCount: 2,
      maxRelationsPerNamespace: 4,
      maxPermissionsPerNamespace: 3,
      maxRewriteDepth: 3,
    };
    const a = generateRandomSchema('determinism-seed-3', options);
    const b = generateRandomSchema('determinism-seed-3', options);
    expect(b.source).toBe(a.source);
    expect(b.schema).toEqual(a.schema);
  });

  it('two different seeds produce different source (sanity — not a strict requirement, but a generator that ignores its own seed is broken)', () => {
    const a = generateRandomSchema('seed-alpha');
    const b = generateRandomSchema('seed-beta');
    expect(a.source).not.toBe(b.source);
  });
});

describe('generateRandomSchema — every generated schema compiles for real', () => {
  it('500 default-option seeds all compile through the real compileSchema', () => {
    const failures: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      const seed = `compile-sweep-${i}`;
      // generateRandomSchema itself throws on a compile failure (its own
      // top-of-file "constructive correctness" claim) — this loop exists
      // to report every failing seed at once rather than stopping at the
      // first, and to double-check the returned `schema` really is what
      // an independent `compileSchema(source)` call produces.
      let result: ReturnType<typeof generateRandomSchema>;
      try {
        result = generateRandomSchema(seed);
      } catch (err) {
        failures.push(`${seed}: generation threw — ${(err as Error).message}`);
        continue;
      }
      const recompiled = compileSchema(result.source);
      if (!recompiled.ok) {
        failures.push(`${seed}: source did not recompile independently`);
      } else if (JSON.stringify(recompiled.schema) !== JSON.stringify(result.schema)) {
        failures.push(`${seed}: returned schema differs from an independent recompile`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('300 seeds at high option ceilings (5 namespaces, depth 4, all operators) all compile', () => {
    // 300, not 1000: CI runner speed varies enough between runs (one
    // observed run: 1000 iterations took 23.35s; a later run of the
    // identical code took 49.35s and blew through a 45s timeout with
    // every assertion still passing) that iteration count itself needed
    // to come down, not just the timeout back it's checked against.
    // 300 is still comfortably enough to see every rewrite-rule operator
    // appear (each showed up within the first ~10 of 500+ seeds in
    // local runs) while cutting both the typical and worst-case runtime
    // by roughly 3x.
    const failures: string[] = [];
    let sawTupleToUserset = false;
    let sawIntersection = false;
    let sawExclusion = false;
    let sawUnion = false;
    for (let i = 0; i < 300; i += 1) {
      const seed = `stress-sweep-${i}`;
      try {
        const result = generateRandomSchema(seed, {
          namespaceCount: 5,
          principalCount: 2,
          maxRelationsPerNamespace: 5,
          maxPermissionsPerNamespace: 4,
          maxRewriteDepth: 4,
        });
        if (result.source.includes('->')) sawTupleToUserset = true;
        if (result.source.includes(' & ')) sawIntersection = true;
        if (/ - /.test(result.source)) sawExclusion = true;
        if (result.source.includes(' | ')) sawUnion = true;
      } catch (err) {
        failures.push(`${seed}: ${(err as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
    // Every rewrite-rule kind actually appears somewhere across the
    // sweep — a generator that never emits `tupleToUserset` (say) would
    // compile fine and pass every check above while silently never
    // exercising the one edge class the schema verifier's own build
    // spec calls "the one to get exactly right."
    expect(sawTupleToUserset).toBe(true);
    expect(sawIntersection).toBe(true);
    expect(sawExclusion).toBe(true);
    expect(sawUnion).toBe(true);
  }, 60_000);

  it('a single-namespace, principal-only schema (no earlier structural namespace to target) still compiles', () => {
    const result = generateRandomSchema('edge-single-namespace', {
      namespaceCount: 1,
      principalCount: 1,
      maxRewriteDepth: 3,
    });
    expect(compileSchema(result.source).ok).toBe(true);
  });
});

describe('generateRandomSchema — operator mix', () => {
  it('disabling intersection and exclusion produces a monotone-fragment schema (union + tupleToUserset only)', () => {
    for (let i = 0; i < 50; i += 1) {
      const result = generateRandomSchema(`monotone-${i}`, {
        namespaceCount: 4,
        maxRewriteDepth: 3,
        operators: { intersection: false, exclusion: false },
      });
      expect(result.source).not.toMatch(/ & /);
      expect(result.source).not.toMatch(/ - /);
    }
  });

  it('disabling every combinator produces only bare computedUserset/tupleToUserset leaves', () => {
    const result = generateRandomSchema('leaves-only', {
      namespaceCount: 3,
      maxRewriteDepth: 3,
      operators: { union: false, intersection: false, exclusion: false },
    });
    expect(result.source).not.toMatch(/ [|&-] /);
    expect(compileSchema(result.source).ok).toBe(true);
  });

  it('disabling tupleToUserset never emits an arrow', () => {
    for (let i = 0; i < 50; i += 1) {
      const result = generateRandomSchema(`no-arrow-${i}`, {
        namespaceCount: 4,
        maxRewriteDepth: 3,
        operators: { tupleToUserset: false },
      });
      expect(result.source).not.toContain('->');
    }
  });
});

describe('generateRandomSchema — invalid options', () => {
  it.each([
    ['namespaceCount', { namespaceCount: 0 }],
    ['namespaceCount', { namespaceCount: -1 }],
    ['principalCount', { principalCount: 0 }],
    ['maxRelationsPerNamespace', { maxRelationsPerNamespace: 0 }],
    ['maxPermissionsPerNamespace', { maxPermissionsPerNamespace: 0 }],
    ['maxRewriteDepth', { maxRewriteDepth: -1 }],
  ])(
    'rejects an out-of-range %s with a clear message naming it, not a generic compile failure',
    (name, options) => {
      expect(() => generateRandomSchema('invalid-options-seed', options)).toThrow(new RegExp(name));
    },
  );

  it('maxRewriteDepth: 0 is valid (leaf-only permissions, no combinators)', () => {
    const result = generateRandomSchema('zero-depth', { maxRewriteDepth: 0, namespaceCount: 2 });
    expect(result.source).not.toMatch(/ [|&-] /);
    expect(compileSchema(result.source).ok).toBe(true);
  });
});
