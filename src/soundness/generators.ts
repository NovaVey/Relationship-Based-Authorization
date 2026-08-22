/**
 * Random (schema, tuple-graph, query) generation for Phase 5's differential
 * soundness fuzzer — see `.claude/commands/build-authz-service.md` §6.2,
 * §6.8, and §9 Phase 5's exit criteria. `runner.ts` is the only intended
 * caller of `generateFixture`; this file has zero knowledge of Postgres,
 * the reference resolver, or the production resolver — it only produces
 * plain data (a DSL source string, tuples, queries) plus metadata
 * (`docs/DECISIONS.md`-worthy design notes below).
 *
 * **Determinism (§6.8): every value below is derived from `seed` alone.**
 * The only sources of randomness this file ever touches are (a) a seeded
 * `fast-check` integer stream (`fc.sample(fc.integer(...), { seed, numRuns
 * })`), which is backed by a pure-JS PRNG (`pure-rand`) with no dependency
 * on `Math.random()`, wall-clock time, or any platform-specific entropy
 * source, and (b) fixed, hand-written word banks / template shapes. Given
 * the same seed string, every draw this module makes is byte-identical on
 * any machine, every time — verified directly (see this phase's
 * verification report) by generating twice from one seed and diffing the
 * output, not assumed from "it's deterministic in theory."
 *
 * **Why `fast-check` here, not a hand-rolled PRNG:** §2 lists `fast-check`
 * as this project's property-based fuzzing library, and it ships a
 * seeded, pure-JS random source (`pure-rand`, a transitive dependency)
 * with no platform-dependent behavior — exactly what a byte-for-byte
 * reproducible generator needs, and there's no concrete reason to
 * hand-roll an equivalent. What this file does NOT do is compose
 * `fast-check` *arbitraries* (`fc.record`, `fc.array`, shrinking, etc.) to
 * build the fixture: those combinators are built for "generate broadly,
 * shrink a failing case toward a minimal one," which is the wrong shape
 * for this task's actual requirement — *guaranteeing* specific structural
 * properties (every rewrite-rule kind present, a cycle present) by
 * construction, every run, not by generating broadly and hoping. Instead,
 * `fc.sample(fc.integer(...), { seed, numRuns })` is used once to draw a
 * large, deterministic pool of raw integers, and a small local
 * `SeededRng` class turns that pool into `nextInt`/`pick`/`shuffle`
 * helpers driving plain, imperative, guarantee-shaped construction code
 * below. See `docs/DECISIONS.md` for this recorded as its own decision.
 *
 * **Why every generated namespace name carries a seed-derived salt:** this
 * generator writes real rows into a live, shared `relation_tuples` table
 * across many runs (different seeds, potentially the same run replayed).
 * `relation_tuples` has no per-run partition — a tuple written under
 * `object_ns = 'doc'` by one run is visible to *any* later check against
 * `doc`, forever, regardless of which run wrote it. The reference resolver
 * only ever sees *this run's own* in-memory tuple array, but the
 * production resolver reads the live table directly — so if two different
 * seeds independently chose the plain word `doc` as a namespace name, a
 * stale tuple from an unrelated earlier run could make the production
 * resolver see a grant the reference resolver (this run's own tuples only)
 * has no way to know about, producing a spurious `false_grant` that has
 * nothing to do with a real resolver bug — exactly the kind of
 * self-inflicted false positive this project's own standard (§0 rule 9,
 * the `soundness-engineer` brief) warns against mistaking for a genuine
 * finding. Salting every generated namespace name with a short,
 * seed-derived, deterministic suffix (`doc_<base36-hash-of-seed>`) makes
 * two different seeds' namespaces collide only in the astronomically
 * unlikely event of a 31-bit hash collision, while the *same* seed always
 * reproduces the *same* salted names — preserving byte-for-byte
 * reproducibility. `user:*` subject ids are deliberately left unsalted and
 * freely reused across runs: the object side of every check is always
 * salted-unique per run, so a shared `user:u0` subject id occurring in two
 * unrelated runs' tuples can never cause cross-run leakage (queries are
 * always anchored to a specific, run-unique object). See
 * `docs/DECISIONS.md`.
 */
import { randomUUID } from 'node:crypto';
import { integer, sample } from 'fast-check';

import { compileSchema } from '../schema/dsl/compiler.js';
import { formatSchemaError } from '../schema/dsl/errors.js';
import type { CompiledRelation, CompiledSchema, RewriteRule } from '../schema/dsl/types.js';

// ---------------------------------------------------------------------------
// Public data shapes
// ---------------------------------------------------------------------------

/** A namespaced entity reference — the same `{ ns, id }` shape both resolvers use. */
export interface GeneratedEntityRef {
  ns: string;
  id: string;
}

/**
 * One generated relation-tuple fact. Field-for-field identical to
 * `src/store/tuples.ts`'s `TupleKey` and `src/resolve/reference/
 * resolver.ts`'s `ReferenceTuple` — deliberately redefined here rather
 * than imported, matching `docs/DECISIONS.md` D-022's own precedent, so
 * this generator has no import-time coupling to the store or either
 * resolver. `runner.ts` passes these values directly to `writeTuple` and
 * `referenceCheck` — structurally compatible, never re-mapped.
 */
export interface GeneratedTuple {
  objectNs: string;
  objectId: string;
  relation: string;
  subjectNs: string;
  subjectId: string;
  /** Present only for a userset subject (`group:eng#member`). */
  subjectRelation?: string;
}

/** One generated (subject, relation-or-permission, object) query to check. */
export interface GeneratedQuery {
  subject: GeneratedEntityRef;
  object: GeneratedEntityRef;
  relationOrPermission: string;
}

/**
 * Fuzz-harness-level metadata about one generated namespace — in
 * particular, `critical`. **This is not a DSL feature.** §6.5's prose
 * describes a namespace "flagged critical in its schema," but §5's actual
 * grammar has no such flag, and extending Phase 1's already-shipped
 * grammar to add one is out of this phase's scope (Phase 1 is done; this
 * isn't a Phase 1 gap this phase should reopen). `critical` is tracked
 * here, entirely outside the DSL text, and threaded through
 * `runner.ts`/`classify.ts` to populate `soundness_runs
 * .critical_namespace_false_grants`. See `docs/DECISIONS.md`.
 */
export interface GeneratedNamespaceMeta {
  namespace: string;
  critical: boolean;
}

/** Which of the four meaningful `RewriteRule` kinds were found in the generated schema. */
export interface RewriteRuleKindCoverage {
  union: boolean;
  intersection: boolean;
  exclusion: boolean;
  tupleToUserset: boolean;
}

/**
 * The generator's own self-check that its "guaranteed, not probabilistic"
 * coverage requirements actually held for this run — audited against the
 * *actual* compiled schema and tuple graph, not trusted from construction
 * logic alone (construction logic can have bugs; this check independently
 * re-derives the answer from the artifact itself). `ok` is what
 * `computeVerdict` (`classify.ts`) reads to decide `insufficient_coverage`.
 */
export interface CoverageReport {
  rewriteRuleKinds: RewriteRuleKindCoverage;
  hasCycle: boolean;
  ok: boolean;
}

