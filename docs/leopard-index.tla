---- MODULE leopard_index ----
(***************************************************************************)
(* A TLA+ model of the Leopard-index-plus-fallback protocol shipped in     *)
(* `docs/DECISIONS.md` D-163 and designed in `docs/LEOPARD-INDEX-          *)
(* PROPOSAL.md`. Ground truth for this model is the REAL code, not just   *)
(* the proposal's prose: `src/store/relation-index.ts`                    *)
(* (`rebuildRelationMembershipIndex`, `lookupRelationMembershipIndex`) and *)
(* `src/resolve/production/resolver.ts`'s `relationIndexFloor` short-      *)
(* circuit in `resolve()`'s relation branch.                              *)
(*                                                                         *)
(* WHAT THIS MODELS, ONE SENTENCE EACH:                                   *)
(*   - A single global watermark token (`relation_membership_index_       *)
(*     state.watermark_token`), published atomically together with a full *)
(*     index rebuild (`TRUNCATE`+recursive-closure `INSERT`+watermark     *)
(*     `UPDATE`+`COMMIT`, one transaction).                               *)
(*   - A pinned check's own `atToken` gates whether it may trust the      *)
(*     index (`watermark_token >= requiredFloorToken`,                    *)
(*     `lookupRelationMembershipIndex` in `relation-index.ts`) or must    *)
(*     fall through to the live, out-of-scope-here recursive walk.        *)
(*   - Concurrent writes (`writeTuple`/`deleteTuple`, each minting a new  *)
(*     `write_log.token`), concurrent rebuild attempts (guarded by a      *)
(*     `pg_try_advisory_xact_lock`, so at most one is ever in flight),    *)
(*     and concurrent pinned reads, as independent, interleavable         *)
(*     actions.                                                           *)
(*   - The rebuild's own non-atomic PREPARATION (lock acquired, watermark *)
(*     read, recursive closure computed — all inside one still-open,      *)
(*     externally-invisible transaction) versus its perfectly atomic      *)
(*     PUBLICATION (the single `COMMIT` that makes the new watermark and  *)
(*     the new rows visible together, or not at all).                    *)
(*   - A DELIBERATELY WEAKENED variant (`RebuildPublishWatermarkEarly`/    *)
(*     `RebuildPublishRowsLate`, `NextWeakened`/`SpecWeakened`, below)     *)
(*     that splits that one atomic publish into two, to show a real       *)
(*     model checker actually catching the bug the real design's own      *)
(*     one-transaction publish forecloses. This is not a hypothetical     *)
(*     "what if" — Section "COUNTEREXAMPLE" below reports the actual,     *)
(*     reproduced trace.                                                  *)
(*                                                                         *)
(* WHAT THIS DELIBERATELY DOES NOT MODEL, AND WHY THAT'S STILL SOUND:     *)
(* see `docs/TLA-SPEC-NOTES.md` for the full discussion. In short: the    *)
(* real recursive-closure graph walk (`fetchReachableFrontier`,           *)
(* D-021/D-026's cycle guard, D-092's `DISTINCT ON` fix) is assumed       *)
(* correct and out of scope — exactly as this exercise's own brief        *)
(* frames it ("the assumed-correct, out of scope for your model" live     *)
(* path). This model does not recompute a tuple graph's transitive        *)
(* closure at all; it treats "is `subject` reachable from `root` as of    *)
(* write-log token T" as an ABSTRACT, opaque fact — `truthAt[T]` below —  *)
(* that write actions update directly (an edge appears or disappears),   *)
(* never re-derived from a lower-level tuple graph. This is a real,       *)
(* deliberate modeling decision, not a shortcut taken by omission: the    *)
(* property this model exists to check — Candidate C,                     *)
(* "Watermark staleness must never produce a false ALLOW"                 *)
(* (`docs/LEOPARD-INDEX-PROPOSAL.md`, "Candidate properties, adversarially*)
(* reviewed") — is a claim about the INDEX-VS-WATERMARK PUBLICATION       *)
(* MECHANISM, not about whether the recursive closure itself is computed  *)
(* correctly (a separate, already-differentially-fuzzed concern, D-100).  *)
(* Modeling `truthAt` abstractly lets this spec isolate exactly the       *)
(* mechanism under test instead of re-proving graph-walk correctness      *)
(* TLA+ is not the right tool to re-litigate here.                        *)
(*                                                                         *)
(* Also out of scope, named explicitly rather than silently omitted:      *)
(* Candidate F (the caller's own `maxDepth` gate on a stored `via_path`'s *)
(* length) and Candidate G (the live `min_expires_at` re-check) are       *)
(* SEPARATE, ORTHOGONAL soundness axes from watermark staleness — each    *)
(* would need `via_path` lengths or an expiry clock threaded through this *)
(* model for no analytical benefit to the property actually under test    *)
(* here, and each already has its own dedicated, disclosed live           *)
(* fail-check in `docs/DECISIONS.md` D-163's own test-suite account       *)
(* (`relation-index-watermark.dst.test.ts`'s 11 cases). Candidate D       *)
(* (root completeness) is Phase-B-only and does not exist in shipped      *)
(* code. The "a schema republish could invalidate the index" candidate    *)
(* was reviewed and dismissed in the proposal itself (schema-independent  *)
(* closure) and is not modeled here either.                               *)
(*                                                                         *)
(* ENVIRONMENT CONSTRAINT — DISCLOSED HERE, NOT JUST IN THE PROSE REPORT: *)
(* the real TLC model checker (`tla2tools.jar`) ships only via GitHub     *)
(* Releases (`tlaplus/tlaplus`), and this sandbox's network policy blocks *)
(* generic GitHub access (`github.com`, `api.github.com`,                 *)
(* `objects.githubusercontent.com` all confirmed 403/blocked). No cached  *)
(* copy of the jar exists anywhere under `/usr`, `/opt`, `/root`, or this *)
(* repo (checked directly); `apt`/`apt-cache` carry no `tlaplus`-adjacent *)
(* package; `pip` has nothing under that name. `npm` DOES surface one     *)
(* real hit worth naming precisely: `tla-checker` (npm, `tla-rs` on       *)
(* GitHub) — a ~1-month-old, single-maintainer, third-party TLA+ model    *)
(* checker written in Rust, compiled to WebAssembly, explicitly           *)
(* self-described as "a lightweight alternative to the official TLC model*)
(* checker for specs that fit its supported subset." This is NOT the      *)
(* official TLC and this spec does not pretend it is. It was used, with  *)
(* that caveat disclosed at every mention, as a genuine, best-effort,     *)
(* SUPPLEMENTARY empirical check in this sandbox — see                    *)
(* `docs/TLA-SPEC-NOTES.md` for exactly what it was asked to check, what  *)
(* it reported, and the real `tla2tools.jar` invocation someone with      *)
(* GitHub access should run for the authoritative result.                 *)
(***************************************************************************)

EXTENDS Naturals, FiniteSets

CONSTANTS
  Roots,      \* Finite, nonempty set of abstract (object_ns, object_id, relation) "root" identifiers
              \* — what `relation_membership_index`'s own
              \* (object_ns, object_id, relation) key columns range over. Kept as opaque
              \* identifiers (never structured (ns,id,relation) triples) because nothing in
              \* Candidate C's own claim depends on that internal structure — only on "which
              \* root," an abstraction the real schema's own composite primary key already
              \* makes for us.
  Subjects,   \* Finite, nonempty set of abstract leaf-subject identifiers — the
              \* (subject_ns, subject_id) columns, same abstraction rationale as Roots.
  MaxToken    \* Upper bound on the write-log token counter. See "BOUNDS, NAMED AND
              \* JUSTIFIED" below for why this (and no separate depth or rebuild-attempt
              \* bound) is the one cardinality knob this model actually needs.

ASSUME
  /\ IsFiniteSet(Roots)    /\ Roots # {}
  /\ IsFiniteSet(Subjects) /\ Subjects # {}
  /\ MaxToken \in Nat      /\ MaxToken >= 1

(***************************************************************************)
(* BOUNDS, NAMED AND JUSTIFIED.                                           *)
(*                                                                         *)
(* MaxToken — the model's only "time" bound. Every Write action consumes  *)
(* exactly one token (mirroring `write_log.token`'s own strict            *)
(* monotonicity — one row per write, never reused, never skipped). The    *)
(* smallest counterexample to the DELIBERATELY WEAKENED variant needs     *)
(* exactly two writes (an add, then a revoke of the same edge) plus one   *)
(* rebuild generation straddling each — i.e. MaxToken = 2 is already      *)
(* enough to falsify the weakened model. The shipped `.cfg` uses          *)
(* MaxToken = 3: one token of headroom above the minimal falsifying case, *)
(* enough to also exercise "write again after a rebuild has already       *)
(* published," without inflating the reachable state count materially    *)
(* (the model's real cost driver is `truthAt`'s domain size, linear in    *)
(* MaxToken, not combinatorial).                                          *)
(*                                                                         *)
(* |Roots| = |Subjects| = 2 (not 1) — deliberately more than the bare     *)
(* minimum needed for the counterexample, specifically to confirm the     *)
(* invariant doesn't accidentally hold only because there is nowhere else *)
(* for a witness to go: with two roots and two subjects, TLC/tla-checker  *)
(* must also confirm a stale row for (root A, subject A) never gets       *)
(* wrongly entangled with a concurrent, unrelated write to (root B,       *)
(* subject B) — i.e. that the property is genuinely per-(root,subject),   *)
(* not an artifact of a degenerate single-edge state space.               *)
(*                                                                         *)
(* No separate "max rebuild attempts" bound. Considered and deliberately  *)
(* NOT added: `rebuildPhase` already cycles through a small fixed set of  *)
(* named phases (see `RebuildPhases` below), and the FULL state — every   *)
(* variable this spec declares — lives in a space that is already finite  *)
(* purely from MaxToken/Roots/Subjects being finite (`truthAt`'s domain   *)
(* and range, `indexRows`/`pendingRows`'s range, `currentToken`/          *)
(* `indexWatermark`/`pendingWatermark`'s range are all bounded by them).  *)
(* Nothing about repeating a full Idle -> Started -> ... -> Idle cycle    *)
(* many times produces a NEW, previously-unseen state once every variable *)
(* has returned to a value it has held before — TLC/tla-checker's own     *)
(* visited-state memoization means an unbounded NUMBER of rebuild cycles  *)
(* is fully compatible with a bounded, exhaustively-searchable state      *)
(* GRAPH. A dedicated rebuild-attempt counter would only add an unused    *)
(* dimension to the state space for no soundness benefit — the opposite   *)
(* of the "smallest model that can still falsify the weakened variant"    *)
(* discipline this spec follows throughout.                               *)
(***************************************************************************)

Edges == Roots \X Subjects
  (* One element per (root, subject) pair — the same granularity
     `relation_membership_index`'s own composite primary key
     (object_ns, object_id, relation, subject_ns, subject_id) uses. *)

RebuildPhases == {
  "Idle",                          \* No rebuild in flight — `pg_try_advisory_xact_lock` is free.
  "Started",                       \* Lock acquired, `pendingWatermark` read (real code's step
                                    \* 0/0.5/1, collapsed into one atomic transition here — see
                                    \* "WHY STEPS 0/0.5/1 COLLAPSE" below). Externally invisible:
                                    \* `indexWatermark`/`indexRows` are untouched.
  "InProgress",                    \* `pendingRows` computed from the FROZEN `truthAt[
                                    \* pendingWatermark]` snapshot (real code's TRUNCATE +
                                    \* recursive CTE + INSERT, all still inside the one open,
                                    \* uncommitted transaction). Still externally invisible.
  "WatermarkPublishedRowsPending"  \* ONLY reachable under `NextWeakened`/`SpecWeakened` — the
                                    \* real design has no analogue of this phase at all, by
                                    \* construction (see `RebuildCommit` vs.
                                    \* `RebuildPublishWatermarkEarly`/`RebuildPublishRowsLate`
                                    \* below). Its presence in this set, not in the correct
                                    \* model's reachable states, is exactly the point.
}

VARIABLES
  currentToken,      \* The real system's `select coalesce(max(token),0) from write_log`,
                      \* i.e. "the freshest token any write has actually minted so far."
  truthAt,            \* truthAt[T] : SUBSET Edges — the abstract, ground-truth oracle: "every
                      \* (root, subject) pair a live, correct recursive walk would report
                      \* ALLOW for, as of write-log token T." See the module header's own
                      \* "WHAT THIS DELIBERATELY DOES NOT MODEL" note for why this is an
                      \* opaque relation maintained directly by Write, never re-derived from a
                      \* lower-level tuple graph. truthAt[T] for T > currentToken is a
                      \* well-typed but meaningless placeholder — nothing in this spec ever
                      \* reads it (see PinnedRead's own `t \in 0..currentToken` guard, mirroring
                      \* `assertTokenObserved`'s real, enforced "you may only pin to an
                      \* already-observed token" precondition).
  rebuildPhase,       \* \in RebuildPhases — see above.
  pendingWatermark,   \* The watermark value THIS in-flight rebuild attempt read at its own
                      \* `Started` transition — real code's `REBUILD_WATERMARK_QUERY_TEXT`
                      \* result, held in the transaction's own local state until COMMIT.
  pendingRows,        \* The row set THIS in-flight rebuild attempt computed at its own
                      \* `InProgress` transition — real code's `candidate_rows`/the corrected
                      \* `DISTINCT ON ... ORDER BY array_length(via_path,1) asc` INSERT's
                      \* result set, likewise held uncommitted until COMMIT.
  indexWatermark,     \* The PUBLISHED, externally-visible `relation_membership_index_state.
                      \* watermark_token` — what `lookupRelationMembershipIndex`'s own first
                      \* query actually reads.
  indexRows,          \* The PUBLISHED, externally-visible `relation_membership_index` row set
                      \* (abstracted to (root,subject) key pairs — `via_path`/`min_expires_at`
                      \* are Candidate F/G's own concern, out of scope here, see the header).
  lastRead            \* Auxiliary/history variable, no real-system counterpart: records the
                      \* most recent `lookupRelationMembershipIndex` call's own inputs and
                      \* outcome, purely so `ReadHitIsSound` below can restate Candidate C's
                      \* English ("IF the index reports an ALLOW hit at floor-check time...")
                      \* as a literal transliteration against a concrete modeled read, as a
                      \* companion to the primary, read-independent state invariant.

vars == <<currentToken, truthAt, rebuildPhase, pendingWatermark, pendingRows,
           indexWatermark, indexRows, lastRead>>

TypeOK ==
  /\ currentToken \in 0..MaxToken
  /\ truthAt \in [0..MaxToken -> SUBSET Edges]
  /\ rebuildPhase \in RebuildPhases
  /\ pendingWatermark \in 0..MaxToken
  /\ pendingRows \in SUBSET Edges
  /\ indexWatermark \in 0..MaxToken
  /\ indexRows \in SUBSET Edges
  /\ lastRead \in [tok: 0..MaxToken, root: Roots, subj: Subjects,
                    hit: BOOLEAN, watermarkSeen: 0..MaxToken]

Init ==
  /\ currentToken = 0                    \* Empty `write_log` — real code's `coalesce(..., 0)`.
  /\ truthAt = [t \in 0..MaxToken |-> {}] \* No tuples written yet anywhere in history.
  /\ rebuildPhase = "Idle"
  /\ pendingWatermark = 0                \* Unused until the first `RebuildStart`; any value in
  /\ pendingRows = {}                    \* range is fine as an Init placeholder.
  /\ indexWatermark = 0                  \* Never-built index — migration 0010's own
  /\ indexRows = {}                      \* `insert into ... state (id) values (1)` row, with
                                          \* `watermark_token` at its declared `default 0`.
  /\ lastRead = [tok |-> 0,
                 root |-> CHOOSE r \in Roots : TRUE,
                 subj |-> CHOOSE s \in Subjects : TRUE,
                 hit |-> FALSE,
                 watermarkSeen |-> 0]    \* Sentinel: "no read has happened yet."

(***************************************************************************)
(* WRITE — a plain-grant or userset-edge tuple write/revoke                *)
(* (`writeTuple`/`deleteTuple`, `src/store/tuples.ts`), each minting       *)
(* exactly one new `write_log.token`. This model does not distinguish a   *)
(* plain-grant write from a userset-edge write, or an "add" from a        *)
(* "delete tuple" versus "tuple expired" — all of those are real,         *)
(* already-differentially-fuzzed distinctions in the LIVE recursive walk  *)
(* this spec deliberately does not re-implement (see the header). What    *)
(* matters here is only the one fact Candidate C's own claim is about:    *)
(* "a write can flip whether `truthAt` reports ALLOW for some             *)
(* (root, subject) pair, and it does so by minting a fresh token." `op`   *)
(* ranges over exactly the two directions a real write can move that      *)
(* fact (Add: some new tuple chain now proves membership; Remove: a       *)
(* revocation, an expiry, or a deleted userset edge removes the last      *)
(* proof of it — indistinguishable at this abstraction's granularity,     *)
(* and correctly so: Candidate C's own claim doesn't care WHY truthAt     *)
(* flipped, only THAT it can, at a specific, observable token).           *)
(***************************************************************************)
Write(r, s, op) ==
  /\ currentToken < MaxToken
  /\ currentToken' = currentToken + 1
  /\ truthAt' = [truthAt EXCEPT ![currentToken + 1] =
                   IF op = "Add"
                   THEN truthAt[currentToken] \cup {<<r, s>>}
                   ELSE truthAt[currentToken] \ {<<r, s>>}]
  /\ UNCHANGED <<rebuildPhase, pendingWatermark, pendingRows,
                  indexWatermark, indexRows, lastRead>>

AnyWrite == \E r \in Roots, s \in Subjects, op \in {"Add", "Remove"} : Write(r, s, op)

(***************************************************************************)
(* REBUILD — THE REAL, CORRECT DESIGN. Three sub-actions modeling the     *)
(* rebuild's genuinely non-atomic PREPARATION, and a fourth,              *)
(* `RebuildCommit`, modeling its perfectly atomic PUBLICATION.            *)
(*                                                                         *)
(* WHY STEPS 0/0.5/1 COLLAPSE INTO ONE `RebuildStart` TRANSITION: the     *)
(* real code's lock acquisition (`pg_try_advisory_xact_lock`), its        *)
(* `rebuild_started_at = clock_timestamp()` write, and its watermark read *)
(* (`REBUILD_WATERMARK_QUERY_TEXT`) happen in that order, but NONE of     *)
(* them changes anything an external reader can observe — `indexWatermark*)
(* `/`indexRows` are provably untouched by all three (the first is a      *)
(* lock, the second an operational-metadata column no check ever reads,  *)
(* the third a local read). Collapsing three internally-sequential but    *)
(* externally-invisible steps into one TLA+ action changes nothing this   *)
(* spec can observe about interleaving, and keeps the state space         *)
(* smaller for no loss of fidelity to the property under test.            *)
(***************************************************************************)
RebuildStart ==
  /\ rebuildPhase = "Idle"                \* the try-lock succeeds — real code's precondition
                                           \* for doing ANY work at all.
  /\ pendingWatermark' = currentToken     \* `coalesce(max(token),0)`, read now, frozen from here.
  /\ rebuildPhase' = "Started"
  /\ UNCHANGED <<currentToken, truthAt, pendingRows, indexWatermark, indexRows, lastRead>>

RebuildStartFailsLock ==
  (* The real `pg_try_advisory_xact_lock` returning false: "a refresh is already in flight
     elsewhere... this returns immediately... and does no other work at all — not even the
     watermark read" (relation-index.ts's own doc comment). Formally this is already implied by
     `[Next]_vars`'s own built-in stuttering allowance (a state where nothing changes is always
     a legal step) — it is named as its own action anyway, purely so "two concurrent refresh
     attempts, one wins the try-lock, one no-ops" is a first-class, readable behavior in this
     spec rather than an unnamed stutter a reader has to infer. *)
  /\ rebuildPhase # "Idle"
  /\ UNCHANGED vars

RebuildComputeRows ==
  (* The recursive CTE + the corrected DISTINCT-ON-shortest-path INSERT
     (`docs/LEOPARD-INDEX-PROPOSAL.md`'s own "single most consequential correction"),
     abstracted to: "the new generation's row set is exactly the ground truth AS OF THE
     WATERMARK THIS SAME TRANSACTION ALREADY COMMITTED TO AT `Started`" — never
     `truthAt[currentToken]` (which could have advanced past `pendingWatermark` via
     interleaved Writes by the time this fires). This is the direct TLA+ statement of
     `REPEATABLE READ`'s own guarantee: the whole rebuild transaction shares ONE snapshot,
     anchored at its first query, so a write that lands after that first query is invisible
     to every later query in the same transaction — exactly the discipline
     `assertTokenObservedOnSnapshot`'s own doc comment (`resolver.ts`) already relies on for
     the unrelated, but structurally identical, pinned-check case. *)
  /\ rebuildPhase = "Started"
  /\ pendingRows' = truthAt[pendingWatermark]
  /\ rebuildPhase' = "InProgress"
  /\ UNCHANGED <<currentToken, truthAt, pendingWatermark, indexWatermark, indexRows, lastRead>>

RebuildCommit ==
  (* THE LOAD-BEARING ACTION OF THIS ENTIRE SPEC. Real code: `UPDATE ... SET watermark_token =
     $1, ... ; COMMIT` — one transaction, one COMMIT, both the watermark and the row generation
     becoming visible to every other session at the identical instant (`relation-index.ts`'s own
     doc comment: "an external reader can never observe one without the other"). In TLA+, a
     single action IS a single indivisible transition by construction — there is no way for
     another action (in particular `PinnedRead`) to observe a state where `indexWatermark' `
     has updated but `indexRows'` hasn't, or vice versa, because no such INTERMEDIATE STATE
     EXISTS in the state graph at all. This is not an assumption this spec makes and then
     separately argues for; it is a structural fact about how TLA+ next-state relations work,
     and it is the actual, formal content of "the watermark write and the flattened-table write
     are literally the same transaction, the same COMMIT" (the proposal's own words). Compare
     directly against `RebuildPublishWatermarkEarly`/`RebuildPublishRowsLate` below, which
     re-introduce exactly the intermediate state this action's atomicity rules out. *)
  /\ rebuildPhase = "InProgress"
  /\ indexWatermark' = pendingWatermark
  /\ indexRows' = pendingRows
  /\ rebuildPhase' = "Idle"
  /\ UNCHANGED <<currentToken, truthAt, pendingWatermark, pendingRows, lastRead>>

(***************************************************************************)
(* THE DELIBERATELY WEAKENED VARIANT — NOT part of `Next`/`Spec`, NOT      *)
(* what `docs/leopard-index.cfg` checks. Exists only so this spec can      *)
(* demonstrate, not merely assert, that atomic publication is             *)
(* load-bearing: split `RebuildCommit`'s one atomic step into two,        *)
(* publishing the watermark before the rows, and confirm a model checker  *)
(* actually finds the resulting false-ALLOW window. See                   *)
(* `docs/TLA-SPEC-NOTES.md` ("COUNTEREXAMPLE") for the real, reproduced   *)
(* trace this produces, and the paragraph below for how to re-run it.     *)
(*                                                                         *)
(* HOW TO REPRODUCE: build a second `.cfg` identical to                   *)
(* `docs/leopard-index.cfg` except `SPECIFICATION SpecWeakened` in place  *)
(* of `SPECIFICATION Spec` (same `INVARIANT`/`CONSTANTS` lines,           *)
(* unchanged), then run TLC (or, absent TLC in this sandbox, the same     *)
(* `tla-checker` invocation `docs/TLA-SPEC-NOTES.md` documents) against   *)
(* this same module. Expect `IndexHitImpliesLiveTruth` to be reported     *)
(* violated, with a trace ending in a state where `rebuildPhase =         *)
(* "WatermarkPublishedRowsPending"`, `indexWatermark` already reflects a  *)
(* revocation, and `indexRows` still contains the revoked edge.           *)
(***************************************************************************)
RebuildPublishWatermarkEarly ==
  (* The bug being deliberately (re-)introduced: publish the NEW watermark while the OLD
     generation's rows are still what any reader sees. Real code never does this — there is no
     SQL statement boundary between "UPDATE watermark_token" and "the INSERT becoming visible,"
     because both are inside the one transaction this action pretends to split. *)
  /\ rebuildPhase = "InProgress"
  /\ indexWatermark' = pendingWatermark
  /\ rebuildPhase' = "WatermarkPublishedRowsPending"
  /\ UNCHANGED <<currentToken, truthAt, pendingWatermark, pendingRows, indexRows, lastRead>>

RebuildPublishRowsLate ==
  /\ rebuildPhase = "WatermarkPublishedRowsPending"
  /\ indexRows' = pendingRows
  /\ rebuildPhase' = "Idle"
  /\ UNCHANGED <<currentToken, truthAt, pendingWatermark, pendingRows, indexWatermark, lastRead>>

(***************************************************************************)
(* PINNED READ — `lookupRelationMembershipIndex`'s own two-gate logic,    *)
(* restricted to exactly the watermark-freshness gate (Candidate C);      *)
(* the depth gate (Candidate F) and the live-expiry re-check (Candidate   *)
(* G) are out of scope per the module header. `t \in 0..currentToken`     *)
(* mirrors `assertTokenObserved`'s own real, enforced precondition — a    *)
(* check can only ever be pinned to a token that has actually been        *)
(* observed; this spec does not model a check pinned to a future token    *)
(* because the real system rejects that before it ever reaches the index *)
(* lookup at all.                                                         *)
(***************************************************************************)
PinnedRead(t, r, s) ==
  /\ t \in 0..currentToken
  /\ lastRead' = [tok |-> t, root |-> r, subj |-> s,
                  hit |-> (indexWatermark >= t /\ <<r, s>> \in indexRows),
                  watermarkSeen |-> indexWatermark]
     (* `watermarkSeen` FREEZES the watermark this specific read actually observed. This is
        NOT a redundant field — an earlier draft of this spec's own `ReadHitIsSound` invariant
        compared a stored `hit` against `truthAt[indexWatermark]` using indexWatermark's
        CURRENT value at invariant-check time, rather than the value the read itself saw. Under
        the real, correct model that produced a SPURIOUS violation the instant a later,
        unrelated rebuild generation committed after this read had already returned a
        perfectly sound hit — a bug in this spec's OWN formalization, not in the protocol,
        caught empirically by actually running the checker (see `docs/TLA-SPEC-NOTES.md`,
        "A FALSE POSITIVE THIS SPEC ITSELF PRODUCED, AND THE FIX"). Freezing the observed
        watermark at read time, exactly as a real client would only ever reason about the
        answer it was actually given, fixes this. *)
  /\ UNCHANGED <<currentToken, truthAt, rebuildPhase, pendingWatermark, pendingRows,
                  indexWatermark, indexRows>>

AnyPinnedRead == \E t \in 0..MaxToken, r \in Roots, s \in Subjects : PinnedRead(t, r, s)

(***************************************************************************)
(* NEXT / SPEC — the real, correct design. Fairness is asserted only on   *)
(* the rebuild's own internal progression (a rebuild that acquires the    *)
(* lock and then never continues would be a real, distinct operational    *)
(* bug — a stuck lock holder), never on `Write` or `PinnedRead`: a real    *)
(* deployment where no client ever writes or checks again is a valid,     *)
(* unremarkable execution, not a liveness violation, so no fairness       *)
(* constraint is owed to those two. Fairness plays no role in the safety  *)
(* invariants this spec actually checks (TLC/tla-checker explore exactly  *)
(* the same reachable-state graph for an INVARIANT check with or without  *)
(* these WF conjuncts) — it is included for `Spec`'s own completeness as  *)
(* a specification, and would matter only for a liveness property this    *)
(* deliverable does not check (see `docs/TLA-SPEC-NOTES.md`).             *)
(***************************************************************************)
Next ==
  \/ AnyWrite
  \/ RebuildStart
  \/ RebuildStartFailsLock
  \/ RebuildComputeRows
  \/ RebuildCommit
  \/ AnyPinnedRead

Spec ==
  /\ Init
  /\ [][Next]_vars
  /\ WF_vars(RebuildStart)
  /\ WF_vars(RebuildComputeRows)
  /\ WF_vars(RebuildCommit)

NextWeakened ==
  \/ AnyWrite
  \/ RebuildStart
  \/ RebuildStartFailsLock
  \/ RebuildComputeRows
  \/ RebuildPublishWatermarkEarly
  \/ RebuildPublishRowsLate
  \/ AnyPinnedRead

SpecWeakened ==
  /\ Init
  /\ [][NextWeakened]_vars
  (* No fairness conjuncts — this variant exists only to be model-checked for a SAFETY
     violation (a specific bad state is reachable at all), which needs no fairness assumption;
     see "HOW TO REPRODUCE" above. *)

(***************************************************************************)
(* THE CENTRAL STALENESS INVARIANT — Candidate C, formalized.             *)
(*                                                                         *)
(* `docs/LEOPARD-INDEX-PROPOSAL.md`'s own English: "Watermark staleness   *)
(* must never produce a false ALLOW... for any query where                *)
(* `lookupRelationMembershipIndex` returns a hit, [the live path] pinned  *)
(* to `atToken := watermark_token` must also return `allowed: true`."     *)
(* Note precisely what that sentence pins the comparison TO:              *)
(* `watermark_token` — the index's OWN claimed generation — not the       *)
(* caller's original floor `T`. This is not a simplification this spec    *)
(* introduces; it is the design's own, adversarially-reviewed resolution  *)
(* of the exact ambiguity a reader might otherwise expect ("Candidate A", *)
(* same document): `atToken` is a FLOOR, not an exact pin — a check       *)
(* pinned to T only ever contracts to see everything up to and including  *)
(* T, never contracts to see NOTHING beyond it — so a fact that only      *)
(* became true strictly after T but at or before the index's own          *)
(* watermark W (>= T, or the gate would have missed) is a perfectly       *)
(* legitimate thing for an index-served ALLOW to reflect. Asserting       *)
(* equality against `truthAt[T]` instead of `truthAt[indexWatermark]`     *)
(* would be STRICTLY STRONGER than the real contract and would spuriously *)
(* fail even a fully correct implementation the moment a fresh grant      *)
(* legitimately appears between T and W — this spec deliberately does     *)
(* NOT make that mistake. (When there are zero writes between a rebuild   *)
(* and a check pinned to exactly that rebuild's own watermark — the       *)
(* proposal's own required discipline for its Candidate A test fixture —  *)
(* T and `indexWatermark` coincide exactly, and this invariant            *)
(* specializes to the literal "exact pin" reading as a special case; see  *)
(* `docs/TLA-SPEC-NOTES.md` for this correspondence spelled out.)         *)
(***************************************************************************)
IndexHitImpliesLiveTruth ==
  indexRows \subseteq truthAt[indexWatermark]
  (* Equivalent, spelled-out form, for a reader checking this against the English property
     directly: \A r \in Roots, s \in Subjects :
                  <<r, s>> \in indexRows => <<r, s>> \in truthAt[indexWatermark] *)

ReadHitIsSound ==
  (* The same claim, restated against a concrete, literally-modeled `PinnedRead` action's own
     recorded outcome rather than purely structurally — the direct transliteration of "IF the
     index reports an ALLOW hit at floor-check time, THEN a live check ... would also say
     ALLOW," using `watermarkSeen` (frozen at read time — see `PinnedRead`'s own comment above)
     rather than the index's current, possibly-since-advanced watermark. Logically implied by
     `IndexHitImpliesLiveTruth` holding at the moment of every `PinnedRead` transition; kept as
     its own named invariant because a violation here points a reader directly at an actual,
     concrete false-ALLOW read, which is easier to reason about at a glance than a purely
     structural set-containment fact. *)
  lastRead.hit => <<lastRead.root, lastRead.subj>> \in truthAt[lastRead.watermarkSeen]

====
