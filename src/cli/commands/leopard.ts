/**
 * `authz leopard refresh|status` — the operational surface for the Leopard
 * index (Phase A), `docs/LEOPARD-INDEX-PROPOSAL.md`'s own "Operational
 * surface" section. Mirrors this project's established CLI shape exactly —
 * `soundness.ts`'s validate-`--format`-then-connect-then-report structure
 * and its `printInfrastructureFailure`-style exit-3 reporting,
 * `apikey.ts`'s `DATABASE_URL` check + `getPool()`/`closePool()` lifecycle.
 *
 * `authz leopard refresh` is deliberately runnable regardless of
 * `LEOPARD_INDEX_ENABLED` — the proposal's own "pre-warm before enabling"
 * sequence depends on this not being gated on the flag. `authz leopard
 * status` reports one of three states (disabled / enabled-never-built /
 * enabled-built) regardless of `--format`, per the proposal's own worked
 * examples.
 *
 * Exit codes (`docs/LEOPARD-INDEX-PROPOSAL.md`, "Operational surface"):
 *   `refresh`: 0 completed (including a dry run, and including "skipped —
 *     a refresh is already running"); 2 malformed `--format`; 3
 *     infrastructure failure (DB unreachable, the rebuild query itself
 *     errored — the previous state is left untouched and keeps serving,
 *     since `rebuildRelationMembershipIndex` itself rolls back on any
 *     thrown error before this ever sees it).
 *   `status`: 0 ran fine (reports state regardless of what that state
 *     is — staleness is never this command's own failure); 2 malformed
 *     `--format`; 3 infrastructure failure.
 */
import { rebuildRelationMembershipIndex } from '../../store/relation-index.js';
import { getPool, closePool } from '../../store/client.js';
import { env } from '../../config/env.js';

/**
 * `rebuildRelationMembershipIndex` returns an inline object type, not a
 * named export — this file has no store-layer changes to make, so the
 * shape is captured here via `Awaited<ReturnType<...>>` rather than
 * inventing a type that doesn't exist on that module.
 */
type RelationMembershipIndexRebuildResult = Awaited<
  ReturnType<typeof rebuildRelationMembershipIndex>
>;

const VALID_FORMATS = ['text', 'json'] as const;
type Format = (typeof VALID_FORMATS)[number];

function isValidFormat(f: string): f is Format {
  return (VALID_FORMATS as readonly string[]).includes(f);
}

/**
 * The exit-code-3 ("infrastructure failure") reporter shared by both
 * subcommands below — same "always stderr, plus an honest, parseable
 * stdout line for `--format json`, never a silent empty stdout" discipline
 * `soundness.ts`'s own `printInfrastructureFailure` already establishes.
 */
function printInfrastructureFailure(format: Format, message: string): void {
  if (format === 'json') {
    console.log(JSON.stringify({ status: 'error', error: message }));
  }
  console.error(`Postgres: ${message}`);
}

export interface LeopardRefreshCliOptions {
  dryRun?: boolean;
  format?: string;
}

