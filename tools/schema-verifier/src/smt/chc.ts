/**
 * `tryChcTier` — the Horn-clause/CHC tier this module adds, wired in
 * `../validate/check-and-validate.ts` between the existing non-recursive
 * SMT tier (`./index.ts`'s own `trySmtTier`, unchanged) and the existing
 * bounded search (`../bounded/search.ts`, unchanged). Closes the gap
 * D-151 (`docs/DECISIONS.md`) deliberately left open: "Revisit if a real
 * schema needs this tier to decide a genuinely recursive goal — that's
 * the sketch's own named Horn-clause/CHC fixpoint-solver v2 phase (Z3's
 * own PDR/Spacer), explicitly out of scope here."
 *
 * Applies *only* to a goal `../smt/recursion.ts`'s own `isRecursive`
 * flags as recursive — the exact fragment `trySmtTier` (`./index.ts`)
 * itself declines on for exactly that reason, so the two tiers are
 * mutually exclusive by construction, never racing to decide the same
 * goal two different ways. See `./chc-encode.ts`'s own header comment for
 * this tier's own further, real, empirically-confirmed scope boundary
 * (no exclusion, no `notRelationEquals` — Horn-clause negation is not
 * usable in this z3-solver build's `Fixedpoint` engine) and for why every
 * outcome besides those two carve-outs is fully general with respect to
 * recursion (genuine, unbounded, real cycles — not "up to k").
 *
 * Same three outcomes as `./index.ts`'s own `trySmtTier`, and the same
 * non-negotiable discipline:
 *  - `undefined` — this tier does not apply. Not recursive (`trySmtTier`'s
 *    own job instead), a `notRelationEquals` constraint is present, the
 *    encoder met an exclusion edge or its own compile-step ceiling
 *    (`./chc-encode.ts`), z3 returned `unknown` or threw, or a `sat`
 *    result's own reconstructed witness (`./chc-witness.ts`) either
 *    couldn't be built or failed real-engine replay. Every one of these
 *    falls through to bounded search exactly as if this tier didn't
 *    exist.
 *  - `HOLDS`, `proof: 'exact'` — Spacer proved the goal relation UNSAT in
 *    the Horn-clause program's own least fixpoint: a real, unconditional
 *    proof, with genuine recursion, not "up to k" and not "up to depth
 *    d." Still run through `fuzzHolds` afterward, the same empirical
 *    belt-and-suspenders check every other tier's own `HOLDS` gets.
 *  - `VIOLATED`, `proof: 'exact'` — a SAT result whose reconstructed
 *    witness was independently confirmed (`../validate/replay.ts`,
 *    completely unmodified) through the real, unmodified production
 *    engine. Never reported on Spacer's own word alone.
 */
import type { Bool } from 'z3-solver';
import type { CompiledSchema } from '../../../../src/schema/dsl/types.js';
import type { Invariant } from '../invariants/types.js';
import type { NodeId, SchemaGraph } from '../ir/types.js';
import type { CheckResult } from '../reachability/types.js';
import { fuzzHolds, type FuzzHoldsOptions } from '../validate/fuzz.js';
import { replayWitness } from '../validate/replay.js';
import { encodeChc } from './chc-encode.js';
import { extractChcWitness } from './chc-witness.js';
import { getZ3 } from './index.js';
import { isRecursive } from './recursion.js';
import type { SmtTierResult } from './index.js';

/** How long Spacer may spend on any one `fp.query()` call (the tier's own top-level goal query, and every one of `./chc-witness.ts`'s own re-queries) before this tier gives up honestly rather than risk a hang — this tier's own counterpart to `./index.ts`'s `SMT_SOLVER_TIMEOUT_MS`, same value, same reasoning, per z3's own `Fixedpoint` `timeout` param (milliseconds). */
export const CHC_SOLVER_TIMEOUT_MS = 5_000;

function namedNodeId(namespace: string, name: string): NodeId {
  return `${namespace}#${name}`;
}

export async function tryChcTier(
  graph: SchemaGraph,
  schema: CompiledSchema,
  invariant: Invariant,
  fuzzOptions?: FuzzHoldsOptions,
): Promise<SmtTierResult | undefined> {
  const goalObjectType = invariant.variables.find((v) => v.name === invariant.goal.object)?.type;
  if (goalObjectType === undefined) return undefined; // checkInvariant's own upfront validation already rejects this invariant with a real reason.
  const goalNodeId = namedNodeId(goalObjectType, invariant.goal.permission);
  if (!graph.nodes.has(goalNodeId)) return undefined;

  if (!isRecursive(graph, goalNodeId)) {
    // Not this tier's fragment — `./index.ts`'s own `trySmtTier` already
    // handles (or has already declined for its own, different reasons)
    // every non-recursive goal. Never attempted here.
    return undefined;
  }

  if (invariant.constraints.some((c) => c.kind === 'notRelationEquals')) {
    // `not <relation>(<var>) = <var>` needs Horn-clause negation too —
    // see `./chc-encode.ts`'s own header comment, finding 2. Declined
    // upfront rather than discovered mid-compile, since it's a property
    // of the invariant, not of the schema graph.
    return undefined;
  }

  const { Context } = await getZ3();
  const ctx = new Context('main');
  const encoded = encodeChc(ctx, graph, invariant);
  if (!encoded.ok) return undefined;

  const { encoding } = encoded;
  encoding.fp.set('timeout', CHC_SOLVER_TIMEOUT_MS);

  let verdict: 'sat' | 'unsat' | 'unknown';
  try {
    verdict = await encoding.fp.query(
      encoding.goalRelation.decl.call(ctx.Int.val(encoding.goalObjectValue)) as Bool<'main'>,
    );
  } catch {
    // z3 itself can throw rather than return 'unknown' on some internal
    // failure — treated identically to 'unknown': this tier doesn't
    // apply, never a crash this tool's own caller has to handle.
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
  const witness = await extractChcWitness(encoding);
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
