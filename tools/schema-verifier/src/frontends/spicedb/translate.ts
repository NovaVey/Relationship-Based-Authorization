/**
 * `./parser.ts`'s raw AST → this tool's own neutral `IrSchema`
 * (`../common/ir.ts`). Three genuinely separate translation problems, all
 * validated against real upstream schemas before writing this file:
 *
 * 1. **`self`** (`thirdparty/README.md`'s own disclosed gap — "no
 *    equivalent here"). See `convertRewrite`'s own doc comment.
 * 2. **A `type#relation` nested-userset subject type whose target is a
 *    computed *permission*, not a storable relation** — this DSL's `#`
 *    syntax can only ever name a relation (`src/schema/dsl/compiler.ts`'s
 *    own validation), but SpiceDB's real grammar places no such
 *    restriction on what a nested-userset subject type may target. Three
 *    cases, confirmed against three *different* real fixtures before
 *    writing `buildMember` below (not assumed from one example
 *    generalized): a target that already IS a relation needs nothing; a
 *    target permission that's exactly a union of bare relations expands
 *    losslessly into one `#`-reference per underlying relation
 *    (`spicedb-github`'s own `team#member` → `team#maintainer |
 *    team#direct_member`, since `permission member = maintainer +
 *    direct_member`); anything else (an arrow, an intersection, an
 *    exclusion, or a union containing any of those) has no `#`-syntax
 *    equivalent at all and is restructured instead — a new bare relation
 *    accepting the target type unconditionally, plus an added arrow term
 *    (`spicedb-docs-style-sharing`'s own `group_with_parent#view` →
 *    `viewer_via_group_with_parent: group_with_parent` +
 *    `viewer_via_group_with_parent->view`, since `permission view =
 *    member + parent->member` is a real computed union with an arrow in
 *    it, not a pure alias). See `buildMember`'s own doc comment for how
 *    this restructuring reuses `../common/ir.ts`'s own `splitMember`
 *    (via the neutral `this` sentinel) rather than duplicating its logic.
 * 3. **An arrow (`R->C`) whose followed relation `R` has a subject type
 *    that doesn't define `C` at all.** SpiceDB's own real runtime
 *    behavior silently treats that branch as empty (no error, no match)
 *    — this project's own `compileSchema` is stricter, requiring *every*
 *    subject type of a followed relation to define the target
 *    (`tuple_to_userset_unknown_target`, `src/schema/dsl/compiler.ts`) —
 *    so a direct syntactic translation of e.g. `spicedb-superuser`'s own
 *    `relation owner: user | organization` + `permission admin = owner +
 *    owner->admin` (where bare `user` has no `admin` at all) would simply
 *    fail to compile. `applyArrowTypeSplit` fixes this generically: a
 *    relation followed by an incompatible arrow anywhere is split by
 *    subject type (`owner_user: user`, `owner_org: organization`,
 *    `permission owner = owner_user | owner_org`), and every arrow
 *    following it is narrowed to only the type(s) that actually define
 *    the target (`owner_org->admin`, never `owner_user->admin`) —
 *    matching SpiceDB's own silent-skip semantics exactly, rather than
 *    reproducing this DSL's stricter compile-time rejection. Confirmed
 *    against exactly one of this survey's seven real fixtures
 *    (`spicedb-superuser` — every other fixture's own arrows already
 *    happen to be fully compatible, checked directly, not assumed): this
 *    pass is a no-op — and never even scans the schema at all — unless a
 *    multi-typed relation genuinely needs it.
 */
import type { IrMember, IrNamespace, IrRewrite, IrSchema, IrSubjectType } from '../common/ir.js';
import type { TranslationNote } from '../common/disclose.js';
import type { ParsedDefinition, ParsedRewrite, ParsedSubjectType } from './parser.js';

export interface TranslateSpicedbOptions {
  /**
   * Default `false`: SpiceDB's `self` keyword anywhere in a permission
   * throws, matching this survey's own established policy of excluding
   * constructs with no equivalent in this DSL outright rather than best-
   * effort-translating them into something that no longer represents the
   * real schema. `true` drops `self` instead, but *only* when it appears
   * as one term of a union (`permission view = viewer + self`, the real,
   * documented shape) — `self` as an entire rewrite alone, or nested
   * inside an intersection/exclusion, has no well-defined "drop" and
   * still throws even under `--best-effort` (see `convertRewrite`'s own
   * doc comment). Every drop is disclosed via a `TranslationNote`, never
   * silent.
   */
  readonly bestEffort?: boolean;
}

export interface TranslateSpicedbResult {
  readonly schema: IrSchema;
  readonly notes: readonly TranslationNote[];
}

