# Reverse lookup acceleration for `listObjects` — design proposal (v2)

**Status: DRAFT — not yet implemented.** Revision 2, after a genuine
four-lens adversarial review of v1 (soundness, fidelity to real code,
test-plan/scope-gap) found real, disclosed bugs in that draft. This
revision doesn't patch around them — several of them forced a materially
different design, not a wording fix. What changed and why is stated
inline at each gate below, not hidden in a changelog.

Closes `docs/CAPABILITY-GAPS.md`'s "Reverse lookup that isn't capped in the
way it matters" — confirmed by research to be "a genuinely new fourth
direction, not something already named and deferred under a different
label," i.e. **not** Leopard's own reserved "Phase B" (unpinned-check
acceleration; DENY-capable root-completeness/Candidate D).

## What v1 got right, and what it got wrong

**Right, and unchanged:** narrowing candidates rather than deciding
membership. Every object this feature ever returns still passes through
the exact same, real, unmodified `productionCheck` `listObjects` already
runs today. That makes the _soundness_ argument nearly free — confirmed
independently by two reviewers who could not construct a `false_grant`
counterexample against it — and it stays the foundation of this revision.

**Wrong, and why v1 doesn't ship:** v1's freshness gate
(`watermark_token >= atToken`, the caller's own floor) is the wrong
comparison for this feature's shape. It's the right comparison for
Leopard's _forward_ direction, where a miss falls through to a live,
correct answer — so staleness there can never change the result, only
whether the fast path engaged. For a _candidate-enumeration_ accelerator,
staleness changes the result directly: an object granted after the index's
last rebuild is simply never a candidate, and nothing in v1 could tell the
difference between "the subject truly has no more access" and "the index
hasn't caught up yet." Two reviewers independently constructed the same
concrete counterexample (a write landing after the rebuild watermark,
before the caller's own `atToken`), and a third found a second, unrelated
way to reach the identical silent-omission outcome (a live rebuild's
`TRUNCATE` racing the read). Both are closed below — not by better
wording, but by two new, structural rules (the freshness gate and the
empty-result rule) that make the failure mode itself unreachable rather
than merely less likely.

## What already exists, reused unmodified

No new table. `relation_membership_index` (migration `0010`, D-163)
already stores one row per `(object_ns, object_id, relation, subject_ns,
subject_id)` reachable via storable-relation membership — **including
direct, zero-hop grants**, not only nested-group ones (the rebuild's
`membership` CTE seeds at the root itself before any recursion; a v1
inaccuracy, corrected here). Never a computed permission — the rebuild's
own roots are `(object_ns, object_id, relation)` triples drawn from
`relation_tuples`, and `resolve()`'s own Leopard short-circuit only ever
consults it inside its `config.relations[name]` branch
(`src/resolve/production/resolver.ts:729-730`).

Reused as-is: `relation_membership_index_state.watermark_token`, the full
rebuild/refresh/advisory-lock machinery, the `authz leopard refresh`/
`status` CLI surface. `via_path`/`min_expires_at` are **not** read by this
feature — it never reconstructs a proof or re-derives ALLOW/DENY from a
row, only `object_id` — precisely because of the "always re-verified"
property above.

**Schema change:** one new secondary index, in its own migration
(`0011_relation_membership_index_subject_idx.sql`):

```sql
create index relation_membership_index_subject_idx
  on relation_membership_index (subject_ns, subject_id, relation, object_ns, object_id);
```

All five columns, subject-leading — a full permutation of the table's own
primary key, not a partial prefix. This makes the lookup below an
**index-only scan**: every column the query needs (`object_id`) is present
in the index itself, and because the first four columns are
equality-constrained, the trailing `object_id` column is returned in
sorted order for free, directly satisfying `order by object_id asc limit
$n` with no separate sort step. (v1's index omitted `object_id`, which
would have forced a heap fetch per matching row and given the planner
nothing to sort by — a real cost this revision closes structurally rather
than disclaiming.)

## Gate 1 of 5 — `LEOPARD_INDEX_ENABLED=true`

Same env gate Leopard's forward lookup already uses. No second flag for
"is this feature on" — same index, same operator decision to keep it warm.

## Gate 2 of 5 — the index must be _currently_ caught up, not merely past the caller's own floor

This is the gate that changed. Read in this order, at call time:

1. `watermark := relation_membership_index_state.watermark_token`
2. `current := select coalesce(max(token), 0) from write_log` (the same
   `currentToken()` primitive `src/store/tokens.ts` already exports)
3. Accelerate only if `watermark >= current`.

Reading watermark first, current second, makes the comparison meaningful:
if no write has landed between the moment the rebuild published its
watermark and the moment this read of `current` completes, the index is
provably complete as of _now_, not merely as of some caller-supplied floor
that could be arbitrarily old. A write landing a moment later, between
this check and the candidate query, is the same ordinary race every live,
unpinned read in this codebase already has — `list.ts`'s own doc comment
already discloses the identical race for today's unaccelerated candidate
scan ("an object created after the scan is silently absent"). This gate
doesn't introduce a new risk category; it collapses the accelerated path's
own risk down to that same, already-accepted one, instead of the
unbounded, undisclosed staleness window v1 left open.

**Consequence, stated plainly: acceleration is now genuinely opportunistic,
possibly rarely so under continuous write load** (any write since the last
rebuild disqualifies it), exactly like every other acceleration structure
in this codebase — Leopard's own forward lookup, D-171's wildcard fallback,
D-168's Dockerfile. It engages reliably right after an operator runs
`authz leopard refresh` (or the background refresh loop, D-167) — the
same "pre-warm before a read-heavy window" operational pattern this
project's Leopard CLI already documents — and safely does nothing
otherwise. A lower hit rate than v1 hoped for is the honest cost of
closing the completeness gap v1 didn't.

**This also removes v1's "pinned calls only" restriction.** Since the gate
no longer compares against the caller's own `atToken` at all, there's
nothing left that requires pinning — an _unpinned_ `listObjects` call can
be accelerated exactly as safely as a pinned one, which matters, because
`docs/CAPABILITY-GAPS.md`'s own motivating example ("which of these 50k
documents can Alice see" on every list-view render) is exactly the kind of
call that's typically unpinned in practice.

## Gate 3 of 5 — an empty accelerated result is a miss, not an answer

A second, independent hazard, found by the third reviewer: Leopard's own
rebuild `TRUNCATE`s and repopulates the _same_ table this feature reads.
`test/isolation/relation-index-concurrent-rebuild.integration.test.ts`
already live-verified, against real Postgres, that a reader whose snapshot
predates a `TRUNCATE` blocks for that rebuild's whole duration and then —
this is Postgres's own documented `TRUNCATE` semantics, not a bug — sees
the table as **empty**, neither the old generation nor the new one. Gate
2's freshness check reads `relation_membership_index_state` (a table
that's only ever `UPDATE`d, never `TRUNCATE`d) and can pass even while a
rebuild is mid-flight against `relation_membership_index` itself — e.g. an
operator re-running `authz leopard refresh` on an unchanged database, which
recomputes an identical watermark while still momentarily truncating the
table underneath it.

The fix doesn't require detecting that race — it requires never trusting
its one possible symptom: **an accelerated candidate query returning zero
rows never means "the subject has no access"; it always falls through to
today's unmodified candidate scan.** The only cost is a little wasted work
on a call whose true answer really was empty. This same rule also closes
v1's degenerate case where `atToken: 0` against a never-built index
(`watermark = 0`) trivially satisfied the old floor comparison — a
never-built index also has zero rows, so it now falls through exactly the
same way, needing no special case.

An uncaught Postgres error from the accelerated query — the same
`lock_timeout`-triggered failure the concurrent-rebuild isolation test
already reproduces live for Leopard's forward lookup — is handled
identically: caught, logged, treated as a miss, falls through. **No
`SAVEPOINT` is needed for this**, unlike Leopard's own lookup, and the
reason is structural, not an oversight: Leopard's lookup runs _inside_ the
same `REPEATABLE READ` transaction as the rest of that check, so an
uncaught error there poisons a transaction other statements still need.
This feature's candidate query is a standalone, autocommit `pool.query`
call with no surrounding transaction — each subsequent `productionCheck`
already opens its own independent connection and transaction
(`checkCandidatesConcurrently`, unchanged) — so a plain `try`/`catch` fully
contains the failure. Stated explicitly because D-165's own "Revisit if"
flags a second, independently-named `SAVEPOINT` call site as something
`src/store/dst/connection.ts`'s exact-literal recognizer would need
extending for; this design adds none, so it doesn't trip that note.

## Gate 4 of 5 — `relationOrPermission` names a bare, storable relation in the _current_ schema, on this namespace

Corrected from v1's imprecise version (which named a nonexistent
`namespaces[objectNs].relations` shape): the real check is
`getLatestNamespaceConfig(pool, objectNs)` → `NamespaceConfig | undefined`,
then `config?.relations[relationOrPermission]`. Three outcomes, only one of
which accelerates:

- `config` is `undefined` (no published schema at all) → miss, fall
  through.
- `relationOrPermission` is a key in `config.permissions` (a computed
  rewrite tree) → miss, fall through. `relation_membership_index`'s
  closure has no representation of a rewrite rule at all — this is the
  same restriction Leopard's own resolver integration already has.
- `relationOrPermission` is a key in `config.relations` → proceed to gate 5.

**A disclosed, narrow, accepted race, not engineered around:** this schema
read and the per-candidate `productionCheck` calls that follow are not on
one shared snapshot. A schema republish landing in the gap between them —
renaming this exact relation into a permission, say — means the
accelerated candidates reflect the relation's old closure while the real
per-candidate check evaluates the new permission. The consequence is
bounded to an _omission_, never a wrong grant (each candidate is still
independently re-verified against current schema), and the window is one
query's duration against an explicit, admin-only, rare operation — not
routine write traffic. Compare Leopard's own forward lookup, where schema
and index consult share one connection's snapshot and this race can't
happen at all; this feature can't get that for free (its schema check has
no natural transaction to share), and closing it fully would mean wrapping
the whole candidate-generation step in its own `REPEATABLE READ`
transaction purely to pin one schema read — a real cost this proposal
judges not worth paying for a rare-event, omission-only, already-bounded
risk. Revisit if schema republishes ever become a routine, high-frequency
operation.

