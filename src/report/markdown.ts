/**
 * Human-readable rendering of a `soundness_runs` row — build spec
 * `.claude/commands/build-authz-service.md` §6.5 (asymmetric verdicts),
 * §6.7 (resolution paths), §8 (design direction, binding per that section's
 * own header), §9 Phase 7's exit criterion. Pure functions only: everything
 * here takes a `SoundnessRunResult` (already fully computed by
 * `src/soundness/runner.ts`) and returns a string. No Postgres, no GitHub
 * API, no `process.env` — I/O and CLI wiring belong to
 * `src/cli/commands/soundness.ts` and `.github/workflows/soundness.yml`,
 * neither of which this file touches or imports.
 *
 * ---
 *
 * **The non-linear resolution-path problem (D-036) and the approach taken
 * here.** `union`/`tupleToUserset` reduce naturally to §8's single
 * arrow-chain notation (`user:alice → group:eng#member → ... →
 * document:readme#view`) because each is genuinely a linear witness: one
 * branch, one hop, one proof. `intersection` (every branch required) and
 * `exclusion` (a proof of `base` AND a disproof of `subtract`) are not
 * linear — there is no single chain that means "both of these were
 * required" or "this holds, and specifically this other thing was shown not
 * to." The chosen rendering:
 *
 * - Everywhere the proof tree IS linear (a run of `directGrant` /
 *   `usersetMembership` / `tupleToUserset` / transparent `union` hops, all
 *   the way down), it renders as exactly one `→`-joined chain line — the
 *   common case, and the one that matches §8's own worked example.
 * - The moment an `intersection` or `exclusion` node is reached anywhere in
 *   the tree, rendering switches to a labeled, indented structure at that
 *   point and *only* that point — an `intersection` becomes an "AND — all N
 *   required" block with each branch numbered and independently rendered
 *   (recursively, so a branch that's itself linear still collapses back to
 *   one chain line); an `exclusion` becomes "base holds, excluding:"
 *   followed by the base's own rendering and then a structurally symmetric
 *   rendering of the `subtractDisproof` tree (mirroring the same
 *   proof/disproof duality `docs/DECISIONS.md` D-036 built into the
 *   resolvers themselves) — every disproof leaf (`relationDisproof`,
 *   `boundReached`, `undeclared`, ...) is rendered with its own real
 *   evidence, never collapsed to "and it doesn't hold, trust that."
 * - Nothing is ever flattened into a bare divergence count. "8 divergences
 *   found" never appears anywhere in this file's output — every divergence
 *   gets its own rendered block, every block gets its own resolution path
 *   (or an explicit note that none was recorded, which only happens for a
 *   `false_deny` produced by a synthetic test double, never a real run).
 *   The one deliberate exception: once the running rendered body approaches
 *   this report's own size budget (`DEFAULT_MAX_COMMENT_CHARS`, see
 *   `RenderSoundnessMarkdownOptions.maxCommentChars`), further `false_grant`
 *   entries stop rendering their own block — but the true total count and an
 *   unmissable, un-muted truncation notice always render in their place; a
 *   `false_grant` is never quietly summarized the casual way `false_deny`'s
 *   own overflow is (see `docs/DECISIONS.md` D-084 — closes a real crash: an
 *   uncapped `false_grant` count could itself cross GitHub's hard PR-comment
 *   size limit and take down the comment poster before it posted anything).
 *
 * This module normalizes the reference resolver's and the production
 * resolver's independently-declared `ResolutionStep`/`DisproofStep` shapes
 * (`src/resolve/reference/resolver.ts`, `src/resolve/production/
 * resolver.ts` — deliberately un-shared per D-022, since sharing walking
 * code between the two *resolvers* is what §6.2 forbids) into one internal
 * `RenderProofNode`/`RenderDisproofNode` shape purely for *display*. This is
 * not a violation of D-022: nothing here is walked by either resolver, nor
 * does either resolver import from this file — this is a downstream
 * reporting layer consuming both resolvers' already-computed output, the
 * same way a human reading two independent lab reports is free to put them
 * side by side on one page without compromising the independence of the two
 * labs. The one place the two resolvers' own disproof shapes genuinely
 * differ (`RelationDisproof` — D-037: the reference resolver's is a nested
 * tree, the production resolver's is a flat reachability certificate) is
 * handled by two separate, resolver-specific "detail line" builders rather
 * than forcing a shared shape — matching D-037's own reasoning for why that
 * difference is real and not cosmetic.
 *
 * ---
 *
 * **`false_grant` gets the one reserved alert treatment.** Markdown has no
 * color, so the reserved marker is a bold, all-caps, backticked label —
 * `**FALSE_GRANT**` — used nowhere else in this file's output, ever. No
 * emoji: the report-designer brief's own copy rules forbid one "anywhere a
 * false_grant could appear," which supersedes this task's own suggestion
 * that a fixed emoji was an equally valid alternative to a bold label — see
 * this project's final report for that conflict stated explicitly.
 * `false_deny` and `insufficient_coverage` are always rendered in a plain,
 * muted register (lowercase, backticked, never bold) — visible, counted,
 * never competing with a `false_grant` for attention.
 */
import type { SoundnessRunResult, DivergenceRecord } from '../soundness/runner.js';
import type {
  ResolutionStep as ReferenceResolutionStep,
  DisproofStep as ReferenceDisproofStep,
} from '../resolve/reference/resolver.js';
import type {
  ResolutionStep as ProductionResolutionStep,
  DisproofStep as ProductionDisproofStep,
} from '../resolve/production/resolver.js';

/**
 * Embedded verbatim in every rendered report, always as the very first
 * line. `src/report/prComment.ts`'s `decidePrCommentAction` looks for this
 * exact string in a prior comment's body to decide "update this one" vs.
 * "post a new one" — an HTML comment so it never renders visibly on GitHub,
 * but survives in the raw body text `prComment.ts` is handed.
 */
export const SOUNDNESS_REPORT_MARKER = '<!-- authz:soundness-report -->';

