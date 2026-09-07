# Integrating this service into a caller's own request path

This document is written for one specific kind of caller: something that
calls `/check` (or `/check/batch`) synchronously, inline, as part of
deciding whether to let some other action proceed — an API gateway, a
policy-decision point in front of a resource, an agent tool-call broker
deciding whether a tool invocation may proceed. That caller's requirements
are different from an occasional audit script's: it needs a latency
budget it can plan around, a caching story, a stated behavior for a token
that hasn't landed yet, a stated behavior for when this service can't be
reached at all, a way to gate several decisions in one round trip, and a
concrete answer for "how do I turn my authenticated user into a subject
this service understands."

Every claim below is either a fact about the current, committed code, or a
number this project actually measured and can point to — never an assumed
SLA. Where this project hasn't measured something, that's stated too.

## Latency budget

`performCheck` — the check engine's own recursive graph walk plus its real
Postgres round trips, no cache, the uncached path every correctness claim
in this project is proven against — measured against real Postgres, 50
runs per depth (`npm run benchmark`, `scripts/benchmark-check-depth.ts`;
see the README's own "Latency" section for the full table and how to
reproduce it):

| Depth | p50    | p95    |
| ----- | ------ | ------ |
| 1     | 4.9ms  | 6.5ms  |
| 3     | 9.6ms  | 12.6ms |
| 5     | 12.6ms | 15.3ms |
| 10    | 17.4ms | 21.5ms |

That's in-process — no HTTP transit. `docs/BENCHMARK-PROPOSAL.md`'s own
cross-engine rerun measured the same check through the real HTTP API (a
genuine caller shape: `POST /check` over a real socket, real Postgres,
`--runs-per-depth 10`, no cache):

| Depth | p50     | p95     | p99     | max     |
| ----- | ------- | ------- | ------- | ------- |
| 1     | 7.77ms  | 9.30ms  | 9.30ms  | 9.30ms  |
| 3     | 11.26ms | 14.49ms | 14.49ms | 14.49ms |
| 5     | 15.26ms | 24.81ms | 24.81ms | 24.81ms |
| 10    | 18.41ms | 33.03ms | 33.03ms | 33.03ms |

**What to actually budget for.** A caller inline on a real request path
should plan for low tens of milliseconds at typical permission-chain
depths (most real schemas resolve in well under 10 hops), growing with
depth — this is a real recursive graph walk, not a memoized lookup (§6.1:
no cached, precomputed permission anywhere), so cost genuinely scales with
how deep a grant chain runs, not a fixed per-call constant. The `p99`/`max`
columns above show real tail cost, not just p50 — a caller with a strict
end-to-end deadline should budget against the tail for its own actual
depth, not the median. `CHECK_MAX_DEPTH` (default `25`) is a hard ceiling
on how deep the walk can ever go, not a typical depth — it exists to
guarantee termination (§6.4), not to describe expected latency.

**What isn't measured.** There is no dedicated benchmark for `/check/batch`
latency specifically (see "Batching several checks into one call" below
for what its concurrency mechanics predict analytically); there is no
benchmark for check latency under concurrent load from many simultaneous
callers (every number above is one caller, checks issued one at a time).
Numbers are this repo's own, measured on one sandbox machine, and will
vary by hardware and network — reproduce them against your own deployment
before treating any number here as a commitment.

## The caching story

`CHECK_CACHE_TTL_MS` (default `0`, disabled) is an opt-in, in-process
check-result cache (`src/resolve/production/cache.ts`, `docs/DECISIONS.md`
D-028/D-135) — purely a latency optimization, never where a permission
decision actually comes from; every correctness claim this project makes
is proven with the cache off.

**What it buys.** Repeated identical checks (same subject/relation/object,
same `atToken`/`maxDepth` options) skip the graph walk entirely and return
the prior result. A **pinned** (`atToken`) result is safe to cache for the
rest of the process's life, regardless of later writes — the token is a
floor, not a snapshot pin, so reusing it never "ignores" a write the
original call hadn't already observed (see `cache.ts`'s own top-of-file
doc comment for the full, adversarially-reviewed argument). An
**unpinned** result is bounded by two mechanisms instead: every successful
write/delete/schema-publish reachable through the same server process
clears the whole cache immediately, and the TTL itself is a backstop for
staleness that clearing can't see — specifically, a write issued through a
_different_ process (the CLI, another replica behind a shared reverse
proxy, or a write straight against Postgres).

**What it doesn't buy, stated plainly.** A single in-process cache
structurally cannot observe a write from a different process — that
staleness is bounded only by the TTL for exactly that class of write, not
by immediate invalidation. A cached `allowed: true` result is never kept
past its own tuple's `expires_at` (D-144's fix: a result that touched a
still-live-but-expiring tuple is simply never written into the cache in
the first place — see `docs/CONSISTENCY.md`'s own account); a cached
`allowed: false` result is always safe to keep, since expiry can only ever
remove access, never grant it.

