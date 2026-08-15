/**
 * `authz check` — build spec §7: `authz check <subject> <relation> <object>
 * [--at-token <n>]`. Subject and object both use the plain `namespace:id`
 * form (never `namespace:id#relation`) — a check always asks about a
 * concrete principal, never a userset reference (Zanzibar's own Check API
 * has the same restriction; a userset isn't a thing you check membership
 * *of*, it's a thing other tuples point at).
 *
 * Backed by `src/resolve/production/resolver.ts` (Phase 4) — the same
 * engine an eventual API server would call. This is the CLI surface for
 * exactly the same `productionCheck`, not a separate code path.
 */
import { productionCheck } from '../../resolve/production/resolver.js';
import { getPool, closePool } from '../../store/client.js';
import { env } from '../../config/env.js';

interface EntityArg {
  ns: string;
  id: string;
}

/** Parses `namespace:id` — the only form a check's subject or object takes. */
function parseEntityArg(raw: string): EntityArg | undefined {
  const colon = raw.indexOf(':');
  if (colon <= 0 || colon === raw.length - 1) return undefined;
  return { ns: raw.slice(0, colon), id: raw.slice(colon + 1) };
}

const REF_USAGE = "subject and object must both be 'namespace:id' (e.g. 'user:alice')";

export interface CheckCliOptions {
  atToken?: string;
}

/**
 * Runs one check and prints the result. Exit codes follow §7's table as
 * applied elsewhere in this CLI (see `tuple.ts`): 0 the check ran and
 * printed a real answer (allowed *or* denied — denial is information, not
 * an error), 2 a malformed argument (bad subject/object reference, a
 * non-numeric `--at-token`), 3 an infrastructure failure (DB unreachable,
 * or a supplied token this database hasn't observed yet — both surface as
 * a thrown error from `productionCheck`, never a silent `false`).
 */
export async function check(
  subjectRaw: string,
  relation: string,
  objectRaw: string,
  options: CheckCliOptions,
): Promise<void> {
  const subject = parseEntityArg(subjectRaw);
  const object = parseEntityArg(objectRaw);
  if (!subject || !object) {
    console.error(`invalid subject/object reference — ${REF_USAGE}`);
    process.exitCode = 2;
    return;
  }

  let atToken: number | undefined;
  if (options.atToken !== undefined) {
    atToken = Number(options.atToken);
    if (!Number.isInteger(atToken) || atToken < 0) {
      console.error(`invalid --at-token '${options.atToken}' — must be a non-negative integer`);
      process.exitCode = 2;
      return;
    }
  }

  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  try {
    const result = await productionCheck(pool, subject, object, relation, {
      ...(atToken !== undefined ? { atToken } : {}),
    });
    console.log(
      `${subjectRaw} ${relation} ${objectRaw}: ${result.allowed ? 'ALLOWED' : 'DENIED'}` +
        (atToken !== undefined ? ` (at token ${atToken})` : ''),
    );
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}
