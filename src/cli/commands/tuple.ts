/**
 * `authz tuple write` / `authz tuple delete` — build spec §7. Object and
 * subject arguments use Zanzibar's own compact notation: `namespace:id`
 * for a plain reference, `namespace:id#relation` for a tuple-to-userset
 * subject (`group:eng#member`).
 *
 * `authz tuple export` / `authz tuple import` (new feature, closes
 * `docs/CAPABILITY-GAPS.md`'s "Bulk writes and import/export" gap) — see
 * each function's own doc comment below. Both use the flat `TupleKey`
 * field shape (`objectNs`/`objectId`/`relation`/`subjectNs`/`subjectId`/
 * `subjectRelation`/`expiresAt`), one JSON object per NDJSON line — the
 * identical shape `POST /tuples`/`POST /tuples/batch` (`src/api/server.ts`)
 * already accept, deliberately, so a caller wiring this CLI into a real
 * migration doesn't have to translate between two different tuple
 * representations depending on whether they're going through the CLI or
 * the API.
 */
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

import {
  writeTuple,
  deleteTuple,
  validateIdentifiers,
  validateExpiresAt,
  listAllTuples,
  type TupleKey,
  type WriteTupleResult,
} from '../../store/tuples.js';
import { encodeToken } from '../../store/tokens.js';
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

/**
 * Full-repo audit finding #11 (2026-08-29): `created: false` alone doesn't
 * tell an operator whether the existing row is still active or its
 * validity window has already closed — surface `existingExpiresAt`
 * (`writeTuple`'s own new field) so re-granting access after an expiry
 * doesn't read as "already active, nothing to do" when the resolver is
 * still denying it.
 */
function describeWriteOutcome(result: Extract<WriteTupleResult, { ok: true }>): string {
  if (result.created) return '';
  if (result.existingExpiresAt != null && result.existingExpiresAt.getTime() <= Date.now()) {
    return ` (already existed — no new row — but the existing row expired at ${result.existingExpiresAt.toISOString()} and is no longer granting access; delete it and write again to restore)`;
  }
  return ' (already existed — no new row)';
}

const REF_USAGE =
  "object must be 'namespace:id' (e.g. 'document:readme'); subject must be 'namespace:id' or 'namespace:id#relation' (e.g. 'user:alice' or 'group:eng#member')";

