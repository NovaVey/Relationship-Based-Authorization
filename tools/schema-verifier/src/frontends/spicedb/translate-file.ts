/**
 * The shared "read a `.zed` file, translate it, print `.authz` text with
 * a disclosed-notes header" pipeline — used by both `./cli.ts`
 * (`translate-spicedb`) and `../../cli/verify.ts`'s `--from-spicedb`
 * sugar, mirroring the OpenFGA front end's own `translate-file.ts`
 * exactly, so the two entry points can never disagree on what
 * translating a given file actually produces.
 */
import { readFileSync } from 'node:fs';

import { parseSpicedbSchema } from './parser.js';
import { translateSpicedb } from './translate.js';
import { printSchema } from '../common/dsl-print.js';
import { formatDisclosureHeader, type TranslationNote } from '../common/disclose.js';

export interface TranslateSpicedbFileOptions {
  readonly bestEffort?: boolean;
}

export type TranslateSpicedbFileResult =
  | { readonly ok: true; readonly dslText: string; readonly notes: readonly TranslationNote[] }
  | { readonly ok: false; readonly error: string };

export function translateSpicedbFile(
  path: string,
  options: TranslateSpicedbFileOptions = {},
): TranslateSpicedbFileResult {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, error: `could not read schema file '${path}': ${(err as Error).message}` };
  }

  const parsed = parseSpicedbSchema(source);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `failed to parse SpiceDB schema '${path}': line ${parsed.error.line}: ${parsed.error.message}`,
    };
  }

  let translated;
  try {
    translated = translateSpicedb(parsed.definitions, { bestEffort: options.bestEffort ?? false });
  } catch (err) {
    return {
      ok: false,
      error: `failed to translate SpiceDB schema '${path}': ${(err as Error).message}`,
    };
  }

  let dsl: string;
  try {
    dsl = printSchema(translated.schema);
  } catch (err) {
    return {
      ok: false,
      error: `failed to print the translated schema for '${path}': ${(err as Error).message}`,
    };
  }

  const header = formatDisclosureHeader({
    title: `Translated from SpiceDB schema '${path}' via tools/schema-verifier's SpiceDB front end (see tools/schema-verifier/src/frontends/spicedb/).`,
    notes: translated.notes,
  });
  return { ok: true, dslText: header + dsl, notes: translated.notes };
}
