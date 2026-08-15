/**
 * Structured errors for the schema DSL parser and compiler. Every rejection
 * this package produces is one of these — never a generic "invalid schema"
 * string. See `.claude/commands/build-authz-service.md` §9 Phase 1's exit
 * criteria: "a malformed schema is rejected with an error naming the exact
 * line/construct."
 */
import type { CompiledSchema } from './types.js';

export type SchemaErrorCode =
  // Syntax-level (parser.ts) — always exactly one error, parsing stops at
  // the first one; a hand-rolled recursive-descent parser has no safe error
  // recovery strategy worth building for a DSL this small.
  | 'empty_source'
  | 'no_namespaces_declared'
  | 'unexpected_token'
  | 'unterminated_namespace'
  | 'missing_namespace_name'
  | 'empty_namespace_body'
  | 'invalid_identifier'
  // Semantic-level (compiler.ts) — collected across the whole compilation
  // unit; every issue the compiler can find is reported in one pass rather
  // than one-at-a-time.
  | 'duplicate_namespace'
  | 'duplicate_member_name'
  | 'undeclared_reference'
  | 'circular_permission_definition'
  | 'tuple_to_userset_target_not_a_relation'
  | 'tuple_to_userset_unknown_namespace'
  | 'tuple_to_userset_unknown_target'
  | 'subject_type_targets_a_permission';

/**
 * A single structured rejection. `message` is a complete, human-readable
 * sentence naming the exact construct and its location (matches the style
 * of `.claude/commands/build-authz-service.md` §9 Phase 1's own example:
 * "line 4: `permission` `edit` references undeclared relation `admin`").
 * `line`, `namespace`, and `member` are the same information broken out for
 * programmatic use (a test asserting on the exact line number, a CLI
 * highlighting the offending construct) without parsing `message` back
 * apart.
 */
export interface SchemaError {
  code: SchemaErrorCode;
  message: string;
  line: number;
  /** The namespace the error occurred in, when one was known. */
  namespace?: string;
  /** The relation/permission name the error is about, when applicable. */
  member?: string;
}

export type SchemaCompileResult =
  | { ok: true; schema: CompiledSchema }
  | { ok: false; errors: SchemaError[] };

/**
 * Thrown internally by the lexer/parser to unwind to `parseSchema`'s single
 * catch site — never allowed to escape `parser.ts`. Compiler-level
 * (semantic) validation never throws this; it pushes onto a shared
 * `SchemaError[]` and keeps going, so a caller sees every issue at once.
 */
export class SchemaParseError extends Error {
  readonly schemaError: SchemaError;

  constructor(schemaError: SchemaError) {
    super(schemaError.message);
    this.name = 'SchemaParseError';
    this.schemaError = schemaError;
  }
}

/** Builds a `namespace?`-qualified `SchemaError` without ever assigning a literal `undefined`. */
export function makeSchemaError(
  code: SchemaErrorCode,
  message: string,
  line: number,
  options?: { namespace?: string; member?: string },
): SchemaError {
  return {
    code,
    message,
    line,
    ...(options?.namespace !== undefined ? { namespace: options.namespace } : {}),
    ...(options?.member !== undefined ? { member: options.member } : {}),
  };
}

/** One-line, CLI-friendly rendering of a `SchemaError` — `line N: message`. */
export function formatSchemaError(error: SchemaError): string {
  return `line ${error.line}: ${error.message}`;
}
