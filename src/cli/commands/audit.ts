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
 *
 * ---
 *
 * **`--anchor-file <path>` (closes D-148's own disclosed residual risk —
 * see `src/audit/anchor.ts`'s own top-of-file doc comment for the full
 * design).** The internal walk above recomputes every row's hash from
 * that SAME row's own currently-stored columns and its predecessor's own
 * currently-stored hash — which is exactly the computation a privileged
 * attacker performs when rewriting the chain forward, consistently, from
 * a tampered row. The two agree by construction, so a full consistent
 * forward rewrite is invisible to the internal walk alone, no matter how
 * carefully it's written — this is D-148's own stated, honest limit, not
 * a bug in the walk above. `--anchor-file` closes exactly this gap, and
 * only this gap: it reads every entry previously recorded by `authz audit
 * anchor` and, for each one, independently re-derives what the chain
 * actually hashes to at that exact `chain_seq` position using ONLY
 * currently-stored data (`verifyAgainstAnchors` below, reusing the exact
 * per-row `expectedRowHash` this file's own internal walk already
 * computes) — comparing that fresh recomputation against what was
 * anchored at the time. A privileged rewrite of any row at or before an
 * anchored `chain_seq` changes what the chain re-derives to at that
 * position, so it can never match an anchor recorded before the rewrite
 * happened, even though the internal walk alone reports the (rewritten)
 * chain fully intact.
 *
 * **Deliberately only ever run when the internal walk itself reports the
 * chain intact.** If the internal walk already found a broken row (a
 * single row edited without a cascading forward fix — the shape it CAN
 * catch on its own), that is already a complete, correctly-attributed
 * answer; running the anchor comparison on top would either report a
 * redundant, secondary "also broken" finding or — worse — risk a report
 * that reads as ambiguous about which finding is real. Keeping the two
 * failure paths structurally disjoint (the function below returns
 * immediately on an internal break, before `--anchor-file` is ever
 * consulted) is what makes "never conflated with a plain
 * single-row-tamper failure message" true by construction, not just by
 * careful wording.
 */
import {
  canonicalJson,
  computeCheckRowHash,
  GENESIS_PREV_HASH,
  type HashableCheckRow,
} from '../../audit/checks.js';
import {
  DEFAULT_ANCHOR_FILE_PATH,
  readAnchorFile,
  recordAnchor,
  type AnchorEntry,
} from '../../audit/anchor.js';
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

/**
 * Compares every entry in `anchorFile` against `expectedHashBySeq` — the
 * per-row `chain_seq -> expectedRowHash` map `auditVerify`'s own internal
 * walk already built while confirming the chain intact (see this file's
 * own top-of-file "`--anchor-file`" section for why this is only ever
 * reached once that walk has already reported no internal break). Prints
 * either every anchor entry verified or a distinct `ANCHOR MISMATCH`
 * report and sets `process.exitCode = 1` — never the `TAMPERING DETECTED`
 * wording the internal walk above uses, so the two failure modes never
 * read as the same finding.
 *
 * Reads the anchor file itself first; a missing/corrupt file is reported
 * as a malformed-input problem (`process.exitCode = 2`, this project's own
 * established convention — `index.ts`'s own top-of-file doc comment) since
 * `--anchor-file` names a specific path the caller asserted exists, not an
 * infrastructure failure.
 */
