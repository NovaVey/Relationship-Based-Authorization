/**
 * `authz tuple write` / `authz tuple delete` — build spec §7. Object and
 * subject arguments use Zanzibar's own compact notation: `namespace:id`
 * for a plain reference, `namespace:id#relation` for a tuple-to-userset
 * subject (`group:eng#member`).
 */
import { writeTuple, deleteTuple, type TupleKey } from '../../store/tuples.js';
import { getPool, closePool } from '../../store/client.js';
import { env } from '../../config/env.js';

interface ObjectRef {
  ns: string;
  id: string;
}

interface SubjectRef extends ObjectRef {
  relation?: string;
}

/**
 * Parses `namespace:id` — used for the object argument, which is never a
 * userset reference.
 *
 * Exported for `test/isolation/identifier-and-tuple-validation.fuzz.test.ts`
 * (the malformed-userset-subject-grammar `.todo()`s), which needs to
 * inspect the raw-string splitting behavior directly, not just the CLI
 * command's own output — see that file's own doc comment on why. No
 * behavior change; this was module-private since Phase 2.
 */
export function parseObjectRef(raw: string): ObjectRef | undefined {
  const colon = raw.indexOf(':');
  if (colon <= 0 || colon === raw.length - 1) return undefined;
  return { ns: raw.slice(0, colon), id: raw.slice(colon + 1) };
}

/**
 * Parses `namespace:id` or `namespace:id#relation` — used for the subject
 * argument. Exported for the same reason as `parseObjectRef` above.
 */
export function parseSubjectRef(raw: string): SubjectRef | undefined {
  const hash = raw.indexOf('#');
  const objectPart = hash === -1 ? raw : raw.slice(0, hash);
  const object = parseObjectRef(objectPart);
  if (!object) return undefined;
  if (hash === -1) return object;
  const relation = raw.slice(hash + 1);
  if (relation.length === 0) return undefined;
  return { ...object, relation };
}

/** Exported for the same reason as `parseObjectRef`/`parseSubjectRef` above. */
export function buildTupleKey(
  objectRaw: string,
  relation: string,
  subjectRaw: string,
): TupleKey | undefined {
  const object = parseObjectRef(objectRaw);
  const subject = parseSubjectRef(subjectRaw);
  if (!object || !subject) return undefined;
  return {
    objectNs: object.ns,
    objectId: object.id,
    relation,
    subjectNs: subject.ns,
    subjectId: subject.id,
    ...(subject.relation !== undefined ? { subjectRelation: subject.relation } : {}),
  };
}

const REF_USAGE =
  "object must be 'namespace:id' (e.g. 'document:readme'); subject must be 'namespace:id' or 'namespace:id#relation' (e.g. 'user:alice' or 'group:eng#member')";

export async function tupleWrite(
  objectRaw: string,
  relation: string,
  subjectRaw: string,
): Promise<void> {
  const tuple = buildTupleKey(objectRaw, relation, subjectRaw);
  if (!tuple) {
    console.error(`invalid object/subject reference — ${REF_USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  try {
    const result = await writeTuple(pool, tuple);
    if (!result.ok) {
      console.error(`tuple write rejected:`);
      for (const error of result.errors) console.error(`  ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.log(`token ${result.token}${result.created ? '' : ' (already existed — no new row)'}`);
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}

export async function tupleDelete(
  objectRaw: string,
  relation: string,
  subjectRaw: string,
): Promise<void> {
  const tuple = buildTupleKey(objectRaw, relation, subjectRaw);
  if (!tuple) {
    console.error(`invalid object/subject reference — ${REF_USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  try {
    const result = await deleteTuple(pool, tuple);
    if (!result.ok) {
      console.error(`tuple delete rejected:`);
      for (const error of result.errors) console.error(`  ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.log(`token ${result.token}${result.deleted ? '' : ' (no such tuple — no-op)'}`);
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}
