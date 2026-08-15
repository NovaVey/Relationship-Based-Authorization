/**
 * Core RBAC vocabulary shared by {@link RbacPolicy} (`rbac/policy.ts`) and
 * the middleware factories in `rbac/middleware.ts`.
 *
 * These are kept as plain string aliases (rather than enums or branded
 * types) so consumers can define roles and permissions as ordinary string
 * literals or constants without any coupling to this package's types.
 */

/** The name of a role, e.g. `"admin"` or `"billing-viewer"`. */
export type Role = string;

/**
 * A single grantable capability, conventionally namespaced as
 * `"<resource>:<action>"` (e.g. `"invoices:read"`).
 *
 * A granted permission ending in `":*"` (e.g. `"invoices:*"`) acts as a
 * wildcard that matches any requested permission sharing its prefix (e.g.
 * `"invoices:read"`, `"invoices:write"`). The bare permission `"*"` is a
 * superuser wildcard that matches every requested permission.
 */
export type Permission = string;

/**
 * Declares a role's own permissions and, optionally, other roles it
 * inherits from. Inheritance is transitive: a role picks up every
 * permission granted to any role reachable through `inherits`, however
 * deep the chain.
 */
export interface RoleDefinition {
  /** Unique name for this role. Must be unique across the definitions passed to {@link RbacPolicy}. */
  name: Role;
  /**
   * Permissions granted directly to this role, independent of inheritance.
   * Typed `readonly` because {@link RbacPolicy}'s constructor defensively
   * copies (and freezes) this array rather than storing your reference —
   * mutating an array you passed in after construction never affects an
   * already-built policy, matching its own "instances are immutable" docs.
   */
  permissions: readonly Permission[];
  /**
   * Names of other roles this role inherits permissions from. Every name
   * here must correspond to another role in the same definition list —
   * {@link RbacPolicy} validates this eagerly at construction time. Also
   * defensively copied and frozen, for the same reason as `permissions`.
   */
  inherits?: readonly Role[];
}

/**
 * The caller a permission check is evaluated against: which tenant they're
 * acting within, and which roles they hold.
 *
 * Carrying `tenantId` here (rather than relying solely on ambient tenant
 * context) keeps `RbacPolicy.can` / `.assert` pure and testable, while
 * {@link subjectFromRequestRoles} (see `rbac/middleware.ts`) still ties it
 * back to the active tenant context by construction for defense-in-depth.
 */
export interface AccessSubject {
  /** The tenant this subject is currently acting within. */
  tenantId: string;
  /** Role names held by this subject within that tenant. */
  roles: Role[];
}
