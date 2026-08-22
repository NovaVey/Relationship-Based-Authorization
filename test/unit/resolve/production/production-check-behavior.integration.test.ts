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
 * Runs against a real, ephemeral Postgres container, same convention as
 * `cross-resolver-agreement.integration.test.ts` in this directory — see
 * that file's own header and `docs/DECISIONS.md` D-019 for why.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, deleteTuple, type TupleKey } from '../../../../src/store/tuples.js';
import { currentToken } from '../../../../src/store/tokens.js';
import { publishSchema } from '../../../../src/schema/publish.js';
import { productionCheck } from '../../../../src/resolve/production/resolver.js';
import { runMigrations } from '../../../../src/store/migrate.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on('error', (err) => {
    // pg's own documented contract: without this, an idle client hitting a
    // background/network-level error (most commonly this file's own container
    // being stopped in afterAll while a pooled connection was still technically
    // open, though the identical gap applies to any Pool in this file) crashes
    // the whole test run with an unhandled 'error' event, even though every
    // real assertion already passed — a known pg gotcha, not a bug in this
    // file's own test logic. Logged, not swallowed: still visible if it ever
    // fires somewhere other than expected teardown.
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
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

/**
 * The regression test for full-repo audit finding #1 (HIGH, `docs/
 * DECISIONS.md` D-092): before this fix, every read inside a single
 * `productionCheck` call (the config lookup, the frontier query, the
 * tuple-on-frontier query) was its own independent, autocommit
 * `pool.query()` — no shared transaction, no shared snapshot. A write that
 * committed *while* one check was still in flight could be observed by
 * some of that check's own internal reads and not others, stitching a
 * resolution path together out of facts that never coexisted at any real
 * point in the database's history.
 *
 * **Why this can't be triggered by simply racing `productionCheck` against
 * a concurrent `writeTuple` call and hoping the timing lines up:**
 * `productionCheck`'s own internal `await`s run back-to-back with no
 * externally-observable pause between them — from a caller's perspective
 * it is one atomic promise, so there is no reliable way to schedule a
 * concurrent commit to land in the microseconds-wide window between two of
 * its own queries. This test sidesteps that by using a real Postgres
 * table-level lock to create a *wide, fully controlled* pause instead:
 *
 * 1. A decoy tuple is written first, and its token (`T1`) is captured —
 *    this is the token the check below will pin to.
 * 2. A raw `pg.Client` (`lockHolder`) takes `LOCK TABLE namespace_configs
 *    IN ACCESS EXCLUSIVE MODE` and holds it, uncommitted — this blocks any
 *    *other* connection's plain `SELECT` against `namespace_configs`
 *    (confirmed directly against real Postgres before this test was
 *    trusted — see this task's own final report), including
 *    `productionCheck`'s own config lookup, but does **not** block a write
 *    to the *different* `relation_tuples` table.
 * 3. `productionCheck(..., { atToken: T1 })` is started (not yet awaited).
 *    Its `REPEATABLE READ` transaction's first statement — the token
 *    floor-check against `write_log` (unaffected by the lock above) — runs
 *    immediately and anchors this check's entire snapshot right there,
 *    before the config lookup even gets a chance to run. The config lookup
 *    then genuinely blocks on `lockHolder`'s lock — confirmed, not
 *    assumed, by the `sleep`+"still not settled" check below.
 * 4. *While the check is blocked*, a real grant tuple naming the checked
 *    subject is inserted directly (a second raw client, autocommit — not
 *    `writeTuple`, since `writeTuple` would itself block on the same
 *    `namespace_configs` lock via its own schema-validation lookup) and
 *    confirmed committed.
 * 5. `lockHolder` releases the lock. The check's config lookup, then its
 *    frontier and tuple-on-frontier queries, all finally run — using the
 *    snapshot that was already fixed back in step 3, strictly before the
 *    new grant existed.
 * 6. The check is asserted `allowed: false` — its own snapshot never saw
 *    the grant, even though every one of its internal queries physically
 *    executes *after* that grant was already committed and visible to any
 *    other reader. A fresh, unpinned check run immediately afterward
 *    confirms the grant really is there (`allowed: true`) — ruling out "the
 *    insert silently failed" as an alternative explanation for step 6.
 *
 * Verified live, manually, against this exact test with the fix reverted
 * (`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` replaced with a
 * same-connection `BEGIN` at plain `READ COMMITTED`, mirroring what the
 * autocommit-per-query code effectively behaved like): the check instead
 * resolved `allowed: true` — its config-lookup, frontier, and
 * tuple-on-frontier queries each independently re-read whatever was
 * committed at their own execution time, all of which was *after* the
 * concurrent grant — reproducing the exact phantom-witness hazard this
 * finding describes. Restored before this test was considered done — see
 * this task's own final report for the exact before/after transcript.
 */
