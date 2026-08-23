/**
 * `authz check` — build spec §7: `authz check <subject> <relation> <object>
 * [--at-token <token>]`. Subject and object both use the plain `namespace:id`
 * form (never `namespace:id#relation`) — a check always asks about a
 * concrete principal, never a userset reference (Zanzibar's own Check API
 * has the same restriction; a userset isn't a thing you check membership
 * *of*, it's a thing other tuples point at).
 *
 * Backed by `src/audit/checks.ts`'s `performCheck` (Phase 6), not
 * `productionCheck` directly (Phase 4) — every real `authz check`
 * invocation is a real application-facing check, so every one gets logged
 * to the `checks` audit trail (§9 Phase 6's exit criterion: "every check,
 * allowed or denied, is logged"), same engine either way.
 */
import { performCheck } from '../../audit/checks.js';
import { getPool, closePool } from '../../store/client.js';
import { decodeToken } from '../../store/tokens.js';
import { env } from '../../config/env.js';
import type { ResolutionStep } from '../../resolve/production/resolver.js';
import { parseEntityArg, isValidIdentifier } from '../entity-ref.js';
import { MAX_IDENTIFIER_LENGTH } from '../../schema/dsl/types.js';

function entity(e: { ns: string; id: string }): string {
  return `${e.ns}:${e.id}`;
}

/**
 * Renders `ResolutionStep` (§6.7's positive-witness tree, `result.path`) as
 * the same indented arrow-chain the README's own headline example shows —
 * added by full-repo audit finding #8 (MEDIUM, 2026-08-16): the README
 * states `authz check ... "returns this exact path"` and its own "try it
 * yourself" walkthrough runs exactly that command, but before `--path`
 * existed, plain `check` only ever printed `ALLOWED`/`DENIED` — the
 * resolution path was real and already computed/stored (`checks.
 * resolution_path`, the API's JSON response), just never what this
 * specific command printed. This closes that gap for real rather than
 * rewriting the README down to what the CLI used to do.
 *
 * `union`/`computedUserset`-style transparency: a `UnionStep` only ever
 * represents the *one* branch that actually satisfied the permission (§6.7
 * — the resolver doesn't record the branches that weren't needed), so it
 * contributes no hop of its own here, exactly mirroring how `expand.ts`'s
 * `computedUserset` case is transparent. `IntersectionStep`/`ExclusionStep`
 * are genuinely tree-shaped (every branch of an intersection mattered; an
 * exclusion depends on a base grant *and* a negative witness) rather than
 * one linear chain, so those render as an indented sub-list instead of
 * folding into the single arrow chain the union/direct-grant/userset/
 * tuple-to-userset cases produce.
 *
 * `name` is the relation/permission name currently being satisfied at
 * `step.object` — threaded down explicitly because most `ResolutionStep`
 * variants do NOT carry it themselves. Only `directGrant`/
 * `usersetMembership` name a real, storable relation on their own node
 * (`step.relation`); `union`/`intersection`/`exclusion` are pure
 * combinators over whatever permission the caller was already resolving,
 * so `name` passes through unchanged; `tupleToUserset` is the one case
 * that's genuinely easy to get wrong — `step.relation` is the TUPLE
 * relation *followed* (e.g. "parent"), and `step.computedUserset` is the
 * permission/relation checked on the *target* (`step.through`) reached via
 * that tuple, which is not required by the DSL's grammar to equal `name`
 * even though a "parent->view" self-referential-inheritance idiom often
 * makes them look the same — conflating either of those with `name` was
 * caught live during verification (produced `document:eng_handbook#parent`
 * instead of the README's own documented `document:eng_handbook#edit` for
 * the exact worked example this flag exists to reproduce) before this
 * threaded-`name` version was written.
 *
 * Exported for `test/unit/cli/check-path.test.ts` — needs to construct
 * fake `ResolutionStep` trees directly, not just the CLI command's own
 * output, to pin the `tupleToUserset` name-threading behavior a real check
 * might not exercise on every schema. No behavior change; module-private
 * since this flag was added.
 */
