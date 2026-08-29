/**
 * `lookupRelationMembershipIndex` (`src/store/relation-index.ts`) — DB-free
 * unit tests. `docs/LEOPARD-INDEX-PROPOSAL.md`, "Test plan — the third
 * comparison arm," names this file's own job precisely: "the fast, DB-free,
 * permanent regression guard for Candidates C, F, G's decision logic once
 * each is confirmed real." No Postgres, no Testcontainers, no DST fake
 * store (`src/store/dst/` has no notion of `relation_membership_index`/
 * `relation_membership_index_state` at all — this file drives the real
 * function directly against a hand-written fake `QueryExecutor` that
 * returns canned rows, the exact same pattern
 * `test/unit/resolve/production/snapshot-anchor-invariant.test.ts` already
 * uses for `guardPinnedClientForSnapshotAnchor`, and several other files in
 * this directory use for their own storage-seam functions).
 *
 * **Why canned rows, not a re-implementation of the real SQL predicates.**
 * `lookupRelationMembershipIndex` issues exactly two queries and applies
 * exactly two of its own *TypeScript-level* gates on top of whatever rows
 * come back — the watermark-vs-floor comparison (Candidate C) and the
 * stored-path-length-vs-`maxDepth` comparison (Candidate F). The `min_
 * expires_at is null or min_expires_at > now()` predicate (Candidate G) is
 * evaluated inside Postgres itself, before a row is ever handed back to
 * this function — this file cannot exercise that predicate without a real
 * database (that is exactly what
 * `test/unit/store/relation-index.integration.test.ts` and
 * `test/metamorphic/relation-index-soundness.integration.test.ts` are for).
 * What this file CAN and does prove, DB-free, is the second half of
 * Candidate G's own contract: a row that has *already survived* that
 * predicate (whether because `min_expires_at` was NULL, or because it was a
 * real, still-future timestamp) must produce `touchedExpiringTuple` that
 * mirrors `row.min_expires_at !== null` exactly — the fix for the real bug
 * `docs/LEOPARD-INDEX-PROPOSAL.md`'s own adversarial-review pass found in an
 * earlier draft (hardcoding `touchedExpiringTuple: false` regardless of the
 * row), which would have silently defeated `src/audit/checks.ts`'s D-144
 * check-cache safety gate.
 *
 * Every test below was verified to actually fail when the specific
 * behavior it names is broken — see this file's own accompanying task
 * report for exactly which line was temporarily inverted/removed/hardcoded
 * for each one, then restored.
 */
import { describe, expect, it } from 'vitest';

import { lookupRelationMembershipIndex } from '../../../../src/store/relation-index.js';
import type { QueryExecutor, QueryResultLike } from '../../../../src/store/query-executor.js';

/** An arbitrary, fixed (object, relation, subject) triple — its exact identity is never asserted on; every test below only cares about the canned rows and the resulting `RelationIndexLookup`. */
const OBJECT = { ns: 'group', id: 'eng' };
const RELATION = 'member';
const SUBJECT = { ns: 'user', id: 'alice' };

/**
 * Builds a `via_path` of exactly `hopCount` hops (`hopCount + 1` nodes) in
 * the same `ns:id#relation`-string shape `FrontierRow.path` uses —
 * `lookupRelationMembershipIndex` never parses these strings itself (it
 * hands the array straight back on a hit), so their exact content is
 * irrelevant to this file's own tests; only `.length` matters, which is
 * exactly what Candidate F's own gate (`row.via_path.length - 1 >
 * maxDepth`) reads.
 */
function pathOfHops(hopCount: number): string[] {
  return Array.from({ length: hopCount + 1 }, (_, i) => `group:node${i}#member`);
}

/**
 * A minimal fake `QueryExecutor` that returns one canned response per call,
 * in the exact order `lookupRelationMembershipIndex` issues them when it
 * doesn't short-circuit: first the `relation_membership_index_state` read,
 * then the `relation_membership_index` read. A canned entry may also be an
 * `Error`, to drive this file's own "an exception is never swallowed here"
 * tests. Throws loudly (rather than returning some default) if
 * `lookupRelationMembershipIndex` ever issues MORE queries than were
 * canned — the same "a wrong pause point throws its own loud, structural
 * error" discipline `token-pin-coverage.dst.test.ts`'s own top-of-file doc
 * comment describes for `raceUnderPause`, applied here to query count
 * instead of pause-point count.
 */
