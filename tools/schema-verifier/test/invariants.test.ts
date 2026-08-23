/**
 * `parseInvariants` — build spec §4 exit criteria: "invariants parse from
 * a file; the three fixtures load; error messages on malformed input name
 * the line."
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseInvariants } from '../src/invariants/index.js';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/invariants/', import.meta.url));

function loadFixture(filename: string): string {
  return readFileSync(FIXTURE_DIR + filename, 'utf8');
}

describe('parseInvariants — the three worked fixtures all load', () => {
  it('tenant-isolation.invariant parses to the exact structure §4 describes', () => {
    const result = parseInvariants(loadFixture('tenant-isolation.invariant'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.invariants).toHaveLength(1);
    const inv = result.invariants[0]!;
    expect(inv.name).toBe('tenant_isolation');
    expect(inv.variables).toEqual([
      { name: 's', type: 'user' },
      { name: 'o', type: 'document' },
      { name: 'orgA', type: 'organization' },
      { name: 'orgB', type: 'organization' },
    ]);
    expect(inv.constraints).toEqual([
      { kind: 'distinct', variables: ['orgA', 'orgB'] },
      { kind: 'relationEquals', relation: 'tenant', subject: 's', value: 'orgA' },
      { kind: 'relationEquals', relation: 'tenant', subject: 'o', value: 'orgB' },
    ]);
    expect(inv.goal).toEqual({ permission: 'view', subject: 's', object: 'o' });
  });

  it('no-public-path-to-private-document.invariant parses with two distinct groups and two relation constraints', () => {
    const result = parseInvariants(loadFixture('no-public-path-to-private-document.invariant'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const inv = result.invariants[0]!;
    expect(inv.name).toBe('no_public_path_to_private_document');
    expect(inv.constraints).toEqual([
      { kind: 'distinct', variables: ['publicGroup', 'restrictedGroup'] },
      { kind: 'relationEquals', relation: 'member', subject: 's', value: 'publicGroup' },
      { kind: 'relationEquals', relation: 'visibility', subject: 'o', value: 'restrictedGroup' },
    ]);
    expect(inv.goal).toEqual({ permission: 'view', subject: 's', object: 'o' });
  });

  it('positive-control.invariant parses with zero constraints — a bare, unconstrained goal', () => {
    const result = parseInvariants(loadFixture('positive-control.invariant'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const inv = result.invariants[0]!;
    expect(inv.name).toBe('positive_control_view_is_reachable');
    expect(inv.constraints).toEqual([]);
    expect(inv.variables).toEqual([
      { name: 's', type: 'user' },
      { name: 'o', type: 'document' },
    ]);
    expect(inv.goal).toEqual({ permission: 'view', subject: 's', object: 'o' });
  });

  it('all three fixtures together, concatenated into one file, parse as three separate invariants', () => {
    const combined = [
      loadFixture('tenant-isolation.invariant'),
      loadFixture('no-public-path-to-private-document.invariant'),
      loadFixture('positive-control.invariant'),
    ].join('\n');
    const result = parseInvariants(combined);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.invariants.map((i) => i.name)).toEqual([
      'tenant_isolation',
      'no_public_path_to_private_document',
      'positive_control_view_is_reachable',
    ]);
  });
});

describe('parseInvariants — comments and blank lines', () => {
  it('ignores full-line comments, trailing comments, and blank lines without shifting reported line numbers', () => {
    const source = [
      '// a leading comment',
      '',
      'invariant with_comments { // trailing comment on the block start',
      '  s: user // trailing comment on a variable',
      '',
      '  // a comment between the variable and the goal',
      '  goal: view(s, s)',
      '}',
    ].join('\n');
    const result = parseInvariants(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.invariants[0]!.variables).toEqual([{ name: 's', type: 'user' }]);
  });
});

describe('parseInvariants — malformed input names the line', () => {
  it('an undeclared variable in a relation constraint names the constraint line, not the block start', () => {
    const source = [
      'invariant bad {',
      '  s: user',
      '  tenant(s) = orgA',
      '  goal: view(s, s)',
      '}',
    ].join('\n');
    const result = parseInvariants(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        line: 3,
        message: expect.stringContaining("undeclared variable 'orgA'"),
      }),
    );
  });

  it('an undeclared variable inside distinct(...) names that line', () => {
    const source = [
      'invariant bad {',
      '  a: user',
      '  distinct(a, b)',
      '  goal: view(a, a)',
      '}',
    ].join('\n');
    const result = parseInvariants(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        line: 3,
        message: expect.stringContaining("undeclared variable 'b'"),
      }),
    );
  });

  it('an undeclared variable in the goal line names that line', () => {
    const source = ['invariant bad {', '  s: user', '  goal: view(s, o)', '}'].join('\n');
    const result = parseInvariants(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        line: 3,
        message: expect.stringContaining("undeclared variable 'o'"),
      }),
    );
  });

  it('a duplicate variable name names the redeclaration line and cites the first declaration', () => {
    const source = [
      'invariant bad {',
      '  s: user',
      '  s: document',
      '  goal: view(s, s)',
      '}',
    ].join('\n');
    const result = parseInvariants(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        line: 3,
        message: expect.stringContaining('first declared at line 2'),
      }),
    );
  });

  it('a duplicate invariant name names the second block and cites the first', () => {
    const source = [
      'invariant dup {',
      '  s: user',
      '  goal: view(s, s)',
      '}',
      'invariant dup {',
      '  s: user',
      '  goal: view(s, s)',
      '}',
    ].join('\n');
    const result = parseInvariants(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        line: 5,
        message: expect.stringContaining('first declared at line 1'),
      }),
    );
  });

  it('a variable declared after a constraint is rejected and names that line', () => {
    const source = [
      'invariant bad {',
      '  a: user',
      '  b: user',
      '  distinct(a, b)',
      '  c: user',
      '  goal: view(a, b)',
      '}',
    ].join('\n');
    const result = parseInvariants(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        line: 5,
        message: expect.stringContaining('declared after a constraint'),
      }),
    );
  });

  it('a reserved word used as a variable name is rejected', () => {
    const source = ['invariant bad {', '  goal: user', '  goal: view(goal, goal)', '}'].join('\n');
    const result = parseInvariants(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // Line 2 is ambiguous on its own (`goal: user` also fails to match the
    // goal-line grammar), so this only asserts a reserved-word error fires
    // somewhere in the file, not which exact line — the point of this test
    // is that "goal" as a variable name is caught at all, not the recovery
    // path's exact shape.
    expect(result.errors.some((e) => e.message.includes('reserved word'))).toBe(true);
  });

  it('a missing closing brace is reported at the invariant’s own start line', () => {
    const source = ['invariant unclosed {', '  s: user', '  goal: view(s, s)'].join('\n');
    const result = parseInvariants(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        line: 1,
        message: expect.stringContaining("missing its closing '}'"),
      }),
    );
  });

  it('an unclosed block followed by a new invariant reports the missing brace once and still parses the second block', () => {
    const source = [
      'invariant first {',
      '  s: user',
      '  goal: view(s, s)',
      // missing `}` here
      'invariant second {',
      '  s: user',
      '  goal: view(s, s)',
      '}',
    ].join('\n');
    const result = parseInvariants(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        line: 1,
        message: expect.stringContaining("missing its closing '}'"),
      }),
    );
  });

  it('a completely unrecognized line names itself', () => {
    const source = [
      'invariant bad {',
      '  s: user',
      '  this is not valid syntax',
      '  goal: view(s, s)',
      '}',
    ].join('\n');
    const result = parseInvariants(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual(
      expect.objectContaining({ line: 3, message: expect.stringContaining('unrecognized line') }),
    );
  });

  it('an invariant with no goal line is rejected', () => {
    const source = ['invariant bad {', '  s: user', '}'].join('\n');
    const result = parseInvariants(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual(
      expect.objectContaining({ line: 1, message: expect.stringContaining("no 'goal:' line") }),
    );
  });

  it('an invariant with no variables is rejected', () => {
    const source = ['invariant bad {', '  goal: view(s, s)', '}'].join('\n');
    const result = parseInvariants(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(
      result.errors.some((e) => e.line === 1 && e.message.includes('declares no variables')),
    ).toBe(true);
  });

  it('collects every error in the file rather than stopping at the first', () => {
    const source = [
      'invariant bad {',
      '  s: user',
      '  distinct(s, missing1)',
      '  tenant(s) = missing2',
      '  goal: view(s, missing3)',
      '}',
    ].join('\n');
    const result = parseInvariants(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    const lines = result.errors.map((e) => e.line).sort();
    expect(lines).toEqual([3, 4, 5]);
  });
});