/** Everything one differential-fuzz run needs: a compilable schema, a tuple graph, and queries. */
export interface GeneratedFixture {
  seed: string;
  schemaSource: string;
  namespaces: GeneratedNamespaceMeta[];
  tuples: GeneratedTuple[];
  queries: GeneratedQuery[];
  coverage: CoverageReport;
}

/** A fresh, unseeded seed value — used when a caller omits `seed` entirely (still recorded afterward). */
export function generateRandomSeed(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Seeded randomness — a deterministic draw pool sourced from fast-check
// ---------------------------------------------------------------------------

/**
 * FNV-1a, 32-bit, masked into the non-negative 31-bit range `fc.sample`'s
 * own `seed` option expects ("seeds are supposed to be 32-bit integers").
 * Pure, deterministic, platform-independent — no `Buffer`, no `crypto`
 * hash, just arithmetic, so this can never itself be a source of
 * cross-machine nondeterminism. Exported alongside `SeededRng` — see that
 * class's own doc comment for why (DST D3's own graph generator needs the
 * identical seed string -> `fc.sample`-compatible-int31 conversion, not a
 * second, hand-copied version of this same tiny function).
 */
export function hashSeedToInt31(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0) & 0x7fffffff;
}

/**
 * How many raw integer draws this generator's own construction logic can
 * ever need, sized with generous headroom rather than tuned tight — a
 * `SeededRng` that runs out throws a specific, loud "generator sizing bug"
 * error (see `SeededRng.drawRaw`) rather than silently wrapping around and
 * quietly breaking determinism or reusing entropy. `queryCount` scales the
 * pool because query generation is the one phase whose draw count is
 * genuinely proportional to a caller-supplied number, not a small,
 * schema-shaped constant.
 */
const DRAW_POOL_BASE_SIZE = 4_000;
const DRAW_POOL_PER_QUERY = 12;

/**
 * Exported (this file's own doc comment above already explains why
 * `fast-check`/`pure-rand` is this whole module's chosen entropy source,
 * not a new hand-rolled PRNG) for outside reuse, per `docs/DST-PROPOSAL.md`'s
 * own phased plan requiring "this project's already-seeded fast-check/
 * pure-rand machinery, not a new PRNG" -- this class *is* that machinery.
 * Two outside consumers so far: DST D3's own random userset-subject-edge
 * graph generator (`test/unit/resolve/production/frontier-equivalence
 * .integration.test.ts`, `docs/DECISIONS.md` D-100), and DST D4's own
 * shared `dstRngFromSeed` (`src/store/dst/scheduler.ts`, `docs/DECISIONS.md`
 * D-101). Each builds its own draw pool sized for its own needs (this
 * file's own `buildRng` below sizes for *this* generator's needs
 * specifically, via `DRAW_POOL_BASE_SIZE`/`DRAW_POOL_PER_QUERY` -- not a
 * one-size-fits-all a different caller should reuse as-is) via
 * `sample(integer(...), { seed: hashSeedToInt31(seed), numRuns:
 * <caller-sized> })` -- `hashSeedToInt31` exported alongside this class for
 * exactly that.
 */
export class SeededRng {
  private readonly pool: readonly number[];
  private cursor = 0;

  constructor(pool: readonly number[]) {
    this.pool = pool;
  }

  private drawRaw(): number {
    if (this.cursor >= this.pool.length) {
      throw new Error(
        `soundness fixture generator exhausted its deterministic draw pool ` +
          `(${this.pool.length} draws) — this is a generator sizing bug (see ` +
          `DRAW_POOL_BASE_SIZE/DRAW_POOL_PER_QUERY in src/soundness/generators.ts), ` +
          `never a random failure.`,
      );
    }
    const value = this.pool[this.cursor];
    this.cursor += 1;
    if (value === undefined) {
      // Unreachable given the bounds check above — `noUncheckedIndexedAccess`
      // still types `pool[cursor]` as possibly-undefined.
      throw new Error('unreachable: SeededRng draw pool index within bounds was undefined');
    }
    return value;
  }

  /** A uniform integer in `[0, exclusiveMax)`. */
  nextInt(exclusiveMax: number): number {
    if (exclusiveMax <= 0) {
      throw new Error(`SeededRng.nextInt: exclusiveMax must be positive, got ${exclusiveMax}`);
    }
    return this.drawRaw() % exclusiveMax;
  }

  /** A uniform integer in `[min, max]` — both ends inclusive. */
  nextIntBetween(min: number, max: number): number {
    if (max < min) {
      throw new Error(`SeededRng.nextIntBetween: max (${max}) < min (${min})`);
    }
    return min + this.nextInt(max - min + 1);
  }

  /** `true` with probability `probabilityTrue` (default even odds). */
  nextBoolean(probabilityTrue = 0.5): boolean {
    return this.drawRaw() / 0x7fffffff < probabilityTrue;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('SeededRng.pick: cannot pick from an empty array');
    }
    const item = items[this.nextInt(items.length)];
    if (item === undefined) {
      throw new Error('unreachable: SeededRng.pick index within bounds was undefined');
    }
    return item;
  }

  /** A Fisher-Yates shuffle, deterministic given this RNG's own draw sequence. */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const a = copy[i];
      const b = copy[j];
      if (a === undefined || b === undefined) {
        throw new Error('unreachable: SeededRng.shuffle index out of range');
      }
      copy[i] = b;
      copy[j] = a;
    }
    return copy;
  }
}

function buildRng(seed: string, queryCount: number): { rng: SeededRng; numericSeed: number } {
  const numericSeed = hashSeedToInt31(seed);
  const poolSize = DRAW_POOL_BASE_SIZE + Math.max(0, queryCount) * DRAW_POOL_PER_QUERY;
  const pool = sample(integer({ min: 0, max: 0x7fffffff }), {
    seed: numericSeed,
    numRuns: poolSize,
  });
  return { rng: new SeededRng(pool), numericSeed };
}

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Namespace / schema construction
// ---------------------------------------------------------------------------

const NAMESPACE_WORDS = [
  'doc',
  'folder',
  'group',
  'org',
  'project',
  'space',
  'repo',
  'ticket',
  'asset',
  'room',
  'board',
  'workspace',
] as const;

const RELATION_WORDS = [
  'owner',
  'editor',
  'viewer',
  'admin',
  'member',
  'approver',
  'reviewer',
  'banned',
  'watcher',
  'contributor',
  'maintainer',
  'guest',
] as const;

const PERMISSION_WORDS = [
  'view',
  'edit',
  'manage',
  'access',
  'read',
  'write',
  'moderate',
  'publish',
  'archive',
  'approve',
] as const;

const CORE_NAMESPACE_COUNT = 3;
const MIN_EXTRA_NAMESPACES = 1;
const MAX_EXTRA_NAMESPACES = 3;
const OBJECTS_PER_NAMESPACE_MIN = 3;
const OBJECTS_PER_NAMESPACE_MAX = 6;
const USER_COUNT_MIN = 6;
const USER_COUNT_MAX = 12;

