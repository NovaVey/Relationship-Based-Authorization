# Invariants

This is the shared vocabulary the schema verifier (static safety) and
deterministic simulation testing — DST (dynamic safety) — both draw from,
so that a claim made by one project can be understood, and eventually
cross-referenced, by the other without either needing to know the other's
internals. The schema verifier's own build spec (§1, not checked into this
repo as a command file the way `.claude/commands/build-authz-service.md`
is — it was scoped directly, not saved) states the full three-part safety
argument this file exists to support:

- **Verifier (static safety)** — no unsafe path can exist, for any tuple
  set. This document's own subject: an _invariant_ is a claim about the
  schema graph itself, checked once, structurally, independent of what
  data ever gets written.
- **DST (dynamic safety)** — no unsafe path is observable at runtime,
  under any interleaving or failure. See
  [`docs/DST-PROPOSAL.md`](DST-PROPOSAL.md) for that project's own design;
  its dynamic invariants belong in a section of this file too, added by
  that branch, not retrofitted here.
- **Consistency layer (temporal safety, later)** — no unsafe path is
  observable after a revoking write is acknowledged. Not started; see
  [`docs/CONSISTENCY.md`](CONSISTENCY.md) for the one property already
  guaranteed today (read-your-writes via the consistency token), which
  this future layer would extend, not replace.

Three vocabularies invented at different times, for different failure
modes, are three unrelated features unless something states the
relationship between them plainly. That's this file's job — not to define
each project's own mechanism (their own docs do that), but to keep them
speaking about the same underlying claim: _for a given schema, who can
reach what, and under what condition should that never be true._

## Static invariants (the schema verifier)

An invariant is deliberately tiny — three parts, no more:

1. A set of **typed variables** — `s: user`, `o: document`, `orgA:
organization`. Each names a role a witness (a concrete object, once the
   verifier finds one) gets bound to. The type is a real namespace name,
   resolved against a real compiled schema only when an invariant and a
   schema graph are walked together (build spec §5) — parsing an
   invariant on its own never requires a schema to exist yet.
2. **Constraints** between those variables. Two kinds exist today,
   deliberately the minimum needed to state the two worked properties
   below:
   - `distinct(orgA, orgB)` — every listed variable must bind to a
     different object. This is the entire reason the invariant language
     is a constraint problem and not plain reachability: "cross-tenant"
     means precisely that two variables must **not** collapse onto the
     same node, and a reachability answer that quietly let them would be
     a false negative no amount of testing catches.
   - `tenant(s) = orgA` — applying the named relation to `s` must equal
     `orgA`. This is how the language expresses "the object this relation
     points to" without needing a first-class notion of what that
     relation means — `tenant` here is not a keyword, it's an ordinary
     relation name the real schema defines, resolved in §5, not here.
