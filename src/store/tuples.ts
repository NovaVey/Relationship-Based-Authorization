/**
 * The tuple store — build spec §4/§6.1/§6.3, Phase 2. `relation_tuples` is
 * the one and only source of truth this whole system reasons from; nothing
 * here computes a permission (that's Phase 3/4's job, walking the compiled
 * rewrite rules in `src/schema/dsl/types.ts` over exactly what this file
 * writes and reads) — this file only ever proves or changes what facts
 * exist.
 */
import type { Pool, PoolClient } from 'pg';

import { getLatestNamespaceConfig } from '../schema/publish.js';
import { IDENTIFIER_PATTERN, MAX_IDENTIFIER_LENGTH } from '../schema/dsl/types.js';

export interface TupleKey {
  objectNs: string;
  objectId: string;
  relation: string;
  subjectNs: string;
  subjectId: string;
  /** Present only for a tuple-to-userset subject ("group:eng#member"). */
  subjectRelation?: string;
}

export interface TupleRow extends TupleKey {
  id: number;
  createdAt: Date;
}

export interface TupleError {
  code:
    | 'invalid_identifier'
    | 'no_published_schema'
    | 'undeclared_relation'
    | 'relation_is_a_permission'
    | 'subject_type_not_allowed';
  message: string;
}

export type WriteTupleResult =
  { ok: true; token: number; created: boolean } | { ok: false; errors: TupleError[] };

export type DeleteTupleResult =
  { ok: true; token: number; deleted: boolean } | { ok: false; errors: TupleError[] };

const FIELDS: Array<[keyof TupleKey, string]> = [
  ['objectNs', 'object namespace'],
  ['objectId', 'object id'],
  ['relation', 'relation'],
  ['subjectNs', 'subject namespace'],
  ['subjectId', 'subject id'],
];

/**
 * Validates every identifier-shaped field of a tuple key against the same
 * grammar the schema DSL compiler enforces on namespace/relation names
 * (`IDENTIFIER_PATTERN`/`MAX_IDENTIFIER_LENGTH` — see `src/schema/dsl/
 * types.ts`'s own note that this is meant to be reused here, not
 * re-derived) — a malformed identifier is rejected before it ever reaches
 * a query, per §10's `a-malformed-namespace-relation-or-id-is-rejected-
 * before-it-reaches-the-database`.
 *
 * Exported (not module-private, despite `writeTuple`/`deleteTuple` being
 * this function's only in-module callers) so the CLI (`src/cli/commands/
 * tuple.ts`) can run this same pure, DB-free check on a parsed tuple key
 * before its own `DATABASE_URL`-set check — a malformed identifier is a
 * deterministic argument error regardless of whether a database happens to
 * be configured, and should never be masked behind an unrelated
 * infrastructure message (full-repo audit finding #13, LOW, 2026-08-16).
 */
export function validateIdentifiers(tuple: TupleKey): TupleError[] {
  const errors: TupleError[] = [];
  const check = (value: string, label: string): void => {
    if (value.length === 0) {
      errors.push({ code: 'invalid_identifier', message: `${label} must not be empty` });
      return;
    }
    if (value.length > MAX_IDENTIFIER_LENGTH) {
      errors.push({
        code: 'invalid_identifier',
        message: `${label} '${value}' exceeds the maximum identifier length (${MAX_IDENTIFIER_LENGTH})`,
      });
      return;
    }
    if (!IDENTIFIER_PATTERN.test(value)) {
      errors.push({
        code: 'invalid_identifier',
        message: `${label} '${value}' is not a valid identifier (must match ${IDENTIFIER_PATTERN.source})`,
      });
    }
  };
  for (const [key, label] of FIELDS) check(tuple[key] as string, label);
  if (tuple.subjectRelation !== undefined) check(tuple.subjectRelation, 'subject relation');
  return errors;
}

/**
 * Validates a tuple write against the *latest published* config for
 * `tuple.objectNs` (see `src/schema/publish.ts`): the relation must exist
 * and must be a storable `relation`, never a `permission` (build spec §5's
 * own non-negotiable — "the compiler rejects a schema that tries" covers
 * compile time; this is the same rule enforced again at write time, since
 * nothing else stops a caller from writing a tuple against a name the
 * compiler never got a chance to check), and the subject's
 * `(namespace, relation?)` pair must match one of that relation's declared
 * `subjectTypes` exactly.
 *
 * Deliberately not applied to deletes (see `deleteTuple`) — a relation
 * removed from a newer schema version must still be revocable for tuples
 * written under an older one; see `docs/DECISIONS.md`.
 */
