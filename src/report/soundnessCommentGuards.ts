/**
 * The pure, testable half of `scripts/post-soundness-comment.mjs` —
 * `src/report/prComment.ts`'s own `decidePrCommentAction` doc comment lays
 * out exactly why the update-in-place decision was pulled out of that
 * script into a real, tested `src/` module rather than left as inline
 * script logic; this file does the same for the script's other three
 * branches, closing full-repo audit finding #6 (MEDIUM, test-gap,
 * 2026-08-22): despite gating whether this project's core soundness
 * verdict is ever visibly posted to a PR, and despite three follow-on
 * fixes after initial ship (`docs/DECISIONS.md` D-046, D-068, D-084), the
 * script itself had zero automated coverage — a `.mjs` file with no `.ts`
 * counterpart is invisible to `npm test`, `npm run typecheck`, and every
 * other check this repo's `verify` script runs. Deliberately no
 * `@octokit`/GitHub API calls or filesystem I/O anywhere in this file — the
 * script still owns `readFileSync`, `fetch`, and `console.log`; this file
 * owns only the decisions those calls feed into and act on, exactly the
 * same split `prComment.ts` already draws.
 */
import { Buffer } from 'node:buffer';

import { SOUNDNESS_REPORT_MARKER } from './markdown.js';

/**
 * Turns `GITHUB_EVENT_PATH`'s raw, untyped `pull_request.number` into a
 * validated string safe to interpolate into a GitHub REST API URL, or
 * throws. Two checks, not one, deliberately layered:
 *
 * 1. `raw` must be a positive integer `number` — rejects `undefined`
 *    (no `pull_request` key at all, e.g. this workflow somehow running on
 *    a non-`pull_request` event), and rejects `0`/negative/non-integer
 *    values a hand-crafted or malformed event payload could carry.
 * 2. The stringified result is re-checked against a strict digit-only
 *    `^[1-9][0-9]*$` pattern before being returned. Not redundant with
 *    check 1: `Number.isInteger` is true of values large enough that
 *    `String()` renders them in exponential notation (e.g.
 *    `String(1e21) === '1e+21'`), which would flow a non-digit string into
 *    a URL untouched. `scripts/post-dst-comment.mjs` already carries this
 *    exact second check with the identical reasoning (a CodeQL "file data
 *    in outbound network request" finding flagged the file-to-URL flow
 *    directly) — folded in here rather than left as a soundness-specific
 *    gap the DST script's own review already closed for its sibling.
 *
 * `event.pull_request?.number` is `unknown` from this function's point of
 * view (parsed JSON, never trusted as the type it claims to be) — the
 * caller passes it through untouched rather than asserting a type first.
 */
export function validatePullRequestNumber(raw: unknown): string {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(
      'no valid pull_request.number in the GitHub event payload — this script only runs in a pull_request-triggered job',
    );
  }
  const prNumber = String(raw);
  if (!/^[1-9][0-9]*$/.test(prNumber)) {
    throw new Error(`pull_request.number "${prNumber}" is not a plain positive integer`);
  }
  return prNumber;
}

/**
 * Throws unless `body` (the raw content of `soundness-report.md`, already
 * read by the caller) has real, non-whitespace content. See
 * `scripts/post-soundness-comment.mjs`'s own top-of-file doc comment
 * ("This script refuses to post or update the tracked comment with an
 * empty body (D-068)") for the full reasoning — this function is that
 * guard, extracted so it is exercised by a real test rather than only ever
 * observed live in a CI failure. Checks literal blankness only, never a
 * length threshold: a genuine `sound` verdict's own rendered markdown is
 * legitimately short, and this must never treat "short" as suspect the way
 * it correctly treats "blank" as suspect.
 */
export function requireNonEmptySoundnessReportBody(body: string, reportPath: string): void {
  if (body.trim().length === 0) {
    throw new Error(
      `${reportPath} is empty — \`authz soundness run --format markdown\` produced no report on ` +
        `stdout. Refusing to post or overwrite the tracked soundness PR comment with a blank body ` +
        `(that would silently erase the last known-good report). See the "Run soundness fuzz" ` +
        `step's own logged output, above, for the real underlying error.`,
    );
  }
}

