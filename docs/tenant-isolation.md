# Tenant isolation

`@novavey/multi-tenant-security-kit/tenant`

This is the foundation module every other module builds on. It has three
jobs: figure out which tenant a request belongs to, make that tenant
available anywhere in the call stack without threading it through every
function signature, and give you sharp tools for refusing to touch another
tenant's data.

## The core idea: one context, propagated automatically

`runWithTenant` / `getCurrentTenant` are built on Node's
[`AsyncLocalStorage`](https://nodejs.org/api/async_context.html#class-asynclocalstorage).
Once you're inside `runWithTenant(context, fn)`, the active tenant is visible
to _anything_ `fn` calls or schedules — `await`s, `.then()` chains, timers,
nested function calls — without passing it as a parameter:

```ts
import {
  runWithTenant,
  getCurrentTenantId,
  requireCurrentTenantId,
} from '@novavey/multi-tenant-security-kit/tenant';

await runWithTenant({ tenantId: 'acme' }, async () => {
  getCurrentTenantId(); // 'acme'
  await someAsyncWork();
  getCurrentTenantId(); // still 'acme' — propagated across the await
});

getCurrentTenantId(); // undefined — the context ends when runWithTenant returns
```

Two flavors of every getter:

- `getCurrentTenant()` / `getCurrentTenantId()` — return `undefined` outside
  a tenant context.
- `requireCurrentTenant()` / `requireCurrentTenantId()` — throw
  `TenantContextError` outside a tenant context. Prefer these at the top of
  any function that must never run "tenant-less" — a thrown error is much
  easier to notice and debug than a query that silently returns nothing.

Concurrent requests get independent contexts automatically — two requests
for different tenants running at the same time never see each other's
`getCurrentTenantId()`.

## Resolving the tenant from a request

`createTenantMiddleware` wraps the rest of the request pipeline in
`runWithTenant`, using a `TenantResolver` you supply to figure out the
tenant. Three ready-made resolvers cover the common cases:

```ts
import {
  createTenantMiddleware,
  headerTenantResolver,
  subdomainTenantResolver,
  claimTenantResolver,
} from '@novavey/multi-tenant-security-kit/tenant';

// From a header (default name: x-tenant-id)
app.use(createTenantMiddleware({ resolver: headerTenantResolver() }));

// From the subdomain: acme.yourapp.com -> tenant "acme"
app.use(createTenantMiddleware({ resolver: subdomainTenantResolver() }));

// From an already-verified token/session — you decode it, this just extracts the claim
app.use(
  createTenantMiddleware({
    resolver: claimTenantResolver((req) => req.auth, 'tenant_id'),
  }),
);
```

`claimTenantResolver` deliberately does not verify tokens itself — pass it a
`decode` function that returns your already-verified claims (from
`jsonwebtoken`, `jose`, a session store, whatever you use). This module has
no opinion about authentication; it only reads the tenant claim out of it.

Mount `createTenantMiddleware` as early as possible, before any route or
middleware that touches tenant-scoped data — `rbac`'s
`subjectFromRequestRoles` and `rate-limit`'s `createRateLimitMiddleware`
both default to reading the tenant from this context.

### Validation and the "no tenant" path

By default, resolved tenant ids are validated against
`/^[a-zA-Z0-9_-]{1,64}$/` — deliberately strict, since this value often flows
into SQL identifiers, cache keys, and file paths downstream (see the [RLS
module](./row-level-security.md) for where that matters most). Override with
`validateTenantId`. When no tenant resolves, or one resolves but fails
validation, `onMissing` runs — its `info.reason` (`'missing'` or
`'invalid'`) tells you which, and `info.tenantId` carries the rejected value
for the `'invalid'` case. The default behavior for both is
`400 { error: "tenant_required" | "invalid_tenant" }`; override `onMissing`
to implement e.g. a public/marketing-site fallback that calls `next()`
without a tenant, or to log the rejected value yourself.

### Background jobs and non-HTTP entry points

`runWithTenant` isn't HTTP-specific — call it directly for queue consumers,
cron jobs, or anything else that needs tenant scoping outside of a request:

```ts
await runWithTenant({ tenantId: job.tenantId }, () => processJob(job));
```

If `job.tenantId` comes from an untrusted source (a queue message, an RPC
argument) and you want the same validation `createTenantMiddleware` applies
to a resolved tenant id — but as an exception instead of a response, since
there's no `res` to reject with here — use `assertValidTenantId`:

```ts
import { assertValidTenantId } from '@novavey/multi-tenant-security-kit/tenant';

assertValidTenantId(job.tenantId); // throws InvalidTenantIdError if malformed
await runWithTenant({ tenantId: job.tenantId }, () => processJob(job));
```

This mirrors `assertNotRateLimited`'s role for
[rate limiting](./rate-limiting.md#outside-http-background-jobs-rpc-graphql-resolvers):
`createTenantMiddleware` itself deliberately never throws for an invalid
resolved tenant id (it calls `onMissing` instead, so an HTTP middleware can
respond directly rather than forcing every caller to install
error-handling middleware) — `assertValidTenantId` is the throw-based
option for call sites with no response to send.

## Guarding against cross-tenant access

Resolving the tenant is only half the job — you also need to stop code from
touching a _different_ tenant's data. Three helpers, in increasing order of
how much they do for you:

```ts
import {
  assertSameTenant,
  assertTenantMatches,
  scopeToTenant,
} from '@novavey/multi-tenant-security-kit/tenant';
```

**`assertTenantMatches(resource)`** — call this right after any lookup by
primary key. Primary-key lookups are the classic multi-tenant leak: nothing
about `db.invoices.findById(id)` stops tenant A from requesting tenant B's
row id if B's id is guessable or enumerable.

```ts
// `String(...)`: Express 5 types route params as `string | string[]` (to
// support repeated-segment patterns), so coerce before a lookup expecting
// a single id.
const invoice = await db.invoices.findById(String(req.params.id));
assertTenantMatches(invoice); // throws CrossTenantAccessError if invoice.tenantId !== the active tenant
```

**`scopeToTenant(query)`** — merges the active tenant into a query/filter
object, so every read is scoped by construction instead of by convention. If
the query already has a `tenantId` set to a _different_ tenant, it throws
rather than silently overwriting it — that shape usually means a bug
upstream, not something to paper over.

```ts
const rows = await db.invoices.find(scopeToTenant({ status: 'open' }));
// -> { status: 'open', tenantId: '<the active tenant>' }
```

**`assertSameTenant(expected, actual)`** — the low-level primitive the other
two are built on. Reach for this directly when you already have both tenant
ids in hand and don't need the active-context lookup.

All three throw `CrossTenantAccessError` (carrying `expectedTenantId` /
`actualTenantId`) on a mismatch, and `assertTenantMatches` / `scopeToTenant`
throw `TenantContextError` if called outside any tenant context at all.

## API reference

| Export                                     | Kind     | Summary                                                                                         |
| ------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------- |
| `TenantContext<Extra>`                     | type     | `{ tenantId: string; extra?: Extra }`                                                           |
| `TenantScoped`                             | type     | `{ tenantId: string; [key: string]: unknown }`                                                  |
| `runWithTenant(context, fn)`               | function | Runs `fn` with `context` as the active tenant                                                   |
| `getCurrentTenant()`                       | function | Active `TenantContext`, or `undefined`                                                          |
| `requireCurrentTenant()`                   | function | Active `TenantContext`; throws `TenantContextError`                                             |
| `getCurrentTenantId()`                     | function | Active tenant id, or `undefined`                                                                |
| `requireCurrentTenantId()`                 | function | Active tenant id; throws `TenantContextError`                                                   |
| `assertSameTenant(expected, actual)`       | function | Throws `CrossTenantAccessError` if the two ids differ                                           |
| `assertTenantMatches(resource)`            | function | Throws unless `resource.tenantId` matches the active tenant                                     |
| `scopeToTenant(query)`                     | function | Injects/validates the active tenant id into a query object                                      |
| `createTenantMiddleware(options)`          | function | Builds the request-scoping middleware                                                           |
| `TenantMiddlewareOptions<Req>`             | type     | Options for `createTenantMiddleware`: `{ resolver, validateTenantId?, onMissing? }`             |
| `TenantResolver<Req>`                      | type     | `(req) => TenantContext \| undefined \| Promise<...>` — what every `*TenantResolver` returns    |
| `headerTenantResolver(headerName?)`        | function | Resolver: reads a request header (default `x-tenant-id`)                                        |
| `subdomainTenantResolver(options?)`        | function | Resolver: reads the leftmost hostname label                                                     |
| `SubdomainTenantResolverOptions`           | type     | `{ baseDomainLabels? }` — options for `subdomainTenantResolver`, default `2`                    |
| `claimTenantResolver(decode, claim?)`      | function | Resolver: reads a claim off an already-decoded token/session                                    |
| `TenantMissingInfo`                        | type     | `{ reason: 'missing' } \| { reason: 'invalid'; tenantId }` — passed to `onMissing`              |
| `assertValidTenantId(tenantId, validate?)` | function | Throws `InvalidTenantIdError` if `tenantId` fails validation; for non-HTTP call sites           |
| `SecurityKitError`                         | class    | Base class every error in this package extends; carries a stable `.code`                        |
| `TenantContextError`                       | class    | Thrown by `requireCurrentTenant()`/`requireCurrentTenantId()`; `code: 'TENANT_CONTEXT_MISSING'` |
| `CrossTenantAccessError`                   | class    | Thrown by `assertSameTenant()`/`assertTenantMatches()`; `code: 'CROSS_TENANT_ACCESS_DENIED'`    |
| `InvalidTenantIdError`                     | class    | Thrown by `assertValidTenantId()`; `code: 'INVALID_TENANT_ID'`                                  |
