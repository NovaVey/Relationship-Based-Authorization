import { ForbiddenError, RbacConfigurationError } from '../errors.js';
import type { AccessSubject, Permission, Role, RoleDefinition } from './types.js';

/**
 * Walks the (already duplicate- and unknown-reference-checked)
 * `inherits` graph looking for cycles, using the classic
 * white/gray/black DFS coloring so it can report every role on the cycle
 * it finds rather than just "a cycle exists somewhere".
 *
 * This runs once, at {@link RbacPolicy} construction time, so that a
 * misconfigured role hierarchy fails loudly on boot instead of silently
 * infinite-looping (or subtly under-resolving permissions) the first time
 * someone calls `permissionsFor`.
 */
function assertNoInheritanceCycles(definitions: ReadonlyMap<Role, RoleDefinition>): void {
  const state = new Map<Role, 'visiting' | 'done'>();
  const path: Role[] = [];

  const visit = (name: Role): void => {
    const status = state.get(name);
    if (status === 'done') return;
    if (status === 'visiting') {
      const cycleStart = path.indexOf(name);
      const cycle = [...path.slice(cycleStart), name];
      throw new RbacConfigurationError(`Role inheritance cycle detected: ${cycle.join(' -> ')}.`);
    }

    state.set(name, 'visiting');
    path.push(name);
    for (const parent of definitions.get(name)?.inherits ?? []) {
      visit(parent);
    }
    path.pop();
    state.set(name, 'done');
  };

  for (const name of definitions.keys()) {
    visit(name);
  }
}

/**
 * Resolves and enforces role-based access control for a fixed set of role
 * definitions.
 *
 * `RbacPolicy` instances are immutable and cheap to reuse: build one from
 * your application's role catalog at startup (typically as a singleton)
 * and share it across every `requirePermission` middleware and any
 * business logic that needs a manual `.can()` / `.assert()` check.
 *
 * All validation of the role graph itself (duplicate names, dangling
 * `inherits` references, inheritance cycles) happens eagerly in the
 * constructor, so a broken configuration fails at boot rather than
 * surfacing as a confusing runtime authorization bug much later.
 */
export class RbacPolicy {
  private readonly definitions: ReadonlyMap<Role, RoleDefinition>;

  /**
   * Memoizes each *known* role's fully-resolved (own + transitively
   * inherited) permission set. Safe to cache indefinitely because
   * `RbacPolicy` is immutable, the inheritance graph is guaranteed
   * cycle-free by the constructor, and the key space is bounded by
   * `definitions` — there are only ever as many entries here as roles
   * passed to the constructor.
   *
   * Deliberately does NOT memoize unknown role names (see
   * {@link resolveRole}) — that key space is *not* bounded, and is
   * reachable with arbitrary caller-controlled strings (e.g. through
   * `subjectFromRequestRoles`, which passes request-derived role strings
   * straight through with no validation against this policy's catalog).
   * Memoizing every distinct unknown string ever queried would let a
   * client trivially grow this map without bound just by sending a fresh
   * role name on each request — the same unbounded-growth shape
   * `MemoryRateLimitStore` had to guard against for its bucket map.
   */
  private readonly resolvedPermissionsByRole = new Map<Role, ReadonlySet<Permission>>();

  /**
   * @throws {RbacConfigurationError} if two role definitions share a name,
   * if a role's `inherits` references a role name absent from
   * `roleDefinitions`, or if the inheritance graph contains a cycle.
   */
  constructor(roleDefinitions: RoleDefinition[]) {
    const definitions = new Map<Role, RoleDefinition>();
    for (const definition of roleDefinitions) {
      if (definitions.has(definition.name)) {
        throw new RbacConfigurationError(
          `Duplicate role definition: role "${definition.name}" is defined more than once.`,
        );
      }
      // Defensive copy — this class's own docs promise "RbacPolicy instances
      // are immutable", but storing `definition` (and its `permissions`/
      // `inherits` arrays) by reference let a caller who still held onto
      // their original `roleDefinitions` array mutate a role's permissions
      // *after* construction, silently changing this policy's behavior —
      // verified live: pushing onto the original array's `permissions`
      // before that role's first resolution changed what `.can()` returned
      // for it, with no error or warning. Freezing the copies (not the
      // caller's own arrays) makes a mutation attempt on what this class
      // actually reads fail loudly instead of silently succeeding, the same
      // defense `runWithTenant` applies to `TenantContext`.
      definitions.set(definition.name, {
        name: definition.name,
        permissions: Object.freeze([...definition.permissions]),
        ...(definition.inherits ? { inherits: Object.freeze([...definition.inherits]) } : {}),
      });
    }

    for (const definition of definitions.values()) {
      for (const parent of definition.inherits ?? []) {
        if (!definitions.has(parent)) {
          throw new RbacConfigurationError(
            `Role "${definition.name}" inherits from unknown role "${parent}".`,
          );
        }
      }
    }

    assertNoInheritanceCycles(definitions);

    this.definitions = definitions;
  }

