/**
 * `runVerify` — the whole `verify-schema <schema-file> --invariants
 * <file> [--bound k] [--json]` pipeline (build spec §9), independent of
 * Commander so `src/cli/index.ts` stays a thin argument-parsing shell
 * and this function stays directly unit-testable. Reads both files,
 * compiles the schema, parses every invariant the `--invariants` file
 * names (a file may hold more than one — see `src/invariants/parser.ts`
 * — every one of them is checked, not just the first), runs
 * `checkAndValidate` (§6/§7's fragment-aware entry point) on each, and
 * combines their exit codes (`exitCodes.ts`'s own worst-wins ordering)
 * into the single code the process exits with.
 *
 * Every failure that isn't a verifier *result* — a missing file, a
 * schema or invariant that fails to compile/parse, an unexpected
 * exception thrown by the check engine itself — is exit code `3`, per
 * §9's own table ("CI needs to distinguish 'your schema is unsafe' from
 * 'the verifier crashed'"). This function never throws; every failure
 * path returns `{ exitCode: 3, ... }` with a message already written to
 * `stderr`, so `index.ts`'s own `.action()` handler never needs its own
 * `catch`.
 *
 * `fromOpenfga`/`fromSpicedb` are sugar over "translate, then verify the
 * translated DSL text" — exactly one of `schemaFile`, `fromOpenfga`, or
 * `fromSpicedb` must be given (checked first, exit `3` otherwise, the
 * same "usage problem, not a verifier result" bucket a missing file
 * lands in). Either translation path's own disclosed notes (each front
 * end's own translate.ts, under `../frontends/`) are always written to
 * `stderr` before the verification result itself — a caller piping only
 * stdout (`--json` or the human report) never silently loses them.
 */
import { readFileSync } from 'node:fs';

import { compileSchema } from '../../../../src/schema/dsl/compiler.js';
import { buildSchemaGraph } from '../ir/index.js';
import { parseInvariants } from '../invariants/index.js';
import { checkAndValidate } from '../validate/index.js';
import { translateOpenfgaFile } from '../frontends/openfga/translate-file.js';
import { translateSpicedbFile } from '../frontends/spicedb/translate-file.js';
import { combineExitCodes, invariantExitCode, type InvariantExitCode } from './exitCodes.js';
import { formatHuman, toJsonReport, type InvariantVerification } from './format.js';

export interface RunVerifyOptions {
  /** Exactly one of `schemaFile`, `fromOpenfga`, `fromSpicedb` must be set. */
  readonly schemaFile?: string;
  /** Path to an OpenFGA `.fga`/JSON model file — translated in-memory before verification (`../frontends/openfga/`). */
  readonly fromOpenfga?: string;
  /** Reserved for the SpiceDB front end — not yet built. */
  readonly fromSpicedb?: string;
  /** Only meaningful alongside `fromOpenfga`/`fromSpicedb` — see that front end's own `TranslateOptions.bestEffort` doc comment. */
  readonly bestEffort?: boolean;
  readonly invariantsFile: string;
  readonly bound?: number;
  readonly json: boolean;
  /** Defaults to real `console.log`/`console.error` — overridable so tests can capture output without spawning a subprocess. */
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

export interface RunVerifyResult {
  readonly exitCode: InvariantExitCode;
}

function readFileOrThrow(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${label} '${path}': ${(err as Error).message}`, { cause: err });
  }
}

export async function runVerify(options: RunVerifyOptions): Promise<RunVerifyResult> {
  const log = options.stdout ?? ((line: string) => console.log(line));
  const err = options.stderr ?? ((line: string) => console.error(line));

  const sourcesGiven = [options.schemaFile, options.fromOpenfga, options.fromSpicedb].filter(
    (s) => s !== undefined,
  );
  if (sourcesGiven.length !== 1) {
    err(
      sourcesGiven.length === 0
        ? 'no schema source given — pass a schema file, or exactly one of --from-openfga/--from-spicedb'
        : 'more than one schema source given — pass a schema file, or exactly one of --from-openfga/--from-spicedb, never several at once',
    );
    return { exitCode: 3 };
  }

  let schemaSource: string;
  let schemaLabel: string;
  if (options.fromOpenfga !== undefined) {
    schemaLabel = options.fromOpenfga;
    const translated = translateOpenfgaFile(options.fromOpenfga, {
      bestEffort: options.bestEffort ?? false,
    });
    if (!translated.ok) {
      err(translated.error);
      return { exitCode: 3 };
    }
    for (const note of translated.notes) err(`translate-openfga: ${note.detail}`);
    schemaSource = translated.dslText;
  } else if (options.fromSpicedb !== undefined) {
    schemaLabel = options.fromSpicedb;
    const translated = translateSpicedbFile(options.fromSpicedb, {
      bestEffort: options.bestEffort ?? false,
    });
    if (!translated.ok) {
      err(translated.error);
      return { exitCode: 3 };
    }
    for (const note of translated.notes) err(`translate-spicedb: ${note.detail}`);
    schemaSource = translated.dslText;
  } else {
    schemaLabel = options.schemaFile!;
    try {
      schemaSource = readFileOrThrow(options.schemaFile!, 'schema file');
    } catch (e) {
      err((e as Error).message);
      return { exitCode: 3 };
    }
  }

  let invariantsSource: string;
  try {
    invariantsSource = readFileOrThrow(options.invariantsFile, 'invariants file');
  } catch (e) {
    err((e as Error).message);
    return { exitCode: 3 };
  }

  const compiled = compileSchema(schemaSource);
  if (!compiled.ok) {
    err(
      `schema '${schemaLabel}' failed to compile:\n` +
        compiled.errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n'),
    );
    return { exitCode: 3 };
  }

  const parsedInvariants = parseInvariants(invariantsSource);
  if (!parsedInvariants.ok) {
    err(
      `invariants file '${options.invariantsFile}' failed to parse:\n` +
        parsedInvariants.errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n'),
    );
    return { exitCode: 3 };
  }
  if (parsedInvariants.invariants.length === 0) {
    err(`invariants file '${options.invariantsFile}' declares no invariants`);
    return { exitCode: 3 };
  }

  let graph;
  try {
    graph = buildSchemaGraph(compiled.schema);
  } catch (e) {
    err(`failed to build the schema graph: ${(e as Error).message}`);
    return { exitCode: 3 };
  }

  const verifications: InvariantVerification[] = [];
  try {
    for (const invariant of parsedInvariants.invariants) {
      const checkOptions = options.bound !== undefined ? { bound: options.bound } : undefined;
      const { result, validation } = await checkAndValidate(
        graph,
        compiled.schema,
        invariant,
        checkOptions,
      );
      verifications.push({
        name: invariant.name,
        result,
        validation,
        exitCode: invariantExitCode(result, validation),
      });
    }
  } catch (e) {
    err(`the verifier itself threw while checking: ${(e as Error).message}`);
    return { exitCode: 3 };
  }

  const exitCode = combineExitCodes(verifications.map((v) => v.exitCode));

  if (options.json) {
    log(JSON.stringify(toJsonReport(schemaLabel, verifications, exitCode), null, 2));
  } else {
    log(formatHuman(schemaLabel, verifications));
  }

  return { exitCode };
}
