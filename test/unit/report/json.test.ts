/**
 * `renderSoundnessJson` / `renderSoundnessJsonString` — build spec
 * `.claude/commands/build-authz-service.md` §6.5 (asymmetric verdicts),
 * §6.7 (resolution paths), §9 Phase 7. Written against `src/report/json.ts`'s
 * own exported types and doc comments, not from reading its rendering logic:
 *
 * - Every field is a direct passthrough of the input `SoundnessRunResult`
 *   (`docs/DECISIONS.md` D-006's asymmetric-verdict discipline extended to
 *   this file: nothing here is re-derived from a threshold).
 * - `severity` is `'blocking'` for every `false_grant` and `'non_blocking'`
 *   for every `false_deny`, and *only* tracks `kind` — this file's own doc
 *   comment on `SoundnessJsonDivergence.severity` states this explicitly.
 * - `referencePath`/`productionPath` pass through verbatim, present iff
 *   that resolver's own `expected`/`actual` boolean was `true` (matching
 *   `DivergenceRecord`'s own field doc comments in `src/soundness/runner.ts`).
 * - `headline` must never drift from `markdown.ts`'s own `renderHeadline` —
 *   this file's own top-of-file doc comment states the two must never
 *   diverge, so the test compares them directly rather than hardcoding
 *   either's expected text.
 */
import { describe, expect, it } from 'vitest';

import {
  renderSoundnessJson,
  renderSoundnessJsonString,
  renderSoundnessFixtureFailureJsonString,
} from '../../../src/report/json.js';
import { renderHeadline } from '../../../src/report/markdown.js';
import type { DivergenceRecord, SoundnessRunResult } from '../../../src/soundness/runner.js';
import type { ResolutionStep as ReferenceResolutionStep } from '../../../src/resolve/reference/resolver.js';
import type { ResolutionStep as ProductionResolutionStep } from '../../../src/resolve/production/resolver.js';

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

const referenceGrantPath: ReferenceResolutionStep = {
  kind: 'directGrant',
  object: { ns: 'document', id: 'readme' },
  relation: 'viewer',
  subject: { ns: 'user', id: 'alice' },
};

const productionGrantPath: ProductionResolutionStep = {
  kind: 'directGrant',
  object: { ns: 'critical_ns', id: 'secret' },
  relation: 'viewer',
  subject: { ns: 'user', id: 'mallory' },
};

describe('renderSoundnessJson — field values match the input SoundnessRunResult exactly', () => {
  it('every-scalar-field-in-the-rendered-report-matches-the-input-soundnessrunresult-exactly', () => {
    const result = baseResult({
      id: 'run-xyz',
      graphSeed: 'seed-42',
      namespaceCount: 6,
      tupleCount: 33,
      queryCount: 5000,
      falseGrantCount: 2,
      falseDenyCount: 5,
      criticalNamespaceFalseGrants: 1,
      verdict: 'unsound',
    });

    const json = renderSoundnessJson(result);

    expect(json.id).toBe(result.id);
    expect(json.seed).toBe(result.graphSeed);
    expect(json.namespaceCount).toBe(result.namespaceCount);
    expect(json.tupleCount).toBe(result.tupleCount);
    expect(json.queryCount).toBe(result.queryCount);
    expect(json.falseGrantCount).toBe(result.falseGrantCount);
    expect(json.falseDenyCount).toBe(result.falseDenyCount);
    expect(json.criticalNamespaceFalseGrants).toBe(result.criticalNamespaceFalseGrants);
    expect(json.verdict).toBe(result.verdict);
  });
});

