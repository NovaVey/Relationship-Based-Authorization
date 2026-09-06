# Third-party schema survey — findings (build spec §10, `CHECKPOINT 6`)

Twelve real, published ReBAC schemas this project didn't write — five from
[OpenFGA's `sample-stores`](https://github.com/openfga/sample-stores) and
seven from SpiceDB (six from
[`authzed/examples`](https://github.com/authzed/examples), one from
[`authzed/docs`](https://github.com/authzed/docs))
— translated into this repo's own schema DSL
(`tools/schema-verifier/thirdparty/*.authz`) and checked against invariants
their own documentation states or clearly implies
(`tools/schema-verifier/thirdparty/*.invariant`). Translation methodology,
the OpenFGA relation/permission split rule, and the disclosed
expressiveness gaps are in `tools/schema-verifier/thirdparty/README.md`.

Two rules, applied throughout:

1. **A `VIOLATED` verdict on someone else's schema is a modeling
   question, not a vulnerability report.** The honest framing is "this
   schema permits X, which may or may not be intended."
2. **Nothing below is published unless it passed §6 self-validation** —
   every `VIOLATED` entry was replayed against the real, unmodified
   production engine (monotone fragment) or came directly from the real
   engine in the first place (non-monotone fragment — `boundedSearch`
   calls the real engine for every candidate it tries).

## The recurring finding: no negative constraints

Nine of the twelve entries were originally `VIOLATED`, and eight of those
nine shared the same shape: the goal permission's closure contains _some_
relation directly grantable to the tested subject's own type, and this
project's invariant language could only **pin** facts (`distinct`,
`relationEquals`) — it had no way to state a _negative_ precondition
("subject `s` does **not** hold relation `R`"). So the bounded search
(and, for the same reason, the exact search's own direct-edge dispatch)
was always free to add one more, wholly unconstrained tuple of that
directly-grantable relation and satisfy the goal trivially, regardless of
what the invariant actually meant to probe. This isn't a bug in any of the
twelve source schemas — real authorization systems need direct grants —
and it isn't a bug in this project's verifier either; it's a genuine,
now-documented limit on what kinds of safety properties this invariant
language could state. It showed up identically across both ecosystems,
across six different domains (SaaS entitlements, org/repo access, expense
approval, chat workspaces, document sharing, a deliberate superuser
backdoor), which is itself the finding: it's a property of the _language_,
not of any one schema.

**Two of those eight have since closed.** `docs/DECISIONS.md` D-131 adds
a new, deliberately narrow invariant primitive — `not <relation>(<var>) =
<var>` — that lets an invariant explicitly rule out one already-known,
already-declared triple. `spicedb-entitlements` and `openfga-entitlements`
(below) each gained one line, `not member(o2) = u`, ruling out exactly the
extra membership the original witness relied on, and now report `HOLDS`.
**This closes 2 of the 9 disclosed entries, not all 8 that share the
underlying shape** — the primitive is intentionally narrow (bare
principal, declared variables only, one hop) and both closing entries
happen to be a single tupleToUserset chain with no alternate escape route.
The other 6 same-shape entries each have a second, structurally different
escape (a userset-subject or recursive path this primitive was never
designed to reach) and remain `VIOLATED`, unaffected — closing those would
need a fundamentally different, schema-level primitive ("this relation can
never be satisfied via any object, anywhere"), not attempted here. See
D-131 for the full account, including the empirical, entry-by-entry check
that arrived at "2 of 9," not the "8 of 9" the primitive's design
originally hoped for.

The one exception among the original nine — `openfga-expenses` — hits the
same underlying cause (a directly-grantable relation reachable in the
closure) but the witness is more interesting than a bare extra grant: a
self-referential `manager` loop, which is itself worth a schema's own
consideration, not just a language limitation. It is not one of the two
closed by D-131.

The four `HOLDS` entries below are exactly the cases where the "no
negative constraints" limitation doesn't apply, or has since been closed
for it: either the goal permission has **no** direct grant term of the
tested type anywhere in its closure (`spicedb-ai-agents`), the
unreachability is a structural type mismatch that no amount of extra
tuples can bridge (`spicedb-googledocs-typecheck-bug`, an exact proof
rather than a bounded check — see that row's own note), or the one escape
witness the survey recorded has since been explicitly excluded via D-131's
new primitive (`spicedb-entitlements`, `openfga-entitlements`).

**Correction (2026-09-06): `spicedb-userdefined-roles` has flipped from
`HOLDS up to k = 1` to a confirmed, exact `VIOLATED`, moving the published
tally from 7 VIOLATED/5 HOLDS to 8 VIOLATED/4 HOLDS.** The row below used
to report only what `boundedSearch` (D-118) could establish within its own
small candidate budget — "no counterexample found up to k = 1 or k = 2,"
never a proof of unreachability. D-151 (`docs/DECISIONS.md`) later added a
z3-backed exact tier ahead of bounded search for the non-recursive
fragment, but nothing re-ran this survey against it until now — the
tallies published here had simply gone stale, not been re-verified after
that tier shipped. Re-run directly against the current `verify-schema` CLI
(`npx tsx tools/schema-verifier/src/cli/index.ts tools/schema-verifier/thirdparty/spicedb-userdefined-roles.authz
--invariants tools/schema-verifier/thirdparty/spicedb-userdefined-roles.invariant`):
the SMT tier now decides this goal exactly and finds a real, self-validated
counterexample bounded search's own limited candidate budget never
happened to construct — see the corrected row below for the witness. This
is a genuinely different escape shape from the eight "directly-grantable
relation" entries above, and from `openfga-expenses`'s self-referential
loop: an unconstrained SECOND tuple (`project:obj1#role_manager@role:obj2#member`)
slipping past the already-pinned `role:r#project@project:p` relation the
invariant meant to hold fixed, letting the goal reach a _different_ role
manager's own delegated membership than the one the invariant pinned.
Closing it would need a schema-level primitive stating "this relation can
never be satisfied via any object, anywhere" — a materially bigger lift
than D-131's own narrow, one-hop, already-declared-variable primitive, and
not attempted here; tracked as its own still-open follow-up in
`docs/CAPABILITY-GAPS.md`.
`test/thirdparty-survey.test.ts` (`tools/schema-verifier/test/`, new) now
pins this exact verdict — and every other entry in this table — as a
permanent regression guard, so a future change to either tier can't
silently flip one back without a test noticing.

## Results

| Schema                             | Source                                                                                                                                 | Invariant tested                                                                                                                                                       | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Witness (if violated)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openfga-github`                   | [openfga/sample-stores: github](https://github.com/openfga/sample-stores/blob/main/stores/github/model.fga)                            | `plain_org_member_never_gets_repo_admin` — an org member (not owner) never gets repo admin without an explicit repo-level grant                                        | **VIOLATED** (monotone, self-validated)                                                                                                                                                                                                                                                                                                                                                                                                                                   | `repo:r#admin_direct@user:s` — a direct grant unrelated to the org-membership path the invariant meant to probe                                                                                                                                                                                                                                                                                                                                     |
| `openfga-expenses`                 | [openfga/sample-stores: expenses](https://github.com/openfga/sample-stores/blob/main/stores/expenses/model.fga)                        | `employee_never_approves_own_report` — an employee can't approve their own report                                                                                      | **VIOLATED** (monotone, self-validated)                                                                                                                                                                                                                                                                                                                                                                                                                                   | `report:r#submitter@employee:e`, `employee:e#manager@employee:e` — a self-referential manager loop (nothing in the schema's type system forbids an employee being declared their own manager)                                                                                                                                                                                                                                                       |
| `spicedb-entitlements`             | [authzed/examples: entitlements](https://github.com/authzed/examples/blob/main/schemas/entitlements/schema-and-data.yaml)              | `feature_access_requires_membership_in_entitled_org` — access to a feature requires membership in the _specific_ org its entitlement belongs to                        | **HOLDS** (exact, monotone; empirically confirmed clean across 25 sampled tuple sets — closed by `docs/DECISIONS.md` D-131's `not member(o2) = u`, added to the invariant to rule out the extra, unconstrained org membership the original witness relied on; see that entry's own account of what this does and doesn't generalize to)                                                                                                                                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `openfga-entitlements`             | [openfga/sample-stores: entitlements](https://github.com/openfga/sample-stores/blob/main/stores/entitlements/model.fga)                | `feature_access_requires_subscription_in_associated_org` — same question, OpenFGA's independently-authored equivalent model                                            | **HOLDS** (exact, monotone; empirically confirmed clean across 25 sampled tuple sets — closed the same way as `spicedb-entitlements` above, `not member(o2) = u`, confirming this is a language-level closure, not a one-schema quirk)                                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `spicedb-superuser`                | [authzed/examples: superuser](https://github.com/authzed/examples/blob/main/schemas/superuser/schema-and-data.yaml)                    | `document_admin_requires_ownership_chain` — document admin requires an actual ownership chain                                                                          | **VIOLATED** (monotone, self-validated)                                                                                                                                                                                                                                                                                                                                                                                                                                   | `document:d#owner_user@user:u` — a direct owner grant. The source's _own_ README and fixture assertion (`document:lasers#admin@user:drevil`, reached only via the platform's `super_admin`) confirm a site-wide superuser backdoor is the schema's deliberate design — but that isn't the path this witness exercises; the trivial direct grant is cheaper for the bounded search to find, and would exist with or without the intentional backdoor |
| `spicedb-docs-style-sharing`       | [authzed/examples: docs-style-sharing](https://github.com/authzed/examples/blob/main/schemas/docs-style-sharing/schema-and-data.yaml)  | `sibling_group_member_cannot_view_other_group_document` — a member of one group can't view a document shared only with a sibling group                                 | **VIOLATED** (monotone, self-validated)                                                                                                                                                                                                                                                                                                                                                                                                                                   | `document:d#viewer@user:a` — a direct viewer grant. The source's own `assertFalse` proves real sibling-group isolation exists in this schema; this survey's invariant language can't verify it, because `document.viewer` accepts a plain user directly, so _any_ invariant about it is trivially escapable regardless of the group logic being sound                                                                                               |
| `openfga-gdrive`                   | [openfga/sample-stores: gdrive](https://github.com/openfga/sample-stores/blob/main/stores/gdrive/model.fga)                            | `sibling_folder_viewer_cannot_read_document` — folder-level access to a sibling folder doesn't grant read on a document filed elsewhere                                | **VIOLATED** (monotone, self-validated)                                                                                                                                                                                                                                                                                                                                                                                                                                   | `doc:d#viewer@user:u` — direct viewer grant                                                                                                                                                                                                                                                                                                                                                                                                         |
| `openfga-slack`                    | [openfga/sample-stores: slack](https://github.com/openfga/sample-stores/blob/main/stores/slack/model.fga)                              | `workspace_guest_never_becomes_channel_writer` — a workspace guest never becomes a channel writer                                                                      | **VIOLATED** (monotone, self-validated)                                                                                                                                                                                                                                                                                                                                                                                                                                   | `channel:c#writer@user:u` — direct writer grant, unrelated to the `guest` relation (which has no rewrite path into `writer`/`commenter` at all)                                                                                                                                                                                                                                                                                                     |
| `spicedb-github`                   | [authzed/examples: github](https://github.com/authzed/examples/blob/main/schemas/github/schema-and-data.yaml)                          | `org_member_never_gets_repo_admin_without_role` — same question as `openfga-github`, checked against SpiceDB's own independently-authored model of the same domain     | **VIOLATED** (monotone, self-validated)                                                                                                                                                                                                                                                                                                                                                                                                                                   | `repository:r#admin@user:u` — direct admin grant, same shape as the OpenFGA entry above despite a structurally different schema                                                                                                                                                                                                                                                                                                                     |
| `spicedb-userdefined-roles`        | [authzed/examples: user-defined-roles](https://github.com/authzed/examples/blob/main/schemas/user-defined-roles/schema-and-data.yaml)  | `built_in_role_never_deletable` — a project's built-in role can never be deleted, even by that project's own role manager                                              | **VIOLATED** (non-monotone, self-validated — corrected from the earlier, superseded `HOLDS up to k = 1`; see "The recurring finding" section's own correction note above)                                                                                                                                                                                                                                                                                                 | `role:r#project@project:p`, `role:r#built_in_role@project:p`, `role:r#project@project:obj1`, `project:obj1#role_manager@role:obj2#member`, `role:obj2#member@user:m` — an unconstrained second tuple reaching a _different_ role manager's own delegated membership than the one the invariant pinned                                                                                                                                               |
| `spicedb-ai-agents`                | [authzed/examples: ai-agents](https://github.com/authzed/examples/blob/main/schemas/ai-agents/schema-and-data.yaml)                    | `ai_agent_never_edits_document` — an AI agent (a distinct subject type from `user`) can never edit a document                                                          | **HOLDS** (exact, monotone; empirically confirmed clean across 25 sampled tuple sets)                                                                                                                                                                                                                                                                                                                                                                                     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `spicedb-googledocs-typecheck-bug` | [SpiceDB schema language docs, "typechecking" example](https://github.com/authzed/docs/blob/main/app/spicedb/concepts/schema/page.mdx) | `edit_always_unreachable_for_any_user` — `document#edit = viewer & admin` is unreachable because `viewer: user` and `admin: serviceaccount` are disjoint subject types | **HOLDS** (`fragment: non-monotone`, `proof: exact` — `checkInvariant`'s AND-infeasibility short-circuit proves `viewer & admin` unreachable directly from the disjoint subject types, closing the gap previously disclosed here: this used to route through §7's bounded search and report only `HOLDS up to k = 1`, `proof: bounded`, even though the unreachability is provable by hand via type-disjointness alone; see `docs/DECISIONS.md` for the entry closing it) | —                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**8 VIOLATED, 4 HOLDS, 0 UNKNOWN, 0 tool errors.** (Originally 9 VIOLATED,
3 HOLDS at first publication — `spicedb-entitlements` and
`openfga-entitlements` moved to `HOLDS` per `docs/DECISIONS.md` D-131,
bringing it to 7 VIOLATED/5 HOLDS; `spicedb-userdefined-roles` then moved
back from `HOLDS` to `VIOLATED` once re-checked against D-151's SMT tier,
bringing it to the current 8 VIOLATED/4 HOLDS — see "The recurring
finding" above for both corrections.) Every `VIOLATED` entry is self-validated
per rule 2 above.

## Not analyzed

Two source schemas are deliberately excluded, not silently dropped, per
`tools/schema-verifier/thirdparty/README.md`'s own stated policy — both
are built entirely around a runtime-attribute (ABAC/caveat) concept this
DSL has no equivalent for:

- **OpenFGA's `superadmin`** sample store — built around `condition`
  blocks (CEL expressions) evaluated against request-time attributes.
- **SpiceDB's `caveats`** example — built around `caveat` blocks, the
  same concept under SpiceDB's own name.

Translating either into a schema with the caveat/condition silently
dropped would produce something that no longer represents the real
schema — worse than not analyzing it at all.

## Exit criteria (build spec §10)

- [x] At least ten third-party schemas analyzed — twelve.
- [x] Findings table published (above).
- [x] Every `VIOLATED` entry self-validated (§6, monotone fragment) or
      confirmed by direct real-engine calls (§7, non-monotone fragment).
- [x] Two rules (VIOLATED ≠ vulnerability; no unvalidated findings)
      applied and stated explicitly, including for the one entry
      (`spicedb-superuser`) that names a source's own intentional
      backdoor by design, not as something this survey discovered.
