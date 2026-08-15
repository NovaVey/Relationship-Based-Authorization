/**
 * The consistency token — build spec §6.3. `write_log.token` (a generated
 * column always equal to that row's own `id` — see the 0001 migration's own
 * comment) is a monotonic marker every write/delete advances. A caller that
 * pins a read to token T is expressing "this read must reflect everything
 * up to and including T" — not "give me a snapshot as of exactly T": on one
 * Postgres instance, with no replica lag to hide, ordinary transaction
 * visibility already guarantees a query started after a commit sees it.
 * What actually needs enforcing is narrower and checkable: T must be a
 * token this database has actually observed by the time the pinned read
 * runs — `assertTokenObserved` is that check, made concrete rather than an
 * unexamined "eventually consistent."
 */
import type { Pool } from 'pg';

/** The highest token this database has issued so far, or `null` if no write has ever happened. */
export async function currentToken(pool: Pool): Promise<number | null> {
  const { rows } = await pool.query<{ max_token: number | null }>(
    'select max(token) as max_token from write_log',
  );
  return rows[0]?.max_token ?? null;
}

/**
 * Throws if `token` is higher than every token this database has observed
 * — the property build spec §6.3 states as non-negotiable: "a check pinned
 * to token T never returns a result that ignores a write with token ≤ T."
 * A pinned read calls this immediately before it reads, so an unobservable
 * token fails loudly instead of silently reading current state and calling
 * it a match for a pin it never actually satisfied.
 */
export async function assertTokenObserved(pool: Pool, token: number): Promise<void> {
  const observed = await currentToken(pool);
  if (observed === null || token > observed) {
    throw new Error(
      `consistency token ${token} has not been observed by this database ` +
        `(highest known token: ${observed ?? 'none — no writes yet'})`,
    );
  }
}