async function verifyAgainstAnchors(
  anchorFile: string,
  expectedHashBySeq: Map<string, string>,
): Promise<void> {
  let entries: AnchorEntry[];
  try {
    entries = await readAnchorFile(anchorFile);
  } catch (err) {
    console.error(`authz audit verify --anchor-file: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  if (entries.length === 0) {
    console.log(
      `authz audit verify: ${anchorFile} contains no anchor entries — nothing to compare ` +
        "against. Run 'authz audit anchor' to record one.",
    );
    return;
  }

  for (const entry of entries) {
    const expectedRowHash = expectedHashBySeq.get(entry.chainSeq);

    if (expectedRowHash === undefined) {
      console.error('authz audit verify: ANCHOR MISMATCH — an anchored row is missing.');
      console.error('');
      console.error(
        `This anchor entry (recorded ${entry.recordedAt}) claims chain_seq ${entry.chainSeq} ` +
          `had row_hash ${entry.rowHash}, but no chained row exists at that chain_seq in this ` +
          'database right now. Either that row was deleted, or the chain was truncated and ' +
          'rebuilt from an earlier point — either way, the chain no longer contains what was ' +
          'genuinely observed and anchored at that moment.',
      );
      process.exitCode = 1;
      return;
    }

    if (expectedRowHash !== entry.rowHash) {
      console.error(
        'authz audit verify: ANCHOR MISMATCH — the chain was rewritten forward, consistently, ' +
          'after this anchor was recorded.',
      );
      console.error('');
      console.error(
        "This is exactly the residual risk D-148's own internal hash-chain walk (above, or on " +
          'its own with no --anchor-file) CANNOT detect: a privileged database user rewrote ' +
          "one or more rows at or before this anchor's own chain_seq and recomputed every " +
          'row_hash/prev_hash forward from there, consistently — so the internal walk alone ' +
          'reports the chain intact even though it no longer reflects what was genuinely ' +
          'recorded.',
      );
      console.error('');
      console.error(`  chain_seq:                 ${entry.chainSeq}`);
      console.error(`  anchor recorded_at:        ${entry.recordedAt}`);
      console.error(`  anchored row_hash:         ${entry.rowHash}`);
      console.error(
        `  currently re-derived hash: ${expectedRowHash} (recomputed from genesis using only ` +
          "what's stored in this database right now)",
      );
      process.exitCode = 1;
      return;
    }
  }

  console.log(
    `authz audit verify: ${entries.length}/${entries.length} anchor entries verified against ` +
      `${anchorFile} — no consistent forward rewrite detected at any anchored position.`,
  );
}

export interface AuditVerifyOptions {
  /** Optional path to an anchor file (`authz audit anchor`, `src/audit/anchor.ts`) — see this file's own top-of-file "`--anchor-file`" section. */
  anchorFile?: string;
}

export async function auditVerify(options: AuditVerifyOptions = {}): Promise<void> {
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

    // Built alongside the walk below regardless of outcome — the input
    // `--anchor-file` comparison needs (see this file's own top-of-file
    // "`--anchor-file`" section). Harmless bookkeeping when no
    // `--anchor-file` is given: the map is simply never read.
    const expectedHashBySeq = new Map<string, string>();

    let expectedPrevHash = GENESIS_PREV_HASH;
    for (const row of rows) {
      const expectedRowHash = computeCheckRowHash(toHashable(row), expectedPrevHash);
      expectedHashBySeq.set(row.chain_seq, expectedRowHash);
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

    // Only ever reached once the internal walk above found zero breaks —
    // see this file's own top-of-file "Deliberately only ever run..."
    // section for why.
    if (options.anchorFile !== undefined) {
      await verifyAgainstAnchors(options.anchorFile, expectedHashBySeq);
    }
  } finally {
    await closePool();
  }
}

export interface AuditAnchorOptions {
  /** Path to append the new anchor entry to — defaults to `DEFAULT_ANCHOR_FILE_PATH` (`src/audit/anchor.ts`). */
  file?: string;
}

/**
 * `authz audit anchor [--file <path>]` — records one new anchor entry (the
 * `checks` hash chain's current tip) to a local, append-only file. See
 * `src/audit/anchor.ts`'s own top-of-file doc comment for the full design,
 * the file format, and — most importantly — the honest disclosure that a
 * local file alone provides no real security value until an operator
 * replicates it somewhere this same Postgres instance genuinely cannot
 * reach. Repeated here, at the point an operator actually runs this
 * command, not just in a source comment they may never read.
 */
export async function auditAnchor(options: AuditAnchorOptions = {}): Promise<void> {
  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const filePath = options.file ?? DEFAULT_ANCHOR_FILE_PATH;
  const pool = getPool();
  try {
    const entry = await recordAnchor(pool, filePath);
    if (!entry) {
      console.log(
        'authz audit anchor: no chained rows exist yet in checks — nothing to anchor. Run a ' +
          'real check first (authz check), then anchor again.',
      );
      return;
    }

    console.log(
      `authz audit anchor: recorded chain_seq=${entry.chainSeq} row_hash=${entry.rowHash} ` +
        `(${entry.rowCount} chained row(s) total) to ${filePath}`,
    );
    console.log('');
    console.log(
      'Reminder: this file, on its own, on this same host, provides no protection against a ' +
        'privileged Postgres user — it must be replicated somewhere this database genuinely ' +
        'cannot reach (a different host, an external backup pipeline, a git commit to a ' +
        "separate repository, anything already outside this database's own reach) before it " +
        'closes the residual risk it exists to close. See src/audit/anchor.ts for the full ' +
        'design.',
    );
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}
