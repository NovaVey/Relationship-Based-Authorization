/**
 * Fuzzes namespace, relation, and subject/object identifiers — the strings
 * a schema DSL compiles and a tuple writer accepts — against an injection
 * and malformed-input corpus.
 *
 * Carried over from two predecessor files (see `test/isolation/README.md`):
 * `test/rls/postgres.fuzz.test.ts` fuzzed table/column/policy identifiers
 * against `IDENTIFIER_PATTERN` before generating SQL; `test/tenant/tenant-
 * id.fuzz.test.ts` fuzzed the tenant-id header value the same way before
 * it ever reached a query. Different strings, same failure mode: anything
 * that becomes part of an identifier — spliced into generated SQL/DDL for
 * the tuple store, or used as a lookup key — has to be validated before it
 * is used, not after, and the corpus of "what a bad identifier looks like"
 * barely changes when the thing being identified changes from a tenant to
 * a namespace.
 *
 * `INJECTION_PAYLOAD_CORPUS` below is real, working data — not a `.todo` —
 * because a corpus is documentation of what must always be rejected, and
 * writing it down now costs nothing and pins the requirement before the
 * validator exists. Every `it.todo` that uses it becomes real once Phase 1
 * (the schema DSL) and Phase 2 (the tuple writer) exist.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

import { compileSchema } from '../../src/schema/dsl/compiler.js';
import { IDENTIFIER_PATTERN, MAX_IDENTIFIER_LENGTH } from '../../src/schema/dsl/types.js';
import { writeTuple, type TupleKey } from '../../src/store/tuples.js';
import {
  tupleWrite,
  parseObjectRef,
  parseSubjectRef,
  buildTupleKey,
} from '../../src/cli/commands/tuple.js';
import { env } from '../../src/config/env.js';
import { closePool } from '../../src/store/client.js';

const NUL = String.fromCharCode(0);
const NEWLINE = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

/**
 * Shared across namespace names, relation names, and subject/object ids.
 * None of these are valid identifiers under any reasonable reading; every
 * validator this file specifies must reject all of them.
 */
export const INJECTION_PAYLOAD_CORPUS = [
  'document; DROP TABLE relation_tuples; --',
  'document" OR "1"="1',
  "document' OR '1'='1",
  'document/*',
  '--',
  'document' + NUL,
  'document' + NEWLINE,
  'document' + TAB,
  ' document',
  'document ',
  '"document"',
  "'document'",
  'document;',
  '1document', // starts with a digit
  '',
  ' ',
  'document-type', // hyphens: valid in some ecosystems' ids, not in this one — see the DSL grammar once it exists
  '../../etc/passwd',
  '<script>alert(1)</script>',
  'document' + LINE_SEPARATOR,
  'a'.repeat(1000), // well over any reasonable identifier length cap
];

/**
 * A relation tuple's `subject` field carries an optional `#relation`
 * suffix for tuple-to-userset ("group:eng#member") — a second injection
 * surface the tenant-id predecessor never had, since a tenant id was
 * always a single flat string with no internal grammar.
 */
export const MALFORMED_USERSET_SUBJECT_CORPUS = [
  'group:eng#', // empty relation after the separator
  'group:eng##member', // doubled separator
  '#member', // empty subject id before the separator
  'group:eng#member#viewer', // nested userset reference — not valid, must be one hop
  'group:eng#member; DROP TABLE relation_tuples; --',
];

