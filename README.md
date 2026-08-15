# Relationship-Based Authorization

[![CI](https://github.com/NovaVey/Relationship-Based-Authorization/actions/workflows/ci.yml/badge.svg)](https://github.com/NovaVey/Relationship-Based-Authorization/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A fine-grained, relationship-based authorization service in the style of
[Google Zanzibar](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/):
a schema DSL for defining relations between namespaces, a relation-tuple
store, and a graph-walking check engine that answers exactly one question —
does a relation path from this subject to this object actually exist — and
proves it never answers yes without one.

## Status: scaffold, not yet a working service

This repository currently holds CI, lint/format, the environment loader, and
a test suite — no implementation. The full build is specified phase by phase
in **[`.claude/commands/build-authz-service.md`](.claude/commands/build-authz-service.md)**;
that document is the plan, this README describes the destination it's
aimed at. Track real progress in [`PROGRESS.md`](PROGRESS.md) and the
reasoning behind non-obvious calls in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## The problem this is for

A flat `role` column or a scattered pile of `if (user.orgId === resource.orgId)`
checks can't express "can view this document because you're a member of the
group that owns the folder it's in" — and once an application starts
approximating that by hand, in a dozen slightly different ways across a
dozen routes, the actual security property (can this specific subject reach
this specific object through a real, current relationship) stops being
something anyone can verify. It becomes something everyone hopes is still
true.

Relationship-based authorization (ReBAC) makes the relationships themselves
the source of truth — `document:readme#viewer@user:alice`,
`folder:design#editor@group:eng#member` — and answers every permission
question by walking that graph, the same way, every time, in one place. The
question this project exists to answer about its own implementation is not
"is the graph model expressive enough" (Zanzibar and its production
implementations already settled that) — it's **does the check engine ever
say yes when no path exists.** See
[`test/isolation/`](test/isolation/README.md) for how that gets proven, not
just asserted.

## What this is not

This is not a from-scratch alternative to production Zanzibar
implementations — [SpiceDB](https://authzed.com/spicedb),
[OpenFGA](https://openfga.dev/), and [Ory Keto](https://www.ory.sh/keto/)
already exist, are battle-tested, and are the right choice for most teams
that need this today. This project is not a distributed, globally-consistent
authorization system either — it runs on a single Postgres, with
consistency handled by a token/zookie mechanism (see the build spec §6.3),
not multi-region consensus. It is not an ABAC/policy-language engine
(no attribute rules, no Rego/Cedar-style policy evaluation) — relationships
only. What it demonstrates is building and reasoning correctly about ReBAC
infrastructure end to end, soundness proof included.

## Repository layout (current)

```
src/config/env.ts    validated environment loading (Phase 0 scaffolding — see docs/DECISIONS.md)
test/isolation/       the inherited, repurposed isolation-proof suite — see test/isolation/README.md
docs/                 process docs (governance) + the build spec's supporting docs, as phases add them
.claude/commands/     the build specification — read this before any implementation PR
.claude/agents/       subagents the build specification delegates specific phases to
```

## Setup

```bash
npm install
cp .env.example .env   # see .env.example for what each variable is for
npm test                # runs the isolation suite — currently all `.todo()`, by design
npm run lint && npm run typecheck && npm run build
```

`npm run test:integration` additionally needs Docker (it spins up a real
Postgres via testcontainers once the tuple store exists — see
`vitest.integration.config.ts`).

## Contributing / building this out

Read [`.claude/commands/build-authz-service.md`](.claude/commands/build-authz-service.md)
in full before writing any implementation code — it defines the phases, the
data model, the soundness-validation methodology, the test plan, and the
subagent delegation rules this project is built under. Un-skip a `.todo()`
test only in the same change that implements what makes it pass.
