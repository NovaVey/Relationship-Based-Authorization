/**
 * The shared "read a model file, translate it, print `.authz` text with a
 * disclosed-notes header" pipeline — used by both `./cli.ts`
 * (`translate-openfga`) and `../../cli/verify.ts`'s `--from-openfga`
 * sugar, so the two entry points can never disagree on what translating a
 * given file actually produces.
 */
import { readFileSync } from 'node:fs';

import { parseOpenfgaModel } from './parse.js';
import { translateOpenfga } from './translate.js';
import { printSchema } from '../common/dsl-print.js';
import { formatDisclosureHeader, type TranslationNote } from '../common/disclose.js';

export interface TranslateOpenfgaFileOptions {
  readonly bestEffort?: boolean;
}

export type TranslateOpenfgaFileResult =
  | { readonly ok: true; readonly dslText: string; readonly notes: readonly TranslationNote[] }
  | { readonly ok: false; readonly error: string };

export function translateOpenfgaFile(
  path: string,
  options: TranslateOpenfgaFileOptions = {},
): TranslateOpenfgaFileResult {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, error: `could not read model file '${path}': ${(err as Error).message}` };
  }

  const parsed = parseOpenfgaModel(source);
  if (!parsed.ok) {
    return { ok: false, error: `failed to parse OpenFGA model '${path}': ${parsed.error.message}` };
  }

  let translated;
  try {
    translated = translateOpenfga(parsed.model, { bestEffort: options.bestEffort ?? false });
  } catch (err) {
    return {
      ok: false,
      error: `failed to translate OpenFGA model '${path}': ${(err as Error).message}`,
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
    title: `Translated from OpenFGA model '${path}' via tools/schema-verifier's OpenFGA front end (see tools/schema-verifier/src/frontends/openfga/).`,
    notes: translated.notes,
  });
  return { ok: true, dslText: header + dsl, notes: translated.notes };
}
