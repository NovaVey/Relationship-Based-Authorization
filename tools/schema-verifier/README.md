# Schema verifier

A **static** verifier for this repo's own relationship-based-authorization
schema language (`src/schema/dsl/`, the same compiler the live service
imports and uses). Point it at a compiled schema and an invariant — "no
user should ever be able to view a private document," say — and it either
proves the invariant holds, or produces a concrete counterexample: real
tuples, replayed against the real, unmodified production check engine, so
a `VIOLATED` verdict is never just a static tool's opinion.

It never talks to a live system, a database, or a deployed instance. It
compiles a `.authz` schema file, builds a graph out of it, and searches
that graph — see [Fragments and guarantees](#fragments-and-guarantees)
below for exactly what "searches" means and what it does and doesn't
prove.

## Worked example

Take this schema (`examples/three-hop-leak.authz`) — a document-sharing
system with a `private_document` namespace meant to be visible only to its
`owner` (a `service_account`, never a plain `user`):

```
namespace organization {
  relation member: user | group#member
}

namespace group {
  relation member: user | group#member
}

namespace document {
  relation tenant: organization

  permission view = tenant->member
}

namespace private_document {
  relation owner: service_account
  relation linked_doc: document

  permission view = owner | linked_doc->view
}
```

Nothing here looks obviously wrong — `linked_doc` is a document a private
record happens to reference. But `private_document#view`'s rewrite rule
follows `linked_doc` into `document#view`, and any org member can view a
`document` scoped to their own org. Three hops, each individually
unremarkable:

```
private_document.linked_doc -> document.tenant -> organization.member -> user
```

The invariant (`examples/three-hop-leak.invariant`) says this should never
be possible:

```
invariant no_user_can_view_a_private_document {
  s: user
  o: private_document

  goal: view(s, o)
}
```

Run it:

```
npx tsx tools/schema-verifier/examples/run.ts
```

```
verdict: VIOLATED
fragment: monotone

counterexample tuples (write these and the invariant is genuinely violated):
  private_document:o#linked_doc@document:obj1
  document:obj1#tenant@organization:obj2
  organization:obj2#member@user:s

self-validation against the real engine: confirmed
  the real, unmodified production resolver was called with the witness
  tuples above written to a fake store, and it independently agreed: allowed.
```

The verdict, the three counterexample tuples, and the engine's own
confirmation are exactly what `test/worked-example.test.ts` pins in CI —
if this example ever stops being true (the schema changes, the engine's
behavior changes, the search itself regresses), that test fails.

That's the whole tool: compile a schema, state what should never be
reachable, get back either a proof it can't happen or three lines you can
paste into a bug report.

## Quickstart

From a fresh clone of this repository:

```
npm install
npx tsx tools/schema-verifier/examples/run.ts        # the worked example above
cd tools/schema-verifier && npx vitest run            # the full test suite
```

Everything under `tools/schema-verifier/` is self-contained — its own
`tsconfig.json`, `eslint.config.mjs`, and `vitest.config.ts` — but it
imports the schema DSL parser and compiler directly from `src/schema/dsl/`
rather than reimplementing them, so `npm install` at the repository root
is the only setup step; there is nothing to install inside this directory.

## Checking your own schema

There's no CLI yet (`verify-schema <schema-file> --invariants <file>` is
tracked, not built — see [What's not built yet](#whats-not-built-yet)
below). Until then, the library is what `examples/run.ts` shows: write a
short script in the same shape —

```ts
import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { buildSchemaGraph } from './src/ir/index.js';
import { parseInvariants } from './src/invariants/index.js';
import { checkAndValidate } from './src/validate/index.js';

const schema = compileSchema(schemaSource); // schemaSource: your .authz file's text
const invariant = parseInvariants(invariantSource).invariants[0]; // your .invariant file's text
const graph = buildSchemaGraph(schema.schema);
const { result, validation } = await checkAndValidate(graph, schema.schema, invariant);
```

`result.verdict` is `'HOLDS'`, `'VIOLATED'`, or `'UNKNOWN'` — see
[Fragments and guarantees](#fragments-and-guarantees) for what each one
actually promises. `result.witness` is the counterexample tuple list when
`VIOLATED`. `validation` is the §6 self-validation outcome — `'confirmed'`
means the real engine agrees; see `src/validate/types.ts` for the other
four outcomes and what each means.

### The invariant language

Three parts, always in this order:

```
invariant <name> {
  <typed variables, one per line, e.g. `s: user`>
  <optional constraints, e.g. `distinct(orgA, orgB)` or `tenant(s) = orgA`>
  goal: <permission>(<subject var>, <object var>)
}
```

See `fixtures/invariants/*.invariant` for real examples, including
`tenant-isolation.invariant`'s own comment on what a `relationEquals`
constraint can and can't prove (short version: it can prove a leak is
real; it essentially never proves one is impossible — see
`docs/DECISIONS.md` D-116 for why).

## Fragments and guarantees

Every check first asks which **fragment** the schema falls into, as
reachable from the invariant's own goal permission:

- **Monotone** (union and tuple-to-userset only — no intersection, no
  exclusion): the verifier is **exact** — sound and complete. `HOLDS`
  means the invariant provably can't be violated by any tuple set,
  ever — not "wasn't found," but "can't exist." This relies on a
  small-model property: if a violation exists at all, one exists using
  only object instances already reachable from the goal, so the search
  never needs to guess at an unbounded space. `docs/DECISIONS.md` D-115
  through D-117 have the full argument, including the counterexample
  self-validation (§6) that replays every `VIOLATED` witness against the
  real, unmodified production engine before it's ever reported.
- **Non-monotone** (the schema, as reachable from the goal, uses
  intersection or exclusion anywhere): the verifier runs a **bounded**
  search instead — every type-valid tuple set up to `k` objects per type,
  checked through the real engine directly. A `VIOLATED` verdict here is
  just as real as in the monotone case (it came from the real engine). A
  `HOLDS` verdict is reported as `HOLDS up to k = N`, never bare `HOLDS` —
  it means no violation was found within that bound, not that none
  exists. `docs/DECISIONS.md` D-118 has the full reasoning, including a
  real false-negative bug this bound caught while it was being built.
- **`UNKNOWN`** is a real, distinct outcome the monotone search can
  return on its own (before fragment routing even applies bounded
  search) — never silently collapsed into `HOLDS`. Reported with a reason.

This tool never edits, generates, or migrates a schema. A `VIOLATED`
verdict is a modeling question for whoever owns the schema, not
automatically a vulnerability — see `docs/FINDINGS.md` (§10, not yet
written) for that distinction applied to schemas this tool didn't author.

## What's not built yet

Tracked, explicit future work — not silently missing:

- **CLI and CI** (`verify-schema` command, required-PR-check wiring on
  this repo's own schemas) — build spec §9.
- **Third-party schema survey** (`docs/FINDINGS.md`, analyzing schemas
  this project didn't write) — build spec §10, `CHECKPOINT 6`.
- Explicitly out of scope for this tool entirely (build spec §13): no
  edits to the schema parser, engine, or storage layer; no consistency
  tokens; no SMT solver; no performance work; no web UI.

The nightly differential test (`test/differential.nightly.test.ts`, §8b —
brute-force agreement at `k = 3`, deliberately excluded from the default
`vitest run` because it's slow) is fully built and independently
verified, but not yet wired into a scheduled CI job — that's part of §9
above, not shipped early, per this branch's own file-touch discipline.
Run it directly:

```
npx vitest run --config tools/schema-verifier/vitest.nightly.config.ts
```

## Further reading

- `docs/INVARIANTS.md` — the invariant language and fragment guarantees,
  in more depth, with the fixtures that motivated each design decision.
- `docs/DECISIONS.md` — the dated decision log for this tool, D-114
  onward. Every non-obvious choice here (why bounded search's default
  `k` differs from the build spec's own illustrative `k = 3`, why a
  relation-equality constraint can't prove absence, the small-model
  property's exact scope) is recorded there, not just in code comments.
- `PROGRESS.md` — phase-by-phase build history.