async function validateAgainstSchema(pool: Pool, tuple: TupleKey): Promise<TupleError[]> {
  const config = await getLatestNamespaceConfig(pool, tuple.objectNs);
  if (!config) {
    return [
      {
        code: 'no_published_schema',
        message: `no published schema for namespace '${tuple.objectNs}' — publish one with 'authz schema publish' before writing tuples against it`,
      },
    ];
  }

  const relation = config.relations[tuple.relation];
  if (!relation) {
    if (config.permissions[tuple.relation]) {
      return [
        {
          code: 'relation_is_a_permission',
          message: `'${tuple.relation}' on namespace '${tuple.objectNs}' is a permission, not a relation — only a relation can be the target of a tuple write`,
        },
      ];
    }
    return [
      {
        code: 'undeclared_relation',
        message: `namespace '${tuple.objectNs}' declares no relation named '${tuple.relation}'`,
      },
    ];
  }

  const subjectTypeAllowed = relation.subjectTypes.some(
    (st) => st.namespace === tuple.subjectNs && st.relation === tuple.subjectRelation,
  );
  if (!subjectTypeAllowed) {
    const attempted =
      tuple.subjectRelation === undefined
        ? tuple.subjectNs
        : `${tuple.subjectNs}#${tuple.subjectRelation}`;
    return [
      {
        code: 'subject_type_not_allowed',
        message: `relation '${tuple.relation}' on namespace '${tuple.objectNs}' does not accept subject type '${attempted}'`,
      },
    ];
  }

  return [];
}

/**
 * Global advisory-lock key that serializes every `writeTuple`/`deleteTuple`
 * transaction's insert into `write_log` — see `acquireWriteLogLock`'s own
 * doc comment immediately below for the race this closes and why it must
 * be global rather than scoped like `src/schema/publish.ts`'s
 * `pg_advisory_xact_lock(hashtext($1))`. Also see `docs/DECISIONS.md`
 * (the entry documenting this fix).
 *
 * Deliberately the **two-integer-argument** form
 * (`pg_advisory_xact_lock(classid, objid)`), not the single-bigint form
 * `publish.ts` uses — Postgres documents the two forms as two entirely
 * separate lock keyspaces that never overlap (see "Advisory Locks" in the
 * Postgres manual: a lock taken with the bigint-key form can never collide
 * with one taken with the two-int-key form, regardless of the actual
 * numeric values involved). Using the two-int form here — rather than
 * picking some hopefully-unused bigint constant in `publish.ts`'s own
 * keyspace — makes that non-collision a structural guarantee, not a
 * "we picked a number nowhere near `hashtext()`'s typical output" argument.
 *
 * `classid` is the ASCII bytes of the literal string `wlog`
 * (`0x77 6c 6f 67` = `2003595111`) — an arbitrary but fixed, greppable,
 * human-legible `int4` reserved for exactly this one purpose, never
 * computed from anything. `objid` is a fixed `0`: this lock has exactly one
 * thing it ever serializes (all writes to the single, global `write_log`
 * table) — unlike `publishOne`'s per-namespace lock, there is no second
 * dimension here to key by, so every `writeTuple`/`deleteTuple` call,
 * across every namespace and every object/subject involved, takes the
 * identical `(classid, objid)` pair and therefore genuinely serializes
 * against every other one.
 *
 * Exported (not module-private) for exactly one reason: `test/unit/store/
 * tuple-store.integration.test.ts`'s inverted-commit-order regression test
 * acquires this *same* lock directly from a raw `pg.Client` to construct a
 * real "transaction A is holding the lock, mid-write, uncommitted" state
 * and then proves the real `writeTuple` genuinely blocks behind it —
 * exporting the real constants means that test exercises the actual
 * production lock key, not a value that merely happens to match it today
 * and could silently drift out of sync with this file on a future edit.
 */
export const WRITE_LOG_LOCK_CLASSID = 0x776c6f67; // ASCII 'wlog' — see doc comment above.
export const WRITE_LOG_LOCK_OBJID = 0;

