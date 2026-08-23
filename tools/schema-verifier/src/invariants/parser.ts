/**
 * `parseInvariants` — hand-written, line-oriented parser for the invariant
 * language (build spec §4). Deliberately not a character-level tokenizer
 * like `src/schema/dsl/parser.ts`: every construct in this language is
 * exactly one line, so a line is already the right unit to parse and to
 * blame in an error message.
 *
 * Informal grammar:
 *
 *   file       := invariant+
 *   invariant  := "invariant" IDENT "{" variable+ constraint* goal "}"
 *   variable   := IDENT ":" IDENT
 *   constraint := distinctConstraint | relationConstraint
 *   distinctConstraint := "distinct" "(" IDENT ("," IDENT)+ ")"
 *   relationConstraint := IDENT "(" IDENT ")" "=" IDENT
 *   goal       := "goal" ":" IDENT "(" IDENT "," IDENT ")"
 *
 * Reserved words (never valid as a variable/invariant name): `invariant`,
 * `distinct`, `goal`. Relation and permission names (the `tenant` in
 * `tenant(s) = orgA`, the `view` in `goal: view(s, o)`) are NOT checked
 * against this reserved set or against a real schema here — resolving them
 * is §5's job, once an invariant and a schema graph are walked together.
 *
 * Two identifier vocabularies, deliberately not one:
 *
 *   - A **schema name** — an invariant's own name (§11 needs it as a
 *     stable, citable ID), and every relation/permission/type name that
 *     will eventually be resolved against a real compiled schema in §5 —
 *     reuses this project's own `IDENTIFIER_PATTERN` (lowercase,
 *     `snake_case`) exactly, the same convention every real namespace,
 *     relation, and permission name in this repo already follows.
 *   - A **variable name** — local to one invariant, never resolved
 *     against anything, purely a label a witness gets bound to — allows
 *     the mixed-case style §4's own worked example uses verbatim
 *     (`orgA`, `orgB`). Constraining these to the schema convention too
 *     would reject the build spec's own literal text.
 */
import { IDENTIFIER_PATTERN, MAX_IDENTIFIER_LENGTH } from '../../../../src/schema/dsl/types.js';
import type {
  Constraint,
  Goal,
  Invariant,
  InvariantError,
  ParseInvariantsResult,
  TypedVariable,
} from './types.js';

const RESERVED_WORDS = new Set(['invariant', 'distinct', 'goal']);

// `IDENTIFIER_PATTERN` is anchored (`^...$`) for whole-string validation;
// composing it into these line-level regexes via its `.source` (unanchored)
// keeps one single source of truth for what a *schema* identifier looks
// like, instead of a second hand-copied character class silently drifting
// from the schema DSL's own (see D-114 on why that drift risk is worth
// avoiding).
const SCHEMA_ID = IDENTIFIER_PATTERN.source.slice(1, -1); // strip the anchors
const VAR_ID = '[A-Za-z][A-Za-z0-9_]*';
const VARIABLE_PATTERN = new RegExp(`^${VAR_ID}$`);
const BLOCK_START = new RegExp(`^invariant\\s+(${SCHEMA_ID})\\s*\\{$`);
const BLOCK_END = /^\}$/;
const GOAL_LINE = new RegExp(
  `^goal\\s*:\\s*(${SCHEMA_ID})\\(\\s*(${VAR_ID})\\s*,\\s*(${VAR_ID})\\s*\\)$`,
);
const DISTINCT_LINE = /^distinct\(([^)]*)\)$/;
const RELATION_EQUALS_LINE = new RegExp(`^(${SCHEMA_ID})\\((${VAR_ID})\\)\\s*=\\s*(${VAR_ID})$`);
const VARIABLE_LINE = new RegExp(`^(${VAR_ID})\\s*:\\s*(${SCHEMA_ID})$`);

interface Line {
  readonly text: string;
  readonly number: number;
}

/** Strips `//` comments and surrounding whitespace, keeping real line numbers for error reporting even though blank/comment-only lines are dropped from the result. */
function tokenizeLines(source: string): Line[] {
  const lines: Line[] = [];
  const raw = source.split('\n');
  for (let i = 0; i < raw.length; i++) {
    const withoutComment = raw[i]!.split('//')[0]!;
    const text = withoutComment.trim();
    if (text.length > 0) {
      lines.push({ text, number: i + 1 });
    }
  }
  return lines;
}

function checkIdentifier(name: string, line: number, what: string, errors: InvariantError[]): void {
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    errors.push({
      line,
      message: `${what} '${name}' is longer than the ${MAX_IDENTIFIER_LENGTH}-character identifier limit`,
    });
  }
  if (RESERVED_WORDS.has(name)) {
    errors.push({
      line,
      message: `${what} '${name}' is a reserved word (invariant/distinct/goal)`,
    });
  }
}

