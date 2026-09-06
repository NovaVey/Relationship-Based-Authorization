-- The reverse-lookup accelerant for `listObjects` (`docs/DECISIONS.md`
-- D-175, `docs/REVERSE-LOOKUP-PROPOSAL.md`) — one new secondary index on
-- the existing `relation_membership_index` table (migration `0010`, D-163).
-- No new table, no new column: this reads the identical rows the Leopard
-- index's own forward lookup already reads, just in the other direction.
--
-- All five columns of the table's own primary key, reordered subject-first
-- and kept in full (not a partial prefix): the query this index serves
-- (`fetchReverseIndexCandidates`, `src/store/relation-index.ts`) constrains
-- `subject_ns`, `subject_id`, `relation`, and `object_ns` by equality and
-- needs `object_id` back, in ascending order, capped by a `limit` — every
-- one of those needs is answered by this index alone (an index-only scan;
-- `object_id`'s own ascending order falls out of the index's own key order
-- for a fixed four-column prefix, no separate sort). Applying this
-- migration on a deployment that never enables `LEOPARD_INDEX_ENABLED`
-- costs one more empty index on an already-empty table — the same "no-op
-- beyond storage" framing migration `0010`'s own comment already gives for
-- this table's existing index.
create index relation_membership_index_subject_idx
  on relation_membership_index (subject_ns, subject_id, relation, object_ns, object_id);
