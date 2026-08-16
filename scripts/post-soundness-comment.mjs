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
 */
import { readFileSync } from 'node:fs';
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
    { method: 'POST', body: JSON.stringify({ body }) },
    'create PR comment',
  );
  console.log('posted a new soundness report comment');
} else {
  await checkedFetch(
    `${apiBase}/issues/comments/${decision.commentId}`,
    { method: 'PATCH', body: JSON.stringify({ body }) },
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
