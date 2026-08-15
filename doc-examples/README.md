# doc-examples

Every code sample shown in `README.md` and `docs/*.md` is mirrored here and
checked by CI (`npm run verify:docs`), so a doc that "looks right" but
doesn't actually compile or run against the real package never ships
silently — this is exactly how two real bugs shipped in past releases (see
`CHANGELOG.md`'s `0.1.1` and `0.1.2` entries) and were only caught by manual,
one-off doc sweeps. This directory turns that one-off exercise into a
permanent, automated check.

Unlike `test/` and `examples/`, files here import via the package's own
public name (`@novavey/multi-tenant-security-kit`, `/tenant`, `/rbac`, ...)
rather than relative `../src/...` paths, using Node's self-referencing
package feature (resolves through this repo's own `package.json` `exports`
map against the built `dist/`). That's deliberate: it's the only way to
actually exercise the published package shape — subpath export wiring,
built type declarations, everything a real consumer sees — the same class
of bug that slipped through 0.1.2 (a missing subpath re-export) would not
have been caught by a `../src/` import.

**Because of that, `npm run build` must run before `verify:docs`** — see
`package.json`'s `verify` script and `.github/workflows/ci.yml`'s `build`
job for where this is wired in.

## Layout

- `typecheck/*.ts` — one file per doc page, type-checked (not executed) via
  `doc-examples/tsconfig.json`. Pseudocode entities the doc doesn't define
  itself (a `db` client, an `app`, external SDK clients) are declared with
  `declare const`/`declare function` rather than given real implementations.
- `run/*.mjs` — the subset of each doc page's samples that are genuinely
  self-contained and side-effect-free enough to execute for real, asserting
  the actual runtime output/behavior (not just that it type-checks) — e.g.
  the RLS module's generated SQL is asserted to match the doc's own comments
  _exactly_, and the crypto module's samples do a real encrypt/decrypt
  roundtrip.

## The convention

**If you edit a code sample in `README.md` or `docs/*.md`, update the
matching file here in the same commit** (and vice versa — if a fix belongs
here, it almost certainly belongs in the doc too). `npm run verify:docs`
catches drift in behavior (a sample that no longer compiles or runs
correctly) but can't catch the two files' _text_ silently diverging while
both stay individually valid — that's a review-time check, not a tooling
one.
