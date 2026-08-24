/**
 * Lexer + recursive-descent parser for the namespace DSL — see
 * `.claude/commands/build-authz-service.md` §5 for the grammar this
 * implements.
 *
 * Pure, zero I/O: `parseSchema` takes a source string and returns either
 * every declared namespace as a `Parsed*` AST (source line numbers still
 * attached — that's what lets `compiler.ts` report a specific line for a
 * semantic error) or a single `SchemaError` for the first syntax problem
 * found. This file only knows grammar; it never checks whether a name
 * referenced in a rewrite rule was actually declared anywhere — that's
 * `compiler.ts`'s job, once every namespace's shape is known.
 *
 * Grammar (informally):
 *
 *   schema      := namespace+
 *   namespace   := "namespace" IDENT "{" member+ "}"
 *   member      := relation | permission
 *   relation    := "relation" IDENT ":" subjectType ("|" subjectType)*
 *   subjectType := IDENT ("#" IDENT)?
 *   permission  := "permission" IDENT "=" expression
 *   expression  := term (("|" | "-") term)*        -- union / exclusion, equal precedence, left-assoc
 *   term        := atom ("&" atom)*                -- intersection, binds tighter than "|"/"-"
 *   atom        := "(" expression ")" | IDENT ("->" IDENT)?   -- computed-userset, or tuple-to-userset
 *
 * `//` starts a line comment. Precedence (`&` tighter than `|`/`-`) and
 * comment support are not specified by §5's worked examples — see
 * `docs/DECISIONS.md` for why these particular choices.
 */
import {
  IDENTIFIER_PATTERN,
  MAX_EXPRESSION_NESTING_DEPTH,
  MAX_IDENTIFIER_LENGTH,
} from './types.js';
import { makeSchemaError, SchemaParseError, type SchemaError } from './errors.js';

// ---------------------------------------------------------------------------
// Parse-time AST — line numbers attached to every node so semantic errors in
// compiler.ts can name an exact location. Stripped away when compiler.ts
// builds the final `RewriteRule` shape in types.ts; never stored.
// ---------------------------------------------------------------------------

export interface ParsedSubjectType {
  namespace: string;
  relation?: string;
  line: number;
}

export interface ParsedRelation {
  name: string;
  subjectTypes: ParsedSubjectType[];
  line: number;
}

export type ParsedRewriteRule =
  | { kind: 'computedUserset'; name: string; line: number }
  | { kind: 'union'; children: ParsedRewriteRule[]; line: number }
  | { kind: 'intersection'; children: ParsedRewriteRule[]; line: number }
  | { kind: 'exclusion'; base: ParsedRewriteRule; subtract: ParsedRewriteRule; line: number }
  | { kind: 'tupleToUserset'; relation: string; computedUserset: string; line: number };

export interface ParsedPermission {
  name: string;
  rewrite: ParsedRewriteRule;
  line: number;
}

export interface ParsedNamespace {
  name: string;
  relations: ParsedRelation[];
  permissions: ParsedPermission[];
  line: number;
}

export type ParseResult =
  { ok: true; namespaces: ParsedNamespace[] } | { ok: false; error: SchemaError };

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
  | 'pipe'
  | 'amp'
  | 'minus'
  | 'arrow'
  | 'hash'
  | 'eof';

interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

