# Contributing

Thanks for your interest in contributing to `@novavey/multi-tenant-security-kit`.

## Prerequisites

- Node.js as pinned in [`.nvmrc`](./.nvmrc) (use `nvm use` if you have nvm installed)
- npm (this repo uses npm, not yarn/pnpm — a committed `package-lock.json` is
  the source of truth for dependency versions)

## Local setup

```sh
git clone https://github.com/NovaVey/Multi-Tenant-Security-Kit.git
cd multi-tenant-security-kit
npm install
```

## Codebase organization

Each security module lives in its own subdirectory under `src/`, with a
barrel `index.ts` that defines its public API:

```
src/
  tenant/
  rbac/
  rate-limit/
  audit/
  rls/
  crypto/
  http/
  errors.ts
  index.ts
```

Tests mirror this layout under `test/`, one directory per module. New code
should follow the same pattern: add or extend a module's directory and its
`index.ts` barrel, and add matching tests under `test/<module>/`.

`test/integration/` holds tests that need Docker (currently: RLS against a
real Postgres) — kept separate from the fast unit suite, run via
`npm run test:integration`, not part of `npm run verify`/`npm test`.

**Every code sample in `README.md` and `docs/*.md` is mirrored in
`doc-examples/`** and checked by CI (`npm run verify:docs`) — see
[`doc-examples/README.md`](./doc-examples/README.md). **If you edit a code
sample in a doc, update the matching file in `doc-examples/` in the same
commit** (and vice versa). This exists because two real bugs shipped in
past releases from doc samples that looked correct but didn't actually
compile or run — see `CHANGELOG.md`'s `0.1.1` and `0.1.2` entries.

## Before you push

Run the full verification gate — the same command CI runs:

```sh
npm run verify
```

This runs, in order: `format:check`, `lint`, `typecheck`, `test`, `build`,
`verify:dist` (checks the built package's public entry points still share
one `AsyncLocalStorage` instance — see `scripts/verify-dist-singleton.mjs`),
`verify:docs` (type-checks and runs every file in `doc-examples/` against
that same build), and `verify:types` (runs `@arethetypeswrong/cli` against
the real `npm pack` tarball — catches a package.json `exports`/`typesVersions`
mistake that breaks type resolution for consumers, which `tsc --noEmit`
alone can't: that only checks source-adjacent files, never what a consumer
actually resolves through the published `exports` map). A PR won't pass CI
unless this passes locally first. `test:integration` is separate (needs
Docker) — run it yourself if your change touches `src/rls/`.

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add per-tenant token bucket rate limiter
fix(rbac): correctly resolve inherited role permissions
```

Common prefixes: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

## Branch / PR workflow

- Branch off `main`.
- Open a pull request against `main`.
- CI must be green before merging (see branch protection rules); required
  approvals is currently 0 for this solo-maintained repo, but the PR + green
  CI requirement itself is never skipped, including for the maintainer.
- Prefer small, focused PRs over large multi-purpose ones — they're easier
  to review and safer to release.
- Dependabot PRs are a partial exception: low-risk updates (npm
  devDependency minor/patch, `github-actions` minor/patch) merge themselves
  automatically once CI passes — see
  [`docs/github-governance.md`](./docs/github-governance.md). Anything
  riskier (major bumps, production dependencies) still shows up as a normal
  PR waiting for review.

## How a release happens

Releases are driven by [Changesets](https://github.com/changesets/changesets),
not by a maintainer manually bumping `package.json` and pushing a git tag:

1. **If your PR changes anything published in the npm package**, run
   `npx changeset` and follow the prompts (which kind of bump —
   `patch`/`minor`/`major` — and a short summary). Commit the generated
   `.changeset/*.md` file as part of your PR. Purely internal changes
   (tests, CI, tooling, docs that aren't shipped) don't need one. See
   [docs/versioning-policy.md](./docs/versioning-policy.md) for precisely
   what does and doesn't count as a `patch`/`minor`/`major` change here —
   don't guess.
2. On every push to `main`, [`.github/workflows/release.yml`](./.github/workflows/release.yml)
   runs the full verify gate, then hands off to `changesets/action`, which
   keeps a **"Version Packages"** PR up to date with every merged
   changeset's version bump.
3. A maintainer reviews that PR — adding the real `CHANGELOG.md` entry by
   hand (changelog generation is deliberately off in
   [`.changeset/config.json`](./.changeset/config.json); see
   [`.changeset/README.md`](./.changeset/README.md)) — and merges it.
4. That merge triggers the release workflow again; with no pending
   changesets left and a version bump not yet on npm, it publishes with
   provenance, pushes the matching `vX.Y.Z` git tag, and creates a GitHub
   Release — all automatically, no manual tagging step.

Contributors' only release-related job is adding a changeset when their
change needs one; everything else is automatic once a maintainer merges
the Version Packages PR.

## Reporting bugs / requesting features

Please use the issue templates:

- [Bug report](./.github/ISSUE_TEMPLATE/bug_report.yml)
- [Feature request](./.github/ISSUE_TEMPLATE/feature_request.yml)

For security vulnerabilities, do **not** open a public issue — see
[SECURITY.md](./SECURITY.md) instead.
