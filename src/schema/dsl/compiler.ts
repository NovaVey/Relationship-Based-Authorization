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
 *
 * The traversal itself is iterative (an explicit worklist stack), not
 * native JS recursion: a namespace with a very long, flat permission chain
 * (`permission pN = pN+1`, thousands deep, no `(` nesting anywhere) drove a
 * previous recursive version of this DFS to consume one native call-stack
 * frame per chain edge and overflow Node's real call stack — a second,
 * structurally separate denial-of-service path from `parser.ts`'s
 * paren-nesting depth cap (`MAX_EXPRESSION_NESTING_DEPTH`), since this
 * function only runs after parsing has already succeeded and never
 * recurses through `parseAtom`/`parseExpression` at all. Simulating the
 * call stack explicitly (one array entry per in-progress `dfs` frame,
 * lazily advancing each frame's own dependency index — exactly what the
 * native call stack would otherwise track for us) sidesteps the
 * native-recursion depth limit entirely rather than merely capping it,
 * which is the correct fix for a cycle-detection algorithm that has no
 * principled reason to bound how long a legitimate, acyclic permission
 * chain may be. See `docs/DECISIONS.md` for the audit this closes; see
 * D-013 (above) for the coloring/cycle semantics this rewrite preserves
 * exactly — verified by an extensive differential comparison against the
 * original recursive implementation across hand-built and randomly
 * generated permission graphs (self-loops, mutual cycles, longer cycles,
 * diamonds, disjoint components, and `tupleToUserset` edges that must
 * never contribute to the cycle graph) before this rewrite was trusted.
 */
function checkCircularPermissions(ns: ParsedNamespace, errors: SchemaError[]): void {
  // Guard: every map/set built below is keyed solely by `permission.name`
  // (`permissionsByName`, `deps`, and the DFS's own `color` map) — the
  // moment a namespace declares two *permissions* sharing a name, the
  // later declaration overwrites the earlier one in each of those maps,
  // so cycle detection only ever runs on whichever declaration happened
  // to be built/visited last. That silently drops a real cycle in the
  // overwritten declaration when it happens to be the first one (and,
  // depending on which declaration's dependency set survives the
  // overwrite, can also fabricate the *appearance* of a cycle that's
  // really an artifact of the alias) — purely a function of source
  // order, not of the schema's actual shape. This exact case is already
  // independently and deterministically rejected by
  // `checkDuplicateMemberNames`'s `duplicate_member_name` error (run
  // just before this function, see `compileParsedNamespaces` below), and
  // "is this permission-permission-cycle graph acyclic" has no
  // well-defined meaning once two of its nodes share one name and one
  // map slot anyway — so this function's own cycle analysis is skipped
  // entirely for a namespace with such a collision, rather than made to
  // second-guess which of the two colliding declarations "wins" the
  // graph. This keeps `checkCircularPermissions`'s behavior
  // order-independent (full-repo audit finding #2, confirmed via
  // `permission x = x; permission x = owner` compiling with only
  // `duplicate_member_name` in one declaration order but also gaining a
  // spurious/accidental `circular_permission_definition` in the other) —
  // see `docs/DECISIONS.md`. Scoped to permission-permission name
  // collisions specifically (not every `duplicate_member_name` cause):
  // a relation and a permission sharing a name doesn't alias anything
  // here, since `relationNames` and `permissionsByName` are always built
  // from disjoint source lists and `collectPermissionDeps` below already
  // treats a name present in `relationNames` as grounding, never as a
  // permission dependency, regardless of any same-named permission.
  const permissionNameCounts = new Map<string, number>();
  for (const permission of ns.permissions) {
    permissionNameCounts.set(permission.name, (permissionNameCounts.get(permission.name) ?? 0) + 1);
  }
  if ([...permissionNameCounts.values()].some((count) => count > 1)) {
    return;
  }

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
    // Joined once, outside the loop below — found live while load-testing
    // the iterative `dfs` rewrite at very large N: with `cycle.join(' -> ')`
    // called once per member *inside* the loop (as this line originally
    // read), a single reported cycle of length N costs O(N) to render each
    // of its N member messages, for O(N^2) total — invisible for any
    // legitimate-sized cycle (a cycle is always a compile error, so no
    // legitimate schema has a large one), but a genuine, newly-reachable
    // CPU/memory-exhaustion path for a large adversarial one now that the
    // iterative `dfs` no longer stack-overflows before a large cycle can be
    // fully detected. See docs/DECISIONS.md.
    const cyclePath = cycle.join(' -> ');
    for (const member of cycle) {
      if (reported.has(member)) continue;
      reported.add(member);
      const permission = permissionsByName.get(member);
      if (!permission) continue;
      errors.push(
        makeSchemaError(
          'circular_permission_definition',
          `permission '${member}' on namespace '${ns.name}' is circularly defined with no relation to ground it (${cyclePath}) at line ${permission.line}`,
          permission.line,
          { namespace: ns.name, member },
        ),
      );
    }
  }

  // Iterative DFS: an explicit worklist stack stands in for what native
  // recursion would otherwise track on the real JS call stack. Each frame
  // is one in-progress `dfs(name, path)` call from the original recursive
  // version, with `depIndex` recording exactly how far that call's own
  // `for (const dep of deps.get(name))` loop had gotten — the same thing
  // a paused native stack frame would remember for us. `path` is the
  // single shared array every recursive call would otherwise have been
  // passed by reference (see this function's own doc comment above);
  // pushing/popping it here at exactly the same points the recursive
  // version did (frame creation / frame completion) is what keeps cycle
  // reporting byte-identical to the original.
  interface DfsFrame {
    name: string;
    depsList: string[];
    depIndex: number;
  }

  function dfsFrom(startName: string): void {
    const path: string[] = [];
    const stack: DfsFrame[] = [];

    const pushFrame = (name: string): void => {
      color.set(name, GREY);
      path.push(name);
      stack.push({ name, depsList: [...(deps.get(name) ?? [])], depIndex: 0 });
    };

    pushFrame(startName);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.depIndex < frame.depsList.length) {
        const dep = frame.depsList[frame.depIndex]!;
        frame.depIndex += 1;
        const depColor = color.get(dep) ?? WHITE;
        if (depColor === GREY) {
          const cycleStart = path.indexOf(dep);
          reportCycle([...path.slice(cycleStart), dep]);
        } else if (depColor === WHITE) {
          pushFrame(dep);
        }
        // depColor === BLACK: already fully explored — the recursive
        // version never re-entered `dfs` for a BLACK node either.
      } else {
        path.pop();
        color.set(frame.name, BLACK);
        stack.pop();
      }
    }
  }

  for (const permission of ns.permissions) {
    if ((color.get(permission.name) ?? WHITE) === WHITE) {
      dfsFrom(permission.name);
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
