/**
 * `src/report/markdown.ts` — build spec
 * `.claude/commands/build-authz-service.md` §6.5 (asymmetric verdicts),
 * §6.7/§8 (the resolution path IS the audit trail — §8's own worked
 * example: `user:alice → group:eng#member → folder:design#editor →
 * document:readme#view`), `docs/DECISIONS.md` D-036 (proof/disproof
 * symmetry for exclusion), D-043 (fenced-block rendering for non-linear
 * paths, and the annotation-placement bug this file's own tests must be
 * able to catch), D-044 (bold-label, never emoji, for `false_grant`), D-084
 * (the `false_grant` size budget — a real crash this file's tests must be
 * able to catch: uncapped `false_grant` rendering could itself cross
 * GitHub's PR-comment limit).
 *
 * Fixtures below are hand-built `ResolutionStep`/`DisproofStep` trees using
 * the reference/production resolvers' own exported types
 * (`src/resolve/reference/resolver.ts`, `src/resolve/production/
 * resolver.ts`) — never produced by calling either resolver. The linear
 * chain fixture is deliberately shaped to match §8's own worked example
 * structurally (a `tupleToUserset` hop landing on a `usersetMembership`
 * landing on a `directGrant`) so its expected flattened chain is derivable
 * by hand from the resolvers' own documented flattening rules, not copied
 * from any one rendering.
 */
import { describe, expect, it } from 'vitest';

import {
  SOUNDNESS_REPORT_MARKER,
  renderDivergenceMarkdown,
  renderHeadline,
  renderSoundnessMarkdown,
  renderSoundnessFixtureFailureMarkdown,
} from '../../../src/report/markdown.js';
import type { DivergenceRecord, SoundnessRunResult } from '../../../src/soundness/runner.js';
import type { ResolutionStep as ProductionResolutionStep } from '../../../src/resolve/production/resolver.js';
import type { ResolutionStep as ReferenceResolutionStep } from '../../../src/resolve/reference/resolver.js';