class UnsupportedSpicedbConstructError extends Error {}

type MemberInfo =
  { readonly kind: 'relation' } | { readonly kind: 'permission'; readonly rewrite: IrRewrite };
type Lookup = ReadonlyMap<string, ReadonlyMap<string, MemberInfo>>;

/**
 * Converts one parsed rewrite node into the common `IrRewrite`, handling
 * `self` — the one node kind with no `IrRewrite` equivalent at all. A
 * `self` reached where dropping it has no well-defined meaning (as a
 * whole rewrite, or as a lone intersection/exclusion operand) throws
 * unconditionally, `--best-effort` or not; a `self` that is one term of a
 * union is simply omitted from that union under `--best-effort` (and the
 * whole union collapses to its one remaining child if that leaves
 * exactly one, or is `flatMap`-recursed into if more than one) —
 * `permission view = viewer + self` becoming `permission view = viewer`
 * is the real, documented shape this handles
 * (`thirdparty-upstream/spicedb-googledocs-typecheck-bug.mdx`'s own
 * example, though that specific schema isn't part of this survey's
 * checked corpus).
 */
function convertRewrite(
  rule: ParsedRewrite,
  bestEffort: boolean,
  notes: TranslationNote[],
  context: string,
): IrRewrite {
  const result = convertRewriteMaybeDropped(rule, bestEffort, notes, context);
  if (result === undefined) {
    throw new UnsupportedSpicedbConstructError(
      `${context}: uses SpiceDB's 'self' keyword in a position where dropping it has no well-defined meaning (the whole rewrite, or a lone intersection/exclusion operand) — 'self' has no equivalent in this DSL`,
    );
  }
  return result;
}

/** `undefined` return means "this node was `self` and got dropped" — only ever produced when `bestEffort` and only ever consumed by a union's own child-filtering below; every other caller requires a real value via `convertRewrite`. */
function convertRewriteMaybeDropped(
  rule: ParsedRewrite,
  bestEffort: boolean,
  notes: TranslationNote[],
  context: string,
): IrRewrite | undefined {
  switch (rule.kind) {
    case 'self':
      if (!bestEffort) {
        throw new UnsupportedSpicedbConstructError(
          `${context}: uses SpiceDB's 'self' keyword (line ${rule.line}) — this DSL has no equivalent (an object implicitly including itself in its own permission's result set); excluded rather than best-effort translated (pass --best-effort to drop it where it appears as one term of a union, disclosed)`,
        );
      }
      return undefined;
    case 'ref':
      return { kind: 'ref', name: rule.name };
    case 'tupleToUserset':
      return {
        kind: 'tupleToUserset',
        relation: rule.relation,
        computedUserset: rule.computedUserset,
      };
    case 'union': {
      const kept: IrRewrite[] = [];
      let droppedAny = false;
      for (const child of rule.children) {
        const converted = convertRewriteMaybeDropped(child, bestEffort, notes, context);
        if (converted === undefined) {
          droppedAny = true;
        } else {
          kept.push(converted);
        }
      }
      if (droppedAny) {
        notes.push({
          kind: 'self-dropped',
          detail: `${context}: dropped SpiceDB's 'self' keyword from a union — this DSL has no equivalent, so the object no longer implicitly includes itself here (a real narrowing versus the source model).`,
        });
      }
      if (kept.length === 0) {
        throw new UnsupportedSpicedbConstructError(
          `${context}: nothing left after dropping 'self' — the entire rewrite was 'self' alone (or a union of only 'self')`,
        );
      }
      return kept.length === 1 ? kept[0]! : { kind: 'union', children: kept };
    }
    case 'intersection':
      return {
        kind: 'intersection',
        children: rule.children.map((c) => convertRewrite(c, bestEffort, notes, context)),
      };
    case 'exclusion':
      return {
        kind: 'exclusion',
        base: convertRewrite(rule.base, bestEffort, notes, context),
        subtract: convertRewrite(rule.subtract, bestEffort, notes, context),
      };
  }
}

/**
 * Resolves `ns#name` to `[name]` if it's already a genuine relation, or
 * to the flattened list of underlying relation names if it's a
 * permission whose rewrite is exactly a bare reference or a union of
 * references that themselves all flatten the same way (recursively, in
 * case of a chain of pure-relation-union permissions — not exercised by
 * any real fixture in this survey, but a straightforward generalization
 * worth being safe about) — `null` if it's anything else (an unresolved
 * name, a `tupleToUserset`/intersection/exclusion anywhere in the chain,
 * or a cycle deep enough to suggest one). `depth` guards against a
 * malformed/cyclic schema recursing forever; `null` past the cap is a
 * safe, conservative answer — the caller falls back to restructuring
 * (case 3) rather than to a wrong expansion.
 */
