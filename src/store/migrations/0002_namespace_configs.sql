-- §4's namespace_configs — the published, versioned record of what
-- src/schema/dsl/compiler.ts compiled. This lands in Phase 2 (not batched
-- with 0001) because it's the table a tuple write actually validates
-- against (see src/schema/dsl/types.ts's own doc comment: "src/store/
-- (Phase 2) validates tuple writes against NamespaceConfig.relations") —
-- `authz tuple write` needs a real "what does this namespace actually
-- declare" to check against, or it can only ever accept writes on faith.
-- `checks` (Phase 6) and `soundness_runs` (Phase 5) still wait for their
-- own phase — nothing in Phase 2 reads or writes either.
create table namespace_configs (
  id           uuid primary key default gen_random_uuid(),
  namespace    text not null,
  version      int not null,
  config       jsonb not null,
  source_dsl   text not null,
  created_at   timestamptz not null default now(),
  unique (namespace, version)
);

-- A tuple write always validates against the *latest* published version
-- for a namespace — this is the lookup that needs to be fast.
create index namespace_configs_latest on namespace_configs (namespace, version desc);
