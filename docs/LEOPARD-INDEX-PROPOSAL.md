# The Leopard index — scope and design

**Status: built and shipped — `docs/DECISIONS.md` D-163.** This document
records the design as it was proposed, synthesized, and adversarially
reviewed on paper — the output of four independent design explorations
(storage/schema, resolver integration, soundness-proof extension,
operational surface), reconciled into one coherent proposal, then put
through this project's own "design → adversarial review → correct"
discipline (`docs/DECISIONS.md` D-140): a four-lens adversarial review
(soundness, fidelity to the real code, gaps in stated scope, test-plan
sufficiency) found real, independently-cross-validated defects in the
draft's own code samples and test plan — not style nits — and every
confirmed finding was corrected in place, disclosed inline at the point of
correction rather than silently smoothed over (search this file for
"Corrected here" and "adversarial review" to find each one). The code
below is left exactly as it was reasoned through on paper — it is a
faithful record of the design, not a mirror of the final shipped
implementation, which diverges in a small number of places (three found
live during implementation, disclosed in D-163 itself: a
`now()`-vs-`clock_timestamp()` bug in the rebuild's own operational
metadata, a missing `lockAcquired` signal, and — the most consequential —
a real transaction-poisoning gap in the "falls through unconditionally"
exception boundary, closed with a `SAVEPOINT`; a fourth found later by a
2026-08-29 documentation audit and disclosed here for the first time: this
proposal's own "Revisit if" section below left "should `ProductionCheckResult`
expose an index-hit diagnostic field" as an undecided alternative to the
source design's recommendation not to add one at all — the shipped code
silently resolved it by adding `WalkContext.indexHit`/`ProductionCheckResult.indexHit`,
none of the four changing this document's own schema or candidate-property
reasoning). Implementation, its own adversarial review, and live
fail-checking against real Postgres are complete — see D-163 for the full
account, every disclosed correction, and the exact verification record,
the same sequence `docs/DST-PROPOSAL.md` went through before it became
real, shipped code. Two further gaps between this document's stated intent
and what was actually built — a described `authz serve` background
refresh loop that was never wired up, and a described nightly-scale
three-way differential test that was never written — are disclosed inline
below, at the sections that described them, rather than only here.

## The problem this exists to name, not hide

Google's own Zanzibar paper spends real design effort on exactly one
performance problem: a `check` that has to walk a deeply or widely nested
group graph — "is `user:alice` a member of `group:eng`, which nests
`group:platform`, which nests `group:infra-oncall`, ..." — pays the full
cost of that walk on every single request, even though group membership
changes far less often than it's read. Zanzibar's answer is the _Leopard
index_: an offline-computed, periodically-refreshed materialization of
"every member reachable from this group," consulted as a fast path ahead
of the live graph walk, with a token-based staleness bound so a query
pinned to a specific point in the write history can trust a
not-perfectly-current materialization without ever seeing a wrong answer.

This project has exactly the same shape of problem, in miniature.
`sqlRelationMembershipWithWitness` (`src/resolve/production/resolver.ts`)
— "mechanism 2" in that file's own vocabulary — answers "is `subject` a
transitive member of the set `relation` grants on `object`?" with one
`WITH RECURSIVE` query per relation-level check, walking every
userset-subject tuple (`relation_tuples.subject_relation is not null`)
outward from `(object, relation)` up to `maxDepth`, with an exact,
lossless path-array cycle guard (`docs/DECISIONS.md` D-021/D-026). That
query is proven correct and proven to terminate (§6.4's own non-negotiable
— every claim in this codebase about mechanism 2's soundness rests on
`fetchReachableFrontier`'s cycle guard and depth ceiling, not on this
proposal). It is not proven _fast_ at every possible graph shape: a
group-nesting lattice with real depth or width pays real, repeated
recursive-query cost on every check that touches it, exactly the cost
Zanzibar's Leopard index exists to amortize.

**This project's own honest scope, stated the same way `docs/
CONSISTENCY.md` states it for the token model:** this runs on one
Postgres instance, not Zanzibar's globally-distributed Spanner deployment.
There is no cross-region replica lag to hide here, no zookie scheme to
approximate — the correctness question this design has to answer is
narrower and more tractable than Zanzibar's own: "can an offline,
periodically-rebuilt materialization ever let a _pinned_ check see a
result that ignores a write with token ≤ its own pin?" The answer this
proposal is built to make provably "no" to, not "probably not."

## How this design was chosen

Three genuinely different architectures were worked through in parallel
by independent design passes before this synthesis reconciled them into
one. This section states the real comparison and the real reasoning,
rather than presenting only the winning shape as though it were the only
one considered.

**1. A single flattened `relation_membership_index` table, one row per
`(object, relation, subject)` reachable pair, full-rebuild-plus-watermark,
no incremental maintenance — adopted as this proposal's v1 backbone.**
Every reachable _leaf subject_ is a materialized row, rebuilt from
scratch by one atomic transaction, gated for use by a single global
watermark token compared against the caller's own `atToken`. Simplest
correctness story of the three: the entire index is either "fresh enough
and this exact answer is real" or it's consulted not at all, with no
partial-freshness or per-node bookkeeping to get wrong. Costliest of the
three at rebuild time (full table recompute on every refresh, regardless
of how little actually changed) and structurally incompatible with
answering DENY soundly without more machinery (§"Candidate D," below) —
both accepted, explicitly, as the price of the smallest reviewable
surface for a v1.

**2. A node-reachability graph (which `(ns,id,relation)` _nodes_ are
reachable, not which leaf subjects) plus write-triggered dirty-marking and
incremental, per-node recompute — considered, and deferred, not adopted.**
This is a materially more sophisticated design: smaller steady-state
storage (node-level, not leaf-level, granularity), a write path that only
pays cost proportional to userset-edge churn rather than full-table
recompute, and a genuinely clever reuse of `write_log.token`'s own
monotonicity in place of a separate epoch counter for its publish-race
argument. It was designed carefully and its own risk disclosure is
honest: its central new mechanism — a reverse-edge walk from a changed
tuple up to every ancestor root that might need re-marking dirty — is
"new, untested, soundness-load-bearing logic with no existing precedent,"
unlike the forward frontier walk it mirrors, which has years of
adversarial review and D-100's own differential-equivalence suite behind
it. Building and proving that walk correct (a genuine, non-trivial
graph-algorithm correctness question — the "must not prune at an
unmaterialized intermediate node" rule this design itself flags as easy
to accidentally "optimize" away) is real, additional soundness-critical
work beyond what "a rebuildable snapshot plus a watermark, not fine-grained
incremental algebra" (this exercise's own stated scope) calls for. See
"Considered and deferred: incremental refresh," below, for the full
design and for which of its ideas this proposal keeps anyway.

**3. A hypothetical, fully Zanzibar-faithful compressed leaf index
(dense integer subject IDs, roaring-bitmap or `int8[]`-with-GIN posting
lists per root, membership-answering split from proof-reconstruction as
two separate concerns) — never designed in detail, deliberately.** This
is what a _real_ Leopard index looks like at Google's own scale: a
yes/no bitmap membership test with no path attached, because at that
scale even storing a `via_path` string array per member is too much. It
would need a new external dependency (`pg_roaringbitmap`, in tension with
this project's dependency-conservative, hand-written-SQL posture — `docs/
DECISIONS.md` D-004) or a materially less compact Postgres-native
substitute, and — more importantly — it changes the _contract_: a
compressed bitmap answers only "yes" or "no," never "here is the real
chain," so witness/disproof reconstruction on a hit would need its own,
separate, on-demand path, which this project's whole Phase 6 resolution-
path machinery (`ResolutionStep`, `reconstructProof`, the hash-chained
audit trail) is built around never needing. Rejected for v1 not because
it's a bad idea, but because it's a different, larger redesign than
"accelerate the existing mechanism, never change what a caller can
observe" — named here as a real future direction, not a hidden assumption
that today's design "obviously" scales into it.

**Why the flattened design (1), not the node-graph design (2), was
chosen as this proposal's backbone — the single most consequential call
in this document, stated plainly.** Storage's own node-graph design
rejected full leaf-level flattening for two reasons: (a) expiry — a
flattened member row is a durable claim about a specific subject that can
go stale from time alone, with no write to invalidate it, needing new,
untested `least(...)`-across-a-recursive-walk logic to track a minimum
expiry per materialized row; and (b) disproof reconstruction — a
flattened member-only table has none of the real tuple detail
`RelationDisproof`/`buildRelationDisproof` need to certify a DENY. Both
objections are real **for a design that also accelerates DENY**. Neither
applies to this proposal, because this proposal's own Phase A scope
(below) is deliberately **ALLOW-only**: an index hit only ever produces a
positive witness, so the disproof-reconstruction cost storage's design
correctly worried about is never paid, and the expiry problem — while
real — has a closed-form, already-precedented fix (`min_expires_at` per
row, re-checked against Postgres's own `now()` at lookup time; see
"Candidate G," below) that doesn't need a second materialized copy of
anything. The full leaf-level flattening storage's own design rejected as
too complex _for the design storage was building_ turns out to be the
_simpler_ option once the scope is narrowed to ALLOW-only — this is not a
case of one proposal being wrong, it's a case of two proposals correctly
solving differently-scoped problems, and this synthesis explicitly
narrows the scope to the one where the simpler design is sound.

## Scope: this is a "Phase A" proposal, not the whole feature

Explicitly, and by design, this proposal covers only:

- **Pinned checks** (`options.atToken` present). An unpinned check never
  consults the index at all in this phase — see "What this project
  deliberately does not claim," below, and "Revisit if" for why extending
  to unpinned checks is real, disclosed, separately-scoped future work,
  not something this design is unsound for lacking.
- **ALLOW-only acceleration.** An index lookup either returns a proven
  `allowed: true, certain: true` hit, or it is treated exactly like "the
  index doesn't exist" and control falls through to the real,
  byte-identical `sqlRelationMembershipWithWitness`. The index never
  produces an authoritative DENY.

Both restrictions exist because they let this phase avoid two
separately-hard problems: unpinned acceleration needs `productionCheck`
to acquire a _self-anchored_ floor for a check that doesn't have one
today (a real, disclosed change to `productionCheck`'s control flow, not
a purely additive one — see the resolver-integration section below for
exactly what this project's real code would need to grow to support it);
authoritative DENY needs a "root completeness" tracking mechanism (an
offline generalization of `depthCeilingGenuinelyBinding`'s own online
reasoning) that Phase A's ALLOW-only scope structurally does not need
(see "Candidate D," below, for exactly why).

**The D-158 → D-161 citation, corrected to what that chain actually
established, not stretched to cover more than it does.** The first draft
of this paragraph cited D-158 → D-159 → D-160 → D-161 as precedent for
"ship the safe, narrower subset first... and close the rest in
separately-reviewed follow-ups" — directionally right (that chain is a
real example of this project shipping a proven-safe fix while explicitly
disclosing, rather than silently ignoring, an adjacent unclosed risk),
but the analogy has a real disanalogy worth naming rather than papering
over. D-158's deferred piece was a _residual risk in an already-shipped
safety property_ — a second mechanism sharing one resolver's exact bug
shape, closed by D-159 the same day, then hardened by a permanent test
(D-160) and a fuzzer-coverage fix (D-161) shortly after. Phase B here is
not a same-day residual cleanup on a shipped guarantee; it is a
materially larger, unscheduled follow-on requiring genuinely new
machinery (Candidate D's "root completeness" tracker) with no existing
partial implementation and no committed timeline. The honest claim this
project's history actually supports is narrower: this project has a
demonstrated pattern of shipping a fully-proven subset and disclosing,
rather than silently omitting, what it deliberately left out — not a
guarantee that the left-out part closes quickly, which is what citing
D-158→D-161 without this caveat would imply.

## Schema

Next free migration slot, confirmed by listing `src/store/migrations/`
directly — the highest existing file is `0009_checks_certain.sql`:

```sql
-- migration 0010_relation_membership_index.sql

