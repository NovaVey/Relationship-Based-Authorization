# GitHub Repository Governance Checklist

This is a manual, one-time setup checklist for a repository admin. None of it
can be applied by pushing a commit — branch protection, secrets, and
repository-level security settings live in GitHub's settings UI / API, not in
the git tree. Work through these steps in order after the initial files in
this repo (workflows, `CODEOWNERS`, `dependabot.yml`, etc.) have been pushed
to `main`.

This repo is set up at the **Standard** governance tier: required CI checks
before merge, with the security audit job kept advisory rather than
blocking. The tier's _documented default_ also calls for one required
review before merge, but this repo currently runs with required approvals
dropped to **0** (solo maintainer, see Step 2) — required status checks
still gate every merge either way. Step 5 describes the upgrade path to a
stricter tier, including raising required approvals back to 1+ once there's
a second regular reviewer.

## Step 1 — General settings

**Settings -> General**

- Confirm the default branch is `main`.
- Optionally enable **Automatically delete head branches** (keeps merged
  branches from piling up).

## Step 2 — Branch protection for `main`

**Settings -> Branches -> Add branch protection rule** (the newer
**Settings -> Rules -> Rulesets** UI covers the same functionality and is
also acceptable — use whichever is available on your plan).

Create a rule targeting `main` with:

- **Require a pull request before merging**
  - Require approvals: **1** is the documented default; this repo currently
    runs with it dropped to **0** (solo maintainer) — "require a pull
    request before merging" stays enabled either way, so required status
    checks still gate every merge regardless of the approval count.
  - **Allowed merge methods**: this repo is configured **squash-only**
    (uncheck "Merge commit" and "Rebase", leave only "Squash" checked) —
    keeps `main`'s history one commit per PR, which matters for an
    easily-auditable authorization service and for `dependabot-auto-merge.yml`
    (Step 3) always squashing.
- **Require status checks to pass before merging**
  - **Require branches to be up to date before merging**
  - Once each check has run at least once on a PR (open any PR to trigger
    them), select these exact checks — the job names come directly from
    `.github/workflows/ci.yml`, plus `schema-verifier` from
    `.github/workflows/schema-verifier.yml`:
    - `lint-and-typecheck`
    - `test (22)`
    - `build`
    - `schema-verifier` — added once the workflow had run green on three
      real PRs (#83, #84, #85), per the deliberate hold stated in
      `docs/DECISIONS.md` D-123 and the schema verifier's own build spec
      §9 exit criterion ("wire it as a required PR check on this repo's
      own schemas"). It checks `banned_member_never_views_org` against
      `schema/example.authz` on every PR — gates on exit code `{0, 2}` =
      pass, `{1, 3}` = fail (D-123's own "Exit-code gating" section has
      the full reasoning for why a non-monotone `HOLDS up to k = 1` still
      counts as a pass here).
  - Do **not** add `security-audit` or `test-integration` to this list —
    both are intentionally advisory (`continue-on-error: true` /
    `test-integration`'s own comment in the workflow) under the Standard
    tier this repo uses. See Step 5 for the upgrade path.
- **Require conversation resolution before merging**
- Disallow force pushes to `main`.
- Disallow branch deletion.
- Apply these restrictions to administrators too (don't exempt admins from
  the rule), so the same gates apply to everyone.

## Step 3 — Enable Dependabot auto-merge

**Settings -> General -> Pull Requests -> check "Allow auto-merge"**

`.github/workflows/dependabot-auto-merge.yml` calls `gh pr merge --auto`,
which fails outright unless this repository setting is on. It's off by
default and isn't part of any Ruleset — a separate toggle you have to find
under General settings specifically.

**What it actually auto-merges — deliberately narrow:**

- npm **devDependency** bumps that are **minor or patch** (the same
  `dev-dependencies-minor-patch` group already batched in
  `.github/dependabot.yml`).
- `github-actions` ecosystem bumps that are **minor or patch**.

**What it never touches:** any `semver-major` bump, and any npm
**production**-dependency bump. Those PRs are left exactly as a normal
Dependabot PR — sitting there for you to review and merge by hand.

Auto-merged PRs still go through the exact same branch protection as
everything else — required status checks must pass, squash-only — this
workflow only flips "merge automatically once green," it never bypasses a
required check. It also auto-approves the low-risk subset it merges, purely
so the workflow keeps working unmodified if you ever raise required
approvals above 0; it has no effect while approvals are 0.

## Step 4 — Code security and analysis

**Settings -> Code security and analysis**

- Enable **Dependabot security updates** (this is separate from the
  version-update configuration already committed in
  `.github/dependabot.yml` — security updates react to published
  advisories, version updates are the weekly scheduled bumps).
- Enable **Secret scanning** and **Push protection**, if available on your
  plan.

## Step 5 — Upgrade path

If this project's risk profile grows (more contributors, wider adoption,
handling sensitive data), consider moving further toward a stricter
governance tier:

- ~~Add a CodeQL analysis workflow.~~ **Done** — `.github/workflows/codeql.yml`
  runs on every push/PR to `main` plus a weekly schedule, and reports to the
  repo's Security -> Code scanning alerts tab. It's deliberately **not** in
  the required-status-checks list above (same advisory posture as
  `security-audit`) — add `Analyze (javascript-typescript)` there yourself if
  you want it to block merges.
- ~~Pin third-party GitHub Actions to a commit SHA instead of a floating
  version tag.~~ **Done** — every third-party action across every workflow
  file is pinned to a full 40-character commit SHA, with a trailing
  `# vX` comment for readability (and so Dependabot's `github-actions`
  ecosystem updates, already configured in `dependabot.yml`, can still find
  and bump the pin when a new version ships). A floating tag like `@v3` can
  be repointed by the upstream repo — accidentally or via a compromised
  maintainer account — and a rerun would silently execute different code
  with whatever permissions that job already has; a SHA can't be
  repointed.
- Require **2** approving reviews instead of 1. **Not done** — left for a
  solo maintainer to opt into if/when there's a second regular reviewer;
  forcing it now would just mean self-approving or bypassing the rule.
- Require signed commits. **Not done** — a real workflow-friction cost (every
  contributor needs a configured signing key) for a benefit that mostly
  matters once commits come from more than one trusted person.
- Promote `security-audit` and `test-integration` from advisory to required
  status checks. **Not done** — `npm audit` can fail on a transitive
  dev-only advisory with no available fix, which would block every merge
  until upstream ships one; `test-integration` runs a real, non-`.todo()`
  suite today (18 files as of the 2026-08-25 live-verification doc audit,
  up from 13 when first counted; zero remaining `.todo()`s as of full-repo
  audit finding #18, MEDIUM, 2026-08-16 — this bullet previously, incorrectly,
  gave "a still-`.todo()` integration suite has nothing to fail on yet" as
  its own reason, which had been stale since roughly Phase 2), but
  container-based tests carry more infra-flakiness risk than the pure unit
  suite (`.github/workflows/ci.yml`'s own `test-integration` job comment
  makes the identical point) — a flaky Postgres testcontainer spin-up
  failing an unrelated PR's merge is a worse failure mode than the
  advisory status quo. Advisory keeps both visible without a false-failure
  mode.

The items above are intentionally left as a manual choice for whoever is
running this repo, not something to silently flip on.

---

This checklist exists because these are GitHub repository settings, not
files in this repository, so they can't be applied by pushing a commit — an
admin needs to click through them once.