function collectUnderlyingRelations(
  ns: string,
  name: string,
  lookup: Lookup,
  depth = 0,
): string[] | null {
  if (depth > 20) return null;
  const info = lookup.get(ns)?.get(name);
  if (info === undefined) return null;
  if (info.kind === 'relation') return [name];
  return flattenPermissionRewrite(ns, info.rewrite, lookup, depth);
}

function flattenPermissionRewrite(
  ns: string,
  rewrite: IrRewrite,
  lookup: Lookup,
  depth: number,
): string[] | null {
  if (rewrite.kind === 'ref') {
    return collectUnderlyingRelations(ns, rewrite.name, lookup, depth + 1);
  }
  if (rewrite.kind === 'union') {
    const out: string[] = [];
    for (const child of rewrite.children) {
      const sub = flattenPermissionRewrite(ns, child, lookup, depth + 1);
      if (sub === null) return null;
      out.push(...sub);
    }
    return out;
  }
  return null; // 'this' never appears here (only ever synthesized later, by buildMember itself, never present in a real parsed permission); tupleToUserset/intersection/exclusion are never flattenable.
}

function convertSubjectTypeDirect(t: ParsedSubjectType): IrSubjectType {
  return {
    namespace: t.namespace,
    ...(t.wildcard === true ? { wildcard: true } : {}),
  };
}

/**
 * Builds the `IrMember`(s) for one relation, resolving every nested-
 * userset subject type per this file's own module doc comment. Case-3
 * restructuring reuses `../common/ir.ts`'s own `splitMember` rather than
 * duplicating its logic: a restructured relation's own `directTypes` (the
 * types that stayed, case 1/2) are unioned with a synthesized `{ kind:
 * 'this' }` sentinel (the exact same sentinel OpenFGA's own `define`
 * conflation produces) plus one `tupleToUserset` term per distinct
 * restructured target — `splitMember` then does the identical `<name>_
 * direct` synthesis it already does for OpenFGA, with no SpiceDB-specific
 * splitting code needed here at all. `{ kind: 'this' }` is omitted
 * entirely when `directTypes` ends up empty (every subject type needed
 * restructuring) — otherwise `splitMember` would correctly reject it
 * ("references its own direct assignment but declares no direct subject
 * types"), since there would be nothing left to synthesize a `_direct`
 * relation from.
 */
function buildMember(
  namespaceName: string,
  relationName: string,
  subjectTypes: readonly ParsedSubjectType[],
  lookup: Lookup,
  notes: TranslationNote[],
): { readonly main: IrMember; readonly extra: readonly IrMember[] } {
  const directTypes: IrSubjectType[] = [];
  const extra: IrMember[] = [];
  const arrowTerms: IrRewrite[] = [];

  for (const t of subjectTypes) {
    if (t.relation === undefined) {
      directTypes.push(convertSubjectTypeDirect(t));
      continue;
    }
    const info = lookup.get(t.namespace)?.get(t.relation);
    if (info === undefined || info.kind === 'relation') {
      // Case 1: already a genuine relation (or an unresolved name — left
      // alone; the real compileSchema reports an unknown-relation error
      // for that case, which is the right place for it to surface).
      directTypes.push({ namespace: t.namespace, relation: t.relation });
      continue;
    }

    const flattened = collectUnderlyingRelations(t.namespace, t.relation, lookup);
    if (flattened !== null) {
      // Case 2: an exact, lossless expansion.
      notes.push({
        kind: 'nested-userset-expanded',
        detail: `'${namespaceName}#${relationName}' declares '${t.namespace}#${t.relation}' as a subject type, nesting into a computed permission on '${t.namespace}' that is exactly a union of bare relations — expanded to ${flattened.map((r) => `'${t.namespace}#${r}'`).join(', ')} directly, an exact equivalent, not an approximation.`,
      });
      for (const r of flattened) directTypes.push({ namespace: t.namespace, relation: r });
      continue;
    }

    // Case 3: restructure — no `#`-syntax equivalent exists.
    const viaName = `${relationName}_via_${t.namespace}_${t.relation}`;
    notes.push({
      kind: 'nested-userset-restructured',
      detail: `'${namespaceName}#${relationName}' declares '${t.namespace}#${t.relation}' as a subject type, nesting into a computed permission this DSL's '#' syntax cannot express directly (it must name a storable relation) — restructured into a new relation '${viaName}: ${t.namespace}' plus an added '${viaName}->${t.relation}' tuple-to-userset term, semantically equivalent to the original nested-userset grant (writing to '${viaName}' takes the place of a nested-userset tuple on '${relationName}' itself).`,
    });
    extra.push({ name: viaName, directTypes: [{ namespace: t.namespace }] });
    arrowTerms.push({ kind: 'tupleToUserset', relation: viaName, computedUserset: t.relation });
  }

  if (arrowTerms.length === 0) {
    return { main: { name: relationName, directTypes }, extra };
  }
  const unionChildren: IrRewrite[] =
    directTypes.length > 0 ? [{ kind: 'this' }, ...arrowTerms] : arrowTerms;
  const rewrite: IrRewrite =
    unionChildren.length === 1 ? unionChildren[0]! : { kind: 'union', children: unionChildren };
  return { main: { name: relationName, directTypes, rewrite }, extra };
}

