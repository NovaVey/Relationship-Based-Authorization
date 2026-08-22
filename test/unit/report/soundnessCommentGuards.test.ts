/**
 * Coverage for `src/report/soundnessCommentGuards.ts` — the pure decisions
 * `scripts/post-soundness-comment.mjs` imports from the build output
 * (`test/unit/report/prComment.test.ts` is the model this follows: same
 * "hand-built fixtures, no network access" shape for a script's own
 * extracted decision logic). Closes full-repo audit finding #6 (MEDIUM,
 * test-gap, 2026-08-22) — this script had zero automated coverage of any
 * kind despite three follow-on fixes after initial ship (D-046, D-068,
 * D-084) for exactly the branches this file exercises.
 */
import { describe, expect, it } from 'vitest';

import {
  GITHUB_COMMENT_BODY_BYTE_LIMIT,
  buildOversizedFallbackBody,
  decideSoundnessCommentBody,
  requireNonEmptySoundnessReportBody,
  validatePullRequestNumber,
} from '../../../src/report/soundnessCommentGuards.js';
import { SOUNDNESS_REPORT_MARKER } from '../../../src/report/markdown.js';

describe('validatePullRequestNumber', () => {
  it('a-plain-positive-integer-is-accepted-and-returned-as-a-string', () => {
    expect(validatePullRequestNumber(42)).toBe('42');
  });

  it('a-single-digit-pr-number-is-accepted', () => {
    expect(validatePullRequestNumber(7)).toBe('7');
  });

  it.each([
    ['undefined (no pull_request key at all)', undefined],
    ['null', null],
    ['zero', 0],
    ['a negative number', -5],
    ['a non-integer number', 3.5],
    ['a numeric string', '42'],
    ['an object', { number: 42 }],
    ['NaN', Number.NaN],
  ])('%s-is-rejected', (_label, raw) => {
    expect(() => validatePullRequestNumber(raw)).toThrow(
      /no valid pull_request\.number in the GitHub event payload/,
    );
  });

  it('a-value-large-enough-to-stringify-in-exponential-notation-is-rejected-by-the-second-digit-only-check', () => {
    // Number.isInteger(1e21) is true, but String(1e21) === '1e+21' — not a
    // plain digit string. This is exactly the gap the second, string-level
    // regex check exists to close (see this function's own doc comment and
    // scripts/post-dst-comment.mjs's identical reasoning); a caller relying
    // on the numeric check alone would let a non-digit string reach a URL.
    expect(Number.isInteger(1e21)).toBe(true);
    expect(String(1e21)).toBe('1e+21');
    expect(() => validatePullRequestNumber(1e21)).toThrow(/is not a plain positive integer/);
  });
});

describe('requireNonEmptySoundnessReportBody', () => {
  it('a-normal-non-empty-body-does-not-throw', () => {
    expect(() =>
      requireNonEmptySoundnessReportBody('## SOUND — 0 false_grant', 'soundness-report.md'),
    ).not.toThrow();
  });

  it('a-short-but-real-body-does-not-throw-short-is-never-treated-as-suspect', () => {
    // A genuine `sound` verdict's own rendered markdown is legitimately
    // short — this guard must never conflate "short" with "blank".
    expect(() => requireNonEmptySoundnessReportBody('ok', 'soundness-report.md')).not.toThrow();
  });

  it('a-literally-empty-body-throws-naming-the-report-path', () => {
    expect(() => requireNonEmptySoundnessReportBody('', 'soundness-report.md')).toThrow(
      /soundness-report\.md is empty/,
    );
  });

  it('a-whitespace-only-body-throws-the-same-way-a-truly-empty-one-does', () => {
    expect(() => requireNonEmptySoundnessReportBody('   \n\t  \n', 'soundness-report.md')).toThrow(
      /is empty/,
    );
  });

  it('the-thrown-message-reflects-a-non-default-report-path', () => {
    expect(() => requireNonEmptySoundnessReportBody('', 'custom-path.md')).toThrow(
      /custom-path\.md is empty/,
    );
  });
});

