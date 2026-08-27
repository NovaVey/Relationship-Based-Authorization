/**
 * An out-of-band, append-only anchor for the `checks` hash chain's own tip
 * — closing D-148's own disclosed residual risk (`docs/DECISIONS.md`):
 * "this detects tampering after the fact; it cannot stop a privileged
 * database user from rewriting the whole chain forward consistently from
 * a tampered row." D-148's own "Revisit if" names the fix exactly:
 * "an out-of-band, append-only anchor... periodically publishing the
 * current chain tip somewhere this database can't itself rewrite, a
 * materially different mechanism than hash-chaining alone can provide."
 *
 * **Why a full consistent forward rewrite is invisible to `authz audit
 * verify` alone.** `row_hash` is a pure function of a row's own recorded
 * columns plus its predecessor's `row_hash` (`computeCheckRowHash`,
 * `checks.ts`). Anyone with enough Postgres privilege to `UPDATE` one
 * row's columns can, in principle, also recompute and rewrite every
 * `row_hash`/`prev_hash` pair from that row forward — the hash chain has
 * no way to distinguish "this is genuinely what was recorded" from "this
 * is a self-consistent fabrication," because *every* input the chain is
 * built from, including the chain's own history, lives in the one
 * database that attacker already fully controls. `authz audit verify`'s
 * own internal walk recomputes each row's hash from its own currently-
 * stored columns and the *previous row's own currently-stored* hash —
 * exactly the computation a forward-rewriting attacker also performs, so
 * the two agree by construction. No amount of hashing harder, or walking
 * more carefully, closes this: the fix has to come from *outside* the one
 * thing under attack.
 *
 * **What an anchor actually buys.** An anchor entry is a snapshot, taken
 * at a specific moment, of "the chain's tip was `rowHash` at `chainSeq`."
 * Once written, `authz audit verify --anchor-file <path>` can independently
 * re-derive what today's chain *actually* hashes to at that exact
 * `chainSeq` position (walking forward from genesis using only the
 * currently-stored canonical row data — see `verifyAgainstAnchors` in
 * `src/cli/commands/audit.ts`) and compare it against what was anchored.
 * If a privileged attacker rewrites row K (K < the anchored `chainSeq`)
 * and cascades the rewrite forward, the recomputed hash at the anchored
 * `chainSeq` changes — the rewrite necessarily produces a *different* tip
 * hash than the one genuinely observed and recorded before the tampering
 * happened, because the anchor's own stored value is no longer derivable
 * from that database at all. That comparison is the entire mechanism —
 * nothing here needs to re-verify every row a second time, just the one
 * position an anchor already committed to.
 *
 * **The one honest, non-negotiable requirement this file cannot satisfy
 * by itself, stated plainly, not glossed over.** An anchor file that lives
 * on the same disk this same Postgres server (or a privileged operator
 * with shell access to this same host) can also reach provides NO real
 * security improvement over the hash chain alone — a privileged attacker
 * who can rewrite `checks` can, by the identical logic, also rewrite (or
 * simply delete and regenerate) a local anchor file sitting right next to
 * it. This module's real job is narrower and honest about its own limit:
 * it gives an operator a genuine, working append-only recording mechanism
 * and a genuine, working comparison mechanism — the actual security value
 * only materializes once an operator replicates this file somewhere a
 * privileged Postgres user cannot reach (a different host, an external
 * backup/log-shipping pipeline, a periodic `git commit` to a separate
 * repository, anything already outside this database's own blast radius).
 * This project's own established discipline (`docs/DECISIONS.md`) takes no
 * new paid or external dependency without asking first, and this sandbox
 * has no real external immutable-storage service available regardless —
 * so what ships here is the real, working local mechanism, not a claim
 * that a local file alone closes the threat model. `authz audit anchor`'s
 * own CLI output repeats this reminder every time it runs, not just here.
 *
 * **File format: newline-delimited JSON (NDJSON), one `AnchorEntry` per
 * line.** A reasonable default for a small, append-only, line-oriented
 * log: trivially appendable without parsing the rest of the file first
 * (`fs.appendFile`'s own default flag is `'a'` — open-for-append, which
 * can only ever grow a file, never rewrite or truncate what's already on
 * disk), trivially diffable/greppable by a human or `git`, and trivially
 * streamable line-by-line without loading a single giant JSON array into
 * memory. `readAnchorFile` below tolerates a trailing blank line (the one
 * `fs.appendFile` itself always leaves after the last entry) but treats
 * any other malformed line as a hard error — a corrupted anchor file
 * should fail loud, never silently skip an entry an operator is relying
 * on to detect tampering.
 *
 * **Concurrency, disclosed honestly.** `recordAnchor` does not take any
 * lock — unlike `insertCheckRow`'s own `CHECKS_HASH_CHAIN_LOCK_CLASSID`
 * (`checks.ts`), there is no cross-process coordination here at all. Two
 * genuinely concurrent `authz audit anchor` invocations against the same
 * file could interleave their two `fs.appendFile` calls' underlying
 * writes on some platforms/filesystems (POSIX only guarantees a single
 * `write(2)` syscall is atomic up to `PIPE_BUF`-ish limits, and Node's
 * `fs.appendFile` may or may not emit the whole line in one syscall
 * depending on platform and buffering). Acceptable for what this command
 * actually is — a low-frequency, operator-run/cron-scheduled snapshot,
 * not a hot path — and not addressed here: a real fix (an OS-level file
 * lock, or serializing through a single writer process) is speculative
 * complexity for a shape nothing has yet observed to be a problem, the
 * same "build a thing only when the current need actually depends on it"
 * discipline this codebase already holds itself to elsewhere. Revisit if
 * `authz audit anchor` is ever actually run concurrently against one file
 * in practice.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { QueryExecutor } from '../store/query-executor.js';

/**
 * Default anchor file path — a plain NDJSON file in the current working
 * directory. Deliberately not under `.gitignore`'s reach by name alone
 * (this file starts with no dot) so an operator who chooses to anchor via
 * `git commit` — one of the real, honest replication options this
 * module's own top-of-file doc comment names — doesn't have to first fight
 * a stray ignore rule. Overridable per-invocation via `authz audit
 * anchor --file <path>` / `authz audit verify --anchor-file <path>`.
 */
