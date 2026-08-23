#!/usr/bin/env -S npx tsx
/**
 * The schema verifier's own worked example — run this directly:
 *
 *   npx tsx tools/schema-verifier/examples/run.ts
 *
 * See README.md for the walkthrough this backs, and
 * test/worked-example.test.ts for the same claim pinned as a CI-enforced
 * assertion — this script and that test load the exact same two fixture
 * files, so neither can silently drift from the other.
 */
import { compileSchema } from '../../../src/schema/dsl/compiler.js';
import { buildSchemaGraph } from '../src/ir/index.js';
import { parseInvariants } from '../src/invariants/index.js';
import { checkAndValidate } from '../src/validate/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXAMPLE_DIR = fileURLToPath(new URL('.', import.meta.url));

const schemaSource = readFileSync(EXAMPLE_DIR + 'three-hop-leak.authz', 'utf8');
const invariantSource = readFileSync(EXAMPLE_DIR + 'three-hop-leak.invariant', 'utf8');

const compiled = compileSchema(schemaSource);
if (!compiled.ok) {
  console.error('schema failed to compile:', compiled.errors);
  process.exit(1);
}

const parsedInvariants = parseInvariants(invariantSource);
if (!parsedInvariants.ok) {
  console.error('invariant failed to parse:', parsedInvariants.errors);
  process.exit(1);
}
const invariant = parsedInvariants.invariants[0]!;

const graph = buildSchemaGraph(compiled.schema);
const { result, validation } = await checkAndValidate(graph, compiled.schema, invariant);

console.log(`verdict: ${result.verdict}`);
console.log(`fragment: ${result.fragment}`);
console.log();

if (result.witness) {
  console.log('counterexample tuples (write these and the invariant is genuinely violated):');
  for (const t of result.witness) {
    const subject =
      t.subjectRelation === undefined
        ? `${t.subjectType}:${t.subject}`
        : `${t.subjectType}:${t.subject}#${t.subjectRelation}`;
    console.log(`  ${t.objectType}:${t.object}#${t.relation}@${subject}`);
  }
  console.log();
}

console.log(`self-validation against the real engine: ${validation.kind}`);
if (validation.kind === 'confirmed') {
  console.log('  the real, unmodified production resolver was called with the witness');
  console.log('  tuples above written to a fake store, and it independently agreed: allowed.');
}
