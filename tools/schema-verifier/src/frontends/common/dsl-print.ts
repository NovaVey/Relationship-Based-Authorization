/**
 * Prints an `IrSchema` (`./ir.ts`) as real `.authz` DSL source text — the
 * one and only thing either front end's `translate.ts` ultimately produces.
 * No printer for this DSL existed anywhere in this repo before this file
 * (every `.authz` file this project has ever had was hand-authored); this
 * one is deliberately the mechanical inverse of `src/schema/dsl/parser.ts`'s
 * own grammar (see that file's own module comment for the grammar itself),
 * not a generic pretty-printer — it exists only to hand `compileSchema`
 * something to compile, never to be read as a finished artifact on its own
 * (the `disclose.ts` header this always sits under is what a reader
 * actually reads).
 *
 * The one genuinely tricky part is `printRewrite`'s own parenthesization —
 * see its own doc comment.
 */
import {
  splitMember,
  type DslPermission,
  type DslRelation,
  type IrMember,
  type IrRewrite,
  type IrSchema,
  type IrSubjectType,
} from './ir.js';

function printSubjectType(t: IrSubjectType): string {
  if (t.wildcard === true) return `${t.namespace}:*`;
  if (t.relation !== undefined) return `${t.namespace}#${t.relation}`;
  return t.namespace;
}

/**
 * `parentTier` is the precedence tier of whatever is about to join `rule`
 * with an operator of its own — `undefined` at the very top of a
 * permission's rewrite (nothing surrounds it, so it never needs parens):
 *
 * - `'intersection'`: `rule` is one operand of an `&` chain. `&` binds
 *   tighter than `|`/`-` (`src/schema/dsl/parser.ts`'s own grammar
 *   comment), so a `rule` at the *lower* tier (`union`/`exclusion`) must be
 *   parenthesized regardless of where it sits in the chain — mixing a
 *   looser operator into a tighter one always needs a boundary. A `ref`/
 *   `tupleToUserset` (atomic) or another `intersection` (same tier) never
 *   does.
 * - `'union'`: `rule` is one operand of the shared `|`/`-` left-associative
 *   tier (this DSL's grammar gives `|` and `-` *equal* precedence, unlike
 *   `&` — see `parser.ts`'s own `parseExpression`). Whether a `union`/
 *   `exclusion` operand needs parens here depends on *position*, not just
 *   tier: `isFirstOperand` — the leftmost operand of a left-associative
 *   chain reconstructs correctly with no parens at all (printing `a | b`
 *   as the *first* operand of an outer chain, followed by ` - c`,
 *   reproduces exactly the tree `parseExpression` itself would have built
 *   parsing that text, since it accumulates strictly left to right), but
 *   any *later* operand that is itself a multi-term `union`/`exclusion`
 *   needs explicit grouping — printed bare, its own internal operator(s)
 *   would just keep extending the same left-to-right chain instead of
 *   staying scoped to that one operand. Confirmed both directions against
 *   `test/frontends/*-print.test.ts`'s own round-trip cases: printing then
 *   re-parsing an IR tree with a non-first union/exclusion operand,
 *   without this rule, reparses into a *different* tree than the one
 *   printed.
 */
type ParentTier = 'union' | 'intersection' | undefined;

function needsParens(rule: IrRewrite, parentTier: ParentTier, isFirstOperand: boolean): boolean {
  if (rule.kind === 'ref' || rule.kind === 'tupleToUserset' || rule.kind === 'intersection') {
    return false;
  }
  // rule.kind is 'union' or 'exclusion' from here — both share the
  // looser, left-associative tier.
  if (parentTier === 'intersection') return true;
  if (parentTier === 'union') return !isFirstOperand;
  return false; // top-level: nothing surrounds this rewrite at all.
}

function printMaybeParen(rule: IrRewrite, parentTier: ParentTier, isFirstOperand: boolean): string {
  const text = printRewrite(rule);
  return needsParens(rule, parentTier, isFirstOperand) ? `(${text})` : text;
}

/**
 * `rule.kind === 'this'` is never reached here — `splitMember` (`./ir.ts`)
 * resolves every `this` node before a `DslPermission` is ever constructed;
 * a `this` surviving to this point is this file's own bug, not a
 * translation-input problem, so it throws rather than printing something
 * silently wrong.
 */
function printRewrite(rule: IrRewrite): string {
  switch (rule.kind) {
    case 'this':
      throw new Error(
        "unreachable: a 'this' node reached dsl-print — splitMember should have resolved it first",
      );
    case 'ref':
      return rule.name;
    case 'tupleToUserset':
      return `${rule.relation}->${rule.computedUserset}`;
    case 'union':
      return rule.children.map((child, i) => printMaybeParen(child, 'union', i === 0)).join(' | ');
    case 'intersection':
      return rule.children
        .map((child) => printMaybeParen(child, 'intersection', false))
        .join(' & ');
    case 'exclusion':
      // `base` plays the "first operand" role of the shared union/
      // exclusion tier (see `needsParens`'s own doc comment); `subtract`
      // plays the "later operand" role, so it alone needs parens when
      // it's itself a multi-term union/exclusion.
      return (
        `${printMaybeParen(rule.base, 'union', true)}` +
        ` - ${printMaybeParen(rule.subtract, 'union', false)}`
      );
  }
}

function printRelation(r: DslRelation): string {
  return `  relation ${r.name}: ${r.subjectTypes.map(printSubjectType).join(' | ')}`;
}

function printPermission(p: DslPermission): string {
  return `  permission ${p.name} = ${printRewrite(p.rewrite)}`;
}

/**
 * Prints every namespace in `schema`, each member already run through
 * `splitMember` — a namespace with zero relations and zero permissions
 * after splitting (e.g. a terminal principal type like `user`, which
 * OpenFGA/SpiceDB both declare with no relations block at all) is silently
 * dropped, matching every hand-translated `thirdparty/*.authz` file's own
 * convention (see `schema/example.authz`'s own namespace list — `user`
 * never gets a namespace block of its own either, since nothing ever
 * declares relations on it) — this DSL's own parser rejects an empty
 * `namespace { }` body outright (`empty_namespace_body`,
 * `src/schema/dsl/parser.ts`), so emitting one here would only ever fail
 * downstream, never legitimately compile.
 */
export function printSchema(schema: IrSchema): string {
  const blocks: string[] = [];
  for (const ns of schema.namespaces) {
    const relations: DslRelation[] = [];
    const permissions: DslPermission[] = [];
    for (const member of ns.members) {
      const split = splitMemberOrThrow(ns.name, member);
      if (split.relation !== undefined) relations.push(split.relation);
      if (split.permission !== undefined) permissions.push(split.permission);
    }
    if (relations.length === 0 && permissions.length === 0) continue;

    const lines = [
      `namespace ${ns.name} {`,
      ...relations.map(printRelation),
      // A blank line between the relations and permissions blocks, but
      // only when both are actually present — matching every hand-
      // translated `thirdparty/*.authz` file's own convention.
      ...(relations.length > 0 && permissions.length > 0 ? [''] : []),
      ...permissions.map(printPermission),
      `}`,
    ];
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n') + '\n';
}

// Wraps `splitMember` purely to attach a namespace name to its error
// message — `splitMember` itself has no namespace context of its own.
function splitMemberOrThrow(namespace: string, member: IrMember) {
  try {
    return splitMember(member);
  } catch (err) {
    throw new Error(`namespace '${namespace}': ${(err as Error).message}`, { cause: err });
  }
}
