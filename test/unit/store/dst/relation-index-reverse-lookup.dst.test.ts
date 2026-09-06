/**
 * `fetchReverseIndexCandidates` (`src/store/relation-index.ts`, D-175) — the
 * fast, DB-free permanent regression guard for gates 2 and 3
 * (`docs/REVERSE-LOOKUP-PROPOSAL.md`) once each is confirmed real. Mirrors
 * this directory's own `relation-index-watermark.dst.test.ts` exactly: a
 * hand-written fake `QueryExecutor` returning canned rows in the exact
 * order this function issues its own queries, never a re-implementation of
 * the real SQL predicates.
 *
 * Gates 1 (env), 4 (bare relation vs. permission), and 5 (wildcard subject
 * type) live in `src/audit/list.ts`'s own `tryReverseIndexCandidates`, not
 * in this function — see that function's own doc comment for why — so this
 * file has nothing to say about them; `test/unit/audit/list.test.ts` is
 * where those three belong.
 *
 * Query order this function issues, when it doesn't short-circuit: (1) the
 * `relation_membership_index_state` watermark read, (2) `currentToken`'s own
 * `write_log` read, (3) the candidate query itself.
 */
import { describe, expect, it } from 'vitest';

import { fetchReverseIndexCandidates } from '../../../../src/store/relation-index.js';
import type { QueryExecutor, QueryResultLike } from '../../../../src/store/query-executor.js';

const SUBJECT = { ns: 'user', id: 'alice' };
const RELATION = 'viewer';
const OBJECT_NS = 'document';
const LIMIT = 5;

/** Mirrors `relation-index-watermark.dst.test.ts`'s own `createCannedClient` exactly — one canned response per call, in order; throws loudly if this function issues more queries than were canned. */
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
            `${responses.length} canned response(s) were provided`,
        );
      }
      if (response instanceof Error) throw response;
      return response as unknown as QueryResultLike<Row>;
    },
  };
  return { client, calls };
}

function stateRow(watermarkToken: number | undefined): QueryResultLike {
  const rows = watermarkToken === undefined ? [] : [{ watermark_token: String(watermarkToken) }];
  return { rows, rowCount: rows.length };
}

function currentTokenRow(maxToken: number | null): QueryResultLike {
  const rows = maxToken === null ? [{ max_token: null }] : [{ max_token: String(maxToken) }];
  return { rows, rowCount: rows.length };
}

function candidateRows(objectIds: string[]): QueryResultLike {
  return { rows: objectIds.map((object_id) => ({ object_id })), rowCount: objectIds.length };
}

// ---------------------------------------------------------------------------
// Gate 2 — the index must be caught up to *right now*, not merely past some
// caller-supplied floor. This is the gate v1 got backwards — see
// docs/REVERSE-LOOKUP-PROPOSAL.md's own "Gate 2" section.
// ---------------------------------------------------------------------------

describe('Gate 2 — watermark vs. currentToken()', () => {
  it('a-watermark-strictly-below-current-is-a-miss-and-never-even-reads-the-candidate-table', async () => {
    const { client, calls } = createCannedClient([stateRow(100), currentTokenRow(200)]);

    const result = await fetchReverseIndexCandidates(client, SUBJECT, RELATION, OBJECT_NS, LIMIT);

    expect(result).toEqual({ hit: false });
    expect(calls).toHaveLength(2); // never reaches the candidate query
  });

  it('a-watermark-exactly-equal-to-current-is-caught-up-enough-to-be-trusted', async () => {
    const { client } = createCannedClient([
      stateRow(100),
      currentTokenRow(100),
      candidateRows(['doc1']),
    ]);

    const result = await fetchReverseIndexCandidates(client, SUBJECT, RELATION, OBJECT_NS, LIMIT);

    expect(result).toEqual({ hit: true, objectIds: ['doc1'], truncated: false });
  });

  it('a-watermark-above-current-is-also-trusted', async () => {
    const { client } = createCannedClient([
      stateRow(150),
      currentTokenRow(100),
      candidateRows(['doc1']),
    ]);

    const result = await fetchReverseIndexCandidates(client, SUBJECT, RELATION, OBJECT_NS, LIMIT);

    expect(result.hit).toBe(true);
  });

  it('no-state-row-and-no-writes-ever-both-default-to-zero-and-pass-the-gate', async () => {
    // Neither degenerate case is special-cased — 0 >= 0 is an ordinary pass,
    // not a "no state row means always miss" rule. v1 asserted these were
    // the same case as a below-floor miss; they aren't (docs/REVERSE-
    // LOOKUP-PROPOSAL.md's own fidelity-review correction).
    const { client } = createCannedClient([stateRow(undefined), currentTokenRow(null)]);

    const result = await fetchReverseIndexCandidates(client, SUBJECT, RELATION, OBJECT_NS, LIMIT);

    // Falls through to gate 3 (empty candidate table) — a miss, but for a
    // different, later reason than gate 2 itself.
    expect(result).toEqual({ hit: false });
  });
});