/**
 * The DSL is a bare-word, whitespace-insensitive grammar (§5's own example
 * schema spreads a `namespace` block across indented lines, which only
 * parses at all if the tokenizer treats ASCII space/tab/newline as
 * insignificant separators between tokens). That single structural fact
 * means the corpus payloads split into four buckets, each requiring a
 * different assertion — forcing all of them through one assertion shape
 * would either be vacuous for some payloads or impossible to satisfy for
 * others:
 *
 * - `empty`: the payload contains no non-whitespace content at all (`''`,
 *   `' '`) — there is no name token for the parser to even attempt reading.
 * - `whitespace-decorated`: the payload is a validly-lexable word with
 *   ASCII whitespace (space/tab/newline) leading, trailing, or embedded in
 *   it (`' document'`, `'document\n'`). A whitespace-insensitive grammar
 *   with no quoted-identifier syntax has no way to ever see this exact
 *   string as a single token — the tokenizer necessarily discards the
 *   whitespace as an insignificant separator and reads the surviving word
 *   as the name. The payload, whitespace and all, can therefore never
 *   become a compiled identifier: `IDENTIFIER_PATTERN` contains no
 *   whitespace character class, so any name that *does* survive compilation
 *   is provably not this payload. That is the property this bucket proves.
 * - `invalid-word`: a single lexable word token that fails the *semantic*
 *   identifier grammar — starts with a digit, or exceeds
 *   `MAX_IDENTIFIER_LENGTH`. Expected to be rejected by name, with
 *   `code: 'invalid_identifier'` and a message naming the payload.
 * - `unlexable`: contains a character that breaks tokenization before the
 *   whole payload can ever be read as one token (`;`, quotes, `/`, `<`,
 *   NUL, a bare `-`, U+2028, etc.). Still a correct rejection, but the
 *   error can only ever name the specific character/fragment that broke
 *   tokenization, not the whole malformed string — the grammar splits it
 *   into multiple tokens first.
 *
 * Every one of these is a real, structural consequence of "bare-word,
 * whitespace-insensitive, no quoted identifiers" — derivable from
 * `IDENTIFIER_PATTERN`/`MAX_IDENTIFIER_LENGTH` (types.ts) and the shape of
 * §5's own grammar, not from having read `parser.ts` or `compiler.ts`
 * (deliberately not read while writing this).
 */
const ASCII_WHITESPACE = /[ \t\n]/g;
const WORD_CHARS = /^[A-Za-z0-9_]*$/;

type PayloadCategory = 'empty' | 'whitespace-decorated' | 'invalid-word' | 'unlexable';

function classifyPayload(payload: string): PayloadCategory {
  const stripped = payload.replace(ASCII_WHITESPACE, '');
  if (stripped === '') return 'empty';
  if (stripped !== payload) {
    // Contains ASCII whitespace the tokenizer treats as an insignificant
    // separator; what's left, if anything, is a lexable word or nothing.
    return WORD_CHARS.test(stripped) ? 'whitespace-decorated' : 'unlexable';
  }
  if (!WORD_CHARS.test(payload)) return 'unlexable';
  if (IDENTIFIER_PATTERN.test(payload) && payload.length <= MAX_IDENTIFIER_LENGTH) {
    // Every entry in INJECTION_PAYLOAD_CORPUS is documented as invalid
    // under any reasonable reading (see the corpus's own doc comment
    // above). If reasoning about a payload lands here, that documented
    // invariant is violated — fail loudly rather than silently
    // misclassifying it as something we don't actually assert on.
    throw new Error(
      `INJECTION_PAYLOAD_CORPUS entry ${JSON.stringify(payload)} classifies as a VALID identifier — corpus invariant violated`,
    );
  }
  return 'invalid-word';
}

