#!/usr/bin/env node
/**
 * Posts, or updates in place, the DST run's own result as a PR comment —
 * `docs/DST-PROPOSAL.md`'s own "CI" design section, `docs/DECISIONS.md`
 * D-102. Run only by `.github/workflows/dst.yml`'s `dst-pr` job, after
 * `npx vitest run test/unit/store/dst/ --reporter=json --outputFile=...`
 * has already written its structured report to a file. Mirrors
 * `scripts/post-soundness-comment.mjs`'s own established shape exactly —
 * same plain-`fetch`-against-the-REST-API approach (no `@octokit/*`, no
 * `actions/github-script`), same reuse of the real, already-tested
 * `decidePrCommentAction` (`src/report/prComment.ts`) for the
 * update-in-place decision, so there is exactly one implementation of
 * "which comment to update," never two that could drift between the two
 * report kinds — only the report body itself and its own marker differ.
 *
 * The shared low-level plumbing genuinely is identical to
 * `post-soundness-comment.mjs`'s own — `requireEnv`, the PR-number
 * validation out of `GITHUB_EVENT_PATH`, `checkedFetch`, the paginated
 * `listExistingComments`, the `decidePrCommentAction` reuse itself, and the
 * `GITHUB_COMMENT_BODY_BYTE_LIMIT` oversized-body safety net — but this
 * script is not a pure copy with only the body/marker swapped out (an
 * earlier draft of this comment overclaimed exactly that; an adversarial
 * review caught it, `docs/DECISIONS.md` D-102). Concretely, three things
 * differ beyond content: (1) `DST_REPORT_MARKER` is a bare local literal —
 * unlike `SOUNDNESS_REPORT_MARKER`, it has no shared module to import from,
 * since there's no DST rendering module for it to live in (see the next
 * paragraph for why); (2) this script contains real report-rendering logic
 * of its own (the `if (report.success)`/`else` block below, parsing
 * `vitest`'s raw JSON and walking `testResults`/`assertionResults`) —
 * `post-soundness-comment.mjs` has none, since it only ever reads an
 * already-rendered markdown file verbatim; (3) the oversized-body fallback
 * here is built fresh from `report.success` directly, not extracted out of
 * an existing rendered body the way `post-soundness-comment.mjs`'s own
 * `buildOversizedFallbackBody` does, because there is no existing rendered
 * body to extract from.
 *
 * That asymmetry is deliberate, not an oversight: unlike the soundness
 * report (a measured false-grant/false-deny rate, with its own
 * markdown/json dual-format renderer and dedicated tests), a DST run's own
 * result is a plain pass/fail count plus, on failure, which assertions
 * failed — simple enough to build directly from `vitest`'s own
 * `--reporter=json` output here, without a parallel `src/report/` rendering
 * module whose only real content would be "how many tests passed."
 */
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { decidePrCommentAction } from '../dist/report/prComment.js';

const DST_REPORT_MARKER = '<!-- authz:dst-report -->';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const token = requireEnv('GITHUB_TOKEN');
const repo = requireEnv('GITHUB_REPOSITORY'); // "owner/repo", set by GitHub Actions
const eventPath = requireEnv('GITHUB_EVENT_PATH'); // set by GitHub Actions
const reportPath = process.env.DST_REPORT_PATH ?? 'dst-report.json';
const botLogin = process.env.DST_BOT_LOGIN ?? 'github-actions[bot]';

// `event` is file data (GITHUB_EVENT_PATH) — everything pulled out of it and
// used to build a request URL below is validated to a narrow, safe type
// immediately here, not trusted as-is — see post-soundness-comment.mjs's
// own identical comment for why a bare truthy check isn't enough.
const event = JSON.parse(readFileSync(eventPath, 'utf8'));
const prNumberRaw = event.pull_request?.number;
if (typeof prNumberRaw !== 'number' || !Number.isInteger(prNumberRaw) || prNumberRaw <= 0) {
  throw new Error(
    'no valid pull_request.number in the GitHub event payload — this script only runs in a pull_request-triggered job',
  );
}
const prNumber = prNumberRaw;

