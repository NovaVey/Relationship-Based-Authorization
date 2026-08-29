# DST absorbs the Leopard index — scope and design

**Status: proposal, not built.** Nothing in this document has landed —
`grep -rn "relation_membership_index" src/store/dst/` returns nothing today,
confirmed directly before writing a word of this. This is a design
document in the same register as `docs/DST-PROPOSAL.md` and
`docs/LEOPARD-INDEX-PROPOSAL.md`: problem statement, a model, the new
invariants it earns, a test plan, what's considered and deferred, and what
this design accepts as a real, disclosed risk rather than smoothing over.
No `docs/DECISIONS.md` entry exists for this yet; phase labels below
(`D6`/`D7`/`D8`) are this document's own proposed continuation of
`docs/DST-PROPOSAL.md`'s `D0`–`D5` numbering, not an assigned decision.

## The problem this exists to name, not hide

The Leopard index (`docs/LEOPARD-INDEX-PROPOSAL.md`, shipped,
`docs/DECISIONS.md` D-163) added a real asynchronous surface this project's
DST harness (`docs/DST-PROPOSAL.md`, D0–D5, `docs/DECISIONS.md` D-097
through D-102) was never built to know about: an offline rebuild
transaction (`rebuildRelationMembershipIndex`, `src/store/relation-index.ts`)
that opens its own connection, takes a non-blocking advisory lock, and
publishes a whole-table replace atomically at one `COMMIT`; a lookup
(`lookupRelationMembershipIndex`) gated by comparing a single watermark row
against a caller's pinned `atToken`; and, since D-163's own live-Postgres
testing found a real bug, a `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` recovery
path around that lookup inside `resolve()`'s relation branch
(`src/resolve/production/resolver.ts:770-788`).

DST was built before any of this existed, and it has not actually absorbed
it. Three pieces of direct evidence, not assertion:

1. **`grep -rn "relation_membership_index" src/store/dst/`** returns
   nothing. None of `state.ts`, `shapes.ts`, `connection.ts` know these two
   tables exist.
2. **The one file with "dst" in its name for this feature,
   `test/unit/store/dst/relation-index-watermark.dst.test.ts`, never
   touches `src/store/dst/scheduler.ts` at all.** Its own top-of-file doc
   comment says so directly: "this file drives the real function directly
   against a hand-written fake `QueryExecutor` that returns canned rows,"
   the exact same pattern `snapshot-anchor-invariant.test.ts` uses for a
   pure decision-logic unit test. It is a good, real test of
   `lookupRelationMembershipIndex`'s own TypeScript-level gates (Candidates
   C and F, and half of G), but it explores zero interleavings, injects no
   faults, and runs no seeds — "dst" in its filename describes what it's
   near, not what it does.
3. **If the real, unmodified `rebuildRelationMembershipIndex` or the
   `resolve()` relation branch's `SAVEPOINT`-guarded lookup were run
   against today's fake store, both would throw immediately**, before
   doing anything: `rebuildRelationMembershipIndex`'s own first
   non-lock statement, `BEGIN ISOLATION LEVEL REPEATABLE READ` (no `READ
ONLY` — a different literal string than `connection.ts`'s own
   `SNAPSHOT_BEGIN` constant), matches none of `connection.ts`'s four
   recognized transaction-control texts and falls through to
   `lookupShape`, which throws `"no shape registered for query"` per
   `shapes.ts`'s own documented, deliberate "throw loudly on anything
   unrecognized" design. The lock statement one line later
   (`select pg_try_advisory_xact_lock($1, $2) as locked`) would fail the
   identical way — `pg_try_advisory_xact_lock` is not one of the four lock
   forms `connection.ts` special-cases (only the blocking
   `pg_advisory_xact_lock`/`pg_advisory_lock`/`pg_advisory_unlock` three are
   recognized). And `resolve()`'s own `SAVEPOINT leopard_lookup` statement
   would fail the same way a third time. This is not a hypothetical gap —
   it is confirmed directly from reading `connection.ts`'s exact recognized
   literals against `relation-index.ts`'s and `resolver.ts`'s exact issued
   literals, side by side, above.