describe('renderSoundnessJson — severity is derived from kind alone, never from anything else', () => {
  it('severity-is-blocking-for-every-false-grant-and-non-blocking-for-every-false-deny-regardless-of-critical-or-expected-actual-values', () => {
    const divergences: DivergenceRecord[] = [
      // A false_grant that is NOT critical — must still be 'blocking'.
      {
        query: {
          subject: { ns: 'user', id: 'a' },
          object: { ns: 'ns1', id: 'o1' },
          relationOrPermission: 'view',
        },
        expected: false,
        actual: true,
        kind: 'false_grant',
        critical: false,
      },
      // A false_grant that IS critical — also 'blocking' (same as above;
      // `critical` must not change `severity`).
      {
        query: {
          subject: { ns: 'user', id: 'b' },
          object: { ns: 'ns1', id: 'o2' },
          relationOrPermission: 'view',
        },
        expected: false,
        actual: true,
        kind: 'false_grant',
        critical: true,
      },
      // A false_deny that is NOT critical — 'non_blocking'.
      {
        query: {
          subject: { ns: 'user', id: 'c' },
          object: { ns: 'ns1', id: 'o3' },
          relationOrPermission: 'view',
        },
        expected: true,
        actual: false,
        kind: 'false_deny',
        critical: false,
      },
      // A false_deny that IS critical — must still be 'non_blocking'. This
      // is the case that would catch severity being derived from
      // `critical` instead of `kind`.
      {
        query: {
          subject: { ns: 'user', id: 'd' },
          object: { ns: 'ns1', id: 'o4' },
          relationOrPermission: 'view',
        },
        expected: true,
        actual: false,
        kind: 'false_deny',
        critical: true,
      },
    ];
    const result = baseResult({
      verdict: 'unsound',
      falseGrantCount: 2,
      falseDenyCount: 2,
      criticalNamespaceFalseGrants: 1,
      divergences,
    });

    const json = renderSoundnessJson(result);

    expect(json.falseGrants).toHaveLength(2);
    expect(json.falseGrants.every((d) => d.severity === 'blocking')).toBe(true);
    expect(json.falseDenies).toHaveLength(2);
    expect(json.falseDenies.every((d) => d.severity === 'non_blocking')).toBe(true);
  });
});

describe('renderSoundnessJson — referencePath/productionPath pass through verbatim', () => {
  it('referencepath-and-productionpath-are-deep-equal-to-the-input-never-rederived-or-reshaped', () => {
    const falseGrant: DivergenceRecord = {
      query: {
        subject: { ns: 'user', id: 'mallory' },
        object: { ns: 'critical_ns', id: 'secret' },
        relationOrPermission: 'view',
      },
      expected: false,
      actual: true,
      kind: 'false_grant',
      critical: true,
      productionPath: productionGrantPath,
    };
    const falseDeny: DivergenceRecord = {
      query: {
        subject: { ns: 'user', id: 'alice' },
        object: { ns: 'document', id: 'readme' },
        relationOrPermission: 'viewer',
      },
      expected: true,
      actual: false,
      kind: 'false_deny',
      critical: false,
      referencePath: referenceGrantPath,
    };
    const result = baseResult({
      verdict: 'unsound',
      falseGrantCount: 1,
      falseDenyCount: 1,
      criticalNamespaceFalseGrants: 1,
      divergences: [falseGrant, falseDeny],
    });

    const json = renderSoundnessJson(result);

    expect(json.falseGrants).toHaveLength(1);
    expect(json.falseGrants[0]?.productionPath).toEqual(productionGrantPath);
    expect(json.falseDenies).toHaveLength(1);
    expect(json.falseDenies[0]?.referencePath).toEqual(referenceGrantPath);
  });

  it('a-path-is-present-iff-its-own-resolvers-boolean-was-true-never-the-other-resolvers-field-and-never-a-present-but-undefined-key', () => {
    const falseGrant: DivergenceRecord = {
      query: {
        subject: { ns: 'user', id: 'mallory' },
        object: { ns: 'critical_ns', id: 'secret' },
        relationOrPermission: 'view',
      },
      expected: false,
      actual: true,
      kind: 'false_grant',
      critical: true,
      productionPath: productionGrantPath,
      // referencePath deliberately absent — expected is false.
    };
    const result = baseResult({
      verdict: 'unsound',
      falseGrantCount: 1,
      criticalNamespaceFalseGrants: 1,
      divergences: [falseGrant],
    });

    const json = renderSoundnessJson(result);
    const rendered = json.falseGrants[0];
    expect(rendered).toBeDefined();
    expect(rendered?.referencePath).toBeUndefined();
    // Not merely `=== undefined` — the key itself must be absent, not a
    // present-but-undefined own property (a `{ ...cond ? {x} : {} }` bug
    // could otherwise regress to always including the key).
    expect(Object.prototype.hasOwnProperty.call(rendered ?? {}, 'referencePath')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(rendered ?? {}, 'productionPath')).toBe(true);
  });
});

