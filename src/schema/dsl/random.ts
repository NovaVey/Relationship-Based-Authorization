/**
 * A seeded random *schema* generator — emits a valid, compiled schema
 * (type definitions, relations with type restrictions, and rewrite rules
 * of configurable depth and operator mix), not a random tuple graph over
 * a fixed schema. `src/soundness/generators.ts`'s `generateFixture` is a
 * different thing: a fixed three-namespace-role skeleton (group/hier/
 * resource) with randomized tuple *data* layered on top, purpose-built
 * for Phase 5's differential fuzzer. This module has no namespace-role
 * skeleton at all — every namespace, relation, and permission in its
 * output is generated, and the *shape itself* (namespace count, relation
 * type restrictions, rewrite-rule depth and operator mix) is what varies
 * by seed and by caller-supplied option.
 *
 * Written once, here, so both the DST harness and the schema verifier's
 * own differential tests (§8b of the verifier's build spec: "on small
 * random schemas from §2b, run the verifier against a deliberately dumb
 * exhaustive checker") draw from one generator rather than each growing
 * its own copy.
 *
 * **Constructive correctness, not generate-and-filter.** Every schema
 * this module can produce is built to satisfy `compiler.ts`'s semantic
 * rules by construction — no permission ever depends on itself or a
 * later-declared permission in the same namespace (rules out
 * `circular_permission_definition` by construction, since the dependency
 * graph is acyclic by build order), a `tupleToUserset` rule only ever
 * follows a relation whose subject types are *all* namespaces declared in
 * this same compilation unit (rules out `tuple_to_userset_unknown_
 * namespace`/`tuple_to_userset_unknown_target`), and every namespace/
 * relation/permission name is index-derived and therefore unique by
 * construction (rules out `duplicate_namespace`/`duplicate_member_name`).
 * The generated source is still run through the real `compileSchema` —
 * never hand-assembled into a `CompiledSchema` directly — both because
 * that is the only source of truth for what this DSL means (see this
 * package's own "don't reimplement the parser" discipline) and because a
 * thrown compile failure here is the fastest possible signal that this
 * file's own "constructive correctness" claim has a bug in it.
 *
 * **Two kinds of subject type, deliberately:** a "structural" namespace
 * (a real, generated `namespace X { ... }` block, eligible as a
 * `tupleToUserset` target) and a "principal" type (a bare identifier with
 * no namespace block at all — exactly how `user` is used throughout
 * `schema/example.authz`: never declared, never validated, a terminal
 * subject with nothing to walk). A relation is `tupleToUserset`-eligible
 * only when every one of its subject types is structural — matching
 * `compiler.ts`'s own `tupleToUserset` validation, which checks *every*
 * subject type of the followed relation against the compilation unit and
 * would reject a bare, undeclared principal type outright.
 */
import { integer, sample } from 'fast-check';

import { compileSchema } from './compiler.js';
import { formatSchemaError } from './errors.js';
import type { CompiledSchema } from './types.js';

// ---------------------------------------------------------------------------
// Seeded RNG — deliberately not imported from `src/soundness/generators.ts`.
// That module already exports an equivalent `SeededRng`/`hashSeedToInt31`
// pair, but importing it here would make `schema/dsl/` (the foundational
// layer every other module compiles against) depend upward on `soundness/`
// (a module built on top of `schema/dsl/`) — backwards layering for a
// four-line hash function and a thin draw-pool wrapper. Same technique
// (`fast-check`'s seeded, pure-JS `sample(integer(...), { seed, numRuns })`
// — no new dependency, no `Math.random()`, no wall-clock), independently
// implemented to keep this module self-contained. See `docs/DECISIONS.md`.
// ---------------------------------------------------------------------------

function hashSeedToInt31(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0) & 0x7fffffff;
}

class SeededDraws {
  private readonly pool: readonly number[];
  private cursor = 0;

  constructor(pool: readonly number[]) {
    this.pool = pool;
  }

  private drawRaw(): number {
    if (this.cursor >= this.pool.length) {
      throw new Error(
        `random schema generator exhausted its deterministic draw pool ` +
          `(${this.pool.length} draws) — this is a generator sizing bug ` +
          `(see buildDrawPool in src/schema/dsl/random.ts), never a random failure.`,
      );
    }
    const value = this.pool[this.cursor];
    this.cursor += 1;
    if (value === undefined) {
      throw new Error('unreachable: SeededDraws draw pool index within bounds was undefined');
    }
    return value;
  }