/** The one reserved label for a `false_grant` — never used for anything else in this file. */
const FALSE_GRANT_LABEL = '**FALSE_GRANT**';

/** The muted, non-blocking label — plain, lowercase, backticked, never bold. */
const FALSE_DENY_LABEL = '`false_deny`';

const DEFAULT_MAX_RENDERED_FALSE_DENY = 20;

/**
 * Soft ceiling, in characters, this renderer targets for the WHOLE rendered
 * document — deliberately well under GitHub's real PR-comment/issue-comment
 * body limit (~65,536 characters; empirically confirmed, not this project's
 * own guess, by a real 422 rejection past that point — full-repo audit
 * finding, 2026-08-16), to leave real headroom for the `false_deny` section,
 * the headline, and everything else that renders after the `false_grant`
 * section this budget actually governs (see the loop in
 * `renderSoundnessMarkdown` below). Before this existed, `false_grant`
 * rendered every entry unconditionally, in full, regardless of count —
 * correct in spirit (§8/report-designer brief: a `false_grant` must never be
 * summarized away) but with no ceiling at all, a genuine regression that
 * flips a commonly-hit relation to always-allow could produce hundreds of
 * `false_grant`s in one 5,000-query fuzz run, cross this exact limit, and
 * crash `scripts/post-soundness-comment.mjs` on GitHub's own 422 before it
 * ever posted a comment — silencing the report for exactly the worst-case
 * finding it exists to surface. This value stays a soft, disclosed budget,
 * never a silent hard cutoff: crossing it stops rendering further
 * `false_grant` entries, but always states the true total count and an
 * unmissable notice in their place — see `docs/DECISIONS.md` D-084.
 */
const DEFAULT_MAX_COMMENT_CHARS = 60_000;

// ---------------------------------------------------------------------------
// Internal normalized tree — see this file's own top-of-file doc comment.
// ---------------------------------------------------------------------------

interface RenderEntity {
  ns: string;
  id: string;
}

type RenderProofNode =
  | { kind: 'directGrant'; object: RenderEntity; relation: string; subject: RenderEntity }
  | {
      kind: 'usersetMembership';
      object: RenderEntity;
      relation: string;
      userset: RenderEntity;
      usersetRelation: string;
      member: RenderProofNode;
    }
  | { kind: 'union'; object: RenderEntity; branchIndex: number; branch: RenderProofNode }
  | { kind: 'intersection'; object: RenderEntity; branches: RenderProofNode[] }
  | {
      kind: 'exclusion';
      object: RenderEntity;
      base: RenderProofNode;
      subtractDisproof: RenderDisproofNode;
    }
  | {
      kind: 'tupleToUserset';
      object: RenderEntity;
      relation: string;
      computedUserset: string;
      through: RenderEntity;
      member: RenderProofNode;
    };

type RenderDisproofNode =
  | { kind: 'relationDisproof'; object: RenderEntity; relation: string; detailLines: string[] }
  | { kind: 'unionDisproof'; object: RenderEntity; branches: RenderDisproofNode[] }
  | {
      kind: 'intersectionDisproof';
      object: RenderEntity;
      branchIndex: number;
      branch: RenderDisproofNode;
    }
  | {
      kind: 'exclusionDisproof';
      object: RenderEntity;
      reason:
        | { kind: 'baseDisproven'; base: RenderDisproofNode }
        | { kind: 'subtractProven'; subtract: RenderProofNode }
        // The fix for the exclusion/cycle-guard soundness gap — see both
        // resolvers' own `ExclusionDisproof` doc comment. Structurally
        // unreachable through this file's own real callers today (a
        // top-level check's own disproof is never surfaced; this reason
        // can only ever appear *inside* the disproof tree that already
        // shows up in that scenario — never inside a winning proof's own
        // `subtractDisproof`, since anything tainting `subtract` also taints
        // the containing exclusion itself, which then can't be `allowed:
        // true` either) — handled anyway for type-level exhaustiveness and
        // in case a future feature surfaces a bare disproof directly.
        | { kind: 'subtractUnprovable'; subtract: RenderDisproofNode };
    }
  | {
      kind: 'tupleToUsersetDisproof';
      object: RenderEntity;
      relation: string;
      followed: Array<{ through: RenderEntity; disproof: RenderDisproofNode }>;
    }
  | { kind: 'boundReached'; object: RenderEntity; name: string; reason: 'cycle' | 'depth' }
  | { kind: 'undeclared'; object: RenderEntity; name: string };

function assertNever(x: never): never {
  throw new Error(`report/markdown: unreachable node ${JSON.stringify(x)}`);
}

// ---------------------------------------------------------------------------
// Normalize: reference resolver's own shapes -> the internal render tree.
// ---------------------------------------------------------------------------

function normalizeReferenceProof(step: ReferenceResolutionStep): RenderProofNode {
  switch (step.kind) {
    case 'directGrant':
      return {
        kind: 'directGrant',
        object: step.object,
        relation: step.relation,
        subject: step.subject,
      };
    case 'usersetMembership':
      return {
        kind: 'usersetMembership',
        object: step.object,
        relation: step.relation,
        userset: step.userset,
        usersetRelation: step.usersetRelation,
        member: normalizeReferenceProof(step.member),
      };
    case 'union':
      return {
        kind: 'union',
        object: step.object,
        branchIndex: step.branchIndex,
        branch: normalizeReferenceProof(step.branch),
      };
    case 'intersection':
      return {
        kind: 'intersection',
        object: step.object,
        branches: step.branches.map(normalizeReferenceProof),
      };
    case 'exclusion':
      return {
        kind: 'exclusion',
        object: step.object,
        base: normalizeReferenceProof(step.base),
        subtractDisproof: normalizeReferenceDisproof(step.subtractDisproof),
      };
    case 'tupleToUserset':
      return {
        kind: 'tupleToUserset',
        object: step.object,
        relation: step.relation,
        computedUserset: step.computedUserset,
        through: step.through,
        member: normalizeReferenceProof(step.member),
      };
    default:
      return assertNever(step);
  }
}