const WORD_CHAR = /[A-Za-z0-9_]/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;

  const advance = (count = 1): void => {
    for (let n = 0; n < count; n++) {
      if (source[i] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
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

    const startLine = line;
    const startColumn = column;

    if (ch !== undefined && WORD_CHAR.test(ch)) {
      let value = '';
      while (i < source.length) {
        const c = source[i];
        if (c === undefined || !WORD_CHAR.test(c)) break;
        value += c;
        advance();
      }
      tokens.push({ type: 'word', value, line: startLine, column: startColumn });
      continue;
    }

    const single = (type: TokenType, value: string, len = 1): void => {
      tokens.push({ type, value, line: startLine, column: startColumn });
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
      case '|':
        single('pipe', '|');
        continue;
      case '&':
        single('amp', '&');
        continue;
      case '#':
        single('hash', '#');
        continue;
      case '-':
        if (source[i + 1] === '>') {
          single('arrow', '->', 2);
        } else {
          single('minus', '-');
        }
        continue;
      default:
        throw new SchemaParseError(
          makeSchemaError(
            'unexpected_token',
            `unexpected character '${ch}' at line ${startLine}`,
            startLine,
          ),
        );
    }
  }

  tokens.push({ type: 'eof', value: '', line, column });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const RESERVED_WORDS = new Set(['namespace', 'relation', 'permission']);

interface ParserState {
  tokens: Token[];
  pos: number;
  /**
   * How many `(` a permission expression is currently nested inside, at
   * the point `parseAtom` is about to descend one level further —
   * incremented on `(`, decremented on the matching `)`. `parseAtom`,
   * `parseTerm`, and `parseExpression` are mutually recursive with one
   * native call-stack frame consumed per level of `(` nesting; this
   * counter is what lets `parseAtom` reject past
   * `MAX_EXPRESSION_NESTING_DEPTH` with a clean `SchemaError` instead of
   * letting that recursion run until Node's real call stack overflows.
   */
  parenDepth: number;
}

function peek(state: ParserState): Token {
  // `tokenize` always appends a trailing eof token, so this index is
  // always in range for any state produced by `parseSchema`.
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
    throw new SchemaParseError(
      makeSchemaError(
        'unexpected_token',
        `expected keyword '${keyword}' at line ${token.line}, found ${describeToken(token)}`,
        token.line,
      ),
    );
  }
  return consume(state);
}

function expectWord(state: ParserState, context: string): Token {
  const token = peek(state);
  if (token.type !== 'word') {
    throw new SchemaParseError(
      makeSchemaError(
        'unexpected_token',
        `expected ${context} at line ${token.line}, found ${describeToken(token)}`,
        token.line,
      ),
    );
  }
  return consume(state);
}

function expectPunct(state: ParserState, type: TokenType, display: string): Token {
  const token = peek(state);
  if (token.type !== type) {
    throw new SchemaParseError(
      makeSchemaError(
        'unexpected_token',
        `expected '${display}' at line ${token.line}, found ${describeToken(token)}`,
        token.line,
      ),
    );
  }
  return consume(state);
}

/** Validates a user-declared name (namespace/relation/permission/subject-type). */
function validateIdentifier(token: Token, context: string): void {
  if (RESERVED_WORDS.has(token.value)) {
    throw new SchemaParseError(
      makeSchemaError(
        'invalid_identifier',
        `invalid ${context} '${token.value}' at line ${token.line}: '${token.value}' is a reserved word`,
        token.line,
      ),
    );
  }
  if (token.value.length > MAX_IDENTIFIER_LENGTH) {
    throw new SchemaParseError(
      makeSchemaError(
        'invalid_identifier',
        `invalid ${context} '${token.value}' at line ${token.line}: identifiers may be at most ${MAX_IDENTIFIER_LENGTH} characters`,
        token.line,
      ),
    );
  }
  if (!IDENTIFIER_PATTERN.test(token.value)) {
    throw new SchemaParseError(
      makeSchemaError(
        'invalid_identifier',
        `invalid ${context} '${token.value}' at line ${token.line}: identifiers must match ${IDENTIFIER_PATTERN.source} (lowercase, start with a letter)`,
        token.line,
      ),
    );
  }
}

function parseSubjectType(state: ParserState): ParsedSubjectType {
  const nsToken = expectWord(state, 'subject type');
  validateIdentifier(nsToken, 'subject type namespace');
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
  while (peek(state).type === 'pipe') {
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
  return { name: nameToken.value, subjectTypes, line: keyword.line };
}

function parseAtom(state: ParserState): ParsedRewriteRule {
  if (peek(state).type === 'lparen') {
    const openToken = consume(state);
    state.parenDepth += 1;
    if (state.parenDepth > MAX_EXPRESSION_NESTING_DEPTH) {
      throw new SchemaParseError(
        makeSchemaError(
          'expression_nesting_too_deep',
          `permission expression at line ${openToken.line} nests '(' more than ${MAX_EXPRESSION_NESTING_DEPTH} levels deep`,
          openToken.line,
        ),
      );
    }
    const expr = parseExpression(state);
    expectPunct(state, 'rparen', ')');
    state.parenDepth -= 1;
    return expr;
  }
  const nameToken = expectWord(state, 'a relation, permission, or tuple-to-userset reference');
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
  return { kind: 'computedUserset', name: nameToken.value, line: nameToken.line };
}

/**
 * `&`/`|` are associative, so a chain of the same operator always compiles
 * to one flat n-ary node, regardless of how parentheses happened to group
 * it while parsing: `(a & b) & c` and `a & (b & c)` (and the unparenthesized
 * `a & b & c`) all produce the identical flat `{kind, children: [a, b, c]}`
 * — never a node nested purely because of where a `(...)` boundary fell.
 * Both `left` and the freshly parsed `right` are checked and merged when
 * either already has the target kind, which is what makes this symmetric:
 * checking `left.kind` alone (as an earlier version of this function did)
 * flattens a same-operator chain building up on the left but not one
 * arriving via a parenthesized `right`, producing two different tree shapes
 * for logically identical source. See `docs/DECISIONS.md` for why flattening
 * (rather than preserving parens as real tree structure) is the chosen
 * direction, and `test/unit/schema/rewrite-rules.test.ts` for the pinned
 * shape this produces on both sides of `|` and `&`.
 */
function flattenChildren(
  kind: 'union' | 'intersection',
  left: ParsedRewriteRule,
  right: ParsedRewriteRule,
): ParsedRewriteRule[] {
  const rightChildren = right.kind === kind ? right.children : [right];
  if (left.kind === kind) {
    // Extend `left.children` in place instead of always spreading into a
    // fresh array — the difference between this being O(n) and O(n^2)
    // over a flat same-operator chain (`docs/DECISIONS.md`, the entry
    // documenting a confirmed, unauthenticated CPU-exhaustion DoS through
    // this exact function before this fix: a ~32,700-term chain, well
    // within the real request body's byte cap, took 8+ seconds of
    // synchronous CPU to compile via the old always-spread version).
    // Safe because `left` is always a `let` variable `parseTerm`/
    // `parseExpression` is about to reassign to a brand-new object
    // wrapping this same array — nothing else ever retains a reference
    // to the old `left` wrapper, or to this array, before that
    // reassignment happens. Looping rather than `left.children.push(
    // ...rightChildren)` avoids relying on any engine's spread-argument
    // count limit at this same worst-case chain length.
    for (const child of rightChildren) left.children.push(child);
    return left.children;
  }
  return [left, ...rightChildren];
}

function parseTerm(state: ParserState): ParsedRewriteRule {
  let left = parseAtom(state);
  while (peek(state).type === 'amp') {
    const opToken = consume(state);
    const right = parseAtom(state);
    left = {
      kind: 'intersection',
      children: flattenChildren('intersection', left, right),
      line: left.kind === 'intersection' ? left.line : opToken.line,
    };
  }
  return left;
}

function parseExpression(state: ParserState): ParsedRewriteRule {
  let left = parseTerm(state);
  while (peek(state).type === 'pipe' || peek(state).type === 'minus') {
    const opToken = consume(state);
    const right = parseTerm(state);
    if (opToken.type === 'pipe') {
      left = {
        kind: 'union',
        children: flattenChildren('union', left, right),
        line: left.kind === 'union' ? left.line : opToken.line,
      };
    } else {
      left = { kind: 'exclusion', base: left, subtract: right, line: opToken.line };
    }
  }
  return left;
}

function parsePermission(state: ParserState): ParsedPermission {
  const keyword = expectKeyword(state, 'permission');
  const nameToken = expectWord(state, 'permission name');
  validateIdentifier(nameToken, 'permission name');
  expectPunct(state, 'equals', '=');
  const rewrite = parseExpression(state);
  return { name: nameToken.value, rewrite, line: keyword.line };
}

function parseNamespace(state: ParserState): ParsedNamespace {
  const keyword = expectKeyword(state, 'namespace');
  const nameTokenCandidate = peek(state);
  if (nameTokenCandidate.type !== 'word') {
    throw new SchemaParseError(
      makeSchemaError(
        'missing_namespace_name',
        `namespace declared at line ${keyword.line} is missing a name (expected an identifier after 'namespace', found ${describeToken(nameTokenCandidate)})`,
        keyword.line,
      ),
    );
  }
  const nameToken = consume(state);
  // A reserved word (e.g. `namespace relation { ... }`) is caught by
  // validateIdentifier below with a specific "reserved word" message,
  // rather than being folded into the "missing a name" case above.
  validateIdentifier(nameToken, 'namespace name');
  expectPunct(state, 'lbrace', '{');

  const relations: ParsedRelation[] = [];
  const permissions: ParsedPermission[] = [];

  while (peek(state).type !== 'rbrace') {
    const token = peek(state);
    if (token.type === 'eof') {
      throw new SchemaParseError(
        makeSchemaError(
          'unterminated_namespace',
          `namespace '${nameToken.value}' opened at line ${keyword.line} is missing a closing '}'`,
          keyword.line,
          { namespace: nameToken.value },
        ),
      );
    }
    if (token.type === 'word' && token.value === 'relation') {
      relations.push(parseRelation(state));
    } else if (token.type === 'word' && token.value === 'permission') {
      permissions.push(parsePermission(state));
    } else {
      throw new SchemaParseError(
        makeSchemaError(
          'unexpected_token',
          `expected 'relation' or 'permission' at line ${token.line}, found ${describeToken(token)}`,
          token.line,
          { namespace: nameToken.value },
        ),
      );
    }
  }
  expectPunct(state, 'rbrace', '}');

  if (relations.length === 0 && permissions.length === 0) {
    throw new SchemaParseError(
      makeSchemaError(
        'empty_namespace_body',
        `namespace '${nameToken.value}' at line ${keyword.line} declares no relations or permissions`,
        keyword.line,
        { namespace: nameToken.value },
      ),
    );
  }

  return { name: nameToken.value, relations, permissions, line: keyword.line };
}

/**
 * Parses one or more `namespace { ... }` blocks. Returns every namespace's
 * AST (still carrying source line numbers) or the first syntax error
 * found — see this file's module doc comment for why parsing doesn't
 * attempt error recovery past the first problem.
 */
export function parseSchema(source: string): ParseResult {
  if (source.trim().length === 0) {
    return { ok: false, error: makeSchemaError('empty_source', 'schema source is empty', 1) };
  }

  try {
    const tokens = tokenize(source);
    const state: ParserState = { tokens, pos: 0, parenDepth: 0 };
    const namespaces: ParsedNamespace[] = [];
    while (peek(state).type !== 'eof') {
      namespaces.push(parseNamespace(state));
    }
    if (namespaces.length === 0) {
      return {
        ok: false,
        error: makeSchemaError(
          'no_namespaces_declared',
          'schema source declares no namespace blocks',
          1,
        ),
      };
    }
    return { ok: true, namespaces };
  } catch (err) {
    if (err instanceof SchemaParseError) {
      return { ok: false, error: err.schemaError };
    }
    // A truly unexpected failure (a real parser bug) must never be
    // silently swallowed into a generic "invalid schema" — surface it.
    throw err;
  }
}
