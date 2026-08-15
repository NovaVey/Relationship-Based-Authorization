-- Phase 2 — the tuple store's own two tables (build spec §4). The other
-- three tables §4 defines (namespace_configs, checks, soundness_runs)
-- deliberately do NOT appear here — see docs/DECISIONS.md for why table
-- creation is scoped to the phase that first writes to a table, not batched
-- up front against the whole §4 data model at once.

-- A tuple is a fact: it exists or it's deleted, never edited in place.
create table relation_tuples (
  id                bigint generated always as identity primary key,
  object_ns         text not null,
  object_id         text not null,
  relation          text not null,
  subject_ns        text not null,
  subject_id        text not null,
  subject_relation  text,
  created_at        timestamptz not null default now()
);

-- §4 specifies this as a plain `unique (...)` table constraint, but Postgres
-- treats NULL as distinct from every other NULL — including itself — under
-- a standard UNIQUE constraint, so two identical "plain subject" tuples
-- (the common case: subject_relation IS NULL for every tuple that isn't a
-- tuple-to-userset subject) would NOT collide and the same fact could be
-- inserted twice as two distinct rows. That directly breaks §10's own
-- `writing-the-same-tuple-twice-is-idempotent-not-a-duplicate-row`
-- requirement for the overwhelming majority of real tuples. A unique index
-- over coalesce(subject_relation, '') closes that gap: '' is never a valid
-- identifier (every identifier must start with a letter — see
-- src/schema/dsl/types.ts's IDENTIFIER_PATTERN), so it's a safe sentinel
-- that can never collide with a real subject_relation value. See
-- docs/DECISIONS.md.
create unique index relation_tuples_unique_fact on relation_tuples (
  object_ns,
  object_id,
  relation,
  subject_ns,
  subject_id,
  coalesce(subject_relation, '')
);

-- The two directions a graph walk needs: "who has R on O" and "what does S have".
create index relation_tuples_by_object on relation_tuples (object_ns, object_id, relation);
create index relation_tuples_by_subject on relation_tuples (subject_ns, subject_id);

create table write_log (
  id            bigint generated always as identity primary key,
  -- The consistency token (build spec §6.3: "every write returns one
  -- (write_log.id, monotonic)"). Rather than a second independently-tracked
  -- counter that could ever drift from `id`, `token` is a generated column
  -- always equal to this row's own `id` — one source of truth, exposed
  -- under the name callers actually reason about ("pin to token N") without
  -- ever risking the two diverging. See docs/DECISIONS.md.
  token         bigint generated always as (id) stored,
  operation     text not null check (operation in ('write', 'delete')),
  tuple         jsonb not null,
  written_at    timestamptz not null default now()
);
