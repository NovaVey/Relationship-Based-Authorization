/**
 * A seeded random *invariant* generator for §8b's differential test:
 * "on small random schemas from §2b, run the verifier against a
 * deliberately dumb exhaustive checker" (`src/schema/dsl/random.ts`'s own
 * top-of-file comment quotes this verbatim — that module is the schema
 * half; this is the other half). Supplies a random, always-parseable
 * invariant targeting a real relation or permission the random schema
 * actually declares, so the differential test has something meaningful
 * to check on every schema it draws, not a goal name pulled from thin
 * air that would just fail to resolve.
 *
 * Deliberately no `distinct`/`relationEquals` constraints. The value this
 * differential test exists to prove is specifically about §5's exact
 * search — the reachability walk itself, over the many graph shapes
 * (unions, tupleToUserset chains, nested groups, cycles)
 * `generateRandomSchema` already produces — not about the constraint
 * language, which the shipped fixtures (`tenant_isolation`,
 * `blocked_user_cannot_publish`) already exercise directly. Source text,
 * not a hand-built `Invariant` object literal: fed through the real
 * `parseInvariants`, the same "never hand-assemble what a real parser
 * produces" discipline `random.ts` already applies to schemas (never
 * hand-assembling a `CompiledSchema` either).
 */
import type { CompiledSchema } from '../../../../src/schema/dsl/types.js';
import { parseInvariants } from '../invariants/index.js';
import type { Invariant } from '../invariants/types.js';

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

/**
 * One random invariant over `schema`: a random declared namespace as the
 * object type, a random relation or permission declared on it as the
 * goal permission, and a random declared namespace (drawn independently
 * — may equal the object type, matching how a real invariant's subject
 * and object types are unrelated choices) as the subject type.
 *
 * `name` is caller-supplied, not generated here — this function enforces
 * nothing about uniqueness across calls; a caller batching several of
 * these into one source string (as the differential test does, one
 * invariant per trial) is responsible for passing a distinct name each
 * time, or `parseInvariants` will correctly reject the duplicate.
 *
 * Throws if the generated source fails to parse — a bug in this
 * generator's own construction, never an expected outcome (every name it
 * builds a goal line from is drawn straight from the schema's own real
 * `relations`/`permissions` keys, which are already valid schema
 * identifiers by construction — `compileSchema` accepted them).
 */
export function generateRandomInvariant(
  schema: CompiledSchema,
  rng: () => number,
  name: string,
): Invariant {
  const namespaces = Object.keys(schema.namespaces);
  if (namespaces.length === 0) {
    throw new Error('generateRandomInvariant: schema declares no namespaces');
  }
  const objectType = pick(rng, namespaces);
  const subjectType = pick(rng, namespaces);
  const objectNs = schema.namespaces[objectType]!;
  const goalNames = [...Object.keys(objectNs.relations), ...Object.keys(objectNs.permissions)];
  const goalName = pick(rng, goalNames);

  const source = [
    `invariant ${name} {`,
    `  s: ${subjectType}`,
    `  o: ${objectType}`,
    `  goal: ${goalName}(s, o)`,
    `}`,
  ].join('\n');

  const result = parseInvariants(source);
  if (!result.ok) {
    throw new Error(
      `generateRandomInvariant: generated source failed to parse — a bug in this generator, not an expected outcome: ${result.errors.map((e) => e.message).join('; ')}\n${source}`,
    );
  }
  return result.invariants[0]!;
}
