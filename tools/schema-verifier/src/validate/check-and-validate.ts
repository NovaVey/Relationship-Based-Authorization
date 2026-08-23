/**
 * `checkAndValidate` — the single entry point build spec §6 describes:
 * "self-validation runs automatically on every VIOLATED result." Also
 * where §7's fragment detection lives: every call first asks which
 * fragment the schema falls into (as reachable from the goal), and
 * routes accordingly — the monotone fragment gets §5's exact search plus
 * §6's replay/fuzz self-validation; the non-monotone fragment gets §7's
 * bounded search directly (which needs no separate self-validation step
 * — every verdict it returns already came from the real engine, not a
 * static claim needing replay).
 */
import type { CompiledSchema } from '../../../../src/schema/dsl/types.js';
import { generateCandidateTuples, boundedSearch } from '../bounded/index.js';
import type { Invariant } from '../invariants/types.js';
import { checkInvariant, scanReachability } from '../reachability/index.js';
import type { CheckResult } from '../reachability/types.js';
import type { SchemaGraph } from '../ir/types.js';
import { fuzzHolds, type FuzzHoldsOptions } from './fuzz.js';
import { replayWitness } from './replay.js';
import type { ValidationOutcome } from './types.js';

export interface CheckAndValidateOptions {
  readonly fuzz?: FuzzHoldsOptions;
  /** The bound k for §7's bounded search — only consulted when the schema (as reachable from the goal) falls into the non-monotone fragment. Default 1: see docs/DECISIONS.md D-118 for why this tool's own default differs from the build spec's own illustrative k = 3 — candidate-count growth is quadratic per reachable relation (k objects per type on both the object and subject side), so even two reachable relations of the same type pair puts k = 3 at hundreds of thousands of subsets. Callers may still pass a higher k for a schema small enough to afford it; `MAX_BOUNDED_CANDIDATES` refuses to run rather than hang regardless of what's requested. */
  readonly bound?: number;
}

export interface CheckAndValidateResult {
  readonly result: CheckResult;
  readonly validation: ValidationOutcome;
}

function namedNodeId(namespace: string, name: string): string {
  return `${namespace}#${name}`;
}

export async function checkAndValidate(
  graph: SchemaGraph,
  schema: CompiledSchema,
  invariant: Invariant,
  options?: CheckAndValidateOptions,
): Promise<CheckAndValidateResult> {
  const goalObjectType = invariant.variables.find((v) => v.name === invariant.goal.object)!.type;
  const goalNodeId = namedNodeId(goalObjectType, invariant.goal.permission);
  const scan = scanReachability(graph, goalNodeId);

  if (scan.fragment === 'non-monotone') {
    const k = options?.bound ?? 1;
    const candidates = generateCandidateTuples(schema, scan.relations, invariant, k);
    const result = await boundedSearch(schema, invariant, candidates, k);
    // Every verdict boundedSearch returns already came from the real
    // engine directly — there is nothing left to replay or fuzz.
    return { result, validation: { kind: 'not-applicable' } };
  }

  const result = { ...checkInvariant(graph, schema, invariant), fragment: 'monotone' as const };

  if (result.verdict === 'VIOLATED') {
    const validation = await replayWitness(result.witness!, schema, invariant);
    return { result, validation };
  }
  if (result.verdict === 'HOLDS') {
    const validation = await fuzzHolds(schema, invariant, options?.fuzz);
    return { result, validation };
  }
  return { result, validation: { kind: 'not-applicable' } };
}
