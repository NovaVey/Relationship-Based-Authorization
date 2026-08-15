/**
 * Semantic validation + compilation from the parsed AST (`parser.ts`) to
 * the stable `CompiledSchema` shape (`types.ts`) that every later phase
 * reads. See `.claude/commands/build-authz-service.md` §5 and §9 Phase 1.
 *
 * `parser.ts` only knows grammar; this file is where every reference gets
 * resolved and every non-negotiable from the schema-compiler brief gets
 * enforced: a `permission` can never be the target of a tuple write, an
 * undeclared reference is always rejected (never coerced into a no-op), a
 * tuple-to-userset rule's target namespace must exist in this compilation
 * unit, and a permission with no relation to ground it is rejected rather
 * than left to loop a resolver at 2am.
 *
 * `compileSchema` collects every semantic error it can find in one pass
 * (unlike `parseSchema`, which stops at the first syntax error) — a
 * schema author fixing a real file wants to see every problem at once, not
 * one at a time across repeated compiler invocations.
 */
import {
  parseSchema,
  type ParsedNamespace,
  type ParsedRelation,
  type ParsedRewriteRule,
} from './parser.js';
import { makeSchemaError, type SchemaCompileResult, type SchemaError } from './errors.js';
import type {
  CompiledPermission,
  CompiledRelation,
  CompiledSchema,
  NamespaceConfig,
  RewriteRule,
  SubjectTypeRef,
} from './types.js';

function assertNeverRewriteRule(node: never): never {
  throw new Error(`unreachable: unhandled rewrite-rule kind ${JSON.stringify(node)}`);
}

/** Kept out of `types.ts` — a compile-time-only lookup, never part of the stored shape. */
interface NamespaceLookup {
  byName: Map<string, ParsedNamespace>;
}

function buildLookup(namespaces: ParsedNamespace[]): NamespaceLookup {
  return { byName: new Map(namespaces.map((ns) => [ns.name, ns])) };
}

function findRelation(ns: ParsedNamespace, name: string): ParsedRelation | undefined {
  return ns.relations.find((r) => r.name === name);
}

function hasRelationOrPermission(
  ns: ParsedNamespace,
  name: string,
): 'relation' | 'permission' | undefined {
  if (ns.relations.some((r) => r.name === name)) return 'relation';
  if (ns.permissions.some((p) => p.name === name)) return 'permission';
  return undefined;
}

interface RewriteCompileContext {
  ns: ParsedNamespace;
  lookup: NamespaceLookup;
  relationNames: Set<string>;
  permissionNames: Set<string>;
  permissionName: string;
  errors: SchemaError[];
}

/**
 * Validates one node of a permission's parsed rewrite tree and returns the
 * stripped, stable `RewriteRule` shape. Errors are pushed onto
 * `ctx.errors` and compilation continues (rather than throwing) so a
 * single `compileSchema` call surfaces every problem in the tree, not just
 * the first.
 */
