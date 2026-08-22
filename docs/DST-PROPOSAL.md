# Deterministic simulation testing — scope and design

A proposal, not yet built. Read this if the question is "what would it take
to test this service's write path the way TigerBeetle or FoundationDB test
theirs?" — the honest answer, including the parts of that comparison that
don't hold, not an assumed yes.

## The problem this exists to name, not hide

TigerBeetle and FoundationDB own their entire storage stack, so they can
run their whole system inside a deterministic simulator: one seeded
scheduler drives every clock, every random choice, every disk write, every
network delay, and every crash, and the same seed reproduces the same run
byte-for-byte forever. That's what lets them fuzz years of simulated
uptime — reordered I/O, torn writes, correlated crashes — in minutes, and
have a failing seed be a permanent, replayable regression the instant it's
found.

This project runs on real Postgres. We do not own Postgres's storage
engine, its WAL, or its crash-recovery code, and we have no way to
crash-inject _inside_ it from outside its own process. Claiming
"deterministic simulation testing" without saying that plainly would be the
kind of overclaim this project's own soundness-report language already has
a working discipline against making — "a measured result of this run's
fuzz budget, not a claim of general security" is the exact sentence to
apply here too.

**What we actually do instead: simulate at the storage seam, not inside
Postgres.** We swap `productionCheck`/`writeTuple`/`deleteTuple`/
`runMigrations`/`publishSchema`'s storage dependency for an in-memory
implementation that models Postgres's _documented_ transaction, lock, and
MVCC semantics — closely enough to inject partial writes, a crash between a
commit and the caller observing it, reordered or duplicated operations, and
seeded concurrent interleaving — and assert this project's own
consistency/correctness invariants hold across all of it. This proves the
application's own concurrency logic is correct under adversarial scheduling.
It does not prove Postgres's crash-recovery is correct — that's Postgres's
job, not this project's, and this document never claims otherwise. See
`docs/DECISIONS.md` D-095 for the settled version of this decision.

## How this design was chosen

Three independent, fully-worked architectures were scored against each
other by two independent judges before this one was picked, rather than
building the first idea that seemed reasonable:

- **Abstract seam** — replace every raw-SQL transaction/lock/query
  operation with a typed interface method, implemented identically by a
  real pg-backed adapter and an in-memory one. Scored 30/30 (of 50):
  strongest fault-class coverage, but the largest, most speculative new
  architecture of the three, and it has to land as one sweeping rewrite of
  nearly every store/resolve signature before the seam is swappable at
  all — the opposite of this project's own bias against building
  abstraction ahead of a proven need.
- **SQL-pattern-matching fake driver** — keep every call site exactly as
  it is; build a fake object that recognizes the specific SQL text sent
  today and simulates it. Scored 30/30: the smallest possible blast
  radius (zero production call sites change), but zero type-level
  protection anywhere, and every future migration file — something this
  project's own workflow does routinely — silently obligates hand-written
  support in a second file forever, with no way to enforce the two stay
  in sync.
- **Narrow hybrid** — extend the one precedent this project already has
  (`publishOne`'s `client: { query: Pool['query'] }`, a structural type
  narrower than concrete `pg.Pool`) rather than build a general
  abstraction or a SQL-parsing engine. Scored 39/50, independently, by
  both judges: promote only the handful of operations that demonstrably
  need more than a structural query type, leave everything else as
  trivial, and argue case-by-case why each promoted operation earns it.

The narrow hybrid is what follows. Two ideas from the other two designs
are grafted directly into it, not left as "also considered" — see "Two
grafts from the designs that didn't win" below.

## The boundary: fifteen plain shapes, three promoted operations