/**
 * See this file's own module doc comment, point 3, for what this fixes
 * and why. Runs once, after every relation's own subject types are fully
 * resolved (case 1/2/3 above) — a relation this pass ends up splitting is
 * always one of *those* relations' final, resolved type lists, never a
 * raw/unresolved one.
 *
 * `lookup` doubles as "does namespace N define member M" — exactly what
 * `MemberInfo`'s own presence/absence in it already means, no separate
 * data structure needed.
 */
function applyArrowTypeSplit(
  namespaces: readonly IrNamespace[],
  lookup: Lookup,
  notes: TranslationNote[],
): IrNamespace[] {
  const relationTypes = new Map<string, Map<string, readonly IrSubjectType[]>>();
  for (const ns of namespaces) {
    const m = new Map<string, readonly IrSubjectType[]>();
    for (const member of ns.members) {
      if (member.rewrite === undefined) m.set(member.name, member.directTypes);
    }
    relationTypes.set(ns.name, m);
  }

  const definesTarget = (namespace: string, name: string): boolean =>
    lookup.get(namespace)?.has(name) ?? false;

  // Which (namespace, relationName) pairs need splitting: multi-typed,
  // and followed by at least one arrow that isn't compatible with every
  // one of its types.
  const needsSplit = new Map<string, Set<string>>();
  function scan(ns: string, rewrite: IrRewrite | undefined): void {
    if (rewrite === undefined) return;
    if (rewrite.kind === 'tupleToUserset') {
      const types = relationTypes.get(ns)?.get(rewrite.relation);
      if (types !== undefined && types.length > 1) {
        const allCompatible = types.every((t) =>
          definesTarget(t.namespace, rewrite.computedUserset),
        );
        if (!allCompatible) {
          if (!needsSplit.has(ns)) needsSplit.set(ns, new Set());
          needsSplit.get(ns)!.add(rewrite.relation);
        }
      }
      return;
    }
    if (rewrite.kind === 'union' || rewrite.kind === 'intersection') {
      for (const child of rewrite.children) scan(ns, child);
      return;
    }
    if (rewrite.kind === 'exclusion') {
      scan(ns, rewrite.base);
      scan(ns, rewrite.subtract);
    }
  }
  for (const ns of namespaces) {
    for (const member of ns.members) scan(ns.name, member.rewrite);
  }
  if (needsSplit.size === 0) return namespaces as IrNamespace[]; // the common case — nothing to rewrite.

  /** `undefined` means "drop this node — every branch it could have contributed through turned out incompatible." */
  function rewriteNode(ns: string, rewrite: IrRewrite): IrRewrite | undefined {
    if (rewrite.kind === 'tupleToUserset') {
      const splitRelations = needsSplit.get(ns);
      if (splitRelations === undefined || !splitRelations.has(rewrite.relation)) return rewrite;
      const types = relationTypes.get(ns)!.get(rewrite.relation)!;
      const compatible = types.filter((t) => definesTarget(t.namespace, rewrite.computedUserset));
      notes.push({
        kind: 'arrow-type-split',
        detail: `'${ns}#${rewrite.relation}' is followed by '->${rewrite.computedUserset}', but it also accepts a subject type that declares no '${rewrite.computedUserset}' at all — split '${rewrite.relation}' by subject type and narrowed this arrow to only the type(s) that do, matching SpiceDB's own real runtime behavior (a mismatched arrow branch is silently empty, never a compile-time error) rather than this DSL's own stricter requirement that every subject type of a followed relation define the target.`,
      });
      if (compatible.length === 0) return undefined;
      const terms: IrRewrite[] = compatible.map((t) => ({
        kind: 'tupleToUserset',
        relation: `${rewrite.relation}_${t.namespace}`,
        computedUserset: rewrite.computedUserset,
      }));
      return terms.length === 1 ? terms[0] : { kind: 'union', children: terms };
    }
    if (rewrite.kind === 'union' || rewrite.kind === 'intersection') {
      const kept = rewrite.children
        .map((c) => rewriteNode(ns, c))
        .filter((c): c is IrRewrite => c !== undefined);
      if (kept.length === 0) {
        throw new UnsupportedSpicedbConstructError(
          `${ns}: arrow-type-split left nothing in a ${rewrite.kind} — every child arrow turned out incompatible with its own target`,
        );
      }
      return kept.length === 1 ? kept[0] : { kind: rewrite.kind, children: kept };
    }
    if (rewrite.kind === 'exclusion') {
      const base = rewriteNode(ns, rewrite.base);
      const subtract = rewriteNode(ns, rewrite.subtract);
      if (base === undefined || subtract === undefined) {
        throw new UnsupportedSpicedbConstructError(
          `${ns}: arrow-type-split left an exclusion with a missing base or subtract operand — no well-defined replacement`,
        );
      }
      return { kind: 'exclusion', base, subtract };
    }
    return rewrite;
  }

  return namespaces.map((ns) => {
    const splitRelations = needsSplit.get(ns.name);
    const members: IrMember[] = [];
    for (const member of ns.members) {
      if (splitRelations?.has(member.name) === true) {
        const perType = member.directTypes.map((t) => ({
          name: `${member.name}_${t.namespace}`,
          directTypes: [t] as IrSubjectType[],
        }));
        members.push(...perType);
        const refs: IrRewrite[] = perType.map((p) => ({ kind: 'ref', name: p.name }));
        members.push({
          name: member.name,
          directTypes: [],
          rewrite: refs.length === 1 ? refs[0]! : { kind: 'union', children: refs },
        });
      } else if (member.rewrite === undefined) {
        members.push(member);
      } else {
        const rewritten = rewriteNode(ns.name, member.rewrite);
        if (rewritten === undefined) {
          throw new UnsupportedSpicedbConstructError(
            `${ns.name}#${member.name}: nothing left after arrow-type-split — the entire rewrite was a single arrow, and no subject type of the followed relation was compatible with its target`,
          );
        }
        members.push({ name: member.name, directTypes: member.directTypes, rewrite: rewritten });
      }
    }
    return { name: ns.name, members };
  });
}