/**
 * Closes a real race, found and reproduced against real Postgres during a
 * full-repo audit (HIGH severity), before this lock existed:
 * `write_log.token` is a `bigint generated always as identity` column —
 * its sequence value is allocated at INSERT-statement-execution time,
 * non-transactionally, so allocation order carries no guaranteed
 * relationship to commit order. Without this lock, two concurrent
 * transactions — A (token 100, slow to commit: a lock wait, a GC pause, a
 * disk stall) and B (an unrelated write, token 101, fast) — could commit
 * in the order B, then A. A caller who received token 101 from B and
 * pinned a check to it would pass `assertTokenObserved(101)` (`max(token)
 * = 101` is visible) while A's write (token 100 <= 101) had not committed
 * yet — the exact violation of `docs/CONSISTENCY.md`'s stated invariant,
 * "a check pinned to token T never returns a result that ignores a write
 * with token <= T." Reproduced live with two real, independently-driven
 * `pg.Client` connections before this fix existed: client A began a
 * transaction and inserted its `write_log` row (allocating the lower
 * token) but withheld its `COMMIT`; client B began, inserted (allocating
 * the higher token), and committed immediately, before A did — at that
 * point `max(token)` already covered B's token while A's still-lower-
 * numbered row remained genuinely uncommitted and invisible to a plain
 * read. See `docs/DECISIONS.md` for the exact live-reproduction transcript.
 *
 * The fix: acquire this transaction-scoped advisory lock as the very first
 * statement inside `writeTuple`/`deleteTuple`'s transaction, before either
 * their own `insert`/`delete` against `relation_tuples` or their call to
 * `insertWriteLog`. This makes every tuple write or delete, across the
 * entire database, a fully serialized sequence: the second of any two
 * concurrent calls blocks here until the first either commits or rolls
 * back, so `write_log.token` allocation order and commit order are
 * provably identical for every write this store ever performs — not
 * merely unlikely to disagree.
 *
 * Unlike `publishOne`'s namespace-scoped `hashtext($1)` lock (see that
 * function's own doc comment and `docs/DECISIONS.md` D-080), this lock
 * cannot be scoped any narrower than global: `write_log.token` is a single
 * sequence shared by every tuple write/delete in the entire database,
 * regardless of namespace, so any two concurrent writes anywhere — even on
 * completely unrelated namespaces/objects — can exhibit the exact race
 * above. A namespace-scoped lock here would close the race only for two
 * writes that happen to share a namespace, leaving the general case (the
 * one the finding actually describes: an unrelated concurrent write)
 * completely open.
 *
 * **The honest cost of this fix:** every `writeTuple`/`deleteTuple` call in
 * the entire system, for any namespace, now serializes against every other
 * one — a real throughput ceiling under concurrent write load that this
 * store did not have before (previously, only two writes racing for the
 * exact same `relation_tuples` row could contend at the database level;
 * now, any two concurrent tuple writes/deletes anywhere contend on this
 * lock). This is a deliberate trade of write throughput for a soundness
 * guarantee `docs/CONSISTENCY.md` already claimed unconditionally — see
 * `docs/DECISIONS.md`'s "Revisit if" note on this entry for what would
 * justify revisiting it (e.g. this lock becoming a measured bottleneck
 * under real write concurrency).
 *
 * `pg_advisory_xact_lock` needs no matching unlock call: Postgres releases
 * a transaction-scoped advisory lock automatically at this transaction's
 * own `COMMIT` or `ROLLBACK`, matching `writeTuple`/`deleteTuple`'s
 * existing `BEGIN`/`COMMIT`/`ROLLBACK` wrapping exactly, the same reasoning
 * `publishOne`'s own doc comment gives for its own lock.
 */
async function acquireWriteLogLock(client: PoolClient): Promise<void> {
  await client.query('select pg_advisory_xact_lock($1, $2)', [
    WRITE_LOG_LOCK_CLASSID,
    WRITE_LOG_LOCK_OBJID,
  ]);
}

async function insertWriteLog(
  client: PoolClient,
  operation: 'write' | 'delete',
  tuple: TupleKey,
): Promise<number> {
  // write_log.token is a Postgres `bigint`, which `pg` returns as a string,
  // never coerced on its own — see src/store/tokens.ts's doc comment for
  // the real, reproduced bug this caused before `Number(...)` was added
  // here. Query typed as `string`, not `number`, so this stays honest
  // about what `pg` actually hands back.
  const { rows } = await client.query<{ token: string }>(
    `insert into write_log (operation, tuple) values ($1, $2) returning token`,
    [operation, JSON.stringify(tuple)],
  );
  const raw = rows[0]?.token;
  if (raw === undefined) {
    // write_log.token is a NOT NULL generated column — reaching this means
    // the insert itself didn't return a row, which should be impossible
    // for a successful single-row INSERT ... RETURNING. Fail loudly rather
    // than let a caller receive an unusable token.
    throw new Error('write_log insert did not return a token');
  }
  return Number(raw);
}

/**
 * Writes a relation tuple. Idempotent: writing an already-existing tuple
 * doesn't create a second row (`created: false`), but still advances the
 * consistency token — the caller asked the store to ensure this fact
 * holds, and a fresh token is what lets them pin a later read to "as of
 * this call, that fact holds," whether or not this exact call is what
 * created it.
 */