export const DEFAULT_ANCHOR_FILE_PATH = path.resolve(process.cwd(), 'audit-anchor.ndjson');

/**
 * One recorded snapshot of the `checks` hash chain's own tip. `chainSeq`
 * is carried as a `string` — the exact same D-018 "bigint over the wire is
 * a string" convention `ChainedCheckRow.chain_seq` (`audit.ts`) already
 * follows, so this shape never needs a second, diverging representation
 * for the identical kind of value. `rowCount` is purely informational (how
 * many chained rows existed as of this snapshot) — never read back by the
 * comparison logic, which keys strictly on `chainSeq`/`rowHash`.
 */
export interface AnchorEntry {
  chainSeq: string;
  rowHash: string;
  /** ISO-8601, when this entry was appended — not when the tip row itself was checked/inserted. */
  recordedAt: string;
  /** How many chained rows existed in `checks` as of this snapshot — informational only. */
  rowCount: number;
}

/** The current chain tip, read the identical way `insertCheckRow`'s own `fetchChainTipHash` and `authz audit verify` already read and trust a stored `row_hash` — see `checks.ts`. `undefined` iff no chained row exists yet (nothing to anchor). */
export interface ChainTip {
  chainSeq: string;
  rowHash: string;
  rowCount: number;
}

/**
 * Reads the current chain tip: the highest-`chain_seq` chained row's own
 * `row_hash`, plus how many chained rows exist right now. `where row_hash
 * is not null` is the identical filter `fetchChainTipHash` (`checks.ts`)
 * and `authz audit verify`'s own rows query already use, for the identical
 * reason — every row predating migration `0006_checks_hash_chain.sql` has
 * a NULL `row_hash` by design and must never be mistaken for part of the
 * chain. A plain read, no transaction or lock: exactly like `authz audit
 * verify`'s own read, this is a periodic, operator-run snapshot, not part
 * of the write path `insertCheckRow`'s own locked critical section
 * protects — reading a tip that is a few milliseconds stale relative to a
 * concurrent insert is harmless, since the next anchor invocation (or the
 * next `verify` run) always re-reads the real, current state fresh.
 */
