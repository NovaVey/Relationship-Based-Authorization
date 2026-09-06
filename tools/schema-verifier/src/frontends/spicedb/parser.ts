/**
 * Lexer + recursive-descent parser for SpiceDB's own schema language
 * (`.zed`) — a light fork of `src/schema/dsl/parser.ts`'s own shape (same
 * module-doc discipline: pure, zero I/O, knows only grammar, never
 * validates whether a referenced name was actually declared — that's
 * `./translate.ts`'s job, once every definition's shape is known), not a
 * full grammar. Scoped to exactly what real SpiceDB schemas use — see
 * `docs/DECISIONS.md`'s own front-end entry for the seven real upstream
 * schemas this was built and checked against before writing a line of
 * `./translate.ts`.
 *
 * Grammar (informally), confirmed against SpiceDB's own real published
 * schema-language reference
 * (https://raw.githubusercontent.com/authzed/docs/main/app/spicedb/concepts/schema/page.mdx,
 * fetched verbatim into `thirdparty/upstream/spicedb-googledocs-typecheck-bug.mdx`)
 * and seven real upstream schemas, not assumed from memory:
 *
 *   schema        := (directive | definition)*
 *   directive     := "use" IDENT                        -- e.g. `use typechecking`; parsed and discarded, see below
 *   definition    := "definition" IDENT "{" member* "}"
 *   member        := relation | permission
 *   relation      := "relation" IDENT ":" subjectType ("|" subjectType)*
 *   subjectType   := IDENT ("#" IDENT | ":" "*")?
 *   permission    := "permission" IDENT (":" subjectType ("|" subjectType)*)? "=" expression
 *   expression    := term (("&" | "-") term)*        -- intersection / exclusion, equal precedence, left-assoc (the LOOSER tier)
 *   term          := atom ("+" atom)*                -- union, the TIGHTER tier
 *   atom          := "(" expression ")" | "self" | IDENT ("->" IDENT)?
 *
 * **The one genuinely surprising, easy-to-get-wrong difference from this
 * project's own DSL: SpiceDB's operator precedence is inverted.** This
 * DSL gives `&` (intersection) the tighter binding and `|`/`-` (union/
 * exclusion) the shared looser tier (`src/schema/dsl/parser.ts`'s own
 * grammar comment). SpiceDB's own schema-language reference states the
 * opposite plainly, and calls it out as a known wart: "For historical
 * reasons, union (`+`) takes precedence over intersection (`&`) and
 * exclusion (`-`) ... `a + b & c` is evaluated as `(a + b) & c`, not
 * `a + (b & c)`." Confirmed against a real fixture, not just the docs'
 * own prose: `spicedb-userdefined-roles`'s own
 * `(project->assigned_issue_resolver & assigned) + project->any_issue_resolver`
 * needs its explicit parens preserved around the intersection precisely
 * because `+` would otherwise bind tighter and regroup it wrong. Getting
 * this right here (the parser builds the *correct* tree, respecting
 * SpiceDB's own precedence) is what lets `../common/dsl-print.ts`'s own
 * parenthesization (built for *this* DSL's own, opposite-tiered grammar)
 * print it back out correctly with no special-casing anywhere — a
 * translate-time bug in precedence would otherwise silently change what a
 * translated schema means. See `test/frontends/spicedb-parser.test.ts`'s
 * own dedicated round-trip case for this exact inversion.
 *
 * **`use IDENT` (e.g. `use typechecking`) and a permission's own optional
 * `: TYPE | TYPE...` result-type annotation are both recognized and
 * discarded, never acted on.** Neither has any effect on what a schema
 * actually *computes* — `use typechecking` and permission type
 * annotations are a static linter feature checked at SpiceDB's own
 * `WriteSchema` time, not part of the runtime semantics a translated
 * schema needs to preserve — so parsing past them losslessly, rather than
 * refusing the whole schema, costs nothing and widens real-world
 * compatibility for free. None of this survey's own seven real fixtures
 * use either feature (confirmed directly, not assumed) — this is
 * forward-compatibility, not something the regression corpus exercises.
 *
 * **`self` cannot be discarded the same way — it's a real semantic
 * construct with no equivalent in this DSL's own rewrite-rule vocabulary**
 * (`thirdparty/README.md`'s own disclosed-gap list already names it: "no
 * equivalent here"). Parsed into its own distinct AST node
 * (`{ kind: 'self' }`, never conflated with `IrRewrite` — that neutral,
 * ecosystem-shared type has no `self` concept at all) so `./translate.ts`
 * can decide what to do with it (refuse by default, drop-and-disclose
 * under `--best-effort` — see that file's own doc comment).
 */
