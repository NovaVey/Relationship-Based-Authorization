/**
 * A pure, zero-I/O schema+tuple-graph generator: for a randomly-parameterized
 * seed, builds the DSL source text and the exact tuple graph needed to
 * exercise the GENERAL shape D-158 (`docs/DECISIONS.md`) fixed and disclosed
 * as needing a permanent metamorphic property, not just its own two
 * fixture-specific regression tests: **an exclusion rule whose `subtract`
 * branch hits an unprovable cut — a genuine tuple-data cycle, or a chain
 * deeper than the check's own depth budget — must never let the exclusion
 * grant.**
 *
 * Two independently-built shapes, one per mechanism this project's
 * production resolver actually has (see `src/resolve/production/resolver.ts`'s
 * own top-of-file doc comment):
 *
 *   - `buildMechanism1Fixture` — `subtract` is a `tupleToUserset` recursing
 *     into a PERMISSION (`parent->view`, `view` self-referential only
 *     through tuple DATA, never through the schema's own dependency graph —
 *     this DSL's compiler already rejects a literal `permission view = view`
 *     as `circular_permission_definition`). This routes through `resolve()`'s
 *     TS-level `visited`-Set walk — mechanism 1, the one D-158 itself fixed
 *     in both resolvers.
 *   - `buildMechanism2Fixture` — `subtract` is a bare `computedUserset`
 *     naming a plain declared RELATION with a self-referential userset
 *     subject type (`member: user | <self>#member`), routing instead through
 *     `sqlRelationMembershipWithWitness` — mechanism 2, D-158's own
 *     explicitly disclosed, NOT-fixed-by-that-entry residual risk.
 *
 * **Why this can't reuse `src/schema/dsl/random.ts` or
 * `src/soundness/generators.ts`'s `generateFixture` as-is (checked directly,
 * not assumed) — and why this file exists instead of extending either in
 * place.** `generateRandomSchema` (`random.ts`) is *constructively acyclic
 * by design*: `buildRewriteExpr`'s `eligibleHops` and every relation's own
 * structural subject types are drawn only from `earlierNamespaces` (strictly
 * before the current namespace in top-level generation order — see that
 * file's own top-of-file doc comment, "Constructive correctness"), and a
 * permission's own `referenceableNames` excludes itself and every
 * later-declared permission on the same namespace. No namespace can ever
 * reference itself, directly or transitively — the exact shape this
 * property needs (a `tupleToUserset`/relation that loops back into its own
 * namespace) is structurally impossible for that generator to produce, by
 * its own explicit design goal, not an oversight. `generateFixture`
 * (`generators.ts`) DOES ship both a self-referential group namespace
 * (`member: user | <self>#member`) and a self-referential hierarchical
 * namespace (`parent: <self>`, `view = editor | parent->view`) — but
 * neither is wired into an EXCLUSION's own `subtract` branch anywhere in
 * that fixed three-namespace skeleton: the one guaranteed exclusion
 * (`unbanned_view = viewer - banned`) subtracts a plain, non-recursive
 * `banned: user` relation, and the guaranteed cycle/deep-chain constructs
 * both live on `view`/`member`, never on `unbanned_view`'s own `banned`
 * side. Extending either shared, load-bearing generator in place to add
 * this shape would risk perturbing `generateFixture`'s own exact,
 * depended-upon tuple counts and the D-070 deep-chain accounting several
 * *other* tests assert byte-for-byte (`DEEP_CHAIN_*` constants,
 * `test/unit/soundness/generators.test.ts`) — a materially larger, riskier
 * change than this property needs. This file instead reuses the one piece
 * of infrastructure that genuinely does generalize cleanly: the same
 * seeded, deterministic, `fast-check`-backed draw-pool technique both of
 * those files already use (`SeededRng`/`hashSeedToInt31`, imported directly
 * from `src/soundness/generators.ts` — the same reuse `src/store/dst
 * /scheduler.ts` already established as normal for this exact pair, not a
 * new precedent), rather than hand-rolling a third PRNG.
 *
 * **Never shares code with either resolver.** This file only ever emits DSL
 * source text (fed through the real `compileSchema`, never hand-assembled —
 * matching `random.ts`'s own discipline) and plain tuple-key data; it
 * contains no traversal, no cycle-detection, no rewrite-rule evaluation of
 * its own. The property this generator feeds (`test/metamorphic
 * /exclusion-subtract-unprovable-cut.integration.test.ts`) checks its output
 * only against the real, unmodified production engine — never a second
 * implementation — so this generator itself is never "the thing being
 * checked," only the input to it.
 */
