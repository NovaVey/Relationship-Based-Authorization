#!/usr/bin/env node
/**
 * Posts, or updates in place, the soundness fuzz report as a PR comment —
 * build spec §9 Phase 7's exit criterion ("posts a PR comment ... in place
 * on new commits, never stacking"). Run only by
 * `.github/workflows/soundness.yml`, after `npm run build` and after
 * `authz soundness run --format markdown` has already written its output to
 * a file.
 *
 * Deliberately a plain Node script speaking to the GitHub REST API directly
 * via Node 22's built-in `fetch` — not a new npm dependency (`@octokit/*`
 * is outside build spec §2's stack, and this needs nothing an npm client
 * would add beyond a thin wrapper over `fetch`) and not
 * `actions/github-script` either (that would mean re-implementing the
 * update-in-place decision as inline workflow-YAML JavaScript, duplicating
 * `src/report/prComment.ts`'s own logic instead of calling it — this
 * script imports the real, tested `decidePrCommentAction` from the build
 * output directly, so there is exactly one implementation of "which
 * comment to update," never two that could drift). See
 * `docs/DECISIONS.md` (D-046, D-068).
 *
 * **This script refuses to post or update the tracked comment with an
 * empty body (D-068).** `authz soundness run --format markdown`'s own
 * `catch` block (`src/cli/commands/soundness.ts`) is the primary fix for
 * "stdout must never be empty on an infrastructure failure" — this is a
 * narrow, second-layer check, not a substitute for that fix: it protects
 * against any *other*, unforeseen way `soundness-report.md` could end up
 * empty (a crash before `soundnessRun` even runs, a future regression that
 * reintroduces a silent-stdout code path, a disk/redirection problem in the
 * workflow step itself) that the CLI-level fix, by construction, can't
 * reach. On a blank report, this script throws (failing the step, and the
 * job) *before* calling the GitHub API at all — the existing,
 * already-tracked comment (if any) is left completely untouched rather than
 * being overwritten with a placeholder, so the last known-good report stays
 * visible on the PR either way.
 *
 * **This script also refuses to POST an oversized body unhandled (closes a
 * real HIGH finding, 2026-08-16).** `src/report/markdown.ts`'s own
 * `renderSoundnessMarkdown` now targets a soft `DEFAULT_MAX_COMMENT_CHARS`
 * (60,000) budget for exactly this reason (see `docs/DECISIONS.md` D-084),
 * but this script does not trust that budget math to be bug-free forever —
 * before either `fetch` call below, `body`'s real byte length is checked
 * against GitHub's actual documented comment-body ceiling
 * (`GITHUB_COMMENT_BODY_BYTE_LIMIT`). If it's over, this script never sends
 * the oversized `body` at all: it POSTs/PATCHes a short, honest,
 * `SOUNDNESS_REPORT_MARKER`-prefixed fallback instead. Without this, a body
 * that ever did cross GitHub's real limit would reach `checkedFetch`, get a
 * `422` back, and throw unhandled — crashing this step, and with it the
 * entire "post or update the soundness PR comment" job, before a single
 * comment was posted; on a PR with no prior soundness comment, that means
 * silence; on a PR with an older, clean-looking comment already tracked,
 * that stale comment is left untouched while the real (likely severe) new
 * report never displays — exactly backwards for the worst-case finding this
 * whole pipeline exists to surface.
 *
 * **Every decision above except the actual `readFileSync`/`fetch` I/O now
 * lives in `src/report/soundnessCommentGuards.ts`, not inline in this
 * script (full-repo audit finding #6, MEDIUM, test-gap, 2026-08-22).**
 * Mirrors this file's own established reasoning for importing
 * `decidePrCommentAction` rather than re-implementing it: the PR-number
 * validation, the empty-body guard, and the oversized-body fallback are all
 * real branching logic this script had already needed three follow-on
 * fixes for (D-046, D-068, D-084) with zero automated coverage of any of
 * it — a `.mjs` script has no `.ts` counterpart `npm test`/`npm run
 * typecheck` ever touches. Pulling the pure decisions into a real,
 * `test/unit/report/soundnessCommentGuards.test.ts`-covered `src/` module
 * closes that gap the same way `prComment.ts` already closed it for the
 * update-in-place decision, without changing this script's own behavior.
 */
