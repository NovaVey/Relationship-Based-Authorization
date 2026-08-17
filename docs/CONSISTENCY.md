# Consistency

Plain-language companion to `.claude/commands/build-authz-service.md`
§6.3 (the token model) and §6.6 (the cache). Read this if the question is
"when I write a tuple, when exactly does a check see it?" — the honest,
stated answer, not an assumed "eventually."

## The problem this exists to name, not hide

Every real authorization system that separates "write a grant" from "check
a grant" has to answer a specific, adversarial question: can a write and a
check race, such that a permission was just revoked but a check still says
yes? Google's own Zanzibar paper calls this the "new enemy" problem — you
remove someone from a group, then share something you believe is now safe,
and a stale read lets the person you just removed see it anyway, because
the check that mattered ran against data from before the removal.

This project runs on one Postgres, not Zanzibar's globally-distributed
Spanner deployment (see the README's own honest-positioning section) — so
the _mechanism_ here is far simpler than Zanzibar's own "zookie" scheme.
But the property it has to uphold is the same one, and it's the property
this document states plainly rather than leaving implicit.

## Every write returns a token; a check can pin to it

```sql
create table write_log (
  id            bigint generated always as identity primary key,
  token         bigint generated always as (id) stored,  -- the token
  operation     text not null check (operation in ('write', 'delete')),
  tuple         jsonb not null,
  written_at    timestamptz not null default now()
);
```

`token` is a generated column, always equal to that row's own `id` —
deliberately a _separate_ column from `id`, not `id` reused directly under
a second name. One source of truth (`id` is what Postgres actually
increments), exposed under the name callers actually reason about ("pin to
token N") — see `docs/DECISIONS.md` for why this project chose that over
either a second, independently-tracked counter (which could drift from
`id`) or having every caller pin to `id` itself (which would leak an
internal primary-key detail into this project's own public consistency
vocabulary). Either way, it's monotonically increasing — every single
`tuple write` or `tuple delete`, across every namespace, advances it by
one. The CLI prints it (`authz tuple write ... ` → `token 1160`); the API
returns it (`{"token": 1160, "created": true}`). It is nothing more
sophisticated than "how many writes has this database seen, in order" —
and that's exactly what makes it usable: a caller who just wrote something
gets back a number that names the exact point in the write history their
write landed at.

**A check that supplies that token as `--at-token` (CLI) or `atToken`
(API) is guaranteed to observe that write, and everything before it.**
Concretely: the check's own read transaction first confirms `write_log`
has actually advanced to at least that token, before it reads a single
`relation_tuples` row. If it hasn't yet — a genuinely impossible situation
on a single Postgres instance with synchronous commits, but the check
exists as a real, testable assertion rather than an assumption — the check
fails loudly (an infrastructure error) rather than silently reading stale
data and returning a wrong answer.

"Everything before it" holds for _any_ observed token, not only one the
same caller minted themselves — including a token that names a write some
other, concurrent transaction produced. That's a stronger claim than it
looks: `write_log.token` is a Postgres identity column, whose sequence
value is allocated at INSERT time, non-transactionally — allocation order
alone gives no guarantee about commit order. `writeTuple`/`deleteTuple`
(`src/store/tuples.ts`) close that gap explicitly with a global,
transaction-scoped `pg_advisory_xact_lock`, serializing every tuple
write/delete in the system so that token-allocation order and commit order
always agree — see `acquireWriteLogLock`'s own doc comment and
`docs/DECISIONS.md` D-083 for the race this closes and how it was verified
live.

**A check with no token is a plain read of whatever is currently
committed.** Not "the latest write, always" in some real-time-guaranteed
sense — an ordinary, unpinned read, bounded by nothing more than Postgres's
own transaction visibility rules. Most checks in a real application will be
unpinned, and that's fine: the token exists for the specific moment a
caller needs to say "I just changed something, and my very next check must
see it" — read-your-writes, expressed as data instead of hoped for.

## The one property this must never violate

> A check pinned to token T never returns a result that ignores a write
> with token ≤ T.

That's the whole guarantee, stated as a single sentence on purpose — see
`test/isolation/permission-resolution.integration.test.ts` for where it's
held to that exact property as an executable test, not just prose: _"a
check pinned to the consistency token returned by a just-completed write
observes that write"_ and its sibling _"a check NOT pinned to a token,
issued concurrently with a revoking write, never observes a permission
strictly newer than its own start"_ — pinning is a floor on freshness,
never a reason to make an ordinary unpinned caller wait. The same property
is exercised again, directly against the production resolver, in
`test/unit/resolve/production/production-check-behavior.integration.test.ts`
(`a-check-pinned-to-the-token-a-write-just-returned-observes-that-write`
and its delete-side counterpart), plus the fail-closed case a token scheme
also has to get right — a token higher than any write this database has
actually seen yet is rejected, not silently resolved as if it were valid.

## What this project deliberately does not claim

This is a **read-your-writes** guarantee on a single Postgres instance,
not Spanner-style external consistency across a distributed deployment.
There's no replica lag to hide here — everything lives in one database —
so the token mechanism isn't solving a hard distributed-systems problem,
it's giving a caller a way to _express_ "I need to observe up through this
specific write" instead of just getting whatever the latest commit happens
to be. If this project ever became a multi-region deployment, the token
scheme as written would need real rethinking (see the README's own
non-goals) — stating the simpler guarantee honestly now is what makes it
possible to know exactly what would have to change later, rather than
discovering the gap in production.

## The cache: latency only, never the source of truth

`CHECK_CACHE_TTL_MS` (default `0`, disabled) exists purely to bound
check latency under load — it is never where a permission decision
actually comes from. Every claim this project makes about correctness
(§6.2's differential fuzzing, above all) is proven with the cache off; a
cached check result is an optimization layered on top of an answer that's
already provably correct without it, never a shortcut that could itself
be wrong.

The one non-negotiable rule if the cache is ever enabled: it must be
invalidated by the specific writes it depends on, immediately, never left
to expire on a timer alone. A permission revoked but still served from a
stale cache entry for however many milliseconds `CHECK_CACHE_TTL_MS` allows
is exactly the class of bug `test/isolation/` exists to catch — see its
own `README.md` for that lineage. Until write-triggered invalidation is
implemented and proven correct under the same fuzzing discipline as
everything else here, the cache stays off by default, and turning it on
without that proof is not a supported configuration.