**Recommendation for a broker-style caller.** If most of your traffic is
the same small set of (subject, relation, object) triples checked
repeatedly and cheaply re-decidable (e.g., "can this agent invoke this
tool" for a small, stable set of agent/tool pairs), enabling the cache
with a short TTL (seconds, not minutes) is a reasonable latency win —
your own write cadence and cross-process topology determine how short "a
short TTL" should be, per the cross-process gap above. If you need every
decision to reflect a specific write immediately regardless of which
process made it, either keep the cache off, or pin every check to that
write's own `atToken` (a pinned result's safety doesn't depend on the TTL
at all). See `docs/CONSISTENCY.md`'s own "The cache" section for the full
account, including the real concurrent-request race an adversarial review
found and closed before this shipped.

## Consistency-token discipline

Covered in full in `docs/CONSISTENCY.md`'s own "Consistency-token
discipline for an online caller" section — the short version: a pinned
check whose token this database hasn't observed yet returns a
distinguishable `503 token_not_yet_observed`, not the generic `503
infrastructure_unavailable` a real Postgres outage produces. Retry the
same request again immediately (never with backoff) — a fresh call opens
a fresh snapshot, and this project's single-Postgres design expects the
condition to resolve in microseconds. Only after several immediate
retries against the same token keep failing should a caller treat it like
a genuine infrastructure problem; at that point the token itself is
almost certainly one this database will never observe (a different
deployment's token, or a value held too long), which is a caller-side bug
to fix, not a database outage to wait out.

## Batching several checks into one call

`POST /check/batch` (up to `CHECK_BATCH_MAX_SIZE` = 50 checks per request)
was built for exactly this shape — a broker gating several arguments (or
several tool calls) in one policy decision, folding N `/check` round trips
into one. It fits that caller well, with one real, disclosed limitation
worth knowing before relying on it:

- **Order-preserving, one outcome per input check**, in the same order
  supplied — never a set, never reordered by which check happened to
  finish first.
- **Every `atToken` is decoded independently, per item** — the same
  pinning discipline as a single `/check` call, item by item, not one
  token for the whole batch.
- **Structural validation is all-or-nothing, before any check runs.** A
  malformed item anywhere in the batch (bad shape, an undecodable
  `atToken`, an out-of-scope namespace for a scoped credential) rejects
  the entire request with `400`/`403` before a single `performCheck` call
  happens — no partial credit for the well-formed items sitting next to a
  malformed one.
- **A runtime failure anywhere in the batch fails the whole batch, not
  just that one item — the one real, disclosed sharp edge.** Once
  validation passes and checks start running (`Math.max(1,
MAX_CONCURRENCY)` at a time, default 8), there is no per-item try/catch:
  if any single item's `performCheck` throws — a genuine Postgres error,
  or a `token_not_yet_observed` condition on that one item's own
  `atToken` — the whole request fails with that error's status
  (`503 infrastructure_unavailable` or `503 token_not_yet_observed`), and
  every other item's result, including ones that had already succeeded in
  an earlier concurrency slice, is discarded. A caller that needs partial
  results even when one check's token isn't observed yet has two real
  options today: split a batch so a token likely to be freshly-minted
  (and therefore more likely to race an unobserved write) isn't mixed
  into a batch with checks that don't need to be that fresh, or catch the
  whole-batch failure and retry with the offending item's `atToken`
  loosened (dropped, or pinned to an earlier, already-observed token) once
  identified from the error. Making `/check/batch` return a per-item
  success/error outcome instead is real, tractable follow-up work, not
  attempted here.
- **Rate budget is tuned for this shape deliberately, not reused from
  `/check` outright.** `/check` allows 200 requests/minute (200
  check-equivalents/minute); `/check/batch` allows 20 requests/minute but
  each can carry up to 50 checks, for a 1,000 check-equivalents/minute
  ceiling — five times `/check`'s own aggregate throughput, deliberately
  bounded tighter than a naive "just reuse 200/minute" would have allowed
  (which would have admitted up to 10,000 check-equivalents/minute in the
  worst case). See `POST /check/batch`'s own route comment in
  `src/api/server.ts` for the exact reasoning.
- **Every check in a batch is logged to the audit table exactly as if it
  had been its own `/check` call** — unlike `listObjects`/`listUsers`'s
  own deliberate audit-table gap, `/check/batch` is N named "is this
  allowed" questions, the same shape a single `/check` answers, not a bulk
  discovery operation.

## Fail-open or fail-closed when this service is unreachable

Everything above assumes the caller can reach this service at all. If the
broker starts depending on this service at runtime, "what happens when I
can't reach it" is a security decision, and this project states its own
default rather than leaving it as an integrator's accident:

**The stated default is fail-closed: treat an unreachable check the same
as a denied one.** If this service cannot be reached at all (connection
refused, timeout, DNS failure — distinct from a `503` this service itself
returned, which is a real response naming a real condition, see above), a
caller enforcing an authorization decision should deny the action being
gated, not allow it. This is the same posture this service takes toward
its own dependency: `productionCheck` never guesses an answer when
Postgres itself is unreachable — it fails the request outright
(`503 infrastructure_unavailable`) rather than returning a default
`allowed`/`denied` value. An authorization system that fails open turns
every outage of that system into a total bypass of whatever it was
supposed to be protecting; failing closed turns an outage into an
availability problem for the thing being gated, which is the safer
direction to fail in by a wide margin, and the reason this is stated as
the default rather than left to whichever way an integrator's error
handling happened to fall.

**The honest tradeoff, stated rather than hidden.** Fail-closed means an
RBA outage becomes an outage for every action this service gates, not
just for authorization decisions — a caller that cannot tolerate that
availability coupling for a specific, genuinely low-risk action (one where
an incorrect allow is cheap and reversible, and an incorrect, unnecessary
deny during an outage is the more expensive failure for that specific
case) may deliberately choose to fail open for that one path — but that is
a deliberate, scoped, documented exception a caller makes for a specific
decision, never the default posture, and never a decision this project
makes on a caller's behalf. Nothing in this service enforces which way a
caller fails on its own network errors — that enforcement point is
necessarily on the caller's side, since this service has no way to act
once a caller can't reach it at all; this document exists so that choice
is made deliberately rather than by accident.

## The identity seam: mapping a real authenticated user to a subject

This project is not an authentication system — subjects are opaque
`{ ns, id }` pairs, and who authenticates them is out of scope entirely
(see the README's own "What this is not" section). That leaves one
concrete question every real integration has to answer that nothing in
this codebase decides for you: **how does a caller turn "the user this
request is authenticated as" into the `{ ns, id }` this service checks
against?**

**What this service requires of a subject id, and what it doesn't.** A
subject id just needs to match this DSL's identifier grammar
(`^[a-z][a-z0-9_]*$` — lowercase, digits, underscores, starting with a
letter) and be stable and consistent across every write and every check
that concerns the same real principal. This service has no concept of a
"current session," no token verification, and no notion of an anonymous
or unauthenticated caller beyond whatever the integrating deployment
chooses to represent as a subject (or chooses not to check at all).

**What a caller has to get right, since nothing here checks it for you:**

- **Use a stable, internal identifier, never anything a real person can
  change.** An email address, a display name, or a username a user can
  edit are all real-world-mutable — mapping today's email to a subject id
  and reusing that mapping after the person changes their email either
  silently splits one real principal into two unrelated subject ids, or
  (worse) hands a new person the previous owner's entire grant history if
  the identifier is ever reissued. An internal, immutable user id (a
  database primary key, a UUID your own identity provider mints and never
  reassigns) is the right shape.
- **Keep the mapping consistent between the write side and the check
  side.** A grant written for `user:internal_id_42` and a check issued
  for `user:alice_from_the_jwt` because two different parts of an
  integration derived the subject id two different ways is a silent
  authorization bug this service has no way to detect — from this
  service's perspective, those are simply two different, unrelated
  subjects, and it has no way to know a caller meant them to be the same
  principal.
- **Namespace convention.** This repository's own examples and tests
  consistently use `user` as the namespace for a real human principal
  (`{ ns: 'user', id: '...' }`) — a convention, not an enforced
  requirement; a deployment integrating an existing identity system with
  multiple distinct principal kinds (a human user, a service account, an
  API key acting on someone's behalf) is free to declare additional
  subject namespaces for each, exactly the way `spicedb-superuser`'s own
  third-party fixture models a platform-wide `serviceaccount` type
  distinctly from `user` (see `docs/FINDINGS.md`).
- **A caller that authenticates via delegated credentials (an OAuth token,
  a session cookie, an API key minted for a specific user) must resolve
  that credential to the same stable subject id every time it's
  presented** — this service has no visibility into the credential at
  all, only whatever subject id the integration decides to pass it.

**What this project deliberately does not do, and won't:** verify a JWT,
validate a session, check a password, or accept any form of credential as
input to a check. `unauthorizedError`/the `ADMIN_API_KEY`/the namespace-
scoped DB-backed API keys (`src/api/db-api-keys.ts`) authenticate the
_caller of this API_ (which system is allowed to ask "is this subject
allowed to do this"), never the _subject_ a check is being asked about —
those are deliberately two separate concerns, and only the first is this
service's job.
