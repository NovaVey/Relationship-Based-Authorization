-- §4's soundness_runs — the differential-fuzzing report (Phase 5). Lands
-- now, not before, because Phase 5 is the first thing that writes to it —
-- same "build a table only when the current phase actually depends on it"
-- discipline as 0002's namespace_configs (see docs/DECISIONS.md D-016).
create table soundness_runs (
  id                               uuid primary key default gen_random_uuid(),
  trigger                          text not null,             -- cli|ci|api
  pr_number                        int,
  graph_seed                       text not null,              -- reproducible byte-for-byte from this alone
  namespace_count                  int not null,
  tuple_count                      int not null,
  query_count                      int not null,
  false_grant_count                int not null default 0,     -- CRITICAL: engine allowed with no path
  false_deny_count                 int not null default 0,     -- engine denied despite a path existing
  critical_namespace_false_grants  int not null default 0,
  verdict                          text not null check (verdict in ('sound', 'unsound', 'insufficient_coverage')),
  divergences                      jsonb not null default '[]',
  computed_at                      timestamptz not null default now()
);

create index soundness_runs_computed_at on soundness_runs (computed_at desc);
