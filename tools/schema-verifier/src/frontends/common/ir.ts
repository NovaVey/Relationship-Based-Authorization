/**
 * A neutral, ecosystem-independent intermediate representation for "one
 * writable-or-computed name declared on one object type" — the shape both
 * the OpenFGA front end (`../openfga/translate.ts`) and the SpiceDB front
 * end (`../spicedb/translate.ts`) translate their own source model into,
 * before `dsl-print.ts` turns it into real `.authz` source text that gets
 * handed to the unmodified `compileSchema`/`parseSchema` pipeline
 * (`src/schema/dsl/`) — this project never re-derives a `CompiledSchema`
 * directly from a third-party model; it only ever reaches one by printing
 * DSL text and compiling it the ordinary way, so a bug here is a bug in
 * generated *source*, inspectable the same way a human-authored `.authz`
 * file is.
 *
 * `IrMember` exists because OpenFGA's `define` conflates what this DSL (and
 * SpiceDB) keep separate: a name can be directly writable (`directTypes`),
 * computed (`rewrite`), or — the OpenFGA case this file's own `splitMember`
 * exists for — both at once. See `thirdparty/README.md`'s own "Translation
 * methodology" section for the hand-translation rule this function
 * automates: `define admin: [user, team#member] or repo_admin from owner`
 * becomes `relation admin_direct: user | team#member` +
 * `permission admin = admin_direct | owner->repo_admin`. SpiceDB's own
 * `relation`/`permission` split already matches this DSL one-to-one, so
 * its own translate.ts never needs to *produce* a `rewrite` alongside
 * non-empty `directTypes` in the first place — `splitMember` is a no-op
 * pass-through for every member it emits, not dead code kept "just in
 * case."
 */

export interface IrSubjectType {
  readonly namespace: string;
  /** Present only for a `namespace#relation` nested-userset subject type. */
  readonly relation?: string;
  /** Present (and `true`) only for a `namespace:*` wildcard subject type. */
  readonly wildcard?: boolean;
}

/**
 * `{ kind: 'this' }` is the one variant with no equivalent in
 * `src/schema/dsl/types.ts`'s own `RewriteRule` — it stands for "whatever
 * this member's own `directTypes` were directly written," OpenFGA's `this`
 * sentinel. `splitMember` below either resolves it into a synthesized
 * `relation` (when it's the whole rewrite) or rewrites every occurrence
 * into a `ref` naming that synthesized relation (when it appears alongside
 * other rewrite terms) — a `this` node never survives into the DSL text
 * `dsl-print.ts` emits.
 */
export type IrRewrite =
  | { readonly kind: 'this' }
  | { readonly kind: 'ref'; readonly name: string }
  | { readonly kind: 'union'; readonly children: readonly IrRewrite[] }
  | { readonly kind: 'intersection'; readonly children: readonly IrRewrite[] }
  | { readonly kind: 'exclusion'; readonly base: IrRewrite; readonly subtract: IrRewrite }
  | {
      readonly kind: 'tupleToUserset';
      readonly relation: string;
      readonly computedUserset: string;
    };

/**
 * One `define` (OpenFGA) or one `relation`/`permission` (SpiceDB) — not yet
 * committed to being either a DSL `relation` or a DSL `permission`;
 * `splitMember` makes that call.
 *
 * `directTypes.length === 0 && rewrite === undefined` is invalid (a member
 * with neither direct types nor a rewrite declares nothing at all) —
 * `splitMember` throws rather than silently emitting an empty relation, on
 * the theory that a translator producing this shape has a bug worth
 * surfacing, not a schema worth papering over.
 */
export interface IrMember {
  readonly name: string;
  readonly directTypes: readonly IrSubjectType[];
  readonly rewrite?: IrRewrite;
}

export interface IrNamespace {
  readonly name: string;
  readonly members: readonly IrMember[];
}

export interface IrSchema {
  readonly namespaces: readonly IrNamespace[];
}

/** A DSL `relation` declaration, already split out of an `IrMember`. */
export interface DslRelation {
  readonly name: string;
  readonly subjectTypes: readonly IrSubjectType[];
}

/** A DSL `permission` declaration, already split out of an `IrMember`. */
export interface DslPermission {
  readonly name: string;
  readonly rewrite: IrRewrite;
}

export interface SplitMemberResult {
  /** Present unless this member is a pure computed permission with no direct grant of its own. */
  readonly relation?: DslRelation;
  /** Present unless this member is a bare relation with no rewrite logic at all. */
  readonly permission?: DslPermission;
}