## Gate 5 of 5 — the relation must declare no wildcard-eligible subject type

New in this revision, and the gate that resolves two separate v1 findings
at once. v1 handled a stored wildcard grant (`subject_id = '*'`) by
querying the subject's own concrete id **and** the wildcard sentinel
together (`subject_id in ($2, '*')`). Worked through, that union carried
two real costs: (a) it re-implements — in SQL, a second time — the exact
subject-matching rule `src/resolve/production/resolver.ts` already
centralizes in one canonical `subjectMatches` predicate specifically so it
is never re-derived elsewhere; (b) if _any_ wildcard grant reaches the
relation, the wildcard branch matches every object in the namespace,
silently erasing the entire narrowing this feature exists to provide —
while still costing an extra schema read and a heavier query than the
scan it was meant to beat.

Both costs disappear by checking, once per call, whether
`config.relations[relationOrPermission].subjectTypes` contains any entry
with `wildcard: true` (`SubjectTypeRef.wildcard`,
`src/schema/dsl/types.ts:116-122`). If it does, this feature never
engages for that relation at all — full stop, always the existing scan.
**Confirmed, not assumed, that wildcard rows can't leak in through some
other relation's closure:** a wildcard tuple can never carry a
`subject_relation` (`validateWildcardStructure`,
`src/store/tuples.ts:148-158`, rejects the combination outright), and the
rebuild's own recursive term only ever follows edges with
`subject_relation is not null` — so a wildcard subject is structurally
incapable of being anything but a terminal row in the index, never an
intermediate one this gate would need to chase through a different
relation's own closure.