/**
 * `MAX_EXPRESSION_NESTING_DEPTH` and `MAX_IDENTIFIER_LENGTH` are reused
 * from the real DSL's own `types.ts` for an early, clear parse-time error
 * on a pathological input — but unlike `IDENTIFIER_PATTERN`/its own
 * reserved-word list, this file deliberately does *not* duplicate full
 * identifier-legality validation: every identifier this parser accepts
 * still passes through the real, unmodified `compileSchema` once printed
 * (`../common/dsl-print.ts` → `translate-file.ts`), which already
 * enforces all of that — the same "don't re-validate what the real
 * compiler already will" precedent the OpenFGA front end's own
 * `translate.ts` established first.
 */
import {
  MAX_EXPRESSION_NESTING_DEPTH,
  MAX_IDENTIFIER_LENGTH,
} from '../../../../../src/schema/dsl/types.js';

// ---------------------------------------------------------------------------
// Parse-time AST
// ---------------------------------------------------------------------------

export interface ParsedSubjectType {
  namespace: string;
  relation?: string;
  wildcard?: boolean;
  line: number;
}

export interface ParsedRelation {
  kind: 'relation';
  name: string;
  subjectTypes: ParsedSubjectType[];
  line: number;
}

export type ParsedRewrite =
  | { kind: 'ref'; name: string; line: number }
  | { kind: 'self'; line: number }
  | { kind: 'union'; children: ParsedRewrite[]; line: number }
  | { kind: 'intersection'; children: ParsedRewrite[]; line: number }
  | { kind: 'exclusion'; base: ParsedRewrite; subtract: ParsedRewrite; line: number }
  | { kind: 'tupleToUserset'; relation: string; computedUserset: string; line: number };

export interface ParsedPermission {
  kind: 'permission';
  name: string;
  rewrite: ParsedRewrite;
  line: number;
}

export type ParsedMember = ParsedRelation | ParsedPermission;

export interface ParsedDefinition {
  name: string;
  members: ParsedMember[];
  line: number;
}

export interface SpicedbParseError {
  message: string;
  line: number;
}

export type SpicedbParseResult =
  { ok: true; definitions: ParsedDefinition[] } | { ok: false; error: SpicedbParseError };

class SpicedbParseFailure extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenType =
  | 'word'
  | 'lbrace'
  | 'rbrace'
  | 'lparen'
  | 'rparen'
  | 'colon'
  | 'equals'
  | 'plus'
  | 'amp'
  | 'minus'
  | 'arrow'
  | 'hash'
  | 'star'
  | 'eof';

interface Token {
  type: TokenType;
  value: string;
  line: number;
}

