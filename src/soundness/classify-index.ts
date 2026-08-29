/**
 * The Leopard-index third comparison arm — `docs/LEOPARD-INDEX-PROPOSAL.md`,
 * "Test plan — the third comparison arm". Mirrors `classify.ts`'s own shape
 * (one small, pure classification function, no I/O, no resolver, no
 * generator) but is deliberately **not** a reuse of `classifyResult`: that
 * function is keyed to "the reference resolver is the independent oracle,
 * production might diverge from it" (`referenceAllowed` vs
 * `productionAllowed`, §6.5, `docs/DECISIONS.md` D-006). Here *both* sides
 * of the comparison are `productionCheck` — the exact same engine, called
 * twice against the identical pinned snapshot, differing only in
 * `options.useRelationIndex`. A divergence found here is never a
 * `false_grant`/`false_deny` in `classify.ts`'s own sense — it is its own,
 * independent question ("did turning the index on change what this specific
 * call returns, relative to the unaccelerated live path?"), and conflating
 * the two would blur exactly the distinction D-006 already insists on
 * keeping sharp for `false_grant` vs `false_deny`. See `runner.ts`'s own
 * `SoundnessRunOptions.relationIndex` for how this is wired into the fuzz
 * harness.
 */

export type IndexDivergenceKind = 'index_false_grant' | 'index_false_deny';

export interface ClassifyIndexInput {
  /** The unaccelerated `productionCheck` call's own `allowed` (`useRelationIndex: false`), pinned to the identical snapshot as `productionIndexAllowed` below. */
  productionAllowed: boolean;
  /** The index-accelerated `productionCheck` call's own `allowed` (`useRelationIndex: true`), against the identical pinned snapshot. */
  productionIndexAllowed: boolean;
}

/**
 * `null` on agreement (the expected majority — both calls read the exact
 * same underlying data, so disagreement should never happen in a sound
 * implementation). Otherwise, exactly the two directions:
 *
 * - `false -> true` (the index-accelerated call allows something the
 *   unaccelerated live call denies) -> `'index_false_grant'` — a real
 *   security bug (the index served a hit that doesn't correspond to a real,
 *   currently-live path), must be zero, ever. `runner.ts` blocks the run's
 *   verdict on this unconditionally, the same way a critical `false_grant`
 *   already blocks it today — never softened, never merged into
 *   `falseGrantCount` itself, since the two measure different things
 *   (agreement with an independent oracle, vs. agreement with the same
 *   engine's own unaccelerated path).
 * - `true -> false` (the index-accelerated call denies something the
 *   unaccelerated call allows) -> `'index_false_deny'` — the index missed a
 *   real hit (an overly-conservative depth/expiry/freshness gate, or a
 *   genuine miss that correctly fell back but the fallback itself somehow
 *   denied — see `runner.ts`'s own comment on why this shouldn't happen
 *   under the harness's "zero writes between rebuild and comparison"
 *   discipline). Recorded and reported, never blocking on its own — the
 *   explicitly accepted safe direction.
 */
export function classifyIndexDivergence(input: ClassifyIndexInput): IndexDivergenceKind | null {
  const { productionAllowed, productionIndexAllowed } = input;
  if (productionAllowed === productionIndexAllowed) {
    return null;
  }
  if (productionIndexAllowed && !productionAllowed) {
    return 'index_false_grant';
  }
  return 'index_false_deny';
}