describe('decideSoundnessCommentBody / buildOversizedFallbackBody', () => {
  it('a-body-under-the-byte-limit-is-posted-verbatim-with-no-fallback', () => {
    const body = `${SOUNDNESS_REPORT_MARKER}\n\n## SOUND — 0 false_grant\n\nReproduce: \`authz soundness run\``;

    const decision = decideSoundnessCommentBody(body);

    expect(decision).toEqual({
      postBody: body,
      usedFallback: false,
      fullBodyByteLength: Buffer.byteLength(body, 'utf8'),
    });
  });

  it('a-body-exactly-at-the-byte-limit-is-still-posted-verbatim-the-comparison-is-strictly-greater-than', () => {
    const padding = 'x'.repeat(GITHUB_COMMENT_BODY_BYTE_LIMIT - SOUNDNESS_REPORT_MARKER.length);
    const body = `${SOUNDNESS_REPORT_MARKER}${padding}`;
    expect(Buffer.byteLength(body, 'utf8')).toBe(GITHUB_COMMENT_BODY_BYTE_LIMIT);

    const decision = decideSoundnessCommentBody(body);

    expect(decision.usedFallback).toBe(false);
    expect(decision.postBody).toBe(body);
  });

  it('a-body-one-byte-over-the-limit-falls-back-to-the-short-summary', () => {
    const padding = 'x'.repeat(GITHUB_COMMENT_BODY_BYTE_LIMIT - SOUNDNESS_REPORT_MARKER.length + 1);
    const body = `${SOUNDNESS_REPORT_MARKER}${padding}`;
    expect(Buffer.byteLength(body, 'utf8')).toBe(GITHUB_COMMENT_BODY_BYTE_LIMIT + 1);

    const decision = decideSoundnessCommentBody(body);

    expect(decision.usedFallback).toBe(true);
    expect(decision.postBody).not.toBe(body);
    expect(decision.postBody).toBe(buildOversizedFallbackBody(body));
  });

  it('the-fallback-body-is-shorter-than-the-oversized-original-and-still-starts-with-the-marker', () => {
    const hugeBody = `${SOUNDNESS_REPORT_MARKER}\n\n## UNSOUND — 500 false_grant\n\nReproduce: \`authz soundness run --seed 1\`\n\n${'x'.repeat(300_000)}`;

    const fallback = buildOversizedFallbackBody(hugeBody);

    expect(fallback.length).toBeLessThan(hugeBody.length);
    expect(fallback.startsWith(SOUNDNESS_REPORT_MARKER)).toBe(true);
  });

  it('the-fallback-body-preserves-the-real-headline-and-reproduce-line-verbatim', () => {
    const hugeBody = `${SOUNDNESS_REPORT_MARKER}\n\n## UNSOUND — 500 false_grant\n\nReproduce: \`authz soundness run --seed 42\`\n\n${'x'.repeat(300_000)}`;

    const fallback = buildOversizedFallbackBody(hugeBody);

    expect(fallback).toContain('## UNSOUND — 500 false_grant');
    expect(fallback).toContain('Reproduce: `authz soundness run --seed 42`');
  });

  it('the-fallback-body-falls-back-to-a-generic-headline-when-no-h2-headline-line-is-present', () => {
    const bodyWithNoHeadline = `${SOUNDNESS_REPORT_MARKER}\n\n${'x'.repeat(300_000)}`;

    const fallback = buildOversizedFallbackBody(bodyWithNoHeadline);

    expect(fallback).toContain('## verdict unknown — see the workflow run log');
  });

  it('the-fallback-body-omits-the-reproduce-line-entirely-when-none-is-present-rather-than-fabricating-one', () => {
    const bodyWithNoReproduceLine = `${SOUNDNESS_REPORT_MARKER}\n\n## UNSOUND — 1 false_grant\n\n${'x'.repeat(300_000)}`;

    const fallback = buildOversizedFallbackBody(bodyWithNoReproduceLine);

    expect(fallback).not.toContain('Reproduce:');
  });

  it('the-fallback-message-calls-the-ceiling-a-byte-limit-never-a-character-limit', () => {
    // Full-repo audit finding #14 (LOW, 2026-08-22): the comparison is
    // Buffer.byteLength, so every human-facing message about it must say
    // "bytes", never "characters" — a dense UTF-8 report (arrows, em
    // dashes) can have materially more bytes than characters.
    const hugeBody = `${SOUNDNESS_REPORT_MARKER}\n\n## UNSOUND\n\n${'x'.repeat(300_000)}`;

    const fallback = buildOversizedFallbackBody(hugeBody);

    expect(fallback).toContain('bytes');
    expect(fallback).not.toContain('characters');
    expect(fallback).not.toContain('character limit');
  });

  it('multi-byte-utf8-characters-can-push-a-body-over-the-byte-limit-well-before-its-character-count-would', () => {
    // An em dash ('—') is 1 JS string character but 3 UTF-8 bytes — the
    // exact discrepancy finding #14 is about. A body made entirely of them
    // crosses the byte limit at roughly a third of its character count.
    const emDashCount = Math.ceil(GITHUB_COMMENT_BODY_BYTE_LIMIT / 3) + 1;
    const body = `${SOUNDNESS_REPORT_MARKER}\n${'—'.repeat(emDashCount)}`;

    expect(body.length).toBeLessThan(GITHUB_COMMENT_BODY_BYTE_LIMIT);
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(GITHUB_COMMENT_BODY_BYTE_LIMIT);

    const decision = decideSoundnessCommentBody(body);

    expect(decision.usedFallback).toBe(true);
  });
});