/**
 * The guaranteed deep chain (D-070, see `docs/DECISIONS.md`) — sizing
 * constants only; the construction itself is `buildGuaranteedDeepChain`
 * below. Hardcoded relative to `env.CHECK_MAX_DEPTH`'s *documented default*
 * (25 — `src/config/env.ts`, `.env.example`), deliberately not read from
 * `env.ts` itself: this file stays as free of runtime-config coupling as
 * the reference resolver keeps itself of `env.ts` (see that file's own doc
 * comment on `ReferenceCheckOptions.maxDepth` — "this resolver stays pure
 * and env-independent"), and every other constant in this section is
 * already a hardcoded, non-configurable choice. If a future change moves
 * `CHECK_MAX_DEPTH`'s default away from 25, these numbers stop landing
 * exactly on the real ceiling but remain structurally meaningful (a chain
 * comfortably past half of *whatever* the real default happens to be) —
 * see D-070's own "Revisit if".
 *
 * `DEEP_CHAIN_HIER_HOPS` (24) is the full length of the guaranteed
 * `hierNs` parent chain (`dc_h0..dc_h24`) — the largest number of
 * `tupleToUserset` hops `resolve()`'s own TS-level depth ceiling permits
 * before entering `dc_h0`'s `editor` relation (`D + 1 <= CHECK_MAX_DEPTH`,
 * i.e. `D <= 24`), so a query anchored at `dc_h24` sits exactly at that
 * boundary.
 *
 * `DEEP_CHAIN_ISOLATED_HOP` (13) is where the chain's *pure* tupleToUserset
 * cost (no relation-lookup budget involved at all — the witness grant is a
 * plain, direct tuple on `dc_h0.editor`) is queried, comfortably past half
 * of 24 — deep enough that D-069 bug 2's double-charging (each hop costing
 * 2 instead of 1) pushes the *buggy* total (2 x 13 = 26) past the ceiling
 * while the *correct* total (13) stays comfortably inside it.
 *
 * `DEEP_CHAIN_INTERMEDIATE_HOP` (12) is where the two group-chain-combo
 * witnesses (below) are queried: `D = 12` real `tupleToUserset` hops
 * already spent (entering `dc_h0`'s `editor` relation lookup at TS-depth
 * `13`) before a nested-`group#member` chain of length `k` is walked
 * *inside* that one relation lookup's own SQL-level budget
 * (`remainingDepth = CHECK_MAX_DEPTH - 13 = 12`) — the exact "remaining
 * budget after N prior hops" vs. "full budget" split D-069 bug 1 confused.
 *
 * `DEEP_CHAIN_GROUP_HOPS_INSIDE`/`_OUTSIDE` (12 / 13) are the two nested
 * `groupNs#member` chain lengths queried against `dc_h12`: `12` sits
 * exactly at the shared `D + k <= CHECK_MAX_DEPTH - 1` boundary (`12 + 12
 * = 24`, allowed under correctly-scoped accounting at a *shared* ceiling);
 * `13` sits one hop past it (`12 + 13 = 25`, denied under correctly-scoped
 * accounting at a shared ceiling, but wrongly *allowed* by D-069 bug 1's
 * unreduced `ctx.maxDepth` budget — see D-070 for the full derivation and
 * its live-verified numbers).
 */
// Exported (not just module-private, unlike this file's other sizing
// constants) specifically so `test/unit/soundness/generators.test.ts` can
// assert against the exact same numbers this file uses to build the chain,
// rather than a second, hand-copied set of literals that could silently
// drift from these if either changed.
export const DEEP_CHAIN_HIER_HOPS = 24;
export const DEEP_CHAIN_ISOLATED_HOP = 13;
export const DEEP_CHAIN_INTERMEDIATE_HOP = 12;
export const DEEP_CHAIN_GROUP_HOPS_INSIDE = 12;
export const DEEP_CHAIN_GROUP_HOPS_OUTSIDE = 13;

/** Dedicated, never-shared-with-`userIds` witness subjects for the guaranteed deep chain — see `buildGuaranteedDeepChain`. */
export const DEEP_CHAIN_DIRECT_GRANT_USER = 'deep_chain_direct_grant_witness';
export const DEEP_CHAIN_COMBO_INSIDE_USER = 'deep_chain_combo_inside_witness';
export const DEEP_CHAIN_COMBO_OUTSIDE_USER = 'deep_chain_combo_outside_witness';

/**
 * The group-shaped namespace — always namespace #0. Its `member` relation
 * accepts `user | <self>#member`, the exact shape a nested-group cycle
 * needs (§6.4's own worked example: `group:a` nests `group:b` nests
 * `group:a`). This namespace is where the guaranteed cycle (below) always
 * lives.
 */
function buildGroupNamespaceSource(name: string): string {
  return [
    `namespace ${name} {`,
    `  relation member: user | ${name}#member`,
    '',
    '  permission view = member',
    '}',
  ].join('\n');
}

/**
 * The hierarchical namespace — always namespace #1. `parent->view` is the
 * one guaranteed `tupleToUserset` construct; `editor | parent->view` is
 * also a guaranteed `union`.
 */
function buildHierNamespaceSource(name: string, groupName: string): string {
  return [
    `namespace ${name} {`,
    `  relation parent: ${name}`,
    `  relation editor: user | ${groupName}#member`,
    '',
    '  permission view = editor | parent->view',
    '}',
  ].join('\n');
}

/**
 * The resource namespace — always namespace #2. Hosts the guaranteed
 * `intersection` (`trusted_edit`) and `exclusion` (`unbanned_view`)
 * constructs, plus a second `tupleToUserset` (`parent_link->view`,
 * crossing into the hierarchical namespace) for realism — mirrors §5's own
 * `document`/`folder` worked example shape.
 */
function buildResourceNamespaceSource(name: string, groupName: string, hierName: string): string {
  return [
    `namespace ${name} {`,
    '  relation owner: user',
    `  relation editor: user | ${groupName}#member`,
    `  relation viewer: user | ${groupName}#member`,
    '  relation banned: user',
    `  relation parent_link: ${hierName}`,
    '',
    '  permission view = viewer | editor | owner | parent_link->view',
    '  permission trusted_edit = editor & owner',
    '  permission unbanned_view = viewer - banned',
    '}',
  ].join('\n');
}

/** Picks a word from `wordBank` not already in `used`, falling back to a numbered variant if exhausted. */
function pickUniqueName(
  rng: SeededRng,
  wordBank: readonly string[],
  used: ReadonlySet<string>,
): string {
  const available = wordBank.filter((word) => !used.has(word));
  if (available.length > 0) {
    return rng.pick(available);
  }
  const base = rng.pick(wordBank);
  let suffix = 1;
  let candidate = `${base}_${suffix}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}_${suffix}`;
  }
  return candidate;
}

/**
 * A random, always-valid rewrite-rule expression built only from names
 * already known to exist (`citable`) — guaranteed to compile by
 * construction, never by hoping a reference happens to resolve. Every
 * composite node is defensively parenthesized so operator precedence
 * (`docs/DECISIONS.md` D-011) can never produce a surprising parse for
 * randomly-composed text.
 */
