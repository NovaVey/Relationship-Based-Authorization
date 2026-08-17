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
 * `--progress <n>` (D-090): prints `  checked X/Y queries` to **stderr**
 * every `n` completed queries, plus once more on the final batch regardless
 * of whether `n` evenly divides the total — see `createProgressReporter`
 * (`src/report/progress.ts`) for the cadence logic and
 * `SoundnessRunOptions.onProgress` (`src/soundness/runner.ts`) for how it's
 * threaded into the actual check loop. Omit for today's exact behavior —
 * no progress output at all, unchanged since before this option existed.
 * Always stderr, in every `--format`, including `markdown`/`json` — never
 * stdout, which those two formats' own contract (this comment, just above)
 * requires stay exactly the report and nothing else.
 *
 * Exit codes, per §7's table (distinct from `check`/`tuple`'s own table —
 * this command's `1` and `2` mean something specific to a soundness
 * verdict, not a generic validation/audit failure):
 *   0  verdict `sound`
 *   1  verdict `unsound` — at least one `false_grant` (§6.5: always
 *      blocking, regardless of aggregate rate or critical-namespace status)
 *   2  verdict `insufficient_coverage`, a malformed `--queries`/`--format`/
 *      `--progress` argument (`--seed` accepts any string, including empty
 *      — it is never itself "malformed"; full-repo audit finding #15, LOW,
 *      2026-08-16), or `runSoundnessFuzz` threw a
 *      `SoundnessFixtureError` — the generated fixture itself failed to
 *      compile/publish/write (a generator bug, not a resolver finding —
 *      see `runner.ts`). **Implemented by an `instanceof
 *      SoundnessFixtureError` check in the `catch` block below** (full-repo
 *      audit finding #12, MEDIUM, 2026-08-16 — before this class existed,
 *      every thrown error, fixture bug or not, fell into the exit-code-3
 *      branch below; see `docs/DECISIONS.md`).
 *   3  infrastructure failure (DB unreachable, an unexpected
 *      `soundness_runs` insert response, etc.) — any `runSoundnessFuzz`
 *      throw that is *not* a `SoundnessFixtureError`.
 *
 * **Exit codes 2 and 3 each still print a stdout report for
 * `markdown`/`json`, never a silent, empty stdout — but never each
 * other's.** `.github/workflows/soundness.yml` captures this command's
 * stdout verbatim into `soundness-report.md`, which
 * `scripts/post-soundness-comment.mjs` posts — or PATCHes the existing
 * tracked comment to, unconditionally — as the literal PR-comment body.
 * Every place this function can reach exit code 3 (the `DATABASE_URL`-
 * missing early return, and a non-fixture throw from the `try` block below)
 * goes through `printInfrastructureFailure`, which prints
 * `renderSoundnessInfrastructureFailureMarkdown`/
 * `renderSoundnessInfrastructureFailureJsonString` — framed as a database
 * problem, `"Postgres: <message>"` on stderr included. A
 * `SoundnessFixtureError` instead goes through `printFixtureFailure`,
 * which prints `renderSoundnessFixtureFailureMarkdown`/
 * `renderSoundnessFixtureFailureJsonString` — deliberately *never* that
 * `"Postgres: "` framing, since the fixture generator, not the database,
 * is what actually failed. Neither path ever leaves `soundness-report.md`
 * a 0-byte file, which would either post a blank PR comment or silently
 * blank out the last known-good, already-tracked one via PATCH.
 * `--format text` is unaffected either way: its existing
 * `console.error`-only behavior already surfaces the failure where a human
 * running the CLI directly actually looks (stderr), and nothing in this
 * repository captures its stdout as a report body the way the workflow
 * does for `markdown`.
 */
import {
  runSoundnessFuzz,
  SoundnessFixtureError,
  type SoundnessRunResult,
} from '../../soundness/runner.js';
import { getPool, closePool } from '../../store/client.js';
import { env } from '../../config/env.js';
import {
  renderSoundnessMarkdown,
  renderSoundnessInfrastructureFailureMarkdown,
  renderSoundnessFixtureFailureMarkdown,
} from '../../report/markdown.js';
import {
  renderSoundnessJsonString,
  renderSoundnessInfrastructureFailureJsonString,
  renderSoundnessFixtureFailureJsonString,
} from '../../report/json.js';
import { soundnessExitCode } from '../../report/exitCodes.js';
import { createProgressReporter } from '../../report/progress.js';