describe("renderSoundnessJson — headline matches markdown.ts's own renderHeadline output exactly", () => {
  it('headline-matches-markdownts-own-renderheadline-output-exactly-for-every-verdict', () => {
    for (const verdict of ['sound', 'unsound', 'insufficient_coverage'] as const) {
      const result = baseResult({
        verdict,
        falseGrantCount: verdict === 'unsound' ? 3 : 0,
        queryCount: 1234,
        graphSeed: `seed-${verdict}`,
      });

      const json = renderSoundnessJson(result);

      expect(json.headline).toBe(renderHeadline(result));
    }
  });
});

describe('renderSoundnessJsonString', () => {
  it('rendersoundnessjsonstring-produces-valid-json-that-parses-back-to-the-same-structured-report', () => {
    const result = baseResult();
    const str = renderSoundnessJsonString(result);

    expect(JSON.parse(str)).toEqual(renderSoundnessJson(result));
  });

  it('rendersoundnessjsonstring-with-pretty-false-produces-a-single-line-payload-that-still-parses-to-the-same-report', () => {
    const result = baseResult();
    const compact = renderSoundnessJsonString(result, false);

    expect(compact).not.toContain('\n');
    expect(JSON.parse(compact)).toEqual(renderSoundnessJson(result));
  });
});

// ---------------------------------------------------------------------------
// renderSoundnessFixtureFailureJsonString — full-repo audit finding #12
// (MEDIUM, 2026-08-16). The JSON sibling of
// `renderSoundnessFixtureFailureMarkdown` (`src/report/markdown.ts`,
// `test/unit/report/markdown.test.ts`'s own test of the same name) —
// rendered when `runSoundnessFuzz` throws a `SoundnessFixtureError`, never
// for an infrastructure failure. Written from
// `renderSoundnessFixtureFailureJsonString`'s own doc comment and its
// sibling `SoundnessInfrastructureFailureJson`'s doc comment in
// `src/report/json.ts` (both state the `pretty` contract is identical to
// `renderSoundnessJsonString`'s own — asserted here the same way
// `renderSoundnessJsonString`'s own tests immediately above assert it, not
// against a pre-existing infrastructure-failure sibling test — no such test
// exists yet in this file; see this phase's own test-author report for that
// gap), not from reading `src/report/json.ts`'s implementation beyond those
// two doc comments.
// ---------------------------------------------------------------------------

describe('renderSoundnessFixtureFailureJsonString', () => {
  const message =
    'soundness run (seed=broken-fixture-seed): failed to write a generated tuple: object id is malformed';

  it('parses-to-status-fixture-failure-and-the-exact-message-passed-in-and-no-other-keys', () => {
    const parsed = JSON.parse(renderSoundnessFixtureFailureJsonString(message));
    expect(parsed).toEqual({ status: 'fixture_failure', message });
  });

  it('never-uses-status-infrastructure-failure-for-a-fixture-error', () => {
    const parsed = JSON.parse(renderSoundnessFixtureFailureJsonString(message));
    expect(parsed.status).not.toBe('infrastructure_failure');
  });

  it('pretty-defaults-to-true-two-space-indented-multi-line-output', () => {
    const output = renderSoundnessFixtureFailureJsonString(message);
    expect(output).toContain('\n');
    expect(output).toBe(JSON.stringify({ status: 'fixture_failure', message }, null, 2));
  });

  it('pretty-false-produces-a-single-line-payload-that-still-parses-to-the-same-report', () => {
    const compact = renderSoundnessFixtureFailureJsonString(message, false);
    expect(compact).not.toContain('\n');
    expect(JSON.parse(compact)).toEqual({ status: 'fixture_failure', message });
  });
});