/**
 * The reference resolver's own `RelationDisproof` (`resolveRelation`'s
 * output) is a nested tree of every tuple examined on `(object, relation)` —
 * see D-036/D-037. Rendered here as a numbered list of the real tuples that
 * were considered, each with its own reason, recursing into the nested case
 * (`usersetNotMember`) via the same disproof renderer used everywhere else.
 */
function referenceRelationDetailLines(
  step: Extract<ReferenceDisproofStep, { kind: 'relationDisproof' }>,
): string[] {
  if (step.tupleDisproofs.length === 0) {
    return [`no tuples stored for ${relLabel(step.object, step.relation)}`];
  }
  return step.tupleDisproofs.flatMap((td, i) => {
    const n = i + 1;
    if (td.kind === 'subjectMismatch') {
      return [
        `${n}. ${relLabel(step.object, step.relation)}@${entityLabel(td.subject)} — not the queried subject`,
      ];
    }
    const nested = renderDisproofStructured(normalizeReferenceDisproof(td.disproof), '   ');
    return [
      `${n}. ${relLabel(step.object, step.relation)}@${relLabel(td.userset, td.usersetRelation)} — queried subject is not a member:`,
      ...nested,
    ];
  });
}

function normalizeReferenceDisproof(step: ReferenceDisproofStep): RenderDisproofNode {
  switch (step.kind) {
    case 'relationDisproof':
      return {
        kind: 'relationDisproof',
        object: step.object,
        relation: step.relation,
        detailLines: referenceRelationDetailLines(step),
      };
    case 'unionDisproof':
      return {
        kind: 'unionDisproof',
        object: step.object,
        branches: step.branches.map(normalizeReferenceDisproof),
      };
    case 'intersectionDisproof':
      return {
        kind: 'intersectionDisproof',
        object: step.object,
        branchIndex: step.branchIndex,
        branch: normalizeReferenceDisproof(step.branch),
      };
    case 'exclusionDisproof':
      return {
        kind: 'exclusionDisproof',
        object: step.object,
        reason:
          step.reason.kind === 'baseDisproven'
            ? { kind: 'baseDisproven', base: normalizeReferenceDisproof(step.reason.base) }
            : step.reason.kind === 'subtractProven'
              ? { kind: 'subtractProven', subtract: normalizeReferenceProof(step.reason.subtract) }
              : {
                  kind: 'subtractUnprovable',
                  subtract: normalizeReferenceDisproof(step.reason.subtract),
                },
      };
    case 'tupleToUsersetDisproof':
      return {
        kind: 'tupleToUsersetDisproof',
        object: step.object,
        relation: step.relation,
        followed: step.followed.map((f) => ({
          through: f.through,
          disproof: normalizeReferenceDisproof(f.disproof),
        })),
      };
    case 'boundReached':
      return { kind: 'boundReached', object: step.object, name: step.name, reason: step.reason };
    case 'undeclared':
      return { kind: 'undeclared', object: step.object, name: step.name };
    default:
      return assertNever(step);
  }
}

// ---------------------------------------------------------------------------
// Normalize: production resolver's own shapes -> the internal render tree.
// Deliberately a near-duplicate of the reference-side normalizer rather than
// a shared generic — see this file's own top-of-file doc comment for why
// (TypeScript can't narrow a generic discriminated union parameter the way
// it narrows a concrete one, and the two resolvers' own `RelationDisproof`
// shapes are legitimately different per D-037, not a case worth forcing
// into one generic).
// ---------------------------------------------------------------------------

function normalizeProductionProof(step: ProductionResolutionStep): RenderProofNode {
  switch (step.kind) {
    case 'directGrant':
      return {
        kind: 'directGrant',
        object: step.object,
        relation: step.relation,
        subject: step.subject,
      };
    case 'usersetMembership':
      return {
        kind: 'usersetMembership',
        object: step.object,
        relation: step.relation,
        userset: step.userset,
        usersetRelation: step.usersetRelation,
        member: normalizeProductionProof(step.member),
      };
    case 'union':
      return {
        kind: 'union',
        object: step.object,
        branchIndex: step.branchIndex,
        branch: normalizeProductionProof(step.branch),
      };
    case 'intersection':
      return {
        kind: 'intersection',
        object: step.object,
        branches: step.branches.map(normalizeProductionProof),
      };
    case 'exclusion':
      return {
        kind: 'exclusion',
        object: step.object,
        base: normalizeProductionProof(step.base),
        subtractDisproof: normalizeProductionDisproof(step.subtractDisproof),
      };
    case 'tupleToUserset':
      return {
        kind: 'tupleToUserset',
        object: step.object,
        relation: step.relation,
        computedUserset: step.computedUserset,
        through: step.through,
        member: normalizeProductionProof(step.member),
      };
    default:
      return assertNever(step);
  }
}

/**
 * The production resolver's own `RelationDisproof` is a flat reachability
 * certificate (D-037) — every frontier node the recursive CTE actually
 * reached, each with its own real tuples. Rendered here as one entry per
 * node reached, listing its tuples in full, exactly matching what
 * `test/unit/resolve/production/production-resolution-path.integration.test
 * .ts`'s own independent verifier checks.
 */
function productionRelationDetailLines(
  step: Extract<ProductionDisproofStep, { kind: 'relationDisproof' }>,
): string[] {
  if (step.nodes.length === 0) {
    return [`no tuples reachable from ${relLabel(step.object, step.relation)}`];
  }
  return step.nodes.flatMap((node) => {
    const nodeEntity: RenderEntity = { ns: node.key.ns, id: node.key.id };
    const nodeLabel = relLabel(nodeEntity, node.key.relation);
    const pathLabel = node.ancestorPath
      .map((k) => relLabel({ ns: k.ns, id: k.id }, k.relation))
      .join(' → ');
    const tupleLines =
      node.tuples.length === 0
        ? [`  - no stored tuples`]
        : node.tuples.map((t) =>
            t.kind === 'plain'
              ? `  - @${entityLabel(t.subject)} — not the queried subject`
              : `  - @${relLabel(t.userset, t.usersetRelation)} — followed, did not close on the queried subject`,
          );
    return [`reached ${nodeLabel} at depth ${node.depth} (path: ${pathLabel}):`, ...tupleLines];
  });
}