describe("a check pinned to a token does not observe a write that commits mid-check, even though every one of the check's own internal queries physically executes after that write — full-repo audit finding #1", () => {
  /** Waits `ms`, purely to give a wrongly-unblocked promise every chance to have already settled — mirrors `tuple-store.integration.test.ts`'s own established idiom for this exact class of proof. */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('a-grant-committed-while-the-check-is-blocked-mid-transaction-is-invisible-to-that-checks-own-result-despite-every-internal-query-running-after-it', async () => {
    const ns = uniqueName('doc');
    await publishOk(documentSource(ns));
    const objectId = uniqueName('obj');
    const decoyObjectId = uniqueName('decoy');

    // Step 1: a decoy write, unrelated to the subject/object under test,
    // purely to mint a real token to pin to.
    const decoyWrite = await writeTuple(pool, tuple(ns, decoyObjectId, 'viewer', 'user', 'zoe'));
    expect(decoyWrite.ok).toBe(true);
    if (!decoyWrite.ok) return;
    const pinnedToken = decoyWrite.token;

    // Step 2: block any *other* connection's read of namespace_configs —
    // confirmed directly against real Postgres (not assumed) to block a
    // plain SELECT on that table while leaving a write to the unrelated
    // relation_tuples table completely free to proceed.
    const lockHolder = new Client({ connectionString: container.getConnectionUri() });
    await lockHolder.connect();
    const grantWriter = new Client({ connectionString: container.getConnectionUri() });
    await grantWriter.connect();

    try {
      await lockHolder.query('BEGIN');
      await lockHolder.query('LOCK TABLE namespace_configs IN ACCESS EXCLUSIVE MODE');

      // Step 3: start the pinned check — its floor-check (write_log) is
      // unaffected by the lock above and runs immediately, anchoring this
      // check's REPEATABLE READ snapshot right there. Not yet awaited.
      let checkSettled = false;
      const checkPromise = productionCheck(pool, ref('user', 'alice'), ref(ns, objectId), 'view', {
        atToken: pinnedToken,
      }).then(
        (r) => {
          checkSettled = true;
          return r;
        },
        (e: unknown) => {
          checkSettled = true;
          throw e;
        },
      );

      // Confirmed, not assumed: the check is genuinely blocked on the
      // config-lookup lock, not merely slow.
      await sleep(500);
      expect(checkSettled).toBe(false);

      // Step 4: the grant, committed for real, while the check above is
      // still blocked mid-transaction. Raw SQL against `grantWriter`
      // (autocommit, single statement) rather than the real `writeTuple` —
      // `writeTuple` validates against `namespace_configs` itself and
      // would deadlock behind the exact same lock the check is blocked on.
      await grantWriter.query(
        `insert into relation_tuples
           (object_ns, object_id, relation, subject_ns, subject_id, subject_relation)
         values ($1, $2, 'viewer', 'user', 'alice', null)`,
        [ns, objectId],
      );
      // Confirmed committed and visible to an independent connection
      // before the lock is released — proving what follows is a real,
      // already-committed fact the check's own snapshot chooses not to
      // see, not a write that simply hadn't landed yet.
      const { rows: committedCheck } = await pool.query<{ count: string }>(
        `select count(*)::text as count from relation_tuples
         where object_ns = $1 and object_id = $2 and subject_id = 'alice'`,
        [ns, objectId],
      );
      expect(Number(committedCheck[0]?.count)).toBe(1);

      // Step 5: unblock the check.
      await lockHolder.query('COMMIT');

      // Step 6: the actual claim.
      const result = await checkPromise;
      expect(result.allowed).toBe(false);
    } finally {
      await lockHolder.end();
      await grantWriter.end();
    }

    // Control: a fresh, unpinned check for the identical subject/object/
    // relation now sees the grant — the earlier `false` was the snapshot
    // genuinely excluding a real fact, not the insert having silently
    // failed.
    const freshResult = await productionCheck(
      pool,
      ref('user', 'alice'),
      ref(ns, objectId),
      'view',
    );
    expect(freshResult.allowed).toBe(true);
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
  unreachablePool.on('error', (err) => {
    // pg's own documented contract: without this, an idle client hitting a
    // background/network-level error (most commonly this file's own container
    // being stopped in afterAll while a pooled connection was still technically
    // open, though the identical gap applies to any Pool in this file) crashes
    // the whole test run with an unhandled 'error' event, even though every
    // real assertion already passed — a known pg gotcha, not a bug in this
    // file's own test logic. Logged, not swallowed: still visible if it ever
    // fires somewhere other than expected teardown.
    console.error(`pool error (expected during container teardown): ${err.message}`);
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
