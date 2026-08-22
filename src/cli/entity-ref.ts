/**
 * `namespace:id` parsing and identifier validation shared by every CLI
 * command that names a subject/object/relation directly on the command
 * line without routing through `writeTuple`/`deleteTuple` (which already
 * validate via `src/store/tuples.ts`'s own `validateIdentifiers`) — today
 * `authz check` and `authz expand` (second full-repo audit, finding #4,
 * MEDIUM, 2026-08-22).
 *
 * Before this file existed, both commands had their own copy-pasted
 * `parseEntityArg`, checking only colon *position* in the raw string —
 * never `IDENTIFIER_PATTERN`/`MAX_IDENTIFIER_LENGTH` (`src/schema/dsl/
 * types.ts`) — and neither command validated its own `relation` positional
 * argument at all. `src/api/server.ts`'s `identifierField()` already closed
 * this exact gap for the equivalent HTTP routes (D-093): an id containing
 * `:`/`#` can make `src/resolve/production/resolver.ts`'s
 * `parseFrontierKeyString` silently mis-split a reconstructed audit-trail
 * path — concretely, `authz check user:alice view 'document:evil#hack'`
 * produced the seed path `document:evil#hack#view`, and
 * `parseFrontierKeyString` computed `colonIndex=8 < hashIndex=13`, so it
 * did **not** throw and silently mis-split to `id='evil'`,
 * `relation='hack#view'` — corrupting the `--path` output and the
 * `checks.resolution_path` JSON *permanently persisted to the audit
 * table* (which has no `CHECK` constraint on those `text` columns). This
 * never changes the actual allow/deny outcome, only the printed/stored
 * proof of it — matching D-093's own MEDIUM severity for the identical
 * API-side gap, closed here for the CLI the same way.
 */
import { IDENTIFIER_PATTERN, MAX_IDENTIFIER_LENGTH } from '../schema/dsl/types.js';

export interface EntityArg {
  ns: string;
  id: string;
}

/** The exact predicate `identifierField()` (`src/api/server.ts`) applies via Zod — `min(1)` is implied by `IDENTIFIER_PATTERN` itself requiring a leading letter. */
export function isValidIdentifier(value: string): boolean {
  return value.length <= MAX_IDENTIFIER_LENGTH && IDENTIFIER_PATTERN.test(value);
}

/**
 * Parses `namespace:id` — the only form a subject/object reference takes
 * on this CLI — and validates both halves against the same identifier
 * grammar every published namespace/relation/permission name and every
 * `writeTuple`/`deleteTuple` call already has to satisfy. `undefined` for
 * anything else: no colon, a colon at position 0 (empty `ns`), a colon as
 * the last character (empty `id`), or either half failing
 * `isValidIdentifier` — one `undefined` return covers every malformed
 * shape, matching this file's callers' own existing "invalid reference"
 * handling (they don't need to distinguish *why* it was invalid).
 */
export function parseEntityArg(raw: string): EntityArg | undefined {
  const colon = raw.indexOf(':');
  if (colon <= 0 || colon === raw.length - 1) return undefined;
  const ns = raw.slice(0, colon);
  const id = raw.slice(colon + 1);
  if (!isValidIdentifier(ns) || !isValidIdentifier(id)) return undefined;
  return { ns, id };
}
