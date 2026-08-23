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

- **`tenant-isolation.invariant`** — build spec §4's own worked example,
  verbatim in shape: a user in one organization must never get `view` on
  a document belonging to another. Expected verdict once §5 exists:
  `HOLDS`.
- **`no-public-path-to-private-document.invariant`** — structurally the
  same shape (distinct + two relation-equality constraints + a goal),
  applied at a narrower granularity: a user whose only standing is
  membership in some general-access group must never get `view` on a
  document scoped to a different, more restricted group. Expected
  verdict once §5 exists: `HOLDS`.
- **`positive-control.invariant`** — deliberately satisfiable: no
  constraints at all beyond the typed variables and the goal, so any
  schema where `view` can ever be granted (a bare `viewer` tuple is
  enough) satisfies it. Its entire purpose is proving the verifier's
  search can actually find a witness when one plainly exists — a
  verifier whose search is broken and therefore always reports `HOLDS`
  is worse than no verifier, and this fixture is the check against
  exactly that failure mode. Expected verdict once §5 exists: `VIOLATED`,
  with a one-tuple witness.

Both non-control fixtures reference relation names (`tenant`, `member`,
`visibility`) that no real schema in this repository currently declares —
`schema/example.authz`'s namespaces have no cross-namespace tenant/org
scoping today. That's a known, deliberate gap, not an oversight: build
spec §4 is the invariant _language_, checked independent of any schema;
choosing or authoring a real fixture schema whose relations these
invariants actually resolve against is §5's job, once an invariant and a
schema graph are walked together for the first time.

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
