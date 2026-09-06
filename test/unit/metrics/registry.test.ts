/**
 * `src/metrics/registry.ts` — the `GET /metrics` route's own backing
 * store. Pure, in-memory, no I/O of any kind, so every test here is a
 * plain unit test: build a minimal `ProductionCheckResult` fixture, call
 * `recordCheck`/`recordCacheHit`/`recordCacheMiss`, and assert on the
 * rendered Prometheus text. `resetMetricsForTest()` runs in `beforeEach`
 * so every test starts from a known, zeroed state regardless of test
 * order — this file's own reason `resetMetricsForTest` exists at all, per
 * that function's own doc comment.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  recordCacheHit,
  recordCacheMiss,
  recordCheck,
  renderPrometheusText,
  resetMetricsForTest,
} from '../../../src/metrics/registry.js';
import type { ProductionCheckResult } from '../../../src/resolve/production/resolver.js';

function fixture(overrides: Partial<ProductionCheckResult> = {}): ProductionCheckResult {
  return { allowed: true, depth: 1, touchedExpiringTuple: false, ...overrides };
}

function metricValue(text: string, name: string, labels = ''): number {
  const line = text
    .split('\n')
    .find((l) => l.startsWith(`${name}${labels} `) || l === `${name}${labels}`);
  if (line === undefined) {
    throw new Error(`metric ${name}${labels} not found in:\n${text}`);
  }
  return Number(line.split(' ').pop());
}

beforeEach(() => {
  resetMetricsForTest();
});

describe('renderPrometheusText — structure', () => {
  it('every metric carries a # HELP and # TYPE line before its samples', () => {
    const text = renderPrometheusText();
    for (const name of [
      'authz_checks_total',
      'authz_check_cache_hits_total',
      'authz_check_cache_misses_total',
      'authz_leopard_index_hits_total',
      'authz_uncertain_checks_total',
    ]) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} counter`);
    }
  });

  it('starts every counter at 0 before any check is recorded', () => {
    const text = renderPrometheusText();
    expect(metricValue(text, 'authz_checks_total', '{allowed="true"}')).toBe(0);
    expect(metricValue(text, 'authz_checks_total', '{allowed="false"}')).toBe(0);
    expect(metricValue(text, 'authz_check_cache_hits_total')).toBe(0);
    expect(metricValue(text, 'authz_check_cache_misses_total')).toBe(0);
    expect(metricValue(text, 'authz_leopard_index_hits_total')).toBe(0);
    expect(metricValue(text, 'authz_uncertain_checks_total')).toBe(0);
  });
});

describe('recordCheck — authz_checks_total', () => {
  it('counts an allowed result under {allowed="true"}, never {allowed="false"}', () => {
    recordCheck(fixture({ allowed: true }));
    const text = renderPrometheusText();
    expect(metricValue(text, 'authz_checks_total', '{allowed="true"}')).toBe(1);
    expect(metricValue(text, 'authz_checks_total', '{allowed="false"}')).toBe(0);
  });

  it('counts a denied result under {allowed="false"}, never {allowed="true"}', () => {
    recordCheck(fixture({ allowed: false, certain: true }));
    const text = renderPrometheusText();
    expect(metricValue(text, 'authz_checks_total', '{allowed="false"}')).toBe(1);
    expect(metricValue(text, 'authz_checks_total', '{allowed="true"}')).toBe(0);
  });

  it('accumulates across multiple calls, not just the most recent one', () => {
    recordCheck(fixture({ allowed: true }));
    recordCheck(fixture({ allowed: true }));
    recordCheck(fixture({ allowed: false, certain: true }));
    const text = renderPrometheusText();
    expect(metricValue(text, 'authz_checks_total', '{allowed="true"}')).toBe(2);
    expect(metricValue(text, 'authz_checks_total', '{allowed="false"}')).toBe(1);
  });
});

describe('recordCheck — authz_leopard_index_hits_total', () => {
  it('counts only when indexHit is exactly true', () => {
    recordCheck(fixture({ indexHit: true }));
    recordCheck(fixture()); // indexHit absent — the real "miss or never consulted" shape, see registry.ts's own doc comment
    const text = renderPrometheusText();
    expect(metricValue(text, 'authz_leopard_index_hits_total')).toBe(1);
  });
});

describe('recordCheck — authz_uncertain_checks_total', () => {
  it('does not count a denied result with certain: true (exhaustively proven false)', () => {
    recordCheck(fixture({ allowed: false, certain: true }));
    expect(metricValue(renderPrometheusText(), 'authz_uncertain_checks_total')).toBe(0);
  });

  it('counts a denied result with certain: false — the depth-ceiling/cycle-guard fail-closed case', () => {
    recordCheck(fixture({ allowed: false, certain: false }));
    expect(metricValue(renderPrometheusText(), 'authz_uncertain_checks_total')).toBe(1);
  });

  it("counts a denied result with certain entirely absent — the safe, honest direction on ambiguity, matching authz check --path's own identical choice", () => {
    recordCheck(fixture({ allowed: false }));
    expect(metricValue(renderPrometheusText(), 'authz_uncertain_checks_total')).toBe(1);
  });

  it(
    'never counts an ALLOWED result, regardless of certain — a real bug caught live: certain is ' +
      "present if and only if allowed is false (ProductionCheckResult's own doc contract), so an " +
      'earlier draft checking `certain !== true` unconditionally counted every allowed check as ' +
      'uncertain too, since certain is always undefined on an allowed result',
    () => {
      recordCheck(fixture({ allowed: true })); // certain absent, exactly as real allowed results always are
      recordCheck(fixture({ allowed: true, certain: true }));
      expect(metricValue(renderPrometheusText(), 'authz_uncertain_checks_total')).toBe(0);
    },
  );
});

describe('recordCacheHit / recordCacheMiss', () => {
  it('are independent counters from recordCheck — calling recordCheck alone moves neither', () => {
    recordCheck(fixture());
    const text = renderPrometheusText();
    expect(metricValue(text, 'authz_check_cache_hits_total')).toBe(0);
    expect(metricValue(text, 'authz_check_cache_misses_total')).toBe(0);
  });

  it('accumulate independently of each other and of authz_checks_total', () => {
    recordCacheHit();
    recordCacheHit();
    recordCacheMiss();
    recordCheck(fixture());
    const text = renderPrometheusText();
    expect(metricValue(text, 'authz_check_cache_hits_total')).toBe(2);
    expect(metricValue(text, 'authz_check_cache_misses_total')).toBe(1);
    expect(metricValue(text, 'authz_checks_total', '{allowed="true"}')).toBe(1);
  });
});

describe('resetMetricsForTest', () => {
  it('zeroes every counter, not just some of them', () => {
    recordCheck(fixture({ allowed: false, certain: false, indexHit: true }));
    recordCacheHit();
    recordCacheMiss();
    resetMetricsForTest();
    const text = renderPrometheusText();
    expect(metricValue(text, 'authz_checks_total', '{allowed="true"}')).toBe(0);
    expect(metricValue(text, 'authz_checks_total', '{allowed="false"}')).toBe(0);
    expect(metricValue(text, 'authz_check_cache_hits_total')).toBe(0);
    expect(metricValue(text, 'authz_check_cache_misses_total')).toBe(0);
    expect(metricValue(text, 'authz_leopard_index_hits_total')).toBe(0);
    expect(metricValue(text, 'authz_uncertain_checks_total')).toBe(0);
  });
});