// ---------------------------------------------------------------------------
// Gate 3 — an empty or errored accelerated result is a miss, never a final
// answer. Closes the concurrent-TRUNCATE hazard and the atToken:0-against-a-
// never-built-index degenerate case in one rule.
// ---------------------------------------------------------------------------

describe('Gate 3 — empty result is a miss', () => {
  it('zero-candidate-rows-is-a-miss-not-a-final-empty-answer', async () => {
    const { client } = createCannedClient([stateRow(100), currentTokenRow(100), candidateRows([])]);

    const result = await fetchReverseIndexCandidates(client, SUBJECT, RELATION, OBJECT_NS, LIMIT);

    expect(result).toEqual({ hit: false });
  });
});

describe('Gate 3 — an errored candidate query is a miss, caught inside this function, never propagated', () => {
  it('a-thrown-error-from-the-candidate-query-is-caught-and-reported-as-a-miss', async () => {
    const boom = new Error('relation_membership_index: lock wait timeout');
    const { client } = createCannedClient([stateRow(100), currentTokenRow(100), boom]);

    const result = await fetchReverseIndexCandidates(client, SUBJECT, RELATION, OBJECT_NS, LIMIT);

    expect(result).toEqual({ hit: false });
  });

  it('an-error-from-the-watermark-read-is-a-real-infrastructure-problem-and-propagates-uncaught', async () => {
    // TRUNCATE's ACCESS EXCLUSIVE lock is scoped to relation_membership_index
    // itself — it cannot fail a read of the state table or write_log. A real
    // error there is genuine infra failure, not the race gate 3 tolerates,
    // and must not be silently swallowed into a miss (that would defeat
    // listObjects's own "a genuinely unreachable database still throws"
    // contract).
    const boom = new Error('relation_membership_index_state: connection reset');
    const { client } = createCannedClient([boom]);

    await expect(
      fetchReverseIndexCandidates(client, SUBJECT, RELATION, OBJECT_NS, LIMIT),
    ).rejects.toThrow(boom);
  });

  it('an-error-from-the-currentToken-read-also-propagates-uncaught', async () => {
    const boom = new Error('write_log: connection reset');
    const { client } = createCannedClient([stateRow(100), boom]);

    await expect(
      fetchReverseIndexCandidates(client, SUBJECT, RELATION, OBJECT_NS, LIMIT),
    ).rejects.toThrow(boom);
  });
});

// ---------------------------------------------------------------------------
// The query's own limit/truncation contract — the same +1-overflow trick
// fetchCandidateObjectIds (src/audit/list.ts) already uses.
// ---------------------------------------------------------------------------

describe('truncation — the limit+1 overflow trick', () => {
  it('exactly-limit-rows-is-not-truncated', async () => {
    const ids = ['a', 'b', 'c'];
    const { client } = createCannedClient([stateRow(1), currentTokenRow(1), candidateRows(ids)]);

    const result = await fetchReverseIndexCandidates(client, SUBJECT, RELATION, OBJECT_NS, 3);

    expect(result).toEqual({ hit: true, objectIds: ids, truncated: false });
  });

  it('limit-plus-one-rows-is-truncated-and-the-extra-row-is-dropped', async () => {
    const ids = ['a', 'b', 'c', 'd'];
    const { client, calls } = createCannedClient([
      stateRow(1),
      currentTokenRow(1),
      candidateRows(ids),
    ]);

    const result = await fetchReverseIndexCandidates(client, SUBJECT, RELATION, OBJECT_NS, 3);

    expect(result).toEqual({ hit: true, objectIds: ['a', 'b', 'c'], truncated: true });
    // The query itself must actually request limit+1, matching the
    // documented overflow-detection convention.
    const candidateCall = calls[2];
    expect(candidateCall?.params?.[4]).toBe(4);
  });
});