const raw = readFileSync(reportPath, 'utf8');
if (raw.trim().length === 0) {
  throw new Error(
    `${reportPath} is empty — vitest's own --reporter=json produced no report. Refusing to post ` +
      'or overwrite the tracked DST PR comment with a blank body.',
  );
}
/** @type {{numTotalTests: number, numPassedTests: number, numFailedTests: number, success: boolean, testResults: Array<{name: string, status: string, assertionResults: Array<{status: string, fullName: string, failureMessages: string[]}>}>}} */
const report = JSON.parse(raw);

const seedCountOverride = process.env.DST_SEED_COUNT;
const seedCountLine = seedCountOverride
  ? `\`DST_SEED_COUNT=${seedCountOverride}\` (this run's own override).`
  : "unset — each seeded sweep's own small, fixed PR-time default.";

const lines = [DST_REPORT_MARKER, ''];
if (report.success) {
  lines.push(
    `## DST — ${report.numPassedTests}/${report.numTotalTests} passed (${report.testResults.length} files)`,
    '',
    `Seed count: ${seedCountLine}`,
    '',
    'Reproduce: `npx vitest run test/unit/store/dst/`',
  );
} else {
  lines.push(
    `## DST — ${report.numFailedTests} FAILED / ${report.numTotalTests} total (${report.testResults.length} files)`,
    '',
    `Seed count: ${seedCountLine}`,
    '',
    '### Failing assertions',
    '',
  );
  for (const file of report.testResults) {
    if (file.status !== 'failed') continue;
    for (const assertion of file.assertionResults) {
      if (assertion.status !== 'failed') continue;
      lines.push(`- \`${file.name}\` — ${assertion.fullName}`);
    }
  }
  lines.push(
    '',
    'See this workflow run\'s own "Run DST suite" step log for the full failure output.',
  );
}
const body = lines.join('\n');

// GitHub's own documented ceiling for a single issue/PR comment body — see
// post-soundness-comment.mjs's own identical constant/reasoning. A DST
// failure list is bounded by this suite's own test count (currently under
// 100), nowhere near this limit in practice, but checked anyway rather than
// assumed, matching that script's own discipline.
const GITHUB_COMMENT_BODY_BYTE_LIMIT = 65536;
const postBody =
  Buffer.byteLength(body, 'utf8') > GITHUB_COMMENT_BODY_BYTE_LIMIT
    ? [
        DST_REPORT_MARKER,
        '',
        report.success ? '## DST — passed' : '## DST — FAILED',
        '',
        'The full failure list is too large to post as a single PR comment — see this workflow ' +
          'run\'s own "Run DST suite" step log for the complete output.',
      ].join('\n')
    : body;

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
  marker: DST_REPORT_MARKER,
});

if (decision.action === 'create') {
  await checkedFetch(
    `${apiBase}/issues/${prNumber}/comments`,
    { method: 'POST', body: JSON.stringify({ body: postBody }) },
    'create PR comment',
  );
  console.log('posted a new DST report comment');
} else {
  await checkedFetch(
    `${apiBase}/issues/comments/${decision.commentId}`,
    { method: 'PATCH', body: JSON.stringify({ body: postBody }) },
    'update PR comment',
  );
  console.log(`updated DST report comment ${decision.commentId} in place`);
  for (const staleId of decision.staleCommentIds) {
    await checkedFetch(
      `${apiBase}/issues/comments/${staleId}`,
      { method: 'DELETE' },
      'delete stale comment',
    );
    console.log(`deleted stale duplicate comment ${staleId}`);
  }
}

// Runs after the comment above, deliberately — same reasoning as
// post-soundness-comment.mjs never controlling job exit status itself:
// .github/workflows/dst.yml's own next step checks report.success and
// fails the job independently, so the PR comment posts regardless of
// verdict, and only afterward does the job's own pass/fail state follow.