function normalizeProductionDisproof(step: ProductionDisproofStep): RenderDisproofNode {
  switch (step.kind) {
    case 'relationDisproof':
      return {
        kind: 'relationDisproof',
        object: step.object,
        relation: step.relation,
        detailLines: productionRelationDetailLines(step),
      };
    case 'unionDisproof':
      return {
        kind: 'unionDisproof',
        object: step.object,
        branches: step.branches.map(normalizeProductionDisproof),
      };
    case 'intersectionDisproof':
      return {
        kind: 'intersectionDisproof',
        object: step.object,
        branchIndex: step.branchIndex,
        branch: normalizeProductionDisproof(step.branch),
      };
    case 'exclusionDisproof':
      return {
        kind: 'exclusionDisproof',
        object: step.object,
        reason:
          step.reason.kind === 'baseDisproven'
            ? { kind: 'baseDisproven', base: normalizeProductionDisproof(step.reason.base) }
            : step.reason.kind === 'subtractProven'
              ? {
                  kind: 'subtractProven',
                  subtract: normalizeProductionProof(step.reason.subtract),
                }
              : {
                  kind: 'subtractUnprovable',
                  subtract: normalizeProductionDisproof(step.reason.subtract),
                },
      };
    case 'tupleToUsersetDisproof':
      return {
        kind: 'tupleToUsersetDisproof',
        object: step.object,
        relation: step.relation,
        followed: step.followed.map((f) => ({
          through: f.through,
          disproof: normalizeProductionDisproof(f.disproof),
        })),
      };
    case 'boundReached':
      return { kind: 'boundReached', object: step.object, name: step.name, reason: step.reason };
    case 'undeclared':
      return { kind: 'undeclared', object: step.object, name: step.name };
    default:
      return assertNever(step);
  }
}

// ---------------------------------------------------------------------------
// Rendering: the internal tree -> markdown lines.
// ---------------------------------------------------------------------------

function entityLabel(e: RenderEntity): string {
  return `${e.ns}:${e.id}`;
}

function relLabel(e: RenderEntity, name: string): string {
  return `${e.ns}:${e.id}#${name}`;
}

function codeSpan(s: string): string {
  return `\`${s}\``;
}

function chainLine(labels: readonly string[]): string {
  return labels.map(codeSpan).join(' → ');
}

/** Same idea as `chainLine`, undecorated — used only inside a fenced code block (see `renderPathBlock`), where markdown syntax would render literally instead of being interpreted. */
function plainChainLine(labels: readonly string[]): string {
  return labels.join(' → ');
}

function appendIfDifferent(chain: readonly string[], label: string): string[] {
  const last = chain[chain.length - 1];
  return last === label ? [...chain] : [...chain, label];
}

/**
 * Attempts to flatten `node` into one linear `subject -> ... -> object#name`
 * chain. Returns `null` the instant an `intersection` or `exclusion` is
 * reached anywhere in the subtree — those are exactly the two cases with no
 * single linear witness (see this file's own top-of-file doc comment).
 * `union` is transparent (no label of its own — the resolved fact is
 * "object holds the same name via whichever branch," and the branch's own
 * chain already says what mattered). `usersetMembership`/`tupleToUserset`
 * ensure the child chain lands on the label their own fields promise
 * (`userset#usersetRelation` / `through#computedUserset`) before appending
 * their own hop, rather than trusting the child's own terminal label to
 * already match — correct even in the (unusual, but DSL-legal) case where a
 * userset-subject's own name resolves through a multi-branch permission
 * whose deepest concrete relation differs from the name declared on the
 * tuple.
 */
function tryFlattenProof(node: RenderProofNode): string[] | null {
  switch (node.kind) {
    case 'directGrant':
      return [entityLabel(node.subject), relLabel(node.object, node.relation)];
    case 'usersetMembership': {
      const child = tryFlattenProof(node.member);
      if (!child) return null;
      const landed = appendIfDifferent(child, relLabel(node.userset, node.usersetRelation));
      return appendIfDifferent(landed, relLabel(node.object, node.relation));
    }
    case 'tupleToUserset': {
      const child = tryFlattenProof(node.member);
      if (!child) return null;
      // No hop of its own is appended here — the name this tupleToUserset
      // rule was declared under belongs to whichever caller invoked it
      // (a permission's rewrite, ultimately traced back to the query's own
      // `relationOrPermission`), never recorded on this node itself (see
      // the reference resolver's own doc comment on why `computedUserset`
      // is a transparent delegation). The caller (`renderPathBlock`, or a
      // wrapping `usersetMembership`) is responsible for appending the
      // right final label.
      return appendIfDifferent(child, relLabel(node.through, node.computedUserset));
    }
    case 'union':
      return tryFlattenProof(node.branch);
    case 'intersection':
    case 'exclusion':
      return null;
    default:
      return assertNever(node);
  }
}

function prefixOrdinal(lines: readonly string[], n: number): string[] {
  if (lines.length === 0) return [...lines];
  const [first, ...rest] = lines;
  const replaced = (first ?? '').replace(/^(\s*)-\s/, (_m, ws: string) => `${ws}${n}. `);
  return [replaced, ...rest];
}

/**
 * The full structured renderer — used only where `tryFlattenProof` fails
 * (i.e. an `intersection` or `exclusion` is present somewhere in `node`).
 * Every case still tries to flatten its own subtree first, so a linear
 * branch nested inside a non-linear one still collapses to one chain line
 * rather than being needlessly exploded node-by-node.
 *
 * **Deliberately plain text, no markdown syntax (no backticks, no bold).**
 * `renderPathBlock` wraps this output in a fenced code block rather than a
 * native nested markdown list. That was not the first design tried — a
 * native `- `/numbered nested list was, and it was verified (by actually
 * rendering it through a markdown parser, not by inspection — see this
 * project's own final report) to badly mis-nest: GFM's lazy-continuation
 * rule silently folds a sibling line that isn't blank-line-separated and
 * isn't itself a new list marker into the *previous* list item's content,
 * which swallowed this renderer's own "excluding:" label and its closing
 * "(this proves ...)" annotation into the wrong branch — a structural
 * corruption of exactly the evidence this file exists to render faithfully.
 * A fenced code block sidesteps GFM's list-nesting rules entirely (its
 * content is never markdown-parsed), at the cost of losing inline
 * bold/code emphasis inside the tree itself — a trade this file makes
 * deliberately: correct, unambiguous rendering everywhere (mobile
 * included) matters more here than emphasis inside a block that's already
 * visually set off by the code fence.
 */