export async function writeTuple(pool: Pool, tuple: TupleKey): Promise<WriteTupleResult> {
  const identifierErrors = validateIdentifiers(tuple);
  if (identifierErrors.length > 0) {
    return { ok: false, errors: identifierErrors };
  }

  const schemaErrors = await validateAgainstSchema(pool, tuple);
  if (schemaErrors.length > 0) {
    return { ok: false, errors: schemaErrors };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Must be the very first statement after BEGIN, before the insert
    // below and before insertWriteLog — see acquireWriteLogLock's own doc
    // comment for the race this closes.
    await acquireWriteLogLock(client);
    const { rowCount } = await client.query(
      `insert into relation_tuples
         (object_ns, object_id, relation, subject_ns, subject_id, subject_relation)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (object_ns, object_id, relation, subject_ns, subject_id, coalesce(subject_relation, ''))
       do nothing`,
      [
        tuple.objectNs,
        tuple.objectId,
        tuple.relation,
        tuple.subjectNs,
        tuple.subjectId,
        tuple.subjectRelation ?? null,
      ],
    );
    const token = await insertWriteLog(client, 'write', tuple);
    await client.query('COMMIT');
    return { ok: true, token, created: (rowCount ?? 0) > 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Deletes a relation tuple. Idempotent: deleting a tuple that doesn't
 * exist is a no-op (`deleted: false`), not an error — and still advances
 * the consistency token, for the same reason a redundant write does (see
 * `writeTuple`).
 */
export async function deleteTuple(pool: Pool, tuple: TupleKey): Promise<DeleteTupleResult> {
  const identifierErrors = validateIdentifiers(tuple);
  if (identifierErrors.length > 0) {
    return { ok: false, errors: identifierErrors };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Must be the very first statement after BEGIN, before the delete
    // below and before insertWriteLog — see acquireWriteLogLock's own doc
    // comment for the race this closes.
    await acquireWriteLogLock(client);
    const { rowCount } = await client.query(
      `delete from relation_tuples
       where object_ns = $1 and object_id = $2 and relation = $3
         and subject_ns = $4 and subject_id = $5
         and coalesce(subject_relation, '') = coalesce($6, '')`,
      [
        tuple.objectNs,
        tuple.objectId,
        tuple.relation,
        tuple.subjectNs,
        tuple.subjectId,
        tuple.subjectRelation ?? null,
      ],
    );
    const token = await insertWriteLog(client, 'delete', tuple);
    await client.query('COMMIT');
    return { ok: true, token, deleted: (rowCount ?? 0) > 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface TupleFilter {
  objectNs: string;
  objectId: string;
  relation?: string;
}

/**
 * The raw shape a `select ... from relation_tuples` row actually arrives
 * as. `id` is typed `string`, not `number`: `relation_tuples.id` is a
 * Postgres `bigint`, and `pg` never coerces a `bigint` to `number` on its
 * own — see `src/store/tokens.ts`'s doc comment for the real bug this
 * caused elsewhere before every bigint-column read in this file was
 * audited and explicitly coerced with `Number(...)`.
 */
interface RawTupleRow {
  id: string;
  object_ns: string;
  object_id: string;
  relation: string;
  subject_ns: string;
  subject_id: string;
  subject_relation: string | null;
  created_at: Date;
}

/** Every stored tuple on one object, optionally narrowed to one relation — "who has R on O". */
export async function listTuplesByObject(pool: Pool, filter: TupleFilter): Promise<TupleRow[]> {
  const conditions = ['object_ns = $1', 'object_id = $2'];
  const params: string[] = [filter.objectNs, filter.objectId];
  if (filter.relation !== undefined) {
    conditions.push(`relation = $${params.length + 1}`);
    params.push(filter.relation);
  }
  const { rows } = await pool.query<RawTupleRow>(
    `select id, object_ns, object_id, relation, subject_ns, subject_id, subject_relation, created_at
     from relation_tuples where ${conditions.join(' and ')}
     order by id`,
    params,
  );
  return rows.map(rowToTuple);
}

/** Every stored tuple naming one subject — "what does S have". */
export async function listTuplesBySubject(
  pool: Pool,
  subjectNs: string,
  subjectId: string,
): Promise<TupleRow[]> {
  const { rows } = await pool.query<RawTupleRow>(
    `select id, object_ns, object_id, relation, subject_ns, subject_id, subject_relation, created_at
     from relation_tuples where subject_ns = $1 and subject_id = $2
     order by id`,
    [subjectNs, subjectId],
  );
  return rows.map(rowToTuple);
}

function rowToTuple(row: RawTupleRow): TupleRow {
  return {
    id: Number(row.id),
    objectNs: row.object_ns,
    objectId: row.object_id,
    relation: row.relation,
    subjectNs: row.subject_ns,
    subjectId: row.subject_id,
    ...(row.subject_relation !== null ? { subjectRelation: row.subject_relation } : {}),
    createdAt: row.created_at,
  };
}