3. A **goal** — `goal: view(s, o)` — the permission call the verifier
   searches for a witness to. The verifier's answer is three-valued:
   `HOLDS` (no such witness exists, within whatever fragment/bound the
   schema falls into — see build spec §7), `VIOLATED` (a witness exists,
   and — build spec §6 — it has already been replayed against the real
   check engine and confirmed to actually return `allow`), or `UNKNOWN`
   (the search couldn't decide — never silently reported as `HOLDS`).

### Concrete syntax

```
invariant <name> {
  <var>: <type>
  ...
  distinct(<var>, <var>, ...)
  <relation>(<var>) = <var>
  ...
  goal: <permission>(<var>, <var>)
}
```

One statement per line; `//` starts a line or trailing comment; blank
lines are ignored. Variables must all be declared before any constraint
or the goal line. Exactly one `goal:` line per invariant, and it must
come last. `invariant`, `distinct`, and `goal` are reserved words. A
file may declare more than one `invariant { ... }` block.

Two identifier vocabularies, deliberately not one: an invariant's own
name and every relation/permission/type name (anything meant to resolve
against a real schema in §5) follow this project's existing
`IDENTIFIER_PATTERN` — lowercase `snake_case`, the same convention every
real namespace, relation, and permission in this repo already uses.
Variable names are local labels only, never resolved against anything,
and may use the mixed-case style this section's own examples do
(`orgA`, `orgB`) — constraining them to the schema convention too would
reject those very examples.

The parser (`tools/schema-verifier/src/invariants/parser.ts`) is
hand-written and line-oriented, not a character-level tokenizer — every
construct here is exactly one line, so a line is already the right unit
to both parse and blame in an error message. Every malformed-input error
names the line it came from; a malformed file collects every error found
rather than stopping at the first.

### The three worked fixtures

`tools/schema-verifier/fixtures/invariants/` ships three invariants,
required by build spec §4:

All three are checked against `tools/schema-verifier/fixtures/schemas/
tenancy.authz` — a small, purpose-built schema (not a copy of, or edit
to, `schema/example.authz`, which has no tenant/org-scoping relations at
all) authored specifically to give these three invariants real relations
to resolve against.

- **`tenant-isolation.invariant`** — build spec §4's own worked example,
  verbatim in shape: a user in one organization must never get `view` on
  a document belonging to another. **Verdict: `VIOLATED`**, not `HOLDS` —
  and that's the real finding, not a fixture bug. `tenancy.authz`'s
  `document.view = tenant->member` never once consults `user.tenant`; it
  only asks whether the subject is a `member` of whichever org the
  document's own `tenant` tuple names. `tenant(s) = orgA` pins a
  relation the permission's rewrite rule doesn't use, so nothing stops a
  witness from giving `s` a second, unconstrained `organization:orgB#
member` tuple alongside it. See `docs/DECISIONS.md` D-116 for the
  general principle this demonstrates: a `relationEquals` constraint can
  prove a leak real; it essentially never proves one impossible, because
  it pins one `(object, relation)` slot and the search's own terminal
  edge is almost always a different one.
- **`no-public-path-to-private-document.invariant`** — recast around the
  kind of claim this constraint vocabulary _can_ prove unconditionally:
  type-level unreachability. `o`'s type is `private_document`, whose
  `view` permission (`= owner`, `owner: service_account`) never accepts
  `user` anywhere in its rewrite closure, directly or transitively — no
  constraints needed at all. **Verdict: `HOLDS`**, and it's true
  regardless of what tuples anyone ever writes, not true-until-someone-
  adds-one.
- **`positive-control.invariant`** — deliberately satisfiable: no
  constraints at all beyond the typed variables and the goal, so any
  schema where `view` can ever be granted at all satisfies it. Its
  entire purpose is proving the verifier's search can actually find a
  witness when one plainly exists — a verifier whose search is broken
  and therefore always reports `HOLDS` is worse than no verifier, and
  this fixture is the check against exactly that failure mode.
  **Verdict: `VIOLATED`**, with a real witness (`document.tenant` then
  `organization.member` — `tenancy.authz` has no bare `viewer` relation
  to shortcut through, so this also doubles as confirmation the search
  finds a two-hop witness just as readily as a one-hop one).

### Checking an invariant (§5)

`tools/schema-verifier/src/reachability/checkInvariant(graph, schema,
invariant)` walks the schema-graph IR (§3) backward from the goal
permission, over the **monotone fragment only** — union,
computedUserset, tupleToUserset. Each tuple-to-userset hop introduces a
fresh object variable, unified via union-find with any invariant
constraint already naming that same `(object, relation)` slot; each
terminal (direct) edge checks the accumulated bindings for
satisfiability — union-find plus a type check, never a solver. A
`distinct(...)` group is enforced the same way, as a standing "never
unify these" fact the union-find carries throughout.

Reaching an intersection or exclusion edge yields `UNKNOWN` immediately
from this function — §7, below, is where those are actually handled;
`checkInvariant` itself never guesses. Cycles are handled with a
per-search-path visited-node set, exactly as
§3 anticipated: a revisited node is a dead end for that branch, not a
hang and not an automatic pass, matching the monotone fragment's own
small-model property that a minimal witness never needs to unroll a
cycle.

**The load-bearing lesson from building this** — see `docs/DECISIONS.md`
D-116 for the full account — is that `relationEquals` constraints are
good at proving a leak is real, and essentially powerless to prove one
is impossible: pinning `(object, relation)` slot A says nothing about
slot B, and a witness is always free to populate B on its own. A
provable `HOLDS`, with only the two constraint kinds §4 ships today,
needs the schema graph itself to offer no path at all from the goal
subject's type to the goal permission — type-level unreachability, not a
constraint argument.

### Self-validation (§6) — no verdict is trusted on the search's word alone

`tools/schema-verifier/src/validate/checkAndValidate(graph, schema,
invariant)` wraps §5's search with automatic replay against the real,
unmodified check engine, on a fresh in-memory scratch store (the DST
fake, `src/store/dst/` — the same real storage seam `productionCheck`
and `writeTuple` already run against throughout DST, never a second,
separate proof that the fake behaves like the real thing). `VIOLATED`
gets its witness written tuple by tuple and the real engine's own
verdict checked: `allow` confirms it (a real counterexample — tuples,
check, and the engine's own resolution path, all reproducible by anyone
in seconds); a denial, or any tuple the real schema itself rejects, is a
`mismatch` — the static model and the runtime engine disagree, reported
loudly, never silently downgraded. `HOLDS` gets the complementary,
empirical check: N random type-valid tuple sets thrown at the same goal,
none may ever produce `allow`.

This is also where a real bug in the tool's own witness-to-tuple
conversion was caught, immediately, by exactly the discipline this phase
exists to enforce — a witness reading perfectly sensibly on paper
(`document:o#tenant@organization:orgB`) turned out to be unusable the
moment it met the real tuple store, since `orgB` (a valid variable name)
isn't a valid tuple id (lowercase only). Full account: `docs/DECISIONS.md`
D-117.

### The non-monotone fragment (§7) — bounded search over intersection/exclusion

Intersection and exclusion don't have a small-model property the way
union/computedUserset/tupleToUserset do — `checkInvariant` (§5) can't
search them exactly, and never pretends to; it returns `UNKNOWN` the
instant it meets one. §7 gives that case a real answer instead of leaving
it there, for schemas where a caller is willing to accept "checked up to
a bound" rather than an exact result.

`tools/schema-verifier/src/reachability/scanReachability(graph,
goalNodeId)` walks _every_ edge reachable from the goal — unlike §5's
search, it never stops at an intersection/exclusion edge — and reports
which fragment the schema (as reachable from that one goal) falls into,
plus every relation node it passed through. `checkAndValidate` consults
this first, on every call: a `'monotone'` result routes to §5 and §6
exactly as before; a `'non-monotone'` result routes to
`tools/schema-verifier/src/bounded/boundedSearch` instead, and skips
self-validation entirely — every verdict this path returns already came
from the real engine directly, so there is nothing left to replay.

`boundedSearch` fixes a bound `k` on the number of fresh instances per
type, enumerates every type-valid candidate tuple up to that bound
(`bounded/candidates.ts`, drawn straight from each reachable relation's
own real `subjectTypes` — never generate-and-filter), and brute-forces
every _subset_ of those candidates directly through the real, unmodified
`productionCheck`. The first subset that produces `allow` is `VIOLATED`;
exhausting every subset with none allowing is always reported as `HOLDS
up to k = N` — a bare `HOLDS` is never returned for this fragment, per
the build spec's own explicit warning that collapsing "no counterexample
found within a bound" into an unqualified `HOLDS` is exactly the failure
mode that makes a verifier actively dangerous. An invariant's own
`relationEquals` constraints (`blocked(o) = s`) are held fixed as _given_
facts in every subset tried, never left to the enumeration to include or
omit — without that, a claim like "a blocked user can never publish"
would be meaningless, since nothing would keep `blocked` itself true. A
hard ceiling, `MAX_BOUNDED_CANDIDATES`, refuses to run rather than hang
once the candidate count would make brute force impractical — disclosed
as `UNKNOWN` with a specific reason, not a silent stall.

This is deliberately _not_ a second, hand-modeled evaluator for what
intersection/exclusion mean — the real engine already knows, and asking
it directly for each candidate subset is both simpler and more
trustworthy than a bespoke non-monotone semantics this tool would have to
get exactly right on its own. The real fallback for the general,
unbounded case is SMT (out of scope for v1); `docs/DECISIONS.md` D-118
has the full design, the tractability tradeoffs behind this project's own
default bound, and an encoding sketch for what a future SMT-backed phase
would need to handle — recursion, in particular, being the actual
obstacle a bare SMT call doesn't solve by itself.

### Testing the verifier itself (§8)

Every claim above rests on the shipped tests actually being able to fail
— §8 is where that gets checked directly, three ways, rather than
assumed from a green run.

**Mutation testing.** Nine hand-curated, single-change mutations, applied
one at a time straight to this tool's own core algorithmic files (the
union-find's conflict detection, the search's cycle safety and terminal
type check, fragment detection, the bounded-search ceiling, and both of
`generateGivenTuples`/`collectPoolNamespaces`'s own real bugs from §7),
each confirmed to turn the suite red for the right reason, then reverted
— this project's own standing "mutate the real code, confirm red,
restore" discipline, now run across the whole tool at once rather than
one feature at a time. Two mutations went completely uncaught on the
first pass — not noise, but real gaps: `collectPoolNamespaces`'s own
contribution turned out to be silently masked by a different line
nearby, and `replayWitness`'s second `mismatch` branch (engine denies
despite every tuple writing successfully) had no test reaching it at
all. Both closed with new, deliberately isolating tests rather than left
disclosed-but-open. Full mutation list, outcomes, and the two closed
gaps: `docs/DECISIONS.md` D-119.