The cost of this gate: any relation declaring `<ns>:*` never benefits from
this feature, at all, regardless of whether any actual wildcard tuple has
ever been written for it. A real, disclosed scope narrowing versus v1 —
traded for eliminating both the correctness duplication and the
narrowing-defeating perf cliff in one move.

## The lookup, end to end

```
fetchReverseIndexCandidates(pool, subject, relationOrPermission, objectNs, limit):
  if not LEOPARD_INDEX_ENABLED: return { hit: false }                          -- gate 1
  watermark := read relation_membership_index_state.watermark_token
  current   := read select coalesce(max(token),0) from write_log
  if watermark &lt; current: return { hit: false }                               -- gate 2
  config := getLatestNamespaceConfig(pool, objectNs)
  relation := config?.relations[relationOrPermission]
  if relation is undefined: return { hit: false }                              -- gate 4
  if any(t.wildcard for t in relation.subjectTypes): return { hit: false }     -- gate 5
  try:
    rows := select object_id from relation_membership_index
             where subject_ns = subject.ns and subject_id = subject.id
               and relation = relationOrPermission and object_ns = objectNs
             order by object_id asc limit (limit + 1)   -- gate 3's own +1 overflow trick
  catch (err): log err; return { hit: false }                                  -- gate 3 (errors)
  if rows.length == 0: return { hit: false }                                   -- gate 3 (empty)
  return { hit: true, objectIds: rows.slice(0, limit), truncated: rows.length &gt; limit }
```

