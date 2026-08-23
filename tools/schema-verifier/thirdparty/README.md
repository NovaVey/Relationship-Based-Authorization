# Third-party schema survey (build spec §10, `CHECKPOINT 6`)

Real, published ReBAC schemas this project didn't write, translated into
this repo's own schema DSL and checked against invariants their own
documentation states or clearly implies. See `docs/FINDINGS.md` (repo
root) for the actual results table — this directory holds the translated
schema/invariant file pairs the table cites.

Two rules from the build spec itself, carried through everywhere below:

- A `VIOLATED` verdict on someone else's schema is a modeling question,
  not a vulnerability report. The honest framing is "this schema permits
  X, which may or may not be intended" — several entries below are
  exactly that: a schema's own documented, _intentional_ backdoor
  (`spicedb-superuser`), stated as such, not as a bug.
- Never published unless the counterexample passed §6 self-validation —
  every `VIOLATED` entry in `docs/FINDINGS.md` was replayed against the
  real, unmodified production engine (monotone fragment) or came directly
  from the real engine in the first place (non-monotone fragment, §7 —
  `boundedSearch` calls the real engine for every candidate).

## Sources

Fetched directly (not from memory) via `openfga/sample-stores` and
`authzed/examples`/`authzed/docs` (raw GitHub file content). Every schema
file below cites its exact source URL in its own header comment.

## Translation methodology

Both source ecosystems are Zanzibar-derived, like this project — the
concepts map cleanly, but neither source language is a syntactic match,
and one structural difference recurs in nearly every file:

**OpenFGA conflates "relation" and "permission" into one `define`.** A
single OpenFGA `define admin: [user, team#member] or repo_admin from
owner` is simultaneously a _directly writable_ typed relation (you can
write a `repo:x#admin@user:y` tuple) **and** a computed union over other
terms — this project's DSL keeps those two concepts separate (`relation`
= writable, `permission` = computed-only, no direct tuples). Translated
mechanically and consistently everywhere below:

```
// OpenFGA: define admin: [user, team#member] or repo_admin from owner
relation admin_direct: user | team#member
permission admin = admin_direct | owner->repo_admin
```

A bare OpenFGA `define member: [user, team#member]` with no rewrite terms
at all translates to a plain `relation member: user | team#member` —
no wrapper permission — exactly like this repo's own `schema/
example.authz` already does for e.g. `document.viewer`. A wrapper
permission is only introduced for a name this survey actually uses as an
invariant's own goal.

**SpiceDB already separates `relation`/`permission`**, same as this
project — `definition`/`relation`/`permission`/`+`/`&`/`-`/`->` map onto
`namespace`/`relation`/`permission`/`|`/`&`/`-`/`->` almost one-to-one.
The one real gap: SpiceDB's `use self` keyword (a permission that always
includes the object itself as an implicit subject) has no equivalent
here — noted, not faked, wherever it would otherwise apply.

**Known, disclosed expressiveness gaps — not translated, not faked:**

- **Wildcard subjects** (`user:*` in OpenFGA, `user:*` in SpiceDB —
  "grant to literally every current and future user"). This DSL has no
  wildcard concept; the small-model verifier's own soundness depends on
  reasoning over a bounded, named set of subjects, which a true wildcard
  doesn't fit. Schemas that use it (`openfga-gdrive`'s public-document
  case) have that specific mechanic left untranslated, disclosed in the
  file's own header — the rest of the schema is translated and checked
  normally.
- **Caveats / ABAC conditions** (OpenFGA's `condition` blocks with CEL
  expressions, SpiceDB's `caveat` blocks). This DSL has no runtime-
  attribute concept at all. Two source schemas that are built entirely
  around this (OpenFGA's `superadmin`, SpiceDB's `caveats`) are excluded
  from this survey outright rather than translated into something that
  no longer represents the real schema — see `docs/FINDINGS.md`'s own
  "Not analyzed" note.
