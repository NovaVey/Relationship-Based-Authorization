/**
 * `decidePrCommentAction` — build spec
 * `.claude/commands/build-authz-service.md` §9 Phase 7's exit criterion
 * ("posts a PR comment ... in place on new commits, never stacking") and
 * §10's own named CI bullet:
 *
 *   the-soundness-pr-comment-updates-in-place-instead-of-posting-twice
 *
 * A comment counts as "ours" only if BOTH its `author` matches the caller's
 * `botLogin` AND its `body` contains the caller's `marker` — see
 * `src/report/prComment.ts`'s own doc comment for why both conditions are
 * required together (matching on either alone risks adopting a comment that
 * isn't really the soundness report, or overwriting one that only shares an
 * author). Written from that contract and this task's own spec, not from
 * reading past the function's declared inputs/outputs.
 */
import { describe, expect, it } from 'vitest';

import { decidePrCommentAction, type ExistingPrComment } from '../../../src/report/prComment.js';

const BOT_LOGIN = 'github-actions[bot]';
const MARKER = '<!-- authz:soundness-report -->';

function comment(overrides: Partial<ExistingPrComment>): ExistingPrComment {
  return { id: 1, author: 'someone', body: 'an ordinary PR comment', ...overrides };
}

describe('decidePrCommentAction', () => {
  it('no-existing-comments-on-the-pr-creates-a-new-one', () => {
    const decision = decidePrCommentAction({
      existingComments: [],
      botLogin: BOT_LOGIN,
      marker: MARKER,
    });

    expect(decision).toEqual({ action: 'create' });
  });

  it('a-single-comment-authored-by-the-bot-and-containing-the-marker-is-updated-in-place-with-no-stale-comments', () => {
    const ours = comment({
      id: 42,
      author: BOT_LOGIN,
      body: `${MARKER}\n\n## SOUND — 0 false_grant`,
    });

    const decision = decidePrCommentAction({
      existingComments: [ours],
      botLogin: BOT_LOGIN,
      marker: MARKER,
    });

    expect(decision).toEqual({ action: 'update', commentId: 42, staleCommentIds: [] });
  });

  it('a-comment-from-a-different-author-that-happens-to-quote-the-marker-string-is-never-adopted-as-the-bots-own', () => {
    // A human reviewer discussing the report in a reply that quotes the
    // marker text verbatim must never be mistaken for the bot's own
    // comment — matching on `body` alone would get this wrong.
    const humanQuotingMarker = comment({
      id: 7,
      author: 'a-human-reviewer',
      body: `I see this HTML comment in the rendered report: ${MARKER}`,
    });

    const decision = decidePrCommentAction({
      existingComments: [humanQuotingMarker],
      botLogin: BOT_LOGIN,
      marker: MARKER,
    });

    expect(decision).toEqual({ action: 'create' });
  });

  it('a-comment-from-the-bot-itself-that-does-not-contain-the-marker-is-never-adopted-as-the-soundness-report', () => {
    // Same author, unrelated content (e.g. a lint-check comment posted by
    // the same CI identity) — matching on `author` alone would get this
    // wrong and silently overwrite an unrelated comment.
    const unrelatedBotComment = comment({
      id: 8,
      author: BOT_LOGIN,
      body: 'Linting passed with 0 errors.',
    });

    const decision = decidePrCommentAction({
      existingComments: [unrelatedBotComment],
      botLogin: BOT_LOGIN,
      marker: MARKER,
    });

    expect(decision).toEqual({ action: 'create' });
  });

  it('among-a-mix-of-unrelated-comments-only-the-real-bot-authored-marker-bearing-comment-is-picked-for-update', () => {
    const humanQuotingMarker = comment({
      id: 1,
      author: 'a-human-reviewer',
      body: `quoting the report: ${MARKER}`,
    });
    const wrongBotWithMarker = comment({
      id: 2,
      author: 'some-other-automation[bot]',
      body: `${MARKER}\n\n## SOUND`,
    });
    const ourBotNoMarker = comment({ id: 3, author: BOT_LOGIN, body: 'Linting passed.' });
    const theRealOne = comment({
      id: 4,
      author: BOT_LOGIN,
      body: `${MARKER}\n\n## UNSOUND — 1 false_grant`,
    });

    const decision = decidePrCommentAction({
      existingComments: [humanQuotingMarker, wrongBotWithMarker, ourBotNoMarker, theRealOne],
      botLogin: BOT_LOGIN,
      marker: MARKER,
    });

    expect(decision).toEqual({ action: 'update', commentId: 4, staleCommentIds: [] });
  });

  it('two-or-more-matching-comments-update-the-earliest-in-input-order-and-list-every-other-one-as-stale', () => {
    const first = comment({ id: 10, author: BOT_LOGIN, body: `${MARKER}\n\n## SOUND (run 1)` });
    const second = comment({ id: 20, author: BOT_LOGIN, body: `${MARKER}\n\n## SOUND (run 2)` });
    const third = comment({ id: 30, author: BOT_LOGIN, body: `${MARKER}\n\n## SOUND (run 3)` });

    const decision = decidePrCommentAction({
      existingComments: [first, second, third],
      botLogin: BOT_LOGIN,
      marker: MARKER,
    });

    // The earliest (first in the caller's own list-comments ordering) is
    // kept and updated; every other match is reported so a caller can
    // self-heal the PR back down to exactly one soundness comment.
    expect(decision).toEqual({ action: 'update', commentId: 10, staleCommentIds: [20, 30] });
  });

  it('the-earliest-matching-comment-is-picked-by-input-order-not-by-numeric-or-lexicographic-id-order', () => {
    // Deliberately give the *earliest*-appearing match the numerically
    // largest id, so a bug that sorted by id instead of trusting input
    // order would be caught here.
    const earliestByPositionButLargestId = comment({
      id: 999,
      author: BOT_LOGIN,
      body: `${MARKER}\n\n## SOUND (first posted)`,
    });
    const laterByPositionButSmallestId = comment({
      id: 1,
      author: BOT_LOGIN,
      body: `${MARKER}\n\n## SOUND (posted later)`,
    });

    const decision = decidePrCommentAction({
      existingComments: [earliestByPositionButLargestId, laterByPositionButSmallestId],
      botLogin: BOT_LOGIN,
      marker: MARKER,
    });

    expect(decision).toEqual({ action: 'update', commentId: 999, staleCommentIds: [1] });
  });
});