And the concurrency bug that actually mattered — the transaction-poisoning
gap D-163 found and fixed with the `SAVEPOINT` pair, and the `TRUNCATE`
`ACCESS EXCLUSIVE` lock-blocking behavior — was found by a **real Postgres
integration test**
(`test/isolation/relation-index-concurrent-rebuild.integration.test.ts`),
not by DST, for the simple reason above: DST could not have run that code
at all. This document's job is to say precisely what would need to exist
for DST to have a chance at that class of bug in the future, and — just as
importantly, per this project's own stated discipline — to say precisely
which parts of the risk that real Postgres test already closed do **not**
need a DST equivalent, because either Postgres's own documented semantics
already rule the hazard out by construction, or the property in question is
inherently a real-storage-engine question DST was never built to answer
(`docs/DST-PROPOSAL.md`'s own opening: "we do not own Postgres's storage
engine... we have no way to crash-inject _inside_ it").

## What DST's existing model already gives this for free — say so plainly

Before proposing anything new, three things the existing D0–D5 machinery
already provides, unmodified, that a naive reading of "the rebuild has
races, races need a scheduler" might miss:

**1. Whole-transaction atomicity is not a new property to prove — it's the
same one D0 already proved for `writeTuple`.** The rebuild's `TRUNCATE` +
batched-recursive-`INSERT` + two state `UPDATE`s + `COMMIT` are one
transaction on one connection, buffered via the exact same `pending:
PendingOp[]` / `bufferOp` mechanism every existing write already uses
(`connection.ts`'s own top-of-file doc comment: "a shape handler never
mutates `state.relationTuples`/`writeLog`/`namespaceConfigs` directly for a
write — writes are always applied via `bufferOp`... atomically, all at
once"). Nothing about "this transaction writes several statements instead
of two" requires new atomicity machinery; D0's own crash-injection proof
(`docs/DECISIONS.md` D-097) already establishes the general case. What
_is_ new is the **shape** of what gets buffered for these two tables
specifically — covered under "The model," below.

**2. "A lookup reading the watermark row between the state `UPDATE` and the
`COMMIT`" — one of the three interleavings this document was asked to
weigh — is impossible by construction, and no scheduler machinery should
be built to explore it.** The watermark `UPDATE` and the `COMMIT` are the
same transaction, on the same connection (`relation-index.ts:348-359`).
Nothing becomes visible to any other reader until that `COMMIT` runs,
Postgres's ordinary transactional isolation — the identical "the read the
snapshot and durably publish it are fused into one ACID unit" argument
`docs/LEOPARD-INDEX-PROPOSAL.md`'s own "Why this needs no epoch fence"
section already makes. A DST test that tried to pause between these two
statements and assert "no reader observes a state gap here" would be
asserting a property that's true by definition, not by any interleaving
DST's scheduler resolved — the same category of "don't invent a bug that
can't happen" this document's own brief asks to be named plainly, not
built around.

**3. "Two concurrent rebuild attempts, one already covered by the advisory
lock" needs a small addition, not exploration.** `pg_try_advisory_xact_lock`
is a single, stateless boolean check against whatever currently holds a
lock key — there is no traversal, no incremental algebra, nothing
soundness-shaped to get subtly wrong (contrast this with the node-graph
design's own disclosed "reverse-edge dirty-marking walk... new, untested,
soundness-load-bearing logic," `docs/LEOPARD-INDEX-PROPOSAL.md`'s
"Considered and deferred"). And this exact property — "of two concurrent
attempts, exactly one acquires and the other reports failure immediately"
— is **already proven, deterministically, against real Postgres**
(`docs/DECISIONS.md` D-163: "`lockAcquired: false` reproduced
deterministically via a held advisory lock on a separate connection rather
than `Promise.all` timing luck," in `test/unit/store/relation-index.
integration.test.ts`). A DST version of this buys fast-suite regression
coverage of an already-proven property, not new soundness insight. Worth
adding (below, `D7`) because it's cheap and it's the first non-blocking
lock primitive this codebase has, but it is explicitly **not** where this
document's own effort or risk budget goes.

## What is genuinely missing, and why each piece is load-bearing

Three real gaps remain, sized honestly rather than uniformly:

### Gap 1 (small): the two new tables have no fake-store representation at all

Mechanical, but not zero-thought — see "The model," below, for a specific,
disclosed correction to an earlier, wrong draft of this exact reasoning.

### Gap 2 (small): the rebuild's own transaction mode doesn't exist

`connection.ts`'s `TxState.Snapshot` is hardcoded to the literal text
`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` and its `bufferOp`
throws unconditionally on any write attempted while in that mode — correct
for `productionCheck`'s pinned client, wrong for the rebuild's own
`BEGIN ISOLATION LEVEL REPEATABLE READ` (no `READ ONLY` — a real,
deliberate distinction `relation-index.ts`'s own doc comment states
explicitly: "this transaction writes its own output"). A second snapshot
mode is needed: identical anchoring behavior (freeze `visibleAsOf` at the
first real query, not at `BEGIN`), but writes permitted.

### Gap 3 (the real one): DST has no fault class for "a statement fails but the connection survives, poisoned"

Every existing DST fault class is one of exactly two shapes:
`crashAfterStatements` (the connection dies outright — every subsequent
statement, including `ROLLBACK`, throws "already crashed") or
`pauseAfterStatements` (the connection never fails at all, it just waits).
Real Postgres has a **third** shape D-163's own live-Postgres test found
by accident and this project's own discipline requires naming precisely:
a statement can fail with a genuine SQL-level error (a lock-wait timeout,
in D-163's own reproduction) while the **connection itself survives**,
except now poisoned — every subsequent statement on that same connection
fails with `current transaction is aborted, commands ignored until end of
transaction block`, until a `ROLLBACK` (the whole transaction) or a
`ROLLBACK TO SAVEPOINT` (back to an established savepoint) restores it.
`resolve()`'s own `SAVEPOINT`/`RELEASE SAVEPOINT`/`ROLLBACK TO SAVEPOINT`
triplet exists _specifically_ to survive this shape — and DST, today, has
no way to construct it at all. This is the one piece of this whole
proposal that is genuinely new machinery in the same weight class as D2's
own promoted operations, not a mechanical extension — see "The risk this
design accepts," below, for why it's also the one piece most likely to
have its own subtle bugs.

## The model

### New state — `src/store/dst/state.ts`

**A corrected design, not the first draft of it.** The first pass at this
reasoning proposed representing `relation_membership_index` the same way
`namespace_configs` already is: a list of full generations, each tagged
with the `commitSeq` it became visible at, and a read picks "the highest
generation with `commitSeq <= visibleAsOf`." **This is wrong**, caught by
checking it against `relation-index-concurrent-rebuild.integration.test.ts`'s
own documented, live-observed Postgres behavior (its top-of-file doc
comment, point 2): "Once unblocked... that SAME older-snapshot reader sees
the table as EMPTY — neither the pre-truncate old rows nor the
post-truncate new rows." A "pick the latest generation the reader is
entitled to see" model would have **incorrectly preserved** the prior
generation's visibility for a reader whose own read of the table happens
to run after a _later_ rebuild's `TRUNCATE` already committed — exactly
backwards from what real Postgres actually does, because `TRUNCATE` swaps
the underlying relfilenode rather than participating in ordinary per-row
MVCC visibility the way `DELETE` does. A generation-list model would make
DST _less_ faithful than doing nothing.

**The correct model reuses a pattern that already exists in this
codebase, unmodified in spirit: `tupleDeleteHandler`'s own unconditional
array-splice-at-commit.** `relation_membership_index` is a plain array of
rows, each tagged with the `commitSeq` it was inserted at (the same shape
`RelationTupleRow` already uses). The `TRUNCATE`'s own `bufferOp`
unconditionally clears whatever the array currently holds — not filtered
by anyone's `visibleAsOf`, exactly like `tupleDeleteHandler`'s own
`s.relationTuples = s.relationTuples.filter(...)` — and the batched
recursive `INSERT`'s own `bufferOp` (sequenced immediately after, in the
same `pending` array, applied in order at the same `COMMIT`) repopulates it
with freshly tagged rows. A reader's own frozen `visibleAsOf` then needs
**zero new filtering logic**: `isVisible(row.commitSeq, visibleAsOf)`,
unchanged, naturally evaluates to "no rows" for any reader anchored before
this rebuild's commit — not because of any generation-aware special case,
but because the prior generation's rows have already been physically
removed from the shared array by the time such a reader's later statement
runs, and the new generation's rows all carry a `commitSeq` above that
reader's own ceiling. This reproduces the real "sees empty, not the old
generation" behavior exactly, for the identical structural reason real
Postgres does — not a coincidence of implementation, a direct consequence
of reusing the one existing pattern that already has this property.

```ts
export interface RelationMembershipIndexRow {
  objectNs: string;
  objectId: string;
  relation: string;
  subjectNs: string;
  subjectId: string;
  viaPath: string[];
  minExpiresAt: Date | null;
  commitSeq: number;
}
```

**`relation_membership_index_state`'s watermark, by contrast, genuinely is
a versioned-row question — and the existing `namespace_configs` pattern
_is_ the right reuse here, not a mistake to correct.** This is an ordinary
`UPDATE ... WHERE id = 1` against a real single row, and ordinary Postgres
MVCC _does_ preserve an older row version for an older snapshot exactly
the way `latestNamespaceConfigHandler`'s own "pick the highest
version-tagged-by-`commitSeq` within my visibility ceiling" logic already
assumes for `namespace_configs`. Reused directly, not reinvented:

```ts
export interface RelationMembershipIndexStateVersion {
  watermarkToken: number;
  commitSeq: number;
}
```

**Deliberately not modeled: `rebuild_started_at`, `rebuild_finished_at`,
`row_count`.** `relation-index.ts`'s own doc comment is explicit that this
triple is "never a soundness concern — no check ever reads this column;
only `watermark_token`... gates any ALLOW." DST's whole purpose is proving
soundness properties under adversarial scheduling, not operational-metadata
fidelity (`docs/DST-PROPOSAL.md`'s own "the D-092 phantom-witness
regression," not "does `authz leopard status`'s staleness figure render
correctly" — that's `clock_timestamp()` vs. `now()`, already found and
fixed live against real Postgres, D-163). The two `UPDATE` statements that
touch these columns still need SQL-shape registry entries — `shapes.ts`'s
"throw loudly on anything unrecognized" discipline means an unregistered
statement is a hard failure, not a silent skip — but their handlers are
deliberately inert no-ops beyond capturing `watermark_token` from the
second one. Building fidelity DST doesn't need, purely to look complete,
is exactly the kind of speculative machinery `docs/DST-PROPOSAL.md`'s own
"Two grafts" section already argues against building ahead of a proven
need.

### New shape handlers — `src/store/dst/shapes.ts`

Six new registry entries, all mechanical, matching `relation-index.ts`'s
exact literal texts (case-sensitive, whitespace-collapsed — the _same_
exact-match-only discipline `normalizeSql`'s own doc comment states is
"never a fuzzy or regex fallback for any shape... forever"):

1. `REBUILD_WATERMARK_QUERY_TEXT` (`'select coalesce(max(token), 0) as
watermark from write_log'`) — reads `state.writeLog` filtered by
   `visibleAsOf` (this transaction's own anchor), the identical logic
   `maxTokenHandler` already has, just a distinct handler because the
   literal text and result shape differ (`{watermark: string}` vs.
   `{max_token: string|null}` — the whole reason `relation-index.ts`'s own
   doc comment discloses this as "a deliberate small duplication," never an
   import of `resolver.ts`'s private `ANCHOR_QUERY_TEXT").
2. `truncate relation_membership_index` — the unconditional-splice
   `bufferOp` described above.
3. The batched `WITH RECURSIVE roots(...) ... INSERT INTO
relation_membership_index SELECT DISTINCT ON (...) ...` — see "Reusing
   `fetchReachableFrontierVia`, not reimplementing traversal a second
   time," below, for how this is actually computed.
4. `update relation_membership_index_state set rebuild_started_at =
clock_timestamp() where id = 1` — inert no-op, per the disclosure above.
5. `update relation_membership_index_state set watermark_token = $1, ...`
   — a `bufferOp` that appends a new `RelationMembershipIndexStateVersion`
   tagged with this transaction's own eventual `commitSeq`; `row_count`
   discarded.
6. `lookupRelationMembershipIndex`'s own two `SELECT`s — the state read
   (pick the highest version with `commitSeq <= visibleAsOf`, default
   watermark `0` if none) and the row read (filter by `isVisible` **and**
   `isTupleLive(minExpiresAt, now)` — reusing the exact existing helper
   `listTupleSubjectsHandler`/`fetchTuplesOnFrontierHandler` already use
   for the identical `expires_at is null or expires_at > now()` predicate,
   never a second implementation of that comparison).

### New transaction mode — `src/store/dst/connection.ts`

A second recognized `BEGIN` text, `'BEGIN ISOLATION LEVEL REPEATABLE
READ'` (no `READ ONLY`), matched case-insensitively via the same
`.toUpperCase()` comparison the existing four transaction-control tokens
already use (this is the more faithful choice for these specifically —
Postgres's own transaction-control keywords are case-insensitive by
grammar, unlike the lowercase literal SQL text `normalizeSql` matches
case-sensitively). Enters a mode identical to today's `Snapshot` in every
respect except one: `bufferOp` no longer throws unconditionally on a
write — only `Snapshot` (the `READ ONLY` variant) keeps that guard. Rather
than a third parallel `TxState` value duplicating `Snapshot`'s whole
anchoring/`visibleAsOf`/`snapshotNow` machinery, the cleanest shape is one
boolean (`snapshotReadOnly: boolean`) carried alongside the existing
`Snapshot` state, set at whichever of the two `BEGIN` texts opened it —
the anchoring logic itself (freeze `visibleAsOf`/`now` at the first real
query) is completely unchanged and shared between both variants, since
that behavior was never specific to read-only-ness in the first place.

### New lock primitive — `src/store/dst/locks.ts`

```ts
export function tryAcquireLock(
  locks: LocksState,
  key: string,
  connectionId: number,
  scope: LockScope,
): boolean {
  if (locks.held.has(key)) return false;
  locks.held.set(key, { connectionId, scope });
  return true;
}
```

No queueing, no `Promise` — the entire point of the `_try_` form is that
it never waits. `connection.ts` recognizes the new literal text (`select
pg_try_advisory_xact_lock($1, $2) as locked`) and returns `{ rows: [{
locked: tryAcquireLock(...) }], rowCount: 1 }` synchronously. This is
additive only: every one of the four existing lock forms keeps its own
blocking `acquireLock` path, untouched.

### The genuinely new fault class — transaction poisoning and `SAVEPOINT`

**Recognized literals, not a general savepoint engine.** `resolve()`
issues exactly one fixed savepoint name today (`leopard_lookup`), baked
directly into the SQL text (Postgres has no parameterized-identifier form
for `SAVEPOINT`). Rather than building a general savepoint-name-parsing
mechanism — a real, if small, departure from the exact-match-only
discipline — the three exact literals this codebase actually issues are
recognized as three more transaction-control tokens, matched
case-insensitively alongside `BEGIN`/`COMMIT`/`ROLLBACK`:
`SAVEPOINT LEOPARD_LOOKUP`, `RELEASE SAVEPOINT LEOPARD_LOOKUP`,
`ROLLBACK TO SAVEPOINT LEOPARD_LOOKUP` (after `.toUpperCase()`). This keeps
the exact-match discipline fully intact at the cost of the same tradeoff
`docs/DST-PROPOSAL.md`'s own "risk this design accepts" section already
names for the fifteen plain shapes: a second real savepoint name
introduced anywhere else in this codebase in the future needs its own
recognized literal, and the recognizer-coverage gate (`test/unit/store/dst/
recognizer-coverage.dst.test.ts`) is exactly the mechanism that turns a
missed one into a loud, same-day CI failure rather than a silent gap.

**New per-connection state.** One boolean, `poisoned`, and one number,
`pendingLengthAtSavepoint: number | undefined` (the length of `this.pending`
at the moment `SAVEPOINT LEOPARD_LOOKUP` ran — a single slot, not a stack,
since this codebase never nests two savepoints; a second `SAVEPOINT` call
while one is already open should throw loudly, the same "this needs
redesign" signal an unexpected shape already gets elsewhere).

**New fault-injection option, mirroring the existing two exactly**
(`FakeConnectionOptions`, `armNextConnectionCrash`/`armNextConnectionPause`'s
own established shape in `source.ts`):

```ts
/** Test-only: after this many successful statements, the next statement
 * throws an injected error AND poisons this connection (every later
 * statement fails with "current transaction is aborted" until ROLLBACK or
 * ROLLBACK TO SAVEPOINT) — unlike crashAfterStatements, the connection
 * itself survives. Models a real mid-transaction SQL error (a lock-wait
 * timeout, a deadlock) — the exact class relation-index-concurrent-
 * rebuild.integration.test.ts found live. */
poisonAfterStatements?: number;
```

`query()` gains, immediately after the existing `dead` check: if
`poisoned`, throw `current transaction is aborted, commands ignored until
end of transaction block` for **every** statement except `ROLLBACK` and
`ROLLBACK TO SAVEPOINT LEOPARD_LOOKUP` (which clears `poisoned` and, for the
savepoint form, truncates `this.pending` back to `pendingLengthAtSavepoint`
— discarding exactly the ops buffered since the savepoint, restoring
everything before it, matching real Postgres's own `ROLLBACK TO SAVEPOINT`
semantics precisely). `RELEASE SAVEPOINT LEOPARD_LOOKUP` while poisoned must
itself fail the same "transaction is aborted" way — real Postgres does not
let you release a savepoint out from under a poisoned transaction, only
roll back to one — a correctness detail worth getting exactly right, since
getting it wrong (silently succeeding) would make the fake more forgiving
than real Postgres in exactly the direction that would hide a bug.

**Why this is necessary, not merely thorough — a property that would be
vacuous without it.** A weaker design — inject one thrown error from a
single statement, with no lasting effect on the connection afterward —
cannot distinguish "the code under test has a working `SAVEPOINT`/`ROLLBACK
TO SAVEPOINT` recovery" from "the code under test has none at all and the
connection just happens to work anyway," because both would pass the exact
same assertion (the fallback statement succeeds). That is precisely the
"a race that never actually raced proves nothing about the property under
test" failure `raceUnderPause`'s own doc comment already names for a
different mechanism (D-101) — the same discipline applies here. Only a
genuinely poisoned connection makes the test able to tell the difference,
which is the entire reason this fault class earns its own new machinery
rather than being folded into the existing crash/pause primitives.

### Reusing `fetchReachableFrontierVia`, not reimplementing traversal a second time

The rebuild's own recursive CTE computes, per root, the identical
transitive closure `fetchReachableFrontier` already computes per check —
same cycle guard, same expiry filter, same per-iteration dedup rule,
batched over every root simultaneously instead of one root at a time. The
DST fake's own rebuild handler should call the already-existing, already
D-100-proven `fetchReachableFrontierVia` once per distinct
`(objectNs, objectId, relation)` root found in `state.relationTuples`,
then flatten each root's own BFS output to `(root, subject)` candidate rows
(keeping only rows whose reached node carries a real plain tuple,
`subjectRelation === null`) with the same "shortest wins" tie-break the
real corrected SQL's `ORDER BY array_length(via_path, 1) asc` uses — which
falls out for free from `fetchReachableFrontierVia`'s own breadth-first
`allRows` ordering (the first occurrence of a given `(root, subject)` pair
encountered while scanning `allRows` in order is, by construction, the
shortest one).

**This choice has a real, disclosed consequence worth stating precisely:
it makes "does an index-served ALLOW replay on the live CTE" (Candidate A,
`docs/LEOPARD-INDEX-PROPOSAL.md`) structurally untestable, and correctly
so, inside DST.** If both the fake's simulated rebuild and the fake's
simulated online fallback call the identical underlying traversal function,
they are _guaranteed_ to agree on every fixture by construction — no seed
could ever surface a Candidate-A-shaped divergence in the fake, because
there is only one traversal implementation to disagree with itself.
Building a _second_, independently-implemented in-memory closure algorithm
specifically so the two could diverge would not fix this: Candidate A is a
question about whether **two different real Postgres SQL statements** —
the online per-check recursive CTE and the offline per-root-batched
recursive CTE, different queries with different dedup granularity — agree
with each other. That question can only be answered by running both real
queries against real Postgres, which
`test/metamorphic/relation-index-soundness.integration.test.ts` already
does and must remain the permanent, sole owner of that property. DST
reusing one proven traversal function for both simulated paths is the
right choice specifically because it makes explicit that DST was never
going to be a second source of evidence for Candidate A — a full-repo
`grep` for a DST-level "Candidate A" test would be looking for something
that shouldn't exist.

## The interleavings actually worth exploring, and the invariants they earn

### D6 — the staleness invariant (the centerpiece; new)

**Property, stated the way `docs/INVARIANTS.md`'s existing five DST
properties are stated:** _A check pinned to floor `T`, running concurrently
with a rebuild that has not yet committed a generation whose watermark
`>= T`, must receive `{hit:false}` from `lookupRelationMembershipIndex` for
the entire duration until a generation meeting that floor actually
commits — never a hit sourced from a stale or in-flight generation._

This is the direct DST-native analogue of "the simulator found an
interleaving where the index served a stale allow," generalizing the one
hand-picked real-Postgres race
(`relation-index-concurrent-rebuild.integration.test.ts`'s two `describe`
blocks) into a seeded sweep the same way D2 generalized D-092's single
hand-picked repro into `production-check.dst.test.ts`'s own `it.each`
sweep. Mechanically: `raceUnderPause` (already built, D4) arms a pause at
each of `lookupRelationMembershipIndex`'s own two statement boundaries (the
state read; the row read) on a pinned check's connection, races a
concurrent rebuild's `COMMIT` against it, and asserts the lookup's own
watermark comparison never sees a generation the check's own floor
shouldn't yet be entitled to. Because the underlying visibility mechanism
is the same `commitSeq`/`isVisible` discipline D2 already built and D-099
already proved, this sweep is not discovering new soundness logic so much
as it is proving the new shape handlers _use_ that existing, trusted
mechanism correctly — exactly the same category of value the existing
five DST properties already provide for their own respective mechanisms.

### D7 — the non-blocking lock invariant (small, low-priority; new)

**Property:** _Of two connections concurrently calling
`pg_try_advisory_xact_lock` on the identical `(classid, objid)`, exactly
one acquires immediately and the other returns `false` immediately, never
blocking._ A single hand-driven two-connection test (mirroring D1's own
`advisory-lock.dst.test.ts` shape, no scheduler seed sweep needed — there
is no seed-dependent behavior to sweep over in a stateless boolean check)
suffices. As disclosed above, this reproduces a property already proven,
deterministically, against real Postgres — its value is fast-suite
regression coverage, not new evidence.

### D8 — the fallback-resilience invariant (the risky one; new)

**Property:** _An injected mid-lookup statement failure, at any point
inside `lookupRelationMembershipIndex`'s own two statements, is always
followed by a successful, `SAVEPOINT`-recovered fallback to
`sqlRelationMembershipWithWitness` — never a second, uncaught error
cascading from the same now-poisoned connection._ This is the direct DST
reproduction target for the exact bug class D-163 found live: arm
`poisonAfterStatements` at each of the two statement boundaries inside the
lookup (swept, not just the one D-163 happened to hit), confirm
`resolve()`'s own `try`/`catch` around the lookup, plus its
`SAVEPOINT`/`ROLLBACK TO SAVEPOINT` pair, together produce a healthy
connection for the fallback call every time, at every injection point.

## The model's limits — what real Postgres alone still has to prove

Three things this design deliberately leaves to
`relation-index-concurrent-rebuild.integration.test.ts` permanently, not as
an oversight:

- **`TRUNCATE`'s `ACCESS EXCLUSIVE` lock-blocking latency.** DST's fault
  model has no concept of "a plain `SELECT` blocks waiting for a
  table-level lock" at all — every existing read against `relationTuples`/
  `writeLog`/`namespaceConfigs` executes synchronously; the only blocking
  primitive DST has is the opt-in advisory-lock queue, which both sides
  must explicitly contend for. Building a genuine reader/writer table lock
  purely to reproduce this blocking would add real complexity for a
  property that is inherently about **latency**, not correctness — the
  visibility model above (§"New state") already gives the correct
  _answer_ a blocked-then-resumed reader would eventually see, without
  needing to simulate the wait itself. Per `docs/DECISIONS.md` D-142's own
  established distinction ("genuine OS-level... concurrency against a
  real, listening server, distinct from — not a replacement for — DST's
  deterministic single-process fault injection"), latency measurement
  stays real-Postgres-only, permanently.
- **WAL/vacuum-bloat pressure from a long-held `REPEATABLE READ`
  snapshot.** A storage-engine question DST was never built to answer
  (`docs/DST-PROPOSAL.md`'s own opening disclaims exactly this).
- **Candidate A (index-hit replays on the live CTE).** Structurally
  untestable in DST for the reason given above — real-Postgres-only,
  permanently, by design rather than by gap.

## Test plan

| File                                                                                 | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/store/dst/state.ts`                                                             | **Extended**: `relationMembershipIndex: RelationMembershipIndexRow[]`, `relationMembershipIndexStateVersions: RelationMembershipIndexStateVersion[]` added to `FakeStoreState`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/store/dst/shapes.ts`                                                            | **Extended**: six new handlers (§"New shape handlers"), `registeredShapeCount()`'s own tripwire count rises by six.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/store/dst/connection.ts`                                                        | **Extended**: the writable-`REPEATABLE READ` `BEGIN` text, the `pg_try_advisory_xact_lock` text, the three `SAVEPOINT`-family texts, the `poisoned`/`pendingLengthAtSavepoint` fields, `poisonAfterStatements` fault option.                                                                                                                                                                                                                                                                                                                                                                        |
| `src/store/dst/locks.ts`                                                             | **Extended**: `tryAcquireLock` (no queueing, immediate boolean).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/store/dst/source.ts`                                                            | **Extended**: `armNextConnectionPoison(afterStatements: number): void`, mirroring `armNextConnectionCrash`'s exact one-shot-arming shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `test/unit/store/dst/relation-index-rebuild.dst.test.ts` (new)                       | D6 — the staleness sweep, `raceUnderPause` at both lookup statement boundaries, many seeds via `dstSeedList`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `test/unit/store/dst/advisory-lock.dst.test.ts` (extended)                           | D7 — one new describe block, the non-blocking two-connection race.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `test/unit/store/dst/relation-index-savepoint-recovery.dst.test.ts` (new)            | D8 — `poisonAfterStatements` swept across both lookup statement boundaries; asserts zero uncaught throws and a correct fallback result at every injection point. **Its own fail-check, to be run once before trusting it**: temporarily remove `resolve()`'s `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` pair (reproducing the exact pre-D-163 code) and confirm this test goes red at every injection point — the direct DST-side confirmation that this new fault class actually has teeth, the same discipline `raceUnderPause`'s own doc comment already demands of itself.                             |
| `test/unit/store/dst/recognizer-coverage.dst.test.ts` (extended)                     | Six new manifest entries, one per new shape, each exercised through its real production caller (`rebuildRelationMembershipIndex`/`lookupRelationMembershipIndex`), not a synthetic query.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `test/unit/store/dst/production-check.dst.test.ts`, `token-pin-coverage.dst.test.ts` | **To be confirmed unchanged, not assumed** — the exact caveat `docs/LEOPARD-INDEX-PROPOSAL.md`'s own file-by-file table already named and could not itself verify, since DST could not execute this code path at all before this proposal. Now that it can: run both files' existing fixtures (which never set `useRelationIndex`/`LEOPARD_INDEX_ENABLED`) and confirm `ctx.relationIndexFloor` stays `undefined`, so zero new statements enter the pinned client's sequence and every existing `pauseAfterStatements` offset (D-143's own hard-won, already-shifted-once accounting) is untouched. |
| `.github/workflows/dst.yml`                                                          | **No new job** — the existing `dst-pr`/`dst-nightly` jobs simply pick up the new test files and the existing `DST_SEED_COUNT` knob scales D6's sweep exactly like every other seeded DST test. `docs/dst-regression-corpus.json` gains entries only once a seed actually finds something, per its own established, currently-empty-by-honesty convention.                                                                                                                                                                                                                                           |

## Considered and deferred

- **A general savepoint-name-parsing engine**, instead of the three
  recognized literals above. Rejected: it would be the first regex/fuzzy
  match anywhere in `shapes.ts`'s registry, contradicting that file's own
  stated permanent rule, for a codebase that issues exactly one savepoint
  name today. Revisit only if a second, independently-named `SAVEPOINT`
  call site is ever added elsewhere.
- **A real reader/writer table lock modeling `TRUNCATE`'s blocking
  behavior.** Considered and rejected above (§"The model's limits") —
  real value is latency measurement, which is out of DST's scope by
  design, not by omission.
- **Modeling `rebuild_started_at`/`rebuild_finished_at`/`row_count`
  faithfully.** Rejected — zero soundness-relevant code path ever reads
  them back; building this would be speculative fidelity with no test it
  enables.
- **A from-scratch second in-memory closure algorithm, independent of
  `fetchReachableFrontierVia`, specifically so DST could attempt its own
  Candidate-A-shaped check.** Rejected — explained at length above; it
  would answer a different, less valuable question than the real-Postgres
  differential suite already answers, at the cost of a second traversal
  implementation needing its own D-100-style equivalence proof.
- **Root-completeness (Candidate D) / Phase B DENY-from-index modeling.**
  Nothing exists in production to model — this document mirrors
  `docs/LEOPARD-INDEX-PROPOSAL.md`'s own "Candidate D... correctly,
  deliberately descoped from Phase A" and defers identically. Revisit only
  once Phase B itself ships.
- **The incremental-refresh / node-reachability-graph design's own reverse
  dirty-marking walk.** Never built — nothing to model. Named here only so
  its absence isn't mistaken for an oversight.
- **Extending DST to `authz leopard refresh`/`status`'s own CLI wrapper.**
  Thin, non-soundness-critical presentation code; the real integration
  test suite already covers it end to end (D-163). Out of scope.

### A related observation, found while reading, out of this document's scope to fix

`tupleDeleteHandler`'s own `bufferOp` (`shapes.ts`) splices a deleted row
out of the shared `relationTuples` array unconditionally at commit, with no
`commitSeq`-tagged tombstone — unlike an insert, which stays in the array
forever and is filtered purely by `isVisible`. Whether this means an
in-flight `REPEATABLE READ` snapshot anchored _before_ a later, unrelated
`DELETE`'s commit incorrectly loses visibility into a row it should still
see (real Postgres's own snapshot isolation says an older snapshot keeps
seeing a row deleted by a later transaction) is a question no existing DST
test appears to exercise — a `grep` across `test/unit/store/dst/` for a
test racing a snapshot's own later read against a concurrent delete of a
row that predates that snapshot's anchor finds nothing. This document does
not confirm this is a live bug (that would need an actual repro, outside a
design document's own scope) and does not propose fixing it — it is named
here only because it directly shaped a design choice above: `relation_
membership_index`'s own `TRUNCATE` handling deliberately does **not** reuse
this exact pattern by analogy alone; it reuses it because the specific
"unconditionally gone for everyone" behavior it produces happens to be
_correct_ for `TRUNCATE`'s real, distinct-from-`DELETE` semantics, verified
directly against the concurrent-rebuild integration test's own live
findings, not assumed transitively from `DELETE`'s own possibly-imperfect
precedent.

## The risk this design accepts, stated plainly

**The transaction-poisoning/`SAVEPOINT` fault class (D8) is the one
genuinely novel, unproven piece of this whole proposal — sized honestly,
not smoothed into looking like a mechanical extension of D0–D5.** Every
other addition here (the two tables' state shape, the six shape handlers,
the writable-snapshot mode, the non-blocking lock) is a direct,
low-risk generalization of a pattern D0–D5 already built and already
trusts. `poisoned`/`ROLLBACK TO SAVEPOINT` is not — it is a new state
machine layered onto `FakeConnectionImpl`, with a real correctness detail
easy to get subtly wrong (whether `RELEASE SAVEPOINT` while poisoned
correctly fails rather than silently succeeding, whether `ROLLBACK TO
SAVEPOINT` truncates `pending` to exactly the right length and no
further), and it is the _only_ piece of this design whose entire
justification is "without it, the property under test is vacuous" rather
than "without it, DST simply can't run this code." Before this design
should be trusted as a real regression guard for the D-163 bug class, its
own D8 test needs the fail-check named in the test plan above run for
real — the `SAVEPOINT` pair temporarily removed, the test confirmed red,
then restored — the same standard this project's own brief demands of
every fault-injection claim it makes, applied here to its own newest and
least-proven mechanism first.

## Revisit if

- **A shadow-table-and-rename variant of the rebuild's own publish step is
  ever adopted** (`docs/LEOPARD-INDEX-PROPOSAL.md`'s own disclosed,
  deferred alternative to `TRUNCATE`+`INSERT`-in-place). This document's
  own visibility model rests specifically on `TRUNCATE`'s documented
  "unconditionally gone, no per-row MVCC" behavior; a `RENAME`-based
  design may have different real semantics that were not verified here and
  would need its own re-derivation before reusing this design's model
  as-is.
- **Phase B (root completeness, DENY-from-index) ships.** This document's
  own D6–D8 scope is Phase-A-shaped throughout (ALLOW-only, pinned-only);
  Phase B would need its own new invariant (the DST-native mirror of
  Candidate D) built on top of, not instead of, everything here.
- **The `tupleDeleteHandler` tombstone question above is ever actually
  investigated and confirmed as a real gap** — if so, its fix may change
  what "reuse the DELETE pattern" means for any future table this
  project's DST harness models, and this document's own reasoning for why
  `relation_membership_index`'s specific reuse is correct (verified
  directly against `TRUNCATE`'s own distinct semantics, not borrowed
  by analogy) should be re-checked against whatever that investigation
  finds, though the conclusion reached here does not depend on `DELETE`'s
  own fidelity being correct or incorrect.
- **A second, independently-named `SAVEPOINT` call site is added anywhere
  in this codebase.** The exact-literal-recognition choice above (§"The
  genuinely new fault class") would need a second recognized triplet, or a
  reconsideration of whether a small, disclosed regex exception is finally
  warranted — not decided here.
