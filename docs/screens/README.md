# Screens

Five static HTML mockups of what a real UI over this engine would look
like, per build spec §8. Open any file directly in a browser — each is
self-contained (inline CSS, a small amount of vanilla JS for filtering and
disclosure widgets, no build step, no external requests, no framework).

| File                                 | Screen           | What it shows                                                                                                                                                                                                       |
| ------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`namespaces.html`](namespaces.html) | Namespaces       | The 4 example namespaces, their relations/permissions, and every rewrite-rule kind rendered both as a readable expression and as the raw compiled JSON.                                                             |
| [`tuples.html`](tuples.html)         | Tuple browser    | All 22 seeded tuples, grouped by namespace, with a working substring filter.                                                                                                                                        |
| [`check.html`](check.html)           | Check playground | One real allowed result (the signature `dana` chain, five hops through two levels of nested groups) and one real denied result (`mallory`, blocked by an exclusion).                                                |
| [`soundness.html`](soundness.html)   | Soundness runs   | Two real, independent `authz soundness run` results, plus a clearly-labeled illustrative example of what a `false_grant` finding would look like (not a real finding — none has ever been found against this repo). |
| [`expand.html`](expand.html)         | Expand tree      | The full subject tree behind `document:eng_handbook#edit` and `folder:finance_docs#sensitive_review`, open by default so the depth is visible without clicking.                                                     |

**These are mockups, not a live app.** There is no backend behind any
button or form here — "Run check," "Compare versions," and similar
controls are either disabled with a stated reason or, where they do
something (the filters, the collapse/expand controls, copy-to-clipboard),
that something is pure client-side DOM manipulation. Every id, tuple,
check result, resolution path, and soundness run shown is real data
captured from this repo's own CLI and API running against
[`schema/example.authz`](../../schema/example.authz) and
[`scripts/seed-example.ts`](../../scripts/seed-example.ts) — nothing on
any screen is invented. Where a screen has no captured data for a
particular case, it says so rather than filling the gap.

To reproduce the underlying data yourself: see the README's
["Try it yourself"](../../README.md#try-it-yourself--under-10-minutes-from-a-clean-clone)
section.