function renderStructuredProof(node: RenderProofNode, indent: string): string[] {
  const flat = tryFlattenProof(node);
  if (flat) return [`${indent}- ${plainChainLine(flat)}`];

  switch (node.kind) {
    case 'union':
      return renderStructuredProof(node.branch, indent);
    case 'intersection': {
      const lines = [
        `${indent}- AND — all ${node.branches.length} branches required for ${entityLabel(node.object)}:`,
      ];
      node.branches.forEach((branch, i) => {
        lines.push(...prefixOrdinal(renderStructuredProof(branch, `${indent}  `), i + 1));
      });
      return lines;
    }
    case 'exclusion': {
      const lines = [`${indent}- base holds for ${entityLabel(node.object)}, excluding:`];
      lines.push(...renderStructuredProof(node.base, `${indent}  `));
      lines.push(`${indent}  EXCLUDING:`);
      lines.push(...renderDisproofStructured(node.subtractDisproof, `${indent}    `));
      return lines;
    }
    case 'usersetMembership': {
      const lines = [
        `${indent}- ${relLabel(node.object, node.relation)} via ${relLabel(node.userset, node.usersetRelation)}:`,
      ];
      lines.push(...renderStructuredProof(node.member, `${indent}  `));
      return lines;
    }
    case 'tupleToUserset': {
      const lines = [
        `${indent}- ${entityLabel(node.object)} follows "${node.relation}" to ${relLabel(node.through, node.computedUserset)}:`,
      ];
      lines.push(...renderStructuredProof(node.member, `${indent}  `));
      return lines;
    }
    case 'directGrant':
      // Always flattenable — unreachable in practice, kept for exhaustiveness.
      return [
        `${indent}- ${plainChainLine([entityLabel(node.subject), relLabel(node.object, node.relation)])}`,
      ];
    default:
      return assertNever(node);
  }
}

/**
 * The disproof-tree renderer (only ever reached inside an `exclusion`'s
 * `subtractDisproof`). Mirrors `renderStructuredProof`'s shape one-for-one,
 * combinator for combinator, per D-036's own "structurally symmetric
 * negative witness" design — every leaf names real evidence
 * (`relationDisproof`'s examined tuples, `boundReached`'s cycle/depth
 * reason, `undeclared`'s missing name), never a bare "false, trust it."
 * Plain text throughout — see `renderStructuredProof`'s own doc comment.
 */
function renderDisproofStructured(node: RenderDisproofNode, indent: string): string[] {
  switch (node.kind) {
    case 'relationDisproof':
      return [
        `${indent}- no path found for ${relLabel(node.object, node.relation)}:`,
        ...node.detailLines.map((l) => `${indent}  ${l}`),
      ];
    case 'unionDisproof': {
      const lines = [`${indent}- none of the following held for ${entityLabel(node.object)}:`];
      node.branches.forEach((branch, i) => {
        lines.push(...prefixOrdinal(renderDisproofStructured(branch, `${indent}  `), i + 1));
      });
      return lines;
    }
    case 'intersectionDisproof':
      return [
        `${indent}- fails: branch ${node.branchIndex + 1} of the intersection on ${entityLabel(node.object)} does not hold (one failing branch disproves the whole intersection):`,
        ...renderDisproofStructured(node.branch, `${indent}  `),
      ];
    case 'exclusionDisproof':
      if (node.reason.kind === 'baseDisproven') {
        return [
          `${indent}- the base does not hold for ${entityLabel(node.object)}:`,
          ...renderDisproofStructured(node.reason.base, `${indent}  `),
        ];
      }
      if (node.reason.kind === 'subtractProven') {
        return [
          `${indent}- the excluded set holds for ${entityLabel(node.object)} (exclusion fails):`,
          ...renderStructuredProof(node.reason.subtract, `${indent}  `),
        ];
      }
      // `subtractUnprovable` — see both resolvers' own `ExclusionDisproof`
      // doc comment. Structurally unreachable through this file's own real
      // callers today (see `RenderDisproofNode`'s own doc comment on this
      // variant) — rendered anyway with real, honest wording rather than
      // treated as unreachable, in case a future feature ever surfaces a
      // bare top-level disproof.
      return [
        `${indent}- the excluded set for ${entityLabel(node.object)} could not be conclusively resolved (cycle/depth cutoff) — denied conservatively, not proven excluded:`,
        ...renderDisproofStructured(node.reason.subtract, `${indent}  `),
      ];
    case 'tupleToUsersetDisproof':
      if (node.followed.length === 0) {
        return [
          `${indent}- no stored "${node.relation}" tuples on ${entityLabel(node.object)} to follow`,
        ];
      }
      return [
        `${indent}- every "${node.relation}" hop from ${entityLabel(node.object)} failed:`,
        ...node.followed.flatMap((f) => [
          `${indent}  - via ${entityLabel(f.through)}:`,
          ...renderDisproofStructured(f.disproof, `${indent}    `),
        ]),
      ];
    case 'boundReached':
      return [
        `${indent}- cut off at ${relLabel(node.object, node.name)} — ` +
          `${node.reason === 'cycle' ? 'cycle detected' : 'depth budget exhausted'} ` +
          `(a defined denial for this branch, not an unknown)`,
      ];
    case 'undeclared':
      return [
        `${indent}- ${relLabel(node.object, node.name)} names no declared relation or permission`,
      ];
    default:
      return assertNever(node);
  }
}