  /**
   * Resolves each role's own permission set, memoizing the result for
   * *known* roles only. Roles not present in the definitions passed to
   * the constructor resolve to an empty set — `permissionsFor` (and
   * therefore `can`) is deliberately lenient about unknown role *names* at
   * check time, since a subject may legitimately carry a role that was
   * retired from the catalog without every call site being updated in
   * lockstep.
   *
   * The unknown-role branch deliberately does NOT cache its result (see
   * {@link resolvedPermissionsByRole}): unlike a known role, that lookup
   * does no recursive work worth memoizing, and the "role name" here can
   * be arbitrary caller-controlled input — a `can()`/`assert()` call fed
   * by `subjectFromRequestRoles` passes whatever a client sent straight
   * through with no validation against this policy's catalog. Caching
   * every distinct value ever seen there would be unbounded, reachable
   * memory growth: an attacker sending a fresh, never-before-seen role
   * string on every request could grow this map without limit.
   */
  private resolveRole(role: Role): ReadonlySet<Permission> {
    const cached = this.resolvedPermissionsByRole.get(role);
    if (cached) return cached;

    const definition = this.definitions.get(role);
    if (!definition) {
      return new Set<Permission>();
    }

    const resolved = new Set<Permission>(definition.permissions);
    for (const parent of definition.inherits ?? []) {
      for (const permission of this.resolveRole(parent)) {
        resolved.add(permission);
      }
    }

    this.resolvedPermissionsByRole.set(role, resolved);
    return resolved;
  }

  /**
   * Returns the union of every permission granted to `roles`, own plus
   * transitively inherited. Role names that don't exist in this policy's
   * definitions contribute nothing (see {@link resolveRole}); this method
   * never throws on unknown roles, unlike the constructor's strict
   * validation of `inherits` references.
   */
  permissionsFor(roles: Role[]): Set<Permission> {
    const result = new Set<Permission>();
    for (const role of roles) {
      for (const permission of this.resolveRole(role)) {
        result.add(permission);
      }
    }
    return result;
  }

  /**
   * Checks whether `subject` holds `permission`, either exactly, via the
   * bare superuser wildcard `"*"`, or via a namespaced wildcard grant
   * (e.g. granted `"invoices:*"` matches requested `"invoices:read"`).
   *
   * This is a pure, side-effect-free query that never throws — prefer
   * {@link assert} at enforcement points so a denial fails loudly instead
   * of needing every call site to remember to check the boolean. A
   * missing `subject` itself (`null`/`undefined`, e.g. from a lookup that
   * came up empty) or a malformed `subject.roles` (not an array — e.g. a
   * single role string passed where `roles: [role]` was meant, or a
   * decoded-token claim that turned out not to be an array) is treated as
   * holding no roles at all and always resolves to `false`, the same
   * safe-by-default outcome as a subject that legitimately lacks the
   * permission. Without the `subject` check, a `null`/`undefined` subject
   * throws a raw `TypeError` reading `.roles` before `Array.isArray` is
   * ever reached; without the `Array.isArray` check, a *string* `roles`
   * value doesn't throw here (strings are iterable, so it silently
   * iterates character-by-character instead), which is worse than
   * throwing: it can coincidentally grant permissions from a
   * single-character role name.
   */
  can(subject: AccessSubject, permission: Permission): boolean {
    if (!subject || !Array.isArray(subject.roles)) return false;

    const granted = this.permissionsFor(subject.roles);
    if (granted.has(permission)) return true;

    for (const grantedPermission of granted) {
      if (grantedPermission === '*') return true;
      if (
        grantedPermission.endsWith(':*') &&
        permission.startsWith(grantedPermission.slice(0, -1))
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Enforces `permission` for `subject`, throwing rather than returning a
   * boolean so authorization failures can't be accidentally ignored by a
   * caller that forgets to check a return value.
   *
   * Always throws {@link ForbiddenError} on denial — including when
   * `subject` is missing entirely or `subject.roles` isn't an array (see
   * {@link can}) — never a raw, unbranded error, so callers (e.g.
   * `requirePermission`'s middleware) can reliably distinguish "denied"
   * from "something else went wrong" with a plain `instanceof` check.
   *
   * @throws {ForbiddenError} naming the missing permission, if {@link can} is false.
   */
  assert(subject: AccessSubject, permission: Permission): void {
    if (!this.can(subject, permission)) {
      const roles =
        subject && Array.isArray(subject.roles) ? subject.roles.join(', ') : String(subject?.roles);
      throw new ForbiddenError(
        `Subject with roles [${roles}] lacks required permission "${permission}".`,
        permission,
      );
    }
  }
}