function baseResult(overrides: Partial<SoundnessRunResult> = {}): SoundnessRunResult {
  return {
    id: 'run-id-1',
    graphSeed: 'seed-abc',
    namespaceCount: 4,
    tupleCount: 17,
    queryCount: 250,
    falseGrantCount: 0,
    falseDenyCount: 0,
    criticalNamespaceFalseGrants: 0,
    verdict: 'sound',
    divergences: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture: a fully linear false_grant path (directGrant -> usersetMembership
// -> tupleToUserset), shaped to mirror §8's own worked example:
//   user:mallory -> group:eng#member -> folder:design#editor -> document:secret#view
// Derived by hand from each step kind's own documented flattening rule
// (`docs/DECISIONS.md` D-036, each resolver's own doc comment on
// `ResolutionStep`): `directGrant` yields [subject, object#relation];
// `usersetMembership` lands its child chain on `userset#usersetRelation`
// then appends `object#relation`; `tupleToUserset` lands its child chain on
// `through#computedUserset` and appends nothing of its own (the caller
// appends the final query label) — so the fully-flattened chain is exactly
// the four labels above, in that order.
// ---------------------------------------------------------------------------
const linearProductionPath: ProductionResolutionStep = {
  kind: 'tupleToUserset',
  object: { ns: 'document', id: 'secret' },
  relation: 'parent',
  computedUserset: 'editor',
  through: { ns: 'folder', id: 'design' },
  member: {
    kind: 'usersetMembership',
    object: { ns: 'folder', id: 'design' },
    relation: 'editor',
    userset: { ns: 'group', id: 'eng' },
    usersetRelation: 'member',
    member: {
      kind: 'directGrant',
      object: { ns: 'group', id: 'eng' },
      relation: 'member',
      subject: { ns: 'user', id: 'mallory' },
    },
  },
};

const linearFalseGrant: DivergenceRecord = {
  query: {
    subject: { ns: 'user', id: 'mallory' },
    object: { ns: 'document', id: 'secret' },
    relationOrPermission: 'view',
  },
  expected: false,
  actual: true,
  kind: 'false_grant',
  critical: true,
  productionPath: linearProductionPath,
};

// ---------------------------------------------------------------------------
// Fixture: an intersection-shaped false_grant path — two independent
// directGrant branches, both required.
// ---------------------------------------------------------------------------
const intersectionProductionPath: ProductionResolutionStep = {
  kind: 'intersection',
  object: { ns: 'document', id: 'secret' },
  branches: [
    {
      kind: 'directGrant',
      object: { ns: 'document', id: 'secret' },
      relation: 'owner',
      subject: { ns: 'user', id: 'mallory' },
    },
    {
      kind: 'directGrant',
      object: { ns: 'document', id: 'secret' },
      relation: 'editor',
      subject: { ns: 'user', id: 'mallory' },
    },
  ],
};

const intersectionFalseGrant: DivergenceRecord = {
  query: {
    subject: { ns: 'user', id: 'mallory' },
    object: { ns: 'document', id: 'secret' },
    relationOrPermission: 'edit',
  },
  expected: false,
  actual: true,
  kind: 'false_grant',
  critical: false,
  productionPath: intersectionProductionPath,
};

// ---------------------------------------------------------------------------
// Fixture: an exclusion-shaped false_grant path — base holds (a directGrant)
// AND the excluded set ("banned") is disproven via a real relationDisproof
// naming an actual, different subject examined on that relation.
// ---------------------------------------------------------------------------
const exclusionProductionPath: ProductionResolutionStep = {
  kind: 'exclusion',
  object: { ns: 'document', id: 'secret' },
  base: {
    kind: 'directGrant',
    object: { ns: 'document', id: 'secret' },
    relation: 'viewer',
    subject: { ns: 'user', id: 'mallory' },
  },
  subtractDisproof: {
    kind: 'relationDisproof',
    object: { ns: 'document', id: 'secret' },
    relation: 'banned',
    maxDepth: 25,
    nodes: [
      {
        key: { ns: 'document', id: 'secret', relation: 'banned' },
        depth: 0,
        ancestorPath: [],
        tuples: [{ kind: 'plain', subject: { ns: 'user', id: 'notmallory' } }],
      },
    ],
  },
};

const exclusionFalseGrant: DivergenceRecord = {
  query: {
    subject: { ns: 'user', id: 'mallory' },
    object: { ns: 'document', id: 'secret' },
    relationOrPermission: 'view',
  },
  expected: false,
  actual: true,
  kind: 'false_grant',
  critical: true,
  productionPath: exclusionProductionPath,
};

// ---------------------------------------------------------------------------
// Fixture: a plain false_deny with a real reference path, for the
// label-crossing test.
// ---------------------------------------------------------------------------
const referenceDenyPath: ReferenceResolutionStep = {
  kind: 'directGrant',
  object: { ns: 'document', id: 'readme' },
  relation: 'viewer',
  subject: { ns: 'user', id: 'bob' },
};

const plainFalseDeny: DivergenceRecord = {
  query: {
    subject: { ns: 'user', id: 'bob' },
    object: { ns: 'document', id: 'readme' },
    relationOrPermission: 'view',
  },
  expected: true,
  actual: false,
  kind: 'false_deny',
  critical: false,
  referencePath: referenceDenyPath,
};

describe('renderSoundnessMarkdown — a sound run (0/0)', () => {
  const result = baseResult({
    verdict: 'sound',
    falseGrantCount: 0,
    falseDenyCount: 0,
    divergences: [],
  });
  const output = renderSoundnessMarkdown(result);

  it('a-sound-run-headline-says-sound-unambiguously-not-merely-as-a-substring-of-unsound', () => {
    const headline = renderHeadline(result);
    expect(headline).toMatch(/^SOUND\b/);
    expect(headline.startsWith('UNSOUND')).toBe(false);
    expect(output).toContain(headline);
  });

  it('a-sound-run-states-a-measured-result-of-this-runs-fuzz-budget-not-a-general-security-claim', () => {
    expect(output.toLowerCase()).toContain('measured result');
  });

  it('a-sound-run-never-renders-a-false-grant-findings-section-not-even-an-empty-one', () => {
    expect(output).not.toContain('FALSE_GRANT findings');
    expect(output).not.toContain('false_deny findings');
  });
});

describe('renderSoundnessMarkdown — a linear false_grant path', () => {
  const block = renderDivergenceMarkdown(linearFalseGrant, 1).join('\n');

  it('a-fully-linear-false-grant-resolution-path-renders-as-one-arrow-joined-chain-line-not-a-fenced-block', () => {
    const expectedChain =
      '`user:mallory` → `group:eng#member` → `folder:design#editor` → `document:secret#view`';
    expect(block).toContain(expectedChain);
    expect(block).not.toContain('```');
  });

  it('a-false-grant-entry-carries-the-bold-false-grant-label', () => {
    expect(block).toContain('**FALSE_GRANT**');
  });
});

describe('renderSoundnessMarkdown — an intersection-shaped false_grant path', () => {
  const block = renderDivergenceMarkdown(intersectionFalseGrant, 1).join('\n');

  it('an-intersection-shaped-false-grant-path-renders-inside-a-fenced-text-block-not-a-native-nested-list', () => {
    expect(block).toContain('```text');
    // Exactly one fence opened and one closed.
    expect(block.match(/```/g)?.length).toBe(2);
  });

  it('an-intersection-shaped-false-grant-path-states-all-branches-were-required', () => {
    expect(block).toMatch(/AND/);
    expect(block).toMatch(/all 2 branch(es)? required/i);
  });
});

describe('renderSoundnessMarkdown — an exclusion-shaped false_grant path', () => {
  const block = renderDivergenceMarkdown(exclusionFalseGrant, 1).join('\n');

  it('an-exclusion-shaped-false-grant-path-renders-inside-a-fenced-text-block', () => {
    expect(block).toContain('```text');
  });

  it('the-exclusion-disproofs-own-real-examined-tuple-appears-never-a-bare-false-trust-it', () => {
    // The specific, real subject examined while disproving the excluded
    // ("banned") relation must appear verbatim — this is D-036/D-043's
    // whole point: a reader is handed the actual evidence, not asked to
    // trust a resolver's own "and it's excluded" boolean.
    expect(block).toContain('user:notmallory');
    expect(block).not.toMatch(/trust it/i);
  });
});

describe('renderDivergenceMarkdown / renderPathBlock — the annotation after a fenced structured path never glues onto the fence itself (D-043 regression)', () => {
  it.each([
    ['an intersection-shaped path', intersectionFalseGrant],
    ['an exclusion-shaped path', exclusionFalseGrant],
  ])(
    'the-this-proves-annotation-for-%s-is-a-standalone-blank-line-separated-line-after-the-closing-fence',
    (_label, divergence) => {
      const block = renderDivergenceMarkdown(divergence, 1).join('\n');
      const closeFenceIndex = block.lastIndexOf('```');
      expect(closeFenceIndex).toBeGreaterThan(-1);

      const after = block.slice(closeFenceIndex + 3);
      const afterLines = after.split('\n');

      // The required shape, line by line, right after the closing fence:
      //   afterLines[0] === ''   -- nothing glued onto the fence's own line
      //   afterLines[1] === ''   -- a REAL blank line separating fence from
      //                            annotation (this is the element a
      //                            no-blank-line regression collapses away —
      //                            asserting only "some earlier line is
      //                            blank" is not enough, since afterLines[0]
      //                            is *always* '' merely because the fence
      //                            itself ends a line; requiring a SECOND,
      //                            distinct blank line at index 1 is what
      //                            actually proves real separation)
      //   afterLines[2]           -- the standalone annotation line
      expect(afterLines[0]).toBe('');
      expect(afterLines[1]).toBe('');
      expect(afterLines[2]).toMatch(/^_\(this proves .+\)_$/);
    },
  );
});

describe('renderSoundnessMarkdown — false_grant always renders in full, regardless of count', () => {
  function grantFor(n: number): DivergenceRecord {
    return {
      query: {
        subject: { ns: 'user', id: `mallory${n}` },
        object: { ns: 'document', id: `secret${n}` },
        relationOrPermission: 'view',
      },
      expected: false,
      actual: true,
      kind: 'false_grant',
      critical: false,
      productionPath: {
        kind: 'directGrant',
        object: { ns: 'document', id: `secret${n}` },
        relation: 'viewer',
        subject: { ns: 'user', id: `mallory${n}` },
      },
    };
  }

  it('all-3-false-grants-appear-with-their-full-resolution-path-never-summarized-into-a-bare-count', () => {
    const divergences = [grantFor(1), grantFor(2), grantFor(3)];
    const result = baseResult({ verdict: 'unsound', falseGrantCount: 3, divergences });

    const output = renderSoundnessMarkdown(result);

    for (let n = 1; n <= 3; n += 1) {
      expect(output).toContain(`user:mallory${n}`);
      expect(output).toContain(`document:secret${n}#view`);
    }
    // Exactly 3 rendered blocks (one per divergence) — never collapsed.
    expect(output.match(/<summary>/g)?.length).toBe(3);
    // No omission/summarization language anywhere near the false_grant
    // section — the headline's own "3 false_grant" count is expected and
    // is not what this assertion is guarding against, so it targets the
    // "further ... omitted" phrasing specifically, not any digit adjacent
    // to the word "false_grant".
    expect(output).not.toMatch(/further false_grant/i);
    expect(output).not.toMatch(/false_grant.*omitted/i);
  });
});

// ---------------------------------------------------------------------------
// Full-repo audit finding (HIGH, 2026-08-16): uncapped false_grant rendering
// could itself cross GitHub's ~65,536-character PR-comment-body limit and
// crash scripts/post-soundness-comment.mjs on GitHub's own 422, before it
// ever posted a comment — exactly the worst-case finding this whole
// reporting pipeline exists to surface. `renderSoundnessMarkdown` now
// applies a real size budget (`maxCommentChars`, `docs/DECISIONS.md` D-084)
// to the false_grant section specifically — never a fixed entry-count cap
// (that stays the false_deny-only mechanism, see the describe block above
// and below): once the running body would cross the budget, further
// false_grant entries stop rendering their own resolution path, but the
// true total count and an unmissable, un-muted truncation notice always
// render in their place. This is deliberately a *different* mechanism from
// the "always renders in full, regardless of count" describe block above —
// that block's own small (3-entry) fixtures never approach any realistic
// size budget, so it stays a true, un-truncated regression guard on its own.
// ---------------------------------------------------------------------------
describe("renderSoundnessMarkdown — false_grant respects a real size budget so this comment can never cross GitHub's limit, and always discloses the true total", () => {
  function grantFor(n: number): DivergenceRecord {
    return {
      query: {
        subject: { ns: 'user', id: `mallory${n}` },
        object: { ns: 'document', id: `secret${n}` },
        relationOrPermission: 'view',
      },
      expected: false,
      actual: true,
      kind: 'false_grant',
      critical: false,
      productionPath: {
        kind: 'directGrant',
        object: { ns: 'document', id: `secret${n}` },
        relation: 'viewer',
        subject: { ns: 'user', id: `mallory${n}` },
      },
    };
  }

  it('a-small-override-budget-still-renders-at-least-one-false-grant-in-full-and-discloses-the-true-total-for-the-rest', () => {
    const divergences = Array.from({ length: 20 }, (_, i) => grantFor(i + 1));
    const result = baseResult({ verdict: 'unsound', falseGrantCount: 20, divergences });

    const output = renderSoundnessMarkdown(result, { maxCommentChars: 2000 });

    // At least the first entry rendered in full, with its real resolution path.
    expect(output).toContain('user:mallory1');
    expect(output).toContain('document:secret1#view');

    // Not every one of the 20 fits under a 2,000-character budget.
    const summaryCount = output.match(/<summary>/g)?.length ?? 0;
    expect(summaryCount).toBeGreaterThan(0);
    expect(summaryCount).toBeLessThan(20);

    // The truncation notice is unmissable (bold) and states the real total —
    // never a bare "N divergences" with no evidence of severity.
    expect(output).toMatch(
      /\*\*TRUNCATED.+FALSE_GRANT.+not shown in this comment.+\(20 total\)\.\*\*/,
    );
    expect(output).toContain('every omitted entry is a full **FALSE_GRANT** finding');
    expect(output).toMatch(/Run soundness fuzz.*step log/);
  });

  it('the-default-budget-keeps-500-false-grant-divergences-under-githubs-own-65-536-character-comment-limit', () => {
    const divergences = Array.from({ length: 500 }, (_, i) => grantFor(i + 1));
    const result = baseResult({ verdict: 'unsound', falseGrantCount: 500, divergences });

    // Default options — no override — the real, shipped budget.
    const output = renderSoundnessMarkdown(result);

    // GitHub's own documented PR-comment-body ceiling.
    expect(output.length).toBeLessThan(65_536);

    const summaryCount = output.match(/<summary>/g)?.length ?? 0;
    expect(summaryCount).toBeGreaterThan(0);
    expect(summaryCount).toBeLessThan(500);
    expect(output).toContain('(500 total)');
    expect(output).toContain('**TRUNCATED');

    // Confirms the ceiling is real, not incidental: rendering every one of
    // the 500 in full (the pre-fix behavior) does cross GitHub's limit.
    const unbounded = renderSoundnessMarkdown(result, { maxCommentChars: Infinity });
    expect(unbounded.length).toBeGreaterThan(65_536);
  });

  it('the-truncation-notice-is-never-the-muted-false-deny-register-and-the-run-that-triggered-it-is-never-mistaken-for-sound', () => {
    const divergences = Array.from({ length: 20 }, (_, i) => grantFor(i + 1));
    const result = baseResult({ verdict: 'unsound', falseGrantCount: 20, divergences });

    const output = renderSoundnessMarkdown(result, { maxCommentChars: 2000 });

    expect(output).not.toMatch(/^SOUND\b/m);
    expect(output).not.toContain('`false_deny`');
  });

  it('a-run-with-few-false-grants-never-triggers-truncation-even-with-the-default-budget-no-false-positive', () => {
    const divergences = Array.from({ length: 3 }, (_, i) => grantFor(i + 1));
    const result = baseResult({ verdict: 'unsound', falseGrantCount: 3, divergences });

    const output = renderSoundnessMarkdown(result);

    expect(output).not.toContain('TRUNCATED');
    expect(output.match(/<summary>/g)?.length).toBe(3);
  });
});

describe('renderSoundnessMarkdown — false_deny respects maxRenderedFalseDeny and discloses the omitted count', () => {
  function denyFor(n: number): DivergenceRecord {
    return {
      query: {
        subject: { ns: 'user', id: `bob${n}` },
        object: { ns: 'document', id: `readme${n}` },
        relationOrPermission: 'view',
      },
      expected: true,
      actual: false,
      kind: 'false_deny',
      critical: false,
      referencePath: {
        kind: 'directGrant',
        object: { ns: 'document', id: `readme${n}` },
        relation: 'viewer',
        subject: { ns: 'user', id: `bob${n}` },
      },
    };
  }

  it('exactly-the-capped-number-of-false-deny-entries-render-in-full-and-the-rest-are-never-silently-dropped', () => {
    const divergences = Array.from({ length: 5 }, (_, i) => denyFor(i + 1));
    // 0 false_grant / 5 false_deny is still a `sound` verdict per §6.5/
    // D-006 — false_deny never fails a run on its own. This fixture is
    // hand-supplied directly to the renderer; it does not depend on
    // `classify.ts` having produced it.
    const result = baseResult({ verdict: 'sound', falseDenyCount: 5, divergences });

    const output = renderSoundnessMarkdown(result, { maxRenderedFalseDeny: 2 });

    expect(output).toContain('user:bob1');
    expect(output).toContain('user:bob2');
    expect(output).not.toContain('user:bob3');
    expect(output).not.toContain('user:bob4');
    expect(output).not.toContain('user:bob5');

    const match = output.match(/(\d+) further false_deny/i);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(3); // 5 total - 2 rendered = 3 omitted
  });

  it('the-default-cap-is-20-when-maxrenderedfalsedeny-is-omitted-per-the-options-own-documented-default', () => {
    const divergences = Array.from({ length: 25 }, (_, i) => denyFor(i + 1));
    const result = baseResult({ verdict: 'sound', falseDenyCount: 25, divergences });

    const output = renderSoundnessMarkdown(result);

    expect(output).toContain('user:bob20');
    expect(output).not.toContain('user:bob21');
    const match = output.match(/(\d+) further false_deny/i);
    expect(Number(match?.[1])).toBe(5);
  });
});

describe('renderSoundnessMarkdown — SOUNDNESS_REPORT_MARKER is always the literal first line', () => {
  it.each([
    ['sound', 'sound' as const, []],
    ['unsound', 'unsound' as const, [linearFalseGrant]],
    ['insufficient_coverage', 'insufficient_coverage' as const, []],
  ])('the-marker-is-the-first-line-for-a-%s-report', (_label, verdict, divergences) => {
    const result = baseResult({
      verdict,
      falseGrantCount: verdict === 'unsound' ? 1 : 0,
      divergences,
    });

    const output = renderSoundnessMarkdown(result);

    expect(output.split('\n')[0]).toBe(SOUNDNESS_REPORT_MARKER);
  });
});

describe('renderSoundnessMarkdown — false_grant and false_deny labels never cross, and no emoji anywhere', () => {
  it('the-bold-false-grant-label-never-appears-in-a-false-denys-own-rendered-block-and-vice-versa', () => {
    const grantBlock = renderDivergenceMarkdown(linearFalseGrant, 1).join('\n');
    const denyBlock = renderDivergenceMarkdown(plainFalseDeny, 1).join('\n');

    expect(grantBlock).toContain('**FALSE_GRANT**');
    expect(denyBlock).not.toContain('**FALSE_GRANT**');

    expect(denyBlock).toContain('`false_deny`');
    expect(grantBlock).not.toContain('`false_deny`');
  });

  it('no-emoji-appears-anywhere-in-a-rendered-report-covering-a-false-grant-an-intersection-and-an-exclusion', () => {
    const result = baseResult({
      verdict: 'unsound',
      falseGrantCount: 3,
      falseDenyCount: 1,
      criticalNamespaceFalseGrants: 2,
      divergences: [linearFalseGrant, intersectionFalseGrant, exclusionFalseGrant, plainFalseDeny],
    });

    const output = renderSoundnessMarkdown(result);

    // `\p{Extended_Pictographic}` is the standard Unicode property for
    // emoji-shaped characters — verified separately to be `false` for the
    // plain arrow (U+2192) this file's own chain notation uses, so this
    // assertion cannot produce a false positive on the arrow glyph itself.
    const emojiPattern = /\p{Extended_Pictographic}/u;
    expect(emojiPattern.test(output)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderSoundnessFixtureFailureMarkdown — full-repo audit finding #12
// (MEDIUM, 2026-08-16). The `FIXTURE_FAILURE` sibling of
// `renderSoundnessInfrastructureFailureMarkdown` (`src/report/markdown.ts`),
// rendered when `runSoundnessFuzz` throws a `SoundnessFixtureError`: the
// generated fuzz fixture itself was invalid (a schema compile, publish, or
// tuple-write failure), never a database-connectivity problem — so this
// rendering must say plainly that no verdict was produced, without ever
// implying Postgres or connectivity is the culprit. Written from
// `renderSoundnessFixtureFailureMarkdown`'s own doc comment in
// `src/report/markdown.ts` (its `## FIXTURE_FAILURE` header, its explicit
// "not an infrastructure problem" framing, its `SOUNDNESS_REPORT_MARKER`
// requirement for the PR-comment "update in place" contract), not from a
// pre-existing sibling test for `renderSoundnessInfrastructureFailureMarkdown`
// — no such test exists yet in this file to mirror; see this phase's own
// test-author report for that gap.
// ---------------------------------------------------------------------------

describe('renderSoundnessFixtureFailureMarkdown', () => {
  const message =
    'soundness run (seed=broken-fixture-seed): generated schema failed to compile — this is a ' +
    'generator bug, not a resolver finding: line 4: namespace `document` is declared twice';
  const output = renderSoundnessFixtureFailureMarkdown(message);

  it('starts-with-the-soundness-report-marker-so-the-pr-comment-update-in-place-contract-still-recognizes-it', () => {
    expect(output.split('\n')[0]).toBe(SOUNDNESS_REPORT_MARKER);
  });

  it('contains-the-fixture-failure-header-never-the-infrastructure-failure-header', () => {
    expect(output).toContain('## FIXTURE_FAILURE');
    expect(output).not.toContain('INFRASTRUCTURE_FAILURE');
  });

  it('contains-the-literal-message-text-verbatim', () => {
    expect(output).toContain(message);
  });

  it('never-mentions-postgres-or-database-reachability-this-is-a-generator-bug-not-an-infrastructure-problem', () => {
    expect(output.toLowerCase()).not.toContain('postgres');
    expect(output.toLowerCase()).not.toMatch(/check that the (target |)database is reachable/);
  });

  it('states-plainly-that-no-verdict-was-produced-and-never-renders-a-real-headline-claiming-a-measured-false-grant-count', () => {
    expect(output).toContain('No verdict was produced');
    // Never a real `renderHeadline`-shaped claim ("N false_grant, M
    // false_deny, across Q queries") — this rendering's own honest-
    // disclosure sentence legitimately contains the substring "0
    // false_grant" (see `renderSoundnessFixtureFailureMarkdown`'s own doc
    // comment: "`0 false_grant` is never reported here" — the phrase itself
    // appears precisely to say it is NOT being reported as a measured
    // result), so asserting the bare substring is absent would be a false
    // requirement; what actually matters is that no real headline pattern
    // — the one a genuine `sound` verdict renders — ever appears here.
    expect(output).not.toMatch(/\d+ false_grant, \d+ false_deny, across \d+ queries/);
    expect(output).not.toMatch(/^SOUND\b/m);
  });
});
