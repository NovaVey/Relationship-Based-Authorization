/**
 * `authz soundness run` — build spec §7: `authz soundness run [--queries N]
 * [--seed S]`. Runs Phase 5's differential fuzz (`src/soundness/runner.ts`)
 * for real against a real Postgres, prints a summary, and persists the
 * full result as a `soundness_runs` row (already done inside
 * `runSoundnessFuzz` itself — this file's own job is argument parsing,
 * printing, and mapping the result onto §7's exit-code table).
 *
 * `--seed` falls back to `env.SOUNDNESS_FUZZ_SEED` when omitted, and only
 * then to a fresh random seed (`runSoundnessFuzz`'s own default) — so a
 * CI run can pin a seed via env without every local run needing to spell
 * `--seed` out, while a bare `authz soundness run` with neither set still
 * gets a real fuzz run, never a silent no-op.
 *
 * Exit codes, per §7's table (distinct from `check`/`tuple`'s own table —
 * this command's `1` and `2` mean something specific to a soundness
 * verdict, not a generic validation/audit failure):
 *   0  verdict `sound`
 *   1  verdict `unsound` — at least one `false_grant` (§6.5: always
 *      blocking, regardless of aggregate rate or critical-namespace status)
 *   2  verdict `insufficient_coverage`, or a malformed `--queries`/`--seed`
 *      argument, or the generated fixture itself failed to compile/publish
 *      (a generator bug, not a resolver finding — see `runner.ts`)
 *   3  infrastructure failure (DB unreachable, etc.)
 */
import { runSoundnessFuzz } from '../../soundness/runner.js';
import { getPool, closePool } from '../../store/client.js';
import { env } from '../../config/env.js';

export interface SoundnessRunCliOptions {
  queries?: string;
  seed?: string;
}

export async function soundnessRun(options: SoundnessRunCliOptions): Promise<void> {
  let queryCount: number | undefined;
  if (options.queries !== undefined) {
    queryCount = Number(options.queries);
    if (!Number.isInteger(queryCount) || queryCount <= 0) {
      console.error(`invalid --queries '${options.queries}' — must be a positive integer`);
      process.exitCode = 2;
      return;
    }
  }

  const seed = options.seed ?? env.SOUNDNESS_FUZZ_SEED;

  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  try {
    const result = await runSoundnessFuzz(pool, {
      trigger: 'cli',
      ...(seed !== undefined ? { seed } : {}),
      ...(queryCount !== undefined ? { queryCount } : {}),
    });

    console.log(
      `soundness run ${result.id} (seed=${result.graphSeed}): ${result.verdict.toUpperCase()}`,
    );
    console.log(
      `  namespaces: ${result.namespaceCount}  tuples: ${result.tupleCount}  queries: ${result.queryCount}`,
    );
    console.log(
      `  false_grant: ${result.falseGrantCount} (critical: ${result.criticalNamespaceFalseGrants})  false_deny: ${result.falseDenyCount}`,
    );
    if (result.divergences.length > 0) {
      console.log(`  divergences:`);
      for (const d of result.divergences) {
        console.log(
          `    [${d.kind}${d.critical ? ', critical' : ''}] ` +
            `${d.query.subject.ns}:${d.query.subject.id} ${d.query.relationOrPermission} ` +
            `${d.query.object.ns}:${d.query.object.id} — expected ${d.expected}, got ${d.actual}`,
        );
      }
    }

    if (result.verdict === 'unsound') {
      process.exitCode = 1;
    } else if (result.verdict === 'insufficient_coverage') {
      process.exitCode = 2;
    }
    // 'sound' leaves process.exitCode unset, i.e. 0.
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}