import { integer, sample } from 'fast-check';

import { SeededRng, hashSeedToInt31 } from '../soundness/generators.js';

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

export interface FixtureTuple {
  objectNs: string;
  objectId: string;
  relation: string;
  subjectNs: string;
  subjectId: string;
  subjectRelation?: string;
}

const DRAW_POOL_SIZE = 64;

function buildRng(seed: string): SeededRng {
  const numericSeed = hashSeedToInt31(seed);
  const pool = sample(integer({ min: 0, max: 0x7fffffff }), {
    seed: numericSeed,
    numRuns: DRAW_POOL_SIZE,
  });
  return new SeededRng(pool);
}

/** A short, deterministic, `IDENTIFIER_PATTERN`-safe salt derived from `seed` — mirrors `generateFixture`'s own `salt` construction (`numericSeed.toString(36)`), independently computed here rather than imported (this file's own top doc comment explains why it doesn't import `generateFixture`/`buildRng` itself: different shape, same technique). */
function saltFor(seed: string): string {
  return hashSeedToInt31(seed).toString(36);
}

function tuple(
  objectNs: string,
  objectId: string,
  relation: string,
  subjectNs: string,
  subjectId: string,
  subjectRelation?: string,
): FixtureTuple {
  return {
    objectNs,
    objectId,
    relation,
    subjectNs,
    subjectId,
    ...(subjectRelation !== undefined ? { subjectRelation } : {}),
  };
}

// ---------------------------------------------------------------------------
// Mechanism 1 — TS-level recursion (`resolve()`'s own `visited`-Set walk),
// reached when `subtract` is a `tupleToUserset` recursing into a PERMISSION.
// ---------------------------------------------------------------------------

export type Mechanism1CutKind = 'cycle' | 'depthCeiling';

export interface Mechanism1Fixture {
  seed: string;
  cutKind: Mechanism1CutKind;
  schemaSource: string;
  namespace: string;
  /** Always `'view'` — kept as an explicit field (not a hardcoded literal at every call site) so a future variant of this generator can rename it without every consumer needing to change. */
  permissionName: string;
  subjectId: string;
  tuples: FixtureTuple[];
  /**
   * Every object id that must resolve `view` **DENIED** for `subjectId` at
   * `pinnedMaxDepth` — the property's own core assertion. For `cutKind:
   * 'cycle'`, this is EVERY node in the ring (matching D-158's own regression
   * test's discipline of checking every node in an odd ring, generalized to
   * rings of any length here — see this generator's own doc comment on why
   * every ring node needs its own `grant` tuple for this to be meaningful).
   * For `cutKind: 'depthCeiling'`, this is the single object anchoring the
   * over-long chain.
   */
  unprovableQueryObjectIds: string[];
  /** Pinned identically for every check this fixture's own caller runs against it — never a different value per query, matching this project's own D-071 discipline of pinning one shared ceiling. */
  pinnedMaxDepth: number;
  /**
   * A single object, built into the SAME namespace/tuple graph, that must
   * resolve `view` **ALLOWED** for `subjectId` at `pinnedMaxDepth` — the
   * "this isn't just denying everything" control, matching D-158's own
   * established control-test discipline (`cross-resolver-agreement
   * .integration.test.ts`'s "control" case, and this project's Property 4/5
   * precedent of never asserting a one-directional invariant without also
   * proving it doesn't degenerate into a trivial always-false/always-true
   * check).
   */
  controlQueryObjectId: string;
  description: string;
}

