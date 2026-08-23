/**
 * `checkAndValidate` — the single entry point build spec §6 describes:
 * "self-validation runs automatically on every VIOLATED result." Wraps
 * §5's pure, synchronous `checkInvariant` with the appropriate async
 * self-validation for whichever verdict it returned — replay for
 * `VIOLATED`, empirical fuzzing for `HOLDS`, nothing for `UNKNOWN` (there
 * is no witness to replay and no claim to fuzz against).
 */
import type { CompiledSchema } from '../../../../src/schema/dsl/types.js';
import type { Invariant } from '../invariants/types.js';
import { checkInvariant } from '../reachability/search.js';
import type { CheckResult } from '../reachability/types.js';
import type { SchemaGraph } from '../ir/types.js';
import { fuzzHolds, type FuzzHoldsOptions } from './fuzz.js';
import { replayWitness } from './replay.js';
import type { ValidationOutcome } from './types.js';

export interface CheckAndValidateResult {
  readonly result: CheckResult;
  readonly validation: ValidationOutcome;
}

export async function checkAndValidate(
  graph: SchemaGraph,
  schema: CompiledSchema,
  invariant: Invariant,
  fuzzOptions?: FuzzHoldsOptions,
): Promise<CheckAndValidateResult> {
  const result = checkInvariant(graph, schema, invariant);

  if (result.verdict === 'VIOLATED') {
    const validation = await replayWitness(result.witness!, schema, invariant);
    return { result, validation };
  }
  if (result.verdict === 'HOLDS') {
    const validation = await fuzzHolds(schema, invariant, fuzzOptions);
    return { result, validation };
  }
  return { result, validation: { kind: 'not-applicable' } };
}