function assertNeverIrRewrite(node: never): never {
  throw new Error(`unreachable: unhandled IrRewrite kind ${JSON.stringify(node)}`);
}

function containsThis(rule: IrRewrite): boolean {
  switch (rule.kind) {
    case 'this':
      return true;
    case 'ref':
    case 'tupleToUserset':
      return false;
    case 'union':
    case 'intersection':
      return rule.children.some(containsThis);
    case 'exclusion':
      return containsThis(rule.base) || containsThis(rule.subtract);
    default:
      return assertNeverIrRewrite(rule);
  }
}

/** Replaces every `{ kind: 'this' }` node anywhere in `rule` with `replacement`. */
function replaceThis(rule: IrRewrite, replacement: IrRewrite): IrRewrite {
  switch (rule.kind) {
    case 'this':
      return replacement;
    case 'ref':
    case 'tupleToUserset':
      return rule;
    case 'union':
      return { kind: 'union', children: rule.children.map((c) => replaceThis(c, replacement)) };
    case 'intersection':
      return {
        kind: 'intersection',
        children: rule.children.map((c) => replaceThis(c, replacement)),
      };
    case 'exclusion':
      return {
        kind: 'exclusion',
        base: replaceThis(rule.base, replacement),
        subtract: replaceThis(rule.subtract, replacement),
      };
    default:
      return assertNeverIrRewrite(rule);
  }
}

/**
 * The one piece of semantic translation logic both front ends share (see
 * this file's own top-of-file comment for the rule it automates). Four
 * cases, in the order checked:
 *
 * 1. No rewrite at all (`rewrite === undefined`) — a bare relation.
 *    SpiceDB's own `relation` blocks, and an OpenFGA `define` with only a
 *    `[...]` type list and no `or` terms, both land here.
 * 2. `rewrite` is exactly `{ kind: 'this' }` and nothing else — same
 *    outcome as (1); OpenFGA's DSL can produce this shape too (a `define`
 *    whose *entire* body is a direct-assignment type list, represented as
 *    a bare `this` Userset rather than folded away by the transformer).
 * 3. `rewrite` contains no `this` anywhere — a pure computed permission,
 *    SpiceDB's own `permission` blocks and an OpenFGA `define` with no
 *    `[...]` type list at all (e.g. `subscriber_member: member from
 *    subscriber`) both land here.
 * 4. `rewrite` contains `this` alongside other terms — the split case:
 *    synthesizes a `<name>_direct` relation carrying `directTypes`, and
 *    rewrites every `this` occurrence (see `replaceThis`) into a `ref`
 *    naming that synthesized relation.
 */
export function splitMember(member: IrMember): SplitMemberResult {
  if (member.rewrite === undefined || member.rewrite.kind === 'this') {
    if (member.directTypes.length === 0) {
      throw new Error(
        `member '${member.name}' has no rewrite rule and declares no direct subject types`,
      );
    }
    return { relation: { name: member.name, subjectTypes: member.directTypes } };
  }

  if (!containsThis(member.rewrite)) {
    return { permission: { name: member.name, rewrite: member.rewrite } };
  }

  if (member.directTypes.length === 0) {
    throw new Error(
      `member '${member.name}' rewrite references its own direct assignment but declares no direct subject types`,
    );
  }
  const directName = `${member.name}_direct`;
  return {
    relation: { name: directName, subjectTypes: member.directTypes },
    permission: {
      name: member.name,
      rewrite: replaceThis(member.rewrite, { kind: 'ref', name: directName }),
    },
  };
}

/**
 * Whether `namespace`'s member named `relationName` gets synthesized as a
 * `<name>_direct` relation once split — i.e. whether a `namespace#relationName`
 * nested-userset subject-type reference elsewhere in the schema must be
 * rewritten to `namespace#relationName_direct` instead, since this DSL's
 * `#` syntax can only ever name a storable relation, never a computed
 * permission (`src/schema/dsl/compiler.ts`'s own validation — see
 * `thirdparty/README.md` and the `openfga-github`/`openfga-slack` survey
 * entries' own disclosed-narrowing comments, the hand-translated precedent
 * this function's caller reproduces automatically). `false` for any name
 * not declared on `namespace` at all — the reference is left alone and
 * whatever validates the printed DSL text (`compileSchema`) reports the
 * real error, since a dangling reference is a translation bug, not
 * something this function is positioned to explain.
 */
export function memberWasSplit(schema: IrSchema, namespace: string, relationName: string): boolean {
  const ns = schema.namespaces.find((n) => n.name === namespace);
  const member = ns?.members.find((m) => m.name === relationName);
  if (member === undefined) return false;
  return splitMember(member).permission !== undefined;
}