const WORD_CHAR = /[A-Za-z0-9_]/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;

  const advance = (count = 1): void => {
    for (let n = 0; n < count; n++) {
      if (source[i] === '\n') line += 1;
      i += 1;
    }
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance();
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    // Block comments (`/** ... */` doc comments are the common real-world
    // shape — see e.g. spicedb-ai-agents.zed — but a plain `/* ... */`
    // works identically; this DSL's own `//`-only lexer has no equivalent,
    // since every real `.authz` file in this repo only ever uses `//`).
    // Non-nesting, matching every real usage seen — `*/` always closes
    // the nearest `/*`, never a false match inside stray text, since none
    // of the real fixtures put a literal `*/` inside a comment's own body.
    if (ch === '/' && source[i + 1] === '*') {
      const startLine = line;
      advance(2);
      let closed = false;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          advance(2);
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        throw new SpicedbParseFailure(
          `unterminated block comment starting at line ${startLine}`,
          startLine,
        );
      }
      continue;
    }

    const startLine = line;

    if (ch !== undefined && WORD_CHAR.test(ch)) {
      let value = '';
      while (i < source.length) {
        const c = source[i];
        if (c === undefined || !WORD_CHAR.test(c)) break;
        value += c;
        advance();
      }
      tokens.push({ type: 'word', value, line: startLine });
      continue;
    }

    const single = (type: TokenType, value: string, len = 1): void => {
      tokens.push({ type, value, line: startLine });
      advance(len);
    };

    switch (ch) {
      case '{':
        single('lbrace', '{');
        continue;
      case '}':
        single('rbrace', '}');
        continue;
      case '(':
        single('lparen', '(');
        continue;
      case ')':
        single('rparen', ')');
        continue;
      case ':':
        single('colon', ':');
        continue;
      case '=':
        single('equals', '=');
        continue;
      case '+':
        single('plus', '+');
        continue;
      case '&':
        single('amp', '&');
        continue;
      case '#':
        single('hash', '#');
        continue;
      case '*':
        single('star', '*');
        continue;
      case '|':
        // Only ever valid inside a subject-type list (`parseSubjectTypeList`)
        // — reuses the same token type/value shape as this project's own
        // DSL for that context, since SpiceDB's own subject-type-list
        // separator already IS `|` (confirmed directly: `relation owner:
        // user | organization`, spicedb-superuser.zed) — no remapping
        // needed there, unlike the rewrite-expression operators.
        single('word', '|'); // handled specially in parseSubjectTypeList below
        continue;
      case '-':
        if (source[i + 1] === '>') {
          single('arrow', '->', 2);
        } else {
          single('minus', '-');
        }
        continue;
      default:
        throw new SpicedbParseFailure(
          `unexpected character '${ch}' at line ${startLine}`,
          startLine,
        );
    }
  }

  tokens.push({ type: 'eof', value: '', line });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface ParserState {
  tokens: Token[];
  pos: number;
  /** Mirrors `src/schema/dsl/parser.ts`'s own `ParserState.nestingDepth` — same DoS reasoning, same ceiling, applied to this front end's own recursive-descent parsing of third-party input. */
  nestingDepth: number;
}

function peek(state: ParserState): Token {
  return state.tokens[state.pos]!;
}

function consume(state: ParserState): Token {
  const token = peek(state);
  if (token.type !== 'eof') state.pos += 1;
  return token;
}

function describeToken(token: Token): string {
  return token.type === 'eof' ? 'end of input' : `'${token.value}'`;
}

function expectKeyword(state: ParserState, keyword: string): Token {
  const token = peek(state);
  if (token.type !== 'word' || token.value !== keyword) {
    throw new SpicedbParseFailure(
      `expected keyword '${keyword}' at line ${token.line}, found ${describeToken(token)}`,
      token.line,
    );
  }
  return consume(state);
}

function expectWord(state: ParserState, context: string): Token {
  const token = peek(state);
  if (token.type !== 'word' || token.value === '|') {
    throw new SpicedbParseFailure(
      `expected ${context} at line ${token.line}, found ${describeToken(token)}`,
      token.line,
    );
  }
  return consume(state);
}

function expectPunct(state: ParserState, type: TokenType, display: string): Token {
  const token = peek(state);
  if (token.type !== type) {
    throw new SpicedbParseFailure(
      `expected '${display}' at line ${token.line}, found ${describeToken(token)}`,
      token.line,
    );
  }
  return consume(state);
}

function isPipe(token: Token): boolean {
  return token.type === 'word' && token.value === '|';
}

function validateIdentifier(token: Token, context: string): void {
  if (token.value.length > MAX_IDENTIFIER_LENGTH) {
    throw new SpicedbParseFailure(
      `invalid ${context} '${token.value}' at line ${token.line}: identifiers may be at most ${MAX_IDENTIFIER_LENGTH} characters`,
      token.line,
    );
  }
}

