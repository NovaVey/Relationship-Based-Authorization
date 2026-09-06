/**
 * `GET /metrics`'s own backing store — closes the "no Prometheus endpoint"
 * gap `docs/CAPABILITY-GAPS.md`'s "Metrics" section named. Every counter
 * here surfaces data this codebase already computes per-check but used to
 * discard the instant `performCheck` returned (see that file's own
 * `recordCheck` call sites) — this module adds no new computation to the
 * check path itself, only a place for the existing numbers to accumulate.
 *
 * A single in-process, module-level singleton — the same pattern
 * `src/store/client.ts`'s `getPool()` already establishes for this
 * codebase's one other piece of genuinely process-lifetime state.
 * Cumulative since process start, by design: Prometheus's own `rate()`/
 * `increase()` functions are built to difference two samples of a
 * monotonically-increasing counter, not to read an absolute snapshot, so a
 * restart-then-reset-to-zero is the expected, correct behavior — never
 * reset outside of `resetMetricsForTest`, which exists only so
 * `test/unit/metrics/registry.test.ts` can assert against a known starting
 * state.
 *
 * **Deliberately not a full Prometheus client library (`prom-client` or
 * similar) — a real, disclosed scope decision, not an oversight.** This
 * repo's own `docs/CAPABILITY-GAPS.md` asked for exactly the counter
 * families below; a full client library's histogram/summary/label-
 * cardinality machinery would be genuine, unused surface area for a first
 * cut. Revisit if a real latency histogram (the "check latency by depth"
 * half of that same capability-gap paragraph, deliberately NOT attempted
 * here) is ever added — that's the point where a hand-rolled histogram
 * stops being worth maintaining over a real library's.
 *
 * **Two things this doesn't cover, disclosed rather than silently
 * narrowed:**
 *
 * 1. "indexQueriesHit versus fallbacks" (`docs/CAPABILITY-GAPS.md`'s own
 *    phrasing) only gets the hit half here, not a fallback counter.
 *    `ProductionCheckResult.indexHit` (`src/resolve/production/
 *    resolver.ts`) is present if and only if the index actually hit — a
 *    miss and "the index was never consulted at all" (disabled via
 *    `LEOPARD_INDEX_ENABLED`, or a non-pinned check the index's own Phase A
 *    scope excludes) are both the identical `undefined`, by that field's
 *    own deliberate design (see its doc comment). Distinguishing them
 *    would mean widening that soundness-critical resolver's own return-
 *    shape contract for an observability nice-to-have — out of scope for
 *    this change; `authz_leopard_index_hits_total` alone (real, always
 *    correct) is what ships here.
 *
 * 2. "A depth-ceiling-hit and cycle-guard-hit counter" (same source
 *    paragraph) ships as a single combined `authz_uncertain_checks_total`,
 *    not two separate counters — checked directly against the actual
 *    types involved, not assumed possible: `ProductionCheckResult`
 *    (`resolver.ts`) exposes only `certain?: boolean`, never the
 *    `DisproofStep` tree that would be needed to tell a `boundReached`
 *    leaf's own `reason: 'cycle' | 'depth'` apart — that tree lives only
 *    on the internal, non-exported `ProductionOutcome` recursion, one
 *    level further in than this function's own caller (`performCheck`,
 *    `src/audit/checks.ts`) can see. This is not a gap this change
 *    introduces: the CLI's own existing user-facing message for exactly
 *    this case (`src/cli/commands/check.ts`) already says "hit depth/cycle
 *    limit" without distinguishing which — this counter matches that
 *    already-established precedent rather than inventing a granularity
 *    the rest of the codebase doesn't expose either. Splitting it for real
 *    would mean widening `ProductionCheckResult`'s own contract, the exact
 *    kind of soundness-adjacent change this repo's own "design → review →
 *    implement" discipline treats as its own dedicated piece of work, not
 *    a rider on a metrics endpoint.
 */
import type { ProductionCheckResult } from '../resolve/production/resolver.js';

interface MetricsState {
  checksAllowedTotal: number;
  checksDeniedTotal: number;
  checkCacheHitsTotal: number;
  checkCacheMissesTotal: number;
  leopardIndexHitsTotal: number;
  uncertainChecksTotal: number;
}

function freshState(): MetricsState {
  return {
    checksAllowedTotal: 0,
    checksDeniedTotal: 0,
    checkCacheHitsTotal: 0,
    checkCacheMissesTotal: 0,
    leopardIndexHitsTotal: 0,
    uncertainChecksTotal: 0,
  };
}

let state = freshState();

/** Test-only reset — see this file's own top-of-file doc comment for why a real deployment never calls this. */
export function resetMetricsForTest(): void {
  state = freshState();
}