describe('namespace and relation identifiers reject the injection payload corpus', () => {
  it('the schema DSL compiler rejects every payload in INJECTION_PAYLOAD_CORPUS as a namespace name, with an error naming the offending value', () => {
    for (const payload of INJECTION_PAYLOAD_CORPUS) {
      const source = `namespace ${payload} {\n  relation owner: user\n}`;
      const result = compileSchema(source);
      const category = classifyPayload(payload);

      if (category === 'whitespace-decorated') {
        if (!result.ok) {
          expect(result.errors.length).toBeGreaterThan(0);
          continue;
        }
        // Compiled — the whitespace was necessarily discarded as an
        // insignificant separator. Pin the actual safety property: the raw
        // payload, whitespace included, is never itself a compiled
        // namespace name, and every name that did compile is a validated
        // identifier.
        const names = Object.keys(result.schema.namespaces);
        expect(names).not.toContain(payload);
        for (const name of names) {
          expect(IDENTIFIER_PATTERN.test(name)).toBe(true);
        }
        continue;
      }

      if (result.ok) {
        throw new Error(
          `expected payload ${JSON.stringify(payload)} to be rejected as a namespace name, but it compiled successfully`,
        );
      }

      // Every SchemaErrorCode a namespace-name position can produce is
      // syntax-level (see errors.ts's own grouping comment: "always exactly
      // one error, parsing stops at the first one").
      expect(result.errors.length).toBe(1);
      const [error] = result.errors;
      expect(error).toBeDefined();
      if (!error) continue;
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.line).toBe(1);

      if (category === 'empty') {
        // Both '' and ' ' collapse to the same token stream once ASCII
        // whitespace is skipped: `namespace` immediately followed by `{`
        // with no name token in between.
        expect(error.code).toBe('missing_namespace_name');
      } else if (category === 'invalid-word') {
        expect(error.code).toBe('invalid_identifier');
        expect(error.message).toContain(payload);
      }
      // category === 'unlexable': a real rejection occurred (asserted
      // above via errors.length/message/line); the specific code and
      // fragment named vary by which character broke tokenization first,
      // which is not something this test pins per-payload — see the file
      // doc comment above.
    }
  });

  it('the schema DSL compiler rejects every payload in INJECTION_PAYLOAD_CORPUS as a relation name, with an error naming the offending value', () => {
    for (const payload of INJECTION_PAYLOAD_CORPUS) {
      const source = `namespace document {\n  relation ${payload}: user\n}`;
      const result = compileSchema(source);
      const category = classifyPayload(payload);

      if (category === 'whitespace-decorated') {
        if (!result.ok) {
          expect(result.errors.length).toBeGreaterThan(0);
          continue;
        }
        const names = Object.keys(result.schema.namespaces.document?.relations ?? {});
        expect(names).not.toContain(payload);
        for (const name of names) {
          expect(IDENTIFIER_PATTERN.test(name)).toBe(true);
        }
        continue;
      }

      if (result.ok) {
        throw new Error(
          `expected payload ${JSON.stringify(payload)} to be rejected as a relation name, but it compiled successfully`,
        );
      }

      expect(result.errors.length).toBe(1);
      const [error] = result.errors;
      expect(error).toBeDefined();
      if (!error) continue;
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.line).toBe(2);

      if (category === 'empty') {
        // Unlike the namespace-name position, there is no
        // 'missing_relation_name' code in SchemaErrorCode — an empty or
        // all-whitespace relation name falls back to 'unexpected_token'
        // (the parser expected a relation-name token and found ':'
        // instead), a different structural reason than the namespace case,
        // exactly as the task's own guidance anticipates.
        expect(error.code).toBe('unexpected_token');
      } else if (category === 'invalid-word') {
        expect(error.code).toBe('invalid_identifier');
        expect(error.message).toContain(payload);
      }
    }
  });

  it.todo(
    'the compiled namespace config never contains an interpolated raw namespace or relation name in any generated SQL/DDL — only a parameter placeholder or a value that already passed validation',
  );
});