function buildRandomRewriteExpr(
  rng: SeededRng,
  citable: readonly string[],
  depthBudget: number,
): string {
  if (citable.length === 0) {
    throw new Error('buildRandomRewriteExpr: no citable relation/permission names available');
  }
  if (depthBudget <= 0 || rng.nextBoolean(0.45)) {
    return rng.pick(citable);
  }
  const kind = rng.pick(['union', 'intersection', 'exclusion'] as const);
  if (kind === 'union') {
    const childCount = rng.nextIntBetween(2, 3);
    const children = Array.from({ length: childCount }, () =>
      buildRandomRewriteExpr(rng, citable, depthBudget - 1),
    );
    return `(${children.join(' | ')})`;
  }
  if (kind === 'intersection') {
    const a = buildRandomRewriteExpr(rng, citable, depthBudget - 1);
    const b = buildRandomRewriteExpr(rng, citable, depthBudget - 1);
    return `(${a} & ${b})`;
  }
  const base = buildRandomRewriteExpr(rng, citable, depthBudget - 1);
  const subtract = buildRandomRewriteExpr(rng, citable, depthBudget - 1);
  return `(${base} - ${subtract})`;
}

/**
 * An "extra" namespace layered on top of the three guaranteed-shape ones,
 * for schema-shape variety beyond what the coverage requirement demands.
 * Deliberately restricted to `user` and `<groupName>#member` subject
 * types only (never a plain cross-namespace or self-referencing relation
 * type) — both are always valid regardless of generation order or which
 * other extra namespaces exist, which is what keeps "guaranteed to
 * compile" a real guarantee rather than a probabilistic hope for this
 * part of the schema too.
 */
function buildExtraNamespaceSource(rng: SeededRng, name: string, groupName: string): string {
  const relationCount = rng.nextIntBetween(1, 3);
  const usedNames = new Set<string>();
  const relationLines: string[] = [];
  const relationNames: string[] = [];
  const subjectTypeOptions = ['user', `${groupName}#member`];

  for (let i = 0; i < relationCount; i += 1) {
    const relationName = pickUniqueName(rng, RELATION_WORDS, usedNames);
    usedNames.add(relationName);
    relationNames.push(relationName);
    const typeCount = rng.nextIntBetween(1, subjectTypeOptions.length);
    const chosenTypes = rng.shuffle(subjectTypeOptions).slice(0, typeCount);
    relationLines.push(`  relation ${relationName}: ${chosenTypes.join(' | ')}`);
  }

  const permissionCount = rng.nextIntBetween(1, 3);
  const citable = [...relationNames];
  const permissionLines: string[] = [];
  for (let i = 0; i < permissionCount; i += 1) {
    const permissionName = pickUniqueName(rng, PERMISSION_WORDS, usedNames);
    usedNames.add(permissionName);
    const expr = buildRandomRewriteExpr(rng, citable, 2);
    permissionLines.push(`  permission ${permissionName} = ${expr}`);
    citable.push(permissionName);
  }

  return [`namespace ${name} {`, ...relationLines, '', ...permissionLines, '}'].join('\n');
}

// ---------------------------------------------------------------------------
// Tuple graph construction
// ---------------------------------------------------------------------------

interface ObjectEntity {
  ns: string;
  id: string;
  /** A single, global, strictly increasing creation index — see this file's own doc comment on cycle avoidance. */
  order: number;
}

/**
 * Composite key for tuple-level deduplication — random generation can
 * otherwise draw the same (object, relation, subject) triple twice, which
 * `writeTuple` would happily accept as an idempotent no-op (`created:
 * false`) but which would make `fixture.tuples.length` (reported as
 * `soundness_runs.tuple_count`) overcount the graph's real distinct edges.
 */
function tupleKey(t: GeneratedTuple): string {
  return `${t.objectNs}\0${t.objectId}\0${t.relation}\0${t.subjectNs}\0${t.subjectId}\0${t.subjectRelation ?? ''}`;
}

/**
 * Randomly assigns 0-3 subjects for one `(object, relation)` pair, drawing
 * only from subjects that already exist. For a namespace-typed subject
 * type (plain or userset), the candidate pool is filtered to objects whose
 * `order` is strictly less than `object`'s own — the single rule that
 * makes every *randomly generated* userset-subject or tuple-to-userset
 * edge provably acyclic (a directed edge can only ever point to a
 * strictly-earlier-created node, so no cycle can form), leaving the one
 * deliberately hand-inserted cycle (see `generateFixture`) as the run's
 * only cycle, guaranteed and unambiguous rather than incidental.
 */
function assignRandomTuples(
  rng: SeededRng,
  addTuple: (t: GeneratedTuple) => void,
  object: ObjectEntity,
  relation: CompiledRelation,
  objectsByNs: ReadonlyMap<string, ObjectEntity[]>,
  userIds: readonly string[],
): void {
  if (relation.subjectTypes.length === 0) return;
  if (!rng.nextBoolean(0.55)) return;

  const attempts = rng.nextIntBetween(1, 3);
  for (let i = 0; i < attempts; i += 1) {
    const subjectType = rng.pick(relation.subjectTypes);
    if (subjectType.namespace === 'user' && subjectType.relation === undefined) {
      addTuple({
        objectNs: object.ns,
        objectId: object.id,
        relation: relation.name,
        subjectNs: 'user',
        subjectId: rng.pick(userIds),
      });
      continue;
    }
    const candidates = (objectsByNs.get(subjectType.namespace) ?? []).filter(
      (candidate) => candidate.order < object.order,
    );
    if (candidates.length === 0) continue;
    const subject = rng.pick(candidates);
    addTuple({
      objectNs: object.ns,
      objectId: object.id,
      relation: relation.name,
      subjectNs: subject.ns,
      subjectId: subject.id,
      ...(subjectType.relation !== undefined ? { subjectRelation: subjectType.relation } : {}),
    });
  }
}

/** Every `(ns, id)` reserved by `buildGuaranteedDeepChain` — excluded from `assignRandomTuples` below so no randomly drawn edge can ever shorten or lengthen the hand-derived chain it built. */
export interface DeepChainReservedKeys {
  readonly keys: ReadonlySet<string>;
}

function deepChainReservationKey(ns: string, id: string): string {
  return `${ns}\0${id}`;
}

/** The three hand-derivable query witnesses `buildGuaranteedDeepChain` produces — see `generateFixture`'s "Reserved seed queries" section for how each becomes a query, and this file's own `DEEP_CHAIN_*` constants' doc comment for the full numeric derivation. */
export interface DeepChainWitnesses {
  /** `dc_h{DEEP_CHAIN_ISOLATED_HOP}` — a pure tupleToUserset chain, no relation-lookup budget involved; isolates D-069 bug 2. */
  isolatedHopObject: GeneratedEntityRef;
  /** `dc_h{DEEP_CHAIN_HIER_HOPS}` — the TS-level ceiling boundary itself; exercises D-069 bug 3 (not independently isolated from bug 2 — both affect the same TS-level hop count). */
  ceilingBoundaryObject: GeneratedEntityRef;
  /** `dc_h{DEEP_CHAIN_INTERMEDIATE_HOP}` — where the two group-chain-combo witnesses below are queried. */
  comboObject: GeneratedEntityRef;
  directGrantUser: string;
  comboInsideUser: string;
  comboOutsideUser: string;
  reserved: DeepChainReservedKeys;
}

