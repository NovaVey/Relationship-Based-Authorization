#!/usr/bin/env -S npx tsx
/**
 * The harness's orchestrator and CLI entry point (`npm run bench:<engine>`,
 * or directly: `npx tsx src/runner.ts --engine authz,openfga,spicedb`).
 *
 * For each requested engine, in order:
 *   1. `init()` — a fresh, isolated store/model/namespace-set for this run.
 *   2. `loadSchema()` — the translated org/group/folder/document demo
 *      plus the bench_node depth-chain type (see workloads/, types.ts).
 *   3. **Cross-validation**: write the real demo graph
 *      (`workload.exampleGraphWorkload()`), then run its 8 canonical
 *      checks and confirm the engine's answer matches the expected
 *      ALLOWED/DENIED this repo's own README already documents for that
 *      exact graph. This is a CORRECTNESS gate, not a performance
 *      number — a latency table from an engine that disagreed with the
 *      other two about what the graph even means would be worthless, so
 *      this runs first and its result is reported plainly either way.
 *   4. **Depth-latency benchmark**: `workload.depthChainWorkload()` at
 *      the requested depths/runsPerDepth, each case a distinct, freshly
 *      written chain (see that function's own doc comment for why),
 *      checked once, latency recorded.
 *   5. **Consistency probe**: `runConsistencyProbe()` below — write a
 *      fresh grant, then poll with each engine's own DEFAULT (not
 *      strongest) consistency setting until the check reflects it,
 *      timing how long that takes. See docs/BENCHMARK-PROPOSAL.md's
 *      "Metric 2" section for what this does and doesn't show.
 *
 * Every raw number (not just the printed summary) is written to
 * `results/<timestamp>-<engines>.json` — the "raw data available, not
 * just a summary chart" bar the design doc holds a citable result to.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { AuthzAdapter } from './adapters/authz-adapter.js';
import { OpenfgaAdapter } from './adapters/openfga-adapter.js';
import { SpicedbAdapter } from './adapters/spicedb-adapter.js';
import { depthChainWorkload, exampleGraphWorkload } from './workload.js';
import { summarize, type LatencySummary } from './stats.js';
import { markdownCrossValidationTable, markdownDepthTable } from './report.js';
import type { CanonicalCheckQuery, EngineAdapter } from './types.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(moduleDir, '../results');

interface Args {
  engines: readonly string[];
  depths: readonly number[];
  runsPerDepth: number;
  seed: number;
  consistencyTrials: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx === -1 ? undefined : argv[idx + 1];
  };
  const engines = (get('--engine') ?? 'authz,openfga,spicedb').split(',').map((s) => s.trim());
  const depths = (get('--depths') ?? '1,3,5,10').split(',').map((s) => Number(s.trim()));
  const runsPerDepth = Number(get('--runs-per-depth') ?? '30');
  const seed = Number(get('--seed') ?? '42');
  const consistencyTrials = Number(get('--consistency-trials') ?? '5');
  return { engines, depths, runsPerDepth, seed, consistencyTrials };
}

function buildAdapter(name: string): EngineAdapter {
  switch (name) {
    case 'authz':
      return new AuthzAdapter({
        baseUrl: process.env.AUTHZ_BASE_URL ?? 'http://localhost:3001',
        adminApiKey: process.env.AUTHZ_ADMIN_API_KEY ?? 'benchmark-admin-key-0123456789-abcdefghijklmnop',
      });
    case 'openfga':
      return new OpenfgaAdapter({ apiUrl: process.env.OPENFGA_API_URL ?? 'http://localhost:8080' });
    case 'spicedb':
      return new SpicedbAdapter({
        endpoint: process.env.SPICEDB_ENDPOINT ?? 'localhost:50051',
        presharedKey: process.env.SPICEDB_PSK ?? 'benchmark-psk',
      });
    default:
      throw new Error(`unknown engine '${name}' — expected one of authz, openfga, spicedb`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HasDefaultConsistencyCheck {
  checkDefaultConsistency(q: CanonicalCheckQuery): Promise<boolean>;
}

function hasDefaultConsistencyCheck(adapter: EngineAdapter): adapter is EngineAdapter & HasDefaultConsistencyCheck {
  return typeof (adapter as Partial<HasDefaultConsistencyCheck>).checkDefaultConsistency === 'function';
}

/**
 * Writes one fresh grant, then polls — at the engine's own DEFAULT
 * consistency setting, never the strongest one `check()` otherwise
 * always uses — until the check reflects it. Returns the elapsed
 * milliseconds, or `-1` on timeout (the grant never became visible
 * within `timeoutMs`, which would itself be a significant, reportable
 * finding, not just a discarded data point).
 */
async function timeToConsistentRead(
  adapter: EngineAdapter,
  trialId: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<number> {
  const objectId = `probe_${trialId}`;
  const subjectId = `probe_subject_${trialId}`;
  await adapter.writeTuple({
    objectType: 'bench_node',
    objectId,
    relation: 'viewer',
    subject: { type: 'user', id: subjectId },
  });
  const query: CanonicalCheckQuery = {
    subject: { type: 'user', id: subjectId },
    permission: 'view',
    objectType: 'bench_node',
    objectId,
  };
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const allowed = hasDefaultConsistencyCheck(adapter)
      ? await adapter.checkDefaultConsistency(query)
      : (await adapter.check(query)).allowed;
    if (allowed) return performance.now() - start;
    await sleep(intervalMs);
  }
  return -1;
}