/** Parses every `invariant { ... }` block in `source`. Never partially returns — a malformed file returns every error found, not just the first. */
export function parseInvariants(source: string): ParseInvariantsResult {
  const lines = tokenizeLines(source);
  const errors: InvariantError[] = [];
  const invariants: Invariant[] = [];
  const seenNames = new Map<string, number>();

  let i = 0;
  while (i < lines.length) {
    const startLine = lines[i]!;
    const startMatch = BLOCK_START.exec(startLine.text);
    if (!startMatch) {
      errors.push({
        line: startLine.number,
        message: `expected 'invariant <name> {' to start a new invariant, found '${startLine.text}'`,
      });
      i++;
      continue;
    }
    const name = startMatch[1]!;
    checkIdentifier(name, startLine.number, 'invariant name', errors);
    const priorLine = seenNames.get(name);
    if (priorLine !== undefined) {
      errors.push({
        line: startLine.number,
        message: `duplicate invariant name '${name}', first declared at line ${priorLine}`,
      });
    } else {
      seenNames.set(name, startLine.number);
    }
    i++;

    const variables: TypedVariable[] = [];
    const declared = new Map<string, number>();
    const constraints: Constraint[] = [];
    let goal: Goal | undefined;
    let blockClosed = false;

    while (i < lines.length) {
      const line = lines[i]!;
      if (BLOCK_END.test(line.text)) {
        blockClosed = true;
        i++;
        break;
      }

      const goalMatch = GOAL_LINE.exec(line.text);
      if (goalMatch) {
        if (goal !== undefined) {
          errors.push({
            line: line.number,
            message: `invariant '${name}' has more than one goal line`,
          });
        }
        const [, permission, subject, object] = goalMatch as unknown as [
          string,
          string,
          string,
          string,
        ];
        checkIdentifier(permission, line.number, 'permission', errors);
        for (const v of [subject, object]) {
          if (!declared.has(v)) {
            errors.push({
              line: line.number,
              message: `goal references undeclared variable '${v}' (invariant '${name}')`,
            });
          }
        }
        goal = { permission, subject, object };
        i++;
        continue;
      }

      const distinctMatch = DISTINCT_LINE.exec(line.text);
      if (distinctMatch) {
        const rawVars = distinctMatch[1]!.split(',').map((s) => s.trim());
        if (rawVars.length < 2 || rawVars.some((v) => v.length === 0)) {
          errors.push({
            line: line.number,
            message: `distinct(...) needs at least 2 comma-separated variables, found '${line.text}'`,
          });
        } else {
          const seenInThisCall = new Set<string>();
          for (const v of rawVars) {
            if (!VARIABLE_PATTERN.test(v)) {
              errors.push({
                line: line.number,
                message: `distinct(...) contains an invalid identifier '${v}'`,
              });
              continue;
            }
            if (!declared.has(v)) {
              errors.push({
                line: line.number,
                message: `distinct(...) references undeclared variable '${v}' (invariant '${name}')`,
              });
            }
            if (seenInThisCall.has(v)) {
              errors.push({
                line: line.number,
                message: `distinct(...) lists '${v}' more than once`,
              });
            }
            seenInThisCall.add(v);
          }
        }
        constraints.push({ kind: 'distinct', variables: rawVars });
        i++;
        continue;
      }

      const relationMatch = RELATION_EQUALS_LINE.exec(line.text);
      if (relationMatch) {
        const [, relation, subject, value] = relationMatch as unknown as [
          string,
          string,
          string,
          string,
        ];
        checkIdentifier(relation, line.number, 'relation', errors);
        for (const v of [subject, value]) {
          if (!declared.has(v)) {
            errors.push({
              line: line.number,
              message: `'${relation}(...)' references undeclared variable '${v}' (invariant '${name}')`,
            });
          }
        }
        constraints.push({ kind: 'relationEquals', relation, subject, value });
        i++;
        continue;
      }

      const variableMatch = VARIABLE_LINE.exec(line.text);
      if (variableMatch) {
        const [, varName, varType] = variableMatch as unknown as [string, string, string];
        if (constraints.length > 0 || goal !== undefined) {
          errors.push({
            line: line.number,
            message: `variable '${varName}' declared after a constraint or goal — all variables must come first (invariant '${name}')`,
          });
        }
        checkIdentifier(varName, line.number, 'variable', errors);
        checkIdentifier(varType, line.number, 'type', errors);
        const priorVarLine = declared.get(varName);
        if (priorVarLine !== undefined) {
          errors.push({
            line: line.number,
            message: `duplicate variable '${varName}', first declared at line ${priorVarLine} (invariant '${name}')`,
          });
        } else {
          declared.set(varName, line.number);
          variables.push({ name: varName, type: varType });
        }
        i++;
        continue;
      }

      if (BLOCK_START.test(line.text)) {
        // A new `invariant ... {` before this one's `}` — don't swallow it
        // into this block's error cascade. Leave `i` where it is so the
        // outer loop reprocesses this line as its own block; this block
        // just reports its own missing '}' below and stops there.
        break;
      }

      errors.push({
        line: line.number,
        message: `unrecognized line inside invariant '${name}': '${line.text}'`,
      });
      i++;
    }

    if (!blockClosed) {
      errors.push({
        line: startLine.number,
        message: `invariant '${name}' is missing its closing '}'`,
      });
    }
    if (variables.length === 0) {
      errors.push({ line: startLine.number, message: `invariant '${name}' declares no variables` });
    }
    if (goal === undefined) {
      errors.push({ line: startLine.number, message: `invariant '${name}' has no 'goal:' line` });
    }

    if (goal !== undefined) {
      invariants.push({ name, variables, constraints, goal });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, invariants };
}