export async function tupleWrite(
  objectRaw: string,
  relation: string,
  subjectRaw: string,
  options: { expiresAt?: string } = {},
): Promise<void> {
  const tuple = buildTupleKey(objectRaw, relation, subjectRaw);
  if (!tuple) {
    console.error(`invalid object/subject reference — ${REF_USAGE}`);
    process.exitCode = 2;
    return;
  }
  // Optional validity-window expiry (D-144). Parsed and range-checked here,
  // before the identifier/DATABASE_URL checks below, for the same reason
  // those run in this order: an immediately-decidable argument error (a
  // malformed or already-past `--expires-at` value) must never be masked
  // behind a later, unrelated infrastructure message just because no
  // database happens to be configured.
  if (options.expiresAt !== undefined) {
    const expiresAt = new Date(options.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      console.error(
        `invalid --expires-at value '${options.expiresAt}' — must be a valid ISO-8601 date string`,
      );
      process.exitCode = 2;
      return;
    }
    tuple.expiresAt = expiresAt;
  }
  // Full-repo audit finding (2026-08-29, MEDIUM, "tuple write --expires-at
  // <past date> reports exit 3 instead of exit 2 when DATABASE_URL is
  // unset"): `validateExpiresAt` is exactly as pure and DB-free as
  // `validateIdentifiers` below (see its own doc comment in tuples.ts),
  // but until this fix it only ever ran inside `writeTuple`, unreachable
  // until after the DATABASE_URL gate below passed — so a past-dated
  // `--expires-at` with no database configured surfaced as the infra
  // message at exit 3, masking the real, immediately-decidable argument
  // error. Hoisted here to match `validateIdentifiers`'s own precedent.
  const expiresAtErrors = validateExpiresAt(tuple);
  if (expiresAtErrors.length > 0) {
    console.error(`tuple write rejected:`);
    for (const error of expiresAtErrors) console.error(`  ${error.message}`);
    process.exitCode = 2;
    return;
  }
  // Pure, DB-free identifier-pattern check — run before the DATABASE_URL
  // check below so a malformed identifier (e.g. an id containing a space)
  // is reported as the argument error it is, exit code 2, regardless of
  // whether a database happens to be configured. `writeTuple` itself runs
  // this exact same check again once a pool exists (defense in depth, not
  // redundant — a caller other than this CLI might call `writeTuple`
  // directly without ever going through this pre-check).
  const identifierErrors = validateIdentifiers(tuple);
  if (identifierErrors.length > 0) {
    console.error(`tuple write rejected:`);
    for (const error of identifierErrors) console.error(`  ${error.message}`);
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
    console.log(`token ${encodeToken(result.token)}${describeWriteOutcome(result)}`);
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
  // See tupleWrite's identical check above for why this runs before the
  // DATABASE_URL check.
  const identifierErrors = validateIdentifiers(tuple);
  if (identifierErrors.length > 0) {
    console.error(`tuple delete rejected:`);
    for (const error of identifierErrors) console.error(`  ${error.message}`);
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
    console.log(
      `token ${encodeToken(result.token)}${result.deleted ? '' : ' (no such tuple — no-op)'}`,
    );
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}

/** One page at a time — bounds how many rows this command ever holds in memory at once, regardless of how large the store gets. */
export const EXPORT_PAGE_SIZE = 1000;

function tupleToNdjsonLine(tuple: TupleKey): string {
  const fields: Record<string, unknown> = {
    objectNs: tuple.objectNs,
    objectId: tuple.objectId,
    relation: tuple.relation,
    subjectNs: tuple.subjectNs,
    subjectId: tuple.subjectId,
  };
  if (tuple.subjectRelation !== undefined) fields.subjectRelation = tuple.subjectRelation;
  if (tuple.expiresAt !== undefined) fields.expiresAt = tuple.expiresAt.toISOString();
  return JSON.stringify(fields);
}

/**
 * `authz tuple export [--namespace <ns>]` — every stored tuple (or every
 * tuple on one object namespace), one NDJSON line per tuple, to stdout.
 * All diagnostic output (the final count) goes to stderr, matching this
 * codebase's own established "stdout is the report and nothing else"
 * convention (`src/cli/commands/soundness.ts`'s `--format`) — a caller
 * piping this straight into a file or another process's stdin never sees
 * anything but real NDJSON rows on that stream.
 *
 * Paginated by `listAllTuples`'s own stable `id` cursor
 * (`src/store/tuples.ts`), `EXPORT_PAGE_SIZE` rows at a time — this
 * command never holds more than one page in memory regardless of how
 * large the store is, but is not a point-in-time snapshot: a tuple
 * written after this command starts but before it reaches that row's own
 * `id` is included; one deleted after this command has already read past
 * it is not — see `listAllTuples`'s own doc comment for the exact
 * guarantee this rests on.
 */
export async function tupleExport(options: { namespace?: string } = {}): Promise<void> {
  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  let afterId = 0;
  let total = 0;
  try {
    for (;;) {
      const rows = await listAllTuples(pool, {
        ...(options.namespace !== undefined ? { objectNs: options.namespace } : {}),
        afterId,
        limit: EXPORT_PAGE_SIZE,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        process.stdout.write(tupleToNdjsonLine(row) + '\n');
        afterId = row.id;
        total += 1;
      }
      if (rows.length < EXPORT_PAGE_SIZE) break;
    }
    console.error(
      `exported ${total} tuple${total === 1 ? '' : 's'}` +
        (options.namespace !== undefined ? ` (namespace: ${options.namespace})` : ''),
    );
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}

/**
 * `tupleExport`'s own line shape, parsed back — `undefined` for anything
 * that isn't a plain object with every required string field non-empty,
 * an optional non-empty `subjectRelation`, and an optional `expiresAt`
 * that parses as a valid date. One generic shape-error message per bad
 * line at the call site (not itemized field-by-field) — the same level
 * of detail `buildTupleKey`'s own "invalid object/subject reference"
 * already gives a malformed CLI argument.
 */
function parseNdjsonTuple(value: unknown): TupleKey | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { objectNs, objectId, relation, subjectNs, subjectId, subjectRelation, expiresAt } =
    value as Record<string, unknown>;
  const requiredFields = [objectNs, objectId, relation, subjectNs, subjectId];
  if (requiredFields.some((field) => typeof field !== 'string' || field.length === 0)) {
    return undefined;
  }
  if (
    subjectRelation !== undefined &&
    (typeof subjectRelation !== 'string' || subjectRelation.length === 0)
  ) {
    return undefined;
  }
  const tuple: TupleKey = {
    objectNs: objectNs as string,
    objectId: objectId as string,
    relation: relation as string,
    subjectNs: subjectNs as string,
    subjectId: subjectId as string,
  };
  if (subjectRelation !== undefined) tuple.subjectRelation = subjectRelation;
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== 'string') return undefined;
    const parsedExpiresAt = new Date(expiresAt);
    if (Number.isNaN(parsedExpiresAt.getTime())) return undefined;
    tuple.expiresAt = parsedExpiresAt;
  }
  return tuple;
}

/**
 * `authz tuple import [<file>] [--progress <n>]` — the mirror image of
 * `tupleExport`: reads NDJSON (from `<file>`, or stdin if omitted — the
 * standard Unix "pipe from the previous command" convention) and writes
 * every line through the real `writeTuple`, `Math.max(1,
 * env.MAX_CONCURRENCY)` at a time, the same concurrency-slicing shape
 * `runTupleBatch` (`src/api/server.ts`) establishes for `POST /tuples/
 * batch` — this command exists precisely so a real migration doesn't have
 * to fight that route's own 20/minute write rate limit at all, since it
 * writes directly against the store, the same way `scripts/
 * seed-example.ts` already does.
 *
 * **One bad line never sinks the whole import — the identical principle
 * `POST /tuples/batch` already establishes, applied here too.** A
 * malformed line, or a tuple `writeTuple` itself rejects (an undeclared
 * relation, a disallowed subject type, a past `expiresAt`), is reported to
 * stderr and counted as failed; every other line still gets its own
 * chance to write. Exit code `2` if any line failed this way, but only
 * after every line has been attempted.
 *
 * **A genuine infrastructure failure is a different, fatal case.** Unlike
 * a per-line validation rejection, a THROWN error from `writeTuple` (a
 * real, live Postgres problem — that function's own doc comment) is never
 * caught per-item here; it propagates out of the batch loop below and
 * aborts the whole import immediately, exit code `3` — the same
 * "an unreachable database is an infrastructure failure, never smoothed
 * over into an ordinary per-item outcome" discipline `performCheck`'s own
 * doc comment already establishes, applied to writes instead of checks.
 */
export async function tupleImport(
  filePath: string | undefined,
  options: { progress?: string } = {},
): Promise<void> {
  let progressEvery: number | undefined;
  if (options.progress !== undefined) {
    const parsedEvery = Number(options.progress);
    if (!Number.isInteger(parsedEvery) || parsedEvery <= 0) {
      console.error(`invalid --progress '${options.progress}' — must be a positive integer`);
      process.exitCode = 2;
      return;
    }
    progressEvery = parsedEvery;
  }

  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const lines: string[] = [];
  const input = filePath !== undefined ? createReadStream(filePath) : process.stdin;
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.trim().length > 0) lines.push(line);
    }
  } catch (err) {
    console.error(`${filePath ?? 'stdin'}: ${(err as Error).message}`);
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  let written = 0;
  let alreadyExisted = 0;
  let failed = 0;
  let lastReported = 0;
  const concurrency = Math.max(1, env.MAX_CONCURRENCY);

  try {
    for (let start = 0; start < lines.length; start += concurrency) {
      const batch = lines.slice(start, start + concurrency);
      await Promise.all(
        batch.map(async (raw, offset) => {
          const lineNo = start + offset + 1;
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            console.error(`line ${lineNo}: not valid JSON`);
            failed += 1;
            return;
          }
          const tuple = parseNdjsonTuple(parsed);
          if (tuple === undefined) {
            console.error(
              `line ${lineNo}: must be an object with non-empty string objectNs/objectId/relation/subjectNs/subjectId (subjectRelation optional non-empty string, expiresAt optional ISO-8601 string)`,
            );
            failed += 1;
            return;
          }
          // No inner try/catch around this call — see this function's own
          // doc comment for why a thrown error here must propagate,
          // aborting the whole import, rather than being counted as one
          // more failed line.
          const result = await writeTuple(pool, tuple);
          if (!result.ok) {
            console.error(
              `line ${lineNo}: ${result.errors.map((error) => error.message).join('; ')}`,
            );
            failed += 1;
            return;
          }
          if (result.created) written += 1;
          else alreadyExisted += 1;
        }),
      );
      const completed = Math.min(start + concurrency, lines.length);
      if (
        progressEvery !== undefined &&
        (completed - lastReported >= progressEvery || completed >= lines.length)
      ) {
        console.error(`  imported ${completed}/${lines.length} lines`);
        lastReported = completed;
      }
    }
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    console.error(
      `aborted after ${written + alreadyExisted + failed}/${lines.length} lines attempted (${written} written, ${alreadyExisted} already existed, ${failed} failed)`,
    );
    process.exitCode = 3;
    await closePool();
    return;
  }

  await closePool();
  console.log(
    `${written} written, ${alreadyExisted} already existed, ${failed} failed, out of ${lines.length} line${lines.length === 1 ? '' : 's'}`,
  );
  if (failed > 0) process.exitCode = 2;
}
