/**
 * Witness reconstruction for the CHC tier — the counterpart to
 * `./witness.ts` (which walks a *model*, guided by the model's own truth
 * values at every OR, since the non-recursive tier's SAT result comes with
 * exactly one flat model to inspect). `Fixedpoint` exposes no equivalent
 * model for a `'sat'` `query()` result — only `getAnswer()`, a derivation
 * *proof* term (`hyper-res`/`asserted`/`mp` combinators). Tried it directly
 * against this tier's own real encoding (`./chc-encode.ts`) before
 * designing this module: for a goal whose base predicates are all
 * unconditionally true (this encoder's own, deliberate choice — see
 * `./chc-encode.ts`'s own header comment), the derivation is close to
 * immediate, and the returned proof term carries no useful trace of
 * *which* union/intersection branch or *which* concrete intermediate
 * object the derivation actually used — parsing it would mean guessing at
 * an internal, undocumented, version-specific proof-term shape for
 * information it does not reliably carry, the exact kind of fragility
 * `./encode.ts`'s own header comment already rejected native quantifiers
 * for for the very same reason (needing to reverse-engineer Z3's own
 * internals to answer "what value did the solver actually use").
 *
 * **What this does instead: walk the schema graph top-down, exactly the
 * traversal `./chc-encode.ts`'s own `compileNode` already did to *build*
 * the Horn-clause program, and re-`query()` that same, already-built,
 * unmodified program at every branch point to discover which branch was
 * actually used** — never trusting a guess, always confirming through the
 * real Horn-clause relations `./chc-encode.ts` registered. This is sound
 * for a structural reason specific to this encoder's own construction, not
 * merely a hopeful heuristic: every rule `./chc-encode.ts` ever builds is
 * "value-blind" in its own object argument — no rule anywhere pins the
 * object-side variable to a specific ground value (only the *subject* is
 * ever baked in as a ground constant, and always as an argument to a
 * base predicate that is itself unconditionally true regardless of what
 * else is passed to it). A direct, checkable consequence: every registered
 * `Rel_<nodeId>` relation this encoder builds is, for its own single `Int`
 * argument, either satisfiable for *every* integer or for *none* — so a
 * freshly minted, never-before-used integer for a `tupleToUserset`/
 * userset-hop's own intermediate object is never a "wrong guess" the way
 * it could be in a schema where relations distinguish specific values;
 * it either works (because the relevant sub-relation is non-empty, in
 * which case it holds for this fresh value too) or the whole branch is
 * genuinely a dead end (in which case *no* value would have worked
 * either). This module still confirms it live at every step via a real
 * `fp.query()` — belt-and-suspenders, matching this whole project's own
 * "never trust a derivation without checking" discipline — rather than
 * relying on the argument above alone.
 *
 * Same non-negotiable as `./witness.ts`: this is reconstruction, not
 * proof. `./chc.ts` never reports a result this module produces as
 * `VIOLATED` until `replayWitness` independently confirms it against the
 * real, unmodified production engine.
 */
import type { Bool } from 'z3-solver';
import { predicateKey, type ChcEncoding } from './chc-encode.js';
import type { GraphEdge, NodeId } from '../ir/types.js';
import type { WitnessTuple } from '../reachability/types.js';

/**
 * How many `walk()` calls one `extractChcWitness()` may make before giving
 * up honestly — this tier's own counterpart to `../reachability/search.ts`'s
 * `MAX_ATTEMPT_CALLS`. Every step here is justified by a real, confirmed
 * `fp.query()` (see this file's own header comment), so — unlike that
 * budget's own doc comment — this one is not defending against a
 * combinatorial blowup from a relaxed cycle guard; it exists purely as the
 * same disclosed, defensive ceiling every other tier in this codebase
 * carries, in case this encoder's own "value-blind" argument above ever
 * fails to hold for some schema shape not yet seen.
 */
export const MAX_CHC_WITNESS_STEPS = 10_000;

function groupByKind(edges: readonly GraphEdge[]): Map<GraphEdge['kind'], GraphEdge[]> {
  const byKind = new Map<GraphEdge['kind'], GraphEdge[]>();
  for (const e of edges) {
    const bucket = byKind.get(e.kind);
    if (bucket) bucket.push(e);
    else byKind.set(e.kind, [e]);
  }
  return byKind;
}

/**
 * Reconstructs one concrete `WitnessTuple[]` for `encoding`'s own goal,
 * already confirmed `'sat'` by `./chc.ts` — or `undefined` if it can't be
 * honestly reconstructed (this tier's own overriding rule, matching every
 * other tier: a witness that can't be walked to a consistent conclusion is
 * never fabricated, only declined).
 */
