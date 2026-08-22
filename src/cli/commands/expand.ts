/**
 * `authz expand <object> <relation>` — build spec §7. Prints the exact
 * subject tree `src/audit/expand.ts`'s `expand()` (Phase 6) returns for
 * `relationOrPermission` on `object`: every rewrite-rule node
 * (union/intersection/exclusion/tuple-to-userset) and every real subject,
 * direct or reached through a nested userset, indented to show the real
 * structure — not flattened to a list of ids. A polished, human-facing
 * rendering (colors, collapsing, the §8 chain notation) is Phase 7/8/9's
 * job (`report-designer`); this is the functional CLI surface Phase 6's
 * own exit criterion asks for.
 */
import type { ExpandNode } from '../../audit/expand.js';
import { expand } from '../../audit/expand.js';
import { getPool, closePool } from '../../store/client.js';
import { env } from '../../config/env.js';
import { parseEntityArg, isValidIdentifier } from '../entity-ref.js';
import { MAX_IDENTIFIER_LENGTH } from '../../schema/dsl/types.js';

const REF_USAGE = "object must be 'namespace:id' (e.g. 'document:readme')";

function entityStr(e: { ns: string; id: string }): string {
  return `${e.ns}:${e.id}`;
}

/** Renders one `ExpandNode`, indented, mirroring the real rewrite-rule tree structure. */
function renderNode(node: ExpandNode, indent: string, lines: string[]): void {
  switch (node.kind) {
    case 'union':
      lines.push(`${indent}union`);
      for (const child of node.children) renderNode(child, indent + '  ', lines);
      return;
    case 'intersection':
      lines.push(`${indent}intersection (all required)`);
      for (const child of node.children) renderNode(child, indent + '  ', lines);
      return;
    case 'exclusion':
      lines.push(`${indent}exclusion (base, not subtract)`);
      lines.push(`${indent}  base:`);
      renderNode(node.base, indent + '    ', lines);
      lines.push(`${indent}  subtract:`);
      renderNode(node.subtract, indent + '    ', lines);
      return;
    case 'tupleToUserset':
      lines.push(`${indent}${node.relation}->${node.computedUserset}`);
      for (const child of node.children) {
        lines.push(`${indent}  through ${entityStr(child.through)}:`);
        renderNode(child.expansion, indent + '    ', lines);
      }
      return;
    case 'relation':
      lines.push(`${indent}relation ${node.relation} on ${entityStr(node.object)}`);
      for (const subject of node.directSubjects) {
        lines.push(`${indent}  ${entityStr(subject)}`);
      }
      for (const member of node.usersets) {
        lines.push(`${indent}  ${entityStr(member.userset)}#${member.relation}`);
        renderNode(member.expansion, indent + '    ', lines);
      }
      return;
    case 'cycleGuard':
      lines.push(`${indent}(cycle: already expanding ${entityStr(node.object)}#${node.name})`);
      return;
    case 'depthLimitReached':
      lines.push(`${indent}(depth limit reached at ${entityStr(node.object)}#${node.name})`);
      return;
    case 'undeclared':
      lines.push(`${indent}(undeclared: ${entityStr(node.object)}#${node.name})`);
      return;
  }
}

export async function expandCli(objectRaw: string, relation: string): Promise<void> {
  const object = parseEntityArg(objectRaw);
  if (!object) {
    console.error(`invalid object reference — ${REF_USAGE}`);
    process.exitCode = 2;
    return;
  }
  // Second full-repo audit finding #4 (MEDIUM, 2026-08-22): this argument
  // reached expand() completely unvalidated before this fix, unlike
  // src/api/server.ts's expandBodySchema (D-093), which already validates
  // the identical field for the HTTP route. expand.ts's own recursion key
  // (nameKey, NUL-byte-separated) isn't vulnerable to resolver.ts's
  // specific `:`/`#` frontier-key confusion (see ../entity-ref.js's own
  // doc comment for that mechanism, which is what motivates validating
  // `check`'s relation argument above) — the real gap here is narrower:
  // a malformed relation silently resolves to a confusing
  // `{ kind: 'undeclared' }` leaf embedding the raw garbage string,
  // instead of a clear, immediate error, and this CLI has no reason to
  // accept an argument the equivalent API route already rejects.
  if (!isValidIdentifier(relation)) {
    console.error(
      `invalid relation '${relation}' — must be a valid identifier (lowercase snake_case, starts with a letter, ≤${MAX_IDENTIFIER_LENGTH} characters)`,
    );
    process.exitCode = 2;
    return;
  }

  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  try {
    const tree = await expand(pool, object, relation);
    console.log(`${objectRaw}#${relation}:`);
    const lines: string[] = [];
    renderNode(tree, '  ', lines);
    for (const line of lines) console.log(line);
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}
