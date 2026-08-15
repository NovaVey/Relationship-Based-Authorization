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
import { describe, it } from 'vitest';

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

describe('namespace and relation identifiers reject the injection payload corpus', () => {
  it.todo(
    'the schema DSL compiler rejects every payload in INJECTION_PAYLOAD_CORPUS as a namespace name, with an error naming the offending value',
  );

  it.todo(
    'the schema DSL compiler rejects every payload in INJECTION_PAYLOAD_CORPUS as a relation name, with an error naming the offending value',
  );

  it.todo(
    'the compiled namespace config never contains an interpolated raw namespace or relation name in any generated SQL/DDL — only a parameter placeholder or a value that already passed validation',
  );
});

describe('subject and object identifiers reject the injection payload corpus', () => {
  it.todo(
    'writing a tuple rejects every payload in INJECTION_PAYLOAD_CORPUS as a subject id, before the write reaches the tuple store',
  );

  it.todo(
    'writing a tuple rejects every payload in INJECTION_PAYLOAD_CORPUS as an object id, before the write reaches the tuple store',
  );

  it.todo(
    "an empty subject or object id is rejected, never silently treated as a wildcard or 'any subject' — the fails-closed default carried over from the predecessor's own 'empty header treated as absent, never as a match'",
  );
});

describe('tuple-to-userset subject references reject malformed grammar', () => {
  it.todo(
    'writing a tuple with a subject in MALFORMED_USERSET_SUBJECT_CORPUS is rejected with an error identifying which part of the subject reference is invalid',
  );

  it.todo(
    'a well-formed userset subject ("group:eng#member") round-trips exactly through write and read with no normalization surprises',
  );
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
