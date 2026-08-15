# Multi-Tenant Security Kit

[![CI](https://github.com/NovaVey/Multi-Tenant-Security-Kit/actions/workflows/ci.yml/badge.svg)](https://github.com/NovaVey/Multi-Tenant-Security-Kit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40novavey%2Fmulti-tenant-security-kit.svg)](https://www.npmjs.com/package/@novavey/multi-tenant-security-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/NovaVey/Multi-Tenant-Security-Kit/badge)](https://scorecard.dev/viewer/?uri=github.com/NovaVey/Multi-Tenant-Security-Kit)

A framework-agnostic TypeScript toolkit for building secure multi-tenant
applications. It gives you the six pieces every multi-tenant backend ends up
reinventing — tenant isolation, RBAC, per-tenant rate limiting, audit
logging, Postgres row-level security, and per-tenant encryption — as small,
independently-usable, well-tested modules that compose around one shared
idea: **the active tenant lives in one place, and everything else reads from
it.**

```sh
npm install @novavey/multi-tenant-security-kit
```

Node.js >=22. Ships as dual ESM/CJS with full TypeScript types. Works with
Express and any Express-alike framework — the package has no hard dependency
on `express` itself (see [Framework compatibility](#framework-compatibility)).

## Why this exists

Multi-tenant SaaS applications fail in the same few ways over and over:

- A primary-key lookup returns another tenant's row because nothing checked
  the tenant column.
- A permission check is copy-pasted slightly wrong on one route.
- One noisy tenant exhausts a shared rate limit meant to protect everyone.
- Nobody can answer "who accessed this record" after an incident, because
  nothing was logging it.
- The database has no isolation of its own — every guarantee lives entirely
  in application code that someone has to remember to write correctly, every
  time, on every query.
- Tenant data at rest is encrypted with one global key, so a single key leak
  exposes every tenant at once.

This kit doesn't make any of these mistakes impossible on its own — no
library can — but it makes the _correct_ thing the _easy_ thing, and it adds
a second, independent layer of enforcement (database-level RLS) so an
application-level bug doesn't have to be the only thing standing between a
request and another tenant's data.

## The modules

| Module                                  | What it does                                                                                 | Import                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [`tenant`](./docs/tenant-isolation.md)  | Resolves and carries the active tenant through a request; guards against cross-tenant access | `@novavey/multi-tenant-security-kit/tenant`     |
| [`rbac`](./docs/rbac.md)                | Role-based permission checks, with inheritance and wildcard grants                           | `@novavey/multi-tenant-security-kit/rbac`       |
| [`rate-limit`](./docs/rate-limiting.md) | Per-tenant token-bucket rate limiting, pluggable storage backend                             | `@novavey/multi-tenant-security-kit/rate-limit` |
| [`audit`](./docs/audit-logging.md)      | Structured, multi-sink audit event logging that never throws                                 | `@novavey/multi-tenant-security-kit/audit`      |
| [`rls`](./docs/row-level-security.md)   | Generates Postgres row-level-security SQL for defense-in-depth at the DB layer               | `@novavey/multi-tenant-security-kit/rls`        |
| [`crypto`](./docs/encryption.md)        | Per-tenant AES-256-GCM encryption with independently-derived keys                            | `@novavey/multi-tenant-security-kit/crypto`     |

Every module is also re-exported from the package root
(`@novavey/multi-tenant-security-kit`), so
`import { requirePermission } from '@novavey/multi-tenant-security-kit'`
works too — use subpath imports when you want smaller bundles or clearer
call sites.

## Quickstart

```ts
import express from 'express';
import {
  createTenantMiddleware,
  headerTenantResolver,
  scopeToTenant,
} from '@novavey/multi-tenant-security-kit/tenant';
import {
  RbacPolicy,
  requirePermission,
  subjectFromRequestRoles,
} from '@novavey/multi-tenant-security-kit/rbac';
import {
  TenantRateLimiter,
  createRateLimitMiddleware,
} from '@novavey/multi-tenant-security-kit/rate-limit';

const app = express();

// 1. Resolve the tenant for every request, first.
app.use(createTenantMiddleware({ resolver: headerTenantResolver('x-tenant-id') }));

// 2. Rate-limit per tenant.
const limiter = new TenantRateLimiter({ limit: 100, windowMs: 60_000 });
app.use(createRateLimitMiddleware({ limiter }));

// 3. Enforce permissions per route.
const policy = new RbacPolicy([
  { name: 'viewer', permissions: ['invoices:read'] },
  { name: 'admin', permissions: ['invoices:*'], inherits: ['viewer'] },
]);

app.get(
  '/invoices',
  requirePermission({ policy, permission: 'invoices:read', getSubject: subjectFromRequestRoles() }),
  async (_req, res) => {
    // 4. Every query is scoped to the active tenant by construction.
    const rows = await db.invoices.find(scopeToTenant({ status: 'open' }));
    res.json(rows);
  },
);
```

See [`examples/express-basic.ts`](./examples/express-basic.ts) for a fuller,
runnable example wiring all six modules together, including audit logging on
every denial. Other frameworks:
[`examples/fastify-basic.ts`](./examples/fastify-basic.ts),
[`examples/koa-basic.ts`](./examples/koa-basic.ts),
[`examples/nextjs-route-handler.ts`](./examples/nextjs-route-handler.ts), and
a full Redis-backed `RateLimitStore` for multi-instance deployments in
[`examples/redis-rate-limit-store.ts`](./examples/redis-rate-limit-store.ts).

## Design principles

- **One source of truth for "the current tenant."** `tenant/context.ts` uses
  Node's `AsyncLocalStorage` so the active tenant propagates automatically
  through `await`s, callbacks, and promise chains for the lifetime of a
  request — no manual thread-through, no risk of a forgotten parameter.
- **Defense in depth, not a single gate.** Application-level checks
  (`assertTenantMatches`, `scopeToTenant`, RBAC) and database-level checks
  (`rls`) are independent layers. A bug in one doesn't remove the other.
- **Fail loud, not silent.** Missing tenant context, cross-tenant access, and
  RBAC denials all throw typed errors (see [`src/errors.ts`](./src/errors.ts))
  rather than silently returning empty results — a silent empty array looks
  identical to "no data" and identical to "isolation bug," which is exactly
  the ambiguity this kit exists to remove.
- **Framework-agnostic core, Express-compatible middleware.** Every
  middleware factory is typed against a minimal structural `MinimalRequest`/
  `MinimalResponse` interface (see [`src/http/types.ts`](./src/http/types.ts)),
  not `express`'s own types, so this package has zero runtime dependencies
  and works with Express, Connect, or anything shaped like them.
- **Pluggable, not prescriptive, at the infrastructure boundary.** Rate
  limiting and audit logging both ship a working default (in-memory store,
  console sink) plus a small interface (`RateLimitStore`, `AuditSink`) so
  swapping in Redis or a real log pipeline is a one-class implementation, not
  a fork.

## What this kit does _not_ do

Being explicit about scope matters for a security library:

- It does not authenticate users or verify tokens/JWTs. Bring your own auth;
  this kit's `tenant`/`rbac` resolvers just read claims/roles you've already
  verified.
- It is not a WAF or a network-layer protection — `rate-limit` protects
  shared backend capacity between tenants, not your edge from a DDoS.
- It does not manage database connections, migrations, or run SQL — `rls`
  only generates SQL text; you execute it with whatever client/migration
  tool you already use.
- It does not implement key rotation or a KMS — `crypto` gives you a working
  single-secret key-derivation provider (`EnvKeyProvider`) and an interface
  (`KeyProvider`) to plug in a real KMS for that.

## Framework compatibility

Every middleware factory returns `(req, res, next) => void` typed against
minimal structural interfaces, not `express`'s types — Express's own
`Request`/`Response` satisfy them automatically, and so does anything with
the same shape (Connect, most Express-alike routers). There's no `express`
dependency, peer or otherwise.

## Module documentation

- [Tenant isolation](./docs/tenant-isolation.md) — context propagation, resolvers, guards
- [RBAC](./docs/rbac.md) — policies, inheritance, wildcards, middleware
- [Rate limiting](./docs/rate-limiting.md) — token bucket, custom stores, headers
- [Audit logging](./docs/audit-logging.md) — sinks, redaction, child loggers, OpenTelemetry integration
- [Row-level security](./docs/row-level-security.md) — Postgres RLS SQL generation, Prisma/Drizzle integration
- [Encryption](./docs/encryption.md) — per-tenant AES-256-GCM, key providers
- [Auth provider integrations](./docs/auth-integrations.md) — Auth.js, Clerk, Auth0

## Versioning

This project follows [Semantic Versioning](https://semver.org/). See
[docs/versioning-policy.md](./docs/versioning-policy.md) for exactly what
that means here — what counts as the public API, what triggers a
`PATCH`/`MINOR`/`MAJOR` bump, and how deprecation works.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, the codebase
layout, and the release process. See [SECURITY.md](./SECURITY.md) to report
a vulnerability — please don't open a public issue for those. This project
follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).

This repository's GitHub-side setup (branch protection, required checks,
secrets) is documented in [docs/github-governance.md](./docs/github-governance.md).

## License

[MIT](./LICENSE) © Tyler Pepitone / Nova Vey Engineering