create table relation_membership_index_state (
  id                   smallint primary key default 1,
  watermark_token      bigint not null default 0,
  rebuild_started_at   timestamptz,
  rebuild_finished_at  timestamptz,
  row_count            bigint not null default 0,
  constraint relation_membership_index_state_singleton check (id = 1)
);
insert into relation_membership_index_state (id) values (1);

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
```

This is a single, global, unconditionally-created pair of tables
(matching this project's existing convention — `api_keys` exists after
migration whether or not any key is ever minted). With `LEOPARD_INDEX_
ENABLED` unset, both tables sit empty and are never queried; applying
this migration on a deployment that never turns the feature on is a
no-op beyond two empty tables and their indexes.

**`relation_membership_index_state`'s single row is the entire freshness
signal.** There is one watermark for the whole index, not one per root
and not one per namespace — deliberately, mirroring `cache.ts`'s own
"deliberately whole-cache, not scoped" `clear()` design, for the
identical stated reason: a userset edge can cross namespaces, and precise
per-namespace dependency tracking is its own soundness question this
phase keeps out of scope (see "Revisit if"). `rebuild_started_at`/
`rebuild_finished_at`/`row_count` describe the **last successfully
published rebuild only** — they are not a live "a rebuild is in progress
right now" signal, because they are written and become visible atomically,
together with every `relation_membership_index` row, at the same `COMMIT`
(see the rebuild mechanism, next). A concurrent reader cannot observe a
rebuild "in progress" via this table at all; the advisory lock described
under "Operational surface" is the only real-time "is a rebuild running"
signal, and it is a separate mechanism for a separate purpose.

## The rebuild: `rebuildRelationMembershipIndex`

`src/store/relation-index.ts` (new, sibling to `tuples.ts`/`tokens.ts`),
matching the operational surface's naming: brand name "Leopard index" in
docs/CLI, plain descriptive Postgres/TypeScript names everywhere in code
(`relation_membership_index`, `rebuildRelationMembershipIndex`,
`lookupRelationMembershipIndex`) — see "Operational surface" for why the
naming is split this way.

```ts
export async function rebuildRelationMembershipIndex(
  pool: ConnectionSource,
  opts?: { dryRun?: boolean },
): Promise<{ watermarkToken: number; rowCount: number; published: boolean }>;
```

One `BEGIN ISOLATION LEVEL REPEATABLE READ` transaction — **not**
`READ ONLY`, since this transaction writes its own output (the same
distinction `productionCheck`'s own `BEGIN ISOLATION LEVEL REPEATABLE
READ READ ONLY` makes, for the opposite reason) — running on its own,
dedicated pool connection, held for the transaction's entire life:

1. **First statement:** `select coalesce(max(token),0) as watermark from
write_log` — a new, separately-defined query sharing only the anchoring
   _discipline_ with `assertTokenObservedOnSnapshot`, not its literal SQL
   text. **Corrected here, not the same as first drafted**: the real
   `ANCHOR_QUERY_TEXT` constant (`resolver.ts`) is `'select max(token) as
max_token from write_log'` — a different string (no `coalesce`, a
   different column alias) — and it is a module-private `const`, never
   `export`ed, so it cannot actually be imported by a new
   `src/store/relation-index.ts` file without first widening
   `resolver.ts`'s own export surface, an undisclosed change this
   proposal's "`sqlRelationMembershipWithWitness` is never modified — not
   one line" framing does not cover. Two honest choices, not resolved
   here: either keep this as its own separate query (as shown) and accept
   the small, deliberate duplication, or export `ANCHOR_QUERY_TEXT` from
   `resolver.ts` and reuse it verbatim, handling the resulting `null` (on
   an empty `write_log`) explicitly instead of relying on `coalesce`.
2. One recursive CTE, the same shape as `fetchReachableFrontier`'s own
   (identical cycle guard — `not (edge = any(path))` — and identical live
   expiry filter, `rt.expires_at is null or rt.expires_at > now()`),
   batched over **every** `(object_ns, object_id, relation)` that appears
   in `relation_tuples` as a seed simultaneously (root columns threaded
   through the recursion; per-iteration `distinct on (root, reached-
identity)` dedup, generalizing this project's own existing D-092
   `DISTINCT ON` fix from "per reached identity" to "per (root,
   reached identity)"). **This per-iteration dedup is not a global one** —
   `fetchReachableFrontier`'s own doc comment states plainly that a node
   rediscovered at a later, unrelated depth can still appear more than
   once in the CTE's raw output, which is exactly why the _online_ path's
   `dedupeFrontier` exists as a required second pass, for correctness, not
   performance. Step 3, next, is where this rebuild's own equivalent
   second pass has to happen.
3. **The single most consequential correction the adversarial-review pass
   made to this section.** For every closure row whose reached
   `(ns, id, relation)` carries a real _plain_ tuple (`subject_relation is
null`), a candidate `(root, subject)` pair is produced — with `via_path`
   set to **exactly the closure row's own path column, unmodified, in the
   identical `ns:id#relation`-string-array shape `FrontierRow.path`
   already uses**. The first draft of this step described `via_path` as
   "the root's own path concatenated with the leaf hop" — **this was
   wrong**, caught by adversarial review against the real
   `reconstructProof`/`FrontierRow` contract: a path's terminal element is
   the frontier node carrying the matching plain tuple, never the subject
   itself (`reconstructProof(path, subject)` takes the subject as a
   wholly separate argument and never encodes it into the path array); an
   appended "leaf hop" would either throw inside
   `parseFrontierKeyString`'s strict format check or silently produce a
   structurally wrong proof tree, exactly the "phantom witness" class this
   project's own resolution-path machinery exists to rule out. Corrected:
   no element is ever appended for the subject — the subject is already
   fully captured by the row's own separate `subject_ns`/`subject_id`
   columns.

   **The second correction: more than one candidate row can legitimately
   compete for the same `(root, subject)` primary key, and the schema as
   originally drafted had no answer for this — adversarial review found
   the omission would crash the rebuild on ordinary data, not just edge
   cases.** Two independent, everyday sources of collision: the
   per-iteration dedup's own disclosed gap (above), and — the more
   fundamental one — two genuinely _different_ frontier nodes under the
   same root (two different nested groups, say) both carrying a plain
   tuple naming the identical subject, which is exactly the "diamond of
   diamonds" reconvergence shape D-092 itself was written to handle
   online. A bare `INSERT INTO relation_membership_index SELECT ...`
   against a table keyed on `(object_ns, object_id, relation, subject_ns,
subject_id)` raises a Postgres unique-violation and aborts the whole
   rebuild the first time any root has overlapping group membership — the
   ordinary case for the exact nested-group workload this index exists to
   accelerate. The fix must resolve this at the SQL level, keeping
   `via_path` and `min_expires_at` bound to one single winning candidate
   row, atomically, never independent aggregate expressions computed
   separately — the tempting `GROUP BY` "fix" (an arbitrary
   `(array_agg(via_path))[1]` alongside a separately computed
   `min(min_expires_at)`) would silently decouple a stored path from the
   expiry that is supposed to gate it, producing a `(via_path,
min_expires_at)` pair that never coexisted as one real witness — which
   none of Candidates C/F/G below would detect, because all three assume
   the stored row is one coherent, real, historically-accurate witness:

   ```sql
   insert into relation_membership_index (object_ns, object_id, relation, subject_ns, subject_id, via_path, min_expires_at)
   select distinct on (root_ns, root_id, root_relation, subject_ns, subject_id)
     root_ns, root_id, root_relation, subject_ns, subject_id, via_path, min_expires_at
   from candidate_rows
   order by root_ns, root_id, root_relation, subject_ns, subject_id, array_length(via_path, 1) asc;
   ```

   `order by ... array_length(via_path, 1) asc` picks the _shortest_ real
   candidate deterministically (never an arbitrary one), the same
   "shortest available, never fabricated" preference `fetchReachableFrontier`'s
   own BFS ordering already gives the live path online — matching, not
   merely resembling, the existing mechanism's own tie-break behavior. This
   fix is new, untested against real Postgres, and needs its own
   adversarial pass and live fail-check (two distinct groups both granting
   the same subject; confirm the resulting row's `via_path` and
   `min_expires_at` genuinely correspond to one real, coherent path) before
   it can be trusted — named explicitly in the test plan below, not left
   implicit.

4. `TRUNCATE relation_membership_index; INSERT INTO
relation_membership_index SELECT ...` inside the same transaction (a
   shadow-table-and-swap variant is a legitimate implementation choice
   for a large table — see the WAL/lock-blocking risk disclosed under
   "Operational surface" — but it is an implementation detail either way,
   never a soundness concern, because both variants publish atomically at
   the same `COMMIT`).