`listObjects` integration — the only change to the existing function:

```
listObjects(pool, subject, relationOrPermission, objectNs, options):
  accel = fetchReverseIndexCandidates(pool, subject, relationOrPermission,
                                       objectNs, LIST_OBJECTS_MAX_CANDIDATES)
  { ids, truncated } =
    accel.hit
      ? { ids: accel.objectIds, truncated: accel.truncated }
      : fetchCandidateObjectIds(pool, objectNs)   -- unchanged, byte-for-byte
  objects = checkCandidatesConcurrently(pool, subject, objectNs, ids,
                                         relationOrPermission, checkOptions)  -- unchanged
  return { objects, truncated }
```

`ListObjectsOptions` gains one new field,
`useRelationIndex?: boolean`, mirroring
`ProductionCheckOptions.useRelationIndex` exactly and for the identical
reason: `env.LEOPARD_INDEX_ENABLED` is parsed once at module load
(`src/config/env.ts`, `export const env = loadEnv()`), so it cannot be
toggled per test case — every DST test exercising Leopard's own forward
lookup already forces this per-call, never relying on the env var, and
this feature's own tests need the identical mechanism to be independently
runnable at all.

## What this closes, precisely — no "byte-identical parity" claim

v1's headline test property, "accelerated and unaccelerated
`listObjects` return byte-identical `{objects, truncated}`," is **false**,
independent of staleness: the two candidate sources cap different
populations. Today's scan caps _the whole namespace's_ first 1000
object ids; this feature's query caps _this one subject's own_ reachable
objects under this one relation. A namespace with 5000 objects where the
subject can see exactly one, sorting near the end, is a real, permanent
divergence — the unaccelerated scan reports `truncated: true` and an empty
result (never reaching that one object); the accelerated one correctly
finds it. That's the feature working as intended, not a bug — v1 named
this exact case as its own strongest test and had the assertion backwards.

**What's actually provable, stated as two separate properties:**