/**
 * Renders one already-normalized proof tree, ensuring the final label
 * matches the query actually asked. The common case (fully linear —
 * `directGrant`/`usersetMembership`/`tupleToUserset`/transparent `union`
 * only) is one backtick-decorated, `→`-joined markdown paragraph line — §8's
 * own worked-example notation. The moment an `intersection`/`exclusion`
 * appears anywhere in the tree, the whole path renders as one fenced plain-
 * text block instead (see `renderStructuredProof`'s own doc comment for why
 * a native nested markdown list was tried first and rejected), with the
 * "this proves ..." annotation as its own markdown paragraph directly below
 * the fence — never glued onto the fence's own last line, so it can never
 * be swallowed into the wrong element by a markdown parser's continuation
 * rules the way the original nested-list draft was.
 */
function renderPathBlock(
  root: RenderProofNode,
  query: { object: RenderEntity; relationOrPermission: string },
): string[] {
  const finalLabel = relLabel(query.object, query.relationOrPermission);
  const flat = tryFlattenProof(root);
  if (flat) {
    return [chainLine(appendIfDifferent(flat, finalLabel))];
  }
  return [
    '```text',
    ...renderStructuredProof(root, ''),
    '```',
    '',
    `_(this proves ${codeSpan(finalLabel)})_`,
  ];
}

// ---------------------------------------------------------------------------
// Public rendering entry points.
// ---------------------------------------------------------------------------

/**
 * The one plain-text sentence every rendering of a soundness run must be
 * able to stand on alone — verdict, `false_grant` count, `false_deny`
 * count, query budget, and the seed, all in one line (report-designer
 * brief: "someone skimming on a phone decides whether to worry from that
 * line alone"). Shared verbatim between `renderSoundnessMarkdown` (as the
 * report's own first visible line) and `src/report/json.ts` (as the
 * `headline` field), so the two renderers can never drift in wording.
 */
export function renderHeadline(result: SoundnessRunResult): string {
  const verdictWord =
    result.verdict === 'sound'
      ? 'SOUND'
      : result.verdict === 'unsound'
        ? 'UNSOUND'
        : 'INSUFFICIENT_COVERAGE';
  return (
    `${verdictWord} — ${result.falseGrantCount} false_grant, ${result.falseDenyCount} false_deny, ` +
    `across ${result.queryCount} queries (seed ${result.graphSeed})`
  );
}

/**
 * One divergence's own rendered block — collapsible, resolution path always
 * inline, never a link. `<summary>` is deliberately **plain text** (no
 * backticks, no bold): GitHub's markdown renderer does not reliably apply
 * inline formatting to text on the same line as a raw `<summary>` tag, and
 * this file does not depend on behavior it hasn't verified — see
 * `renderStructuredProof`'s own doc comment for the sibling case where this
 * exact caution caught a real rendering bug. The severity marker is still
 * unambiguous in plain text (`FALSE_GRANT` all-caps vs. lowercase
 * `false_deny`, visible even collapsed, since `<summary>` is always shown);
 * the bold, backtick-decorated restatement lives as the first line of the
 * details *body*, which is guaranteed real markdown context (a blank line
 * separates it from the raw `<summary>` tag).
 */
export function renderDivergenceMarkdown(divergence: DivergenceRecord, index: number): string[] {
  const q = divergence.query;
  const plainLabel = divergence.kind === 'false_grant' ? 'FALSE_GRANT' : 'false_deny';
  const decoratedLabel = divergence.kind === 'false_grant' ? FALSE_GRANT_LABEL : FALSE_DENY_LABEL;
  const criticalNote = divergence.critical ? ' — critical namespace' : '';
  const verdictNote = `reference: ${divergence.expected ? 'allow' : 'deny'}, production: ${divergence.actual ? 'allow' : 'deny'}`;
  const queryText = `${entityLabel(q.subject)} ${q.relationOrPermission} ${entityLabel(q.object)}`;

  const lines: string[] = [
    '<details open>',
    `<summary>${index}. ${plainLabel}${criticalNote} — ${queryText} (${verdictNote})</summary>`,
    '',
    `${decoratedLabel}${criticalNote} — ${codeSpan(entityLabel(q.subject))} \`${q.relationOrPermission}\` ${codeSpan(entityLabel(q.object))} (${verdictNote})`,
    '',
  ];

  if (divergence.kind === 'false_grant') {
    lines.push(
      'The reference oracle found no real path. The production engine allowed it anyway — this is the ' +
        "engine's own bogus reasoning, not evidence the access is legitimate:",
      '',
    );
    if (divergence.productionPath) {
      const normalized = normalizeProductionProof(divergence.productionPath);
      lines.push(...renderPathBlock(normalized, q));
    } else {
      lines.push('_no production path was recorded for this divergence — see the run itself._');
    }
  } else {
    lines.push('The reference oracle found a real path. The production engine denied it:', '');
    if (divergence.referencePath) {
      const normalized = normalizeReferenceProof(divergence.referencePath);
      lines.push(...renderPathBlock(normalized, q));
    } else {
      lines.push('_no reference path was recorded for this divergence — see the run itself._');
    }
  }

  lines.push('', '</details>', '');
  return lines;
}

