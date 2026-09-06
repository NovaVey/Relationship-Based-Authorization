/**
 * OpenFGA `AuthorizationModel` (JSON — see `./parse.ts` for how `.fga` DSL
 * text gets there) → this tool's own neutral `IrSchema` (`../common/ir.ts`).
 * `dsl-print.ts` then turns the result into `.authz` source text, which
 * goes through the real, unmodified `compileSchema` — this file only ever
 * builds an `IrSchema`, never a `CompiledSchema` directly.
 *
 * The translation rules below are the exact rules `thirdparty/README.md`'s
 * own "Translation methodology" section documents and the 12 hand-
 * translated `thirdparty/*.authz` files were built from by hand — this
 * file automates the same reasoning a human already applied. Verified by
 * hand against four of the five real upstream OpenFGA sample stores this
 * survey covers before writing a single line here (every relation/
 * permission this produces for `openfga-entitlements`, `openfga-expenses`,
 * `openfga-github`, and `openfga-slack` matches the existing hand-
 * translated file exactly, modulo declaration order, which `compileSchema`
 * never cares about) — see `test/frontends/openfga-thirdparty-regression.
 * test.ts` for the automated version of that same check, run against the
 * real fetched upstream source, not a synthetic stand-in.
 */
import type {
  AuthorizationModel,
  Difference,
  RelationReference,
  TypeDefinition,
  Userset,
} from '@openfga/sdk';

import type { IrMember, IrNamespace, IrRewrite, IrSchema, IrSubjectType } from '../common/ir.js';
import { memberWasSplit } from '../common/ir.js';
import type { TranslationNote } from '../common/disclose.js';

export interface TranslateOpenfgaOptions {
  /**
   * Default `false`: an ABAC `condition` anywhere in the model (a
   * `RelationReference.condition`, or a non-empty `AuthorizationModel.
   * conditions` map) throws, matching this survey's own established
   * policy of excluding condition-heavy models outright rather than
   * best-effort-translating them into something that no longer represents
   * the real schema (`thirdparty/README.md`'s own "Caveats / ABAC
   * conditions" paragraph — this DSL has no runtime-attribute concept at
   * all). `true` drops every condition instead (the type restriction
   * itself is kept, unconditionally — a real widening, always disclosed
   * via a `TranslationNote`, never silent).
   */
  readonly bestEffort?: boolean;
}

export interface TranslateOpenfgaResult {
  readonly schema: IrSchema;
  readonly notes: readonly TranslationNote[];
}

class UnsupportedOpenfgaConstructError extends Error {}

function convertSubjectType(
  ref: RelationReference,
  bestEffort: boolean,
  notes: TranslationNote[],
  context: string,
): IrSubjectType {
  if (ref.condition !== undefined) {
    if (!bestEffort) {
      throw new UnsupportedOpenfgaConstructError(
        `${context}: subject type '${ref.type}${ref.relation !== undefined ? `#${ref.relation}` : ''}' carries an ABAC condition ('${ref.condition}') — this DSL has no runtime-attribute concept; excluded rather than best-effort translated (pass --best-effort to drop the condition and keep the type restriction unconditionally, disclosed)`,
      );
    }
    notes.push({
      kind: 'condition-dropped',
      detail: `${context}: dropped ABAC condition '${ref.condition}' on subject type '${ref.type}${ref.relation !== undefined ? `#${ref.relation}` : ''}' — this DSL has no runtime-attribute concept, so the type restriction below applies unconditionally (a real widening versus the source model).`,
    });
  }
  return {
    namespace: ref.type,
    ...(ref.relation !== undefined ? { relation: ref.relation } : {}),
    ...(ref.wildcard !== undefined ? { wildcard: true } : {}),
  };
}

