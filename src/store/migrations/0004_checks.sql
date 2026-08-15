-- §4's checks — the audit trail (Phase 6): every check this system ever
-- answers, allowed or denied, logged. `resolution_path` is populated only
-- when `allowed` is true (§6.7: "the exact evidence behind every allow" —
-- there is no meaningful path to record for a denial, only the absence of
-- one). This lands now, not before, because Phase 6 is the first thing
-- that writes to it — same "build a table only when the current phase
-- actually depends on it" discipline as 0002/0003 (docs/DECISIONS.md
-- D-016, D-028).
create table checks (
  id                 uuid primary key default gen_random_uuid(),
  subject_ns         text not null,
  subject_id         text not null,
  relation           text not null,
  object_ns          text not null,
  object_id          text not null,
  allowed            boolean not null,
  consistency_token  bigint,
  resolution_path    jsonb,
  depth              int not null,
  duration_ms        int,
  checked_at         timestamptz not null default now()
);

-- The lookup an audit trail actually needs: "every check ever logged
-- against this object", most recent first.
create index checks_by_object on checks (object_ns, object_id, checked_at desc);
-- "every check a given subject has ever made/been the target of a check
-- for", most recent first.
create index checks_by_subject on checks (subject_ns, subject_id, checked_at desc);