/**
 * Rendered when `authz soundness run --format markdown` cannot produce a
 * verdict at all — `runSoundnessFuzz` threw (DB unreachable, a generator
 * bug, anything not caught internally) or a precondition like
 * `DATABASE_URL` was never set, before any `SoundnessRunResult` ever
 * existed to render via `renderSoundnessMarkdown` above. Called from
 * `src/cli/commands/soundness.ts`'s own `catch` block and its
 * `DATABASE_URL`-missing early return — both are the exit-code-3
 * "infrastructure failure" case (`src/report/exitCodes.ts`'s own doc
 * comment). Exists specifically because `.github/workflows/soundness.yml`
 * captures this command's stdout verbatim as `soundness-report.md`, which
 * `scripts/post-soundness-comment.mjs` posts — or PATCHes the existing
 * *tracked* comment to, unconditionally — as the literal PR-comment body.
 * Before this function existed, that `catch` block printed nothing to
 * stdout at all: a single infra hiccup captured a 0-byte file and silently
 * blanked the PR's last known-good soundness comment, with no report and no
 * visible sign anything had gone wrong to a human reading the PR thread
 * (the CI job itself still went red via `exitCode 3` — the job's own
 * pass/fail state was never the problem; the *comment* going silently blank
 * was).
 *
 * Starts with `SOUNDNESS_REPORT_MARKER` for the same reason every real
 * report does: `decidePrCommentAction` (`src/report/prComment.ts`) matches
 * a prior comment against that exact string to decide "update this one" vs.
 * "post a new one." Omitting it here would mean the *next successful* run
 * doesn't recognize this failure comment as "the" tracked soundness
 * comment, creates a brand-new comment instead, and this one sits on the PR
 * forever, orphaned — breaking the "update in place, never stack" contract
 * for exactly the run that most needs a human to notice it.
 *
 * Deliberately **not** shaped like a real verdict line: no `SOUND`/
 * `UNSOUND`/`INSUFFICIENT_COVERAGE` word, no `false_grant`/`false_deny`
 * count, because none was ever computed — reporting `0 false_grant` here
 * would be indistinguishable from a genuine, measured `sound` result, and
 * this project's own copy rules forbid reporting `0 false_grant` as
 * anything other than "a measured result of a specific fuzz budget." This
 * message says plainly that no check ran at all, and includes the real
 * error text rather than a vague "something went wrong."
 */
export function renderSoundnessInfrastructureFailureMarkdown(message: string): string {
  return [
    SOUNDNESS_REPORT_MARKER,
    '',
    '## INFRASTRUCTURE_FAILURE — soundness check did not run',
    '',
    'No verdict was produced — the run did not reach a single query check. This is not a ' +
      '`sound` result: `0 false_grant` is never reported here, because no queries ran to report ' +
      'it about.',
    '',
    `Error: \`${message}\``,
    '',
    'Check that the target database is reachable and correctly configured, then rerun `authz ' +
      'soundness run`.',
  ].join('\n');
}

/**
 * The `FIXTURE_FAILURE` sibling of `renderSoundnessInfrastructureFailureMarkdown`
 * directly above — rendered when `runSoundnessFuzz` throws specifically a
 * `SoundnessFixtureError` (`src/soundness/runner.ts`): the *generated fuzz
 * fixture itself* was invalid — its schema failed to compile, its schema
 * failed to publish, or one of its generated tuples was rejected on write —
 * before a single query was ever checked. This is a bug in the fixture
 * generator, or in schema/tuple validation the generator's own output
 * tripped, never a database-connectivity problem.
 *
 * Exists to close full-repo audit finding #12 (MEDIUM, 2026-08-16):
 * `src/cli/commands/soundness.ts`'s previous blanket `catch` treated every
 * error `runSoundnessFuzz` could throw identically as exit-code-3
 * "infrastructure failure," additionally framed with a `"Postgres:
 * <message>"` prefix — both wrong for this case, per build spec §7's own
 * exit-code table (exit 2 is "insufficient fuzz coverage or a schema/tuple
 * validation failure"; exit 3 is specifically "infrastructure failure (DB
 * unreachable, etc.)"). `SoundnessFixtureError` exists so that `catch` block
 * can now tell the two apart and route a fixture failure to exit code 2 and
 * *this* rendering, never exit code 3 and the infrastructure one.
 *
 * Same `SOUNDNESS_REPORT_MARKER`-prefixed shape, and the same "this is not a
 * `sound` result" honesty line, as `renderSoundnessInfrastructureFailureMarkdown`
 * above (see that function's own doc comment for why omitting the marker
 * would break the "update in place, never stack" PR-comment contract) — but
 * the body text deliberately never suggests a database or connectivity
 * problem (no "check that the target database is reachable"). It says
 * plainly that the *fixture* was invalid, that this is worth filing or
 * investigating as a generator/validation bug, and points at the seed
 * embedded in `message` (every `SoundnessFixtureError` message includes
 * `seed=...`) as what makes the exact broken fixture reproducible.
 */
export function renderSoundnessFixtureFailureMarkdown(message: string): string {
  return [
    SOUNDNESS_REPORT_MARKER,
    '',
    '## FIXTURE_FAILURE — soundness check did not run',
    '',
    'No verdict was produced — the generated fuzz fixture itself was invalid before a single query ' +
      'ran: its schema failed to compile, failed to publish, or one of its generated tuples was ' +
      'rejected on write. This is a bug in the fixture generator or in schema/tuple validation, not an ' +
      'infrastructure problem. This is not a `sound` result: `0 false_grant` is never reported here, ' +
      'because no queries ran to report it about.',
    '',
    `Error: \`${message}\``,
    '',
    'File or investigate this against the seed in the error above — it reproduces the exact fixture ' +
      'that failed to build.',
  ].join('\n');
}

export interface RenderSoundnessMarkdownOptions {
  /**
   * Soft cap on how many `false_deny` entries render their full path before
   * the rest are disclosed-and-omitted, never silently — GitHub caps a
   * single comment/issue body at roughly 65,536 characters. Applies only to
   * `false_deny`. Default 20.
   *
   * `false_grant` is governed separately, by `maxCommentChars` below, never
   * by a fixed entry-count cap: a `false_grant` must never be summarized
   * away or deferred to a link just because it's the Nth one
   * (report-designer brief) — the limit that matters for it is the
   * document's own real, measured size, not an arbitrary count picked in
   * advance.
   */
  maxRenderedFalseDeny?: number;
  /**
   * Soft ceiling, in characters, this renderer targets for the WHOLE
   * document — see `DEFAULT_MAX_COMMENT_CHARS`'s own doc comment for why
   * 60,000 rather than GitHub's literal ~65,536-character limit. Once the
   * running rendered body would cross this while rendering the
   * `false_grant` section, further `false_grant` entries stop rendering
   * their own full resolution path — but the true total count, and an
   * unmissable notice that this is not a clean or reduced-severity result,
   * always render in their place. Never truncates `false_deny` — that
   * section is already independently bounded by `maxRenderedFalseDeny`.
   * Default `60_000`.
   */
  maxCommentChars?: number;
}

