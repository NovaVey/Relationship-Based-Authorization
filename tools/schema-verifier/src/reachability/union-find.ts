/**
 * A tiny, immutable (clone-on-write) union-find with a "must never be
 * merged" side table, per build spec §5: "with only type bounds and
 * distinctness, this is union-find plus a type check, not a solver."
 *
 * Immutable rather than mutate-with-undo-log: the search (`search.ts`)
 * branches at every union-child choice and every `subjectTypes` option,
 * trying each in turn — a real backtracking search. Cloning this
 * structure at each branch point is the simplest way to make that
 * correct (no undo bugs possible), and it's cheap: build spec rule 0.5
 * calls these graphs "tiny — tens of nodes," so cloning a handful of
 * small `Map`s per branch is not a performance concern worth trading
 * correctness for.
 */

export type VarId = string;

export class UnionFind {
  /** Every variable's parent in the union-find forest; a variable that is its own parent is a representative. */
  private readonly parent: Map<VarId, VarId>;
  /** Representative -> set of representatives it must never be merged with. Symmetric: if A forbids B, B forbids A. */
  private readonly forbidden: Map<VarId, Set<VarId>>;
  /** `(objectVar, relationName)` -> the variable that slot is already pinned to — either from an invariant's own `relationEquals` constraint, or from an earlier step of the same search path reusing the same edge. */
  private readonly slots: Map<string, VarId>;

  private constructor(
    parent: Map<VarId, VarId>,
    forbidden: Map<VarId, Set<VarId>>,
    slots: Map<string, VarId>,
  ) {
    this.parent = parent;
    this.forbidden = forbidden;
    this.slots = slots;
  }

  static empty(): UnionFind {
    return new UnionFind(new Map(), new Map(), new Map());
  }

  /** Returns a fully independent copy — the same structure, sharing no mutable state with `this`. */
  clone(): UnionFind {
    return new UnionFind(
      new Map(this.parent),
      new Map([...this.forbidden].map(([k, v]) => [k, new Set(v)])),
      new Map(this.slots),
    );
  }

  /** Registers `id` as its own representative if it hasn't been seen before. Idempotent. */
  private ensure(id: VarId): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
    }
  }

  find(id: VarId): VarId {
    this.ensure(id);
    let root = id;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression.
    let cur = id;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  /** True if `a` and `b` are already known to be the same variable. */
  same(a: VarId, b: VarId): boolean {
    return this.find(a) === this.find(b);
  }

  /** True if merging `a` and `b` would violate a `distinct(...)` group already recorded. */
  private wouldConflict(a: VarId, b: VarId): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    return (this.forbidden.get(ra)?.has(rb) ?? false) || (this.forbidden.get(rb)?.has(ra) ?? false);
  }

  /**
   * Merges `a` and `b` into the same class. Returns `false` (no change
   * made) if they're already forced apart by a `distinct` group;
   * `true` otherwise (including when they were already the same).
   */
  union(a: VarId, b: VarId): boolean {
    this.ensure(a);
    this.ensure(b);
    if (this.wouldConflict(a, b)) return false;
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return true;
    // Prefer a named invariant variable (never starts with `$`, see
    // `search.ts`'s fresh-variable naming) as the surviving representative,
    // so witnesses read in terms of the invariant's own variable names
    // wherever one is available, rather than an internal `$freshN`.
    const [keep, drop] = ra.startsWith('$') && !rb.startsWith('$') ? [rb, ra] : [ra, rb];
    this.parent.set(drop, keep);
    const dropForbidden = this.forbidden.get(drop);
    if (dropForbidden) {
      for (const other of dropForbidden) {
        this.forbidden.get(other)?.delete(drop);
        this.forbidden.get(other)?.add(keep);
        this.addForbidden(keep, other);
      }
      this.forbidden.delete(drop);
    }
    return true;
  }

  private addForbidden(a: VarId, b: VarId): void {
    if (!this.forbidden.has(a)) this.forbidden.set(a, new Set());
    this.forbidden.get(a)!.add(b);
  }

  /** Marks every pair within `ids` as never-mergeable (a `distinct(...)` group). Returns `false` if any two are already the same variable (an immediately-contradictory invariant). */
  markDistinct(ids: readonly VarId[]): boolean {
    for (const id of ids) this.ensure(id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (this.same(ids[i]!, ids[j]!)) return false;
        this.addForbidden(this.find(ids[i]!), this.find(ids[j]!));
        this.addForbidden(this.find(ids[j]!), this.find(ids[i]!));
      }
    }
    return true;
  }

  /**
   * Pins `(objectVar, relationName)`'s value to `value` — merging with
   * whatever that slot is already bound to (from a prior constraint or
   * an earlier step of this same search) if it's already bound, or
   * binding it fresh if not. Returns `false` if that merge would
   * conflict with a `distinct` group.
   *
   * Keyed on `this.find(objectVar)`, not the raw `objectVar` string —
   * found and fixed alongside `search.ts`'s own cycle-guard soundness
   * fix (`docs/DECISIONS.md`, the entry documenting that fix): an
   * invariant can legally write two `relationEquals` lines pinning the
   * exact same `(subject, relation)` slot to two different named
   * variables (nothing in `invariants/parser.ts`'s grammar rejects a
   * repeated slot), which `bindSlot`'s own `union()` call below silently
   * unifies — `objectVar` and whatever it was unified with become the
   * same object, but were, until this fix, still two different raw
   * `VarId` strings. Keying this slot's own storage on the raw string
   * meant a *different* alias of that same now-unified object would
   * silently miss the pin entirely and treat the slot as unbound —
   * resolving through `find()` first means every alias of one object
   * shares one slot, matching what `union()` already made true about
   * their identity.
   */
  bindSlot(objectVar: VarId, relationName: string, value: VarId): boolean {
    const key = `${this.find(objectVar)}#${relationName}`;
    const existing = this.slots.get(key);
    if (existing === undefined) {
      this.slots.set(key, value);
      this.ensure(value);
      return true;
    }
    return this.union(existing, value);
  }

  /** The variable already bound to `(objectVar, relationName)`, if any — checked before introducing a fresh variable for a tuple-to-userset hop, so a constraint that already pinned this exact slot is reused rather than shadowed. Resolves `objectVar` through `find()` first, for the same reason `bindSlot` does — see that method's own doc comment. */
  slotValue(objectVar: VarId, relationName: string): VarId | undefined {
    return this.slots.get(`${this.find(objectVar)}#${relationName}`);
  }

  /**
   * True if `(objectVar, relationName)` is already bound — by a prior
   * `relationEquals` constraint, or an earlier step of this same search —
   * to something already known to be the same variable as `value`.
   * Read-only: unlike `bindSlot`, never binds the slot or unions anything,
   * so probing an unbound slot never fabricates a coincidental match.
   * Built for `notRelationEquals`'s two enforcement sites (`search.ts`,
   * `docs/DECISIONS.md` D-131): a `not <relation>(<var>) = <var>`
   * constraint needs to ask "would this binding collide with the excluded
   * value" without ever causing the union side effect that answering the
   * same question via `bindSlot` would.
   */
  slotEquals(objectVar: VarId, relationName: string, value: VarId): boolean {
    const existing = this.slotValue(objectVar, relationName);
    if (existing === undefined) return false;
    return this.same(existing, value);
  }
}
