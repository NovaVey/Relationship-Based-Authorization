/**
 * Migration runner. Phase 0 wiring — the actual table definitions from §4
 * (namespace_configs, relation_tuples, write_log, checks, soundness_runs)
 * are Phase 2's job and land as .sql files under `migrations/`. This file
 * exists now so that mechanism is proven end to end (a real connection, a
 * real transaction, a real tracking table) against zero migrations, rather
 * than being built for the first time under the pressure of Phase 2's own
 * exit criteria.
 *
 * `discoverMigrations` is a pure function — no I/O beyond a directory
 * listing, no database — specifically so it's unit-testable without a
 * Postgres connection, per this project's own preference for testing pure
 * logic in isolation before it's entangled with I/O (see
 * .claude/commands/build-authz-service.md §9 Phase 1's reasoning, applied
 * here at smaller scale).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectionSource } from './query-executor.js';

export interface MigrationFile {
  /** Filename without the .sql extension — also the schema_migrations primary key. */
  id: string;
  filename: string;
  path: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Lists `*.sql` files in `dir`, sorted lexicographically by filename — the
 * standard "NNNN_description.sql" convention makes lexicographic order the
 * intended apply order. A missing directory is treated as zero migrations,
 * not an error: a fresh clone has no `migrations/` directory at all until
 * Phase 2 commits its first one, and `authz doctor` must not fail just
 * because nothing has been written yet.
 */
export function discoverMigrations(dir: string): MigrationFile[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((filename) => ({
      id: filename.slice(0, -'.sql'.length),
      filename,
      path: join(dir, filename),
    }));
}

const MIGRATIONS_TABLE_DDL = `
  create table if not exists schema_migrations (
    id text primary key,
    applied_at timestamptz not null default now()
  );
`;

/**
 * Advisory-lock key serializing the read-pending-then-apply sequence below
 * — closes a real race (full-repo audit finding #14, LOW, third audit,
 * 2026-08-17): `runMigrations` used to read `schema_migrations`, compute
 * what's pending, and apply it with nothing serializing the read against a
 * concurrent second call. Two instances cold-starting together during a
 * rolling deploy could both read the same "pending" snapshot and both
 * attempt to apply it; the loser's own migration transaction would then die
 * on a real catalog conflict (transactionally safe — no corruption — but an
 * unhandled error, and one that, once finding #4's `doctor.ts` fix landed,
 * would surface as a distinct "Migrations: failed to apply" message rather
 * than a misleading "Postgres: unreachable" one, which is a correctly
 * *attributed* failure but still an entirely avoidable one).
 *
 * The identical "read pending state, then write, unserialized" shape D-080
 * already found and fixed for `publishOne` (`src/schema/publish.ts`,
 * `pg_advisory_xact_lock(hashtext($1))`, namespace-scoped) and D-083 fixed
 * for `writeTuple`/`deleteTuple` (`src/store/tuples.ts`,
 * `WRITE_LOG_LOCK_CLASSID`/`WRITE_LOG_LOCK_OBJID`, globally-scoped) — this
 * is the same idiom applied to `schema_migrations`, a third, independent
 * resource neither of those locks touches. A THIRD, distinct
 * `(classid, objid)` pair, deliberately not reused from either: the
 * two-integer-argument form of `pg_advisory_xact_lock` is documented by
 * Postgres as a keyspace entirely separate from the single-bigint form
 * `publishOne` uses (so no collision risk with that one by construction
 * regardless of the numeric value chosen), and a distinct `classid` from
 * `WRITE_LOG_LOCK_CLASSID` keeps this lock from serializing against
 * completely unrelated tuple-write traffic (migrations run once per
 * deploy, at startup — there's no reason for them to contend with a live
 * service's own write throughput, or vice versa).
 *
 * `classid` is the ASCII bytes of the literal string `migr`
 * (`0x6d 69 67 72` = `1835624306`) — arbitrary but fixed, greppable, and
 * human-legible, matching `WRITE_LOG_LOCK_CLASSID`'s own `'wlog'` naming
 * convention exactly. `objid` is a fixed `0`: like the write-log lock,
 * there is exactly one thing this lock ever serializes (every
 * `runMigrations` call against this database, regardless of which
 * migrations happen to be pending) — no second dimension to key by.
 *
 * Exported (not module-private), for the same reason `tuples.ts` exports
 * `WRITE_LOG_LOCK_CLASSID`/`WRITE_LOG_LOCK_OBJID` (see that export's own
 * doc comment): DST D1's own session-lock-crash test (`docs/DECISIONS.md`
 * D-098) acquires this *exact* production lock directly against a fake
 * connection to prove the real lock key genuinely blocks and genuinely
 * releases on connection death — not a same-shaped-but-different value
 * that only coincidentally matches this file today.
 *
 * **Session-scoped (`pg_advisory_lock`/`pg_advisory_unlock`), NOT
 * transaction-scoped (`pg_advisory_xact_lock`) like D-080's and D-083's own
 * locks — a deliberate, load-bearing difference, not an inconsistency.**
 * Both of those lock a single operation that is itself one transaction from
 * start to finish, so "released automatically at `COMMIT`/`ROLLBACK`, no
 * separate unlock call needed" is exactly the right fit. `runMigrations`'s
 * own sequence cannot be one transaction: `MIGRATIONS_TABLE_DDL` needs to
 * be visible to *other* connections the moment it runs (see below), and
 * each migration is deliberately applied in its **own** transaction, on its
 * **own** pooled connection (`client = await pool.connect()` inside the
 * loop) — the existing, load-bearing contract this function's own doc
 * comment states: "each in its own transaction (one migration's SQL fails
 * without touching the ones before it)". A single connection can hold only
 * one open transaction at a time, so a `pg_advisory_xact_lock` taken on
 * `lockClient` could never stay held across a loop whose actual work
 * commits on *different* connections one migration at a time — the first
 * per-migration `COMMIT` would have nothing to do with `lockClient`'s own
 * transaction at all. A session-scoped lock has no such restriction: taken
 * once, held for the connection's *session* regardless of how many separate
 * transactions run on other connections meanwhile, and released explicitly,
 * by this function itself, only once the entire sequence — DDL, read,
 * every migration's own apply — has finished.
 */