import { readFileSync } from 'node:fs';
import { decidePrCommentAction } from '../dist/report/prComment.js';
import { SOUNDNESS_REPORT_MARKER } from '../dist/report/markdown.js';
import {
  GITHUB_COMMENT_BODY_BYTE_LIMIT,
  decideSoundnessCommentBody,
  requireNonEmptySoundnessReportBody,
  validatePullRequestNumber,
} from '../dist/report/soundnessCommentGuards.js';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const token = requireEnv('GITHUB_TOKEN');
const repo = requireEnv('GITHUB_REPOSITORY'); // "owner/repo", set by GitHub Actions
const eventPath = requireEnv('GITHUB_EVENT_PATH'); // set by GitHub Actions
const reportPath = process.env.SOUNDNESS_REPORT_PATH ?? 'soundness-report.md';
// The identity the built-in GITHUB_TOKEN posts comments as. Overridable via
// env, matching src/report/prComment.ts's own reasoning for taking this as
// a parameter rather than hardcoding it.
const botLogin = process.env.SOUNDNESS_BOT_LOGIN ?? 'github-actions[bot]';

// `event` is file data (GITHUB_EVENT_PATH) — everything pulled out of it and
// used to build a request URL below is validated to a narrow, safe type
// immediately here, not trusted as-is. CodeQL's "file data in outbound
// network request" check flags exactly this kind of unvalidated
// file-to-URL flow; `validatePullRequestNumber`
// (`src/report/soundnessCommentGuards.ts`) is what actually closes it (not
// merely a truthy check, which still lets a non-numeric or negative value
// flow through unchanged) — see its own doc comment for the two layers.
const event = JSON.parse(readFileSync(eventPath, 'utf8'));
const prNumber = validatePullRequestNumber(event.pull_request?.number);

const body = readFileSync(reportPath, 'utf8');

// See this file's own top-of-file doc comment ("This script refuses to
// post or update the tracked comment with an empty body") — a
// literally-blank report is never a legitimate soundness result, and must
// never silently become (or overwrite) a PR comment.
requireNonEmptySoundnessReportBody(body, reportPath);

// See this file's own top-of-file doc comment ("This script also refuses
// to POST an oversized body unhandled") — `renderSoundnessMarkdown`'s own
// `DEFAULT_MAX_COMMENT_CHARS` budget (60,000, `src/report/markdown.ts`)
// already targets staying well under `GITHUB_COMMENT_BODY_BYTE_LIMIT`, but
// `decideSoundnessCommentBody` is the second, independent layer that keeps
// a bug in that budget math from ever reaching `checkedFetch` and crashing
// this step on GitHub's own `422`.
const { postBody, usedFallback, fullBodyByteLength } = decideSoundnessCommentBody(body);
if (usedFallback) {
  console.log(
    `${reportPath} is ${fullBodyByteLength} bytes, over GitHub's ` +
      `${GITHUB_COMMENT_BODY_BYTE_LIMIT}-byte comment limit — posting a short summary instead of ` +
      'the full report; see the "Run soundness fuzz" step log above for the complete output.',
  );
}

const apiBase = `https://api.github.com/repos/${repo}`;
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function checkedFetch(url, init, action) {
  const res = await fetch(url, { ...init, headers: { ...headers, ...init?.headers } });
  if (!res.ok) {
    throw new Error(`${action} failed: ${res.status} ${res.statusText} — ${await res.text()}`);
  }
  return res;
}

async function listExistingComments() {
  const comments = [];
  let page = 1;
  for (;;) {
    const res = await checkedFetch(
      `${apiBase}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      undefined,
      'list PR comments',
    );
    const batch = await res.json();
    comments.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return comments.map((c) => ({ id: c.id, author: c.user?.login ?? '', body: c.body ?? '' }));
}

const existingComments = await listExistingComments();
const decision = decidePrCommentAction({
  existingComments,
  botLogin,
  marker: SOUNDNESS_REPORT_MARKER,
});

if (decision.action === 'create') {
  await checkedFetch(
    `${apiBase}/issues/${prNumber}/comments`,
    { method: 'POST', body: JSON.stringify({ body: postBody }) },
    'create PR comment',
  );
  console.log('posted a new soundness report comment');
} else {
  await checkedFetch(
    `${apiBase}/issues/comments/${decision.commentId}`,
    { method: 'PATCH', body: JSON.stringify({ body: postBody }) },
    'update PR comment',
  );
  console.log(`updated soundness report comment ${decision.commentId} in place`);
  for (const staleId of decision.staleCommentIds) {
    await checkedFetch(
      `${apiBase}/issues/comments/${staleId}`,
      { method: 'DELETE' },
      'delete stale comment',
    );
    console.log(`deleted stale duplicate comment ${staleId}`);
  }
}
