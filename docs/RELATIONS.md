# Relations and permissions

Plain-language companion to `.claude/commands/build-authz-service.md` §5
(the schema DSL grammar) and §6.1/§6.4/§6.7 (the mechanics that make it
work). If you want the formal grammar, read §5; if you want to see it
compile, `authz schema compile schema/example.authz`. This document is for
the question those two don't answer on their own: _why does the DSL look
like this, and what does each piece actually buy you?_

Every example below is real — pulled from `schema/example.authz`, the
schema this repository actually publishes and checks against (see
`scripts/seed-example.ts` and the [README](../README.md)'s own worked
walkthrough), not a hypothetical.

## Two kinds of facts: stored, and computed

A namespace declares two different things, and the DSL keeps them
syntactically distinct on purpose:

```
namespace document {
  relation owner: user
  relation editor: user | group#member
  relation viewer: user | group#member

  permission edit = editor | owner | parent->edit
  permission view = viewer | edit | parent->view
}
```

**A `relation` is a fact you can write.** `authz tuple write
document:readme editor user:alice` creates a real row in `relation_tuples` —
"alice is an editor of readme" now exists as data, until someone deletes
it. Nothing else in the schema decides whether that write is _true_; it's
true because the row exists.

**A `permission` is never stored — it's computed, every time, from
whatever `relation` rows currently exist.** `document.edit` isn't a fact
anywhere in the database; it's a rule ("editor, or owner, or inherited from
the parent folder's own edit") that gets evaluated fresh against real
tuples on every check. There is no cached "alice can edit readme" row that
could go stale the moment a tuple changes — see `docs/CONSISTENCY.md` for
exactly what "fresh" guarantees.

This split is enforced, not a convention: the compiler rejects a tuple
write targeting a `permission` name (`schema/malformed-example.authz` is a
worked example of a related rejection), and a relation's own allowed
subject types can never name another namespace's `permission` — only its
`relation`s. A permission has nothing for a tuple to point _at_.

## The four rewrite-rule kinds, each with a real example

A `permission`'s right-hand side is a **rewrite rule** — an expression over
relations, other permissions, and tuple-to-userset hops. Every kind that
exists appears somewhere in `schema/example.authz`:

### Union (`|`) — "any of these"

```
permission view = viewer | edit | parent->view
```

A document is viewable if you're a direct `viewer`, OR you can `edit` it
(editing implies viewing), OR you inherit view from its parent folder. The
most common rule by far — every `view`/`edit` permission in this schema's
four namespaces starts with one.

### Exclusion (`-`) — "this, but not that"

```
namespace org {
  relation member: user | group#member
  relation banned: user

  permission view = member - banned
}
```

`user:mallory` is a real `member` of `org:acme` in the seeded demo — and
also `banned`. `member - banned` is what actually decides she can't view
org content; `member` alone would get the wrong answer. This is the
rewrite rule a flat boolean column can't express cleanly: "member" was
never false for mallory, the exception is a second, independent fact, and
the permission has to subtract it, not overwrite it.

### Intersection (`&`) — "all of these, together"

```
namespace folder {
  relation viewer: user | group#member
  relation sensitive_reviewer: user | group#member
  ...
  permission sensitive_review = (viewer | edit) & sensitive_reviewer
}
```

In the seeded demo, `carol` and `erin` are both real members of
`group:finance`, and both get ordinary `viewer` access to
`folder:finance_docs` through it. Only `carol` also holds
`sensitive_reviewer` directly. `sensitive_review` needs both — ordinary
access is necessary but not sufficient, exactly the shape of a real
"defense in depth" gate (see `authz expand folder:finance_docs
sensitive_review` for the real tree: one branch resolves for both carol
and erin, the other resolves for carol alone, and only their intersection
answers the permission).

### Tuple-to-userset (`->`) — "follow a relation, then recurse"

```
namespace folder {
  relation parent: folder
  permission edit = editor | owner | parent->edit
}
```

`parent->edit` means: follow the `parent` relation from this folder to
whatever folder it points at (a real tuple, `folder:eng_backend_docs#parent
@ folder:eng_docs` in the seeded demo), then ask the identical question —
`edit` — over there. This is how a folder hierarchy grants access without
every document needing its own copy of every ancestor's grants: write the
`parent` tuple once, and every check that walks through it re-evaluates
the real rule on the real parent, live, every time.

The one non-negotiable rule about this hop: `parent` must be a `relation`
(something with real tuples to walk), never a `permission` — the compiler
rejects `parent->view` if `parent` turns out to name a permission, because
there's nothing to follow.

## Nested groups: a userset as a subject, not a rewrite rule

One more mechanic makes the demo's own deliberately non-obvious case work,
and it isn't a rewrite rule at all — it's in how a **relation's subject
type** is declared:

```
namespace group {
  relation member: user | group#member
}
```

`user | group#member` says a `group:X#member` tuple can point at a plain
`user`, **or** at another group's entire member set. That second option is
what makes a tuple like `group:eng#member @ group:eng_backend#member`
mean something: "everyone who is a member of `eng_backend` is also a
member of `eng`" — nested groups, with no special-cased recursion
anywhere in the compiler or either resolver. The same generic machinery
that walks `folder:eng_docs#editor @ group:eng#member` (a plain userset
subject) walks a userset-of-a-userset identically.

The seeded demo nests this two levels deep specifically to prove it isn't
a one-hop trick: `user:dana` is a member of `group:eng_backend_interns`
only. Her real access to anything `group:eng` can reach — `edit` on
`document:eng_handbook`, for instance — depends on three real tuples
chaining together, not two:

```
group:eng#member                @ group:eng_backend#member
group:eng_backend#member        @ group:eng_backend_interns#member
group:eng_backend_interns#member @ user:dana
```

`authz expand document:eng_handbook edit` renders the real tree this
produces — every level of the nesting visible, not flattened away. See the
README's own resolution-path walkthrough for the real 5-hop chain a
`check` against this exact case returns.

## Two correctness requirements that live in this same walk

**A depth ceiling, always, independent of anything else.** `CHECK_MAX_DEPTH`
(default 25) bounds how deep any single check walk goes, full stop — not
as a performance tweak, as a termination guarantee for a rule set nobody
promised was acyclic.

**Cycle detection, on top of that, not instead of it.** Group nesting can
cycle in real data (`group:a` nesting into `group:b` nesting back into
`group:a`) — the walk tracks which `(namespace, id, relation)` triples are
already being resolved on the current branch and stops instead of looping
forever. Both facts matter separately: a very deep but genuinely acyclic
chain still needs the depth ceiling to terminate in bounded time, and a
short cycle needs the cycle guard specifically, not just a generous depth
limit, to terminate _correctly_ (denied, not merely "eventually stopped").
Both the reference resolver and the production engine are held to this
identically — see `.claude/commands/build-authz-service.md` §6.4 and
`docs/DECISIONS.md` for how each was actually fail-checked (the guard
disabled on purpose, confirmed to hang for real, restored).

## Every `allow` can show its work

`checks.resolution_path` — and the `path` field on a `POST /check`
response — isn't a debugging convenience bolted on afterward. It's the
literal tuple/rewrite chain the engine walked to reach `true`, stored
alongside every check this system ever answers. A `check` that says
"allowed" with nothing behind it is exactly the kind of implicit grant
this project's own build rules refuse to produce (rule 10) — every `allow`
names the real path, or it isn't an `allow`. See the README's own opening
example for what that looks like end to end, and
`docs/CONSISTENCY.md` for how a check's answer relates to a specific point
in time.