/**
 * The guaranteed deep chain (D-070, `docs/DECISIONS.md`) — inserted into
 * every fixture the same deliberate way the guaranteed cycle
 * (`generateFixture`, below) is: created first, in strictly increasing
 * `order`, entirely independent of any randomly drawn structure, so a
 * consumer can reason about its exact real length by construction rather
 * than by chance. Reuses `hierNs`'s existing `parent`/`editor`/`view` shape
 * and `groupNs`'s existing `member`/`view` shape (both already compiled
 * into the schema by `buildHierNamespaceSource`/`buildGroupNamespaceSource`
 * — no new namespace, no new rewrite-rule shape) with a deliberately long,
 * deliberately placed set of real tuples along those existing relations.
 *
 * Shape (see the `DEEP_CHAIN_*` constants above for exactly why these
 * numbers):
 *
 * ```
 * dc_h{DEEP_CHAIN_HIER_HOPS} -parent-> ... -parent-> dc_h{DEEP_CHAIN_INTERMEDIATE_HOP} -parent-> ... -parent-> dc_h0
 * ```
 *
 * `dc_h0.editor` carries two real, independent tuples: a PLAIN grant
 * straight to `DEEP_CHAIN_DIRECT_GRANT_USER` (no userset hop — `k = 0` for
 * that witness), and a userset edge into a *second*, separate nested-group
 * chain rooted at `dc_g0`:
 *
 * ```
 * dc_g0 -member-> dc_g1#member -member-> ... -member-> dc_g{DEEP_CHAIN_GROUP_HOPS_INSIDE - 1}#member
 * ```
 *
 * with `dc_g{DEEP_CHAIN_GROUP_HOPS_INSIDE - 1}` (`dc_g11`) carrying a
 * PLAIN grant to `DEEP_CHAIN_COMBO_INSIDE_USER` *and* one further userset
 * edge to `dc_g{DEEP_CHAIN_GROUP_HOPS_OUTSIDE - 1}#member` (`dc_g12`),
 * which carries a PLAIN grant to `DEEP_CHAIN_COMBO_OUTSIDE_USER`.
 *
 * Every edge here points from a just-created object to an already-created
 * one (`dc_h{i}.parent -> dc_h{i-1}`, `dc_g{i}.member -> dc_g{i+1}#member`
 * — note the group chain's direction is the reverse of its creation order,
 * which is fine: `hasUsersetCycle`'s acyclicity guarantee only cares that
 * *no* directed cycle exists among userset-subject edges, never that every
 * edge points backward in creation order — that stronger rule is specific
 * to `assignRandomTuples`'s own *randomly drawn* edges, the mechanism that
 * actually needs a cheap, syntactic acyclicity proof since it has no other
 * way to guarantee one; this hand-built chain is provably acyclic by
 * inspection, a straight-line path with no repeated node), so this
 * structure is, by construction, a simple acyclic path — no interaction
 * with the guaranteed cycle (`cycleA`/`cycleB`, also in `groupNs`, disjoint
 * object ids) either.
 */
function buildGuaranteedDeepChain(
  createObject: (ns: string, id: string) => ObjectEntity,
  addTuple: (t: GeneratedTuple) => void,
  groupNs: string,
  hierNs: string,
): DeepChainWitnesses {
  const reservedKeys = new Set<string>();
  const reserve = (ns: string, id: string): void => {
    reservedKeys.add(deepChainReservationKey(ns, id));
  };

  // The nested-group chain (built first, deepest-independent — dc_h0's
  // editor tuple below references dc_g0, which must already exist).
  const groupChain: ObjectEntity[] = [];
  for (let i = 0; i < DEEP_CHAIN_GROUP_HOPS_OUTSIDE; i += 1) {
    const g = createObject(groupNs, `dc_g${i}`);
    reserve(g.ns, g.id);
    groupChain.push(g);
  }
  for (let i = 0; i < DEEP_CHAIN_GROUP_HOPS_OUTSIDE - 1; i += 1) {
    const from = requireDefined(groupChain[i], 'generator: deep chain group object missing');
    const to = requireDefined(groupChain[i + 1], 'generator: deep chain group object missing');
    addTuple({
      objectNs: groupNs,
      objectId: from.id,
      relation: 'member',
      subjectNs: groupNs,
      subjectId: to.id,
      subjectRelation: 'member',
    });
  }
  const insideGroup = requireDefined(
    groupChain[DEEP_CHAIN_GROUP_HOPS_INSIDE - 1],
    'generator: deep chain "inside" group object missing',
  );
  addTuple({
    objectNs: groupNs,
    objectId: insideGroup.id,
    relation: 'member',
    subjectNs: 'user',
    subjectId: DEEP_CHAIN_COMBO_INSIDE_USER,
  });
  const outsideGroup = requireDefined(
    groupChain[DEEP_CHAIN_GROUP_HOPS_OUTSIDE - 1],
    'generator: deep chain "outside" group object missing',
  );
  addTuple({
    objectNs: groupNs,
    objectId: outsideGroup.id,
    relation: 'member',
    subjectNs: 'user',
    subjectId: DEEP_CHAIN_COMBO_OUTSIDE_USER,
  });

  // The hier parent chain, created dc_h0 (root) first, then dc_h1..dc_hN —
  // matching `assignRandomTuples`'s own "point only to an earlier-created
  // object" convention even though (per this function's own doc comment)
  // nothing here actually depends on that filter, since these tuples are
  // hand-inserted directly via `addTuple`, never routed through
  // `assignRandomTuples`.
  const hierChain: ObjectEntity[] = [];
  for (let i = 0; i <= DEEP_CHAIN_HIER_HOPS; i += 1) {
    const h = createObject(hierNs, `dc_h${i}`);
    reserve(h.ns, h.id);
    hierChain.push(h);
  }
  for (let i = 1; i <= DEEP_CHAIN_HIER_HOPS; i += 1) {
    const child = requireDefined(hierChain[i], 'generator: deep chain hier object missing');
    const parent = requireDefined(hierChain[i - 1], 'generator: deep chain hier object missing');
    addTuple({
      objectNs: hierNs,
      objectId: child.id,
      relation: 'parent',
      subjectNs: hierNs,
      subjectId: parent.id,
    });
  }
  const root = requireDefined(hierChain[0], 'generator: deep chain hier root missing');
  const groupRoot = requireDefined(groupChain[0], 'generator: deep chain group root missing');
  addTuple({
    objectNs: hierNs,
    objectId: root.id,
    relation: 'editor',
    subjectNs: 'user',
    subjectId: DEEP_CHAIN_DIRECT_GRANT_USER,
  });
  addTuple({
    objectNs: hierNs,
    objectId: root.id,
    relation: 'editor',
    subjectNs: groupNs,
    subjectId: groupRoot.id,
    subjectRelation: 'member',
  });

  const isolatedHopObject = requireDefined(
    hierChain[DEEP_CHAIN_ISOLATED_HOP],
    'generator: deep chain isolated-hop object missing',
  );
  const ceilingBoundaryObject = requireDefined(
    hierChain[DEEP_CHAIN_HIER_HOPS],
    'generator: deep chain ceiling-boundary object missing',
  );
  const comboObject = requireDefined(
    hierChain[DEEP_CHAIN_INTERMEDIATE_HOP],
    'generator: deep chain combo object missing',
  );

  return {
    isolatedHopObject: { ns: isolatedHopObject.ns, id: isolatedHopObject.id },
    ceilingBoundaryObject: { ns: ceilingBoundaryObject.ns, id: ceilingBoundaryObject.id },
    comboObject: { ns: comboObject.ns, id: comboObject.id },
    directGrantUser: DEEP_CHAIN_DIRECT_GRANT_USER,
    comboInsideUser: DEEP_CHAIN_COMBO_INSIDE_USER,
    comboOutsideUser: DEEP_CHAIN_COMBO_OUTSIDE_USER,
    reserved: { keys: reservedKeys },
  };
}