**Differential-against-brute-force.** `src/schema/dsl/random.ts`'s own
header comment states this exactly, quoting the build spec: "on small
random schemas from §2b, run the verifier against a deliberately dumb
exhaustive checker." §7's `boundedSearch` already _is_ that checker —
`tools/schema-verifier/test/differential.test.ts` turns it into a
genuine second, independent oracle for §5's exact search specifically:
for every random schema/goal where `checkInvariant` reports `HOLDS`,
`boundedSearch` is run over the same reachable relations and must never
find a counterexample either. Deliberately the `HOLDS` direction only —
every `VIOLATED` §5 produces is already confirmed against the real
engine on every real run (§6); `HOLDS` previously had only empirical
sampling. A disagreement here would be exactly the "actively dangerous"
failure mode §5's own doc comment warns about, caught by an independent
implementation rather than assumed away by a clean test run.

**A known-answer corpus.** `tools/schema-verifier/test/known-
answers.test.ts` gathers every fixture invariant this project ships —
all five, across both fragments and both verdicts — into one literal
table with its exact committed result and the `docs/DECISIONS.md` entry
that reasoned out why, swept in a single loop. Not a duplicate of the
scattered mechanism-specific assertions elsewhere; this is the one place
a reader sees every answer this project has ever committed to as
correct, at a glance.

