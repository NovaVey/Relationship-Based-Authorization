/**
 * `trySmtTier` — the new tier this module adds, wired in
 * `../validate/check-and-validate.ts` between the existing exact
 * monotone/short-circuit prover (`../reachability/search.ts`, unchanged)
 * and the existing bounded search (`../bounded/search.ts`, unchanged).
 * Closes part of the gap `docs/DECISIONS.md`'s own SMT sketch left open
 * (the entry documenting §7's bounded search, restated when §11 closed):
 * a real, unbounded decision procedure for the non-recursive fragment,
 * where bounded search can only ever offer "HOLDS up to k" or refuse to
 * run at all past `MAX_BOUNDED_CANDIDATES`.
 *
 * Three, and only three, outcomes a caller ever sees:
 *  - `undefined` — this tier does not apply. Either the goal's own
 *    reachable subgraph is recursive (`../smt/recursion.ts` — the sketch's
 *    own named, out-of-scope obstacle, deliberately not attempted here),
 *    or the encoder itself gave up (`encode()`'s own compile-step
 *    ceiling), or z3 returned `unknown`, or a `sat` result's own
 *    reconstructed witness failed to independently replay against the
 *    real engine. Every one of these is treated identically: fall
 *    through to bounded search, exactly as if this tier didn't exist.
 *  - `HOLDS`, `proof: 'exact'` — z3 proved the goal formula UNSAT. A
 *    real, unconditional proof, not "up to k" — see `./encode.ts`'s own
 *    header comment for the exact soundness argument. Still run through
 *    `fuzzHolds` afterward, the same empirical belt-and-suspenders check
 *    the existing exact prover's own `HOLDS` gets (`../validate/fuzz.ts`)
 *    — this tier's own correctness argument is new and hasn't earned the
 *    same track record yet.
 *  - `VIOLATED`, `proof: 'exact'` — a SAT result whose reconstructed
 *    witness was independently confirmed (`../validate/replay.ts`,
 *    completely unmodified) through the real, unmodified production
 *    engine. Never reported on the solver's own word alone.
 */
import { init } from 'z3-solver';
import type { CompiledSchema } from '../../../../src/schema/dsl/types.js';
import type { Invariant } from '../invariants/types.js';
import type { NodeId, SchemaGraph } from '../ir/types.js';
import type { CheckResult } from '../reachability/types.js';
import { fuzzHolds, type FuzzHoldsOptions } from '../validate/fuzz.js';
import { replayWitness } from '../validate/replay.js';
import type { ValidationOutcome } from '../validate/types.js';
import { encode } from './encode.js';
import { isRecursive } from './recursion.js';
import { extractWitness } from './witness.js';

export interface SmtTierResult {
  readonly result: CheckResult;
  readonly validation: ValidationOutcome;
}

/** How long z3 may spend on one `solver.check()` before this tier gives up honestly rather than risk a hang — the SMT-tier counterpart to every other ceiling this project discloses (`MAX_ATTEMPT_CALLS`, `MAX_BOUNDED_CANDIDATES`, `MAX_SMT_COMPILE_STEPS`). Milliseconds, per z3's own `timeout` param. */
export const SMT_SOLVER_TIMEOUT_MS = 5_000;

let z3Promise: ReturnType<typeof init> | undefined;
/** Lazily initializes z3's WASM module once per process and reuses it — `init()` itself is the expensive step (loading and instantiating the WASM binary), not creating a `Context` per call, which is cheap. Exported for `./chc.ts` to reuse — the CHC tier needs the identical `init()` result (there is only one WASM module to load, ever, per process), not a second cold-start of the same expensive step. */
export function getZ3(): ReturnType<typeof init> {
  z3Promise ??= init();
  return z3Promise;
}

function namedNodeId(namespace: string, name: string): NodeId {
  return `${namespace}#${name}`;
}

export async function trySmtTier(
  graph: SchemaGraph,
  schema: CompiledSchema,
  invariant: Invariant,
  fuzzOptions?: FuzzHoldsOptions,
): Promise<SmtTierResult | undefined> {
  const goalObjectType = invariant.variables.find((v) => v.name === invariant.goal.object)?.type;
  if (goalObjectType === undefined) return undefined; // checkInvariant's own upfront validation already rejects this invariant with a real reason — nothing new for this tier to add.
  const goalNodeId = namedNodeId(goalObjectType, invariant.goal.permission);
  if (!graph.nodes.has(goalNodeId)) return undefined;

  if (isRecursive(graph, goalNodeId)) {
    // The sketch's own named, out-of-scope obstacle (docs/DECISIONS.md) —
    // this tier must not apply at all, per this module's own scope. Fall
    // through to bounded search completely unchanged.
    return undefined;
  }

  const { Context } = await getZ3();
  const ctx = new Context('main');
  const encoded = encode(ctx, graph, invariant);
  if (!encoded.ok) return undefined;

  const solver = new ctx.Solver();
  solver.set('timeout', SMT_SOLVER_TIMEOUT_MS);
  solver.add(encoded.encoding.goal.term);

  let verdict: 'sat' | 'unsat' | 'unknown';
  try {
    verdict = await solver.check();
  } catch {
    // z3 itself can throw rather than return 'unknown' on some internal
    // failures (e.g. a resource limit hit mid-search) — treated
    // identically to 'unknown': this tier doesn't apply, never a crash
    // this tool's own caller has to handle.
    return undefined;
  }

  if (verdict === 'unknown') return undefined;

  if (verdict === 'unsat') {
    const result: CheckResult = { verdict: 'HOLDS', fragment: 'non-monotone', proof: 'exact' };
    const validation = await fuzzHolds(schema, invariant, fuzzOptions);
    return { result, validation };
  }

  // verdict === 'sat': a candidate violation only, never reported as one
  // outright — see this file's own header comment.
  const model = solver.model();
  const witness = extractWitness(encoded.encoding, model);
  if (witness === undefined) return undefined;

  const validation = await replayWitness(witness, schema, invariant);
  if (validation.kind !== 'confirmed') return undefined;

  const result: CheckResult = {
    verdict: 'VIOLATED',
    witness,
    fragment: 'non-monotone',
    proof: 'exact',
  };
  return { result, validation };
}