function parseSubjectType(state: ParserState): ParsedSubjectType {
  const nsToken = expectWord(state, 'subject type');
  validateIdentifier(nsToken, 'subject type namespace');
  if (peek(state).type === 'colon') {
    consume(state);
    expectPunct(state, 'star', '*');
    return { namespace: nsToken.value, wildcard: true, line: nsToken.line };
  }
  if (peek(state).type === 'hash') {
    consume(state);
    const relToken = expectWord(state, "subject type relation (after '#')");
    validateIdentifier(relToken, 'subject type relation');
    return { namespace: nsToken.value, relation: relToken.value, line: nsToken.line };
  }
  return { namespace: nsToken.value, line: nsToken.line };
}

function parseSubjectTypeList(state: ParserState): ParsedSubjectType[] {
  const list = [parseSubjectType(state)];
  while (isPipe(peek(state))) {
    consume(state);
    list.push(parseSubjectType(state));
  }
  return list;
}

function parseRelation(state: ParserState): ParsedRelation {
  const keyword = expectKeyword(state, 'relation');
  const nameToken = expectWord(state, 'relation name');
  validateIdentifier(nameToken, 'relation name');
  expectPunct(state, 'colon', ':');
  const subjectTypes = parseSubjectTypeList(state);
  return { kind: 'relation', name: nameToken.value, subjectTypes, line: keyword.line };
}

function parseAtom(state: ParserState): ParsedRewrite {
  if (peek(state).type === 'lparen') {
    const openToken = consume(state);
    state.nestingDepth += 1;
    if (state.nestingDepth > MAX_EXPRESSION_NESTING_DEPTH) {
      throw new SpicedbParseFailure(
        `permission expression at line ${openToken.line} nests '(' more than ${MAX_EXPRESSION_NESTING_DEPTH} levels deep`,
        openToken.line,
      );
    }
    const expr = parseExpression(state);
    expectPunct(state, 'rparen', ')');
    state.nestingDepth -= 1;
    return expr;
  }
  const nameToken = expectWord(
    state,
    'a relation, permission, self, or tuple-to-userset reference',
  );
  if (nameToken.value === 'self') {
    return { kind: 'self', line: nameToken.line };
  }
  validateIdentifier(nameToken, 'rewrite-rule reference');
  if (peek(state).type === 'arrow') {
    consume(state);
    const targetToken = expectWord(state, "tuple-to-userset target (after '->')");
    validateIdentifier(targetToken, 'tuple-to-userset target');
    return {
      kind: 'tupleToUserset',
      relation: nameToken.value,
      computedUserset: targetToken.value,
      line: nameToken.line,
    };
  }
  return { kind: 'ref', name: nameToken.value, line: nameToken.line };
}

/** Mirrors `src/schema/dsl/parser.ts`'s own `flattenChildren` exactly — same associativity reasoning, same O(n) merge-in-place discipline, applied to a `+`/`&` chain instead of `|`/`&`. */
function flattenChildren(
  kind: 'union' | 'intersection',
  left: ParsedRewrite,
  right: ParsedRewrite,
): ParsedRewrite[] {
  const rightChildren = right.kind === kind ? right.children : [right];
  if (left.kind === kind) {
    for (const child of rightChildren) left.children.push(child);
    return left.children;
  }
  return [left, ...rightChildren];
}

/**
 * The tight tier — union (`+`). See this file's own module doc comment
 * for why this is the *inner*, tighter-binding rule here, the reverse of
 * this project's own `parser.ts` (where `&` plays this role).
 */
function parseTerm(state: ParserState): ParsedRewrite {
  let left = parseAtom(state);
  while (peek(state).type === 'plus') {
    const opToken = consume(state);
    const right = parseAtom(state);
    left = {
      kind: 'union',
      children: flattenChildren('union', left, right),
      line: left.kind === 'union' ? left.line : opToken.line,
    };
  }
  return left;
}

/**
 * The loose tier — intersection (`&`) and exclusion (`-`), sharing one
 * precedence level, left-associative — mirrors `src/schema/dsl/
 * parser.ts`'s own `parseExpression` shape exactly (same nesting-depth
 * bookkeeping for a `-` chain, same flatten-only-for-union/intersection
 * reasoning), just with `&` playing the role that file's `parseTerm`
 * gives `&` and this file's own `parseTerm` (above) giving `+` the tight
 * role instead.
 */