export function recordCacheHit(): void {
  state.checkCacheHitsTotal += 1;
}

export function recordCacheMiss(): void {
  state.checkCacheMissesTotal += 1;
}

/**
 * The one call site every real check (cache hit or miss alike) should
 * reach — see `src/audit/checks.ts`'s `performCheck`, the identical
 * "every check funnels through exactly one place" discipline that
 * function's own doc comment already establishes for the audit log.
 */
export function recordCheck(result: ProductionCheckResult): void {
  if (result.allowed) {
    state.checksAllowedTotal += 1;
  } else {
    state.checksDeniedTotal += 1;
  }

  if (result.indexHit === true) {
    state.leopardIndexHitsTotal += 1;
  }

  // `certain` (`ProductionCheckResult`'s own doc comment) is present if and
  // only if `allowed` is false — an allowed result is always a genuine,
  // positively-verified proof, never itself "uncertain" in this resolver's
  // vocabulary, so `certain` is always `undefined` there and carries no
  // signal at all. Confirmed live, not just read off the doc comment: an
  // early draft of this function checked `result.certain !== true`
  // unconditionally, which — because of exactly that "present iff denied"
  // contract — counted every single ALLOWED check as uncertain too, making
  // this counter meaningless the moment it was exercised against a real
  // server. Gated on `!result.allowed` here specifically to close that.
  //
  // A security-relevant signal since D-158/D-159 once correctly scoped to
  // denials: this fails closed (a deny), so a spike means real users may be
  // silently losing access to something a larger CHECK_MAX_DEPTH or a
  // less-cyclic schema would actually grant. `certain !== true` (not
  // `=== false`) on a denial is the same safe, honest direction on
  // ambiguity `src/cli/commands/check.ts`'s own `DENIED (inconclusive...)`
  // message already applies — never silently claim a denial was exhaustively
  // proven when this field didn't actually confirm that.
  if (!result.allowed && result.certain !== true) {
    state.uncertainChecksTotal += 1;
  }
}

interface PrometheusMetric {
  name: string;
  help: string;
  type: 'counter';
  /** `[labels, value][]` — a bare `value` alone (no labels) renders as `name value`, matching a Prometheus metric with no label dimension. */
  samples: Array<[Record<string, string>, number]>;
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
}

function renderMetric(metric: PrometheusMetric): string {
  const lines = [`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`];
  for (const [labels, value] of metric.samples) {
    lines.push(`${metric.name}${formatLabels(labels)} ${value}`);
  }
  return lines.join('\n');
}

/**
 * Prometheus text exposition format (the `# HELP`/`# TYPE`/`name{labels}
 * value` shape every `/metrics` scraper — Prometheus itself, Grafana
 * Agent, OpenTelemetry's own Prometheus receiver — already knows how to
 * parse), version 0.0.4, the same version `GET /metrics`'s own
 * `Content-Type` response header names.
 */
export function renderPrometheusText(): string {
  const metrics: PrometheusMetric[] = [
    {
      name: 'authz_checks_total',
      help: 'Total permission checks performed, by outcome.',
      type: 'counter',
      samples: [
        [{ allowed: 'true' }, state.checksAllowedTotal],
        [{ allowed: 'false' }, state.checksDeniedTotal],
      ],
    },
    {
      name: 'authz_check_cache_hits_total',
      help: 'Check-result cache hits (CHECK_CACHE_TTL_MS > 0 only — always 0 with caching disabled).',
      type: 'counter',
      samples: [[{}, state.checkCacheHitsTotal]],
    },
    {
      name: 'authz_check_cache_misses_total',
      help: 'Check-result cache misses (CHECK_CACHE_TTL_MS > 0 only — always 0 with caching disabled).',
      type: 'counter',
      samples: [[{}, state.checkCacheMissesTotal]],
    },
    {
      name: 'authz_leopard_index_hits_total',
      help: "Checks answered by the Leopard index (see docs/LEOPARD-INDEX-PROPOSAL.md) without a live graph walk. A miss falls through unmodified and is not separately counted here — see this module's own top-of-file doc comment for why.",
      type: 'counter',
      samples: [[{}, state.leopardIndexHitsTotal]],
    },
    {
      name: 'authz_uncertain_checks_total',
      help: "Checks where the depth ceiling or the cycle guard truncated the walk before it could be exhaustively proven or disproven (certain: false) — a fail-closed deny since D-158/D-159. A spike means real users may be silently losing access. Combines depth-ceiling and cycle-guard hits into one counter — see this module's own top-of-file doc comment for why they cannot be split apart here.",
      type: 'counter',
      samples: [[{}, state.uncertainChecksTotal]],
    },
  ];
  return metrics.map(renderMetric).join('\n\n') + '\n';
}
