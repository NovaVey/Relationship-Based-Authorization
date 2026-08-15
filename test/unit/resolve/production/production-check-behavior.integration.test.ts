/**
 * Production-only check-engine behavior — no reference-resolver equivalent,
 * since the Phase 3 reference resolver is pure/in-memory and has no
 * database, no consistency tokens, and no network to be unreachable.
 * Written from `.claude/commands/build-authz-service.md` §6.3 (consistency
 * tokens), §7's exit-code table (fail-closed-as-throw for infrastructure
 * failure vs. fail-closed-as-deny for an ordinary "no"), and the doc
 * comment directly on `productionCheck`'s exported signature in
 * `src/resolve/production/resolver.ts` (read as an interface only, per this
 * task's constraint — not the function body).
 *
 * Runs against the real local Postgres instance provided for this task,
 * same connection convention as `cross-resolver-agreement.integration
 * .test.ts` in this directory — see that file's own header for why this
 * departs from `test/unit/store/tuple-store.integration.test.ts`'s
 * `testcontainers` pattern.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { writeTuple, deleteTuple, type TupleKey } from '../../../../src/store/tuples.js';
import { currentToken } from '../../../../src/store/tokens.js';
import { publishSchema } from '../../../../src/schema/publish.js';
import { productionCheck } from '../../../../src/resolve/production/resolver.js';

const CONNECTION_STRING = 'postgres://authz:authz_dev_password@127.0.0.1:5432/authz_dev';

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: CONNECTION_STRING });
});

afterAll(async () => {
  await pool.end();
});

let uniqueCounter = 0;
// See cross-resolver-agreement.integration.test.ts's own comment on this
// same pattern — a random per-worker salt, not just `Date.now()`, is
// required to avoid real cross-file collisions on shared prefixes like
// 'doc' when vitest runs multiple *.integration.test.ts files in parallel
// worker threads that can start within the same wall-clock millisecond.
const processSalt = Math.random().toString(36).slice(2, 10);
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
}

interface Ref {
  ns: string;
  id: string;
}

function ref(ns: string, id: string): Ref {
  return { ns, id };
}

function tuple(
  objectNs: string,
  objectId: string,
  relation: string,
  subjectNs: string,
  subjectId: string,
): TupleKey {
  return { objectNs, objectId, relation, subjectNs, subjectId };
}

function documentSource(ns: string): string {
  return [
    `namespace ${ns} {`,
    '  relation owner: user',
    '  relation editor: user',
    '  relation viewer: user',
    '',
    '  permission view = viewer | editor | owner',
    '}',
  ].join('\n');
}

async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(pool, source);
  if (!result.ok) {
    throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
  }
}

describe('atToken pinning — §6.3', () => {
  it('a-check-pinned-to-the-token-a-write-just-returned-observes-that-write', async () => {
    const ns = uniqueName('doc');
    await publishOk(documentSource(ns));
    const objectId = uniqueName('obj');
    const t = tuple(ns, objectId, 'viewer', 'user', 'alice');

    const writeResult = await writeTuple(pool, t);
    expect(writeResult.ok).toBe(true);
    if (!writeResult.ok) return;

    const result = await productionCheck(pool, ref('user', 'alice'), ref(ns, objectId), 'view', {
      atToken: writeResult.token,
    });
    expect(result.allowed).toBe(true);
  });

  it('a-check-pinned-to-the-token-a-delete-just-returned-observes-that-delete-and-denies', async () => {
    const ns = uniqueName('doc');
    await publishOk(documentSource(ns));
    const objectId = uniqueName('obj');
    const t = tuple(ns, objectId, 'viewer', 'user', 'alice');

    const writeResult = await writeTuple(pool, t);
    expect(writeResult.ok).toBe(true);
    if (!writeResult.ok) return;

    // Confirm the grant really is observable before revoking it, so
    // "denied after delete" below isn't vacuously true.
    const beforeDelete = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(ns, objectId),
      'view',
      {
        atToken: writeResult.token,
      },
    );
    expect(beforeDelete.allowed).toBe(true);

    const deleteResult = await deleteTuple(pool, t);
    expect(deleteResult.ok).toBe(true);
    if (!deleteResult.ok) return;

    const afterDelete = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(ns, objectId),
      'view',
      {
        atToken: deleteResult.token,
      },
    );
    expect(afterDelete.allowed).toBe(false);
  });
});

describe('an impossible/future atToken makes productionCheck reject, not resolve denied — §6.3, §7', () => {
  it('a-token-higher-than-any-write-this-database-has-observed-causes-productionCheck-to-reject-rather-than-resolve', async () => {
    const highest = await currentToken(pool);
    // Deliberately not trusting `currentToken`'s declared `number` return
    // type at face value — `test/unit/store/tuple-store.integration.test.ts`
    // documents a real bigint-as-string defect in this codebase's token
    // handling, so coercing explicitly here keeps this test meaningful
    // regardless of that defect's status.
    const impossiblyHighToken = Number(highest ?? 0) + 1_000_000;

    const ns = uniqueName('doc');
    await publishOk(documentSource(ns));
    const objectId = uniqueName('obj');

    // This must reject BEFORE resolving any boolean at all — a check
    // pinned to a token this database hasn't observed yet is not a "no,"
    // it's "cannot answer that yet," and §7's exit-code table treats an
    // infrastructure-shaped failure (exit 3) as distinct from a real denial
    // (exit 0). A caller that silently got `{ allowed: false }` here would
    // have no way to distinguish "genuinely denied" from "asked about a
    // future this database hasn't reached."
    await expect(
      productionCheck(pool, ref('user', 'alice'), ref(ns, objectId), 'view', {
        atToken: impossiblyHighToken,
      }),
    ).rejects.toThrow();
  });
});

describe('an unreachable database makes productionCheck reject, not silently resolve denied — the opposite of fail-closed-as-deny', () => {
  const unreachablePool = new Pool({
    connectionString: 'postgres://nobody:nothing@127.0.0.1:1/unreachable',
    connectionTimeoutMillis: 300,
  });

  afterAll(async () => {
    await unreachablePool.end();
  });

  it('an-unreachable-database-makes-productionCheck-reject-rather-than-resolve-allowed-false', async () => {
    // Well-formed identifiers throughout, so nothing short-circuits before
    // the pool is actually queried — this must fail specifically because
    // the query against Postgres itself cannot be made, not because of any
    // earlier validation step.
    await expect(
      productionCheck(unreachablePool, ref('user', 'alice'), ref('document', 'readme'), 'view'),
    ).rejects.toThrow();
  });
});

describe('an undeclared namespace or relation/permission name resolves {allowed:false}, never throws — a real "no," not an infrastructure failure', () => {
  it('checking-against-a-namespace-with-no-published-schema-at-all-resolves-denied-not-a-throw', async () => {
    // uniqueName guarantees no prior publishSchema call in this or any
    // other test could have created a config for this namespace.
    const ns = uniqueName('never_published_ns');

    const result = await productionCheck(pool, ref('user', 'alice'), ref(ns, 'x'), 'view');
    expect(result.allowed).toBe(false);
  });

  it('checking-an-undeclared-relation-or-permission-name-on-a-published-namespace-resolves-denied-not-a-throw', async () => {
    const ns = uniqueName('doc');
    await publishOk(documentSource(ns));
    const objectId = uniqueName('obj');
    // `viewer` is a declared relation; grant it, then ask about a name that
    // was never declared at all on this namespace's compiled config. Having
    // a real, unrelated grant present rules out "denied only because the
    // object has zero tuples" as an alternative explanation.
    await writeTuple(pool, tuple(ns, objectId, 'viewer', 'user', 'alice'));

    const result = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(ns, objectId),
      'not_a_declared_relation_or_permission',
    );
    expect(result.allowed).toBe(false);
  });
});