function compileRewriteRule(node: ParsedRewriteRule, ctx: RewriteCompileContext): RewriteRule {
  switch (node.kind) {
    case 'computedUserset': {
      if (!ctx.relationNames.has(node.name) && !ctx.permissionNames.has(node.name)) {
        ctx.errors.push(
          makeSchemaError(
            'undeclared_reference',
            `permission '${ctx.permissionName}' on namespace '${ctx.ns.name}' references undeclared relation '${node.name}' at line ${node.line}`,
            node.line,
            { namespace: ctx.ns.name, member: ctx.permissionName },
          ),
        );
      }
      return { kind: 'computedUserset', name: node.name };
    }
    case 'union':
      return { kind: 'union', children: node.children.map((c) => compileRewriteRule(c, ctx)) };
    case 'intersection':
      return {
        kind: 'intersection',
        children: node.children.map((c) => compileRewriteRule(c, ctx)),
      };
    case 'exclusion':
      return {
        kind: 'exclusion',
        base: compileRewriteRule(node.base, ctx),
        subtract: compileRewriteRule(node.subtract, ctx),
      };
    case 'tupleToUserset': {
      const followed = findRelation(ctx.ns, node.relation);
      if (!followed) {
        if (ctx.permissionNames.has(node.relation)) {
          ctx.errors.push(
            makeSchemaError(
              'tuple_to_userset_target_not_a_relation',
              `permission '${ctx.permissionName}' on namespace '${ctx.ns.name}' follows '${node.relation}' at line ${node.line}, but '${node.relation}' is a permission, not a relation — tuple-to-userset can only follow a storable relation, since only a relation has tuples to walk`,
              node.line,
              { namespace: ctx.ns.name, member: ctx.permissionName },
            ),
          );
        } else {
          ctx.errors.push(
            makeSchemaError(
              'undeclared_reference',
              `permission '${ctx.permissionName}' on namespace '${ctx.ns.name}' follows undeclared relation '${node.relation}' at line ${node.line}`,
              node.line,
              { namespace: ctx.ns.name, member: ctx.permissionName },
            ),
          );
        }
      } else {
        for (const subjectType of followed.subjectTypes) {
          const targetNs = ctx.lookup.byName.get(subjectType.namespace);
          if (!targetNs) {
            // Non-negotiable: a tuple-to-userset rule referencing a
            // namespace absent from this compilation unit is always a
            // specific "unknown namespace" error, never silently unchecked
            // — unlike a plain relation subject type (see
            // compileRelation), which is checked only when the target
            // namespace happens to be present. See docs/DECISIONS.md.
            ctx.errors.push(
              makeSchemaError(
                'tuple_to_userset_unknown_namespace',
                `permission '${ctx.permissionName}' on namespace '${ctx.ns.name}' at line ${node.line} follows relation '${node.relation}' into namespace '${subjectType.namespace}', which is not declared in this compilation unit`,
                node.line,
                { namespace: ctx.ns.name, member: ctx.permissionName },
              ),
            );
            continue;
          }
          const target = hasRelationOrPermission(targetNs, node.computedUserset);
          if (!target) {
            ctx.errors.push(
              makeSchemaError(
                'tuple_to_userset_unknown_target',
                `permission '${ctx.permissionName}' on namespace '${ctx.ns.name}' at line ${node.line} recurses into '${node.computedUserset}' on namespace '${subjectType.namespace}', but '${subjectType.namespace}' declares no relation or permission named '${node.computedUserset}'`,
                node.line,
                { namespace: ctx.ns.name, member: ctx.permissionName },
              ),
            );
          }
        }
      }
      return {
        kind: 'tupleToUserset',
        relation: node.relation,
        computedUserset: node.computedUserset,
      };
    }
    default:
      return assertNeverRewriteRule(node);
  }
}

/**
 * Compiles a namespace's `relation` declarations, checking each subject
 * type's `#relation` suffix (when present) against the same-compilation-
 * unit namespace it targets: it must name a `relation`, never a
 * `permission` — the concrete place the DSL grammar could otherwise let a
 * relation declaration reference a permission "as if it were a subject
 * type" (see the schema-compiler brief's non-negotiables).
 *
 * Unlike tuple-to-userset (always strict — see `compileRewriteRule`), this
 * check is soft: if the target namespace isn't present in this
 * compilation unit at all, it's left unchecked rather than rejected. See
 * `docs/DECISIONS.md` for why the two cases are treated differently.
 */
