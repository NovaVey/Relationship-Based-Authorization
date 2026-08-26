-- A hash-chained `checks` audit log (post-audit improvement): every row
-- inserted from now on carries `prev_hash` (the row_hash of whatever row
-- immediately precedes it in the chain) and `row_hash` (a SHA-256 hex
-- digest covering this row's own recorded fields, chained onto
-- `prev_hash`) — see `src/audit/checks.ts`'s own top-of-file doc comment
-- for the exact canonical serialization this hashes, the exact
-- serialization order, and the genesis constant the very first chained
-- row's `prev_hash` is fixed to. `authz audit verify`
-- (`src/cli/commands/audit.ts`) walks the chain in order and recomputes
-- every row_hash fresh from what's actually stored, reporting the first
-- row where the stored and recomputed hash disagree.
--
-- **What this catches, and what it plainly does NOT — stated here, not
-- glossed over.** An `UPDATE` against any already-committed row's
-- recorded fields (or against its own stored `row_hash`) makes that row's
-- stored hash disagree with a fresh recomputation, and — because every
-- later row's own `prev_hash` still points at that row's now-wrong
-- `row_hash` — makes the chain fail to reverify from that point forward
-- too. That is genuine, real tamper-evidence: an operator running
-- `authz audit verify` finds out. What this does NOT provide is
-- tamper-PREVENTION: anyone with enough database privilege to run that
-- `UPDATE` in the first place can, in principle, also recompute and
-- rewrite every row_hash/prev_hash from the tampered row forward to make
-- the whole chain re-verify as intact again — this table has no way to
-- stop that on its own. Defending against a fully-rewritten chain would
-- need an anchor this database cannot provide by itself (e.g. periodically
-- publishing the current chain tip's row_hash somewhere outside this
-- database's own reach) — genuinely out of scope for this migration, not
-- silently assumed away.
--
-- **Why a third new column (`chain_seq`), not just the two the hash chain
-- itself needs.** A hash chain still needs an unambiguous, gap-tolerant
-- walk order to know which row is "the previous one" — and this table's
-- two existing candidates both fail that job once concurrent writers
-- exist. `id` is a random `uuid` (`gen_random_uuid()`, migration 0004) —
-- never ordered, so it cannot anchor a walk order at all. `checked_at`'s
-- default, `now()`, is fixed at this row's own TRANSACTION START (Postgres's
-- documented `now()`/`current_timestamp` semantics — see the Postgres
-- manual's "Current Date/Time" section), not at the moment its own INSERT
-- statement actually executes; under the very concurrent-write scenario
-- this hash chain has to stay correct under, a transaction that calls
-- `BEGIN` first but is then made to wait behind `CHECKS_HASH_CHAIN_LOCK_
-- CLASSID` (see `checks.ts`) can still commit its row SECOND, with a
-- `checked_at` value that reads EARLIER than the row that genuinely
-- preceded it in the chain — the identical `write_log.token`-allocation-
-- vs-commit-order failure mode `docs/DECISIONS.md` D-083 already found and
-- fixed for a different table. `chain_seq` closes the same gap here the
-- way D-083 closed it there: a genuine `bigint identity` column, whose
-- value is allocated at INSERT-statement-EXECUTION time — which, once
-- every `insertCheckRow` call is fully serialized by one global
-- transaction-scoped advisory lock (see `checks.ts`), happens in true,
-- unambiguous commit order, never merely "usually" ordered correctly.
alter table checks add column chain_seq bigint;
alter table checks add column prev_hash text;
alter table checks add column row_hash text;

-- Backfill `chain_seq` for every row that already existed before this
-- migration, in the best real ordering available for HISTORICAL data that
-- predates both this column and the serializing lock: (checked_at, id).
-- Disclosed, not hidden: two historical rows sharing the exact same
-- `checked_at` (the same transaction-start timestamp — e.g. two checks
-- that happened to run inside one already-open transaction, though nothing
-- in this codebase does that today) would fall back to `id`'s own random
-- uuid ordering to break the tie, which carries no real relationship to
-- which check actually happened first. This is a one-time, historical
-- backfill, not a live concurrency guarantee — every row inserted from this
-- migration forward gets its `chain_seq` from the identity sequence below,
-- which the "why chain_seq" note above establishes IS safe under real
-- concurrent writers.
with ordered as (
  select id, row_number() over (order by checked_at, id) as rn
  from checks
)
update checks
set chain_seq = ordered.rn
from ordered
where checks.id = ordered.id;

alter table checks alter column chain_seq set not null;

-- Promote chain_seq to a true identity column, exactly like
-- relation_tuples.id/write_log.id: Postgres owns the sequence and assigns
-- the next value automatically and atomically on every future insert,
-- instead of this codebase computing "the next number" itself (which would
-- reopen the exact race this column exists to close). Starts one past the
-- highest value the backfill above assigned, computed dynamically — never
-- hardcoded — so this migration is equally correct against a brand-new,
-- empty `checks` table (starts at 1) and a database with real history
-- (starts right after it, guaranteeing a fresh insert can never collide
-- with a backfilled value).
do $$
declare
  next_seq bigint;
begin
  select coalesce(max(chain_seq), 0) + 1 into next_seq from checks;
  execute format(
    'alter table checks alter column chain_seq add generated always as identity (start with %s)',
    next_seq
  );
end $$;

-- The lookup insertCheckRow's own locked critical section actually needs:
-- "the most recently chained row's own row_hash" — see checks.ts. Also
-- gives `authz audit verify` an efficient, definite walk order.
create unique index checks_chain_seq_unique on checks (chain_seq);

-- **`prev_hash`/`row_hash` are deliberately left NULL for every row that
-- existed before this migration — not retroactively computed.** Computing
-- a real historical hash here would mean re-implementing this project's
-- one canonical SHA-256 serialization (`src/audit/checks.ts`) a second
-- time in raw SQL (Postgres has no built-in SHA-256 without the `pgcrypto`
-- extension, which isn't installed anywhere else in this project and isn't
-- guaranteed available/grantable on every real Postgres host this project
-- might be deployed against) — a second, independently-maintained copy of
-- a correctness-critical algorithm that could silently drift from the
-- real one, for a one-time backfill that buys retroactive coverage of rows
-- nothing has ever claimed integrity over. `insertCheckRow`'s own
-- head-of-chain query (`select row_hash ... where row_hash is not null
-- order by chain_seq desc limit 1`) treats a NULL `row_hash` as "not part
-- of the chain," so the very first row inserted after this migration
-- correctly starts a brand-new chain from the documented genesis constant,
-- regardless of how many un-hashed legacy rows sit before it in
-- `chain_seq` order. Disclosed plainly: **this hash chain does not cover
-- any check performed before this migration ran** — only from here
-- forward. `authz audit verify` reports the count of chained (non-null
-- `row_hash`) rows it actually verified, never a total that silently
-- implies legacy rows were checked too.