function createCannedClient(responses: ReadonlyArray<QueryResultLike | Error>): {
  client: QueryExecutor;
  calls: Array<{ text: string; params: readonly unknown[] | undefined }>;
} {
  const calls: Array<{ text: string; params: readonly unknown[] | undefined }> = [];
  const client: QueryExecutor = {
    async query<Row = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResultLike<Row>> {
      calls.push({ text, params });
      const response = responses[calls.length - 1];
      if (response === undefined) {
        throw new Error(
          `fake client received query #${calls.length} ('${text}') but only ` +
            `${responses.length} canned response(s) were provided — ` +
            `lookupRelationMembershipIndex issued more queries than this test expected`,
        );
      }
      if (response instanceof Error) throw response;
      return response as unknown as QueryResultLike<Row>;
    },
  };
  return { client, calls };
}

/** Canned `relation_membership_index_state` row — `undefined` models the table's never-been-rebuilt state (zero rows, `state[0]` is `undefined`), matching a real never-populated singleton row scenario the doc comment above calls out explicitly. */
function stateRow(watermarkToken: number | undefined): QueryResultLike {
  const rows = watermarkToken === undefined ? [] : [{ watermark_token: String(watermarkToken) }];
  return { rows, rowCount: rows.length };
}

/** Canned `relation_membership_index` row — `undefined` `viaPath` models "no matching row survived the WHERE clause" (a plain miss, no exception). */
function membershipRow(viaPath: string[] | undefined, minExpiresAt: Date | null): QueryResultLike {
  const rows = viaPath === undefined ? [] : [{ via_path: viaPath, min_expires_at: minExpiresAt }];
  return { rows, rowCount: rows.length };
}

// ---------------------------------------------------------------------------
// Candidate C — "Watermark staleness must never produce a false ALLOW."
// docs/LEOPARD-INDEX-PROPOSAL.md's own single most load-bearing property.
// ---------------------------------------------------------------------------