5. `UPDATE relation_membership_index_state SET watermark_token = <the
value read in step 1>, rebuild_finished_at = now(), row_count = ...`.
6. `COMMIT` (or, on `dryRun: true`, compute everything and `ROLLBACK` —
   matching `authz soundness run --dry-run`'s own "prove the claim, leave
   no trace" contract).

**No depth ceiling on this recursion, deliberately — reconciling a real
disagreement between two of the four source proposals.** One proposal
assumed the rebuild takes an optional `maxDepth`, "bigger than
`env.CHECK_MAX_DEPTH`, or the index would rarely help," without ever
specifying a default. A second proposal argued the offline computation
should carry **no** depth ceiling at all, relying solely on the exact,
lossless path-array cycle guard (D-021/D-026) — since the rebuild is not
on the request hot path, it can afford to run to true exhaustion, which
sidesteps needing an offline analogue of `depthCeilingGenuinelyBinding`
entirely. This proposal adopts the second: Phase A is ALLOW-only, so
"Candidate D" (below) already establishes that an under-populated root
from _any_ cause — including a depth cap — can only produce a safe false
miss, never a false hit; there is no `certain: false` case for a rebuild's
own truncation to reason about in this phase the way the online path's
ceiling has to. A generous, uncapped rebuild is therefore strictly
simpler with no soundness cost in Phase A, and this proposal takes it.
The one residual risk this accepts, not solves: an unbounded walk over a
pathological, very deep or very wide real graph could run long or exhaust
memory in a way the online path's ceiling exists specifically to prevent.
The recommended failure mode if that safety valve is ever needed: **fail
the whole run** (the transaction rolls back; the previous, still-valid
index and watermark are left completely untouched and keep serving) —
never silently truncate and risk quietly under-covering a root nobody
notices went stale in a new way. A purely practical, non-safety depth cap
(to stop the rebuild from materializing chains deeper than any real
caller's own `maxDepth` will ever accept — wasted storage, since
"Candidate F" below will always reject those rows anyway) may be worth
adding once real data justifies it; not decided here (see "Revisit if").

**Why this needs no epoch fence the way `cache.ts` does — restated
precisely, because the argument is genuinely different from the check
cache's, not just superficially similar.** `cache.ts`'s epoch fence exists
because the cache's write and a check's read are _not_ the same Postgres
transaction — `clear()` can run, and a stale in-flight check's own
`trySet` can still land _after_ it, re-poisoning a cache that was just
correctly emptied. Here, the watermark write and the flattened-table
write are **literally the same transaction, the same `COMMIT`**. No
external reader can ever observe `watermark_token = W` without also
observing every row this rebuild computed as-of `W`, and no external
reader can ever observe a partially-written table, because Postgres's own
transactional atomicity gives that guarantee for free. The rebuild needs
no analogue of `beginMiss`/`trySet`/an epoch counter — "read the
snapshot" and "durably publish it" are fused into one ACID unit, which an
in-memory `LruMap` cache structurally could never be. This is a load-
bearing structural difference from the cache precedent, not a coincidence
of implementation style, and it is the reason this design needs
materially less new machinery than `cache.ts` did to be safe.

## The lookup, and the integration point in `resolve()`

```ts
export interface RelationIndexHit {
  hit: true;
  allowed: true;
  certain: true;
  path: string[];                // via_path — straight into reconstructProof, unmodified
  touchedExpiringTuple: boolean; // min_expires_at was non-null (and still live, per the SQL below)
}
export type RelationIndexLookup = RelationIndexHit | { hit: false };

async function lookupRelationMembershipIndex(
  client: QueryExecutor,        // ctx.client — NEVER a second connection, see below
  object: EntityRef, relation: string, subject: EntityRef,
  maxDepth: number, requiredFloorToken: number,
): Promise<RelationIndexLookup> {
  const { rows: state } = await client.query<{ watermark_token: string }>(
    `select watermark_token from relation_membership_index_state where id = 1`);
  if (Number(state[0]?.watermark_token ?? 0) < requiredFloorToken) return { hit: false };

  const { rows } = await client.query<{ via_path: string[]; min_expires_at: Date | null }>(
    `select via_path, min_expires_at from relation_membership_index
      where object_ns=$1 and object_id=$2 and relation=$3
        and subject_ns=$4 and subject_id=$5
        and (min_expires_at is null or min_expires_at > now())`,   -- Postgres's own now(), not Node's
    [object.ns, object.id, relation, subject.ns, subject.id]);
  const row = rows[0];
  if (!row) return { hit: false };
  if (row.via_path.length - 1 > maxDepth) return { hit: false };   -- the CALLER's own depth budget
  return {
    hit: true,
    allowed: true,
    certain: true,
    path: row.via_path,
    // Sound precisely because a row surviving the WHERE clause above with a
    // non-null min_expires_at is, by construction, still live right now —
    // see the "adversarial review found a real bug here" note below.
    touchedExpiringTuple: row.min_expires_at !== null,
  };
}
```

**A real bug the adversarial review pass found in an earlier draft of this exact function — fixed here, disclosed rather than silently corrected.** The first version of this lookup selected only `via_path` and hardcoded `touchedExpiringTuple: false`. That one line would have quietly defeated the entire point of Candidate G below: `touchedExpiringTuple` is not a diagnostic field anywhere in this codebase — it is the _sole_ signal `src/audit/checks.ts`'s `performCheck` uses to decide whether an `allowed: true` result may ever enter the check-result cache (`docs/CONSISTENCY.md`'s own "the one place this needs special handling... the opt-in check-result cache" section, D-144). With the bug, an index-served ALLOW whose only real path passed through a still-live-but-expiring tuple would be wrongly reported as "never touched an expiring tuple," written into `CheckCache` (whenever `CHECK_CACHE_TTL_MS > 0`, an independent, already-shipped opt-in feature), and served from cache past that tuple's real `min_expires_at` for up to the cache's own TTL — reopening the exact D-144 "a deny with no corresponding write event" class of bug, through a code path Candidate G's own reasoning about the _index's own_ liveness re-check never examined, because the bug lived one layer downstream of it, in a completely separate consumer. The fix above is real and load-bearing, not cosmetic: `row.min_expires_at !== null` at this point in the function is sound only because the row already survived the `min_expires_at is null or min_expires_at > now()` predicate in the same query — this must remain a single atomic condition read from the same row, never split into two separate queries that could observe two different instants of `now()`.

**`sqlRelationMembershipWithWitness` is never modified — not its
signature, not its body, not one line.** This is deliberate and load-
bearing: one source design proposed threading a new `leopardIndexFloor`
parameter through `sqlRelationMembershipWithWitness` itself and splicing
an index-sourced frontier into the same downstream match/disproof
pipeline the live CTE feeds. This proposal adopts the simpler of the two
real designs instead: the index lookup is a strictly-earlier,
side-effect-free short-circuit **entirely outside**
`sqlRelationMembershipWithWitness`, called from `resolve()`'s relation
branch:

```ts
// resolver.ts — resolve()'s relation branch, real code shown for context
// (current lines ~652-670), new block marked
const relation = config.relations[name];
if (relation) {
  const remainingDepth = Math.max(0, ctx.maxDepth - depth);

  // NEW — Leopard index short-circuit. ctx.relationIndexFloor is
  // undefined whenever this check is unpinned or the feature is off; in
  // either case this whole block is skipped and behavior below is
  // byte-identical to today.
  if (ctx.relationIndexFloor !== undefined) {
    // A thrown exception here — a transient error scoped to the two new
    // tables, lock contention with a concurrent `authz leopard refresh`'s
    // own TRUNCATE, or (should the previous bug's class recur) a malformed
    // row reaching `reconstructProof` — must never fail the whole check.
    // Adversarial review found the first draft of this block had no such
    // boundary: an uncaught throw here would propagate straight through
    // `resolve()`/`evalRewrite()` and fail a check that the live CTE alone
    // would have answered correctly, which is strictly worse than the
    // feature being off — the opposite of "purely additive." `try`/`catch`
    // here is not a defensive nicety, it is what makes "a miss, for any
    // reason at all, falls through unconditionally" — asserted five times
    // elsewhere in this document — actually true rather than true only for
    // the three explicit `{hit:false}` returns.
    let idx: RelationIndexLookup;
    try {
      idx = await lookupRelationMembershipIndex(
        ctx.client,
        object,
        name,
        subject,
        remainingDepth,
        ctx.relationIndexFloor,
      );
    } catch {
      idx = { hit: false }; // logged/counted elsewhere, never re-thrown
    }
    if (idx.hit) {
      ctx.depthReached.value = Math.max(ctx.depthReached.value, idx.path.length - 1);
      ctx.touchedExpiringTuple.value ||= idx.touchedExpiringTuple;
      return { allowed: true, certain: true, proof: reconstructProof(idx.path, subject) };
    }
    // miss, for any reason at all — fall through, unconditionally.
  }

  const sqlOutcome = await sqlRelationMembershipWithWitness(
    ctx.client,
    object,
    name,
    subject,
    remainingDepth, // <-- unchanged signature, unchanged call
  );
  ctx.depthReached.value = Math.max(ctx.depthReached.value, sqlOutcome.depthReached);
  ctx.touchedExpiringTuple.value ||= sqlOutcome.touchedExpiringTuple;
  return sqlOutcome.allowed
    ? { allowed: true, certain: true, proof: sqlOutcome.proof }
    : { allowed: false, certain: sqlOutcome.certain, disproof: sqlOutcome.disproof };
}
```

**One trivial addition to `WalkContext` this proposal states precisely,
rather than glossing over.** The brief this synthesis was given frames
Phase A's scope (pinned-only, `atToken` reused directly) as needing "zero
new fields on `WalkContext`." Verified directly against the real
`resolver.ts`: that is very nearly true, but not quite exactly true, and
the imprecision matters enough to name rather than silently paper over.
`WalkContext` today carries no `atToken` at all — it is a local variable
inside `productionCheck`, never threaded into the walk, because nothing
before this proposal ever needed it there. For `resolve()`'s relation
branch to know (a) whether _this specific check_ was pinned at all, and
(b) what floor to require, `atToken`'s value has to reach it somehow.
The minimal, honest way to do that is one new field —
`WalkContext.relationIndexFloor: number | undefined` — populated exactly
once, in `productionCheck`, as a direct passthrough of a value it already
has in hand:

```ts
const relationIndexFloor =
  (options?.useRelationIndex ?? env.LEOPARD_INDEX_ENABLED === 'true') && atToken !== undefined
    ? atToken
    : undefined;

const ctx: WalkContext = {
  client: guardedClient,
  maxDepth,
  schemaCache: new Map(),
  depthReached,
  touchedExpiringTuple,
  relationIndexFloor, // NEW
};
```