export function translateSpicedb(
  definitions: readonly ParsedDefinition[],
  options: TranslateSpicedbOptions = {},
): TranslateSpicedbResult {
  const bestEffort = options.bestEffort ?? false;
  const notes: TranslationNote[] = [];

  // Pass 1: every definition's own member-name -> kind/rewrite lookup —
  // needed before any relation's subject types can be resolved, since a
  // nested-userset reference can point at any other definition, in any
  // order (`group_with_parent#view` above `group_with_parent` itself is
  // perfectly valid SpiceDB source, and is exactly the shape
  // `spicedb-docs-style-sharing.zed` uses).
  const lookup = new Map<string, Map<string, MemberInfo>>();
  for (const def of definitions) {
    const memberMap = new Map<string, MemberInfo>();
    for (const m of def.members) {
      if (m.kind === 'relation') {
        memberMap.set(m.name, { kind: 'relation' });
      } else {
        const rewrite = convertRewrite(m.rewrite, bestEffort, notes, `${def.name}#${m.name}`);
        memberMap.set(m.name, { kind: 'permission', rewrite });
      }
    }
    lookup.set(def.name, memberMap);
  }

  // Pass 2: build each namespace's final members, resolving relations'
  // subject types against the now-complete lookup.
  const namespaces: IrNamespace[] = [];
  for (const def of definitions) {
    if (def.members.length === 0) continue; // a terminal principal type, e.g. bare `definition user {}`.
    const members: IrMember[] = [];
    for (const m of def.members) {
      if (m.kind === 'relation') {
        const { main, extra } = buildMember(def.name, m.name, m.subjectTypes, lookup, notes);
        members.push(main, ...extra);
      } else {
        const info = lookup.get(def.name)!.get(m.name) as {
          kind: 'permission';
          rewrite: IrRewrite;
        };
        members.push({ name: m.name, directTypes: [], rewrite: info.rewrite });
      }
    }
    namespaces.push({ name: def.name, members });
  }

  // Pass 3: split any relation followed by an arrow it isn't fully
  // compatible with — see this file's own module doc comment, point 3.
  const finalNamespaces = applyArrowTypeSplit(namespaces, lookup, notes);

  return { schema: { namespaces: finalNamespaces }, notes };
}
