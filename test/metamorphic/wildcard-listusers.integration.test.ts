/**
 * A permanent metamorphic property for D-171 (public/wildcard subjects) —
 * `listUsers`'s own mandatory gate, separate from Property C
 * (`wildcard-subtract.integration.test.ts`): `src/audit/list.ts`'s
 * `MemberSet`/`evaluateExpandNode` combinators are a distinct code path
 * from the two check resolvers (built on `expand()`'s own tree, never
 * `productionCheck`/`referenceCheck` directly), so nothing in Property C
 * exercises this file's own logic at all. Every scenario here is run
 * against the real, unmodified `expand()`/`listUsers()` pipeline (real
 * Postgres, real SQL rows, real `expandRelation` wildcard-sentinel
 * detection) — not `evaluateExpandNode` called directly on a hand-built
 * `ExpandNode` (that pure-function-level coverage, including every
 * combinator's own edge cases, already lives in the DB-free
 * `test/unit/audit/list.test.ts`; this file's job is to prove the real
 * pipeline wires a stored wildcard tuple into that logic correctly, not to
 * re-prove the combinators themselves).
 *
 * Four scenario shapes, deliberately fixed per fixture (only the
 * namespace/subject salt varies per seed, to avoid cross-seed collisions
 * against one shared database — the actual correctness question each
 * scenario asks does not itself need randomizing):
 *
 * 1. **The regression this whole feature exists to prevent** (`docs/
 *    CAPABILITY-GAPS.md`'s own "silently mis-flattens a stored `user:*`
 *    into one literal entry" framing, and this design's own §5 finding: a
 *    naive fix that only widens the RESULT type, without also widening the
 *    exclusion combinator to track namespace coverage, would falsely still
 *    list a wildcard-excluded subject). `viewer@user:alice`,
 *    `banned@user:*` — `alice` MUST be absent from `listUsers(view)`'s own
 *    `subjects`, matching `check()`'s own correct denial.
 * 2. **Both branches wildcard the same namespace** — `viewer@user:*`,
 *    `banned@user:*` — the real answer is the empty set (everyone, minus
 *    everyone), never a stray `{kind:'wildcard', ns:'user'}` entry
 *    surviving the subtraction.
 * 3. **The one genuinely co-finite shape** — `viewer@user:*`, `banned` has
 *    ONLY a concrete exception (no `banned@user:*`) — the real answer is
 *    "everyone except this one named exception," unrepresentable as an
 *    enumerated list; `listUsers` MUST return the exact `{unenumerable:
 *    true, ns: 'user', reason: 'wildcardMinusConcreteExceptions'}` refusal,
 *    never a crash and never a silently wrong (over- or under-inclusive)
 *    list.
 * 4. **A plain wildcard grant, no exclusion at all** — `viewer@user:*` —
 *    `listUsers` returns exactly `{subjects: [{kind:'wildcard', ns:
 *    'user'}]}`, and a real, reserved, never-explicitly-granted witness
 *    user still resolves `check()` ALLOWED — the cross-check that `/check`
 *    and `listUsers` agree on what the wildcard actually covers.
 *
 * **Convention** — identical to this repo's every other
 * `*.integration.test.ts` file: a real, ephemeral `PostgreSqlContainer`.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../src/store/tuples.js';
import { publishSchema } from '../../src/schema/publish.js';
import { productionCheck } from '../../src/resolve/production/resolver.js';
import { listUsers } from '../../src/audit/list.js';
import { runMigrations } from '../../src/store/migrate.js';
import { WILDCARD_SUBJECT_ID } from '../../src/schema/dsl/types.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on('error', (err) => {
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

let uniqueCounter = 0;
const processSalt = Math.random().toString(36).slice(2, 10);
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
}

async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(pool, source);
  if (!result.ok) {
    throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
  }
}

async function writeOk(t: TupleKey): Promise<void> {
  const result = await writeTuple(pool, t);
  if (!result.ok) {
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
  }
}

function schemaFor(ns: string): string {
  return [
    `namespace ${ns} {`,
    '  relation viewer: user | user:*',
    '  relation banned: user | user:*',
    '',
    '  permission view = viewer - banned',
    '}',
  ].join('\n');
}

const SEED_COUNT = 10;

describe('Property D — listUsers correctly reflects a stored wildcard tuple through the real expand()/evaluateExpandNode pipeline (D-171)', () => {
  it(`across ${SEED_COUNT} random namespaces, all four wildcard listUsers scenarios resolve exactly as check() independently confirms`, async () => {
    for (let seedIndex = 0; seedIndex < SEED_COUNT; seedIndex += 1) {
      const seed = uniqueName(`m3list${seedIndex}`);
      const ns = `mex3list_${seed}`;
      await publishOk(schemaFor(ns));

      // --- scenario 1: the core regression check ---
      const alice = `alice_${seed}`;
      await writeOk({
        objectNs: ns,
        objectId: 'o1',
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: alice,
      });
      await writeOk({
        objectNs: ns,
        objectId: 'o1',
        relation: 'banned',
        subjectNs: 'user',
        subjectId: WILDCARD_SUBJECT_ID,
      });
      const scenario1 = await listUsers(pool, { ns, id: 'o1' }, 'view');
      expect(
        'unenumerable' in scenario1,
        `seed=${seed}: 'user:alice' minus 'user:*' is fully enumerable (the empty set), never a refusal`,
      ).toBe(false);
      if (!('unenumerable' in scenario1)) {
        expect(
          scenario1.subjects.some((s) => s.kind === 'concrete' && s.id === alice),
          `seed=${seed}: alice must be ABSENT from listUsers(view) once 'banned' wildcards her namespace — a naive tree-flatten regression`,
        ).toBe(false);
      }
      const aliceCheck = await productionCheck(
        pool,
        { ns: 'user', id: alice },
        { ns, id: 'o1' },
        'view',
      );
      expect(
        aliceCheck.allowed,
        `seed=${seed}: check() must independently confirm alice is denied`,
      ).toBe(false);

      // --- scenario 2: both branches wildcard the same namespace ---
      await writeOk({
        objectNs: ns,
        objectId: 'o2',
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: WILDCARD_SUBJECT_ID,
      });
      await writeOk({
        objectNs: ns,
        objectId: 'o2',
        relation: 'banned',
        subjectNs: 'user',
        subjectId: WILDCARD_SUBJECT_ID,
      });
      const scenario2 = await listUsers(pool, { ns, id: 'o2' }, 'view');
      expect(
        'unenumerable' in scenario2,
        `seed=${seed}: 'user:*' minus 'user:*' is exactly empty — fully enumerable, never a refusal`,
      ).toBe(false);
      if (!('unenumerable' in scenario2)) {
        expect(scenario2.subjects).toEqual([]);
      }

      // --- scenario 3: the one genuinely co-finite shape ---
      const excludedException = `excluded_${seed}`;
      await writeOk({
        objectNs: ns,
        objectId: 'o3',
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: WILDCARD_SUBJECT_ID,
      });
      await writeOk({
        objectNs: ns,
        objectId: 'o3',
        relation: 'banned',
        subjectNs: 'user',
        subjectId: excludedException,
      });
      const scenario3 = await listUsers(pool, { ns, id: 'o3' }, 'view');
      expect(
        scenario3,
        `seed=${seed}: 'user:*' minus one named concrete exception is co-finite — must refuse, never silently list a wrong (over- or under-inclusive) set`,
      ).toEqual({ unenumerable: true, ns: 'user', reason: 'wildcardMinusConcreteExceptions' });
      // Cross-check: check() itself must still correctly deny the named
      // exception and correctly allow everyone else — proving the
      // refusal is about listUsers's own enumeration limit, never about
      // check() itself being wrong or uncertain.
      const exceptionCheck = await productionCheck(
        pool,
        { ns: 'user', id: excludedException },
        { ns, id: 'o3' },
        'view',
      );
      expect(exceptionCheck.allowed, `seed=${seed}: check() must deny the named exception`).toBe(
        false,
      );
      const witness3 = `witness3_${seed}`;
      const witness3Check = await productionCheck(
        pool,
        { ns: 'user', id: witness3 },
        { ns, id: 'o3' },
        'view',
      );
      expect(
        witness3Check.allowed,
        `seed=${seed}: check() must allow a real, reserved, never-named witness (covered by the wildcard, not excluded)`,
      ).toBe(true);

      // --- scenario 4: a plain wildcard grant, no exclusion ---
      await writeOk({
        objectNs: ns,
        objectId: 'o4',
        relation: 'viewer',
        subjectNs: 'user',
        subjectId: WILDCARD_SUBJECT_ID,
      });
      const scenario4 = await listUsers(pool, { ns, id: 'o4' }, 'viewer');
      expect(scenario4).toEqual({ subjects: [{ kind: 'wildcard', ns: 'user' }] });
      const witness4 = `witness4_${seed}`;
      const witness4Check = await productionCheck(
        pool,
        { ns: 'user', id: witness4 },
        { ns, id: 'o4' },
        'viewer',
      );
      expect(
        witness4Check.allowed,
        `seed=${seed}: a real, reserved, never-named witness must resolve ALLOWED — check() and listUsers must agree on what the wildcard covers`,
      ).toBe(true);
    }
  }, 600_000);
});
