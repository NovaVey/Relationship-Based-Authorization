# Changesets

This directory is managed by [Changesets](https://github.com/changesets/changesets),
which drives this repo's release automation — see the "How a release
happens" section of [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the full
flow.

**Quick version:** if your PR changes anything published in the npm
package, run `npx changeset` and follow the prompts — it asks which kind of
version bump (`patch`/`minor`/`major`) and a short summary, then writes a
markdown file here describing the change. Commit that file as part of your
PR. Changesets accumulates these across merged PRs and, on `main`, keeps a
"Version Packages" PR up to date with the resulting version bump; merging
that PR is what actually publishes to npm.

Changelog generation is intentionally **off** here (`"changelog": false` in
`config.json`) — `CHANGELOG.md` stays hand-written, matching the
detailed-prose format this project has used since `0.1.0`. A changeset's
own summary is only ever seen by reviewers of the PR that adds it, not
published anywhere; write the real `CHANGELOG.md` entry yourself as part of
reviewing the Version Packages PR before merging it.

See [changesets/changesets](https://github.com/changesets/changesets) for
the full documentation.