This project's entire write/read path — `src/store/tuples.ts`,
`src/store/tokens.ts`, `src/store/migrate.ts`, `src/schema/publish.ts`, and
the plain (non-transaction, non-recursive) parts of
`src/resolve/production/resolver.ts` — is exactly fifteen distinct SQL
shapes plus the three transaction-control tokens (`BEGIN`/`COMMIT`/
`ROLLBACK`), confirmed exhaustively by grepping every `client.query`/
`pool.query` call across those files. Only one of the fifteen
(`listTuplesByObject`'s optional relation filter) has more than one
literal-text variant, and even that's a closed set of two strings, not
dynamic SQL assembly.

**Fourteen of the fifteen stay exactly as they are** — ordinary
parameterized `INSERT`/`SELECT`/`DELETE` against `relation_tuples`,
`write_log`, `namespace_configs`, and `schema_migrations` — narrowed only
from concrete `pg.Pool` to a structural `{ query: Pool['query'] }` type,
the same narrowing `publishOne` already does. A trivial in-memory query
executor answers them: an exact-string lookup (`Map<string,
ShapeHandler>`, keyed on the SQL text after whitespace normalization — no
parsing, no regex, no tokenizer), throwing loudly on anything unrecognized
rather than silently returning an empty result.

**Three operations get promoted** to a named helper with two
implementations (a real pg-backed one and an in-memory one), because each
demonstrably needs more than "run a query and get rows back":

- **`withSnapshotTransaction`** — `productionCheck`'s
  `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction. Ordinary
  autocommit or plain `BEGIN`/`COMMIT` write-buffering only needs "don't
  see uncommitted writes." `REPEATABLE READ` needs a qualitatively
  stronger guarantee — every read in the transaction is frozen at one
  point in time, anchored at the transaction's _first query_, not at
  `BEGIN` (see `resolver.ts`'s own doc comment on why this ordering is
  load-bearing, and `docs/DECISIONS.md` D-092 for the phantom-witness bug
  this exact ordering closed). A per-connection write-buffer alone cannot
  express "immune to a write that fully commits five milliseconds later
  on a different connection" — that needs a real MVCC-lite mechanism,
  described under "Fault injection lives in the connection layer" below.
- **`withAdvisoryLock`** — one generalized helper, three real call sites,
  each keeping its own real SQL text on the pg-backed side: the
  global, transaction-scoped write-log lock (`tuples.ts`), the
  namespace-scoped, transaction-scoped publish lock (`publish.ts`, D-080),
  and the session-scoped migrations lock, held across multiple separate
  transactions on separate connections (`migrate.ts`; see that file's own
  doc comment for why it cannot be transaction-scoped like the other
  two). Postgres documents the two-integer and single-bigint-hash
  advisory-lock forms as structurally non-colliding keyspaces — this
  project relies on that fact for correctness, so the in-memory model
  needs three independently-keyed lock tables and two different lifetime
  models (auto-release-at-commit vs. explicit-release-or-session-death),
  not one shared write buffer.
- **`fetchReachableFrontierVia`** — the recursive CTE behind userset-subject
  membership (`fetchReachableFrontier`, `resolver.ts`). This is
  `WITH RECURSIVE` with a per-iteration `DISTINCT ON` dedup, a path-array
  cycle guard, and a depth cap (D-092) — a real graph-traversal
  _algorithm_ Postgres executes natively, not a SELECT with an unusual
  `WHERE` clause. No string match or light structural matcher can execute
  it against an in-memory table; it needs its own from-scratch BFS
  implementation, proven equivalent (see "Proving the frontier BFS
  matches real Postgres" below).

One operation that looks special but isn't promoted:
`fetchTuplesOnFrontier`'s batched `unnest(...)` join — an unusual shape,
but it performs no recursion and needs no concurrency primitive beyond
`withSnapshotTransaction`'s already-correct visibility, inherited for
free because it runs on the same client. Promoting it would buy nothing.

## Fault injection lives in the connection layer, not in shape handlers

Every statement — plain shape or promoted helper's internals — passes
through the same simulated connection object: a per-connection uncommitted
write-buffer, a monotonically increasing global commit-sequence number
that `COMMIT` assigns atomically when it merges the buffer into shared
state, and `ROLLBACK` (or a connection dying with an open buffer)
discarding it instead. Fault injection hooks this shared layer, which is
why an ordinary `INSERT` is exactly as crash-injectable as an advisory
lock's internals — the crash hook lives at "does this connection's next
statement get to run, does this commit land," not inside any individual
shape handler.

**Partial writes.** A scheduler-chosen crash point — an index into one
logical call's real statement sequence (`writeTuple`'s
`BEGIN → acquire lock → insert tuple → insert write_log → COMMIT`) —
discards the connection's write-buffer and marks it dead, modeling "the
process died mid-transaction, Postgres rolls back automatically." Swept
across every possible crash point, across many seeds. Asserted: for any
crash point before `COMMIT`, a fresh read sees neither the tuple row nor
the write-log row — proving the atomicity boundary is drawn exactly where
the code already claims it is, under every interleaving, not just by
inspection.

**Crash between commit and the caller observing it.** `COMMIT` applies
the merge for real — a fresh connection sees it immediately — but throws
instead of resolving the original caller's promise, modeling "Postgres
committed; the acknowledgment never reached the client." Asserted, by
retrying the same logical write for real afterward: exactly one tuple row
survives (the `ON CONFLICT ... DO NOTHING` insert absorbs the retry), the
write log has two entries and burned two tokens (the documented,
intentional idempotent-but-token-advancing contract, now proven under
this specific failure shape, not just a clean double-call), and a check
pinned to the second token still resolves correctly regardless of the
first attempt's unknown fate.

**Reordered or duplicated operations.** Reordering shares its mechanism
with concurrent interleaving (below) — the scheduler picks the next
statement to run from a seed-derived permutation of whatever's currently
ready. Duplication is a distinct, lower-level hazard: the scheduler marks
one statement to execute twice against the same open transaction, modeling
a transport-level redelivery rather than an application-level retry.
Duplicating the tuple insert is harmless by construction
(`ON CONFLICT ... DO NOTHING`). Duplicating the write-log insert is not —
`write_log` has no uniqueness constraint, so this produces two rows and
burns two tokens for what the application intended as one write. This is
a genuine, presently-undefended finding this design surfaces rather than
assumes away, and it's the first concrete result flagged as likely, not
hypothetical.

**Concurrent writers and readers, seeded.** The flagship scenario: start
`withSnapshotTransaction`'s body, and at a scheduler-chosen point _after_
its snapshot freezes (the connection's first real query) but before its
`COMMIT`, interleave a full independent write that grants or revokes
exactly the edge the check is reading. Asserted: the check's result must
be internally consistent with one frozen point in time and must not
observe the concurrent write, even though a brand-new connection issued
immediately afterward does — mechanically, every committed row carries
the commit-sequence number it became visible at, and a frozen snapshot
filters "visible as of sequence S," S captured at the connection's first
query. A sharper variant interleaves a write _between_ the frontier fetch
and the tuple-on-frontier fetch specifically, reproducing D-092's exact
fixed phantom-witness shape under every interleaving a seed tries, not
just the one hand-picked repro that originally found it. Ordinary cases
get the same treatment: two concurrent writes to the same key (one row
survives, both calls return success, both burn a token — the documented
contract, genuinely under concurrency); a write racing a plain,
unpinned read with no isolation promise at all (asserted only the weaker
property that contract actually offers — a clean pre- or post-write view,
never a torn read).

## Proving the frontier BFS matches real Postgres

`fetchReachableFrontierVia`'s in-memory implementation is not trusted
because it looks right — it's proven the same way this project already
proved the SQL it's replacing. D-092's own `DISTINCT ON` fix was verified
by generating 3,000 random cyclic/reconvergent graphs and comparing the
_set_ of reachable identities between the fixed and unfixed query, never
raw paths (path choice among same-iteration duplicates is documented as
unspecified). The frontier BFS gets the identical treatment, committed as
a permanent regression suite rather than a throwaway script: generate
random userset-subject-edge graphs (reusing `src/soundness/generators.ts`'s
already-seeded `fast-check`/`pure-rand` machinery, not a new PRNG), run
the real `fetchReachableFrontier` against a real Postgres testcontainer
and the new implementation against the in-memory table on the identical
fixture, and compare the _set_ of reached identities, `depthReached`, and
the derived `allowed` boolean — plus a direct replay of D-092's own
hardest known case, the 12-level branching-3 reconvergent-diamond chain.
Nothing above this suite — the scheduler, fault injection — gets to treat
the in-memory frontier as ground truth until it's green, the same trust
discipline this project already applies before letting the reference
resolver stand in as an oracle for the production one.

## Two grafts from the designs that didn't win

**From the abstract-seam design: enforce the snapshot-anchoring ordering
on both sides, not just the fake.** Once `REPEATABLE READ`'s
first-statement-anchors-the-snapshot rule stops being a literal SQL string
at the one call site that matters and becomes an opaque helper, nothing
stops a future edit to the real pg-backed implementation from silently
breaking it — the type system only says "give me a read-only, repeatable-
read transaction," not "and never run anything on this connection before
you do." `withSnapshotTransaction`'s in-memory implementation enforces the
ordering strictly by construction; its pg-backed implementation must add
an explicit runtime check — has any query run on this connection yet? —
and throw if the snapshot-anchoring query isn't first. Without this, DST
only ever exercises the side that was already safe.

**From the SQL-pattern-matching design: a required, always-on recognizer-
coverage gate.** This design's own sharpest self-disclosed risk is that
"a closed set of fifteen shapes" is a fact about today's code, not a
guarantee this design enforces — one ordinary future feature (a
filterable list-tuples endpoint with optional parameters, say) could turn
one plain shape into genuinely conditional SQL, and nothing stops that
from being "fixed" by bolting one more string variant onto the registry,
one PR at a time, with no single commit where the "trivial, closed set"
premise quietly stopped being true. The fix: a test that replays the
_existing_ integration suite against the fake executor and asserts zero
unrecognized-query errors, wired as a **required check on every PR** —
not a DST-scoped check, an ordinary one, so a PR that reworks a query's
wording for a reason with nothing to do with DST gets an immediate, named
CI failure instead of silent drift. Paired with a permanent, written
design rule: the executor is exact-match-only, forever — never a fuzzy or
regex fallback for any shape, because a wrong match producing a
plausible-but-fabricated result is strictly worse than a thrown error.

## CI

**On every PR** — a new job styled directly on `.github/workflows/
soundness.yml` (`concurrency: { group: dst-${{ pr_number }}, cancel-in-
progress: true }`, the same comment-upsert pattern via
`scripts/post-soundness-comment.mjs`'s established shape) — but with no
Postgres service container at all, since the whole point of the fake is
that this runs on pure JS state. A small, fixed seed batch, plus the
recognizer-coverage gate above, plus an unconditional replay of the full
regression corpus (below) on every run.

**Nightly** — genuinely new machinery; no scheduled workflow of this
shape exists anywhere in this repo today except CodeQL's unrelated weekly
SAST cron. Thousands of seeds, the full fault-injection matrix at higher
injection probability than a PR budget affords, filing or updating one
tracking issue per distinct failure signature.

**Regression corpus** — also genuinely new; this repo has no persisted
seed corpus even for the _existing_ soundness fuzzer, which draws a fresh
random seed every run. A checked-in file records `{seed, scheduleId,
failureSummary, dateFound}` for every real bug a seed ever exposed; every
PR replays the whole corpus unconditionally (cheap against an in-memory
driver), so a fixed bug can never silently regress. Worth returning to:
the existing soundness harness has the identical gap today and could
adopt the same corpus discipline once this work proves the pattern.

## Phased plan

Each phase gets its own `docs/DECISIONS.md` entry recording the specific
modeling choice made, in the file's own strict four-field template.

- **D0 — prove the seam is wireable at all.** The connection/transaction
  engine (write-buffer, commit-sequence tagging) plus the plain-shape
  executor for `tuples.ts`/`tokens.ts` only — no locks, no snapshots, no
  recursion. Narrow `writeTuple`/`deleteTuple`'s parameter type from
  concrete `Pool` to the `publishOne`-precedented structural type,
  verified by re-running the existing `tuple-store.integration.test.ts`
  suite unmodified against it. Exit: one DST test — two writes for the
  same key, a crash injected between them, atomicity asserted.
- **D1 — advisory locks.** `withAdvisoryLock` for both lifetime models;
  wire the write-log, publish, and migrations locks through it. Exit: the
  D-083 reordering regression generalized across seeds, plus a
  session-lock-crash test proving the lock auto-releases when its holding
  connection dies.
- **D2 — snapshot transactions.** `withSnapshotTransaction` and the
  commit-sequence visibility model; wire `productionCheck` through it.
  Record explicitly in its own decision entry that narrowing
  `productionCheck`'s storage dependency is orthogonal to D-022 (which
  forbids the _reference_ resolver sharing code with the _production_
  one — parameterizing which physical driver answers the production
  resolver's own storage calls touches neither side of that boundary).
  Exit: the flagship D-092 phantom-witness regression reproduced and
  proven unreachable under many seeded interleavings.
- **D3 — recursive frontier** (parallelizable with D2; depends only on
  D0). `fetchReachableFrontierVia` and its equivalence suite. Exit: zero
  set-level mismatches across a large seeded differential run against
  real Postgres, plus the reconvergent-diamond replay passing.
- **D4 — the scheduler.** Generalize D0–D3's ad hoc per-test crash
  points and interleavings into one seeded, reusable scheduler, built on
  the same `fast-check`/`pure-rand` infrastructure this project already
  chose. Exit: at least one earlier phase's test ported onto the shared
  scheduler with identical pass/fail behavior, proving the abstraction
  changes only how a test is driven, not what it tests.
- **D5 — CI wiring.** The PR job, nightly job, and regression corpus
  above, as real workflow YAML.

## The risk this design accepts, stated plainly

Both promotion boundaries described here — which SQL shapes stay plain,
which three get named helpers — are facts about this codebase _today_,
not structural guarantees the design enforces on its own. The recognizer-
coverage gate above is the mechanical backstop for exactly this: it cannot
prevent the boundary from needing to move, but it guarantees the moment
it needs to move is a loud, same-day, named CI failure — never a silent
one.