async function runConsistencyProbe(
  adapter: EngineAdapter,
  seed: number,
  trials: number,
): Promise<{ trialMs: number[]; timeouts: number }> {
  const trialMs: number[] = [];
  let timeouts = 0;
  for (let i = 0; i < trials; i++) {
    const elapsed = await timeToConsistentRead(adapter, `${seed}_${i}_${Date.now().toString(36)}`, 5, 8000);
    if (elapsed < 0) timeouts++;
    else trialMs.push(elapsed);
  }
  return { trialMs, timeouts };
}

interface EngineResult {
  engine: string;
  crossValidation: { note: string; expected: boolean; actual: boolean | 'ERROR' }[];
  crossValidationAllPass: boolean;
  depthLatenciesMs: Record<number, number[]>;
  depthSummary: { depth: number; summary: LatencySummary }[];
  consistencyProbe: { trialMs: number[]; timeouts: number };
  errors: string[];
}

async function runEngine(name: string, args: Args): Promise<EngineResult> {
  const errors: string[] = [];
  const adapter = buildAdapter(name);
  const result: EngineResult = {
    engine: name,
    crossValidation: [],
    crossValidationAllPass: true,
    depthLatenciesMs: {},
    depthSummary: [],
    consistencyProbe: { trialMs: [], timeouts: 0 },
    errors,
  };

  console.log(`\n=== ${name} ===`);
  await adapter.init();
  await adapter.loadSchema();

  // --- Cross-validation ---
  const example = exampleGraphWorkload();
  for (const tuple of example.tuples) {
    await adapter.writeTuple(tuple);
  }
  for (const { query, expected, note } of example.checks) {
    try {
      const { allowed } = await adapter.check(query);
      result.crossValidation.push({ note, expected, actual: allowed });
      if (allowed !== expected) result.crossValidationAllPass = false;
    } catch (err) {
      result.crossValidation.push({ note, expected, actual: 'ERROR' });
      result.crossValidationAllPass = false;
      errors.push(`cross-validation '${note}': ${(err as Error).message}`);
    }
  }
  console.log(markdownCrossValidationTable(result.crossValidation.map((r) => ({ engine: name, ...r }))));

  // --- Depth-latency benchmark ---
  const cases = depthChainWorkload(args.seed, args.depths, args.runsPerDepth);
  for (const depth of args.depths) result.depthLatenciesMs[depth] = [];
  for (const c of cases) {
    for (const tuple of c.tuples) {
      await adapter.writeTuple(tuple);
    }
    try {
      const { allowed, latencyMs } = await adapter.check(c.check);
      if (!allowed) {
        errors.push(`depth ${c.depth} case ${c.runId}: expected ALLOWED, got DENIED`);
      }
      result.depthLatenciesMs[c.depth]!.push(latencyMs);
    } catch (err) {
      errors.push(`depth ${c.depth} case ${c.runId}: ${(err as Error).message}`);
    }
  }
  for (const depth of args.depths) {
    const summary = summarize(result.depthLatenciesMs[depth]!);
    result.depthSummary.push({ depth, summary });
  }
  console.log(markdownDepthTable(result.depthSummary.map((r) => ({ engine: name, ...r }))));

  // --- Consistency probe ---
  result.consistencyProbe = await runConsistencyProbe(adapter, args.seed, args.consistencyTrials);
  const { trialMs, timeouts } = result.consistencyProbe;
  const trialsDesc = trialMs.map((ms) => `${ms.toFixed(1)}ms`).join(', ');
  console.log(
    `consistency probe (default consistency, ${args.consistencyTrials} trials): ${trialsDesc}` +
      (timeouts > 0 ? ` (${timeouts} timed out at 8000ms)` : ''),
  );

  if (errors.length > 0) {
    console.error(`${name}: ${errors.length} error(s) during this run:`);
    for (const e of errors) console.error(`  - ${e}`);
  }

  await adapter.close();
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `rebac-benchmark: engines=${args.engines.join(',')} depths=${args.depths.join(',')} ` +
      `runsPerDepth=${args.runsPerDepth} seed=${args.seed}`,
  );

  const results: EngineResult[] = [];
  for (const engine of args.engines) {
    results.push(await runEngine(engine, args));
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, `${Date.now()}-${args.engines.join('_')}.json`);
  writeFileSync(
    outPath,
    JSON.stringify({ args, results, generatedAt: new Date().toISOString() }, null, 2),
  );
  console.log(`\nraw results written to ${outPath}`);

  if (args.engines.length > 1) {
    console.log('\n=== Combined depth-latency table ===');
    const combined = results.flatMap((r) => r.depthSummary.map((d) => ({ engine: r.engine, ...d })));
    console.log(markdownDepthTable(combined));
  }

  const anyFailedCrossValidation = results.some((r) => !r.crossValidationAllPass);
  const anyErrors = results.some((r) => r.errors.length > 0);
  if (anyFailedCrossValidation || anyErrors) {
    process.exitCode = 1;
  }
}

await main();