/**
 * Sums `strs` the same way `lines.join('\n')` eventually will — every
 * element's own length, plus one character per joining separator. Used only
 * to track the running rendered-body size against `maxCommentChars` without
 * re-joining and re-measuring the whole (potentially very large) `lines`
 * array on every iteration of the `false_grant` loop below — O(n) total
 * across the loop, not O(n²).
 */
function joinedLength(strs: readonly string[]): number {
  return strs.reduce((sum, s) => sum + s.length + 1, 0);
}

/**
 * Renders a full `SoundnessRunResult` as one GitHub-flavored-markdown
 * document, suitable to post (or update in place — see
 * `src/report/prComment.ts`) as a PR comment. First line is `SOUNDNESS_REPORT_MARKER`
 * (invisible), second is the H2 headline (verdict, both counts, query
 * budget, seed — sufficient alone), followed by a reproduce command, a
 * measured (never "secure") verdict-detail line, and one section per
 * divergence kind — `false_grant` first and unmuted, `false_deny` second
 * and muted — each divergence rendered in full via
 * `renderDivergenceMarkdown`.
 */
export function renderSoundnessMarkdown(
  result: SoundnessRunResult,
  options: RenderSoundnessMarkdownOptions = {},
): string {
  const maxFalseDeny = options.maxRenderedFalseDeny ?? DEFAULT_MAX_RENDERED_FALSE_DENY;
  const maxCommentChars = options.maxCommentChars ?? DEFAULT_MAX_COMMENT_CHARS;
  const lines: string[] = [SOUNDNESS_REPORT_MARKER, '', `## ${renderHeadline(result)}`, ''];

  lines.push(
    `Reproduce: \`authz soundness run --seed ${result.graphSeed} --queries ${result.queryCount}\``,
    '',
  );

  if (result.verdict === 'unsound') {
    const criticalNote =
      result.criticalNamespaceFalseGrants > 0
        ? ` (${result.criticalNamespaceFalseGrants} on a namespace flagged critical)`
        : '';
    lines.push(
      `${result.falseGrantCount} ${result.falseGrantCount === 1 ? 'query was' : 'queries were'} allowed by ` +
        `the production engine with no real path found by the reference oracle${criticalNote} — this fails ` +
        `the run regardless of the aggregate rate across the rest of the graph.`,
    );
  } else if (result.verdict === 'insufficient_coverage') {
    lines.push(
      "This run's generated fixture did not exercise every rewrite-rule kind and a cyclic case — the fuzz " +
        'budget did not produce a run this harness trusts as a complete pass. `0 false_grant` is not reported ' +
        'as a clean result under this condition.',
    );
  } else {
    lines.push(
      `0 false_grant across ${result.queryCount} queries — a measured result of this run's fuzz budget, ` +
        'not a claim of general security.',
    );
  }
  lines.push('');
  lines.push(
    `namespaces: \`${result.namespaceCount}\`  tuples: \`${result.tupleCount}\`  run id: \`${result.id}\``,
    '',
  );

  const falseGrants = result.divergences.filter(
    (d): d is DivergenceRecord & { kind: 'false_grant' } => d.kind === 'false_grant',
  );
  const falseDenies = result.divergences.filter(
    (d): d is DivergenceRecord & { kind: 'false_deny' } => d.kind === 'false_deny',
  );

  if (falseGrants.length > 0) {
    lines.push('### FALSE_GRANT findings', '');

    // Every entry renders in full, in order, until the running body would
    // cross `maxCommentChars` — the same size-budget discipline
    // `false_deny` already applies below, but never a fixed entry-count cap:
    // a `false_grant` is truncated only by real, measured size, and the true
    // total count always renders regardless (see `DEFAULT_MAX_COMMENT_CHARS`
    // and `docs/DECISIONS.md` D-084).
    let renderedFalseGrants = 0;
    for (const [i, divergence] of falseGrants.entries()) {
      const block = renderDivergenceMarkdown(divergence, i + 1);
      if (joinedLength(lines) + joinedLength(block) > maxCommentChars) {
        break;
      }
      lines.push(...block);
      renderedFalseGrants += 1;
    }

    const omittedFalseGrants = falseGrants.length - renderedFalseGrants;
    if (omittedFalseGrants > 0) {
      const noun = omittedFalseGrants === 1 ? 'divergence' : 'divergences';
      lines.push(
        `**TRUNCATED — ${omittedFalseGrants} more FALSE_GRANT ${noun} not shown in this comment ` +
          `(${falseGrants.length} total).**`,
        '',
        'This comment reached its own size budget — that is the only reason rendering stopped, never a ' +
          `reduced severity: every omitted entry is a full ${FALSE_GRANT_LABEL} finding, the same as every ` +
          'entry shown above — the production engine allowed a query with no real path found by the ' +
          `reference oracle. The true, measured count (${falseGrants.length}) is stated in the headline at ` +
          'the top of this comment, not summarized away here. The complete report, every finding included, ' +
          'is printed in full in the workflow run\'s "Run soundness fuzz" step log. Reproduce the exact run ' +
          'locally with the command above to inspect the rest.',
        '',
      );
    }
  }

  if (falseDenies.length > 0) {
    lines.push('### false_deny findings (non-blocking)', '');
    const shown = falseDenies.slice(0, maxFalseDeny);
    shown.forEach((d, i) => lines.push(...renderDivergenceMarkdown(d, i + 1)));
    const omitted = falseDenies.length - shown.length;
    if (omitted > 0) {
      lines.push(
        `_${omitted} further false_deny ${omitted === 1 ? 'divergence' : 'divergences'} omitted from this ` +
          `comment for length — all ${falseDenies.length} are recorded on soundness run \`${result.id}\` ` +
          `(seed \`${result.graphSeed}\`); reproduce locally with the command above to inspect the rest._`,
        '',
      );
    }
  }

  return lines.join('\n');
}