const CYCLE_RING_LENGTH_MIN = 1;
const CYCLE_RING_LENGTH_MAX = 5;
const CYCLE_MAX_DEPTH = 50; // generous and fixed — this variant is about cycle detection, never about depth accounting, so the ceiling must never itself bind here.
const CEILING_PINNED_MAX_DEPTH_MIN = 3;
const CEILING_PINNED_MAX_DEPTH_MAX = 6;
const CEILING_CHAIN_BUFFER_MIN = 4; // how far the chain must run PAST pinnedMaxDepth — generous, not tuned tight, so this never accidentally lands exactly on an off-by-one boundary this file doesn't need to hand-derive precisely (unlike D-070's own exact accounting, which a DIFFERENT, narrower purpose needed).
const CEILING_CHAIN_BUFFER_MAX = 8;

/**
 * Builds ONE randomly-parameterized mechanism-1 fixture. Deterministic given
 * `seed` alone: every namespace/object name is seed-salted (never colliding
 * with a sibling seed's own fixture in the same shared database, matching
 * this project's own established per-seed-salt convention), and `cutKind`
 * itself (cycle vs. depth-ceiling) is drawn from `seed`'s own RNG stream, not
 * a caller-supplied flag — so a caller sweeping many seeds gets a real,
 * unforced mix of both cut kinds, and both ring parity (odd/even ring
 * lengths) and chain length vary from seed to seed too.
 *
 * **Why every ring/chain node needs its own `grant` tuple (both variants).**
 * `view = grant - parent->view`: if some ANCESTOR node along the walk had no
 * `grant` tuple, `evalRewrite`'s own `exclusion` case would short-circuit on
 * that node's own `base` being certainly `false` — a REAL, certain "not
 * excluded" (allowed) conclusion, reached without ever hitting the cycle
 * guard or the depth ceiling at all. That would silently stop exercising
 * this property's own intended shape partway through a random sweep,
 * without any test failing to say so — granting every node along the
 * walk closes that gap by construction, guaranteeing the walk always
 * reaches the real cut (cycle revisit, or `depth > maxDepth`) instead of an
 * unrelated, legitimate early exit.
 */