describe('Candidate C — the watermark-vs-floor gate', () => {
  it('a-watermark-strictly-below-the-required-floor-token-is-a-miss-and-never-even-reads-the-membership-table', async () => {
    const { client, calls } = createCannedClient([stateRow(9)]);

    const result = await lookupRelationMembershipIndex(client, OBJECT, RELATION, SUBJECT, 10, 10);

    expect(result).toEqual({ hit: false });
    // A stale index must never be trusted for ANY row it might contain —
    // the fix must reject before ever asking whether a matching row
    // exists, not filter results out after the fact.
    expect(calls).toHaveLength(1);
  });

  it('a-watermark-exactly-equal-to-the-required-floor-token-is-fresh-enough-to-be-trusted', async () => {
    const path = pathOfHops(0);
    const { client } = createCannedClient([stateRow(10), membershipRow(path, null)]);

    const result = await lookupRelationMembershipIndex(client, OBJECT, RELATION, SUBJECT, 0, 10);

    expect(result).toEqual({
      hit: true,
      allowed: true,
      certain: true,
      path,
      touchedExpiringTuple: false,
    });
  });

  it('a-watermark-strictly-above-the-required-floor-token-is-fresh-enough-to-be-trusted', async () => {
    const path = pathOfHops(0);
    const { client } = createCannedClient([stateRow(50), membershipRow(path, null)]);

    const result = await lookupRelationMembershipIndex(client, OBJECT, RELATION, SUBJECT, 0, 10);

    expect(result.hit).toBe(true);
  });

  it('a-never-built-index-with-no-state-row-at-all-defaults-its-watermark-to-zero-and-misses-any-positive-floor', async () => {
    const { client, calls } = createCannedClient([stateRow(undefined)]);

    const result = await lookupRelationMembershipIndex(client, OBJECT, RELATION, SUBJECT, 10, 1);

    expect(result).toEqual({ hit: false });
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Candidate F — "An index hit must respect the calling check's own
// maxDepth, not just whatever depth the rebuild happened to reach."
// ---------------------------------------------------------------------------

describe('Candidate F — the stored-path-length-vs-maxDepth gate', () => {
  it('a-stored-via-path-longer-than-the-callers-own-maxDepth-falls-back-to-a-miss-rather-than-silently-overriding-the-narrower-budget', async () => {
    const path = pathOfHops(5); // 5 hops — one more than maxDepth below.
    const { client } = createCannedClient([stateRow(10), membershipRow(path, null)]);

    const result = await lookupRelationMembershipIndex(client, OBJECT, RELATION, SUBJECT, 4, 10);

    expect(result).toEqual({ hit: false });
  });

  it('a-stored-via-path-with-hop-count-exactly-equal-to-the-callers-maxDepth-still-hits', async () => {
    const path = pathOfHops(3); // exactly at the ceiling — 3 hops, maxDepth 3.
    const { client } = createCannedClient([stateRow(10), membershipRow(path, null)]);

    const result = await lookupRelationMembershipIndex(client, OBJECT, RELATION, SUBJECT, 3, 10);

    expect(result).toEqual({
      hit: true,
      allowed: true,
      certain: true,
      path,
      touchedExpiringTuple: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Candidate G — "An index-hit ALLOW must never survive past a stored path's
// own real expiry." The SQL-level half of this gate (a row with an expired
// `min_expires_at` never survives the WHERE clause at all) needs real
// Postgres — see this file's own top-of-file doc comment. What's DB-free
// and tested here is the second half: `touchedExpiringTuple` must mirror
// `row.min_expires_at !== null` for whatever row DOES survive, exactly —
// this is the literal fix for the disclosed "hardcoded touchedExpiringTuple:
// false" bug the design doc's own adversarial-review pass found.
// ---------------------------------------------------------------------------

describe('Candidate G (the SQL-level contract) — touchedExpiringTuple mirrors the surviving rows min_expires_at exactly', () => {
  it('a-surviving-row-with-a-null-min-expires-at-reports-touchedExpiringTuple-false', async () => {
    const path = pathOfHops(1);
    const { client } = createCannedClient([stateRow(10), membershipRow(path, null)]);

    const result = await lookupRelationMembershipIndex(client, OBJECT, RELATION, SUBJECT, 5, 10);

    expect(result).toMatchObject({ hit: true, touchedExpiringTuple: false });
  });

  it('a-surviving-row-with-a-real-still-live-future-min-expires-at-reports-touchedExpiringTuple-true', async () => {
    const path = pathOfHops(1);
    const future = new Date(Date.now() + 60_000);
    const { client } = createCannedClient([stateRow(10), membershipRow(path, future)]);

    const result = await lookupRelationMembershipIndex(client, OBJECT, RELATION, SUBJECT, 5, 10);

    expect(result).toMatchObject({ hit: true, touchedExpiringTuple: true });
  });
});

// ---------------------------------------------------------------------------
// A plain miss (no matching row at all) is a normal, non-exceptional
// outcome — not covered by any lettered Candidate above, but part of this
// function's own basic contract ("a miss, for any reason at all").
// ---------------------------------------------------------------------------

describe('a plain miss', () => {
  it('no-matching-row-in-relation_membership_index-is-a-miss-not-a-throw', async () => {
    const { client } = createCannedClient([stateRow(10), membershipRow(undefined, null)]);

    const result = await lookupRelationMembershipIndex(client, OBJECT, RELATION, SUBJECT, 5, 10);

    expect(result).toEqual({ hit: false });
  });
});

// ---------------------------------------------------------------------------
// The exception boundary — asserted here to belong to resolver.ts, NOT to
// this function. docs/LEOPARD-INDEX-PROPOSAL.md is explicit that the
// try/catch swallowing a thrown exception into a safe {hit:false} lives in
// resolve()'s own relation branch, one layer up — this function itself must
// let a real error propagate uncaught, or that boundary would have nothing
// left to catch.
// ---------------------------------------------------------------------------

describe('a real thrown exception from the client is never swallowed inside lookupRelationMembershipIndex itself', () => {
  it('an-exception-from-the-state-query-propagates-uncaught', async () => {
    const boom = new Error('relation_membership_index_state: connection reset');
    const { client } = createCannedClient([boom]);

    await expect(
      lookupRelationMembershipIndex(client, OBJECT, RELATION, SUBJECT, 5, 10),
    ).rejects.toThrow(boom);
  });

  it('an-exception-from-the-membership-row-query-propagates-uncaught', async () => {
    const boom = new Error('relation_membership_index: lock wait timeout');
    const { client } = createCannedClient([stateRow(10), boom]);

    await expect(
      lookupRelationMembershipIndex(client, OBJECT, RELATION, SUBJECT, 5, 10),
    ).rejects.toThrow(boom);
  });
});