function parseExpression(state: ParserState): ParsedRewrite {
  let left = parseTerm(state);
  let exclusionLinksAdded = 0;
  while (peek(state).type === 'amp' || peek(state).type === 'minus') {
    const opToken = consume(state);
    const right = parseTerm(state);
    if (opToken.type === 'amp') {
      left = {
        kind: 'intersection',
        children: flattenChildren('intersection', left, right),
        line: left.kind === 'intersection' ? left.line : opToken.line,
      };
    } else {
      exclusionLinksAdded += 1;
      state.nestingDepth += 1;
      if (state.nestingDepth > MAX_EXPRESSION_NESTING_DEPTH) {
        throw new SpicedbParseFailure(
          `permission expression at line ${opToken.line} chains more than ${MAX_EXPRESSION_NESTING_DEPTH} '-' operators deep`,
          opToken.line,
        );
      }
      left = { kind: 'exclusion', base: left, subtract: right, line: opToken.line };
    }
  }
  state.nestingDepth -= exclusionLinksAdded;
  return left;
}

/** Parses and discards a permission's own optional `: TYPE | TYPE...` result-type annotation — see this file's own module doc comment for why dropping it is lossless. */
function skipOptionalTypeAnnotation(state: ParserState): void {
  if (peek(state).type !== 'colon') return;
  consume(state);
  parseSubjectTypeList(state);
}

function parsePermission(state: ParserState): ParsedPermission {
  const keyword = expectKeyword(state, 'permission');
  const nameToken = expectWord(state, 'permission name');
  validateIdentifier(nameToken, 'permission name');
  skipOptionalTypeAnnotation(state);
  expectPunct(state, 'equals', '=');
  const rewrite = parseExpression(state);
  return { kind: 'permission', name: nameToken.value, rewrite, line: keyword.line };
}

function parseDefinition(state: ParserState): ParsedDefinition {
  const keyword = expectKeyword(state, 'definition');
  const nameTokenCandidate = peek(state);
  if (nameTokenCandidate.type !== 'word') {
    throw new SpicedbParseFailure(
      `definition at line ${keyword.line} is missing a name`,
      keyword.line,
    );
  }
  const nameToken = consume(state);
  validateIdentifier(nameToken, 'definition name');
  expectPunct(state, 'lbrace', '{');

  const members: ParsedMember[] = [];
  while (peek(state).type !== 'rbrace') {
    const token = peek(state);
    if (token.type === 'eof') {
      throw new SpicedbParseFailure(
        `definition '${nameToken.value}' opened at line ${keyword.line} is missing a closing '}'`,
        keyword.line,
      );
    }
    if (token.type === 'word' && token.value === 'relation') {
      members.push(parseRelation(state));
    } else if (token.type === 'word' && token.value === 'permission') {
      members.push(parsePermission(state));
    } else {
      throw new SpicedbParseFailure(
        `expected 'relation' or 'permission' at line ${token.line}, found ${describeToken(token)}`,
        token.line,
      );
    }
  }
  expectPunct(state, 'rbrace', '}');

  return { name: nameToken.value, members, line: keyword.line };
}

/**
 * Parses one or more `definition { ... }` blocks, skipping any top-level
 * `use IDENT` directive it encounters along the way (see this file's own
 * module doc comment for why). Returns every definition's AST or the
 * first syntax error found.
 */
export function parseSpicedbSchema(source: string): SpicedbParseResult {
  if (source.trim().length === 0) {
    return { ok: false, error: { message: 'schema source is empty', line: 1 } };
  }

  try {
    const tokens = tokenize(source);
    const state: ParserState = { tokens, pos: 0, nestingDepth: 0 };
    const definitions: ParsedDefinition[] = [];
    while (peek(state).type !== 'eof') {
      const token = peek(state);
      if (token.type === 'word' && token.value === 'use') {
        consume(state);
        expectWord(state, "a directive name (after 'use')");
        continue;
      }
      definitions.push(parseDefinition(state));
    }
    if (definitions.length === 0) {
      return { ok: false, error: { message: 'schema source declares no definitions', line: 1 } };
    }
    return { ok: true, definitions };
  } catch (err) {
    if (err instanceof SpicedbParseFailure) {
      return { ok: false, error: { message: err.message, line: err.line } };
    }
    throw err;
  }
}
