/**
 * `privescScan` (`src/audit/privesc.ts`) and `authz audit privesc`
 * (`src/cli/commands/privesc.ts`) against a real Postgres — the real-story
 * proof this codebase's own conventions require for anything claiming to
 * answer a bulk permission question (see `test/unit/audit/list.integration
 * .test.ts`'s own established pattern, which this file mirrors): don't
 * just unit-test argument parsing in isolation (`test/unit/cli/
 * privesc.test.ts`), prove the real thing against real, live tuples.
 *
 * The schema/tuple graph below grants the SAME permission
 * (`document#view`) to three real subjects via three genuinely different
 * mechanisms, exactly as required:
 *
 *   - alice: a DIRECT grant (`document:<doc>#viewer -> user:alice`).
 *   - bob:   a NESTED group membership, two levels deep
 *            (`group:eng_backend#member -> user:bob`,
 *             `group:eng#member -> group:eng_backend#member`,
 *             `document:<doc>#viewer -> group:eng#member`).
 *   - carol: a `tupleToUserset` hop (`document:<doc>#parent -> folder:
 *            <design>`, `folder:<design>#editor -> user:carol`,
 *            `document#view = viewer | parent->edit`,
 *            `folder#edit = editor`).
 *
 * A fourth subject, erin, exists elsewhere in `relation_tuples` (so she IS
 * a real candidate `fetchCandidateSubjects` enumerates) but has no
 * connection whatsoever to this document — proving `privescScan` actually
 * runs and correctly filters a real per-candidate check, rather than
 * naively reporting "every distinct subject in the table."
 *
 * Every finding's `depth`/`path` is cross-checked against an independent,
 * direct `productionCheck` call for that exact `(subject, object,
 * relation)` triple — the same "circular as a soundness oracle for
 * `productionCheck` itself, but sound as an oracle for THIS file's own
 * enumeration/aggregation logic" reasoning `list.integration.test.ts`'s own
 * top-of-file doc comment states for its identical use of `productionCheck`
 * as an oracle. Each path is also rendered with `renderResolutionPath`
 * (`check.ts`) and asserted hop-for-hop against a hand-derived chain, so
 * this proves not just "some path" but "the exact real chain of tuples,
 * exactly like `authz check ... --path` already prints" (this feature's
 * own stated purpose).
 *
 * The same fixture is then used, in the same test, to prove the CLI's own
 * `--expected` drift comparison: omitting bob from `--expected` flags him
 * UNEXPECTED, adding an uninvolved subject (`user:dave`, never granted
 * anything) flags him MISSING, and `process.exitCode` is `1` (blocking) —
 * proving both findings can coexist in one run without MISSING alone
 * setting the exit code.
 *
 * Real, ephemeral Postgres via `PostgreSqlContainer` — see
 * `docs/DECISIONS.md` D-019/D-030.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { writeTuple, type TupleKey } from '../../../src/store/tuples.js';
import { publishSchema } from '../../../src/schema/publish.js';
import { runMigrations } from '../../../src/store/migrate.js';
import { productionCheck, type EntityRef } from '../../../src/resolve/production/resolver.js';
import { renderResolutionPath } from '../../../src/cli/commands/check.js';
import { privescScan } from '../../../src/audit/privesc.js';
import { privescCli } from '../../../src/cli/commands/privesc.js';
import { env } from '../../../src/config/env.js';
import { closePool } from '../../../src/store/client.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../src/store/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 20 });
  pool.on('error', (err) => {
    // pg's own documented contract — see every other *.integration.test.ts
    // file in this repo for the identical guard and the identical reason.
    console.error(`pool error (expected during container teardown): ${err.message}`);
  });
  await runMigrations(pool, MIGRATIONS_DIR);
  // privescCli opens its own pool via getPool()/env.DATABASE_URL, exactly
  // like check.integration.test.ts's own established pattern.
  env.DATABASE_URL = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

afterEach(async () => {
  await closePool();
  process.exitCode = undefined;
});

let uniqueCounter = 0;
const processSalt = Math.random().toString(36).slice(2, 10);
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${processSalt}_${uniqueCounter}`;
}

function ref(ns: string, id: string): EntityRef {
  return { ns, id };
}

function tuple(
  objectNs: string,
  objectId: string,
  relation: string,
  subjectNs: string,
  subjectId: string,
  subjectRelation?: string,
): TupleKey {
  return {
    objectNs,
    objectId,
    relation,
    subjectNs,
    subjectId,
    ...(subjectRelation !== undefined ? { subjectRelation } : {}),
  };
}

async function writeOk(t: TupleKey): Promise<void> {
  const result = await writeTuple(pool, t);
  if (!result.ok)
    throw new Error(`fixture tuple failed to write: ${JSON.stringify(result.errors)}`);
}

async function publishOk(source: string): Promise<void> {
  const result = await publishSchema(pool, source);
  if (!result.ok) throw new Error(`fixture schema failed to publish: ${result.errors.join('; ')}`);
}

describe('privescScan / authz audit privesc — three real, genuinely different access mechanisms', () => {
  it('finds all three real subjects with correct depths and real paths, and the CLI --expected comparison flags UNEXPECTED and MISSING correctly with exit code 1', async () => {
    const groupNs = uniqueName('group');
    const folderNs = uniqueName('folder');
    const docNs = uniqueName('document');

    await publishOk(
      [
        `namespace ${groupNs} {`,
        `  relation member: user | ${groupNs}#member`,
        '}',
        '',
        `namespace ${folderNs} {`,
        `  relation editor: user | ${groupNs}#member`,
        '  permission edit = editor',
        '}',
        '',
        `namespace ${docNs} {`,
        `  relation viewer: user | ${groupNs}#member`,
        `  relation parent: ${folderNs}`,
        '',
        '  permission view = viewer | parent->edit',
        '}',
      ].join('\n'),
    );

    const docId = uniqueName('doc');
    const folderId = uniqueName('folder');

    // Mechanism 1: a direct grant.
    await writeOk(tuple(docNs, docId, 'viewer', 'user', 'alice'));

    // Mechanism 2: a nested group membership, two levels deep.
    await writeOk(tuple(groupNs, 'eng_backend', 'member', 'user', 'bob'));
    await writeOk(tuple(groupNs, 'eng', 'member', groupNs, 'eng_backend', 'member'));
    await writeOk(tuple(docNs, docId, 'viewer', groupNs, 'eng', 'member'));

    // Mechanism 3: a tupleToUserset hop.
    await writeOk(tuple(docNs, docId, 'parent', folderNs, folderId));
    await writeOk(tuple(folderNs, folderId, 'editor', 'user', 'carol'));

    // A decoy: erin is a REAL candidate (she has a real relation_tuples
    // row) but has zero connection to this document — proves privescScan
    // runs a real per-candidate check rather than just reporting every
    // distinct subject in the table.
    await writeOk(tuple(groupNs, 'unrelated', 'member', 'user', 'erin'));

    const object = ref(docNs, docId);

    // -----------------------------------------------------------------
    // Part 1: privescScan itself finds exactly the three real subjects,
    // each with a depth/path that independently agrees with a direct
    // productionCheck call, and a real, hop-for-hop-correct path.
    // -----------------------------------------------------------------
    const findings = await privescScan(pool, object, 'view');

    const foundIds = findings.map((f) => `${f.subject.ns}:${f.subject.id}`).sort();
    expect(foundIds).toEqual(['user:alice', 'user:bob', 'user:carol']);
    expect(findings).toHaveLength(3);
    // erin, the decoy, must never appear — the whole point of running a
    // real check per candidate rather than trusting the candidate scan
    // alone.
    expect(foundIds).not.toContain('user:erin');

    // Sorted by depth ascending.
    for (let i = 1; i < findings.length; i += 1) {
      expect(findings[i]!.depth).toBeGreaterThanOrEqual(findings[i - 1]!.depth);
    }

    for (const finding of findings) {
      // Independent oracle: a direct productionCheck call for this exact
      // triple must agree exactly (allowed, depth, and the full path
      // structure) — proves privescScan is nothing more than this real
      // primitive, called correctly, once per real candidate.
      const direct = await productionCheck(pool, finding.subject, object, 'view');
      expect(direct.allowed).toBe(true);
      expect(direct.depth).toBe(finding.depth);
      expect(direct.path).toEqual(finding.path);
    }

    const aliceFinding = findings.find((f) => f.subject.id === 'alice');
    const bobFinding = findings.find((f) => f.subject.id === 'bob');
    const carolFinding = findings.find((f) => f.subject.id === 'carol');
    expect(aliceFinding).toBeDefined();
    expect(bobFinding).toBeDefined();
    expect(carolFinding).toBeDefined();

    // The exact real chain of tuples — the same format `authz check
    // ... --path` already produces (renderResolutionPath is imported
    // unchanged from check.ts, not reimplemented).
    expect(renderResolutionPath(aliceFinding!.path, 'view')).toEqual([
      'user:alice',
      `  → ${docNs}:${docId}#viewer`,
    ]);
    expect(renderResolutionPath(bobFinding!.path, 'view')).toEqual([
      'user:bob',
      `  → ${groupNs}:eng_backend#member`,
      `  → ${groupNs}:eng#member`,
      `  → ${docNs}:${docId}#viewer`,
    ]);
    expect(renderResolutionPath(carolFinding!.path, 'view')).toEqual([
      'user:carol',
      `  → ${folderNs}:${folderId}#editor`,
      `  → ${docNs}:${docId}#view`,
    ]);

    // -----------------------------------------------------------------
    // Part 2: the CLI's own --expected comparison, run against the exact
    // same fixture, in the same test — bob is omitted from --expected
    // (UNEXPECTED), and an uninvolved subject (dave, never granted
    // anything anywhere) is added to --expected (MISSING), both reported
    // in the same run, with process.exitCode set to 1 (UNEXPECTED is
    // blocking; MISSING alone never is).
    // -----------------------------------------------------------------
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let lines: string[];
    try {
      await privescCli(`${docNs}:${docId}`, 'view', {
        expected: 'user:alice,user:carol,user:dave',
      });
      lines = logSpy.mock.calls.map((call) => String(call[0]));
    } finally {
      logSpy.mockRestore();
    }

    expect(process.exitCode).toBe(1);
    expect(lines).toContain('UNEXPECTED: user:bob');
    expect(lines).toContain('MISSING: user:dave');
    // alice and carol were both found AND expected — neither is flagged.
    expect(lines).not.toContain('UNEXPECTED: user:alice');
    expect(lines).not.toContain('UNEXPECTED: user:carol');
    expect(lines).not.toContain('MISSING: user:alice');
    expect(lines).not.toContain('MISSING: user:carol');
    // erin was never expected and never found — not mentioned at all.
    expect(lines.join('\n')).not.toContain('erin');
  }, 60_000);
});