export async function readChainTip(executor: QueryExecutor): Promise<ChainTip | undefined> {
  // `chain_seq` is selected WITHOUT a `::text` cast, deliberately — see this
  // function's own doc comment above. `pg` already returns a `bigint`
  // column as a JS `string` by default (D-018's own "bigint over the wire
  // is a string" convention — `chain_seq` needs no cast to arrive typed
  // correctly here), and casting it to `text` in the select list under the
  // SAME alias (`chain_seq::text as chain_seq`) would make `order by
  // chain_seq desc` resolve against that TEXT alias instead of the real
  // `bigint` column — sorting lexicographically ('9' > '10' as strings),
  // not numerically. A real, live bug this exact shape produced (caught
  // running this file's own fail-check against real Postgres with more
  // than 9 chained rows — the "tip" silently came back as chain_seq 9
  // instead of 10 — before this comment and the fix it documents; see
  // `docs/DECISIONS.md`).
  const { rows } = await executor.query<{
    chain_seq: string;
    row_hash: string;
    row_count: string;
  }>(
    `select chain_seq, row_hash,
            (select count(*)::text from checks where row_hash is not null) as row_count
     from checks
     where row_hash is not null
     order by chain_seq desc
     limit 1`,
  );
  const row = rows[0];
  if (!row) return undefined;
  return { chainSeq: row.chain_seq, rowHash: row.row_hash, rowCount: Number(row.row_count) };
}

/**
 * Appends one new `AnchorEntry` — the current chain tip — to `filePath`.
 * Genuinely append-only: creates the containing directory if needed
 * (`mkdir(..., { recursive: true })`, a no-op if it already exists) and
 * writes via `fs.appendFile`, whose documented default flag is `'a'`
 * (open-for-append) — this can only ever grow the file by one line, never
 * rewrite or truncate anything already on disk. Returns `undefined`
 * (writing nothing) iff the chain has no chained rows yet — anchoring "no
 * tip" would be a meaningless, misleading entry, not a genuine snapshot.
 */
export async function recordAnchor(
  executor: QueryExecutor,
  filePath: string = DEFAULT_ANCHOR_FILE_PATH,
): Promise<AnchorEntry | undefined> {
  const tip = await readChainTip(executor);
  if (!tip) return undefined;

  const entry: AnchorEntry = {
    chainSeq: tip.chainSeq,
    rowHash: tip.rowHash,
    recordedAt: new Date().toISOString(),
    rowCount: tip.rowCount,
  };

  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
  return entry;
}

/**
 * Reads every entry from an anchor file, in on-disk order — which, because
 * this file is only ever appended to (never rewritten or truncated), is
 * also true chronological recording order. A blank line (in particular,
 * the trailing newline `recordAnchor` always leaves after the last entry)
 * is silently skipped; any other malformed line (invalid JSON) throws
 * immediately — an anchor file an operator is relying on to detect
 * tampering should fail loud on corruption, never silently drop an entry.
 * Throws a clear, specific error if `filePath` does not exist at all,
 * rather than letting Node's raw `ENOENT` surface unexplained.
 */
export async function readAnchorFile(filePath: string): Promise<AnchorEntry[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`anchor file not found: ${filePath}`, { cause: err });
    }
    throw err;
  }

  const entries: AnchorEntry[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`anchor file ${filePath}: line ${i + 1} is not valid JSON — ${line}`);
    }
    const record = parsed as Partial<AnchorEntry>;
    if (
      typeof record.chainSeq !== 'string' ||
      typeof record.rowHash !== 'string' ||
      typeof record.recordedAt !== 'string' ||
      typeof record.rowCount !== 'number'
    ) {
      throw new Error(
        `anchor file ${filePath}: line ${i + 1} is not a valid anchor entry — ${line}`,
      );
    }
    entries.push({
      chainSeq: record.chainSeq,
      rowHash: record.rowHash,
      recordedAt: record.recordedAt,
      rowCount: record.rowCount,
    });
  }
  return entries;
}