export const MIGRATIONS_LOCK_CLASSID = 0x6d696772; // ASCII 'migr' — see doc comment above.
export const MIGRATIONS_LOCK_OBJID = 0;

/**
 * Applies every migration in `dir` not already recorded in
 * `schema_migrations`, each in its own transaction (one migration's SQL
 * fails without touching the ones before it). Idempotent: re-running with
 * nothing new to apply reports an empty `applied` list.
 *
 * The whole sequence below — `MIGRATIONS_TABLE_DDL`, the `select id from
 * schema_migrations` read, and the entire apply loop — runs while
 * `lockClient` holds `MIGRATIONS_LOCK_CLASSID`/`MIGRATIONS_LOCK_OBJID` as a
 * *session*-scoped advisory lock; see that constant pair's own doc comment
 * both for the race this closes and for why session-scoped, not
 * transaction-scoped like this project's other two advisory locks (D-080,
 * D-083). `MIGRATIONS_TABLE_DDL` runs as its own implicit, immediately-
 * committed statement (no explicit `BEGIN` wraps it) specifically so it's
 * visible right away to the *separate* pooled connections the apply loop
 * below opens per migration — wrapping it in an explicit transaction that
 * stayed open across the whole function, as an earlier draft of this fix
 * did, left it invisible to every one of those other connections until
 * that outer transaction finally committed, which made even a single,
 * non-concurrent call fail outright (`relation "schema_migrations" does
 * not exist` from the very first migration's own `insert`) — caught live
 * during this fix's own verification, not assumed, and never shipped.
 *
 * The lock is always released in `finally`, whether the function returns
 * normally or throws — including when a migration itself fails — so a
 * failed run never leaves a permanently-locked pooled connection behind.
 * The unlock call's own failure (e.g. the connection died mid-run) is
 * swallowed, never allowed to replace whatever error the `try` block was
 * already propagating: the same "cleanup's own outcome must never
 * overwrite the thing that actually matters" reasoning `runSoundnessFuzz`
 * already applies to its own cleanup step (D-066, `src/soundness/
 * runner.ts`) — Postgres itself releases every session-level advisory lock
 * automatically when the session/connection actually ends regardless, so a
 * failed unlock on a connection that's being torn down anyway costs
 * nothing beyond the swallowed error.
 *
 * `pool: ConnectionSource`, not the concrete `pg.Pool` — DST D1
 * (`docs/DECISIONS.md` D-098), the same non-breaking narrowing D0 already
 * applied to `tuples.ts`/`tokens.ts`/`publish.ts`: a real `Pool` still
 * satisfies this structurally, so every existing caller (`authz doctor`,
 * every integration test) keeps working with zero changes. See
 * `query-executor.ts`'s own doc comment for why the narrower type exists
 * at all.
 */
export async function runMigrations(pool: ConnectionSource, dir: string): Promise<MigrationResult> {
  const lockClient = await pool.connect();
  let lockHeld = false;
  try {
    await lockClient.query('select pg_advisory_lock($1, $2)', [
      MIGRATIONS_LOCK_CLASSID,
      MIGRATIONS_LOCK_OBJID,
    ]);
    lockHeld = true;

    await lockClient.query(MIGRATIONS_TABLE_DDL);

    const { rows } = await lockClient.query<{ id: string }>('select id from schema_migrations');
    const alreadyApplied = new Set(rows.map((row) => row.id));

    const pending = discoverMigrations(dir).filter(
      (migration) => !alreadyApplied.has(migration.id),
    );
    const applied: string[] = [];

    for (const migration of pending) {
      const sql = readFileSync(migration.path, 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('insert into schema_migrations (id) values ($1)', [migration.id]);
        await client.query('COMMIT');
        applied.push(migration.id);
      } catch (err) {
        // The ROLLBACK call's own failure must never replace the real
        // error below — deferred from D0 to D1 (`docs/DECISIONS.md`
        // D-097's own "Revisit if"): this is the exact same
        // rollback-masking gap D0's crash-injection work found and fixed
        // in `tuples.ts`/`publish.ts`, closed here with the identical
        // pattern. See `writeTuple`'s own catch block (`src/store/
        // tuples.ts`) for the full reasoning.
        try {
          await client.query('ROLLBACK');
        } catch {
          // Swallowed deliberately — see comment above.
        }
        throw new Error(`migration ${migration.id} failed: ${(err as Error).message}`, {
          cause: err,
        });
      } finally {
        client.release();
      }
    }

    return { applied, alreadyApplied: [...alreadyApplied] };
  } finally {
    if (lockHeld) {
      try {
        await lockClient.query('select pg_advisory_unlock($1, $2)', [
          MIGRATIONS_LOCK_CLASSID,
          MIGRATIONS_LOCK_OBJID,
        ]);
      } catch {
        // See this function's own doc comment — never let a failed unlock
        // mask the real error the try block above may already be throwing.
      }
    }
    lockClient.release();
  }
}