export async function extractChcWitness(
  encoding: ChcEncoding,
): Promise<WitnessTuple[] | undefined> {
  const { ctx, fp, graph, subjectValue, subjectType } = encoding;
  let nextFresh = encoding.nextFreshValue;
  function freshValue(): number {
    const v = nextFresh;
    nextFresh += 1;
    return v;
  }

  const labels = new Map<number, string>();
  let labelCounter = 0;
  for (const [name, { value }] of encoding.namedValues) {
    if (!labels.has(value)) labels.set(value, name);
  }
  function labelFor(value: number): string {
    const existing = labels.get(value);
    if (existing) return existing;
    labelCounter += 1;
    const label = `obj${labelCounter}`;
    labels.set(value, label);
    return label;
  }

  let steps = 0;
  async function relationHolds(nodeId: NodeId, objVal: number): Promise<boolean> {
    const rel = encoding.relations.get(nodeId);
    if (rel === undefined) return false; // defensive only: every node this walk visits was registered during encoding.
    const result = await fp.query(rel.decl.call(ctx.Int.val(objVal)) as Bool<'main'>);
    return result === 'sat';
  }

  async function walk(nodeId: NodeId, objVal: number): Promise<WitnessTuple[] | undefined> {
    steps += 1;
    if (steps > MAX_CHC_WITNESS_STEPS) return undefined;

    const rel = encoding.relations.get(nodeId);
    if (rel === undefined) return undefined;
    const objType = rel.namespace;

    const edges = graph.edgesFrom.get(nodeId) ?? [];
    const byKind = groupByKind(edges);

    const direct = byKind.get('direct');
    if (direct) {
      const edge = direct[0]!;
      if (edge.kind !== 'direct') throw new Error('unreachable');
      const node = graph.nodes.get(nodeId);
      if (node?.kind !== 'named') return undefined;
      const relationName = node.name;
      for (const st of edge.subjectTypes) {
        if (st.relation === undefined) {
          if (st.namespace !== subjectType) continue;
          const key = predicateKey(objType, relationName, st.namespace);
          const pred = encoding.predicates.get(key);
          if (pred === undefined) continue;
          const ok = await fp.query(
            pred.decl.call(ctx.Int.val(objVal), ctx.Int.val(subjectValue)) as Bool<'main'>,
          );
          if (ok !== 'sat') continue;
          return [
            {
              objectType: objType,
              object: labelFor(objVal),
              relation: relationName,
              subjectType: st.namespace,
              subject: labelFor(subjectValue),
            },
          ];
        }
        if (st.target === undefined) continue;
        const key = predicateKey(objType, relationName, st.namespace, st.relation);
        const pred = encoding.predicates.get(key);
        if (pred === undefined) continue;
        const fv = freshValue();
        const hopOk = await fp.query(
          pred.decl.call(ctx.Int.val(objVal), ctx.Int.val(fv)) as Bool<'main'>,
        );
        if (hopOk !== 'sat') continue;
        const targetOk = await relationHolds(st.target, fv);
        if (!targetOk) continue;
        const sub = await walk(st.target, fv);
        if (sub === undefined) continue;
        return [
          {
            objectType: objType,
            object: labelFor(objVal),
            relation: relationName,
            subjectType: st.namespace,
            subject: labelFor(fv),
            subjectRelation: st.relation,
          },
          ...sub,
        ];
      }
      return undefined;
    }

    const computed = byKind.get('computedUserset');
    if (computed) {
      const edge = computed[0]!;
      if (edge.kind !== 'computedUserset') throw new Error('unreachable');
      return walk(edge.to, objVal);
    }

    const ttu = byKind.get('tupleToUserset');
    if (ttu) {
      const edge = ttu[0]!;
      if (edge.kind !== 'tupleToUserset') throw new Error('unreachable');
      for (const t of edge.targets) {
        const key = predicateKey(objType, edge.viaRelation, t.namespace);
        const pred = encoding.predicates.get(key);
        if (pred === undefined) continue;
        const fv = freshValue();
        const hopOk = await fp.query(
          pred.decl.call(ctx.Int.val(objVal), ctx.Int.val(fv)) as Bool<'main'>,
        );
        if (hopOk !== 'sat') continue;
        const targetOk = await relationHolds(t.target, fv);
        if (!targetOk) continue;
        const sub = await walk(t.target, fv);
        if (sub === undefined) continue;
        return [
          {
            objectType: objType,
            object: labelFor(objVal),
            relation: edge.viaRelation,
            subjectType: t.namespace,
            subject: labelFor(fv),
          },
          ...sub,
        ];
      }
      return undefined;
    }

    const union = byKind.get('unionChild');
    if (union) {
      for (const e of union) {
        if (e.kind !== 'unionChild') throw new Error('unreachable');
        const ok = await relationHolds(e.to, objVal);
        if (!ok) continue;
        const sub = await walk(e.to, objVal);
        if (sub !== undefined) return sub;
      }
      return undefined;
    }

    const intersection = byKind.get('intersectionChild');
    if (intersection) {
      const all: WitnessTuple[] = [];
      for (const e of intersection) {
        if (e.kind !== 'intersectionChild') throw new Error('unreachable');
        const sub = await walk(e.to, objVal);
        if (sub === undefined) return undefined;
        all.push(...sub);
      }
      return all;
    }

    // Exclusion never reaches this point — `./chc-encode.ts` already
    // declines during compilation before any `Fixedpoint` program
    // containing one is ever built.
    return undefined;
  }

  const topLevelOk = await relationHolds(encoding.goalRelation.nodeId, encoding.goalObjectValue);
  if (!topLevelOk) return undefined;
  const fromGoal = await walk(encoding.goalRelation.nodeId, encoding.goalObjectValue);
  if (fromGoal === undefined) return undefined;
  return [...encoding.given, ...fromGoal];
}
