/**
 * DB-free unit tests for `queryScope` (`src/audit/scope.ts`) — the one
 * property this file's own top-of-file doc comment states as its whole
 * reason for existing separately from `/check/batch`: a single target's own
 * runtime failure must never abort any other target's own real, live
 * answer. Follows `test/unit/audit/list.test.ts`'s own established
 * `vi.spyOn`-on-module-namespace pattern: `hasAnyGrant` (`src/audit/list.js`)
 * is mocked at its own module boundary with per-call, per-target-controlled
 * outcomes (including a genuine rejection for one specific target); `queryScope`
 * itself is real and unmocked, so what's actually under test is its own
 * sequential-loop-plus-try/catch orchestration, not `hasAnyGrant`'s internal
 * candidate-scan/early-exit logic (already covered directly in
 * `list.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { queryScope, type ScopeQueryTarget } from '../../../src/audit/scope.js';
import * as listModule from '../../../src/audit/list.js';
import type { EntityRef } from '../../../src/audit/list.js';
import type { ConnectionSource } from '../../../src/store/query-executor.js';

const ALICE: EntityRef = { ns: 'user', id: 'alice' };
const FAKE_POOL = {} as ConnectionSource;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('queryScope — one outcome per target, in the same order supplied, never reordered', () => {
  it('preserves input order across mixed granted/not-granted targets', async () => {
    vi.spyOn(listModule, 'hasAnyGrant').mockImplementation(async (_pool, _subj, rel) =>
      rel === 'edit' ? { granted: true, truncated: false } : { granted: false, truncated: false },
    );
    const targets: ScopeQueryTarget[] = [
      { namespace: 'document', relationOrPermission: 'view' },
      { namespace: 'document', relationOrPermission: 'edit' },
      { namespace: 'folder', relationOrPermission: 'view' },
    ];

    const result = await queryScope(FAKE_POOL, ALICE, targets);

    expect(result.grants).toEqual([
      { namespace: 'document', relationOrPermission: 'view', granted: false, truncated: false },
      { namespace: 'document', relationOrPermission: 'edit', granted: true, truncated: false },
      { namespace: 'folder', relationOrPermission: 'view', granted: false, truncated: false },
    ]);
  });
});

describe("queryScope — a single target's own runtime failure never aborts any other target, the one property this file exists to guarantee (deliberately unlike /check/batch)", () => {
  it('one target throws (a genuine Postgres-shaped error); every other target still gets its own real, live answer', async () => {
    const hasAnyGrantSpy = vi
      .spyOn(listModule, 'hasAnyGrant')
      .mockImplementation(async (_pool, _subj, relationOrPermission) => {
        if (relationOrPermission === 'boom') {
          throw new Error('connection terminated unexpectedly');
        }
        return { granted: relationOrPermission === 'edit', truncated: false };
      });
    const targets: ScopeQueryTarget[] = [
      { namespace: 'document', relationOrPermission: 'view' },
      { namespace: 'document', relationOrPermission: 'boom' },
      { namespace: 'document', relationOrPermission: 'edit' },
    ];

    const result = await queryScope(FAKE_POOL, ALICE, targets);

    expect(result.grants).toHaveLength(3);
    expect(result.grants[0]).toEqual({
      namespace: 'document',
      relationOrPermission: 'view',
      granted: false,
      truncated: false,
    });
    const failed = result.grants[1]!;
    expect('error' in failed).toBe(true);
    if ('error' in failed) {
      expect(failed.namespace).toBe('document');
      expect(failed.relationOrPermission).toBe('boom');
      expect(failed.error).toBeInstanceOf(Error);
      expect(failed.error.message).toBe('connection terminated unexpectedly');
    }
    // The target AFTER the failing one still ran — proves the loop
    // continues past a caught failure rather than aborting the rest.
    expect(result.grants[2]).toEqual({
      namespace: 'document',
      relationOrPermission: 'edit',
      granted: true,
      truncated: false,
    });
    expect(hasAnyGrantSpy).toHaveBeenCalledTimes(3);
  });

  it('every target fails independently — each gets its own error, none masks or short-circuits another', async () => {
    vi.spyOn(listModule, 'hasAnyGrant').mockImplementation(
      async (_pool, _subj, relationOrPermission) => {
        throw new Error(`failure for ${relationOrPermission}`);
      },
    );
    const targets: ScopeQueryTarget[] = [
      { namespace: 'document', relationOrPermission: 'a' },
      { namespace: 'document', relationOrPermission: 'b' },
    ];

    const result = await queryScope(FAKE_POOL, ALICE, targets);

    expect(result.grants).toHaveLength(2);
    for (const [index, letter] of ['a', 'b'].entries()) {
      const outcome = result.grants[index]!;
      expect('error' in outcome).toBe(true);
      if ('error' in outcome) expect(outcome.error.message).toBe(`failure for ${letter}`);
    }
  });
});

describe("queryScope — threads the shared, request-level atToken/maxDepth into every target's own hasAnyGrant call identically", () => {
  it('the same atToken and maxDepth reach every target, not just the first', async () => {
    const hasAnyGrantSpy = vi
      .spyOn(listModule, 'hasAnyGrant')
      .mockResolvedValue({ granted: false, truncated: false });
    const targets: ScopeQueryTarget[] = [
      { namespace: 'document', relationOrPermission: 'view' },
      { namespace: 'folder', relationOrPermission: 'view' },
    ];

    await queryScope(FAKE_POOL, ALICE, targets, { atToken: 42, maxDepth: 5 });

    expect(hasAnyGrantSpy).toHaveBeenCalledTimes(2);
    for (const call of hasAnyGrantSpy.mock.calls) {
      expect(call[4]).toEqual({ atToken: 42, maxDepth: 5 });
    }
  });

  it('omits atToken/maxDepth entirely from the options object when neither is supplied, rather than passing them as explicit undefined', async () => {
    const hasAnyGrantSpy = vi
      .spyOn(listModule, 'hasAnyGrant')
      .mockResolvedValue({ granted: false, truncated: false });

    await queryScope(FAKE_POOL, ALICE, [{ namespace: 'document', relationOrPermission: 'view' }]);

    expect(hasAnyGrantSpy).toHaveBeenCalledTimes(1);
    expect(hasAnyGrantSpy.mock.calls[0]?.[4]).toEqual({});
  });
});

describe('queryScope — an empty targets array resolves to an empty grants array, no hasAnyGrant call at all', () => {
  it('zero targets, zero calls', async () => {
    const hasAnyGrantSpy = vi.spyOn(listModule, 'hasAnyGrant');

    const result = await queryScope(FAKE_POOL, ALICE, []);

    expect(result).toEqual({ grants: [] });
    expect(hasAnyGrantSpy).not.toHaveBeenCalled();
  });
});
