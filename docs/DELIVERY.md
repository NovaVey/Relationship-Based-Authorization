# Delivery — packaging this as a fixed-scope offer

This repository is a working demonstration, not the offer itself. What
follows is what actually gets delivered when this is done as real,
paid work against your own product's permission model — see
`.claude/commands/build-authz-service.md` §13, which this document
follows directly.

## Deliverables

- A namespace schema modeled from your actual product's object and
  permission structure — not this repository's `document`/`folder`/
  `group`/`org` example, your real objects, your real relations.
- A tuple store migrated onto your infrastructure.
- The check engine wired into your API (or exposed as its own service
  your API calls) — the same `check`/`expand`/`write`/`schema` surface
  this repository's own `authz serve` exposes, pointed at your schema.
- The soundness fuzz harness run against your real schema, so you know
  its own false-grant rate under adversarial random testing — not this
  repository's own number, yours.
- CI integration: the same differential-soundness check that runs on
  every PR to this repository, running on every PR to yours.
- A handover session.

## Timeline

2–3 weeks. Week 1 is schema modeling with your team — this is almost
always the actual bottleneck, not the engine. The check engine, the
soundness harness, and the CI wiring are largely fixed, well-understood
work once a schema exists; correctly modeling _your_ permission structure
as relations and rewrite rules is not, and rushing that step is where a
real project would fail regardless of how solid the engine underneath it
is.

## What I need from you

- Your current permission model, however informal — a spreadsheet, a
  paragraph, a pile of `if` statements nobody fully trusts. All of it is
  useful input.
- A list of the object types in your product and the relationships that
  should grant access to each one.
- Repo and infrastructure access for the CI and database integration.

## Out of scope

- **Authentication.** Who a subject _is_ is assumed solved before this
  project starts — this system answers "does this already-identified
  subject have this relationship to this object," never "who is this."
- A distributed, multi-region deployment (see the README's own
  non-goals — this runs on one Postgres, with a stated, tested
  consistency model, not global consensus).
- An ABAC/policy-language layer (no attribute rules, no Rego/Cedar-style
  policy evaluation — relationships only).
- Migrating your existing permission data without your team's own
  involvement in mapping it. The mapping — deciding what "can view this
  because they're in the group that owns its parent folder" actually
  means in relation-tuple terms, for your real objects — **is** the
  product. Outsourcing that step entirely defeats the purpose of doing
  this at all.

## Acceptance

- The soundness harness reports its false-grant rate on your real
  schema. Target: zero, always reported even when it isn't — a false
  grant found before launch is the harness doing its job, not a failed
  delivery.
- CI runs the soundness check on every PR, the same way it runs on every
  PR to this repository.
- Your team can read a resolution path and understand why a specific
  `allow` happened — the audit trail (§6.7) is only worth anything if
  the people who have to trust it can actually follow it.

## The opener on a first call, small and free

Ask how they currently prove that a permission change didn't accidentally
overgrant something. Almost nobody has an answer better than "we tested
the cases we thought of." Naming that gap, concretely, in the first five
minutes reframes the conversation from "we need better authorization" to
"we need a way to know our authorization is actually right" — which is
the actual question this project answers.