// ---------------------------------------------------------------------------
// Coverage self-check
// ---------------------------------------------------------------------------

/** Compile-time exhaustiveness guard — independently written, not imported from either resolver's own copy (see `docs/DECISIONS.md` D-022). */
function assertNeverRewriteRule(node: never): never {
  throw new Error(`generators.ts: unhandled rewrite-rule kind ${JSON.stringify(node)}`);
}

/**
 * Walks every permission's rewrite tree across every namespace and records
 * which of the four meaningful `RewriteRule` kinds actually appear in the
 * *compiled* schema — audited against the real artifact, not trusted from
 * the construction logic that was supposed to guarantee it.
 */
export function checkRewriteRuleCoverage(schema: CompiledSchema): RewriteRuleKindCoverage {
  const found: RewriteRuleKindCoverage = {
    union: false,
    intersection: false,
    exclusion: false,
    tupleToUserset: false,
  };

  function walk(node: RewriteRule): void {
    switch (node.kind) {
      case 'union':
        found.union = true;
        node.children.forEach(walk);
        return;
      case 'intersection':
        found.intersection = true;
        node.children.forEach(walk);
        return;
      case 'exclusion':
        found.exclusion = true;
        walk(node.base);
        walk(node.subtract);
        return;
      case 'tupleToUserset':
        found.tupleToUserset = true;
        return;
      case 'computedUserset':
        return;
      default:
        assertNeverRewriteRule(node);
    }
  }

  for (const namespace of Object.values(schema.namespaces)) {
    for (const permission of Object.values(namespace.permissions)) {
      walk(permission.rewrite);
    }
  }
  return found;
}

/**
 * An independent, standalone cycle check over the userset-subject graph
 * (edges: `(objectNs, objectId, relation)` -> `(subjectNs, subjectId,
 * subjectRelation)`, present only where `subjectRelation` is set) — a
 * small, self-contained DFS with grey/black coloring, deliberately
 * *not* shared with either resolver's own cycle-detection code (this is a
 * meta-check on the generator's own output, not a resolver, so it carries
 * none of §6.2's "no shared code" weight either way, but is kept
 * independent anyway as a matter of hygiene — a bug in this function could
 * only ever produce a false `insufficient_coverage` report, never a
 * `false_grant`/`false_deny` miscount, since it's never consulted by
 * `classify.ts`'s per-query verdict).
 */
export function hasUsersetCycle(tuples: readonly GeneratedTuple[]): boolean {
  const edges = new Map<string, string[]>();
  for (const t of tuples) {
    if (t.subjectRelation === undefined) continue;
    const from = `${t.objectNs}\0${t.objectId}\0${t.relation}`;
    const to = `${t.subjectNs}\0${t.subjectId}\0${t.subjectRelation}`;
    const existing = edges.get(from);
    if (existing) {
      existing.push(to);
    } else {
      edges.set(from, [to]);
    }
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, 0 | 1 | 2>();

  function dfs(node: string): boolean {
    color.set(node, GREY);
    for (const next of edges.get(node) ?? []) {
      const nextColor = color.get(next) ?? WHITE;
      if (nextColor === GREY) return true;
      if (nextColor === WHITE && dfs(next)) return true;
    }
    color.set(node, BLACK);
    return false;
  }

  for (const node of edges.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE && dfs(node)) {
      return true;
    }
  }
  return false;
}

