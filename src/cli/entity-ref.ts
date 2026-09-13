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
 *
 * D-190 (docs/DECISIONS.md): `parseEntityArg`'s `id` half moved off
 * `IDENTIFIER_PATTERN` onto `isValidDataPlaneId` (`src/store/tuples.ts`) —
 * an `id` is an opaque foreign-system key, not a schema symbol, so the
 * strict grammar was the wrong constraint for it (the same distinction
 * D-187 drew for `writeTuple`/`deleteTuple`'s own `objectId`/`subjectId`,
 * and D-093/this file's own `entityRefSchema` HTTP-side equivalent shared
 * before this fix). `ns` is unaffected — still `isValidIdentifier` below —
 * and the audit-trail-corruption danger above is still fully guarded
 * against: `isValidDataPlaneId` still rejects `#` (the char the repro
 * above actually depends on) and every control character; it only
 * additionally *allows* a colon, which was never part of that repro and
 * can never be ambiguous with the `ns`/`id` separator since `ns` stays
 * colon-free by construction (see `isValidDataPlaneId`'s own doc comment
 * for the full proof, identical to D-187's).
 */
import { IDENTIFIER_PATTERN, MAX_IDENTIFIER_LENGTH } from '../schema/dsl/types.js';
import { isValidDataPlaneId } from '../store/tuples.js';

export interface EntityArg {
  ns: string;
  id: string;
}

/**
 * The exact predicate `identifierField()` (`src/api/server.ts`) applies via
 * Zod — `min(1)` is implied by `IDENTIFIER_PATTERN` itself requiring a
 * leading letter. Used for every schema-symbol argument this CLI validates
 * directly: a `namespace:id` reference's `ns` half (`parseEntityArg` below)
 * and a bare `relation`/`namespace` positional argument (`check.ts`/
 * `expand.ts`/`privesc.ts`/`schema.ts`/`apikey.ts`). Never for an `id` half
 * as of D-190 — see `parseEntityArg`'s own doc comment.
 */
export function isValidIdentifier(value: string): boolean {
  return value.length <= MAX_IDENTIFIER_LENGTH && IDENTIFIER_PATTERN.test(value);
}

/**
 * Parses `namespace:id` — the only form a subject/object reference takes
 * on this CLI. `ns` is validated against the strict schema-symbol grammar
 * (`isValidIdentifier`); `id` against the looser data-plane grammar
 * (`isValidDataPlaneId`, D-190) — see this file's own top-of-file doc
 * comment for why the two halves need different constraints. `undefined`
 * for anything else: no colon, a colon at position 0 (empty `ns`), a colon
 * as the last character (empty `id`), or either half failing its own
 * grammar — one `undefined` return covers every malformed shape, matching
 * this file's callers' own existing "invalid reference" handling (they
 * don't need to distinguish *why* it was invalid).
 *
 * `raw.indexOf(':')` — the *first* colon — is still the correct split
 * point even though `id` may itself now contain one: `ns` can never
 * contain a colon (it must pass `isValidIdentifier`), so the first colon
 * in `raw` is always exactly the `ns`/`id` separator, however many more
 * colons `id` contributes after it.
 */
export function parseEntityArg(raw: string): EntityArg | undefined {
  const colon = raw.indexOf(':');
  if (colon <= 0 || colon === raw.length - 1) return undefined;
  const ns = raw.slice(0, colon);
  const id = raw.slice(colon + 1);
  if (!isValidIdentifier(ns) || !isValidDataPlaneId(id)) return undefined;
  return { ns, id };
}
