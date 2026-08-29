-- The Leopard index (Phase A) — `docs/LEOPARD-INDEX-PROPOSAL.md`'s own
-- `## Schema` section. Two tables, unconditionally created (matching this
-- project's existing convention — see `docs/LEOPARD-INDEX-PROPOSAL.md`'s own
-- "single, global, unconditionally-created pair of tables" framing): with
-- `LEOPARD_INDEX_ENABLED` unset, both tables sit empty and are never
-- queried; applying this migration on a deployment that never turns the
-- feature on is a no-op beyond two empty tables and their indexes.
--
-- `relation_membership_index_state`'s single row is the entire freshness
-- signal — one watermark for the whole index, not one per root and not one
-- per namespace, deliberately (see the proposal's own reasoning: a userset
-- edge can cross namespaces, and precise per-namespace dependency tracking
-- is its own soundness question kept out of scope for this phase).
-- `rebuild_started_at`/`rebuild_finished_at`/`row_count` describe the last
-- successfully published rebuild only — they are written and become visible
-- atomically, together with every `relation_membership_index` row, at the
-- rebuild's own single `COMMIT`.

create table relation_membership_index_state (
  id                   smallint primary key default 1,
  watermark_token      bigint not null default 0,
  rebuild_started_at   timestamptz,
  rebuild_finished_at  timestamptz,
  row_count            bigint not null default 0,
  constraint relation_membership_index_state_singleton check (id = 1)
);
insert into relation_membership_index_state (id) values (1);

-- One row per reachable (root, subject) pair — the flattened, ALLOW-only
-- membership closure. `via_path` uses the identical `ns:id#relation`
-- string-array encoding `FrontierRow.path` already uses
-- (`src/resolve/production/resolver.ts`), so it feeds `reconstructProof`
-- unmodified. `min_expires_at` is null iff no tuple on `via_path` carries
-- `expires_at` — re-checked against Postgres's own `now()` at lookup time,
-- never a boolean captured once at rebuild time.
create table relation_membership_index (
  object_ns       text not null,
  object_id       text not null,
  relation        text not null,
  subject_ns      text not null,
  subject_id      text not null,
  via_path        text[] not null,     -- same string encoding as FrontierRow.path
  min_expires_at  timestamptz,         -- null iff no tuple on via_path carries expires_at
  primary key (object_ns, object_id, relation, subject_ns, subject_id)
);
create index relation_membership_index_object_idx
  on relation_membership_index (object_ns, object_id, relation);