/**
 * GitHub's own documented ceiling for a single issue/PR comment body, in
 * bytes — not characters (full-repo audit finding #14, LOW, 2026-08-22:
 * every message that names this limit used to call it a "character" limit,
 * which is wrong given `Buffer.byteLength(body, 'utf8')` is what is
 * actually compared below; a rendered soundness report is dense with
 * multi-byte UTF-8 characters — arrows, em dashes — so byte count can
 * exceed true character count materially. Errs safe either way, the
 * fallback can trip slightly before GitHub's real character-based ceiling,
 * never after — so this was a wording fix, not a measurement change: the
 * comparison itself stays `Buffer.byteLength`, deliberately, per this
 * finding's own resolution).
 */
export const GITHUB_COMMENT_BODY_BYTE_LIMIT = 65536;

/**
 * Built only when `fullBody` is over `GITHUB_COMMENT_BODY_BYTE_LIMIT` — a
 * short, honest, `SOUNDNESS_REPORT_MARKER`-prefixed stand-in for the real
 * report, never the real (oversized) body itself. Starts with the marker
 * for the same reason every real report does (`decidePrCommentAction`
 * matches it to decide "update this one" vs. "post a new one" — omitting it
 * here would orphan this fallback comment the next time a normal-sized
 * report posts). Pulls the real H2 headline line and the real
 * `Reproduce: ...` line straight out of the oversized `fullBody` verbatim —
 * both are always the first two rendered elements after the marker in
 * `renderSoundnessMarkdown`'s own output, so this fallback still states the
 * real, measured verdict and counts, never a vaguer "something is wrong."
 * Points at the workflow run's own "Run soundness fuzz" step log — the one
 * place the complete, untruncated report actually is
 * (`.github/workflows/soundness.yml` already `cat`s the full
 * `soundness-report.md` there; no artifact upload exists in this workflow
 * to point at instead, so this deliberately names the real mechanism, not a
 * hypothetical one).
 */
export function buildOversizedFallbackBody(fullBody: string): string {
  const headlineMatch = fullBody.match(/^## .+$/m);
  const reproduceMatch = fullBody.match(/^Reproduce: .+$/m);
  const byteLength = Buffer.byteLength(fullBody, 'utf8');
  const lines = [
    SOUNDNESS_REPORT_MARKER,
    '',
    headlineMatch ? headlineMatch[0] : '## verdict unknown — see the workflow run log',
    '',
    `The full soundness report is ${byteLength} bytes — too large to post as a single PR ` +
      `comment (GitHub's own limit is ${GITHUB_COMMENT_BODY_BYTE_LIMIT} bytes). The headline ` +
      'above is the real, measured result of this run, not summarized or softened. See the workflow ' +
      'run\'s "Run soundness fuzz" step log for the complete report — it prints the full markdown ' +
      'verbatim — or reproduce the exact run locally.',
  ];
  if (reproduceMatch) {
    lines.push('', reproduceMatch[0]);
  }
  return lines.join('\n');
}

/** What `decideSoundnessCommentBody` returns — everything the script needs, both to act and to log, without recomputing anything itself. */
export interface SoundnessCommentBodyDecision {
  /** The exact string the caller should POST/PATCH as the comment body — `fullBody` verbatim in the common case, or `buildOversizedFallbackBody(fullBody)`. */
  postBody: string;
  /** True iff `postBody` is the short fallback substituted for an oversized `fullBody`, never `fullBody` itself. */
  usedFallback: boolean;
  /** `Buffer.byteLength(fullBody, 'utf8')` — computed once here so the caller's own logging never needs to recompute it (or risk it disagreeing with the value this function actually compared against the limit). */
  fullBodyByteLength: number;
}

/**
 * Given the real, rendered soundness report body, decides whether it is
 * safe to POST/PATCH as-is or must fall back to
 * `buildOversizedFallbackBody`'s short summary. See
 * `scripts/post-soundness-comment.mjs`'s own top-of-file doc comment
 * ("This script also refuses to POST an oversized body unhandled") for why
 * this check exists as a second, independent layer behind
 * `renderSoundnessMarkdown`'s own `DEFAULT_MAX_COMMENT_CHARS` budget
 * (`src/report/markdown.ts`, D-084) rather than trusting that budget math
 * alone.
 */
export function decideSoundnessCommentBody(fullBody: string): SoundnessCommentBodyDecision {
  const fullBodyByteLength = Buffer.byteLength(fullBody, 'utf8');
  if (fullBodyByteLength <= GITHUB_COMMENT_BODY_BYTE_LIMIT) {
    return { postBody: fullBody, usedFallback: false, fullBodyByteLength };
  }
  return {
    postBody: buildOversizedFallbackBody(fullBody),
    usedFallback: true,
    fullBodyByteLength,
  };
}