export function buildMechanism1Fixture(seed: string): Mechanism1Fixture {
  const rng = buildRng(seed);
  const ns = `mex1_${saltFor(seed)}`;
  const schemaSource = [
    `namespace ${ns} {`,
    `  relation parent: ${ns}`,
    '  relation grant: user',
    '',
    '  permission view = grant - parent->view',
    '}',
  ].join('\n');

  const subjectId = `mex1_subj_${saltFor(seed)}`;
  const tuples: FixtureTuple[] = [];

  const cutKind: Mechanism1CutKind = rng.nextBoolean(0.5) ? 'cycle' : 'depthCeiling';

  let unprovableQueryObjectIds: string[];
  let pinnedMaxDepth: number;
  let description: string;

  if (cutKind === 'cycle') {
    const ringLength = rng.nextIntBetween(CYCLE_RING_LENGTH_MIN, CYCLE_RING_LENGTH_MAX);
    const ringIds = Array.from({ length: ringLength }, (_, i) => `ring${i}`);
    for (let i = 0; i < ringLength; i += 1) {
      const current = ringIds[i];
      const next = ringIds[(i + 1) % ringLength];
      if (current === undefined || next === undefined) {
        throw new Error('buildMechanism1Fixture: unreachable ring index out of range');
      }
      tuples.push(tuple(ns, current, 'grant', 'user', subjectId));
      tuples.push(tuple(ns, current, 'parent', ns, next));
    }
    unprovableQueryObjectIds = ringIds;
    pinnedMaxDepth = CYCLE_MAX_DEPTH;
    description = `seed=${seed}: a ${ringLength}-node self-referential 'parent' ring inside 'view = grant - parent->view''s own subtract branch (every ring node granted) — the TS-level 'visited'-Set cycle guard must catch this and deny, never grant, at any ring node`;
  } else {
    const localPinnedMaxDepth = rng.nextIntBetween(
      CEILING_PINNED_MAX_DEPTH_MIN,
      CEILING_PINNED_MAX_DEPTH_MAX,
    );
    const buffer = rng.nextIntBetween(CEILING_CHAIN_BUFFER_MIN, CEILING_CHAIN_BUFFER_MAX);
    const chainLength = localPinnedMaxDepth + buffer; // comfortably past the pinned ceiling — see this file's own doc comment on why a generous, untuned buffer is deliberate here.
    const chainIds = Array.from({ length: chainLength }, (_, i) => `chain${i}`);
    for (let i = 0; i < chainLength; i += 1) {
      const current = chainIds[i];
      if (current === undefined) {
        throw new Error('buildMechanism1Fixture: unreachable chain index out of range');
      }
      tuples.push(tuple(ns, current, 'grant', 'user', subjectId));
      const next = chainIds[i + 1];
      if (next !== undefined) {
        tuples.push(tuple(ns, current, 'parent', ns, next));
      }
      // The last node (`chainIds[chainLength - 1]`) deliberately gets no
      // `parent` tuple at all — a real dead end this walk is never expected
      // to reach (the pinned ceiling cuts it off first); nothing about this
      // property depends on what, if anything, would happen past it.
    }
    const top = chainIds[0];
    if (top === undefined) {
      throw new Error('buildMechanism1Fixture: unreachable — chainLength is always >= 1');
    }
    unprovableQueryObjectIds = [top];
    pinnedMaxDepth = localPinnedMaxDepth;
    description = `seed=${seed}: a ${chainLength}-hop-deep, non-cyclic 'parent' chain (every node granted) queried at pinnedMaxDepth=${localPinnedMaxDepth}, comfortably shorter than the chain — the depth ceiling must cut this off as UNPROVABLE, never treat the cut as 'subtract disproven'`;
  }

  // The control construct — same namespace, disjoint object ids from either
  // variant above (`ctrl_*`, never `ring*`/`chain*`), a real, SHORT,
  // certainly-not-excluded exclusion: `ctrl_top` is granted and its one
  // `parent` hop (`ctrl_bottom`) has no `grant` tuple and no further
  // `parent` tuple of its own — a genuine, certain, single-hop disproof of
  // `subtract`, reachable well within `pinnedMaxDepth` regardless of which
  // variant this seed drew.
  tuples.push(tuple(ns, 'ctrl_top', 'grant', 'user', subjectId));
  tuples.push(tuple(ns, 'ctrl_top', 'parent', ns, 'ctrl_bottom'));
  // ctrl_bottom deliberately gets no 'grant' and no 'parent' tuple at all.

  return {
    seed,
    cutKind,
    schemaSource,
    namespace: ns,
    permissionName: 'view',
    subjectId,
    tuples,
    unprovableQueryObjectIds,
    pinnedMaxDepth,
    controlQueryObjectId: 'ctrl_top',
    description,
  };
}

// ---------------------------------------------------------------------------
// Mechanism 2 — `sqlRelationMembershipWithWitness` (SQL relation-membership
// recursion), reached when `subtract` is a bare `computedUserset` naming a
// plain declared RELATION with a self-referential userset subject type.
// ---------------------------------------------------------------------------

export interface Mechanism2Fixture {
  seed: string;
  schemaSource: string;
  docNamespace: string;
  groupNamespace: string;
  permissionName: string; // 'view'
  /** Number of nested `group#member` hops between `subtract`'s own root tuple and the real, terminal plain grant to `subjectId` — see this file's own doc comment for the exact depth-accounting derivation this number feeds. */
  chainLength: number;
  subjectId: string;
  tuples: FixtureTuple[];
  queryObjectId: string;
  /**
   * `= chainLength` exactly — `fetchReachableFrontier`'s own recursive CTE
   * requires `m.depth < maxDepth` to expand a frontier row one further hop;
   * reaching the chain's OWN terminal group node (`chainLength` hops from
   * `subtract`'s own root row, itself at depth 0) needs `maxDepth >=
   * chainLength`. Pinning `ctx.maxDepth` to exactly `chainLength` (not
   * `chainLength - 1`, and not `chainLength + 1`) means the terminal node's
   * own row is never reached — real reachable graph left unexplored, the
   * exact shape D-158's own report disclosed as mechanism 2's unclosed
   * residual risk. Derived directly from `resolve()`'s own depth-passing
   * (an exclusion's `subtract` runs at the SAME depth as its `base` — only
   * entering a PERMISSION increments `resolve()`'s own depth counter, and
   * `subtract` here is a bare relation, never a permission) and confirmed
   * against a live fixture at this exact shape before this generator was
   * written (see this property's own file for the reproduction).
   */
  cutoffMaxDepth: number;
  /** `= chainLength + 1` — the smallest budget that genuinely, certainly reaches the real terminal membership; used as this property's own natural-boundary control (see `naturalBoundaryMaxDepth`'s own consumer). */
  naturalBoundaryMaxDepth: number;
  description: string;
}