This is a straight passthrough of a value `productionCheck` already
computed, added the same way `maxDepth` itself is already threaded onto
`WalkContext` — **not** a new query, **not** a new computed quantity, and
**not** a change to `productionCheck`'s existing `if (atToken !==
undefined) { ... }` pinned/unpinned branching structure, which stays
byte-for-byte as it is today. It is materially smaller than the
alternative design's own `leopardIndexFloor`, which required a genuinely
new computed value (including a whole new self-anchoring helper function
for the unpinned case) — this field carries only an already-known
constant, never derived, never re-queried. Calling this out explicitly,
rather than asserting "zero new fields" as if it were literally true, is
exactly the kind of precision an adversarial reviewer needs and the kind
this project's own documentation culture already insists on.
`ProductionCheckOptions.useRelationIndex?: boolean` is also new — a
per-call override of `env.LEOPARD_INDEX_ENABLED`, matching the exact
established precedent `maxDepth` itself already sets on that same
interface ("tests use this to force a budget... without a global env
mutation") — needed by the test plan below to force `'cold'`/`'warm'`
comparison runs deterministically.

### Why a caller can never observe an ALLOWED/DENIED difference between the two paths

This argument was worked out precisely by the source design that proposed
the more elaborate (frontier-splicing) integration mechanism, and it
transfers to this proposal's simpler mechanism close to verbatim — it is
restated here rather than re-derived, because it was already argued well:

1. **All-or-nothing trust, never partial.** `lookupRelationMembershipIndex`
   returns either a hit proven equivalent-enough for this exact call
   (fresh token-wise, and covering this call's own depth budget), or a
   miss — there is no code path where an index result is merged with, or
   preferred over, a partial live computation. A call goes 100% through
   the index-served path or 100% through the unchanged live path.
2. **The freshness gate is the same token machinery `docs/CONSISTENCY.md`
   already guarantees, applied at least as conservatively as the existing
   pinned-check floor.** The index can never be trusted for a call whose
   own contractual floor (`atToken`) it hasn't reached — precisely
   `cache.ts`'s "a pinned result is safe forever because the floor was
   proven observed at computation time" argument, applied to a
   materialized index instead of a memoized answer.
3. **The depth-coverage gate ("Candidate F," below) ensures the index is
   never trusted to represent a search shallower than this specific
   call's own `maxDepth`/`remainingDepth`** — the same reasoning
   `depthCeilingGenuinelyBinding` already applies online: only a result at
   exactly the caller's own ceiling can hide real reachability, so
   anything longer than the caller asked for must fall back, never assert
   a length-mismatch DENY.
4. **Under this proposal's simpler mechanism, a HIT never reaches
   `sqlRelationMembershipWithWitness`'s downstream match/disproof code at
   all — and that is exactly as safe as reaching it would be, for a
   different but equally solid reason.** An index-hit ALLOW is not a
   guess produced by new, parallel logic; it is a materialized instance of
   the exact same class of positive witness the live path itself produces
   — a real `via_path` array, computed once, offline, by literally the
   same recursive-query shape `fetchReachableFrontier` uses online, fed
   through the identical, unmodified `reconstructProof`. A MISS, for any
   reason, runs zero new code at all: it falls through to the byte-
   identical existing `sqlRelationMembershipWithWitness` call, whose own
   `certain` computation (`depthCeilingGenuinelyBinding`) is untouched.
   There is no code path where the terminal ALLOW/DENY decision is
   computed by anything other than either (a) a verified, real, offline
   witness, or (b) the exact existing online mechanism.
5. **Only latency differs.** The index path replaces one potentially-
   expensive recursive `WITH RECURSIVE` walk with two small point lookups
   (a single-row state check, a primary-key/covering-index lookup) — the
   `ProductionOutcome`/`ProductionCheckResult` shapes require zero
   changes either way.

**One honest, disclosed numeric imprecision, not an `allowed`/`certain`
imprecision.** `ProductionCheckResult.depth` on an index-accelerated
ALLOW reflects only the winning `via_path`'s own length, not the full
frontier's own high-water mark the way a live call's `depthReached`
would (`sqlRelationMembershipWithWitness` reports the deepest node
examined across the _whole_ walk, not just the winning row). This can
make `depth` slightly lower on an index hit than an equivalent live call
would have reported. This is the identical, already-disclosed reasoning
one of the source designs gives for its own mechanism: `depth`, unlike
`allowed`/`certain`, "was never claimed to be bit-identical, only
semantically honest" — a diagnostic field, never an authorization input,
and never affected by which path answered the check.

### `certain` threading

- **Index-hit ALLOW:** `certain: true`, always. This follows directly
  from this file's own existing, load-bearing invariant — "a positive
  result is only ever produced from a real, verified fact... never from
  an unresolved branch." An index hit _is_ a real fact (a concrete
  `via_path` through real, rebuild-time tuples), exactly as legitimate a
  witness as an online `FrontierRow.path`.
- **Miss, for any reason:** calls the literal, byte-identical
  `sqlRelationMembershipWithWitness`, whose `certain` computation
  (`depthCeilingGenuinelyBinding`) is never touched. This is the
  strongest available argument for "`certain` is preserved correctly on
  the fallback path": there is no new reasoning to verify there at all,
  because there is no new code on it — the D-158/D-159 proofs continue to
  apply unconditionally.

## Candidate properties, adversarially reviewed

Following this project's own D-140 discipline (design candidates,
adversarially reviewed one at a time, corrected or dismissed before
anything is trusted) — five properties, lettered to match the source
design's own numbering (B is a Phase-B-only mirror of A, named for
completeness but not elaborated, since Phase A never produces an
index-served DENY at all).

**Candidate A — "An index-hit ALLOW must replay on the live CTE."** For
any query where `lookupRelationMembershipIndex` returns a hit, re-running
the real, unmodified `sqlRelationMembershipWithWitness` pinned to
`atToken := watermark_token` must also return `allowed: true`.
_Adversarial review:_ `atToken` is a **floor, not an exact pin**
(`resolver.ts`'s own doc comment, restated in `docs/CONSISTENCY.md`) — a
comparison check pinned to `watermark_token` is not guaranteed to see
_nothing_ beyond it; its own `REPEATABLE READ` snapshot anchors wherever
its first query happens to land, which could be strictly later than the
rebuild's own anchor. A concurrent write landing in that gap could make
the comparison check ALLOW for a different, coincidental reason, silently
weakening the property (never falsely failing a sound implementation, but
capable of _masking_ a real rebuild bug in a live-traffic setting).
**Fix:** run this property only inside a static fixture with **zero
writes between the rebuild and the comparison batch** — exactly this
project's own established fuzz-harness shape. Under that discipline the
floor and "the actual state" coincide exactly, and the imprecision is
structurally eliminated inside the test even though it's correctly
disclosed as a real, harmless-direction property of the underlying
mechanism. _Verdict: survives, narrowed._

**Candidate B — "An index-hit DENY (Phase B only) must replay on the
live CTE."** Mirror of A for the authoritative-DENY case; same
floor-vs-pin caveat, same fix. _Verdict: gated to Phase B — not required,
and not built, here._

**Candidate C — "Watermark staleness must never produce a false ALLOW."
The single most load-bearing property in this document.** Build a
fixture, rebuild the index (`watermark_token = W`), then issue a real
revocation whose write token `> W`. Check pinned to `atToken := T ≥` the
revocation's token. Correct behavior: `watermark_token (W) < T` ⇒
`lookupRelationMembershipIndex` returns `{hit:false}` ⇒ fallback to the
live CTE ⇒ `DENIED`. **Fail-check:** bypass the `watermark_token >=
requiredFloorToken` comparison (force `hit:true` from the now-stale index
regardless of freshness) and confirm the same pinned check now reports
`allowed:true` — a live, reproduced false grant. Restore the guard,
reconfirm `DENIED`. This is the literal, executable version of "an
index-backed ALLOW going stale is a live false grant," and it must be
reproduced live, not merely reasoned through, per this project's own
D-158/D-159/D-092 discipline. _Adversarial review:_ none found — this is
the property the whole design exists to satisfy. **This is the one test
that must exist, live-reproduced, before anything ships.**

**Candidate D — "Root incompleteness must never produce a false ALLOW or
false DENY."** _Adversarial review found this unnecessary for Phase A_:
an incomplete rebuild — from a depth cap, an early failure, anything —
can only **under**-populate a root's flattened set; the recursive CTE
never invents an edge or a member that isn't real. Since Phase A only
ever consults the index to accelerate ALLOW, an incomplete root simply
produces `{hit:false}` for the member it missed (correctly falling back),
never a wrong `hit:true`. **Completeness tracking is required only once
Phase B adds authoritative DENY-from-index** — there, an incomplete
root's _absence_ of a row would otherwise be wrongly promoted to a
certain DENY, exactly the shape `depthCeilingGenuinelyBinding` already
exists to catch online. _Verdict: correctly, deliberately descoped from
Phase A — not silently dropped, and named precisely for when Phase B
needs it (a `relation_membership_index_roots(..., complete)` table,
computed the same batched way `depthCeilingGenuinelyBinding` is today,
with its own live-bypass fail-check before it can be trusted)._

**Candidate F — "An index hit must respect the calling check's own
`maxDepth`, not just whatever depth the rebuild happened to reach."
Found by adversarial review, not in the original ask — genuinely
important.** A caller can request a _smaller_ `maxDepth` per check than
whatever the rebuild materialized — `resolver.ts`'s own doc comment
states `maxDepth` exists specifically so tests can force a budget the
depth ceiling itself can't quietly absorb a missing cycle guard into. If
`lookupRelationMembershipIndex` serves a stored `via_path` longer than
the caller's own `maxDepth`, it silently overrides that caller's
explicit, narrower budget — a new, independent unsoundness axis,
orthogonal to watermark staleness: perfectly fresh, perfectly correct-
as-of-now, and still a false grant relative to what the caller asked for.
**This is not hypothetical for this codebase**: this project's own
D-159/D-160/D-161 battery of tests works by _deliberately shrinking_
`maxDepth` to force mechanism 2's ceiling — shipping this design without
the depth-length gate would immediately regress every one of those tests
into reporting false grants the moment the index is turned on.
**Fix, already folded into the lookup above:** `row.via_path.length - 1 >
maxDepth ⇒ {hit:false}`. A caller requesting a smaller `maxDepth` than
the stored path's real length always falls back to the live CTE (which
may or may not find a _shorter_ real path — the stored path is real but
not necessarily shortest — so falling back, never asserting DENY from the
length mismatch, is the only safe move). **Fail-check:** bypass the
length gate; rebuild with no depth cap (per this proposal's own §"The
rebuild"); run a check pinned to `maxDepth: 3` against a subject only
reachable at depth 5 through the index's stored path; confirm it now
wrongly reports `ALLOWED`, while the same check with the index off (or
empty) correctly reports `DENIED` at its own ceiling. _Verdict: survives,
and is added to the must-ship set even though it wasn't in the original
ask — it is exactly the same shape of bug this project's own D-159 found
for the online mechanism, recurring here in the offline one._

**Candidate G — "An index-hit ALLOW must never survive past a stored
path's own real expiry, independent of watermark freshness." Found by
adversarial review — a recurrence of this project's own D-144 blind
spot.** `docs/CONSISTENCY.md` is explicit that "the token model says
nothing about when an expiry takes effect" — an expiry produces **no
write-log entry at all**, so **no watermark check, however fresh, can
ever detect it**. A flattened row computed from a tuple that was live at
rebuild time but expires before the _next_ rebuild would otherwise be
served as an ALLOW for that entire gap — a false-grant vector structurally
invisible to Candidate C's mechanism, and arguably more dangerous than
the check-cache's own analogous D-144 gap, because the index's effective
lifetime (until the next rebuild) can be far longer than
`CHECK_CACHE_TTL_MS`. **Fix:** store `min_expires_at` per row (already in
the schema above) and re-validate it **in SQL, using Postgres's own
transaction-pinned `now()`**, at lookup time — not a boolean captured
once at rebuild time, and not Node's `Date.now()` (a third, independently-
drifting clock that would be a real, disclosed inconsistency with this
project's own established "one `now()` for every read in this
transaction" discipline). This is actually a _stronger_ guarantee than
the check-cache gets: the cache can only refuse to cache (a boolean),
while the index can re-derive liveness cheaply, live, every lookup.
**Fail-check:** build a 'valid'-expiring tuple (reusing `GeneratedTuple`'s
existing `expiryKind` marker from `src/soundness/generators.ts`, turned
into a real timestamp by `runner.ts`'s own `EXPIRY_MARGIN_MS` — corrected
here: `EXPIRY_MARGIN_MS` is `runner.ts`'s constant, not `generators.ts`'s;
`generators.ts` only carries the seed-derived `'expired' | 'valid'` kind
marker and cross-references `runner.ts` for the actual arithmetic, never
defines the margin itself), rebuild the index (captures a non-null
`min_expires_at`), backdate that tuple via the exact raw-SQL `UPDATE`
pattern `runner.ts`'s own `backdateExpiringTuples` already uses (no
write-log entry, by design), confirm the lookup now correctly misses;
bypass the `min_expires_at` predicate and confirm it wrongly hits.
_Verdict: survives, must-ship for Phase A — this is not optional, since
Phase A's very selling point ("ALLOW-only, safe by construction") is
false without it._

**Candidate reviewed-and-dismissed — "A schema republish could
invalidate the index without a tuple write."** Checked directly:
`fetchReachableFrontier`'s SQL never consults `NamespaceConfig` at all —
mechanism 2's transitive closure is a pure function of `relation_tuples`
rows, independent of what the current schema declares. A republish that
renames a relation or changes declared subject types does not
retroactively alter historical tuple rows, so it cannot change the
closure the index materializes, for exactly the same reason it's already
a non-issue for the online mechanism today. No new property needed;
recorded here so it isn't silently unconsidered.

## Considered and deferred: incremental refresh

The node-reachability-graph design summarized under "How this design was
chosen" (comparison #2) deserves a fuller, faithful description here,
because it is a genuinely well-reasoned alternative, its own author's
risk disclosure is honest about exactly where it's unproven, and several
of its ideas are worth keeping even though its central mechanism is not
adopted for v1.

**The design.** Materialize only the _node-reachability graph_ — which
`(ns, id, relation)` nodes are reachable from a root, literally
`FrontierRow`'s own shape, persisted in a table keyed by root
(`userset_closure_frontier`) — plus a small per-root watermark/dirty-
scheduling table (`userset_closure_nodes`, with a generated `is_dirty`
column derived from comparing `computed_at_token` against
`last_dirtied_token`). Every check that hits the index still does one
live join against current `relation_tuples` to resolve the actual leaf-
subject match, the disproof certificate, and expiry — reusing
`fetchTuplesOnFrontier`/`buildRelationDisproof`/`depthCeilingGenuinelyBinding`/
`reconstructProof` completely unchanged (this requires extracting a
`decideMembershipFromFrontier` helper out of the tail of
`sqlRelationMembershipWithWitness`, itself a real, if small, change this
proposal's own "never modify `sqlRelationMembershipWithWitness`" rule
avoids). Freshness for pinned checks is a direct transplant of
`cache.ts`'s own "a floor-sufficient snapshot is safe forever" argument
(`computed_at_token >= atToken`); for unpinned checks, a Postgres-resident
`is_dirty` bit is read directly — a genuine structural improvement over
the check-result cache's own in-process, cross-process-blind epoch
mechanism, since every replica sees the same dirty bit the instant the
write that set it commits.

Refresh is **write-triggered dirty-marking**: `writeTuple`/`deleteTuple`
enqueue an O(1) row into a transactional outbox
(`userset_closure_dirty_queue`) whenever a _userset-edge_ tuple
(`subject_relation is not null`) is written or deleted — a plain-grant
write never touches this mechanism at all, a real and meaningful
efficiency property, since plain grants are almost certainly the dominant
write volume in a real deployment. A background worker drains the
outbox via a **reverse-edge walk** — the mirror image of
`fetchReachableFrontier`'s own forward walk, following `relation_tuples`
backward from a changed node up to every ancestor root within a depth
ceiling, marking each dirty. Lazy-on-miss materialization and a
background sweep (prioritized by `last_used_at`) keep hot nodes warm
under real traffic without ever proactively materializing the full node
universe.

**Why this is not adopted for v1, in the design's own words, not
softened.** Its own author disclosed, plainly: _"The reverse-edge dirty-
marking walk is new, untested, soundness-load-bearing logic with no
existing precedent — unlike the forward `fetchReachableFrontier` query,
which has D-100's differential-equivalence suite and years of adversarial
review, this reverse walk has none yet."_ Getting it wrong has a
disclosed, specific failure shape: the design itself names a rule that
"must not be optimized away" — the reverse walk must traverse the entire
ancestor graph regardless of whether an intermediate ancestor happens to
be materialized, because pruning at an unmaterialized intermediate node
can silently leave a materialized, more distant ancestor's frontier
un-dirtied forever, with nothing to ever detect it. This is exactly the
kind of subtle, easy-to-regress correctness rule this project's own
`fetchReachableFrontier` needed a `DISTINCT ON` fix and years of
adversarial testing to trust — building and proving its reverse-direction
mirror correct is real, substantial, separately-scoped work, genuinely
larger than "a rebuildable snapshot plus a watermark" (this exercise's
own stated scope). The design's own second disclosed gap — the UPSERT
race-closing arithmetic that reuses `write_log.token` monotonicity in
place of a separate epoch counter — is "reasoned through carefully but
not proven the way `cache.ts`'s epoch fence was (a dedicated deterministic
test) or D-092/D-097 were (live, repeated reproduction under real
concurrent load)." Both gaps are real, both are honestly disclosed by the
design that proposed them, and both are exactly the kind of new,
unverified, correctness-critical mechanism this synthesis was directed
not to adopt in place of the simpler design.

**What is kept anyway — three risk mitigations that apply just as well to
the simpler, adopted design, named here even though the mechanism they
came from is not being built:**

1. **The O(V²) worst-case warning, restated for the flattened design.**
   The node-graph design names this plainly: "a densely cross-linked
   lattice of N group nodes... can produce close to O(N²) rows... node-
   level granularity only improves the typical-case constant factor, not
   the asymptotic class." The adopted design flattens all the way to leaf
   subjects, which has a _larger_ constant factor for the identical
   worst case — the same warning applies, more so, to
   `relation_membership_index`. This is disclosed here explicitly, not
   discovered later: a genuinely pathological, densely-nested-group real
   deployment could see this table grow large enough that rebuild cost and
   steady-state size both become real operational concerns this proposal
   has no real numbers to bound (no fixture in this repo today is large
   enough to be informative).
2. **Lazy, on-demand population instead of eagerly indexing every root.**
   The adopted design's default rebuild (§"The rebuild") seeds from
   _every_ `(object_ns, object_id, relation)` that appears anywhere in
   `relation_tuples` — correct and simple, but potentially wasteful if
   most roots are never actually the target of a pinned check. A future
   refinement worth naming, not designed in detail here: restrict the
   rebuild's own seed set to roots that have actually been consulted
   (e.g., a lightweight side-table populated by
   `lookupRelationMembershipIndex`'s own miss path, or a simpler
   heuristic such as "referenced by a write in the last N days"),
   trading some rebuild-cycle latency on a cold root's first check for a
   materially smaller table in the common case where most roots are cold.
3. **A per-root size cutoff.** The node-graph design's own
   `materializeClosureNode` checks a discovered frontier's size before
   inserting, and permanently skips materializing a root whose reachable
   set exceeds a configured cutoff — routing that specific pathological
   root to the online path forever rather than paying its storage cost
   for a set a single check would rarely need in full. This applies
   identically to the flattened design: an analogous
   `LEOPARD_INDEX_MAX_ROWS_PER_ROOT` cutoff, checked before a root's rows
   are inserted in step 3 of the rebuild, is a cheap, always-safe
   mitigation (skipping a root is exactly as safe as any other index
   miss) worth adopting the moment real data shows this matters, not
   speculatively built now.

## Test plan — the third comparison arm

The differential-fuzz harness (`test/isolation/differential-soundness.fuzz.
integration.test.ts`, `src/soundness/{generators,runner,classify}.ts`)
today compares two engines: production against the reference resolver.
This proposal adds a **third arm that compares production against
itself** — the same engine, with the index on versus off — because the
question "did the index change what this call returns" is a different
question from "does production agree with the independent oracle," and
conflating them would blur exactly the distinction `docs/DECISIONS.md`
D-006 already insists on keeping sharp for `false_grant` vs `false_deny`.

**No new base-case generator is needed.** `generateFixture`'s existing
guaranteed shapes — the self-referential group (D-021), the deep
hierarchy chain (D-070), the exclusion-cutoff deep chain (D-161) — are
already exactly mechanism 2's own domain (nested userset-subject
membership) and are reused unmodified.

**What's new:**

- **`src/store/relation-index.ts`** (new) — `rebuildRelationMembershipIndex`,
  `lookupRelationMembershipIndex` (the latter may instead live directly
  in `resolver.ts`, next to `sqlRelationMembershipWithWitness`, if
  keeping the whole read-path decision in one file is preferred at
  implementation time — an internal organization choice, not a soundness
  one).
- **`migrations/0010_relation_membership_index.sql`** (new).
- **`src/soundness/classify-index.ts`** (new, small, pure, mirrors
  `classify.ts`'s own shape) — see below.
- **`ProductionCheckOptions.useRelationIndex?: boolean`** (new field).
- **`runner.ts`: `SoundnessRunOptions.relationIndex?: 'off' | 'cold' |
'warm'`** (new, default `'off'` — the harness's default behavior is
  byte-for-byte unchanged when omitted, matching this project's universal
  opt-in convention).

  **Critical precondition, found by adversarial review and stated once
  here rather than folded quietly into each bullet below: this entire
  comparison arm only means anything for _pinned_ checks.** Phase A's
  index lookup is gated behind `ctx.relationIndexFloor !== undefined`,
  which `resolve()` only ever sets from `productionCheck`'s own `atToken
