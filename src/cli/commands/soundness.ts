/**
 * `authz soundness run` — build spec §7: `authz soundness run [--queries N]
 * [--seed S] [--format text|markdown|json]`. Runs Phase 5's differential
 * fuzz (`src/soundness/runner.ts`) for real against a real Postgres, prints
 * a report, and persists the full result as a `soundness_runs` row (already
 * done inside `runSoundnessFuzz` itself — this file's own job is argument
 * parsing, rendering, and mapping the result onto §7's exit-code table).
 *
 * `--seed` falls back to `env.SOUNDNESS_FUZZ_SEED` when omitted, and only
 * then to a fresh random seed (`runSoundnessFuzz`'s own default) — so a
 * CI run can pin a seed via env without every local run needing to spell
 * `--seed` out, while a bare `authz soundness run` with neither set still
 * gets a real fuzz run, never a silent no-op.
 *
 * `--format` (default `text`): `text` is this command's own original,
 * human-skimmable summary (unchanged from Phase 5); `markdown` prints
 * *only* `src/report/markdown.ts`'s `renderSoundnessMarkdown` output — the
 * exact document `.github/workflows/soundness.yml` (Phase 7) captures
 * verbatim as a PR comment body, so stdout must be the report and nothing
 * else in this mode; `json` prints *only* `src/report/json.ts`'s
 * `renderSoundnessJsonString` output, for the same reason. The verdict and
 * exit-code mapping are identical across all three formats — `--format`
 * changes what's printed, never what's computed or persisted.
 *
 * `--dry-run` (D-063, closing `docs/DECISIONS.md` D-060's own "revisit
 * if"): runs the exact same real differential fuzz — real schema publish,
 * real tuple writes, real checks against both resolvers, the exact same
 * verdict — then deletes every row it created before returning, so
 * whatever database `DATABASE_URL` points at ends the call in exactly the
 * state it started in. Intended for local exploration (see the README's
 * own "try it yourself" walkthrough, which uses it) where the point is
 * "prove the claim," not "leave a permanent record" — CI never needs it,
 * since `.github/workflows/soundness.yml` already runs against its own
 * ephemeral, per-job Postgres (D-045). Only affects `--format text`'s
 * extra note below; `markdown`/`json` output is untouched either way,
 * since both modes' own contract is "stdout is the report and nothing
 * else."
 *
 * Exit codes, per §7's table (distinct from `check`/`tuple`'s own table —
 * this command's `1` and `2` mean something specific to a soundness
 * verdict, not a generic validation/audit failure):
 *   0  verdict `sound`
 *   1  verdict `unsound` — at least one `false_grant` (§6.5: always
 *      blocking, regardless of aggregate rate or critical-namespace status)
 *   2  verdict `insufficient_coverage`, or a malformed `--queries`/`--seed`/
 *      `--format` argument, or the generated fixture itself failed to
 *      compile/publish (a generator bug, not a resolver finding — see
 *      `runner.ts`)
 *   3  infrastructure failure (DB unreachable, etc.)
 */
import { runSoundnessFuzz, type SoundnessRunResult } from '../../soundness/runner.js';
import { getPool, closePool } from '../../store/client.js';
import { env } from '../../config/env.js';
import { renderSoundnessMarkdown } from '../../report/markdown.js';
import { renderSoundnessJsonString } from '../../report/json.js';
import { soundnessExitCode } from '../../report/exitCodes.js';

export interface SoundnessRunCliOptions {
  queries?: string;
  seed?: string;
  format?: string;
  dryRun?: boolean;
}

const VALID_FORMATS = ['text', 'markdown', 'json'] as const;
type Format = (typeof VALID_FORMATS)[number];

function isValidFormat(f: string): f is Format {
  return (VALID_FORMATS as readonly string[]).includes(f);
}

/**
 * The original Phase 5 human-skimmable summary — `--format text` (the
 * default). `dryRun` adds one honest line stating plainly that nothing
 * was persisted — never silently omitted, per this project's own
 * discipline against letting a material fact go unstated. Every other
 * line is byte-for-byte unchanged from before `--dry-run` existed.
 */
function printText(result: SoundnessRunResult, dryRun: boolean): void {
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
  if (dryRun) {
    console.log(
      `  (dry run — the generated schema, tuples, and this run's own record were deleted; nothing was left in the database)`,
    );
  }
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

  const formatRaw = options.format ?? 'text';
  if (!isValidFormat(formatRaw)) {
    console.error(`invalid --format '${formatRaw}' — must be one of: ${VALID_FORMATS.join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const format = formatRaw;

  const seed = options.seed ?? env.SOUNDNESS_FUZZ_SEED;

  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const dryRun = options.dryRun ?? false;

  const pool = getPool();
  try {
    const result = await runSoundnessFuzz(pool, {
      trigger: 'cli',
      dryRun,
      ...(seed !== undefined ? { seed } : {}),
      ...(queryCount !== undefined ? { queryCount } : {}),
    });

    if (format === 'markdown') {
      console.log(renderSoundnessMarkdown(result));
    } else if (format === 'json') {
      console.log(renderSoundnessJsonString(result));
    } else {
      printText(result, dryRun);
    }

    const exitCode = soundnessExitCode(result.verdict);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    // exit code 0 ('sound') leaves process.exitCode unset.
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}
