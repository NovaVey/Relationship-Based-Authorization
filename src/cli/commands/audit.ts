/**
 * `authz audit verify` — walks the `checks` table's hash chain
 * (`src/audit/checks.ts`, migration `0006_checks_hash_chain.sql`) in
 * `chain_seq` order and recomputes every chained row's `row_hash` fresh
 * from what's actually stored right now, comparing it against the value
 * actually stored in that row. Reports either every chained row verified
 * (chain intact) or the FIRST row (by `chain_seq` — the table's own real
 * insertion order, see the migration's own doc comment for why `id`/
 * `checked_at` can't serve this purpose) whose stored and recomputed
 * hashes disagree, printing that row's real column values so an operator
 * can see exactly what was altered.
 *
 * **Verification never trusts a row's own stored `prev_hash` column as an
 * input** — it only ever feeds `computeCheckRowHash` the *actual* previous
 * chained row's own `row_hash`, carried forward from this walk itself. This
 * is what makes tampering with `prev_hash` alone (without also fixing up
 * `row_hash` to match) detectable exactly the same way tampering with any
 * other column is: whatever the tampered row's `prev_hash` column now says,
 * the hash this command recomputes still uses the real predecessor's real
 * hash, so it disagrees with whatever `row_hash` was stored unless that was
 * *also* rewritten consistently. The stored `prev_hash` is still printed on
 * a broken row purely as a diagnostic (so an operator can see the tampered
 * value itself), never as an input to the pass/fail decision.
 *
 * **Only rows with a non-NULL `row_hash` are walked or counted.** Every row
 * that existed before migration `0006_checks_hash_chain.sql` shipped has a
 * NULL `row_hash` by design (that migration's own doc comment explains
 * why) — this command's own "N/N" report counts only the chained subset,
 * never a total that would silently imply legacy rows were checked too.
 *
 * **Scale, disclosed honestly.** This reads every chained row into memory
 * in one query — perfectly fine for the periodic, operator-run integrity
 * check this command is (not something called from the hot check path),
 * but a `checks` table with an enormous chained history would eventually
 * want a cursor-based or batched walk instead. Not built here: this
 * project takes no new dependency for a streaming-cursor library, and
 * hand-rolling batched keyset pagination (`chain_seq > $last limit N`)
 * purely to future-proof a command nothing has yet observed to be slow
 * would be speculative complexity this codebase's own conventions
 * discourage (`.claude/commands/build-authz-service.md`'s own "build a
 * thing only when the current need actually depends on it" discipline,
 * already cited by several migrations in this repo). Revisit if a real
 * `checks` table ever grows large enough for this to matter.
 */
import {
  canonicalJson,
  computeCheckRowHash,
  GENESIS_PREV_HASH,
  type HashableCheckRow,
} from '../../audit/checks.js';
import { getPool, closePool } from '../../store/client.js';
import { env } from '../../config/env.js';

interface ChainedCheckRow {
  id: string;
  chain_seq: string; // bigint over the wire is a string (D-018)
  subject_ns: string;
  subject_id: string;
  relation: string;
  object_ns: string;
  object_id: string;
  allowed: boolean;
  consistency_token: string | null; // bigint over the wire is a string (D-018)
  resolution_path: unknown;
  depth: number;
  duration_ms: number | null;
  checked_at: Date;
  prev_hash: string | null;
  row_hash: string | null;
}

function toHashable(row: ChainedCheckRow): HashableCheckRow {
  return {
    subjectNs: row.subject_ns,
    subjectId: row.subject_id,
    relation: row.relation,
    objectNs: row.object_ns,
    objectId: row.object_id,
    allowed: row.allowed,
    consistencyToken: row.consistency_token,
    resolutionPath: row.resolution_path,
    depth: row.depth,
    durationMs: row.duration_ms,
    checkedAt: row.checked_at,
  };
}

function entity(ns: string, id: string): string {
  return `${ns}:${id}`;
}

/** Renders every real column value of a broken row — exactly what an operator needs to see what was actually altered, per this command's own top-of-file doc comment. */
function printBrokenRow(
  row: ChainedCheckRow,
  expectedPrevHash: string,
  expectedRowHash: string,
): void {
  console.error(`  chain_seq:          ${row.chain_seq}`);
  console.error(`  id:                 ${row.id}`);
  console.error(`  subject:            ${entity(row.subject_ns, row.subject_id)}`);
  console.error(`  relation:           ${row.relation}`);
  console.error(`  object:             ${entity(row.object_ns, row.object_id)}`);
  console.error(`  allowed:            ${row.allowed}`);
  console.error(`  consistency_token:  ${row.consistency_token ?? 'null'}`);
  console.error(`  resolution_path:    ${canonicalJson(row.resolution_path)}`);
  console.error(`  depth:              ${row.depth}`);
  console.error(`  duration_ms:        ${row.duration_ms ?? 'null'}`);
  console.error(`  checked_at:         ${row.checked_at.toISOString()}`);
  console.error(`  stored prev_hash:   ${row.prev_hash ?? 'null'}`);
  console.error(
    `  expected prev_hash: ${expectedPrevHash} (the real preceding chained row's own row_hash)`,
  );
  console.error(`  stored row_hash:    ${row.row_hash ?? 'null'}`);
  console.error(
    `  expected row_hash:  ${expectedRowHash} (recomputed from this row's own current, possibly-altered columns)`,
  );
}

export async function auditVerify(): Promise<void> {
  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  try {
    let rows: ChainedCheckRow[];
    try {
      const result = await pool.query<ChainedCheckRow>(
        `select id, chain_seq, subject_ns, subject_id, relation, object_ns, object_id,
                allowed, consistency_token, resolution_path, depth, duration_ms,
                checked_at, prev_hash, row_hash
         from checks
         where row_hash is not null
         order by chain_seq asc`,
      );
      rows = result.rows;
    } catch (err) {
      console.error(`Postgres: ${(err as Error).message}`);
      process.exitCode = 3;
      return;
    }

    let expectedPrevHash = GENESIS_PREV_HASH;
    for (const row of rows) {
      const expectedRowHash = computeCheckRowHash(toHashable(row), expectedPrevHash);
      if (row.row_hash !== expectedRowHash) {
        console.error('authz audit verify: TAMPERING DETECTED — the chain is broken.');
        console.error('');
        console.error(
          `First broken row (by chain_seq, this table's real insertion order) — ` +
            `its stored row_hash does not match what its currently-recorded columns hash to:`,
        );
        console.error('');
        printBrokenRow(row, expectedPrevHash, expectedRowHash);
        process.exitCode = 1;
        return;
      }
      expectedPrevHash = row.row_hash;
    }

    console.log(`authz audit verify: ${rows.length}/${rows.length} rows verified, chain intact.`);
    if (rows.length === 0) {
      console.log(
        '(No chained rows exist yet — either checks has never been written to, or every ' +
          'existing row predates migration 0006_checks_hash_chain.sql and is intentionally ' +
          "excluded from the chain; see that migration's own doc comment.)",
      );
    }
  } finally {
    await closePool();
  }
}