1. **Soundness, unconditionally:** every object in `objects` passed a real,
   independent, current-state `productionCheck`. True regardless of gates
   1-5, regardless of staleness, regardless of anything — because nothing
   this feature adds is ever the final arbiter.
2. **Completeness, conditioned on the gates actually passing:** if
   `fetchReverseIndexCandidates` returns `{hit: true, ...}`, its
   `objectIds` (up to the cap) are exactly the objects reachable from
   `subject` via `relationOrPermission` in `objectNs` as of the `current`
   token read in gate 2 — no more, no less, subject to the same cap and
   the same `truncated` semantics `listObjects` already documents, just
   correctly scoped to what this algorithm actually enumerated rather than
   compared byte-for-byte against a structurally different algorithm's own
   answer.

## Test plan

Naming follows this table's own established `relation-index-*` convention
(`test/unit/store/dst/relation-index-{watermark,rebuild,savepoint-recovery}.dst.test.ts`,
`test/unit/store/relation-index.integration.test.ts`,
`test/metamorphic/relation-index-soundness.integration.test.ts`) rather
than inventing a new one.

| File                                                                                  | Tier                                | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/store/dst/relation-index-reverse-lookup.dst.test.ts`                       | fast, DB-free                       | Gates 1-5 in isolation via `useRelationIndex` (never the env var): watermark below/equal/above current (equal passes — the boundary case v1 got backwards); no state row (watermark 0, current 0 — passes, same reasoning); `relationOrPermission` present in `relations`/`permissions`/neither; a relation with a wildcard-eligible subject type is always refused; an empty result set is a miss; a thrown error is a miss and never propagates.                                                                                                                                                                                                                                                                                                              |
| `test/unit/store/relation-index-reverse-lookup.integration.test.ts`                   | real Postgres                       | The query itself, live: a subject reachable at real nested-group depth; direct (zero-hop) grants found identically to nested ones; truncation at `LIST_OBJECTS_MAX_CANDIDATES` with the same lowest-sorting-slice guarantee the existing forward-direction truncation test already proves, now over the index-only-scan path; **the case v1's test plan was missing entirely** — an object granted _after_ the last rebuild is absent from the accelerated result while `watermark &lt; current`, proving gate 2 refuses to accelerate rather than silently omitting it (this is the regression test for the bug this revision exists to fix); a revoked-since-rebuild candidate is still returned as a candidate and still correctly denied by the real check. |
| `test/isolation/relation-index-reverse-lookup-concurrent-rebuild.integration.test.ts` | real Postgres, OS-level concurrency | Modelled directly on the existing `relation-index-concurrent-rebuild.integration.test.ts`: a `listObjects` call racing a live rebuild's `TRUNCATE` never returns a smaller-than-real set and never throws — the live proof that gate 3's empty/error-is-a-miss rule actually closes the hazard under genuine concurrency, not merely as an asserted rule.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `test/metamorphic/relation-index-reverse-lookup-soundness.integration.test.ts`        | real Postgres, many random seeds    | Per-seed: write a random fixture, rebuild, confirm the index is caught up (gate 2 passes), assert the accelerated candidate set for every generated subject/relation pair exactly equals the reachable set an independent oracle computes directly from the fixture's own tuples (mirroring `list.integration.test.ts`'s existing brute-force-oracle discipline, generalized across seeds instead of one hand-built graph); **and**, in a second pass per seed, write one more tuple after the rebuild and confirm gate 2 now refuses to accelerate (`hit: false`) rather than silently omitting the new grant — the non-vacuity control that also doubles as R1's own regression guard, so this test cannot pass by accident the way v1's did.                 |
| DST recognizer coverage                                                               | fast, DB-free                       | `src/store/dst/shapes.ts` needs one new `SHAPES` entry for the candidate query's own exact text, reproducing its `DISTINCT`-free equality-prefix/`ORDER BY`/`LIMIT` shape against the fake's array model (the most semantically complex read handler this file would gain — flagged honestly, not understated); `registeredShapeCount()`'s expected value moves from 21 to 22. The precedent for "count exactly what's added" is D-165 Part 2 (`docs/DECISIONS.md`, the seven Leopard shape handlers, corrected from a design doc's own stated six) — not D-163/D-167 as v1 mis-cited.                                                                                                                                                                          |

Every property above gets a fail-check (break gate 2's comparison
direction, break the empty-result rule, break gate 5's wildcard check,
break the try/catch) before being trusted green — the same discipline
every Leopard test file already documents.

## Explicitly out of scope: `listUsers`

`docs/CAPABILITY-GAPS.md` names `listObjects`/`listUsers` together (via
D-135's own "Revisit if"), so the omission is worth stating rather than
leaving silent. `listUsers` does not get this feature, for two principled
reasons rather than an oversight:

1. **It has no pinning concept to gate on.** `expand()` (what `listUsers`
   is built on) takes no `atToken` at all, deliberately
   (`src/audit/list.ts`'s own doc comment on `ListUsersOptions`). Gate 2
   as designed compares the index's watermark against `write_log`'s
   current token — that comparison is meaningful regardless of pinning,
   so this isn't actually a hard blocker on its own, but it does mean
   `listUsers` would need its own, separately-reasoned integration rather
   than inheriting this one.
2. **The load-bearing reason: there is no re-verification step for
   `listUsers` to fall back on.** This feature's entire soundness argument
   is "the index only narrows a candidate list; a real check decides
   membership." `listUsers`'s output _is_ the enumeration — there's no
   per-result recheck the way `checkCandidatesConcurrently` provides here.
   An index-derived answer for `listUsers` would be authoritative, not
   advisory, and a stale row would be a wrong answer directly, not a safe
   omission. It would also need to reproduce D-171's wildcard/co-finite
   `MemberSet` semantics (`src/audit/list.ts:443-603`) from index rows,
   which this feature's own gate 5 sidesteps entirely by simply not
   accelerating wildcard-capable relations — an option `listUsers` doesn't
   have, since refusing wildcard-capable relations there would just
   reproduce today's unaccelerated behavior for the _interesting_ half of
   D-171's own scope.

Left as real, separate future work, not folded in here.

## Revisit if

- **A shadow-table-and-rename rebuild** (already named in
  `docs/LEOPARD-INDEX-PROPOSAL.md`'s own "Revisit if" as the fix for the
  `TRUNCATE`-under-`ACCESS EXCLUSIVE` blocking window, not built there
  either) would shrink both the window gate 3 defends against _and_ the
  gap between rebuilds that keeps gate 2 from engaging under continuous
  write load — this feature is a second, independent reason that fix
  would pay for itself, not just Leopard's own disclosed cost.
- **Schema republishes become routine/high-frequency** — gate 4's disclosed
  race would need a real fix (pinning the schema read to the same
  transaction as the candidate query) rather than staying an accepted,
  rare-event, omission-only risk.
- **`listUsers` gains its own re-verification step or drops wildcards from
  its scope** — either would remove one of the two blockers above and make
  a `listUsers` analog worth a fresh, dedicated proposal.
- **D-135's TTL check-cache "Revisit if"** (`docs/DECISIONS.md:2201`,
  flagging `listObjects`/`listUsers` for "the same optimization") is a
  different axis (a result cache, not a structural index) and is
  unaffected by this proposal either way — still open, still separate.
- **Wildcard-capable relations become common enough that gate 5's scope
  narrowing matters in practice** — would need the wildcard-union approach
  v1 attempted, but built against a `subjectMatches`-derived helper instead
  of a second, independent SQL re-implementation, to avoid the exact
  duplication this revision removed.
- **A `listObjects`-shaped differential-fuzz arm is ever built** — the
  parity metamorphic test above would be a natural candidate to fold into
  it rather than staying its own file.