const MECHANISM_2_CHAIN_LENGTH_MIN = 2;
const MECHANISM_2_CHAIN_LENGTH_MAX = 5;

/**
 * Builds ONE randomly-parameterized mechanism-2 fixture — the SQL relation-
 * membership shape a sibling investigation (see this repo's own worktree
 * history around the identical D-158 residual) found live-reproducible via
 * `sqlRelationMembershipWithWitness`'s own depth ceiling reporting `certain:
 * true` unconditionally on its own `false` outcome. This generator produces
 * MANY structurally-varying instances of that exact shape (different
 * namespace names, different chain lengths — never just the one hand-built
 * fixture) rather than re-parametrizing a single hardcoded case.
 */
export function buildMechanism2Fixture(seed: string): Mechanism2Fixture {
  const rng = buildRng(seed);
  const groupNs = `mex2g_${saltFor(seed)}`;
  const docNs = `mex2d_${saltFor(seed)}`;
  const schemaSource = [
    `namespace ${groupNs} {`,
    `  relation member: user | ${groupNs}#member`,
    '',
    '  permission view = member',
    '}',
    '',
    `namespace ${docNs} {`,
    '  relation grant: user',
    `  relation blocked: user | ${groupNs}#member`,
    '',
    '  permission view = grant - blocked',
    '}',
  ].join('\n');

  const chainLength = rng.nextIntBetween(
    MECHANISM_2_CHAIN_LENGTH_MIN,
    MECHANISM_2_CHAIN_LENGTH_MAX,
  );
  const subjectId = `mex2_subj_${saltFor(seed)}`;
  const queryObjectId = 'd1';
  const groupIds = Array.from({ length: chainLength }, (_, i) => `g${i}`);

  const tuples: FixtureTuple[] = [];
  tuples.push(tuple(docNs, queryObjectId, 'grant', 'user', subjectId));
  const firstGroup = groupIds[0];
  if (firstGroup === undefined) {
    throw new Error('buildMechanism2Fixture: unreachable — chainLength is always >= 2');
  }
  tuples.push(tuple(docNs, queryObjectId, 'blocked', groupNs, firstGroup, 'member'));
  for (let i = 0; i < chainLength - 1; i += 1) {
    const current = groupIds[i];
    const next = groupIds[i + 1];
    if (current === undefined || next === undefined) {
      throw new Error('buildMechanism2Fixture: unreachable group-chain index out of range');
    }
    tuples.push(tuple(groupNs, current, 'member', groupNs, next, 'member'));
  }
  const lastGroup = groupIds[chainLength - 1];
  if (lastGroup === undefined) {
    throw new Error('buildMechanism2Fixture: unreachable — chainLength is always >= 2');
  }
  tuples.push(tuple(groupNs, lastGroup, 'member', 'user', subjectId));

  return {
    seed,
    schemaSource,
    docNamespace: docNs,
    groupNamespace: groupNs,
    permissionName: 'view',
    chainLength,
    subjectId,
    tuples,
    queryObjectId,
    cutoffMaxDepth: chainLength,
    naturalBoundaryMaxDepth: chainLength + 1,
    description: `seed=${seed}: a ${chainLength}-hop-deep real '${groupNs}#member' chain wired into '${docNs}'s own 'blocked' relation, itself 'view = grant - blocked''s subtract branch — subject IS genuinely, really a member of 'blocked' (a real grant exists at the chain's own terminal group), just past a pinned maxDepth=${chainLength} that cannot reach it`,
  };
}