function compileRelations(
  ns: ParsedNamespace,
  lookup: NamespaceLookup,
  errors: SchemaError[],
): Record<string, CompiledRelation> {
  const compiled: Record<string, CompiledRelation> = {};
  for (const relation of ns.relations) {
    const subjectTypes: SubjectTypeRef[] = [];
    for (const subjectType of relation.subjectTypes) {
      if (subjectType.relation !== undefined) {
        const targetNs = lookup.byName.get(subjectType.namespace);
        if (targetNs) {
          const target = hasRelationOrPermission(targetNs, subjectType.relation);
          if (target === 'permission') {
            errors.push(
              makeSchemaError(
                'subject_type_targets_a_permission',
                `relation '${relation.name}' on namespace '${ns.name}' declares subject type '${subjectType.namespace}#${subjectType.relation}' at line ${subjectType.line}, but '${subjectType.relation}' is a permission on namespace '${subjectType.namespace}', not a relation — a permission can never be the target of a tuple write, so a subject-type reference must name a storable relation`,
                subjectType.line,
                { namespace: ns.name, member: relation.name },
              ),
            );
          } else if (target === undefined) {
            errors.push(
              makeSchemaError(
                'undeclared_reference',
                `relation '${relation.name}' on namespace '${ns.name}' declares subject type '${subjectType.namespace}#${subjectType.relation}' at line ${subjectType.line}, but namespace '${subjectType.namespace}' declares no relation or permission named '${subjectType.relation}'`,
                subjectType.line,
                { namespace: ns.name, member: relation.name },
              ),
            );
          }
        }
        subjectTypes.push({ namespace: subjectType.namespace, relation: subjectType.relation });
      } else {
        subjectTypes.push({ namespace: subjectType.namespace });
      }
    }
    compiled[relation.name] = { kind: 'relation', name: relation.name, subjectTypes };
  }
  return compiled;
}

/**
 * Rejects a `permission` and a `relation` sharing a name in the same
 * namespace, and a `relation`-`relation` or `permission`-`permission` name
 * collision — every case ambiguous about whether a name is a stored fact
 * or a computed rule.
 */
function checkDuplicateMemberNames(ns: ParsedNamespace, errors: SchemaError[]): void {
  const seen = new Map<string, 'relation' | 'permission'>();
  const check = (name: string, line: number, kind: 'relation' | 'permission'): void => {
    const existingKind = seen.get(name);
    if (existingKind) {
      const message =
        existingKind === kind
          ? `namespace '${ns.name}' declares ${kind} '${name}' more than once (repeated at line ${line})`
          : `namespace '${ns.name}' declares '${name}' as both a relation and a permission (repeated at line ${line}) — a permission can never share a name with a relation in the same namespace, since that would make it ambiguous whether '${name}' is a stored fact or a computed rule`;
      errors.push(
        makeSchemaError('duplicate_member_name', message, line, {
          namespace: ns.name,
          member: name,
        }),
      );
      return;
    }
    seen.set(name, kind);
  };
  for (const relation of ns.relations) check(relation.name, relation.line, 'relation');
  for (const permission of ns.permissions) check(permission.name, permission.line, 'permission');
}

/**
 * Detects a permission whose definition depends only on itself and other
 * permissions, in a cycle, with no `relation` (or cross-namespace
 * tuple-to-userset hop) anywhere in the cycle to ground it — e.g.
 * `permission view = view`, or `permission a = b; permission b = a`.
 * `tuple_to_userset` edges never contribute to this graph: following an
 * actual relation always makes progress against the real tuple graph (and
 * is bounded by CHECK_MAX_DEPTH / runtime cycle detection per §6.4), so it
 * can never be a *static*, always-true compile-time infinite regress the
 * way a pure same-namespace permission-to-permission cycle is.
 *
 * DFS with a recursion-stack coloring, standard cycle detection — bounded
 * by the number of permissions/edges in the namespace, so this can never
 * itself hang the compiler.
 */
