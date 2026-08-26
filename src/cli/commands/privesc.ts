/**
 * `authz audit privesc <object> <relation> [--expected subj1,subj2,...]` —
 * see `src/audit/privesc.ts`'s own top-of-file doc comment for the full
 * design and the soundness argument this CLI command's own correctness
 * depends on. This file is deliberately thin: argument parsing, calling
 * `privescScan` exactly once, printing, and the `--expected` drift
 * comparison — no reachability logic of its own, mirroring
 * `privescScan`'s own "no new reachability logic" discipline one layer up.
 *
 * **Path rendering reuses `src/cli/commands/check.ts`'s own
 * `renderResolutionPath` unchanged** — that function is already exported
 * (for `check-path.test.ts`'s own direct-construction tests), so this file
 * imports it rather than inventing a second, possibly-diverging path-print
 * format. `authz check ... --path` and `authz audit privesc` render the
 * identical `ResolutionStep` tree identically, byte-for-byte, for the same
 * `(relation, path)` input — verified by inspection, not just assumed: both
 * call sites pass the checked relation/permission name as `renderResolutionPath`'s
 * `name` argument, exactly as `check.ts` itself does.
 *
 * **Argument parsing note (a deliberate deviation worth stating plainly).**
 * `object` and every `--expected` entry are parsed with
 * `parseEntityArg`/`isValidIdentifier` (`src/cli/entity-ref.ts`), not
 * `src/cli/commands/tuple.ts`'s `parseObjectRef`. `entity-ref.ts`'s own
 * top-of-file doc comment states its own purpose exactly: "shared by every
 * CLI command that names a subject/object/relation directly on the command
 * line without routing through `writeTuple`/`deleteTuple` ... today `authz
 * check` and `authz expand`" — this command is a third instance of exactly
 * that same shape (an object/subject reference typed directly on the
 * command line, never touching `writeTuple`/`deleteTuple`), so it gets the
 * same, already-fixed validation (full `IDENTIFIER_PATTERN`/
 * `MAX_IDENTIFIER_LENGTH` checking) `check`/`expand` already have, not
 * `tuple.ts`'s narrower colon-position-only `parseObjectRef` (which predates
 * — and was the reason for — full-repo audit finding #4's fix). Using the
 * narrower, pre-fix parser here for a brand-new command would reintroduce
 * the exact validation gap that finding closed elsewhere.
 */
import { privescScan } from '../../audit/privesc.js';
import { renderResolutionPath } from './check.js';
import { getPool, closePool } from '../../store/client.js';
import { env } from '../../config/env.js';
import { parseEntityArg, isValidIdentifier, type EntityArg } from '../entity-ref.js';
import { MAX_IDENTIFIER_LENGTH } from '../../schema/dsl/types.js';

const REF_USAGE = "object must be 'namespace:id' (e.g. 'document:readme')";
const EXPECTED_USAGE =
  "--expected must be a comma-separated list of 'namespace:id' entries (e.g. 'user:alice,user:bob')";

function entity(e: EntityArg): string {
  return `${e.ns}:${e.id}`;
}

function entityKey(e: EntityArg): string {
  return `${e.ns}:${e.id}`;
}

/**
 * Parses `--expected`'s raw comma-separated value into a list of
 * `EntityArg`s — `undefined` if ANY entry fails to parse as a valid
 * `namespace:id` reference, mirroring `parseEntityArg`'s own "one
 * `undefined` covers every malformed shape" discipline (the caller doesn't
 * need to know which entry was bad, only that the whole list is rejected).
 * Blank entries (an accidental trailing comma, e.g. `'user:alice,'`) are
 * silently skipped rather than treated as an error — the same forgiving
 * treatment a human typing a comma-separated list on a shell would expect,
 * and harmless either way since an empty string could never `parseEntityArg`
 * successfully regardless.
 */
function parseExpectedList(raw: string): EntityArg[] | undefined {
  const parsed: EntityArg[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const ref = parseEntityArg(trimmed);
    if (!ref) return undefined;
    parsed.push(ref);
  }
  return parsed;
}

export interface PrivescCliOptions {
  expected?: string;
}

/**
 * Runs `privescScan` and prints every finding (subject, depth, real
 * resolution path). If `--expected` was supplied, additionally prints
 * `UNEXPECTED: <subject>` for every found subject not on the list and
 * `MISSING: <subject>` for every listed subject not found — and sets
 * `process.exitCode = 1` if there is at least one `UNEXPECTED` finding (a
 * real, blocking security finding: this database currently grants access
 * to someone who was never supposed to have it). `MISSING` findings print
 * but never affect the exit code — an over-cautious allow-list entry that
 * turns out to grant nothing is not, on its own, evidence of anything
 * wrong; per this project's own `false_grant`-vs-`false_deny` asymmetry
 * (§6.5, `docs/DECISIONS.md` D-006, applied here to policy drift rather
 * than resolver correctness), an unexpectedly-present subject is the
 * security-significant direction, an unexpectedly-absent one is not.
 *
 * Exit codes follow this project's own established table
 * (`check.ts`/`expand.ts`): 2 a malformed argument (bad object reference,
 * bad relation, a malformed `--expected` entry) — before ever touching
 * Postgres; 3 an infrastructure failure (DB unreachable); 1 if `--expected`
 * was given and at least one `UNEXPECTED` finding was reported; 0
 * otherwise, including when `--expected` was given and every finding
 * matched (or was merely `MISSING`, never blocking on its own).
 */
export async function privescCli(
  objectRaw: string,
  relation: string,
  options: PrivescCliOptions,
): Promise<void> {
  const object = parseEntityArg(objectRaw);
  if (!object) {
    console.error(`invalid object reference — ${REF_USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (!isValidIdentifier(relation)) {
    console.error(
      `invalid relation '${relation}' — must be a valid identifier (lowercase snake_case, starts with a letter, ≤${MAX_IDENTIFIER_LENGTH} characters)`,
    );
    process.exitCode = 2;
    return;
  }

  let expected: EntityArg[] | undefined;
  if (options.expected !== undefined) {
    expected = parseExpectedList(options.expected);
    if (!expected) {
      console.error(`invalid --expected — ${EXPECTED_USAGE}`);
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
    const findings = await privescScan(pool, object, relation);

    console.log(`${objectRaw}#${relation} — ${findings.length} subject(s) currently have access:`);
    for (const finding of findings) {
      console.log(`  ${entity(finding.subject)} (depth ${finding.depth})`);
      for (const line of renderResolutionPath(finding.path, relation, '    ')) console.log(line);
    }

    if (expected !== undefined) {
      const foundKeys = new Set(findings.map((finding) => entityKey(finding.subject)));
      const expectedKeys = new Set(expected.map((ref) => entityKey(ref)));

      console.log('');
      let hasUnexpected = false;
      for (const finding of findings) {
        if (!expectedKeys.has(entityKey(finding.subject))) {
          console.log(`UNEXPECTED: ${entity(finding.subject)}`);
          hasUnexpected = true;
        }
      }
      for (const ref of expected) {
        if (!foundKeys.has(entityKey(ref))) {
          console.log(`MISSING: ${entity(ref)}`);
        }
      }

      if (hasUnexpected) process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}
