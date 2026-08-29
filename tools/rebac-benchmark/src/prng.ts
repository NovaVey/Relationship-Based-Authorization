/**
 * A tiny, dependency-free seeded PRNG (mulberry32) — the one piece of
 * randomness this harness uses, and every one of its call sites takes an
 * explicit seed so a run is exactly reproducible from that seed alone
 * (see README.md's "Reproducing a run exactly" section). Not
 * cryptographic, not this repo's own soundness-fuzzer RNG
 * (`src/soundness/`) — a fresh, minimal implementation scoped to this
 * tool alone, the same "don't reach across a tool boundary for something
 * this small" call `tools/schema-verifier` already makes for its own
 * fixtures.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic integer in `[0, max)` from a mulberry32 generator. */
export function randInt(rng: () => number, max: number): number {
  return Math.floor(rng() * max);
}
