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
increments), internally nothing more sophisticated than "how many writes
has this database seen, in order" — see `docs/DECISIONS.md` D-014 for why
this project chose that over either a second, independently-tracked
counter (which could drift from `id`) or having every caller pin to `id`
itself (which would leak an internal primary-key detail into this
project's own public consistency vocabulary). It's monotonically
increasing — every single `tuple write` or `tuple delete`, across every
namespace, advances it by one.

**What a caller actually sees is an opaque, encoded string, never that raw
integer.** `src/store/tokens.ts`'s `encodeToken`/`decodeToken` wrap it in a
small versioned envelope before it ever leaves this codebase — the CLI
prints it (`authz tuple write ...` → `token eyJ2IjoxLCJ0IjoxMTYwfQ`); the
API returns it (`{"token": "eyJ2IjoxLCJ0IjoxMTYwfQ", "created": true}`).
This is presentation-layer opacity, not cryptographic protection — nothing
stops a caller from decoding the base64 and reading the integer back out,
and a forged or hand-edited token can't grant extra permissions either way
(the token only ever gates a freshness floor via `assertTokenObserved`,
never the authorization decision itself). What it does buy: the raw
sequential-integer representation was never a promise to callers, and
exposing it directly would have made it one by accident, the moment
anything started comparing, incrementing, or persisting it as a number —
exactly what a real Zanzibar-style zookie exists to prevent. A caller who
just wrote something gets back a token that names the exact point in the
write history their write landed at — they just never see, or need to
see, which integer that actually is.

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

## Time-based revocation: a deny with no corresponding write event

Every guarantee above is stated in terms of writes: a check pinned to
token T sees every write with token ≤ T; an unpinned check sees whatever's
currently committed. Expiring tuples (D-144, `relation_tuples.expires_at`)
introduce a genuinely different category, not an extension of the token
model — a tuple can stop granting access at a specific instant with **no
write ever landing**, `write_log` never advancing, and no token a caller
could pin to ever reflecting it. Stated plainly rather than left for
someone to assume the token guarantee already covers it: **the token
model says nothing about when an expiry takes effect.** What governs that
instead is the same wall clock every part of this system already shares —
"is `now() > expires_at`?", evaluated fresh by both resolvers at the
moment a check actually runs (`src/resolve/production/resolver.ts`,
`src/resolve/reference/resolver.ts`), never cached or precomputed, the
identical `there is no cached, precomputed permission anywhere` discipline
this project already holds itself to for every other kind of grant.

**Snapshot isolation still composes correctly with this — deliberately
proven, not assumed.** A `productionCheck` call's `REPEATABLE READ`
transaction fixes real Postgres's `now()` at the transaction's own start,
the exact same anchor point `assertTokenObservedOnSnapshot`'s own token
floor check already relies on — so every expiry comparison inside one
check agrees on one instant, even if real wall-clock time keeps advancing
while that check's own multi-statement walk is still in flight. An expiry
boundary crossing mid-transaction therefore behaves exactly the way a
concurrent write does under `REPEATABLE READ`: invisible to a snapshot
already anchored before it, visible to the next one opened after.

**The one place this needs special handling, not just "the same as
everything else": the opt-in check-result cache.** Every cache-invalidation
mechanism this project has (`cache.ts`'s `clear()`, called after every
write) is triggered by a write event — and an expiry, by definition, is
the one kind of access change that never produces one. A cached `allowed:
true` result that depended on a tuple which later expires would otherwise
be served past its real expiry for as long as the cache's own TTL allows,
with nothing to invalidate it. Closed narrowly rather than by disabling
caching for every check that merely touches an expiring relation: a check
result is simply never written into the cache when it was `allowed: true`
**and** its own resolution read a live, still-unexpired tuple carrying an
`expires_at` (`ProductionCheckResult.touchedExpiringTuple` —
`src/resolve/production/resolver.ts`, consumed by `performCheck`,
`src/audit/checks.ts`). A cached `allowed: false` result is always safe to
keep serving regardless of this flag: expiry only ever removes access over
time, so a denial can never become stale-wrong the way a grant can. A
pinned (`atToken`) result gets no special exemption from this rule either —
the token's own "valid forever" guarantee is about write-log observation,
a completely different axis from wall-clock expiry, and doesn't make an
expiring grant any safer to cache past its own `expires_at`.

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
own `README.md` for that lineage.

**This is now implemented** (`src/resolve/production/cache.ts`,
`docs/DECISIONS.md` D-135) — still off by default (`CHECK_CACHE_TTL_MS=0`),
still an opt-in optimization a deployment turns on deliberately. Every
successful write/delete/schema-publish reachable through the same server
process invalidates the whole cache immediately, and a monotonic epoch
fence closes a real race an adversarial review found before this shipped:
a check already in flight when a write lands and clears the cache could
otherwise write its now-stale answer back in _after_ that clear — the fence
guarantees it doesn't. One gap is disclosed, not closed: a single
in-process cache structurally cannot observe a write issued through a
_different_ process (the CLI, another replica behind the same reverse
proxy) — that staleness is bounded only by `CHECK_CACHE_TTL_MS` itself,
never by immediate invalidation, for exactly that class of write. A pinned
(`atToken`) result is unaffected by any of this: it's valid for as long as
it's cached, by construction — see `cache.ts`'s own top-of-file doc comment
for the full argument.