function convertUserset(u: Userset, context: string): IrRewrite {
  if (u.this !== undefined) return { kind: 'this' };

  if (u.computedUserset !== undefined) {
    if (u.computedUserset.object !== undefined && u.computedUserset.object !== '') {
      throw new UnsupportedOpenfgaConstructError(
        `${context}: computedUserset names a literal object ('${u.computedUserset.object}') rather than "this object" — no equivalent in this DSL, which only ever computes relative to the object being checked`,
      );
    }
    if (u.computedUserset.relation === undefined) {
      throw new UnsupportedOpenfgaConstructError(
        `${context}: computedUserset with no relation name`,
      );
    }
    return { kind: 'ref', name: u.computedUserset.relation };
  }

  if (u.tupleToUserset !== undefined) {
    const { tupleset, computedUserset } = u.tupleToUserset;
    if (tupleset.object !== undefined && tupleset.object !== '') {
      throw new UnsupportedOpenfgaConstructError(
        `${context}: tupleToUserset's tupleset names a literal object — no equivalent in this DSL`,
      );
    }
    if (tupleset.relation === undefined || computedUserset.relation === undefined) {
      throw new UnsupportedOpenfgaConstructError(
        `${context}: tupleToUserset missing a relation name`,
      );
    }
    return {
      kind: 'tupleToUserset',
      relation: tupleset.relation,
      computedUserset: computedUserset.relation,
    };
  }

  if (u.union !== undefined) {
    return { kind: 'union', children: u.union.child.map((c) => convertUserset(c, context)) };
  }
  if (u.intersection !== undefined) {
    return {
      kind: 'intersection',
      children: u.intersection.child.map((c) => convertUserset(c, context)),
    };
  }
  if (u.difference !== undefined) {
    const diff: Difference = u.difference;
    return {
      kind: 'exclusion',
      base: convertUserset(diff.base, context),
      subtract: convertUserset(diff.subtract, context),
    };
  }

  throw new UnsupportedOpenfgaConstructError(`${context}: empty or unrecognized Userset`);
}

function convertTypeDefinition(
  td: TypeDefinition,
  bestEffort: boolean,
  notes: TranslationNote[],
): IrNamespace | undefined {
  const relationEntries = Object.entries(td.relations ?? {});
  if (relationEntries.length === 0) return undefined; // a terminal principal type, e.g. bare `type user` — see printSchema's own doc comment.

  const members: IrMember[] = relationEntries.map(([name, userset]) => {
    const context = `${td.type}#${name}`;
    const directTypeRefs = td.metadata?.relations?.[name]?.directly_related_user_types ?? [];
    const directTypes = directTypeRefs.map((ref) =>
      convertSubjectType(ref, bestEffort, notes, context),
    );
    return { name, directTypes, rewrite: convertUserset(userset, context) };
  });

  return { name: td.type, members };
}

/**
 * Second translation pass: rewrites every `namespace#relation` nested-
 * userset subject-type reference whose target member gets split (i.e. a
 * `<relation>_direct` relation is synthesized for it) into
 * `namespace#relation_direct` instead — this DSL's `#` syntax can only
 * ever name a storable relation, never a computed permission
 * (`src/schema/dsl/compiler.ts`'s own validation). See `openfga-github`'s
 * and `openfga-slack`'s own hand-translated header comments for the exact
 * precedent this automates (`organization#member` → `organization#
 * member_direct`, `workspace#member` → `workspace#member_direct`).
 *
 * A single pass over the already-built schema suffices — a synthesized
 * `<name>_direct` relation is by construction a bare relation
 * (`directTypes` only, no rewrite), so it is never itself a further
 * narrowing target.
 */
function narrowNestedUsersetReferences(schema: IrSchema, notes: TranslationNote[]): IrSchema {
  const narrowed = new Set<string>();
  const namespaces = schema.namespaces.map((ns) => ({
    ...ns,
    members: ns.members.map((member) => ({
      ...member,
      directTypes: member.directTypes.map((t) => {
        if (t.relation === undefined) return t;
        if (!memberWasSplit(schema, t.namespace, t.relation)) return t;
        const key = `${t.namespace}#${t.relation}`;
        if (!narrowed.has(key)) {
          narrowed.add(key);
          notes.push({
            kind: 'nested-userset-narrowed',
            detail: `'${key}' names a computed permission on '${t.namespace}', which this DSL's '#' subject-type syntax cannot reference directly (it must name a storable relation) — narrowed to '${key}_direct' wherever referenced, an under-approximation versus the source model's own rewrite closure for '${t.relation}'.`,
          });
        }
        return { ...t, relation: `${t.relation}_direct` };
      }),
    })),
  }));
  return { namespaces };
}

export function translateOpenfga(
  model: Omit<AuthorizationModel, 'id'>,
  options: TranslateOpenfgaOptions = {},
): TranslateOpenfgaResult {
  const bestEffort = options.bestEffort ?? false;
  const notes: TranslationNote[] = [];

  if (!bestEffort && model.conditions !== undefined && Object.keys(model.conditions).length > 0) {
    throw new UnsupportedOpenfgaConstructError(
      "model declares 'conditions' (ABAC) — this DSL has no runtime-attribute concept; excluded rather than best-effort translated (pass --best-effort to translate the rest of the model, dropping every condition reference, disclosed)",
    );
  }

  const namespaces = model.type_definitions
    .map((td) => convertTypeDefinition(td, bestEffort, notes))
    .filter((ns): ns is IrNamespace => ns !== undefined);

  const schema = narrowNestedUsersetReferences({ namespaces }, notes);
  return { schema, notes };
}