export function renderResolutionPath(step: ResolutionStep, name: string, indent = ''): string[] {
  switch (step.kind) {
    case 'directGrant':
      return [
        `${indent}${entity(step.subject)}`,
        `${indent}  → ${entity(step.object)}#${step.relation}`,
      ];
    case 'usersetMembership': {
      const lines = renderResolutionPath(step.member, step.usersetRelation, indent);
      lines.push(`${indent}  → ${entity(step.object)}#${step.relation}`);
      return lines;
    }
    case 'tupleToUserset': {
      const lines = renderResolutionPath(step.member, step.computedUserset, indent);
      lines.push(`${indent}  → ${entity(step.object)}#${name}`);
      return lines;
    }
    case 'union':
      // Transparent — see this function's own doc comment.
      return renderResolutionPath(step.branch, name, indent);
    case 'intersection': {
      const lines = [`${indent}${entity(step.object)}#${name} — ALL of:`];
      for (const branch of step.branches) {
        lines.push(...renderResolutionPath(branch, name, indent + '  '));
      }
      return lines;
    }
    case 'exclusion': {
      const lines = [`${indent}${entity(step.object)}#${name} — granted, and not excluded:`];
      lines.push(...renderResolutionPath(step.base, name, indent + '  '));
      return lines;
    }
  }
}

const REF_USAGE = "subject and object must both be 'namespace:id' (e.g. 'user:alice')";

export interface CheckCliOptions {
  atToken?: string;
  /** Print the real resolution path (§6.7) an ALLOWED result was reached through — see `renderResolutionPath`'s own doc comment. */
  path?: boolean;
}

/**
 * Runs one check and prints the result. Exit codes follow §7's table as
 * applied elsewhere in this CLI (see `tuple.ts`): 0 the check ran and
 * printed a real answer (allowed *or* denied — denial is information, not
 * an error), 2 a malformed argument (bad subject/object reference, a
 * `--at-token` that doesn't decode — see `src/store/tokens.ts`'s
 * `decodeToken`), 3 an infrastructure failure (DB unreachable,
 * a supplied token this database hasn't observed yet, or the audit-log
 * write itself failing — all three surface as a thrown error from
 * `performCheck`, never a silent `false` and never an answer reported
 * without also being logged).
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
  // Second full-repo audit finding #4 (MEDIUM, 2026-08-22): this argument
  // reached performCheck completely unvalidated before this fix — see
  // ../entity-ref.js's own top-of-file doc comment for the concrete
  // audit-trail-corruption repro this closes.
  if (!isValidIdentifier(relation)) {
    console.error(
      `invalid relation '${relation}' — must be a valid identifier (lowercase snake_case, starts with a letter, ≤${MAX_IDENTIFIER_LENGTH} characters)`,
    );
    process.exitCode = 2;
    return;
  }

  let atToken: number | undefined;
  if (options.atToken !== undefined) {
    // `--at-token` takes the exact opaque string `authz tuple write`/
    // `delete` printed (`src/store/tokens.ts`'s `encodeToken`), not a raw
    // integer — `decodeToken` rejects anything else outright, including
    // blank/whitespace-only input (full-repo audit finding #11, LOW, third
    // audit, 2026-08-17, closed a `Number('')`-coerces-to-`0` hazard for
    // the old numeric form; a malformed opaque string never decodes to a
    // number at all, so that hazard doesn't recur here). Same shape as
    // `src/api/server.ts`'s `/check` route: decode here, fail loudly here,
    // never pass a string through to `performCheck`.
    try {
      atToken = decodeToken(options.atToken);
    } catch (err) {
      console.error(`invalid --at-token — ${(err as Error).message}`);
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
    const result = await performCheck(pool, subject, object, relation, {
      ...(atToken !== undefined ? { atToken } : {}),
    });
    console.log(
      `${subjectRaw} ${relation} ${objectRaw}: ${result.allowed ? 'ALLOWED' : 'DENIED'}` +
        // Echoes the exact opaque string the caller passed, not the
        // decoded integer — nothing about this command should print the
        // internal representation `encodeToken`/`decodeToken` exist to
        // hide (`src/store/tokens.ts`'s own doc comment).
        (options.atToken !== undefined ? ` (at token ${options.atToken})` : ''),
    );
    if (options.path === true) {
      if (result.allowed && result.path) {
        for (const line of renderResolutionPath(result.path, relation)) console.log(line);
      } else {
        // A DENIED result has no positive witness to show — symmetric with
        // `ProductionCheckResult.path` itself being `undefined` here (§6.7:
        // present iff allowed). Stated explicitly rather than printing
        // nothing, so `--path` never looks like it silently did nothing.
        console.log('  (denied — no resolution path; nothing granted this)');
      }
    }
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}