!== undefined` branch (see "The lookup, and the integration point in
  `resolve()`," above). `checkAllQueries` as it exists in this codebase
  today calls `productionCheck(pool, ..., { maxDepth })` with **no
  `atToken` at all** — every query the differential-fuzz harness has ever
  run is, and always has been, unpinned. Left exactly as first drafted, a
  `'cold'` or `'warm'` run would never set `relationIndexFloor`,
  `resolve()` would never reach the `useRelationIndex` check,
  `lookupRelationMembershipIndex` would never be invoked once, and
  `indexQueriesHit` would read `0` on every single run — not because the
  index correctly missed, but because the harness never gave it a chance
  to be consulted at all. That would make the entire `'warm'` verification
  mode silently vacuous: it would report `SOUND` forever while testing
  nothing this proposal actually built, exactly the class of gap this
  project's own D-140 `totalAllowed0True > 0` non-vacuity fix exists to
  catch, recurring here one level up (a vacuous _mode_, not a vacuous
  _assertion_ within an already-exercised mode).

  **The fix:** `checkAllQueries` gains a new parameter, `pinToken?:
number`, threaded through only when `relationIndex !== 'off'`, and every
  `productionCheck` call it makes then also passes `atToken: pinToken`.
  `runSoundnessFuzz`'s own top-level orchestration computes `pinToken`
  once, after the fixture's tuples are written, via a plain `select
max(token) as max_token from write_log` issued on the harness's own
  pool — the same query _text_ `resolver.ts`'s private `ANCHOR_QUERY_TEXT`
  uses, declared separately in `runner.ts` rather than imported (see this
  proposal's own disclosure under "The rebuild" on exactly why
  `ANCHOR_QUERY_TEXT` cannot be imported without widening `resolver.ts`'s
  export surface — the same two-honest-choices tradeoff applies here,
  and this plan makes the same choice: a small, deliberate duplication of
  the query text, not a new export). For `'warm'`, `pinToken` is not an
  independently-computed value at all — it is set to exactly the
  `watermarkToken` `rebuildRelationMembershipIndex` itself already
  returned, so "pinned to the rebuild's own watermark" and "pinned to the
  harness's own anchor" are the same call, not two numbers that merely
  happen to agree.

  - `'off'` — today's exact code path, nothing new touched, no `pinToken`
    computed or passed.
  - `'cold'` — `useRelationIndex: true` **and** `atToken: pinToken` (the
    fixture's own post-write anchor token) passed to _every_
    `productionCheck` call, but `rebuildRelationMembershipIndex` is never
    invoked for this fixture, so `relationIndexFloor` is genuinely set,
    `lookupRelationMembershipIndex` is genuinely reached on every call,
    and it genuinely misses (empty state row, `watermark_token = 0 <
