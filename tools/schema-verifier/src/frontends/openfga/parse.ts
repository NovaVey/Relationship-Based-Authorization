/**
 * Reads an OpenFGA model — either `.fga` DSL text (the format every real
 * `openfga/sample-stores` file, and everything a human actually writes, is
 * in) or the JSON `AuthorizationModel` shape the OpenFGA API itself
 * accepts — into one common `AuthorizationModel` object `translate.ts`
 * consumes. Reuses OpenFGA's own published `@openfga/syntax-transformer`
 * package for the DSL case (the same package `tools/rebac-benchmark/src/
 * adapters/openfga-adapter.ts` already uses to load `.fga` workloads into
 * a real OpenFGA server) — this file writes no OpenFGA grammar of its own,
 * matching this tool's own established "import the parser, don't
 * reimplement it" discipline (`tsconfig.json`'s own comment) one ecosystem
 * further out.
 */
import { transformer } from '@openfga/syntax-transformer';
import type { AuthorizationModel } from '@openfga/sdk';

export interface OpenfgaParseError {
  readonly message: string;
}

export type OpenfgaParseResult =
  | { readonly ok: true; readonly model: Omit<AuthorizationModel, 'id'> }
  | { readonly ok: false; readonly error: OpenfgaParseError };

/**
 * A real OpenFGA JSON model always parses as a JSON object whose top level
 * carries `type_definitions` (an array) — `.fga` DSL text never does (it
 * isn't even valid JSON in practice, since it has no quoting at all), so
 * a plain `JSON.parse` attempt followed by this one shape check cleanly
 * distinguishes the two accepted input forms without needing a
 * `--format` flag.
 */
function looksLikeJsonModel(value: unknown): value is Omit<AuthorizationModel, 'id'> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { type_definitions?: unknown }).type_definitions)
  );
}

export function parseOpenfgaModel(source: string): OpenfgaParseResult {
  try {
    const parsedJson: unknown = JSON.parse(source);
    if (looksLikeJsonModel(parsedJson)) {
      return { ok: true, model: parsedJson };
    }
    return {
      ok: false,
      error: {
        message:
          'input parses as JSON but is not an OpenFGA authorization model (no type_definitions array)',
      },
    };
  } catch {
    // Not JSON at all — fall through to the DSL transformer below, the
    // expected path for every real `.fga` file.
  }

  try {
    const model = transformer.transformDSLToJSONObject(source);
    return { ok: true, model };
  } catch (err) {
    return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
  }
}