export async function leopardRefresh(options: LeopardRefreshCliOptions): Promise<void> {
  const formatRaw = options.format ?? 'text';
  if (!isValidFormat(formatRaw)) {
    console.error(`invalid --format '${formatRaw}' — must be one of: ${VALID_FORMATS.join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const format = formatRaw;
  const dryRun = options.dryRun ?? false;

  if (!env.DATABASE_URL) {
    printInfrastructureFailure(format, 'DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  try {
    const result = await rebuildRelationMembershipIndex(pool, { dryRun });

    // `rebuildRelationMembershipIndex`'s own dedicated `lockAcquired` field
    // (added specifically for this call site) — an exact signal, not a
    // heuristic: `lockAcquired: false` means this call did no work at all
    // because a concurrent refresh already held the lock, unambiguously
    // distinct from a dry run (or a real rebuild) that simply found nothing
    // in a genuinely empty `relation_tuples`/`write_log` (which reports the
    // identical `{watermarkToken:0, rowCount:0}` pair but `lockAcquired:
    // true`).
    if (!result.lockAcquired) {
      if (format === 'json') {
        console.log(JSON.stringify({ status: 'skipped', reason: 'already-running' }));
      } else {
        console.log('skipped — a refresh is already running');
      }
      return; // exit 0 — an idempotent no-op, not a failure.
    }

    printRefreshResult(format, dryRun, result);
    // exit 0 — completed, whether committed or (for --dry-run) rolled back.
  } catch (err) {
    printInfrastructureFailure(format, (err as Error).message);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}

function printRefreshResult(
  format: Format,
  dryRun: boolean,
  result: RelationMembershipIndexRebuildResult,
): void {
  if (format === 'json') {
    console.log(
      JSON.stringify({
        status: dryRun ? 'dry-run' : 'completed',
        watermarkToken: result.watermarkToken,
        rowCount: result.rowCount,
        published: result.published,
      }),
    );
    return;
  }
  if (dryRun) {
    console.log(
      `dry run — would rebuild to watermark ${result.watermarkToken}, ${result.rowCount} row(s) ` +
        `(rolled back — nothing was persisted).`,
    );
  } else {
    console.log(
      `rebuilt to watermark ${result.watermarkToken}, ${result.rowCount} row(s) — published.`,
    );
  }
}

export interface LeopardStatusCliOptions {
  format?: string;
}

/** The three states `docs/LEOPARD-INDEX-PROPOSAL.md`'s own "Operational surface" section shows. */
type LeopardIndexState = 'disabled' | 'never-built' | 'built';

interface LeopardIndexStatusInfo {
  watermarkToken: number;
  currentWriteLogToken: number;
  finishedAt: Date | null;
  /** `null` iff `finishedAt` is `null` — see the SQL below. */
  stalenessMs: number | null;
}

export async function leopardStatus(options: LeopardStatusCliOptions): Promise<void> {
  const formatRaw = options.format ?? 'text';
  if (!isValidFormat(formatRaw)) {
    console.error(`invalid --format '${formatRaw}' — must be one of: ${VALID_FORMATS.join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const format = formatRaw;

  if (!env.DATABASE_URL) {
    printInfrastructureFailure(format, 'DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  try {
    // A simple select, on the pool directly — no dedicated transaction or
    // snapshot needed for a diagnostic report (unlike the rebuild itself,
    // or a pinned check's own `lookupRelationMembershipIndex`). `now()` in
    // the same query as `rebuild_finished_at` is still Postgres's own
    // clock, not Node's `Date.now()`, matching this project's established
    // "one now() for every staleness computation" discipline.
    const { rows } = await pool.query<{
      watermark_token: string;
      rebuild_finished_at: Date | null;
      // `extract(epoch from ...)` returns Postgres `numeric`, which `pg`
      // hands back as a raw string (never auto-coerced, to avoid silent
      // precision loss) — the exact same class of bug `tokens.ts`'s own
      // doc comment warns about for `write_log.token`. Confirmed live: a
      // real `authz leopard status --format json` run returned
      // `"stalenessMs":"1953.832000"` (a quoted JSON string) before this
      // fix, despite `LeopardIndexStatusInfo.stalenessMs` being typed
      // `number | null` — a real contract violation for any JSON consumer,
      // caught by actually running the command against real Postgres, not
      // by the type system (a `string | null` lie at the query's own type
      // annotation is exactly what let this slip past `tsc`).
      staleness_ms: string | null;
    }>(
      `select
         watermark_token,
         rebuild_finished_at,
         extract(epoch from (now() - rebuild_finished_at)) * 1000 as staleness_ms
       from relation_membership_index_state
       where id = 1`,
    );
    const row = rows[0];
    const watermarkToken = Number(row?.watermark_token ?? 0);
    const finishedAt = row?.rebuild_finished_at ?? null;
    const stalenessMs =
      row?.staleness_ms !== null && row?.staleness_ms !== undefined
        ? Number(row.staleness_ms)
        : null;

    const { rows: writeLogRows } = await pool.query<{ max_token: string | null }>(
      'select max(token) from write_log',
    );
    const currentWriteLogToken = Number(writeLogRows[0]?.max_token ?? 0);

    const enabled = env.LEOPARD_INDEX_ENABLED === 'true';
    const state: LeopardIndexState = !enabled
      ? 'disabled'
      : finishedAt === null
        ? 'never-built'
        : 'built';

    const info: LeopardIndexStatusInfo = {
      watermarkToken,
      currentWriteLogToken,
      finishedAt,
      stalenessMs,
    };

    if (format === 'json') {
      console.log(
        JSON.stringify({
          status: state,
          enabled,
          watermarkToken,
          currentWriteLogToken,
          finishedAt: finishedAt ? finishedAt.toISOString() : null,
          stalenessMs,
        }),
      );
    } else {
      printStatusText(state, info);
    }
    // exit 0 — ran fine, regardless of which of the three states this reports.
  } catch (err) {
    printInfrastructureFailure(format, (err as Error).message);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}

/** `--format text` rendering of the three states — wording drawn directly from the proposal's own worked examples. */
function printStatusText(state: LeopardIndexState, info: LeopardIndexStatusInfo): void {
  if (state === 'disabled') {
    console.log(
      `Leopard index: DISABLED (LEOPARD_INDEX_ENABLED=${env.LEOPARD_INDEX_ENABLED}) — every check uses the live resolver only.`,
    );
    return;
  }
  if (state === 'never-built') {
    console.log('Leopard index: ENABLED, but no rebuild has ever completed.');
    console.log(
      '  Every check currently falls back to the live resolver — this is safe, never wrong, only slower.',
    );
    console.log(
      '  Run `authz leopard refresh` (or wait for the configured interval/cron) to build it.',
    );
    return;
  }

  // state === 'built' — finishedAt/stalenessMs are non-null by construction here.
  const ageSeconds = info.stalenessMs !== null ? Math.round(info.stalenessMs / 1000) : null;
  console.log('Leopard index: ENABLED');
  console.log(
    `  Last complete rebuild: ${info.finishedAt?.toISOString()}` +
      (ageSeconds !== null ? ` (${ageSeconds}s ago)` : ''),
  );
  console.log(`  Watermark: write_log token ${info.watermarkToken}`);
  const writesBehind = info.currentWriteLogToken - info.watermarkToken;
  console.log(
    `  Current write_log token: ${info.currentWriteLogToken}` +
      (writesBehind > 0
        ? ` (index is ${writesBehind} write${writesBehind === 1 ? '' : 's'} behind — expected between rebuilds)`
        : ' (index is fully caught up)'),
  );
  console.log(
    `  Pinned checks: usable whenever their own atToken <= ${info.watermarkToken}, regardless of wall-clock age.`,
  );
  console.log(
    '  Unpinned checks: never consult this index in this phase — always the live resolver (Phase B).',
  );
}
