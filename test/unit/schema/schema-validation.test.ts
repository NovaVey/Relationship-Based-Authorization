/**
 * Schema DSL compiler tests — rejection paths.
 *
 * Written from `.claude/commands/build-authz-service.md` §5 (the grammar)
 * and §10's "Schema DSL" test plan, and from `src/schema/dsl/types.ts` /
 * `src/schema/dsl/errors.ts` (the interface contract only — the
 * `SchemaErrorCode` enum and the worked example in `errors.ts`'s own doc
 * comment: "line 4: `permission` `edit` references undeclared relation
 * `admin`"). Per §14 delegation rule 5, `src/schema/dsl/parser.ts` and
 * `src/schema/dsl/compiler.ts` were deliberately NOT read while writing
 * these tests.
 */
import { describe, expect, it } from 'vitest';

import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { formatSchemaError } from '../../../src/schema/dsl/errors.js';

/** Compiles `source` and fails the test if it unexpectedly compiles; returns the errors otherwise. */
function compileErr(source: string) {
  const result = compileSchema(source);
  if (result.ok) {
    throw new Error('expected schema to be rejected, but it compiled successfully');
  }
  return result.errors;
}

describe('a-permission-referencing-an-undeclared-relation-is-rejected-with-the-relation-name', () => {
  // Mirrors errors.ts's own documented example almost exactly: a
  // `permission` on line 4 referencing a relation that was never declared
  // (`editor` — `owner` is the only relation `document` actually has).
  const source = [
    'namespace document {', // line 1
    '  relation owner: user', // line 2
    '', // line 3
    '  permission edit = editor | owner', // line 4
    '}', // line 5
  ].join('\n');

  it('a-permission-referencing-an-undeclared-relation-is-rejected-with-the-relation-name', () => {
    const errors = compileErr(source);
    const error = errors.find((e) => e.code === 'undeclared_reference');
    expect(error).toBeDefined();
    expect(error?.message).toContain('editor');
    expect(error?.line).toBe(4);
  });
});

describe('only-a-relation-not-a-permission-can-be-the-target-of-a-tuple-write', () => {
  // §5: "A permission is never itself the target of a tuple write — only a
  // relation can be. The compiler rejects a schema that tries." `document`
  // declares `view` as a *permission*; `folder#editor`'s subject type list
  // then names `document#view` — a permission, not a relation — as
  // something a tuple could point at. This must be rejected.
  const source = [
    'namespace document {', // line 1
    '  relation owner: user', // line 2
    '  permission view = owner', // line 3
    '}', // line 4
    '', // line 5
    'namespace folder {', // line 6
    '  relation editor: user | document#view', // line 7
    '}', // line 8
  ].join('\n');

  it('only-a-relation-not-a-permission-can-be-the-target-of-a-tuple-write', () => {
    const errors = compileErr(source);
    const error = errors.find((e) => e.code === 'subject_type_targets_a_permission');
    expect(error).toBeDefined();
    expect(error?.message).toContain('view');
    expect(error?.line).toBe(7);
  });
});

describe('an-empty-source-string-is-rejected-not-silently-compiled-as-zero-namespaces', () => {
  it('an-empty-source-string-is-rejected-not-silently-compiled-as-zero-namespaces', () => {
    const result = compileSchema('');
    expect(result.ok).toBe(false);
    if (result.ok) return; // narrows for TS; unreachable given the assertion above
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.code === 'empty_source')).toBe(true);
  });

  it('a-source-with-only-whitespace-is-also-rejected-not-treated-as-zero-namespaces', () => {
    const result = compileSchema('   \n\n  \t\n');
    expect(result.ok).toBe(false);
  });
});

describe('two-namespaces-with-the-same-name-in-one-compilation-unit-is-rejected', () => {
  const source = [
    'namespace document {', // line 1
    '  relation owner: user', // line 2
    '}', // line 3
    '', // line 4
    'namespace document {', // line 5
    '  relation viewer: user', // line 6
    '}', // line 7
  ].join('\n');

  it('two-namespaces-with-the-same-name-in-one-compilation-unit-is-rejected', () => {
    const errors = compileErr(source);
    const error = errors.find((e) => e.code === 'duplicate_namespace');
    expect(error).toBeDefined();
    expect(error?.message).toContain('document');
  });
});

describe('a-relation-and-a-permission-sharing-a-name-in-one-namespace-is-rejected', () => {
  // §5: only a `relation` can be a tuple-write target, and `types.ts`
  // states `relations`/`permissions` are separate maps precisely so a
  // relation and a permission can never collide under the same name. A
  // schema that declares both `relation view` and `permission view` in the
  // same namespace must be rejected rather than silently letting one
  // shadow the other.
  const source = [
    'namespace document {', // line 1
    '  relation owner: user', // line 2
    '  relation view: user', // line 3
    '  permission view = owner', // line 4
    '}', // line 5
  ].join('\n');

  it('a-relation-and-a-permission-sharing-a-name-in-one-namespace-is-rejected', () => {
    const errors = compileErr(source);
    const error = errors.find((e) => e.code === 'duplicate_member_name');
    expect(error).toBeDefined();
    expect(error?.message).toContain('view');
  });
});

describe('a-self-referential-permission-is-rejected-not-left-to-hang-whatever-eventually-walks-it', () => {
  // `permission view = view` names itself as its own (and only) computed
  // userset with no relation and no tuple-to-userset hop in between — a
  // static cycle of exactly one node the compiler must catch at compile
  // time rather than let reach a resolver's recursion budget.
  const source = [
    'namespace document {', // line 1
    '  relation owner: user', // line 2
    '  permission view = view', // line 3
    '}', // line 4
  ].join('\n');

  it('a-self-referential-permission-is-rejected-not-left-to-hang-whatever-eventually-walks-it', () => {
    const errors = compileErr(source);
    const error = errors.find((e) => e.code === 'circular_permission_definition');
    expect(error).toBeDefined();
    expect(error?.message).toContain('view');
    expect(error?.line).toBe(3);
  });

  it('a-longer-mutual-cycle-between-two-permissions-is-also-rejected-not-just-the-single-node-case', () => {
    // permission a = b, permission b = a — a two-node cycle, not caught by
    // a naive "does it name itself" check alone.
    const cyclicSource = [
      'namespace document {', // line 1
      '  relation owner: user', // line 2
      '  permission a = b', // line 3
      '  permission b = a', // line 4
      '}', // line 5
    ].join('\n');
    const errors = compileErr(cyclicSource);
    expect(errors.some((e) => e.code === 'circular_permission_definition')).toBe(true);
  });
});

describe('every SchemaError formats as "line N: <message>"', () => {
  // errors.ts's own contract for formatSchemaError — cheap to pin down
  // directly since it's part of the public interface this package exports.
  it('formatSchemaError-renders-line-number-and-message-in-the-documented-cli-friendly-shape', () => {
    const errors = compileErr(
      ['namespace document {', '  permission edit = admin', '}'].join('\n'),
    );
    const [error] = errors;
    expect(error).toBeDefined();
    if (!error) return;
    expect(formatSchemaError(error)).toBe(`line ${error.line}: ${error.message}`);
  });
});