pinToken`) — the executed, not merely inspected, proof of "a
    deployment that turns the flag on but has never rebuilt is provably
    unaffected," now actually exercising the guarded code path rather than
    skipping it via an unset `relationIndexFloor`.
  - `'warm'` — after the fixture's tuples are written,
    `rebuildRelationMembershipIndex(pool)` is called once, with **zero
    writes afterward** (Candidate A's own precondition); `pinToken :=`
    that call's own returned `watermarkToken`. `checkAllQueries` then
    calls `productionCheck` **twice** per query, both calls passing the
    identical `atToken: pinToken` — once with `useRelationIndex: false`
    (`productionAllowed`, today's exact field) and once with
    `useRelationIndex: true` (`productionIndexAllowed`, new) — against the
    identical snapshot, now literally true (same pinned floor, zero
    interleaved writes) rather than merely true in practice because
    nothing happened to change in between. `CheckedQuery` gains
    `productionIndexAllowed?`, `productionIndexPath?`,
    `productionIndexCertain?`, populated only when `relationIndex !==
'off'`. **Whether the two calls run sequentially or concurrently
    (`Promise.all`) within a query is an implementation choice, not a
    soundness one, and is made explicit here rather than left
    unspecified: sequentially.** Both read the same already-committed,
    already-static snapshot, so ordering cannot change either result —
    but running them concurrently would silently double
    `checkAllQueries`'s own per-batch connection demand precisely when
    `relationIndex !== 'off'`, re-opening the same class of pool-pressure
    hazard D-140/D-142/D-143 already had to close once, for a different
    caller. Sequential avoids reopening it without needing a new argument
    for why this specific doubling is safe.

- **`classify-index.ts`** — deliberately **not** a reuse of
  `classifyResult` (which is keyed to "the reference resolver is the
  oracle, production might diverge from it"); here _both_ sides are
  `productionCheck`, differing only in `useRelationIndex`.
  `classifyIndexDivergence({ productionAllowed, productionIndexAllowed, ...
})`:
  - `false → true` ⇒ **`index_false_grant`** — must be zero, ever; blocks
    the run's verdict exactly like a critical `false_grant` does today
    (never merely a warning).
  - `true → false` ⇒ **`index_false_deny`** — recorded and reported,
    never blocking on its own (the explicitly accepted safe direction),
    but still surfaced: a design bug that silently defeats the whole
    point of the index (an overly-conservative depth or expiry gate)
    deserves visibility even though it's harmless.
  - agree ⇒ no record (expected majority).
- **`SoundnessRunResult`** gains `indexFalseGrantCount`,
  `indexFalseDenyCount`, `indexQueriesHit` — the last a non-vacuity
  counter, mirroring this project's own D-140 `totalAllowed0True > 0`
  fix for exactly this class of gap: a `'warm'` run that happens to hit
  the index zero times must not silently report "sound." `computeVerdict`
  gains `indexFalseGrantCount === 0` as an additional, independent,
  unconditionally-blocking gate — never folded into `falseGrantCount`
  itself, since the two measure different things (agreement with an
  independent oracle, versus agreement with the same engine's own
  unaccelerated path). **For `relationIndex: 'warm'` specifically,
  `computeVerdict` also gates on `indexQueriesHit > 0`, unconditionally
  blocking** — the direct, executable answer to the `atToken`-pinning gap
  disclosed above: even with `pinToken` wired correctly today, a future
  edit that accidentally stops threading it through (a refactor of
  `checkAllQueries`'s signature, say) must not be able to silently regress
  back into the vacuous mode this fix closes. For `'cold'`, the mirror
  assertion is the opposite and equally load-bearing: `indexQueriesHit`
  **must equal `0`** — any nonzero count there would mean a `'cold'` run
  is, contrary to its whole premise, actually building or consulting real
  index state, which would itself be a bug in the test harness, not the
  index.

**File-by-file — what's extended, what's wholly new, and why two specific
files are deliberately left untouched:**

**A second gap, found by the same adversarial-review pass, not yet named
in any row below: nothing in this plan as first drafted actually exercises
the rebuild's atomic-publish claim against a real, concurrently-reading
Postgres instance while a rebuild is genuinely in flight.** "The rebuild:
`rebuildRelationMembershipIndex`," above, argues atomicity structurally
(one transaction, `TRUNCATE`+`INSERT`+the state `UPDATE`, one `COMMIT`) —
a correct argument, but this project's own standing discipline, set by
D-142/D-143, is that a structural argument about concurrent behavior gets
a real, live concurrency test before it is trusted, not instead of one
(D-142's own framing: "genuine OS-level... concurrency against a real,
listening server, distinct from — not a replacement for — DST's
deterministic single-process fault injection"). A new row below closes
this the same way.

| File                                                                                                                           | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/isolation/differential-soundness.fuzz.integration.test.ts`                                                               | **Extended**: a sibling describe block reruns the same fixture/queries with `relationIndex: 'cold'`, asserting `indexFalseGrantCount === 0` and `indexQueriesHit === 0` — the always-on, PR-speed proof that the feature-off-equivalent path is provably inert.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| (new, nightly-scale, mirroring the existing PR-vs-nightly split) — **never built (found by a 2026-08-29 documentation audit)** | **Planned but not shipped.** A `relationIndex: 'warm'` full three-way run, many seeds, asserting `indexQueriesHit > 0` (the non-vacuity gate above) alongside `indexFalseGrantCount === 0`, was intended here as a nightly-scale sibling to the PR-speed `'cold'` block. No such file or CI job exists — grepping every test file and `.github/workflows/soundness.yml` for `relationIndex` finds only the `'cold'` block below and the separate `relation-index-soundness.integration.test.ts` sweep (which calls `productionCheck` directly, not `runSoundnessFuzz`'s `'warm'` mode, and isn't nightly-scale). D-163's own "Test suite, per the design doc's own file-by-file plan" account never disclosed this row as cut. **This gap is real, disclosed here rather than silently dropped, and is legitimate future work**, not something this correction builds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `test/metamorphic/exclusion-subtract-unprovable-cut.integration.test.ts`                                                       | **Extended, not replaced**: its existing seeded fixtures re-run with the index warmed at a rebuild depth _larger_ than the property's own deliberately-small pinned `maxDepth`, with `atToken` pinned to the rebuild's own watermark (see the `pinToken` fix above — this file's own checks must adopt it too, or this row silently inherits the same vacuity gap) — this file already hand-built exactly the "one hop past the certain boundary" shape Candidate F needs, making it the single most valuable reuse in this plan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `test/unit/resolve/production/snapshot-anchor-invariant.test.ts`                                                               | **Extended, lightly — and named honestly as lightweight.** Confirms only that `lookupRelationMembershipIndex`'s own call signature takes `ctx.client`, never a second pool connection — a static, argument-shape check, not a runtime proof that no second connection is ever opened under real concurrent load. That stronger, load-bearing proof is the new real-Postgres concurrency test below; this row is its fast, DB-free companion, not a substitute for it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `test/unit/store/dst/production-check.dst.test.ts`, `token-pin-coverage.dst.test.ts`                                           | **Deliberately not touched.** Their pause-point statement-count constants are already fragile — D-143's own history is literally "shifted every offset by one" when one new query was inserted into the pinned client's real statement sequence. Since this proposal gates the index lookup behind `ctx.relationIndexFloor !== undefined`, and these two files exercise the existing pinned/unpinned statement sequences with the feature off (`env.LEOPARD_INDEX_ENABLED` unset in their fixtures), no new statement is inserted into the sequence they count — but this must be confirmed, not assumed, the moment the real code exists, exactly the kind of silent-narrowing risk D-143 itself found the hard way.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `test/unit/store/dst/relation-index-watermark.dst.test.ts` (new)                                                               | Hand-written fake `QueryExecutor` (same pattern as `snapshot-anchor-invariant.test.ts`) driving `lookupRelationMembershipIndex` directly with canned `relation_membership_index_state`/`relation_membership_index` rows — the fast, DB-free, permanent regression guard for Candidates C, F, G's decision logic once each is confirmed real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `test/unit/store/relation-index.integration.test.ts` (new, real Postgres)                                                      | The file that actually **reproduces** Candidates C, F, G live end-to-end (real rebuild, real revoke/backdate, real `productionCheck`) — the LOCALVERIFY-grade proof; the DST file above is its fast-suite-safe permanent pin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `test/metamorphic/relation-index-soundness.integration.test.ts` (new)                                                          | The Candidate A/B sweep — many random seeds via the existing `generateFixture`, `relationIndex: 'warm'`, zero interleaved writes, asserting every index hit replays on the live CTE pinned to the rebuild's own watermark.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `test/isolation/relation-index-concurrent-rebuild.integration.test.ts` (new, real Postgres, D-142-style)                       | **New — closes the atomic-publish gap named above.** A real, unmodified Postgres instance; a rebuild deliberately widened (a large-enough fixture that the `TRUNCATE`+`INSERT` window is naturally wide, rather than an artificial `pg_sleep` injected into shipped code) running concurrently, via genuine `Promise.all`-driven parallelism, with many real pinned `productionCheck({ useRelationIndex: true, atToken })` calls firing throughout the rebuild's transaction lifetime. Three assertions, none of them merely structural: (1) every call that returns during the rebuild's open transaction window reflects either the fully-old or fully-new index content — never a torn mix (a `via_path` from the new generation paired with the old watermark, or vice versa) — the atomic-publish claim, reproduced live against real Postgres, not only reasoned from `COMMIT` semantics; (2) no call ever throws past the exception boundary this proposal's `resolve()` integration already adds (a lock-wait timeout or serialization failure mid-`TRUNCATE` must be caught and treated as `{hit:false}`, never surfaced to the caller) — confirming that boundary actually covers this specific, real hazard, not only the hypothetical ones it was written against; (3) measures and reports the actual observed call-latency impact under a realistic table size, since `TRUNCATE` takes Postgres's `ACCESS EXCLUSIVE` lock and concurrent readers of `relation_membership_index` may genuinely **block** (not error) for the rebuild's duration — this is the "Lock-blocking risk," below, made executable rather than left as an unverified assumption. |

## Operational surface

**Naming, reconciled deliberately.** "Leopard index" is the human-facing
brand name — the doc title above, the CLI command group, the env var
prefix — matching this project's own established pattern of a plain-
language name in prose and docs while the actual SQL tables and
TypeScript symbols stay descriptive, never a codename
(`sqlRelationMembershipWithWitness`, not some internal project name, is
the precedent). The schema and functions above use exactly that
convention: `relation_membership_index`, `relation_membership_index_state`,
`rebuildRelationMembershipIndex`, `lookupRelationMembershipIndex` — never
`leopard_*` in code, only in the CLI surface and docs that follow.

### Env vars (`src/config/env.ts`)