**Closing the gap between the paraphrase above and §8's own literal
text.** The three subsections above were built from a paraphrase of the
build spec, not its literal words — the real text asks for schema-level
mutation (not source-code mutation), a nightly run at a genuinely larger
bound ("up to 3 objects per type," explicitly not PR-blocking), and
three specifically-named pathological fixtures. All three gaps are
closed, alongside what's described above rather than replacing it:
`test/schema-mutations.test.ts` (eight schema-text mutations, two
subtle, against a genuinely-`HOLDS` fixture); `test/differential.
nightly.test.ts` (`k = 3` over 150 schemas, verified locally, twice,
deterministically — the actual scheduled-workflow wiring that would run
it nightly in CI is deliberately deferred to §9, "CLI and CI," where the
real spec text actually puts it, and stays outside this branch's own
file-touch discipline in the meantime); and three new pathological
fixtures — a genuinely self-
referential folder hierarchy, a schema whose only witness exceeds the
real engine's own `CHECK_MAX_DEPTH` (caught correctly as a self-
validation `mismatch`, a real static/runtime disagreement rather than a
bug), and a real mutual-cycle schema demonstrating that the real
engine's own cycle guard makes a cycle _never_ load-bearing for a grant
— a broader, disclosed observation about why this project's small-model
property seems to hold even outside the monotone fragment §1's own
theorem formally covers. Full account, including why a `boundedSearch`
`k`-based framing turned out not to fit the cycle case at all: `docs/
DECISIONS.md` D-120.

## Dynamic invariants (DST)

Not yet written here — this section is DST's own to add, in its own
vocabulary, cross-referenced by ID against the static invariants above
where the same underlying property is being claimed at a different layer
(e.g., a future dynamic counterpart to tenant isolation, checked under
concurrent writes rather than statically). See
[`docs/DST-PROPOSAL.md`](DST-PROPOSAL.md) for what DST has actually
proven so far (D0–D5, `docs/DECISIONS.md` D-095/D-097–D-102) — real,
shipped results that simply haven't yet been restated in this file's
shared vocabulary.
