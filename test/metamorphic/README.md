# Metamorphic and invariant tests

A fourth proof mechanism, alongside the three this repo already has: the
differential-soundness fuzzer (`test/isolation/differential-soundness.fuzz*`)
compares the production engine against an independent reference resolver;
`tools/schema-verifier` proves static reachability facts about a compiled
schema with no tuples and no engine at all; DST
(`test/unit/store/dst/*.dst.test.ts`) proves concurrency/crash-safety
properties against a from-scratch in-memory model of Postgres's own
documented semantics. None of the three can catch a bug **both** the
production engine and the reference resolver share by construction — the
same misreading of an ambiguous spec sentence, made independently by both,
would still agree with itself, and differential fuzzing exists to compare
two implementations, not to check either one against the model itself.

**What a metamorphic/invariant property checks instead: a mathematical
relation between two or more calls to the SAME engine, true by the ReBAC
model's own definition** — set-theoretic and boolean-algebra facts about
what a relation, a union, an intersection, an exclusion, and a tuple-to-
userset hop actually mean, checked directly against the real production
engine (`src/resolve/production/resolver.ts`), against real Postgres. No
second implementation is needed for any of it — the property is true or
false on its own mathematical terms, and a violation is a real bug in the
one engine under test, not a disagreement to adjudicate.

## The properties, one file each

Every property below went through a genuine design → adversarial review →
correction cycle before a line of test code was written — see
`docs/DECISIONS.md` D-140 for the full account, including the two
properties whose _original_ form turned out to be **false** (a claimed
"atToken pins an exact historical snapshot" guarantee, and a claimed
"a check never observes a write with a token higher than its own pin" —
both real, both wrong; `docs/CONSISTENCY.md`'s own "floor, not ceiling"
framing is what actually holds) and were corrected or narrowed before
implementation, not silently shipped as originally proposed.

| File                                                                                                   | Properties                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Needs Postgres? |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| [`../unit/metamorphic/monotonicity.test.ts`](../unit/metamorphic/monotonicity.test.ts)                 | Unit tests for `src/metamorphic/monotonicity.ts`'s `classifyMonotone` — the classifier every monotone-dependent property below trusts, proven against hand-built cases (including an adversarial cycle-plus-independent-exclusion case) before anything else relies on it.                                                                                                                                                                                                                                                                                                                                                                            | No              |
| [`algebraic-properties.integration.test.ts`](./algebraic-properties.integration.test.ts)               | **A** — a duplicate write (idempotent in effect, not in token cost) never changes a later `allowed` verdict. **B** — writing two independent tuples in either order produces the same `allowed` verdicts once both are observed. **C** — deleting a permission's sole grounding tuple flips `productionCheck` and `expand()` from grant to empty together, cross-checking two independently-written production code paths against each other. **D** — a purely cyclic, ungrounded tuple graph resolves denied and terminates, at three levels: the SQL recursive-CTE guard, the TypeScript `visited`-Set guard, and the depth-ceiling backstop alone. | Yes             |
| [`monotonicity.integration.test.ts`](./monotonicity.integration.test.ts)                               | **4** — for any permission `classifyMonotone` certifies monotone (no exclusion anywhere in its transitive closure), adding a tuple can never turn an allowed check into a denied one. **5** — for the one guaranteed exclusion shape this repo's own fuzz generator ships (`unbanned_view = viewer - banned`), adding a `banned` tuple can only turn an allowed check into a denied one, never the reverse.                                                                                                                                                                                                                                           | Yes             |
| [`../unit/store/dst/token-pin-coverage.dst.test.ts`](../unit/store/dst/token-pin-coverage.dst.test.ts) | **7a/7b** — generalizes the existing D-092 phantom-witness regression (one schema shape, two pause points) across all four rewrite-rule kinds and every real post-anchor pause point each one issues, both pinned and unpinned. Deliberately does **not** implement the original design's "a check never observes a write with token > its own pin" claim — proven false during design review; `atToken` is a floor, and this file includes one explicit test demonstrating why.                                                                                                                                                                      | No (DST fake)   |

## Why some properties are narrower than they first look

**Property 4's classifier is sound but incomplete, on purpose.**
`classifyMonotone` conservatively classifies a cyclic permission as
non-monotone even when it's genuinely monotone (this repo's own guaranteed
`hierNs.view = editor | parent->view` self-reference, for instance) — the
alternative (an optimistic cache for an in-progress node) can misclassify a
genuinely non-monotone cyclic permission as monotone, which would be a
soundness bug in the classifier itself, not just missed coverage. A
narrower, honestly-scoped classifier that never lies beats a broader one
that might.

**Property 5 stays scoped to one hand-verified schema shape**, not a
general fuzz sweep — proving disjointness between an exclusion's `subtract`
branch and its `base` branch in general requires walking a relation's
`subjectTypes`, not just its permission's `RewriteRule` tree (a real gap
the design's adversarial review caught: the obvious-looking SQL citation in
the original justification named the wrong function entirely). Extending
this to arbitrary schemas is real, disclosed future work, not silently
assumed already covered.

## Running these

```bash
npm test                                        # unit tests, including monotonicity.test.ts
npm run test:integration                        # everything here that needs real Postgres
```

Every `*.integration.test.ts` file here follows this repo's own established
`PostgreSqlContainer`-per-file convention (see
`test/isolation/differential-soundness.fuzz.integration.test.ts`) — a
Docker-less sandbox substitutes a direct `DATABASE_URL` connection instead
(the same LOCALVERIFY accommodation D-092/D-093/D-107 already established),
never shipped as the committed form.
