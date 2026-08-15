# Versioning policy

This project follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`). This page says precisely what that means for this package — what's covered by the stability promise, what triggers each kind of bump, and how deprecation works — so a version bump is never a guess for either side.

## Before `1.0.0`

Per SemVer's own rules, `0.x.y` is initial development: the public API may still change at any time, and no compatibility is guaranteed between minor versions. In practice this project has already been more disciplined than that floor requires — every release so far has used the `MINOR` slot for backward-compatible feature additions (e.g. `0.1.2` → `0.2.0` for the OpenTelemetry audit hooks) and `PATCH` for fixes only, never breaking anything silently. That discipline continues, but until `1.0.0` ships, treat any `MINOR` bump as the "check the changelog before upgrading" signal — [npm's own `^0.x.y` caret-range semantics](https://docs.npmjs.com/cli/v10/using-npm/semver#caret-ranges-123-025-004) already encode this: `^0.1.2` resolves `>=0.1.2 <0.2.0` and will **not** auto-upgrade across a minor bump the way `^1.x` would.

## What `1.0.0` commits to

Once this package reaches `1.0.0`, the following becomes a hard contract, not just a convention:

- **The public API is exactly what's reachable through this package's `package.json` `exports` map** — the root entry point and each documented subpath (`/tenant`, `/rbac`, `/rate-limit`, `/audit`, `/rls`, `/crypto`). Node's `exports` field is a closed map: any other path (`@novavey/multi-tenant-security-kit/rls/postgres`, for instance) is structurally unreachable for a consumer, even though the underlying file exists in `dist/` — so it was never part of the public surface and isn't covered by this policy, regardless of whether it happens to export something. The regex constants a couple of source files export for this repo's own fuzz tests (`IDENTIFIER_PATTERN`, `DEFAULT_TENANT_ID_PATTERN`) are the concrete example: real exports, but not part of any barrel, so not part of the public API.
- **`error.code` strings are stable.** Every error this package throws extends `SecurityKitError` and carries a machine-readable `code` specifically so callers can branch on it instead of parsing messages — see `src/errors.ts`'s own doc comment. Once `1.0.0` ships, an existing `code` value will not change and won't be removed without a `MAJOR` bump.
- **Removing or renaming an export, or changing a function/class's signature in a way that breaks existing correct callers, is a `MAJOR` bump.** No exceptions, including for something that looks like a bug fix — see Deprecation, below, for the path to actually remove something.
- **Adding a new export, or a new optional field to an existing options object, is a `MINOR` bump.**
- **A fix that doesn't change any documented behavior is a `PATCH` bump.**
- **Raising the minimum supported Node.js version (`engines.node`) is a `MINOR` bump, not `MAJOR`.** This follows common ecosystem convention: it's driven by upstream Node.js's own release/EOL schedule, not a change to this package's API, but it can still break a consumer running an old runtime, so it isn't a silent `PATCH` either.
- **Widening what's accepted (a looser type, an additional valid input shape) is `MINOR`; narrowing it (stricter validation, a previously-accepted value now rejected) is `MAJOR`**, even if the narrower behavior is arguably "more correct" — a caller relying on the old, looser behavior would break.

## Deprecation

Removing something always goes through one full `MINOR` release cycle first, never straight to removal in the next `MAJOR`:

1. The export gains an `@deprecated` JSDoc tag explaining what to use instead, and a note in `CHANGELOG.md`'s `### Deprecated` section. It keeps working exactly as before — this step is a `MINOR` bump (or ships alongside one), not `MAJOR`.
2. It's actually removed in the next `MAJOR` release after that, and `CHANGELOG.md`'s `### Removed` section for that release names every deprecated export that's now gone.

This means: if you're not using anything flagged `@deprecated`, a `MAJOR` bump should never surprise you — everything it removes was already visibly on notice for at least one prior release.

## What this policy does not cover

- `examples/` and `doc-examples/` — reference code and this repo's own CI-verified doc samples, not published package exports. `examples/` in particular is explicitly excluded from typecheck (see `eslint.config.js`/`tsconfig.json`, or any individual `examples/*.ts` file's own header comment) precisely because it's illustrative, not load-bearing.
- Anything under `test/` or internal, non-exported implementation details of `src/` — normal refactoring territory, changeable in a `PATCH` at any time as long as the public surface's observable behavior doesn't change.
- This repository's own tooling versions (the Node version CI runs against, `@changesets/cli`'s version, etc.) — distinct from `engines.node`, which is what the _published package_ requires of a consumer's runtime, not what this repo's own CI/dev tooling happens to need.
