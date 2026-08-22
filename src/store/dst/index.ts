/**
 * DST D0's public surface — `docs/DST-PROPOSAL.md`, `docs/DECISIONS.md`
 * D-097. Everything a test needs and nothing else: construct a fresh,
 * empty state, seed it with a real compiled namespace config, get a
 * `ConnectionSource`-shaped fake to hand to `writeTuple`/`deleteTuple`, and
 * optionally arm a one-shot crash on the next connection it opens.
 */
export { createFakeStoreState, seedNamespaceConfig } from './state.js';
export type { FakeStoreState, RelationTupleRow, WriteLogRow, NamespaceConfigRow } from './state.js';
export { createFakeConnectionSource } from './source.js';
export type { FakeConnectionSource } from './source.js';