```ts
// Leopard-style nested-group membership index (opt-in) — accelerates
// mechanism 2 (sqlRelationMembershipWithWitness) for PINNED checks only
// in this phase. 'false' (the default) means resolve() never consults
// the index tables at all.
LEOPARD_INDEX_ENABLED: optionalEnum(z.enum(['true', 'false']).default('false')),

// Reserved for Phase B (unpinned-check acceleration) — has NO effect in
// this phase, disclosed explicitly rather than silently implying it
// already does something: Phase A never consults the index for an
// unpinned check at all (see "Scope," above), so there is no
// TTL-bounded staleness for this value to gate yet. Defined now anyway,
// in the same schema, the same way this project's own NODE_ENV field is
// shipped and explicitly disclosed as "currently informational only"
// ahead of the day something actually reads it.
LEOPARD_INDEX_MAX_STALENESS_MS: optionalNumber(z.coerce.number().int().nonnegative().default(30_000)),

// >0 makes `authz serve` run its own background refresh loop at this
// interval, in addition to (never instead of) any external scheduler an
// operator also has running `authz leopard refresh` — both funnel
// through the same advisory-lock-guarded rebuild, so layering both is
// safe, only possibly redundant. 0 (the default) means `authz serve`
// never triggers a rebuild on its own.
LEOPARD_INDEX_REFRESH_INTERVAL_MS: optionalNumber(z.coerce.number().int().nonnegative().default(0)),
```

`LEOPARD_INDEX_ENABLED` uses `optionalEnum(z.enum(['true','false'])...)`
— the exact existing convention `NODE_ENV`/`LOG_LEVEL` already use in
this file — rather than inventing a new boolean-coercion helper `env.ts`
doesn't have today. `.env.example` gets the matching three blank-default
lines with the same "leave this to pick up the default" comment
convention every other optional var already uses.

### CLI (`src/cli/index.ts`, new `src/cli/commands/leopard.ts`)

A new top-level command group, matching the `audit`/`apikey`/`soundness`
group pattern exactly:

```
authz leopard refresh [--dry-run] [--format <text|json>]
authz leopard status  [--format <text|json>]
```

**`authz leopard refresh` is runnable regardless of `LEOPARD_INDEX_
ENABLED`** — deliberately not gated on the flag, which is what makes
"pre-warm before enabling" possible (below). A concurrent-refresh guard
uses a dedicated, distinctly-keyed transaction-scoped advisory lock
(`pg_try_advisory_xact_lock`), a fresh classid distinct from **all four**
of this project's existing lock users, named exhaustively here rather
than partially, since an incomplete list is exactly the kind of gap that
lets a future fifth lock silently collide: `WRITE_LOG_LOCK_CLASSID`
(`src/store/tuples.ts`), `MIGRATIONS_LOCK_CLASSID` (`'migr'`,
`src/store/migrate.ts`), `CHECKS_HASH_CHAIN_LOCK_CLASSID` (`0x6863686e`,
`'hchn'`, `src/audit/checks.ts`), and `publish.ts`'s own
`pg_advisory_xact_lock(hashtext($1))` call — a `hashtext`-keyed lock
rather than a fixed `classid`, so it occupies a different, effectively
non-colliding keyspace by construction rather than needing its own
reserved constant. A new `LEOPARD_REFRESH_LOCK_CLASSID` would follow the
same fixed-int, ASCII-tag convention the first three already establish
(`'wlog'`/`'migr'`/`'hchn'`) — something like `'lprd'`.

**Corrected here, not the same as first drafted: this is not "the same
mechanism `acquireWriteLogLock` already establishes," and claiming so was
an overstatement caught by adversarial review.** Every existing advisory
lock in this codebase — `acquireWriteLogLock`'s own `pg_advisory_xact_lock`
(`src/store/tuples.ts`), `publish.ts`'s `pg_advisory_xact_lock(hashtext($1))`,
and `CHECKS_HASH_CHAIN_LOCK_CLASSID`'s lock (`src/audit/checks.ts`) — uses
the **blocking** form: the caller waits until the lock becomes available,
never fails fast. `pg_try_advisory_xact_lock` is a genuinely different
primitive — it returns a boolean immediately, succeeding or failing
without ever waiting — and this proposal is the first place in this
codebase that would use it. Nothing about that makes it the wrong choice
here (a refresh that printed "skipped, already running" only after
waiting out someone else's multi-minute rebuild would be a strange UX,
and the blocking form would produce exactly that), but the document
should say plainly that this is a new pattern being introduced, not an
existing one being reused — the same honesty this file already applies to
`ANCHOR_QUERY_TEXT` and `via_path`'s shape, above. `grep -rn
"pg_try_advisory" src/` returns nothing today; this proposal would be the
first hit. **Release timing on an ungraceful crash, disclosed rather
than left implicit:** a transaction-scoped advisory lock
(`pg_try_advisory_xact_lock`, as opposed to the session-scoped
`pg_advisory_lock` `publish.ts` uses nowhere and this proposal doesn't
either) is released by Postgres automatically at the holding
transaction's end for _any_ reason — a normal `COMMIT`/`ROLLBACK`, or the
backend connection simply dying (process kill, OOM, a crashed
container) — because the lock is tied to the transaction, not to any
application-level cleanup code ever running. A refresh that crashes
mid-rebuild therefore never leaves an orphaned lock behind for a future
`refresh` invocation to hang on; the only externally-visible effect is
that the crashed attempt's own changes were never committed, so the
previous, still-valid watermark and rows are left completely untouched —
exactly the same "failed rebuild rolls back, previous state keeps
serving" property already described above, now stated for the crash case
specifically rather than only the caught-exception case.
A refresh already in flight makes a second `refresh` invocation print
"skipped — a refresh is already running" and exit 0 (an idempotent
no-op, not a failure). This proposal deliberately does **not** add a
persisted run-history table (one source design proposed `leopard_index_
runs`, tracking `status`/`trigger`/`error_message` across every past
attempt) — the mandated schema's own `relation_membership_index_state`
already carries everything `status` needs to report about the _last
successful_ rebuild, and a **failed** rebuild's transaction simply rolls
back, leaving the previous, still-valid watermark and rows completely
untouched; the CLI reports a failure directly from the exception at
invocation time (non-zero exit, a printed message), not from a persisted
status column. A richer run-history table is a reasonable future
refinement (see "Revisit if") but is not part of this proposal's own
schema.

**`authz leopard status` — three states, matching the design this
synthesis draws its CLI surface from:**

```
# disabled
Leopard index: DISABLED (LEOPARD_INDEX_ENABLED=false) — every check uses the live resolver only.

# enabled, never built
Leopard index: ENABLED, but no rebuild has ever completed.
Every check currently falls back to the live resolver — this is safe, never wrong, only slower.
Run `authz leopard refresh` (or wait for the configured interval/cron) to build it.

