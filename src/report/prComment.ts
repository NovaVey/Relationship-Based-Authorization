/**
 * Update-in-place decision logic for the soundness PR comment — build spec
 * §9 Phase 7's exit criterion ("posts a PR comment ... in place on new
 * commits, never stacking") and §10's `the-soundness-pr-comment-updates-in-
 * place-instead-of-posting-twice` test-plan bullet.
 *
 * Deliberately pure: no `@octokit`/GitHub API calls anywhere in this file.
 * `.github/workflows/soundness.yml` (main agent's job, not this file's) is
 * expected to fetch a PR's existing comments itself, hand the plain
 * `{ id, author, body }` list to `decidePrCommentAction`, and act on the
 * returned `PrCommentDecision` (call the "create comment" or "update
 * comment" endpoint accordingly, and delete anything listed in
 * `staleCommentIds`). This keeps the actual decision — "is there already a
 * comment we posted for this soundness check, and if so which one do we
 * update" — testable with hand-built fixture arrays and no network access,
 * exactly the shape §10's own test bullet asks for; `test-author` can write
 * that test against this function alone.
 */

export interface ExistingPrComment {
  /** Whatever id type the caller's GitHub client uses (a number from the REST API, in practice) — kept generic so this file has zero GitHub-shaped type dependency. */
  id: string | number;
  /** The GitHub login that posted the comment. Used to make certain this function only ever proposes updating a comment *this bot itself* posted — a human's comment that happens to mention "false_grant" must never be silently overwritten. */
  author: string;
  body: string;
}

export interface PrCommentDecisionInput {
  /**
   * Every comment currently on the PR, in the order the caller's own
   * "list comments" call returned them — GitHub's REST API returns PR
   * issue-comments in ascending creation order by default, and this
   * function relies on that ordering to deterministically pick the
   * *earliest* matching comment as the one to keep updating (rather than,
   * say, whichever one happens to sort first by id, which is not
   * guaranteed to agree with creation order across all GitHub id schemes).
   * A caller that already re-sorted or filtered the list before calling
   * this function is responsible for keeping that ordering meaningful.
   */
  existingComments: readonly ExistingPrComment[];
  /**
   * The identity the CI workflow's token posts comments as (e.g.
   * `github-actions[bot]` for the built-in `GITHUB_TOKEN` — build spec §2).
   * Passed explicitly rather than hardcoded: this pure module has no
   * business assuming which bot identity a given workflow run authenticates
   * as, and a fork/rename of the workflow shouldn't require editing this
   * file.
   */
  botLogin: string;
  /**
   * The exact marker string the new comment body will contain — normally
   * `SOUNDNESS_REPORT_MARKER` from `src/report/markdown.ts`, passed in
   * rather than imported directly so this decision function stays testable
   * against any marker string a caller supplies, without coupling it to
   * `markdown.ts`'s own module graph.
   */
  marker: string;
}

export type PrCommentDecision =
  | {
      action: 'update';
      /** The one comment to update in place. */
      commentId: ExistingPrComment['id'];
      /**
       * Any OTHER comments that also match (same bot, same marker) — should
       * never happen in normal operation (this function is exactly what
       * prevents it from starting to happen), but if it ever does — a past
       * bug, a manual duplicate, two workflow runs racing — these are the
       * extras a caller should delete so the PR self-heals back to exactly
       * one soundness comment rather than accumulating more on every future
       * run. Always `[]` in the common case.
       */
      staleCommentIds: Array<ExistingPrComment['id']>;
    }
  | { action: 'create' };

/**
 * Decides whether the CI workflow should update an existing soundness
 * comment or post a new one. A comment counts as "ours" only if BOTH its
 * `author` matches `botLogin` AND its `body` contains `marker` — matching
 * on the marker alone would risk adopting a comment from a different bot
 * that happens to reuse the same string, and matching on author alone would
 * risk overwriting some other automated comment from the same bot identity
 * that has nothing to do with soundness reporting.
 */
export function decidePrCommentAction(input: PrCommentDecisionInput): PrCommentDecision {
  const candidates = input.existingComments.filter(
    (c) => c.author === input.botLogin && c.body.includes(input.marker),
  );

  const [first, ...rest] = candidates;
  if (!first) {
    return { action: 'create' };
  }

  return {
    action: 'update',
    commentId: first.id,
    staleCommentIds: rest.map((c) => c.id),
  };
}
