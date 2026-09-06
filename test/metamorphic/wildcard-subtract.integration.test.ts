/**
 * A permanent metamorphic property for D-171 (public/wildcard subjects) —
 * the mandatory soundness gate its own design decision requires before the
 * feature ships (see `docs/DECISIONS.md` D-171's own "mandatory, not
 * optional" framing, mirroring D-160/D-161's established precedent for
 * mechanisms 1/2). Structured identically to
 * `exclusion-subtract-unprovable-cut.integration.test.ts`'s own Property
 * A/B — **run against the real, unmodified production AND reference
 * engines, no second implementation needed — the property itself is the
 * check.**
 *
 * **The exact property asserted (mechanism 3 — see
 * `src/metamorphic/unprovable-exclusion-fixtures.ts`'s own top-of-file doc
 * comment for why this is a genuinely new, third mechanism, not a variant
 * of mechanisms 1/2).** For a schema containing an exclusion rule (`base -
 * subtract`) whose `subtract` branch is a plain relation carrying a
 * wildcard tuple (`<ns>:*`), with `base` genuinely, certainly true for a
 * real subject of that wildcard's namespace: the exclusion MUST resolve
 * `DENIED`, `certain: true`, against BOTH the real production engine and
 * the real reference engine. It must NEVER resolve `ALLOWED` on either. An
 * `ALLOWED` result here is a `false_grant` in this project's own strict
 * sense (`docs/DECISIONS.md` D-006) — the exact class of bug D-158 through
 * D-161 found and fixed for the two pre-existing mechanisms, now proven
 * closed for this third one too.
 *
 * A companion, same-fixture assertion proves non-interference: a namespace
 * whose `banned` relation ALSO declares `user:*` as an accepted subject
 * type must not, merely by declaring that grammar, regress the pre-existing
 * mechanism-2 uncertain-cut behavior for a DIFFERENT object's tuples that
 * don't use the wildcard at all — see
 * `buildMechanism3Fixture`'s own doc comment for why this needs three
 * separate objects, not one shared object mixing the wildcard and the deep
 * chain on the same relation (the wildcard would trivially dominate and
 * mask the deep chain for every subject, which is correct behavior, not a
 * meaningful regression check).
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
import { referenceCheck, type ReferenceTuple } from '../../src/resolve/reference/resolver.js';
import { compileSchema } from '../../src/schema/dsl/compiler.js';
import { runMigrations } from '../../src/store/migrate.js';
import {
  buildMechanism3Fixture,
  type FixtureTuple,
} from '../../src/metamorphic/unprovable-exclusion-fixtures.js';
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

interface Ref {
  ns: string;
  id: string;
}

function ref(ns: string, id: string): Ref {
  return { ns, id };
}

function toTupleKey(t: FixtureTuple): TupleKey {
  return {
    objectNs: t.objectNs,
    objectId: t.objectId,
    relation: t.relation,
    subjectNs: t.subjectNs,
    subjectId: t.subjectId,
    ...(t.subjectRelation !== undefined ? { subjectRelation: t.subjectRelation } : {}),
  };
}

function toReferenceTuple(t: FixtureTuple): ReferenceTuple {
  return toTupleKey(t);
}

async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(pool, source);
  if (!result.ok) {
    throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
  }
}

async function writeOk(t: FixtureTuple): Promise<{ token: number; created: boolean }> {
  const result = await writeTuple(pool, toTupleKey(t));
  if (!result.ok) {
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
  }
  return { token: result.token, created: result.created };
}

async function writeAllSequentially(
  seed: string,
  tuples: readonly FixtureTuple[],
): Promise<number> {
  let lastToken: number | undefined;
  for (const t of tuples) {
    const written = await writeOk(t);
    lastToken = written.token;
  }
  if (lastToken === undefined) {
    throw new Error(
      `seed=${seed}: fixture produced zero tuples — a generator bug, not a property finding`,
    );
  }
  return lastToken;
}

describe('Property C — a wildcard subject inside an exclusion subtract branch must correctly deny a subject it covers, on both the production and reference engines (mechanism 3, general sweep)', () => {
  const SEED_COUNT = 30;

  it(`across ${SEED_COUNT} random seeds, a wildcard-excluded subject resolves DENIED (certain) on both engines; a subject excluded only via a real, deep nested-group chain on a DIFFERENT object of the same schema still resolves DENIED (the pre-existing mechanism-2 behavior, unregressed by wildcard grammar existing elsewhere in the schema); and a genuinely unbanned control subject resolves ALLOWED (never denies everyone)`, async () => {
    let totalWildcardChecks = 0;
    let totalChainChecks = 0;
    let totalControlChecks = 0;

    for (let seedIndex = 0; seedIndex < SEED_COUNT; seedIndex += 1) {
      const seed = uniqueName(`m3prop${seedIndex}`);
      const fixture = buildMechanism3Fixture(seed);

      await publishOk(fixture.schemaSource);
      const lastToken = await writeAllSequentially(seed, fixture.tuples);

      // --- the core, load-bearing assertion: wildcard-in-subtract denies ---
      totalWildcardChecks += 1;
      const wildcardResult = await productionCheck(
        pool,
        ref('user', fixture.wildcardExcludedSubjectId),
        ref(fixture.namespace, fixture.wildcardObjectId),
        fixture.permissionName,
        { atToken: lastToken, maxDepth: fixture.pinnedMaxDepth },
      );
      expect(
        wildcardResult.allowed,
        `${fixture.description}\n'${fixture.permissionName}' resolved ALLOWED for a subject the exclusion's own subtract branch wildcards ('${WILDCARD_SUBJECT_ID}') — this is a false_grant, the exact soundness bug class D-158 through D-161 closed for mechanisms 1/2, now proven open (or closed) for mechanism 3`,
      ).toBe(false);
      expect(
        wildcardResult.certain,
        `${fixture.description}\na wildcard match is a depth-0, no-recursion leaf and must never be reported uncertain`,
      ).toBe(true);

      // Cross-check against the independent reference resolver, over the
      // exact same compiled schema and tuple graph — no second Postgres
      // round trip needed, referenceCheck is pure/in-memory.
      const compiled = compileSchema(fixture.schemaSource);
      if (!compiled.ok) {
        throw new Error(
          `${fixture.description}\nfixture schema failed to compile for the reference resolver: ${compiled.errors.map((e) => e.message).join('; ')}`,
        );
      }
      const referenceTuples = fixture.tuples.map(toReferenceTuple);
      const wildcardRefResult = referenceCheck(
        compiled.schema,
        referenceTuples,
        ref('user', fixture.wildcardExcludedSubjectId),
        ref(fixture.namespace, fixture.wildcardObjectId),
        fixture.permissionName,
        { maxDepth: fixture.pinnedMaxDepth },
      );
      expect(
        wildcardRefResult.allowed,
        `${fixture.description}\nthe REFERENCE resolver resolved ALLOWED for the wildcard-excluded subject — the two resolvers must agree, and both must deny`,
      ).toBe(false);

      // --- non-interference: the pre-existing deep-chain behavior still
      // works correctly on a DIFFERENT object of the same schema ---
      totalChainChecks += 1;
      const chainResult = await productionCheck(
        pool,
        ref('user', fixture.deepChainWitnessSubjectId),
        ref(fixture.namespace, fixture.chainObjectId),
        fixture.permissionName,
        { atToken: lastToken, maxDepth: fixture.pinnedMaxDepth },
      );
      expect(
        chainResult.allowed,
        `${fixture.description}\n'${fixture.permissionName}' resolved ALLOWED for the deep-chain witness at a pinned maxDepth shorter than the real chain — a false_grant via the pre-existing mechanism-2 cut, now regressed by this schema ALSO declaring 'user:*' as an accepted subject type elsewhere (D-171 must be additive, never changing behavior for tuples that don't use the wildcard)`,
      ).toBe(false);

      const chainRefResult = referenceCheck(
        compiled.schema,
        referenceTuples,
        ref('user', fixture.deepChainWitnessSubjectId),
        ref(fixture.namespace, fixture.chainObjectId),
        fixture.permissionName,
        { maxDepth: fixture.pinnedMaxDepth },
      );
      expect(
        chainRefResult.allowed,
        `${fixture.description}\nthe REFERENCE resolver resolved ALLOWED for the deep-chain witness — both resolvers must deny`,
      ).toBe(false);

      // --- non-degeneracy control: this fixture's own 'banned' machinery
      // must not deny everyone unconditionally ---
      totalControlChecks += 1;
      const controlResult = await productionCheck(
        pool,
        ref('user', fixture.controlSubjectId),
        ref(fixture.namespace, fixture.controlObjectId),
        fixture.permissionName,
        { atToken: lastToken, maxDepth: fixture.pinnedMaxDepth },
      );
      expect(
        controlResult.allowed,
        `${fixture.description}\ncontrol subject '${fixture.controlSubjectId}' on a genuinely unbanned object resolved DENIED — the fix must not be over-conservative and deny every exclusion under this schema, only the genuinely excluded subjects`,
      ).toBe(true);

      const controlRefResult = referenceCheck(
        compiled.schema,
        referenceTuples,
        ref('user', fixture.controlSubjectId),
        ref(fixture.namespace, fixture.controlObjectId),
        fixture.permissionName,
        { maxDepth: fixture.pinnedMaxDepth },
      );
      expect(
        controlRefResult.allowed,
        `${fixture.description}\nthe REFERENCE resolver resolved DENIED for the control subject — both resolvers must agree the control is ALLOWED`,
      ).toBe(true);
    }

    console.log(
      `[Property C] ${SEED_COUNT} seeds; ${totalWildcardChecks} wildcard-exclusion checks (all DENIED, certain, on both engines), ` +
        `${totalChainChecks} deep-chain non-interference checks (all DENIED, both engines), ` +
        `${totalControlChecks} non-degeneracy control checks (all ALLOWED, both engines)`,
    );

    expect(totalWildcardChecks).toBe(SEED_COUNT);
    expect(totalChainChecks).toBe(SEED_COUNT);
    expect(totalControlChecks).toBe(SEED_COUNT);
  }, 600_000);
});

describe('Property C — write-time control: a relation that does NOT declare a wildcard subject type rejects a wildcard tuple write', () => {
  it("a namespace whose 'banned' relation declares only 'user' (never 'user:*') rejects a 'user:*' tuple write with subject_type_not_allowed, never silently accepting it", async () => {
    const ns = uniqueName('mex3noncard');
    await publishOk(
      [
        `namespace ${ns} {`,
        '  relation viewer: user',
        '  relation banned: user', // deliberately NOT 'user | user:*'
        '',
        '  permission view = viewer - banned',
        '}',
      ].join('\n'),
    );

    const result = await writeTuple(pool, {
      objectNs: ns,
      objectId: 'x',
      relation: 'banned',
      subjectNs: 'user',
      subjectId: WILDCARD_SUBJECT_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.code).toBe('subject_type_not_allowed');
    }
  });
});