export interface SoundnessRunCliOptions {
  queries?: string;
  seed?: string;
  format?: string;
  dryRun?: boolean;
  /** See `--progress`'s own validation below and `createProgressReporter` (`src/report/progress.ts`). */
  progress?: string;
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

/**
 * The exit-code-3 ("infrastructure failure") counterpart to `printText` —
 * called from both places `soundnessRun` can reach that exit code: the
 * `DATABASE_URL`-missing early return below, and the `catch` block wrapping
 * `runSoundnessFuzz`. Always logs the real error text to stderr (unchanged
 * from this command's original, pre-existing behavior, and the only output
 * `--format text` ever gets for this case); additionally prints an honest
 * stdout report for `markdown`/`json` specifically, because those two
 * formats' own contract — stated in this file's own top-of-file doc
 * comment — is "stdout is the report and nothing else," and
 * `.github/workflows/soundness.yml` depends on `markdown`'s stdout being
 * exactly that, never empty. See `renderSoundnessInfrastructureFailureMarkdown`/
 * `renderSoundnessInfrastructureFailureJsonString` (`src/report/markdown.ts`,
 * `src/report/json.ts`) for why each is shaped the way it is.
 */
function printInfrastructureFailure(format: Format, message: string): void {
  if (format === 'markdown') {
    console.log(renderSoundnessInfrastructureFailureMarkdown(message));
  } else if (format === 'json') {
    console.log(renderSoundnessInfrastructureFailureJsonString(message));
  }
  console.error(`Postgres: ${message}`);
}

/**
 * The exit-code-2 ("fixture failure") counterpart to
 * `printInfrastructureFailure`, called only when `runSoundnessFuzz` threw a
 * `SoundnessFixtureError` — the generated fuzz fixture itself was invalid
 * (a schema compile, publish, or tuple-write failure), never a database
 * problem (full-repo audit finding #12, MEDIUM, 2026-08-16 — see
 * `docs/DECISIONS.md`). Deliberately does **not** reuse
 * `printInfrastructureFailure`: that function's own `"Postgres: "` stderr
 * prefix and its `renderSoundnessInfrastructureFailureMarkdown`/`Json`
 * calls both actively mislead a reader into thinking Postgres is the
 * problem, which is exactly the mislabeling this finding named. Same
 * "stdout is the report and nothing else" contract for `markdown`/`json`
 * as its sibling — see that function's own doc comment.
 */
function printFixtureFailure(format: Format, message: string): void {
  if (format === 'markdown') {
    console.log(renderSoundnessFixtureFailureMarkdown(message));
  } else if (format === 'json') {
    console.log(renderSoundnessFixtureFailureJsonString(message));
  }
  console.error(message);
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

  // Omit `--progress` entirely for today's exact behavior (no stderr
  // output during the run at all) — `onProgress` below stays `undefined`,
  // and `checkAllQueries` (`src/soundness/runner.ts`) skips the callback
  // entirely in that case. Always stderr, via `createProgressReporter`
  // (`src/report/progress.ts`), never stdout — see that file's own doc
  // comment on why `--format markdown`/`json`'s "stdout is the report and
  // nothing else" contract makes that non-negotiable.
  let onProgress: ((completed: number, total: number) => void) | undefined;
  if (options.progress !== undefined) {
    const every = Number(options.progress);
    if (!Number.isInteger(every) || every <= 0) {
      console.error(`invalid --progress '${options.progress}' — must be a positive integer`);
      process.exitCode = 2;
      return;
    }
    onProgress = createProgressReporter(every, (line) => process.stderr.write(line));
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
    printInfrastructureFailure(format, 'DATABASE_URL is not set — see .env.example.');
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
      ...(onProgress !== undefined ? { onProgress } : {}),
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
    // `SoundnessFixtureError` (`src/soundness/runner.ts`) is thrown only
    // when the generated fuzz fixture itself was invalid — a generator
    // bug, per build spec §7's exit-code-2 bucket ("insufficient fuzz
    // coverage or a schema/tuple validation failure"), never the
    // exit-code-3 "infrastructure failure" every other thrown error here
    // still means (full-repo audit finding #12, MEDIUM, 2026-08-16 — this
    // `catch` previously mapped both identically; see docs/DECISIONS.md).
    if (err instanceof SoundnessFixtureError) {
      printFixtureFailure(format, err.message);
      process.exitCode = 2;
    } else {
      printInfrastructureFailure(format, (err as Error).message);
      process.exitCode = 3;
    }
  } finally {
    await closePool();
  }
}
