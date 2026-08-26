/**
 * Witness reconstruction — turns a SAT model back into a concrete
 * `WitnessTuple[]`, the same shape `../reachability/search.ts`'s own
 * `materialize()` produces for the exact monotone prover. Walks the
 * *same* `FNode` tree `../smt/encode.ts` built alongside the z3 formula,
 * guided at every OR by the model's own truth values — never every atom
 * this encoder happened to declare (many of which the model may leave
 * unconstrained/irrelevant), only the ones actually needed along one
 * satisfying derivation, mirroring how `materialize()` only ever walks
 * the one path `attempt()` actually found.
 *
 * This is reconstruction, not proof: per `../smt/index.ts`'s own
 * discipline (and this whole project's, since D-117), nothing here is
 * ever reported to a caller as `VIOLATED` until the tuples this produces
 * are independently replayed against the real, unmodified engine.
 */
import type { Model } from 'z3-solver';
import type { Encoding, FNode } from './encode.js';
import type { WitnessTuple } from '../reachability/types.js';

/** A canonical, model-scoped identity for one z3 constant — two different constants the model happens to equate collapse to the same label. `sexpr()` (declared directly on `Ast`, unlike `toString()`, whose declared return type on the generic `Expr` this function receives isn't guaranteed to be more than `Object`'s own default) gives a stable s-expression string for the model's own concrete value. */
function canonicalKey(
  model: Model<'main'>,
  type: string,
  term: Parameters<Model<'main'>['eval']>[0],
): string {
  const value = model.eval(term, true);
  return `${type}::${value.sexpr()}`;
}

/**
 * Extracts one minimal `WitnessTuple[]` from `model`, a satisfying
 * assignment for `encoding.goal`. Returns `undefined` if the tree can't
 * be walked to a consistent conclusion (an `or` node where the model
 * doesn't actually mark any option true — should be unreachable for a
 * genuinely satisfying model, but treated as "this tier doesn't apply"
 * rather than trusted blindly, per this tier's own overriding rule: a
 * witness that can't be honestly reconstructed is never fabricated).
 */
export function extractWitness(
  encoding: Encoding,
  model: Model<'main'>,
): WitnessTuple[] | undefined {
  const { ctx } = encoding;
  const labels = new Map<string, string>();
  let counter = 0;

  function labelFor(
    type: string,
    term: Parameters<Model<'main'>['eval']>[0],
    preferred?: string,
  ): string {
    const key = canonicalKey(model, type, term);
    const existing = labels.get(key);
    if (existing) return existing;
    const label = preferred ?? ((counter += 1), `obj${counter}`);
    labels.set(key, label);
    return label;
  }

  // Seed every invariant-declared variable's own label first (`s`, `o`,
  // `orgA`, ...) — matching `materialize()`'s own "prefer a named
  // invariant variable" convention, and critically ensuring the goal's
  // own subject/object end up labeled exactly `invariant.goal.subject`/
  // `invariant.goal.object`, the literal strings `replayWitness` uses.
  for (const [name, { term, type }] of encoding.declared) {
    labelFor(type, term, name);
  }

  function walk(node: FNode): WitnessTuple[] | undefined {
    switch (node.kind) {
      case 'atom': {
        const { atom } = node;
        return [
          {
            objectType: atom.objectType,
            object: labelFor(atom.objectType, atom.object),
            relation: atom.relation,
            subjectType: atom.subjectType,
            subject: labelFor(atom.subjectType, atom.subject),
            ...(atom.subjectRelation !== undefined
              ? { subjectRelation: atom.subjectRelation }
              : {}),
          },
        ];
      }
      case 'and': {
        const out: WitnessTuple[] = [];
        for (const child of node.children) {
          const sub = walk(child);
          if (sub === undefined) return undefined;
          out.push(...sub);
        }
        return out;
      }
      case 'or': {
        for (const option of node.options) {
          if (ctx.isTrue(model.eval(option.term, true))) {
            return walk(option.node);
          }
        }
        return undefined;
      }
      case 'not':
      case 'false':
        return [];
      default: {
        const _never: never = node;
        throw new Error(`extractWitness: unhandled node kind ${JSON.stringify(_never)}`);
      }
    }
  }

  const fromGoal = walk(encoding.goal.node);
  if (fromGoal === undefined) return undefined;
  return [...encoding.given, ...fromGoal];
}
