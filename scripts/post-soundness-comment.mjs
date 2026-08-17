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
 * reach. It checks for literally empty-or-whitespace-only content only —
 * never a length threshold or any other heuristic — because a genuine
 * `sound` verdict's own rendered markdown is legitimately short, and this
 * script must never treat "short" as suspect the way it correctly treats
 * "blank" as suspect. On a blank report, this script throws (failing the
 * step, and the job) *before* calling the GitHub API at all — the existing,
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
 * `SOUNDNESS_REPORT_MARKER`-prefixed fallback instead
 * (`buildOversizedFallbackBody` below) — the real headline, the real
 * reproduce command, and a pointer at the workflow run's own "Run soundness
 * fuzz" step log (which already prints the complete, untruncated report
 * verbatim — see `.github/workflows/soundness.yml`) for the full detail.
 * Without this, a body that ever did cross GitHub's real limit would reach
 * `checkedFetch`, get a `422` back, and throw unhandled — crashing this
 * step, and with it the entire "post or update the soundness PR comment"
 * job, before a single comment was posted; on a PR with no prior soundness
 * comment, that means silence; on a PR with an older, clean-looking comment
 * already tracked, that stale comment is left untouched while the real
 * (likely severe) new report never displays — exactly backwards for the
 * worst-case finding this whole pipeline exists to surface.
 */
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { decidePrCommentAction } from '../dist/report/prComment.js';
import { SOUNDNESS_REPORT_MARKER } from '../dist/report/markdown.js';

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
// file-to-URL flow; a strict integer/range check is what actually closes
// it (not merely a truthy check, which still lets a non-numeric or
// negative value flow through unchanged).
const event = JSON.parse(readFileSync(eventPath, 'utf8'));
const prNumberRaw = event.pull_request?.number;
if (typeof prNumberRaw !== 'number' || !Number.isInteger(prNumberRaw) || prNumberRaw <= 0) {
  throw new Error(
    'no valid pull_request.number in the GitHub event payload — this script only runs in a pull_request-triggered job',
  );
}
const prNumber = prNumberRaw;

const body = readFileSync(reportPath, 'utf8');

// See this file's own top-of-file doc comment ("This script refuses to
// post or update the tracked comment with an empty body") — a
// literally-blank report is never a legitimate soundness result, and must
// never silently become (or overwrite) a PR comment.
if (body.trim().length === 0) {
  throw new Error(
    `${reportPath} is empty — \`authz soundness run --format markdown\` produced no report on ` +
      `stdout. Refusing to post or overwrite the tracked soundness PR comment with a blank body ` +
      `(that would silently erase the last known-good report). See the "Run soundness fuzz" ` +
      `step's own logged output, above, for the real underlying error.`,
  );
}

// GitHub's own documented ceiling for a single issue/PR comment body. See
// this file's own top-of-file doc comment ("This script also refuses to
// POST an oversized body unhandled") — `renderSoundnessMarkdown`'s own
// `DEFAULT_MAX_COMMENT_CHARS` budget (60,000, `src/report/markdown.ts`)
// already targets staying well under this, but this check is the second,
// independent layer that keeps a bug in that budget math from ever reaching
// `checkedFetch` and crashing this step on GitHub's own `422`.
const GITHUB_COMMENT_BODY_BYTE_LIMIT = 65536;

/**
 * Built only when `body` is over `GITHUB_COMMENT_BODY_BYTE_LIMIT` — a short,
 * honest, `SOUNDNESS_REPORT_MARKER`-prefixed stand-in for the real report,
 * never the real (oversized) `body` itself. Starts with the marker for the
 * same reason every real report does (`decidePrCommentAction` matches it to
 * decide "update this one" vs. "post a new one" — omitting it here would
 * orphan this fallback comment the next time a normal-sized report posts).
 * Pulls the real H2 headline line and the real `Reproduce: ...` line
 * straight out of the oversized `fullBody` verbatim — both are always the
 * first two rendered elements after the marker in `renderSoundnessMarkdown`'s
 * own output, so this fallback still states the real, measured verdict and
 * counts, never a vaguer "something is wrong." Points at the workflow run's
 * own "Run soundness fuzz" step log — the one place the complete,
 * untruncated report actually is (`.github/workflows/soundness.yml` already
 * `cat`s the full `soundness-report.md` there; no artifact upload exists in
 * this workflow to point at instead, so this deliberately names the real
 * mechanism, not a hypothetical one).
 */
function buildOversizedFallbackBody(fullBody) {
  const headlineMatch = fullBody.match(/^## .+$/m);
  const reproduceMatch = fullBody.match(/^Reproduce: .+$/m);
  const byteLength = Buffer.byteLength(fullBody, 'utf8');
  const lines = [
    SOUNDNESS_REPORT_MARKER,
    '',
    headlineMatch ? headlineMatch[0] : '## verdict unknown — see the workflow run log',
    '',
    `The full soundness report is ${byteLength} characters — too large to post as a single PR ` +
      `comment (GitHub's own limit is ${GITHUB_COMMENT_BODY_BYTE_LIMIT} characters). The headline ` +
      'above is the real, measured result of this run, not summarized or softened. See the workflow ' +
      'run\'s "Run soundness fuzz" step log for the complete report — it prints the full markdown ' +
      'verbatim — or reproduce the exact run locally.',
  ];
  if (reproduceMatch) {
    lines.push('', reproduceMatch[0]);
  }
  return lines.join('\n');
}

const postBody =
  Buffer.byteLength(body, 'utf8') > GITHUB_COMMENT_BODY_BYTE_LIMIT
    ? buildOversizedFallbackBody(body)
    : body;
if (postBody !== body) {
  console.log(
    `${reportPath} is ${Buffer.byteLength(body, 'utf8')} bytes, over GitHub's ` +
      `${GITHUB_COMMENT_BODY_BYTE_LIMIT}-character comment limit — posting a short summary instead of ` +
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