function computeCoverageReport(
  schema: CompiledSchema,
  tuples: readonly GeneratedTuple[],
): CoverageReport {
  const rewriteRuleKinds = checkRewriteRuleCoverage(schema);
  const hasCycle = hasUsersetCycle(tuples);
  const ok =
    rewriteRuleKinds.union &&
    rewriteRuleKinds.intersection &&
    rewriteRuleKinds.exclusion &&
    rewriteRuleKinds.tupleToUserset &&
    hasCycle;
  return { rewriteRuleKinds, hasCycle, ok };
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Deterministically generates one complete differential-fuzz fixture from
 * `seed` alone: a compilable multi-namespace DSL source, a tuple graph
 * (guaranteed at least one cycle), and `queryCount` queries drawn from the
 * graph's own entities. See this file's own top-of-file doc comment for
 * the determinism and salting guarantees, and `docs/DECISIONS.md` for why
 * the four required rewrite-rule kinds and the cycle are built first and
 * hand-placed rather than hoped for.
 */
export function generateFixture(seed: string, queryCount: number): GeneratedFixture {
  const { rng, numericSeed } = buildRng(seed, queryCount);
  const salt = numericSeed.toString(36);

  // --- namespaces -----------------------------------------------------
  const extraNamespaceCount = rng.nextIntBetween(MIN_EXTRA_NAMESPACES, MAX_EXTRA_NAMESPACES);
  const totalNamespaceCount = CORE_NAMESPACE_COUNT + extraNamespaceCount;
  const chosenWords = rng.shuffle(NAMESPACE_WORDS).slice(0, totalNamespaceCount);
  const chosenNames = chosenWords.map((word) => `${word}_${salt}`);

  const groupNs = requireDefined(chosenNames[0], 'generator: expected a group-namespace name');
  const hierNs = requireDefined(
    chosenNames[1],
    'generator: expected a hierarchical-namespace name',
  );
  const resourceNs = requireDefined(
    chosenNames[2],
    'generator: expected a resource-namespace name',
  );
  const extraNames = chosenNames.slice(CORE_NAMESPACE_COUNT);
  const namespaceOrder = [groupNs, hierNs, resourceNs, ...extraNames];

  const namespaceSources = [
    buildGroupNamespaceSource(groupNs),
    buildHierNamespaceSource(hierNs, groupNs),
    buildResourceNamespaceSource(resourceNs, groupNs, hierNs),
    ...extraNames.map((name) => buildExtraNamespaceSource(rng, name, groupNs)),
  ];
  const schemaSource = namespaceSources.join('\n\n');

  // Self-check: this schema must actually compile. If it doesn't, that's a
  // generator defect, not a fuzz finding — fail loudly rather than hand a
  // broken fixture to the runner.
  const compiled = compileSchema(schemaSource);
  if (!compiled.ok) {
    throw new Error(
      `soundness fixture generator (seed=${seed}) produced a schema that failed to compile — ` +
        `this is a generator bug, not a fuzz finding: ${compiled.errors.map(formatSchemaError).join('; ')}`,
    );
  }
  const schema = compiled.schema;

  const namespaces: GeneratedNamespaceMeta[] = namespaceOrder.map((namespace, index) => ({
    namespace,
    // resourceNs is always critical (the "protected resource" role); each
    // extra namespace is independently, deterministically critical ~25% of
    // the time, for coverage variety in what a real report would show.
    critical: namespace === resourceNs || (index >= CORE_NAMESPACE_COUNT && rng.nextBoolean(0.25)),
  }));

  // --- objects ----------------------------------------------------------
  let creationOrder = 0;
  const objectsByNs = new Map<string, ObjectEntity[]>();
  for (const ns of namespaceOrder) objectsByNs.set(ns, []);

  function createObject(ns: string, id: string): ObjectEntity {
    const entity: ObjectEntity = { ns, id, order: creationOrder };
    creationOrder += 1;
    const list = requireDefined(objectsByNs.get(ns), `generator: namespace ${ns} not initialized`);
    list.push(entity);
    return entity;
  }

  // The guaranteed cycle's two objects are created first, before any other
  // groupNs object, so later random `groupNs#member` grants can validly
  // reference them as "earlier" nodes too.
  const cycleA = createObject(groupNs, 'cycle_a');
  const cycleB = createObject(groupNs, 'cycle_b');

  // --- tuples (declared here, ahead of the random per-namespace object
  // loop below, so both the guaranteed cycle's tuples AND the guaranteed
  // deep chain's — see `buildGuaranteedDeepChain` — can be added
  // immediately after the objects each one needs already exist, while both
  // constructs' own objects still land at the lowest `order` values in
  // their namespace, exactly like `cycleA`/`cycleB` above; this is a
  // structural reordering of what was previously two separate top-level
  // sections, not a behavior change to anything the cycle itself does). ---
  const tuples: GeneratedTuple[] = [];
  const seenTupleKeys = new Set<string>();
  const addTuple = (t: GeneratedTuple): void => {
    const key = tupleKey(t);
    if (seenTupleKeys.has(key)) return;
    seenTupleKeys.add(key);
    tuples.push(t);
  };

  // --- objects (continued) -----------------------------------------------
  // The guaranteed deep chain (D-070, `docs/DECISIONS.md`) — created next,
  // still ahead of the random per-namespace object loop, so `dc_h*`/`dc_g*`
  // also land at the lowest `order` values in `hierNs`/`groupNs` (after the
  // cycle, before anything random) and so no randomly drawn edge
  // (`assignRandomTuples`, below) can ever attach to one of its objects —
  // see `DeepChainReservedKeys` and the skip check in the tuple-generation
  // loop below.
  const deepChain = buildGuaranteedDeepChain(createObject, addTuple, groupNs, hierNs);

  for (const ns of namespaceOrder) {
    const already = requireDefined(
      objectsByNs.get(ns),
      `generator: namespace ${ns} not initialized`,
    ).length;
    const target = rng.nextIntBetween(OBJECTS_PER_NAMESPACE_MIN, OBJECTS_PER_NAMESPACE_MAX);
    for (let i = already; i < target; i += 1) {
      createObject(ns, `o${i}`);
    }
  }

  const userCount = rng.nextIntBetween(USER_COUNT_MIN, USER_COUNT_MAX);
  const userIds = Array.from({ length: userCount }, (_, i) => `u${i}`);
  const cycleWitnessUser = requireDefined(userIds[0], 'generator: expected at least one user id');
  const lonelyUser = requireDefined(
    userIds[userIds.length - 1],
    'generator: expected at least one user id',
  );

  // The guaranteed cycle (§6.4's own worked example): cycle_a's `member`
  // set includes cycle_b's `member` set, and vice versa. Neither grants
  // real membership to anyone by itself.
  addTuple({
    objectNs: groupNs,
    objectId: cycleA.id,
    relation: 'member',
    subjectNs: groupNs,
    subjectId: cycleB.id,
    subjectRelation: 'member',
  });
  addTuple({
    objectNs: groupNs,
    objectId: cycleB.id,
    relation: 'member',
    subjectNs: groupNs,
    subjectId: cycleA.id,
    subjectRelation: 'member',
  });
  // A real, direct grant on cycle_a, outside the cycle itself — gives a
  // hand-derivable "allowed" seed query (see the reserved queries below)
  // and matches the precedent in `cross-resolver-agreement.integration
  // .test.ts`'s own cyclic fixture (a real grant must not be poisoned by
  // an unrelated cycle sitting on the same object).
  addTuple({
    objectNs: groupNs,
    objectId: cycleA.id,
    relation: 'member',
    subjectNs: 'user',
    subjectId: cycleWitnessUser,
  });

  for (const ns of namespaceOrder) {
    const nsConfig = requireDefined(
      schema.namespaces[ns],
      `generator: namespace ${ns} missing after compile`,
    );
    const objects = objectsByNs.get(ns) ?? [];
    for (const object of objects) {
      // The guaranteed deep chain's own objects are hand-wired above and
      // must never receive an *additional*, randomly drawn tuple on top of
      // what `buildGuaranteedDeepChain` deliberately placed — an extra
      // `parent`/`editor`/`member` edge here could shorten (or otherwise
      // change) the hand-derived real chain length the reserved deep-chain
      // queries below depend on, silently invalidating their hand-derived
      // expected answers for whichever seed happened to draw it.
      if (deepChain.reserved.keys.has(deepChainReservationKey(object.ns, object.id))) continue;
      for (const relation of Object.values(nsConfig.relations)) {
        assignRandomTuples(rng, addTuple, object, relation, objectsByNs, userIds);
      }
    }
  }

  // --- queries --------------------------------------------------------
  const checkableNamesByNs = new Map<string, string[]>();
  for (const ns of namespaceOrder) {
    const nsConfig = requireDefined(
      schema.namespaces[ns],
      `generator: namespace ${ns} missing after compile`,
    );
    checkableNamesByNs.set(ns, [
      ...Object.keys(nsConfig.relations),
      ...Object.keys(nsConfig.permissions),
    ]);
  }

  function pickRandomSubjectEntity(): GeneratedEntityRef {
    if (rng.nextBoolean(0.75)) {
      return { ns: 'user', id: rng.pick(userIds) };
    }
    const ns = rng.pick(namespaceOrder);
    const objects = objectsByNs.get(ns) ?? [];
    if (objects.length === 0) {
      return { ns: 'user', id: rng.pick(userIds) };
    }
    const obj = rng.pick(objects);
    return { ns: obj.ns, id: obj.id };
  }

  function pickRandomObjectEntity(): ObjectEntity {
    const ns = rng.pick(namespaceOrder);
    const objects = objectsByNs.get(ns) ?? [];
    return requireDefined(
      objects.length > 0 ? rng.pick(objects) : undefined,
      `generator: namespace ${ns} unexpectedly has no objects`,
    );
  }

  const queries: GeneratedQuery[] = [];

  // Reserved seed queries, both touching the same cyclic object so any
  // consumer can pair them. Only query 1 (index 1, when queryCount >= 2)
  // is unconditionally hand-derivable: `addTuple` never removes a tuple
  // once added, so the direct grant below (line ~826) guarantees it
  // `allowed`, regardless of what else the seed's random draws produce.
  // Query 0 exercises cycle termination end-to-end through an actual
  // query (it forces the walk to traverse `cycleA`'s real tuples,
  // including the cyclic edge into `cycleB` and back) but its own boolean
  // is NOT guaranteed `denied` by construction — `lonelyUser` is drawn
  // from the same `userIds` pool `assignRandomTuples` freely assigns as a
  // subject elsewhere (line ~549), so a coincidental, unrelated random
  // tuple can grant it a real, separate path to the same object for some
  // seeds. (Found via `test-author`'s Phase 5 delegation, which had
  // originally assumed query 0 was denied-by-construction the same way
  // query 1 is allowed-by-construction; a consumer needing a guaranteed
  // "no real path" witness must derive its own, e.g. a subject id proven
  // absent from every generated tuple — see
  // `differential-soundness.fuzz.test.ts`'s own cyclic-termination test
  // for the pattern.)
  if (queryCount >= 1) {
    queries.push({
      subject: { ns: 'user', id: lonelyUser },
      object: { ns: groupNs, id: cycleA.id },
      relationOrPermission: 'view',
    });
  }
  if (queryCount >= 2) {
    queries.push({
      subject: { ns: 'user', id: cycleWitnessUser },
      object: { ns: groupNs, id: cycleA.id },
      relationOrPermission: 'view',
    });
  }

  // Reserved deep-chain seed queries (D-070, `docs/DECISIONS.md`) — indices
  // 2-5, appended after the two cyclic reserved queries above so nothing
  // about their own indices changes. Each is hand-derived against
  // `buildGuaranteedDeepChain`'s exact, deterministic structure — see that
  // function's own doc comment and the `DEEP_CHAIN_*` constants for the
  // full numeric derivation of why each is expected `allowed`/`denied`.
  //
  // - Query 2 (`isolatedHopObject`, `directGrantUser`): a pure
  //   `tupleToUserset` chain, `DEEP_CHAIN_ISOLATED_HOP` (13) hops from a
  //   direct grant, no relation-lookup budget involved at all — hand-
  //   derived ALLOWED under correct depth accounting (13 hops is
  //   comfortably inside the real ceiling), and reliably flips to a new,
  //   isolated `false_deny` if D-069 bug 2 (tupleToUserset's per-hop cost
  //   doubling) regresses, since 2 x 13 = 26 exceeds the ceiling.
  // - Query 3 (`ceilingBoundaryObject`, `directGrantUser`): the same pure
  //   chain at its full `DEEP_CHAIN_HIER_HOPS` (24) length — sits exactly
  //   at the TS-level ceiling boundary (`D + 1 <= CHECK_MAX_DEPTH`, i.e.
  //   `D <= 24`) — hand-derived ALLOWED under the correct `>` comparator,
  //   and flips to `false_deny` if D-069 bug 3's `>=` regresses (not
  //   independently isolated from bug 2 either, since both affect the same
  //   TS-level hop count — matching D-069's own honest disclosure for its
  //   analogous fixture).
  // - Query 4 (`comboObject`, `comboInsideUser`): `DEEP_CHAIN_INTERMEDIATE
  //   _HOP` (12) real `tupleToUserset` hops, landing on a relation lookup
  //   whose own nested-group chain is `DEEP_CHAIN_GROUP_HOPS_INSIDE` (12)
  //   deep — `D + k = 24`, exactly at the shared `D + k <= CHECK_MAX_DEPTH
  //   - 1` boundary. Hand-derived ALLOWED under correctly-scoped depth
  //   accounting at *any* maxDepth both resolvers actually share (as of
  //   D-071, `runSoundnessFuzz`'s own standard/default invocation already
  //   is one — see below — and an explicitly `maxDepth`-pinned call is
  //   another) — demonstrating the deep chain does not, by itself,
  //   introduce a spurious divergence for a correct resolver.
  // - Query 5 (`comboObject`, `comboOutsideUser`): the same combo, one
  //   nested-group hop deeper (`DEEP_CHAIN_GROUP_HOPS_OUTSIDE` = 13,
  //   `D + k = 25`) — one past that boundary. Hand-derived DENIED under
  //   correctly-scoped depth accounting *whenever both resolvers share a
  //   ceiling*. As of D-071 (`docs/DECISIONS.md`), `runSoundnessFuzz`'s own
  //   standard/default invocation (`options.maxDepth` omitted) already
  //   resolves one effective ceiling (`env.CHECK_MAX_DEPTH`) and passes it
  //   to *both* resolvers — so this query is DENIED on both by default too
  //   (agreement, not a divergence) — and reliably reproduces D-069 bug 1
  //   as a genuine `false_grant` at that same standard/default
  //   configuration if that bug regresses, no `maxDepth` pinning required
  //   any more. (Before D-071, `runSoundnessFuzz`'s default left each
  //   resolver to its own independently mismatched default —
  //   `env.CHECK_MAX_DEPTH` for production, the much larger
  //   `DEFAULT_REFERENCE_MAX_DEPTH` for reference — which made this an
  //   expected, non-blocking `false_deny` at the *old* default and meant
  //   catching bug 1 required an explicit `maxDepth` override; see D-070's
  //   own original discussion and D-071's live-verified numbers for the
  //   full before/after story.)
  if (queryCount >= 3) {
    queries.push({
      subject: { ns: 'user', id: deepChain.directGrantUser },
      object: deepChain.isolatedHopObject,
      relationOrPermission: 'view',
    });
  }
  if (queryCount >= 4) {
    queries.push({
      subject: { ns: 'user', id: deepChain.directGrantUser },
      object: deepChain.ceilingBoundaryObject,
      relationOrPermission: 'view',
    });
  }
  if (queryCount >= 5) {
    queries.push({
      subject: { ns: 'user', id: deepChain.comboInsideUser },
      object: deepChain.comboObject,
      relationOrPermission: 'view',
    });
  }
  if (queryCount >= 6) {
    queries.push({
      subject: { ns: 'user', id: deepChain.comboOutsideUser },
      object: deepChain.comboObject,
      relationOrPermission: 'view',
    });
  }

  const reserved = Math.min(6, Math.max(0, queryCount));
  for (let i = reserved; i < queryCount; i += 1) {
    if (tuples.length > 0 && rng.nextBoolean(0.5)) {
      // "Likely positive": derive a query from a real tuple's own object,
      // biasing toward subjects/objects with an actual chance of a path.
      const t = rng.pick(tuples);
      const names = requireDefined(
        checkableNamesByNs.get(t.objectNs),
        `generator: namespace ${t.objectNs} has no checkable names`,
      );
      const subject =
        t.subjectRelation === undefined
          ? { ns: t.subjectNs, id: t.subjectId }
          : pickRandomSubjectEntity();
      queries.push({
        subject,
        object: { ns: t.objectNs, id: t.objectId },
        relationOrPermission: rng.pick(names),
      });
    } else {
      // Fully random, entity-grounded query — the "should mostly deny" side.
      const object = pickRandomObjectEntity();
      const names = requireDefined(
        checkableNamesByNs.get(object.ns),
        `generator: namespace ${object.ns} has no checkable names`,
      );
      queries.push({
        subject: pickRandomSubjectEntity(),
        object: { ns: object.ns, id: object.id },
        relationOrPermission: rng.pick(names),
      });
    }
  }

  const coverage = computeCoverageReport(schema, tuples);

  return { seed, schemaSource, namespaces, tuples, queries, coverage };
}