  /** A uniform integer in `[min, max]` — both ends inclusive. */
  nextIntBetween(min: number, max: number): number {
    if (max < min) {
      throw new Error(`SeededDraws.nextIntBetween: max (${max}) < min (${min})`);
    }
    return min + (this.drawRaw() % (max - min + 1));
  }

  /** `true` with probability `probabilityTrue` (default even odds). */
  nextBoolean(probabilityTrue = 0.5): boolean {
    return this.drawRaw() / 0x7fffffff < probabilityTrue;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('SeededDraws.pick: cannot pick from an empty array');
    }
    const item = items[this.drawRaw() % items.length];
    if (item === undefined) {
      throw new Error('unreachable: SeededDraws.pick index within bounds was undefined');
    }
    return item;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Which rewrite-rule operators the generator is allowed to use, beyond the
 * always-available `computedUserset` leaf. Every field defaults to `true`.
 * Disabling `intersection` and `exclusion` together produces a schema in
 * the monotone fragment — exactly the dial the schema verifier's own §7
 * fragment-detection tests need (a schema built with both off is provably
 * in the fragment where the verifier is exact; one built with either on
 * is provably not).
 */
export interface RandomSchemaOperatorMix {
  union?: boolean;
  intersection?: boolean;
  exclusion?: boolean;
  tupleToUserset?: boolean;
}

export interface RandomSchemaOptions {
  /** Structural (real, generated `namespace { ... }`) type count. Random in `[2, 4]` if omitted. */
  namespaceCount?: number;
  /** Bare, undeclared principal type count (mirrors `user` — never a namespace block). Random in `[1, 2]` if omitted. */
  principalCount?: number;
  /** Upper bound on relations declared per namespace. Default `3`. */
  maxRelationsPerNamespace?: number;
  /** Upper bound on permissions declared per namespace. Default `2`. */
  maxPermissionsPerNamespace?: number;
  /** Upper bound on rewrite-rule combinator nesting depth within one permission. Default `2`. */
  maxRewriteDepth?: number;
  /** Which operators may appear. All default to `true`. */
  operators?: RandomSchemaOperatorMix;
}

export interface RandomSchema {
  seed: string;
  options: Required<Omit<RandomSchemaOptions, 'operators'>> & {
    operators: Required<RandomSchemaOperatorMix>;
  };
  /** DSL source text, printed from the generated structure — always fed through the real `compileSchema`, never hand-assembled. */
  source: string;
  /** The real compiler's own output for `source`. */
  schema: CompiledSchema;
}

const DEFAULT_MAX_RELATIONS_PER_NAMESPACE = 3;
const DEFAULT_MAX_PERMISSIONS_PER_NAMESPACE = 2;
const DEFAULT_MAX_REWRITE_DEPTH = 2;

/**
 * Rejects an out-of-range option with a clear, dedicated message — before
 * generation starts, not as an incidental crash partway through (e.g.
 * `namespaceCount: 0` would otherwise surface as `compileSchema` rejecting
 * an empty source, and `principalCount: 0` would otherwise surface as
 * `SeededDraws.pick`'s generic "cannot pick from an empty array", neither
 * of which names the actual problem: a caller-supplied option, not this
 * generator's own construction logic).
 */
function validateOptions(options: RandomSchemaOptions): void {
  const checks: Array<[string, number | undefined, number]> = [
    ['namespaceCount', options.namespaceCount, 1],
    ['principalCount', options.principalCount, 1],
    ['maxRelationsPerNamespace', options.maxRelationsPerNamespace, 1],
    ['maxPermissionsPerNamespace', options.maxPermissionsPerNamespace, 1],
    ['maxRewriteDepth', options.maxRewriteDepth, 0],
  ];
  for (const [name, value, min] of checks) {
    if (value !== undefined && (!Number.isInteger(value) || value < min)) {
      throw new Error(
        `generateRandomSchema: options.${name} must be an integer >= ${min}, got ${JSON.stringify(value)}`,
      );
    }
  }
}

function resolveOptions(rng: SeededDraws, options: RandomSchemaOptions): RandomSchema['options'] {
  return {
    namespaceCount: options.namespaceCount ?? rng.nextIntBetween(2, 4),
    principalCount: options.principalCount ?? rng.nextIntBetween(1, 2),
    maxRelationsPerNamespace:
      options.maxRelationsPerNamespace ?? DEFAULT_MAX_RELATIONS_PER_NAMESPACE,
    maxPermissionsPerNamespace:
      options.maxPermissionsPerNamespace ?? DEFAULT_MAX_PERMISSIONS_PER_NAMESPACE,
    maxRewriteDepth: options.maxRewriteDepth ?? DEFAULT_MAX_REWRITE_DEPTH,
    operators: {
      union: options.operators?.union ?? true,
      intersection: options.operators?.intersection ?? true,
      exclusion: options.operators?.exclusion ?? true,
      tupleToUserset: options.operators?.tupleToUserset ?? true,
    },
  };
}

// ---------------------------------------------------------------------------
// Draw-pool sizing — generous, not tuned tight. See `SeededDraws.drawRaw`'s
// own thrown error if this is ever wrong; a schema graph here is "tens of
// nodes" (per the verifier's own build spec §1), so even a very cheap
// over-provision leaves enormous headroom.
// ---------------------------------------------------------------------------

function buildDrawPool(seed: string, options: RandomSchemaOptions): SeededDraws {
  const namespaceCeiling = options.namespaceCount ?? 4;
  const relationsCeiling = options.maxRelationsPerNamespace ?? DEFAULT_MAX_RELATIONS_PER_NAMESPACE;
  const permissionsCeiling =
    options.maxPermissionsPerNamespace ?? DEFAULT_MAX_PERMISSIONS_PER_NAMESPACE;
  const depthCeiling = options.maxRewriteDepth ?? DEFAULT_MAX_REWRITE_DEPTH;
  // Per permission, the rewrite tree can have up to roughly 2^depth leaves,
  // each leaf/combinator costing a handful of draws — generous per-leaf
  // budget, not a tight count.
  const perPermissionBudget = 2 ** (depthCeiling + 2) * 6;
  const poolSize =
    64 + namespaceCeiling * (relationsCeiling * 5 + permissionsCeiling * perPermissionBudget);
  const numericSeed = hashSeedToInt31(seed);
  const pool = sample(integer({ min: 0, max: 0x7fffffff }), {
    seed: numericSeed,
    numRuns: poolSize,
  });
  return new SeededDraws(pool);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

interface GeneratedRelation {
  name: string;
  /** DSL-source subject-type fragments, e.g. `"user"`, `"ns0"`, `"ns0#rel1"`. */
  subjectTypeSource: string[];
  /** `true` iff every subject type points at a structural namespace declared in this unit — the `tupleToUserset`-eligibility condition. */
  grounded: boolean;
}

interface GeneratedNamespace {
  name: string;
  relations: GeneratedRelation[];
  /**
   * Every member name declared so far (relations, in order, then
   * permissions, in order). Used for `computedUserset`/`tupleToUserset`
   * target lookups, where either kind is a legal target
   * (`hasRelationOrPermission`, `compiler.ts`) — never for a relation's
   * own `namespace#relation`-style subject type, where the target MUST be
   * a relation (`subject_type_targets_a_permission` otherwise); that case
   * picks from `relations` directly instead. See `generateNamespace`.
   */
  memberNames: string[];
  permissionSource: Map<string, string>;
}

/** One `tupleToUserset`-eligible hop: a relation on the current namespace, and the member name it may recurse into (present on every one of that relation's — necessarily structural — target namespaces). */
interface EligibleHop {
  relationName: string;
  computedUserset: string;
}

/** Builds one rewrite-rule expression (DSL source text) of bounded depth. */
function buildRewriteExpr(
  rng: SeededDraws,
  ns: GeneratedNamespace,
  eligibleHops: EligibleHop[],
  referenceableNames: readonly string[],
  operators: Required<RandomSchemaOperatorMix>,
  depthBudget: number,
): string {
  const leafChoices: Array<() => string> = [];
  if (referenceableNames.length > 0) {
    leafChoices.push(() => rng.pick(referenceableNames));
  }
  if (operators.tupleToUserset && eligibleHops.length > 0) {
    leafChoices.push(() => {
      const hop = rng.pick(eligibleHops);
      return `${hop.relationName}->${hop.computedUserset}`;
    });
  }
  // Leaf choices are never empty by construction: a permission is only
  // ever generated for a namespace that has at least one relation (see
  // `generateNamespace`), and that relation's own name is always a valid
  // `referenceableNames` entry for the namespace's first permission.

  const combinators: Array<'union' | 'intersection' | 'exclusion'> = [];
  if (operators.union) combinators.push('union');
  if (operators.intersection) combinators.push('intersection');
  if (operators.exclusion) combinators.push('exclusion');

  const canCombine = depthBudget > 0 && combinators.length > 0;
  if (!canCombine || rng.nextBoolean(0.4)) {
    return rng.pick(leafChoices)();
  }

  const child = (): string => {
    const expr = buildRewriteExpr(
      rng,
      ns,
      eligibleHops,
      referenceableNames,
      operators,
      depthBudget - 1,
    );
    // Grammar: `expression := term ((| |-) term)*`, `term := atom (& atom)*`,
    // `atom := "(" expression ")" | IDENT ("->" IDENT)?`. A bare
    // computedUserset/tupleToUserset atom never needs parens; anything else
    // (union/intersection/exclusion) always does, in every operand
    // position this function ever places a child — always-parenthesize is
    // simple and always grammatically legal (`MAX_EXPRESSION_NESTING_DEPTH`
    // is 100; this generator's own depth is at most a handful).
    const isBareAtom = !expr.includes(' ');
    return isBareAtom ? expr : `(${expr})`;
  };

  const kind = rng.pick(combinators);
  if (kind === 'union') {
    const arity = rng.nextIntBetween(2, 3);
    return Array.from({ length: arity }, child).join(' | ');
  }
  if (kind === 'intersection') {
    const arity = rng.nextIntBetween(2, 3);
    return Array.from({ length: arity }, child).join(' & ');
  }
  // exclusion
  return `${child()} - ${child()}`;
}

function generateNamespace(
  rng: SeededDraws,
  name: string,
  principalNames: readonly string[],
  earlierNamespaces: readonly GeneratedNamespace[],
  options: RandomSchema['options'],
): GeneratedNamespace {
  const ns: GeneratedNamespace = {
    name,
    relations: [],
    memberNames: [],
    permissionSource: new Map(),
  };

  const relationCount = rng.nextIntBetween(1, Math.max(1, options.maxRelationsPerNamespace));
  for (let r = 0; r < relationCount; r += 1) {
    const relationName = `rel${r}`;
    // Subject-type mix: a bare principal, a bare earlier structural
    // namespace ("direct object-object", like `parent: folder`), or an
    // earlier structural namespace's own member ("nested userset", like
    // `member: group#member`) — 1-2 of these per relation, matching
    // `schema/example.authz`'s own real mixes (`editor: user |
    // group#member`).
    const subjectTypeSource: string[] = [];
    let grounded = true;
    const pieceCount = earlierNamespaces.length > 0 ? rng.nextIntBetween(1, 2) : 1;
    for (let p = 0; p < pieceCount; p += 1) {
      const kindChoices: Array<'principal' | 'structural-bare' | 'structural-member'> = [
        'principal',
      ];
      if (earlierNamespaces.length > 0) {
        kindChoices.push('structural-bare');
        kindChoices.push('structural-member');
      }
      const kind = rng.pick(kindChoices);
      if (kind === 'principal') {
        subjectTypeSource.push(rng.pick(principalNames));
        grounded = false;
      } else {
        const target = rng.pick(earlierNamespaces);
        if (kind === 'structural-bare') {
          subjectTypeSource.push(target.name);
        } else {
          // A relation's own `namespace#relation`-style subject type must
          // target a *relation* — never a permission
          // (`subject_type_targets_a_permission`, `compiler.ts`), unlike a
          // `tupleToUserset`'s `computedUserset` target below, which may be
          // either. `target.relations` is never empty: every earlier
          // namespace was itself given at least one relation.
          const member = rng.pick(target.relations).name;
          subjectTypeSource.push(`${target.name}#${member}`);
        }
      }
    }
    // Avoid a relation with the identical subject-type fragment repeated —
    // cosmetic only (the compiler accepts duplicates fine), skipped for a
    // cleaner printed schema.
    const uniqueSubjectTypes = [...new Set(subjectTypeSource)];
    ns.relations.push({ name: relationName, subjectTypeSource: uniqueSubjectTypes, grounded });
    ns.memberNames.push(relationName);
  }

  const eligibleHops: EligibleHop[] = [];
  for (const relation of ns.relations) {
    if (!relation.grounded) continue;
    // The `computedUserset` name must exist on *every* target namespace of
    // this relation's subject types — intersect their own member-name
    // sets. Every structural namespace here has ≥1 relation, so the
    // intersection is only empty if the relation mixes two structural
    // targets with disjoint member names, which a random choice of
    // `computedUserset` from the intersection (when non-empty) or a skip
    // (when empty) both handle safely.
    const targetMemberSets = relation.subjectTypeSource
      .map((s) => s.split('#')[0])
      .map((targetName) => earlierNamespaces.find((n) => n.name === targetName))
      .filter((n): n is GeneratedNamespace => n !== undefined)
      .map((n) => new Set(n.memberNames));
    if (targetMemberSets.length === 0) continue;
    const [first, ...rest] = targetMemberSets;
    const intersection = [...first!].filter((name) => rest.every((set) => set.has(name)));
    if (intersection.length === 0) continue;
    eligibleHops.push({ relationName: relation.name, computedUserset: rng.pick(intersection) });
  }

  const permissionCount = rng.nextIntBetween(1, Math.max(1, options.maxPermissionsPerNamespace));
  for (let k = 0; k < permissionCount; k += 1) {
    const permissionName = `perm${k}`;
    // Referenceable-by-computedUserset names: every relation on this
    // namespace, plus every *earlier* permission on this namespace —
    // never this permission itself or a later one, which is what keeps
    // the dependency graph acyclic by construction.
    const referenceableNames = [
      ...ns.relations.map((r) => r.name),
      ...ns.memberNames.slice(ns.relations.length),
    ];
    const expr = buildRewriteExpr(
      rng,
      ns,
      eligibleHops,
      referenceableNames,
      options.operators,
      options.maxRewriteDepth,
    );
    ns.permissionSource.set(permissionName, expr);
    ns.memberNames.push(permissionName);
  }

  return ns;
}

function printNamespace(ns: GeneratedNamespace): string {
  const lines: string[] = [`namespace ${ns.name} {`];
  for (const relation of ns.relations) {
    lines.push(`  relation ${relation.name}: ${relation.subjectTypeSource.join(' | ')}`);
  }
  for (const [name, expr] of ns.permissionSource) {
    lines.push(`  permission ${name} = ${expr}`);
  }
  lines.push('}');
  return lines.join('\n');
}

/**
 * Generates a random, valid schema — deterministic given `seed` and
 * `options`: the same two inputs always produce byte-identical `source`
 * and a deep-equal `schema`. Throws if the generated source fails to
 * compile through the real `compileSchema` (a bug in this generator's own
 * "constructive correctness" claim, never an expected outcome — see this
 * file's own top-of-file doc comment).
 */
export function generateRandomSchema(
  seed: string,
  options: RandomSchemaOptions = {},
): RandomSchema {
  validateOptions(options);
  const sizingRng = buildDrawPool(seed, options);
  const resolved = resolveOptions(sizingRng, options);
  // `resolveOptions` may itself draw (for any option left unset) — done
  // against the *same* pool/cursor the rest of generation continues from,
  // so a single `buildDrawPool` call and a single `SeededDraws` instance
  // drive the whole run, keeping determinism a property of `seed`+
  // `options` alone, not of internal call order.

  const principalNames = Array.from({ length: resolved.principalCount }, (_, i) => `principal${i}`);
  const namespaces: GeneratedNamespace[] = [];
  for (let i = 0; i < resolved.namespaceCount; i += 1) {
    namespaces.push(generateNamespace(sizingRng, `ns${i}`, principalNames, namespaces, resolved));
  }

  const source = namespaces.map(printNamespace).join('\n\n') + '\n';
  const result = compileSchema(source);
  if (!result.ok) {
    throw new Error(
      `generateRandomSchema(seed=${JSON.stringify(seed)}) produced a schema the real compiler ` +
        `rejected — this is a generator bug, not an expected outcome:\n` +
        result.errors.map(formatSchemaError).join('\n') +
        `\n\n--- generated source ---\n${source}`,
    );
  }
  return { seed, options: resolved, source, schema: result.schema };
}
