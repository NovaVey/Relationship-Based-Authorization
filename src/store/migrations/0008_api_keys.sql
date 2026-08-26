-- Real, mintable, DB-backed API keys — a third credential tier alongside
-- this project's two static env-var keys, `ADMIN_API_KEY`/`READONLY_API_KEY`
-- (`src/api/auth.ts`). Additive only: those two functions, and every
-- existing route that already relies on them, are completely unchanged by
-- this migration — `checkAdminAuthDb`/`checkReadAuthDb` (`src/api/auth.ts`)
-- try the existing static-key comparison first and only fall back to a row
-- in this table when that fails, so a deployment that never mints one here
-- keeps behaving exactly as it always has.
create table api_keys (
  id          bigint generated always as identity primary key,
  name        text not null,

  -- The scrypt-derived hex digest of the raw key (`src/api/db-api-keys.ts`'s
  -- `hashApiKey`), never the raw key itself — a lookup key, not a secret
  -- this table needs to keep confidential on its own: even a full dump of
  -- this table (or `authz apikey list`, or a stray `select *`) never hands
  -- back a usable credential. `unique` doubles as this table's one real
  -- hot-path index — `validateDbApiKey`'s every-request lookup is `where
  -- key_hash = $1`, and Postgres always backs a `unique` constraint with
  -- an index automatically, so no second, redundant `create index` is
  -- needed for it. `listApiKeys`/`revokeApiKey` are both low-volume,
  -- operator-driven operations (a full scan or a primary-key lookup,
  -- respectively) that need no index of their own at any size this table
  -- will realistically reach — this project mints keys by hand, not per
  -- request.
  key_hash    text not null unique,

  -- What this key authorizes — mirrors `checkAdminAuth`/`checkReadAuth`'s
  -- own two-tier split exactly, never a third role: a broader
  -- attribute/permission system on top of a credential is out of scope
  -- here the same way it's out of scope for the whole project (this isn't
  -- an ABAC/policy-language engine — relationships between subjects and
  -- objects are the only thing this system reasons about; a credential's
  -- own role is a coarse, fixed, two-value gate ahead of that, not a new
  -- axis of relationship data).
  role        text not null check (role in ('admin', 'readonly')),

  -- NULL = unscoped — this key's authority reaches every namespace, the
  -- exact same unrestricted reach a static `ADMIN_API_KEY`/`READONLY_API_KEY`
  -- match already has today (`src/api/auth.ts`'s `checkAdminAuthDb`/
  -- `checkReadAuthDb` report `scopes: null` for a static-key match for
  -- exactly this reason). A non-null array restricts this key to only the
  -- namespace names it lists, checked by `src/api/server.ts` against each
  -- gated route's own target namespace(s) once authentication succeeds.
  -- NULL-means-"no restriction" is the same convention
  -- `0001_relation_tuples_and_write_log.sql`'s own `subject_relation`
  -- column already established in this schema (NULL there means "a plain
  -- subject, no userset restriction") — reused here for a credential's own
  -- scope instead of a tuple's subject shape. An empty array is
  -- deliberately NOT treated as a synonym for NULL anywhere this column is
  -- read (`src/api/db-api-keys.ts`'s `createApiKey` rejects an empty array
  -- outright rather than silently widening it to "unscoped") — collapsing
  -- "restricted to nothing" into "restricted to nothing in particular"
  -- would be exactly the kind of silent semantic change this project's own
  -- conventions rule out elsewhere (see `src/api/server.ts`'s `.strict()`
  -- body-schema comment for the same discipline applied to a request body
  -- instead of a stored column).
  scopes      text[],

  created_at  timestamptz not null default now(),

  -- NULL = never expires — matches this table's own `scopes` column
  -- immediately above: a real, meaningful default state stored as an
  -- honest absence, never a manufactured non-NULL sentinel (a far-future
  -- timestamp, say) standing in for "forever." Checked by
  -- `validateDbApiKey` as `expires_at is null or expires_at > now()`.
  expires_at  timestamptz,

  -- NULL = not revoked; a real timestamp = revoked at that moment.
  -- Revocation is recorded, never a hard `DELETE` — the same "a fact's own
  -- history is itself real information" principle this project already
  -- applies to `checks` (migration `0006_checks_hash_chain.sql` never
  -- deletes a row either): WHEN a compromised key was actually revoked,
  -- relative to when it was minted or when an incident happened, is
  -- exactly the kind of question an operator needs this table to still be
  -- able to answer after the fact. `revokeApiKey` sets this to `now()`
  -- only `where revoked_at is null` — revoking an already-revoked key is a
  -- no-op that reports "no row updated," never a second, later timestamp
  -- silently overwriting the true original revocation time.
  revoked_at  timestamptz
);