# enabled, built
Leopard index: ENABLED
Last complete rebuild: 2026-08-29T14:02:19.667Z (42s ago)
Watermark: write_log token 118402
Current write_log token: 118405 (index is 3 writes behind — expected between rebuilds)
Pinned checks: usable whenever their own atToken <= 118402, regardless of wall-clock age.
Unpinned checks: never consult this index in this phase — always the live resolver (Phase B).
```

The "enabled, built" example above is adjusted from the source design it
draws from in one place: that design's own example line ("Unpinned-check
staleness budget: ...") described a capability this phase does not build
(unpinned acceleration is Phase B, per "Scope," above) — reworded here to
state plainly what actually happens in this phase, rather than describing
a knob (`LEOPARD_INDEX_MAX_STALENESS_MS`) that has no effect yet.
`--format json` exposes `watermarkToken`, `currentWriteLogToken`,
`finishedAt`, `stalenessMs` for a monitoring script to alert on directly.

**Exit codes**, matching this project's per-command-table convention:

- `refresh`: `0` = completed (including a dry run, and including
  "skipped, already running"); `2` = malformed `--format`; `3` =
  infrastructure failure (DB unreachable, the rebuild query itself
  errored — the previous state is left untouched and keeps serving).
- `status`: `0` = ran fine (reports state regardless of what that state
  is — staleness is not this command's own failure); `2` = malformed
  `--format`; `3` = infrastructure failure.

### Refresh trigger — recommendation

**v1 recommendation: CLI-triggered, operator-scheduled (external cron),
with the in-process interval available but off by default.** No
synchronous post-write hook. Reasoning, in brief: `serve.ts` today does
exactly three things (build the server, listen, handle signals) — there
is no existing precedent anywhere in this codebase for background work
living inside the API process, and a multi-second-to-minute rebuild
transaction competing for a pool connection against `PG_POOL_MAX` is
exactly the class of connection-exhaustion hazard this project already
had to fix once, for a different reason, at D-140/D-142/D-143. Zanzibar's
own Leopard index is itself described as an offline batch job,
deliberately decoupled from the online serving path — external cron is
the more faithful analog, not a deviation from the precedent this
document opens by citing. The optional in-process interval
(`LEOPARD_INDEX_REFRESH_INTERVAL_MS`) was recommended for a deployment
that doesn't want to stand up a separate cron at all, both triggers
calling the same function under the same advisory lock so layering both
would be safe, only possibly redundant.

**As actually built: only the external-cron half of this recommendation
shipped (found by a 2026-08-29 documentation audit).** `LEOPARD_INDEX_REFRESH_INTERVAL_MS`
is parsed and validated by `env.ts` but read nowhere else in the codebase
— `authz serve` never starts a background timer regardless of its value.
The variable is live dead configuration today, not the "optional
in-process interval" this section and the zero-impact checklist below
describe as already available. External cron (or a direct, manual `authz
leopard refresh`) is the only refresh mechanism that actually exists.
Building the in-process interval remains legitimate future work, not a
bug in what shipped — but it was never disclosed as cut, which this
correction fixes.

### The rebuild transaction's real cost — disclosed, not solved

**WAL/vacuum-bloat risk.** The rebuild's `REPEATABLE READ` transaction
holds one snapshot open for however long the full closure computation
takes — during that whole window, Postgres cannot vacuum away any row
version newer than that snapshot **anywhere in the database**, not only
in the index's own tables. On a write-heavy deployment, an infrequent but
long rebuild could measurably worsen bloat/vacuum pressure system-wide.
This is exactly why this proposal recommends operator-scheduled (cron),
not high-frequency automatic, refresh: an operator who schedules this
during a known low-traffic window controls the blast radius; an
aggressive default interval would not.

**Lock-blocking risk during the rebuild's own publish step — found by
applying one source design's own blue/green reasoning to this proposal's
single-table schema, not directly proposed by any of the four source
designs in this exact form, so named here explicitly as this synthesis's
own addition.** `TRUNCATE` takes an `ACCESS EXCLUSIVE` lock on the table,
held until `COMMIT`. If the rebuild's `TRUNCATE relation_membership_index;
INSERT ...` (step 4, above) is implemented literally in-place, every
concurrent `productionCheck` call's own `SELECT` against
`relation_membership_index` blocks, waiting for that lock, for the
rebuild's **entire** duration — not indefinitely (it resolves the moment
the rebuild commits, and nothing here creates a circular wait the way
D-140's connection-exhaustion deadlock did), but for however long the
whole-table recompute takes, which could be the same seconds-to-minutes
range as the WAL-bloat risk above. One source design's alternative
(publish via two physically separate tables and an atomically-flipped
"active buffer" pointer, so `TRUNCATE`'s lock only ever falls on the
table nobody is currently reading) avoids this entirely, at the cost of
2x storage and a genuinely different schema than the one this proposal's
own mandate specifies (a single canonical `relation_membership_index`
table). This proposal does **not** adopt the two-table schema — it keeps
the single canonical table the schema section specifies — but discloses
the lock-blocking cost plainly rather than silently, and recommends the
same mitigation as the WAL-bloat risk (schedule rebuilds during low-
traffic windows). A shadow-table-and-rename variant that preserves the
single canonical _name_ while avoiding the lock-blocking window (build
into a new physical table, then rename it into place) is a legitimate
future refinement, named in "Revisit if," not built here.

### Pre-warm-before-enabling — recommended sequence

Every check falls back to the live resolver until a rebuild completes —
by construction, not a special case (a never-built index has no
`relation_membership_index_state` row with a real watermark, so the
freshness comparison in `lookupRelationMembershipIndex` fails closed to
`{hit:false}` unconditionally). Recommended sequence, stated explicitly
so it can be cited directly by an operator or a future README/DECISIONS
entry: deploy the code with `LEOPARD_INDEX_ENABLED` still `false` → run
`authz leopard refresh` once (safe regardless of the flag, since
`refresh` isn't gated on it) → confirm with `authz leopard status` → only
then flip `LEOPARD_INDEX_ENABLED=true` and restart. Done in that order,
the empty-index fallback window never happens in production at all;
doing it in the "wrong" order (flag first) is still fully safe, just
slower until the first rebuild lands — the fallback is the safety net for
that path, not the recommended one.

### Zero-impact-when-off checklist

| Surface                                          | Behavior with `LEOPARD_INDEX_ENABLED` unset/false                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve()` / `sqlRelationMembershipWithWitness` | `ctx.relationIndexFloor` is always `undefined`; the new block in `resolve()`'s relation branch is never entered; `sqlRelationMembershipWithWitness` itself is never modified. No new query, no new pool connection, no new code path executed.                                                                                                                               |
| `authz serve`                                    | No background timer is ever created. `LEOPARD_INDEX_REFRESH_INTERVAL_MS` is parsed and validated by `env.ts` but consulted nowhere else in the codebase, regardless of `LEOPARD_INDEX_ENABLED` — the in-process interval described above under "Refresh trigger" was never actually wired up; see that section's own correction (found by a 2026-08-29 documentation audit). |
| `authz doctor`                                   | A proposed new status line is itself gated on `LEOPARD_INDEX_ENABLED === 'true'` — a disabled deployment's `doctor` output is byte-for-byte what it is today.                                                                                                                                                                                                                |
| `.env.example` / `env.ts`                        | Three new blank-default lines; `EnvSchema.safeParse` accepts a `.env` with none of the three present, exactly as today.                                                                                                                                                                                                                                                      |
| Migrations                                       | The two new tables exist (per this project's unconditional-migration convention) but are never written to or read from — zero storage growth beyond two empty tables and their indexes.                                                                                                                                                                                      |
| `authz leopard refresh`/`status`                 | Exist and are runnable, but are opt-in _actions_ an operator must invoke; running them with the flag off is harmless (a rebuild can be pre-warmed) and produces no effect on any check either way.                                                                                                                                                                           |

## What this project deliberately does not claim

Mirroring `docs/CONSISTENCY.md`'s own such section, plainly:

- **This does not accelerate DENY in v1.** Every negative answer still
  pays the full cost of the online CTE. This is deliberate — see
  "Candidate D" — and likely gives up a meaningful share of Zanzibar's
  own real-world Leopard-index benefit (accelerating "no" as confidently
  as "yes"), traded for a materially smaller, more defensible soundness
  surface.
- **This does not accelerate unpinned checks in v1.** An unpinned check
  never consults the index in this phase, full stop — not "rarely," not
  "only when stale," never.
- **This is not true incremental single-edge maintenance.** The rebuild
  recomputes the _entire_ flattened closure from scratch every time it
  runs; freshness is a function of how often something chooses to call
  `rebuildRelationMembershipIndex`, never of individual writes. The
  node-graph design considered and deferred above is what real
  incremental maintenance would look like, and it is not what this
  proposal builds.
- **This does not compress storage the way Zanzibar's real, production
  Leopard index does.** No dense integer subject IDs, no roaring
  bitmaps, no posting lists — a plain row per `(root, subject)` pair,
  with the O(V²) worst case named and only partially mitigated (see
  "Considered and deferred," mitigation 1), never eliminated.
- **A deployment that never sets `LEOPARD_INDEX_ENABLED=true` is
  provably unaffected** — not merely believed to be. The zero-impact
  checklist above is intended to be executed as a real differential-fuzz
  comparison arm (`relationIndex: 'cold'`), not just asserted in prose.
- **This inherits, and does not attempt to tighten, `atToken`'s own
  floor-not-ceiling looseness — the _property_ is identical, the typical
  _magnitude_ is not, and saying only "exactly as a live pinned check
  already may today" without that second half would understate it.** A
  live pinned check's own floor-vs-actual gap is normally milliseconds:
  the time between a write committing and a check's own transaction
  starting. This index's gap is bounded only by how long it's been since
  the last `rebuildRelationMembershipIndex` call — minutes to hours,
  entirely operator-controlled, per "Rebuild scheduling cadence," below.
  Both are the same _kind_ of looseness (a floor, never a ceiling; never a
  soundness violation regardless of size, per Candidate C) — but a reader
  who takes "exactly as... already may today" to mean "the same size" as
  well as "the same shape" would be misled about how stale an ALLOW can
  actually be in practice. This design changes nothing about the
  _property_; it materially widens the _typical gap_, and says so.
- **This does not solve the check-result cache's own disclosed cross-
  process staleness gap, and doesn't need to** — `cache.ts` and this
  index are two independent optional layers with independent freshness
  arguments; nothing here changes `cache.ts`'s own documented TTL-bounded
  cross-process gap for unpinned results.

## Revisit if

Genuinely unresolved calls from all four source explorations, carried
forward rather than silently resolved by omission:

- **Is the pinned-only, ALLOW-only Phase A cut the right size, or should
  a larger design ship at once?** The smaller cut meaningfully shrinks
  the soundness surface that has to be gotten right before anything
  ships, at the cost of only helping a narrower slice of real traffic —
  a human call on whether that's an acceptable v1.
- **Should Phase B's root-completeness tracking (`Candidate D`) be built
  now anyway, "build it once correctly" rather than migrated later?**
  Leaning no — shipping unused, untested machinery with its own
  soundness surface (a `complete` boolean nothing yet reads) is itself a
  place a future edit could start trusting incorrectly — but this is a
  judgment call, not settled.
- **Global versus per-namespace watermark.** A single global watermark
  (this proposal's choice, matching `cache.ts`'s own precedent) means one
  write anywhere makes the entire index equally stale from every check's
  perspective. A per-namespace watermark would let an unrelated
  namespace's frequent writes stop starving this namespace's own index
  freshness, but needs its own soundness proof for the cross-namespace-
  closure case (a group in namespace A nesting a group in namespace B) —
  deliberately not solved here.
- **Rebuild scheduling cadence is entirely unspecified** beyond "external
  cron or an optional in-process interval, operator's choice." This
  matters for the feature's real-world _value_ (how stale can the
  watermark realistically get in practice) but not for its correctness
  argument, which holds regardless of staleness (Candidate C's whole
  point).
- **Whether `authz leopard status` reporting "stale" should ever be
  reflected in its own exit code** for cron/monitoring scripts, versus
  requiring `--format json` plus a script parsing the reported fields. A
  `--fail-if-stale <ms>` opt-in flag (only _then_ turning staleness into
  a non-zero exit, never by default) is a plausible middle ground, not
  decided here.
- **Aggregate-only versus per-namespace staleness reporting** — whether a
  real deployment needs "only the `group` namespace's memberships are
  fresh" rather than one whole-index number. Genuinely a product
  question this proposal has no workload data to answer.
- **Lazy-on-miss debounce/dedup**, if the node-graph design (or a lazy-
  population refinement to this one) is ever revisited: enqueueing a
  materialize job on every miss risks a thundering herd of redundant work
  for one hot, cold node many concurrent checks all miss on
  simultaneously; an in-flight-job guard (a `pg_try_advisory_lock` per
  node, mirroring `acquireWriteLogLock`'s own precedent) is the likely
  fix, not designed in detail here.
- **Sync-versus-async dirty-marking**, if incremental refresh is ever
  revisited: the node-graph design chose an async outbox specifically to
  protect write latency from the reverse walk's own potential fan-out
  cost, at the price of a small, bounded unpinned-only staleness window a
  synchronous design wouldn't have. Its own author flagged this as a real
  trade needing load numbers, not confident reasoning, to settle.
- **A purely practical (non-safety) depth cap on the rebuild**, to avoid
  materializing chains deeper than any real caller's `maxDepth` will ever
  accept (wasted storage, since Candidate F's gate rejects those rows
  regardless). Not needed for correctness; worth adding once real data
  justifies the storage savings.
- **A shadow-table-and-rename variant of the rebuild's publish step**, to
  eliminate the `TRUNCATE`-under-`ACCESS EXCLUSIVE` lock-blocking window
  disclosed under "Operational surface," while preserving this schema's
  single canonical table name for readers. Not built here; named as the
  concrete fix if the lock-blocking cost proves real in practice.
- **A richer, persisted run-history table** (one source design's
  `leopard_index_runs`, tracking every past attempt's trigger/status/
  error, not just the last successful one) — a reasonable operational
  nicety this proposal deliberately trimmed to keep the schema faithful
  to the mandated backbone; worth adding if operators want historical
  visibility beyond "the last successful rebuild" and "did the last
  invocation of `refresh` itself fail."
- **Namespace-scoped `LEOPARD_INDEX_ENABLED`**, for a large multi-tenant
  deployment wanting to pilot this on one namespace before enabling it
  everywhere — not designed here; the simplest, most precedented shape
  (one global flag, matching `REDIS_URL`'s own presence-gates-a-subsystem
  convention) is what this proposal adopts by default.
- **Whether `ProductionCheckResult` should ever expose "this check was
  index-accelerated" as a diagnostic field.** This proposal follows the
  more conservative source design's own recommendation — do not add it
  at all, keep it purely internal (at most a metrics counter/log line) —
  reasoning that the "a caller can never observe a difference"
  requirement is most safely read as "don't even add an observable
  field," not merely "don't let it change `allowed`." An alternative,
  purely additive field (matching the `certain`/`touchedExpiringTuple`
  precedent of "never touches the decision") is a real, undecided
  alternative if operational visibility into hit-rate-style
  effectiveness is ever wanted badly enough.
- **Whether `src/store/dst/shapes.ts` needs full deterministic-simulation
  wiring for `relation_membership_index*` queries**, letting the existing
  crash/pause-injection scheduler exercise the rebuild's own transaction
  directly (e.g., a crash mid-rebuild, confirming the old watermark/table
  survive untouched) — genuinely valuable, materially larger than this
  proposal's own must-ship test plan, deferred to whoever owns the
  eventual implementation to decide against real priorities at that time.