function checkCircularPermissions(ns: ParsedNamespace, errors: SchemaError[]): void {
  const permissionsByName = new Map(ns.permissions.map((p) => [p.name, p]));
  const relationNames = new Set(ns.relations.map((r) => r.name));

  function collectPermissionDeps(node: ParsedRewriteRule, deps: Set<string>): void {
    switch (node.kind) {
      case 'computedUserset':
        if (permissionsByName.has(node.name) && !relationNames.has(node.name)) {
          deps.add(node.name);
        }
        return;
      case 'union':
      case 'intersection':
        for (const child of node.children) collectPermissionDeps(child, deps);
        return;
      case 'exclusion':
        collectPermissionDeps(node.base, deps);
        collectPermissionDeps(node.subtract, deps);
        return;
      case 'tupleToUserset':
        return;
      default:
        assertNeverRewriteRule(node);
    }
  }

  const deps = new Map<string, Set<string>>();
  for (const permission of ns.permissions) {
    const set = new Set<string>();
    collectPermissionDeps(permission.rewrite, set);
    deps.set(permission.name, set);
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, 0 | 1 | 2>();
  const reported = new Set<string>();

  function reportCycle(cycle: string[]): void {
    for (const member of cycle) {
      if (reported.has(member)) continue;
      reported.add(member);
      const permission = permissionsByName.get(member);
      if (!permission) continue;
      errors.push(
        makeSchemaError(
          'circular_permission_definition',
          `permission '${member}' on namespace '${ns.name}' is circularly defined with no relation to ground it (${cycle.join(' -> ')}) at line ${permission.line}`,
          permission.line,
          { namespace: ns.name, member },
        ),
      );
    }
  }

  function dfs(name: string, path: string[]): void {
    color.set(name, GREY);
    path.push(name);
    for (const dep of deps.get(name) ?? []) {
      const depColor = color.get(dep) ?? WHITE;
      if (depColor === GREY) {
        const cycleStart = path.indexOf(dep);
        reportCycle([...path.slice(cycleStart), dep]);
      } else if (depColor === WHITE) {
        dfs(dep, path);
      }
    }
    path.pop();
    color.set(name, BLACK);
  }

  for (const permission of ns.permissions) {
    if ((color.get(permission.name) ?? WHITE) === WHITE) {
      dfs(permission.name, []);
    }
  }
}

/**
 * Semantic validation + compilation over an already-parsed set of
 * namespaces — the entry point `compileSchema` below uses after parsing,
 * exported separately so a caller (or a test) that already has a parsed
 * AST doesn't need to re-serialize it back to source text first.
 */
export function compileParsedNamespaces(namespaces: ParsedNamespace[]): SchemaCompileResult {
  const errors: SchemaError[] = [];

  const seenNamespaceNames = new Set<string>();
  for (const ns of namespaces) {
    if (seenNamespaceNames.has(ns.name)) {
      errors.push(
        makeSchemaError(
          'duplicate_namespace',
          `namespace '${ns.name}' is declared more than once (repeated at line ${ns.line})`,
          ns.line,
          { namespace: ns.name },
        ),
      );
    }
    seenNamespaceNames.add(ns.name);
  }

  const lookup = buildLookup(namespaces);
  const compiledNamespaces: Record<string, NamespaceConfig> = {};

  for (const ns of namespaces) {
    checkDuplicateMemberNames(ns, errors);
    checkCircularPermissions(ns, errors);

    const relations = compileRelations(ns, lookup, errors);

    const relationNames = new Set(ns.relations.map((r) => r.name));
    const permissionNames = new Set(ns.permissions.map((p) => p.name));
    const permissions: Record<string, CompiledPermission> = {};
    for (const permission of ns.permissions) {
      const rewrite = compileRewriteRule(permission.rewrite, {
        ns,
        lookup,
        relationNames,
        permissionNames,
        permissionName: permission.name,
        errors,
      });
      permissions[permission.name] = { kind: 'permission', name: permission.name, rewrite };
    }

    // Namespaces named more than once still get a (last-write-wins) entry
    // here so `compiledNamespaces` stays well-formed even though `errors`
    // is non-empty and the overall result will be rejected regardless.
    compiledNamespaces[ns.name] = { namespace: ns.name, relations, permissions };
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const schema: CompiledSchema = { namespaces: compiledNamespaces };
  return { ok: true, schema };
}

/**
 * The main entry point: parses and compiles DSL source text into a
 * `CompiledSchema`, or a structured, located list of every problem found.
 * Pure and deterministic — the same source always produces the same
 * output, and nothing here touches a filesystem, network, or database (a
 * CLI caller reads the file and passes its contents in as `source`).
 */
export function compileSchema(source: string): SchemaCompileResult {
  const parsed = parseSchema(source);
  if (!parsed.ok) {
    return { ok: false, errors: [parsed.error] };
  }
  return compileParsedNamespaces(parsed.namespaces);
}