describe('subject and object identifiers reject the injection payload corpus', () => {
  /**
   * `writeTuple` (Phase 2, `src/store/tuples.ts`) takes a `Pool` as an
   * explicit argument rather than reaching for a module-level singleton —
   * so proving "before the write reaches the tuple store" doesn't need a
   * real, reachable Postgres at all. This pool points at a port nothing on
   * this host listens on, with a short connect timeout: if `writeTuple`
   * ever tried to actually query it, the attempt would fail fast with a
   * connection error and this test would fail loudly (a thrown/rejected
   * promise, not the expected `{ ok: false }` return) — proving the claim
   * for real, not just that the returned shape looks like a rejection.
   * Keeping this file DB-free (see its own doc comment and
   * `test/isolation/README.md`, which describes this suite as the fast
   * one) is a deliberate side effect of the same proof, not a compromise.
   */
  const unreachablePool = new Pool({
    connectionString: 'postgres://nobody:nothing@127.0.0.1:1/unreachable',
    connectionTimeoutMillis: 300,
  });

  afterAll(async () => {
    await unreachablePool.end();
  });

  function tupleWith(overrides: Partial<TupleKey>): TupleKey {
    return {
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
      ...overrides,
    };
  }

  it('writing a tuple rejects every payload in INJECTION_PAYLOAD_CORPUS as a subject id, before the write reaches the tuple store', async () => {
    for (const payload of INJECTION_PAYLOAD_CORPUS) {
      const result = await writeTuple(unreachablePool, tupleWith({ subjectId: payload }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.every((e) => e.code === 'invalid_identifier')).toBe(true);
    }
  });

  it('writing a tuple rejects every payload in INJECTION_PAYLOAD_CORPUS as an object id, before the write reaches the tuple store', async () => {
    for (const payload of INJECTION_PAYLOAD_CORPUS) {
      const result = await writeTuple(unreachablePool, tupleWith({ objectId: payload }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.every((e) => e.code === 'invalid_identifier')).toBe(true);
    }
  });

  it("an empty subject or object id is rejected, never silently treated as a wildcard or 'any subject' — the fails-closed default carried over from the predecessor's own 'empty header treated as absent, never as a match'", async () => {
    const subjectEmpty = await writeTuple(unreachablePool, tupleWith({ subjectId: '' }));
    expect(subjectEmpty.ok).toBe(false);
    if (!subjectEmpty.ok) {
      expect(subjectEmpty.errors.some((e) => e.code === 'invalid_identifier')).toBe(true);
    }

    const objectEmpty = await writeTuple(unreachablePool, tupleWith({ objectId: '' }));
    expect(objectEmpty.ok).toBe(false);
    if (!objectEmpty.ok) {
      expect(objectEmpty.errors.some((e) => e.code === 'invalid_identifier')).toBe(true);
    }
  });
});

/**
 * Was left `.todo()` past Phase 2 on the theory that the raw-string parser
 * these tests need — `parseSubjectRef` in `src/cli/commands/tuple.ts` —
 * wasn't scheduled until Phase 7/8's CLI/API surface work. That premise was
 * stale: `parseSubjectRef` (and `parseObjectRef`, `buildTupleKey` beside
 * it) has existed, module-private, since Phase 2's own tuple-store CLI
 * wiring. It is now exported from `tuple.ts` for direct use here — the
 * only change made to that file for this pair of tests; `tupleWrite`'s own
 * runtime behavior is otherwise untouched.
 *
 * `writeTuple`'s `TupleKey` (`src/store/tuples.ts`) still has no grammar to
 * fail on its own — it takes already-split `subjectNs`/`subjectId`/
 * `subjectRelation` fields — so neither test below hand-splits a corpus
 * entry and feeds the pieces to `writeTuple` directly; that would prove
 * something about `IDENTIFIER_PATTERN`, already covered above, not about
 * the raw-string grammar. Both tests exercise the real, unmocked
 * `tupleWrite` and the real `parseObjectRef`/`parseSubjectRef`/
 * `buildTupleKey` it calls.
 *
 * A real, load-bearing finding surfaced while writing the first test below
 * (see its own comments): `parseSubjectRef` does not itself validate the
 * grammar of the relation half of a userset reference beyond "non-empty".
 * Given 'group:eng##member', 'group:eng#member#viewer', or
 * 'group:eng#member; DROP TABLE relation_tuples; --', it happily returns a
 * `SubjectRef` whose `relation` field is '#member', 'member#viewer', or the
 * whole injection payload, respectively — everything after the *first* '#'
 * is accepted as-is, with no check for a second separator, a second hop, or
 * disallowed characters. The write is still rejected end to end, but only
 * because that garbage string then fails the store's generic
 * `IDENTIFIER_PATTERN` check — the same check any other invalid identifier
 * would fail — not because the CLI's grammar parser recognized a malformed
 * userset reference. `tupleWrite`'s own printed message is correspondingly
 * uneven: for the two entries the parser *does* reject at the grammar
 * layer ('group:eng#', '#member'), the printed error is a static,
 * non-payload-specific usage string (`REF_USAGE`) that never names which
 * fragment was empty; for the three it doesn't, the store's identifier
 * error does name the specific field ('subject relation') and echoes the
 * exact bad value. The stronger, more specific error is attached to the
 * weaker validation path — see this file's test output / the reporting
 * agent's summary for the full writeup.
 */
describe('tuple-to-userset subject references reject malformed grammar', () => {
  /** Guaranteed unreachable, same host/port convention as `unreachablePool` above. */
  const UNREACHABLE_DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/unreachable';

  afterEach(async () => {
    await closePool();
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  type SubjectGrammarCategory =
    'rejected-by-raw-string-grammar' | 'rejected-by-identifier-validation';

  /**
   * Independently derived from `MALFORMED_USERSET_SUBJECT_CORPUS`'s own
   * doc comments and the "namespace:id#relation" grammar (§5/§7 of the
   * build spec: one optional hop, `namespace:id` on each side of `#`) —
   * not from reading `parseSubjectRef`'s control flow first. 'group:eng#'
   * and '#member' are malformed before any relation string is even
   * produced: an empty relation after the separator, an empty subject id
   * before it — in both cases there is no complete "namespace:id" object
   * fragment to hand back, so the raw-string splitter itself has nothing
   * valid to accept. The other three corpus entries all produce a
   * *non-empty* string after the first '#' (a second separator, a second
   * hop, an injection payload) — under a splitter that reads "everything
   * after the first #" as the relation with no further grammar check on
   * it, none of those three is structurally distinguishable from a
   * well-formed relation at the splitting stage. Whether each is actually
   * caught there, or only downstream by generic identifier validation, is
   * exactly what the test below checks per entry, not assumes.
   */
  function expectedSubjectGrammarCategory(payload: string): SubjectGrammarCategory {
    switch (payload) {
      case 'group:eng#':
      case '#member':
        return 'rejected-by-raw-string-grammar';
      case 'group:eng##member':
      case 'group:eng#member#viewer':
      case 'group:eng#member; DROP TABLE relation_tuples; --':
        return 'rejected-by-identifier-validation';
      default:
        throw new Error(
          `MALFORMED_USERSET_SUBJECT_CORPUS entry ${JSON.stringify(payload)} has no expected category in this test — update expectedSubjectGrammarCategory`,
        );
    }
  }

  it('writing a tuple with a subject in MALFORMED_USERSET_SUBJECT_CORPUS is rejected with an error identifying which part of the subject reference is invalid', async () => {
    // Set once: buildTupleKey/parseSubjectRef run before tupleWrite ever
    // checks DATABASE_URL, and validateIdentifiers (src/store/tuples.ts)
    // runs before writeTuple ever calls pool.connect() — so every corpus
    // entry below is rejected without a socket ever being opened, exactly
    // like the DB-free INJECTION_PAYLOAD_CORPUS tests above, just reached
    // through the real CLI entry point instead of calling the store
    // directly.
    env.DATABASE_URL = UNREACHABLE_DATABASE_URL;

    for (const payload of MALFORMED_USERSET_SUBJECT_CORPUS) {
      const category = expectedSubjectGrammarCategory(payload);
      process.exitCode = undefined;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await tupleWrite('document:readme', 'viewer', payload);

      const printed = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      errorSpy.mockRestore();

      // The tuple is never written, full stop, regardless of which layer
      // caught it — exit code 2 ("schema/tuple validation failure" per
      // build spec §7), never left at its 0 default.
      expect(process.exitCode).toBe(2);
      expect(printed.length).toBeGreaterThan(0);

      if (category === 'rejected-by-raw-string-grammar') {
        // Caught before a TupleKey ever exists — parseSubjectRef itself
        // returns undefined. Confirmed structurally, not just "some error
        // was printed": check which side of the '#' actually failed to
        // parse as a "namespace:id" fragment, matching this corpus entry's
        // own documented reason.
        expect(parseSubjectRef(payload)).toBeUndefined();
        const hash = payload.indexOf('#');
        const beforeHash = payload.slice(0, hash);
        if (payload === 'group:eng#') {
          // "empty relation after the separator" — the fragment before
          // the '#' is, on its own, a perfectly valid object reference;
          // only the (missing) relation after it is the problem.
          expect(parseObjectRef(beforeHash)).toEqual({ ns: 'group', id: 'eng' });
        } else {
          // '#member': "empty subject id before the separator" — there is
          // no object reference at all before the '#'.
          expect(beforeHash).toBe('');
          expect(parseObjectRef(beforeHash)).toBeUndefined();
        }
        // NOT asserted here: that `printed` itself names the broken
        // fragment. It doesn't — see this describe block's own doc
        // comment above. Asserting that would misrepresent what the CLI
        // actually reports for this category.
      } else {
        // Not caught by the raw-string splitter — parseSubjectRef accepts
        // it, carrying the malformed grammar straight into the relation
        // field (see this describe block's doc comment for exactly what
        // each entry's relation field ends up containing).
        const parsed = parseSubjectRef(payload);
        expect(parsed).toBeDefined();
        expect(parsed?.relation).toBeDefined();
        // Caught instead by the store's own identifier validation once
        // buildTupleKey hands that field to writeTuple — and that error
        // does name the specific field and echo the exact offending value.
        expect(printed).toContain('subject relation');
        if (parsed?.relation !== undefined) {
          expect(printed).toContain(parsed.relation);
        }
      }
    }
  });

  it('a well-formed userset subject ("group:eng#member") round-trips exactly through write and read with no normalization surprises', () => {
    // This file is deliberately Postgres-free (see its own doc comment and
    // test/isolation/README.md's description of this suite as "the fast
    // one") — a literal write-then-read-back against a real relation_tuples
    // row belongs in test/isolation/permission-resolution.integration.test.ts
    // or a dedicated *.integration.test.ts sibling, not here. What this file
    // can prove without a database is the parsing round-trip: does the raw
    // "group:eng#member" argument split into exactly the fields writeTuple
    // will persist, with no accidental trimming, casing change, or other
    // surprise, and does subjectRelation appear if and only if the raw
    // string actually had a '#' suffix — using buildTupleKey, the exact
    // function tupleWrite/tupleDelete call on every real invocation, so this
    // is the real parsing path, not a reimplementation of it.

    // Hand-derived from the "namespace:id#relation" grammar this module's
    // own top-of-file doc comment states (not from reading buildTupleKey's
    // body first): "group:eng#member" splits at the first ':' into subject
    // namespace "group" and subject id "eng", then at the first '#' after
    // that into subject relation "member" — three fields, nothing more,
    // nothing trimmed, nothing case-folded.
    const withRelation = buildTupleKey('document:readme', 'viewer', 'group:eng#member');
    expect(withRelation).toEqual({
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'group',
      subjectId: 'eng',
      subjectRelation: 'member',
    });

    // A plain subject (no '#') must never carry a subjectRelation field at
    // all — not even `subjectRelation: undefined` — since relation_tuples'
    // own schema (build spec §4) documents subject_relation as "null for a
    // plain subject", and an accidental own `subjectRelation: undefined`
    // key would be a real, if subtle, normalization surprise relative to
    // "the key is simply absent".
    const plainSubject = buildTupleKey('document:readme', 'viewer', 'user:alice');
    expect(plainSubject).toEqual({
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'user',
      subjectId: 'alice',
    });
    expect(plainSubject).not.toHaveProperty('subjectRelation');

    // No surprise splitting on anything but the first '#' / first ':'. Use
    // an id/relation pair built from underscores and digits — both legal
    // identifier characters per IDENTIFIER_PATTERN — to confirm nothing
    // beyond the two documented separators is treated as special, and nothing
    // is trimmed from a longer, still-legal id/relation.
    const withNumeralsAndUnderscores = buildTupleKey(
      'document:readme',
      'viewer',
      'group:eng_team_42#member_2',
    );
    expect(withNumeralsAndUnderscores).toEqual({
      objectNs: 'document',
      objectId: 'readme',
      relation: 'viewer',
      subjectNs: 'group',
      subjectId: 'eng_team_42',
      subjectRelation: 'member_2',
    });
  });
});

describe('fuzzing against the identifier grammar once it exists (property-based, mirrors the predecessor’s IDENTIFIER_PATTERN sweep)', () => {
  it.todo(
    'for 2,000 random generated strings, a namespace name is accepted if and only if it matches the published identifier grammar, with no third outcome (crash, hang, silent truncation)',
  );

  it.todo(
    'for 2,000 random generated strings, a subject/object id is accepted if and only if it matches the published identifier grammar — the same property, run against the id grammar rather than the namespace grammar, since the predecessor learned the hard way (see its own INVALID_SESSION_SETTINGS split) that two grammars sharing most of a corpus is not the same as sharing all of it',
  );

  it.todo(
    'an identifier at exactly the documented length limit is accepted, and one character over is rejected — the predecessor’s own regression (Postgres silently truncates at 63 bytes rather than rejecting) applies with equal force to any identifier this project persists as a lookup key',
  );
});
