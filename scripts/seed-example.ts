#!/usr/bin/env -S npx tsx
/**
 * Publishes `schema/example.authz` and writes the realistic demo tuple
 * graph on top of it — build spec `.claude/commands/build-authz-service.md`
 * §9 Phase 9: "populated with a realistic tuple graph (nested groups, a
 * folder hierarchy, a mix of direct and inherited grants) — including at
 * least one deliberately-included non-obvious case (a user who has access
 * only through two levels of group nesting)."
 *
 * A `.ts` file run directly via `tsx` (`npm run seed:example`), not a
 * plain `.mjs` importing from `dist/` the way `scripts/copy-migrations.mjs`/
 * `scripts/post-soundness-comment.mjs` do — those two run inside CI, after
 * `npm run build`, and have no reason to touch `src/` at all. This script
 * exists for exactly the opposite situation: a stranger who has just run
 * `npm install` and wants the demo live in minutes, matching `npm run
 * cli`'s own `tsx src/cli/index.ts` — no build step required, so "clone,
 * install, seed" stays a 3-command story. It imports the real
 * `publishSchema`/`writeTuple` (`src/schema/publish.ts`/`src/store/
 * tuples.ts`) directly — the exact functions `authz schema publish`/`authz
 * tuple write` call — so seeding the demo exercises the identical code
 * path a real caller would, never a shortcut that writes rows some other
 * way.
 *
 * The graph below is the single source every doc (`README.md`,
 * `docs/RELATIONS.md`, `docs/CONSISTENCY.md`) and every report-designer
 * screen references by name — see `docs/DECISIONS.md` for why this file,
 * not a second copy embedded in a doc, is that source of truth.
 *
 * **The org/group/folder/document story, and why each piece is there:**
 * - `org:acme` has six members; `user:mallory` is also `banned` — the
 *   `org.view = member - banned` exclusion's one negative case.
 * - `group:eng` nests two levels deep: `group:eng_backend` nests inside
 *   `group:eng`, and `group:eng_backend_interns` nests inside
 *   `group:eng_backend`. `user:dana` is a member of `eng_backend_interns`
 *   only — her *only* path to `eng` membership (and everything `eng`
 *   grants) is through two levels of group nesting. This is §9 Phase 9's
 *   own named non-obvious case.
 * - `folder:eng_docs` grants `editor` to `group:eng#member` — reaching
 *   `alice` directly and `dana` through the two-level nesting above.
 *   `folder:eng_backend_docs` has *no* direct grants of its own at all;
 *   everything on it is inherited via `parent->edit`/`parent->view` from
 *   `eng_docs` — proving inheritance actually does the work, not a direct
 *   grant sitting there as a fallback.
 * - `folder:finance_docs` grants `viewer` to `group:finance#member`
 *   (`carol`, `erin`) and `sensitive_reviewer` to `carol` alone — the
 *   `sensitive_review = (viewer|edit) & sensitive_reviewer` intersection's
 *   both cases: `carol` has both, `erin` has only the first.
 * - `document:roadmap` has no `parent` at all — direct grants only
 *   (`bob` viewer, `alice` owner) — the deliberate contrast case against
 *   every other document's inherited access.
 * - `document:eng_handbook` (parent `eng_docs`) and
 *   `document:eng_backend_runbook` (parent `eng_backend_docs`, which
 *   itself has no direct grants) both resolve `edit` for `alice` and
 *   `dana` purely through inheritance — the second one compounds two
 *   folder hops with two group-nesting hops in a single real path.
 * - `document:financials` (parent `finance_docs`) resolves `view` for
 *   `carol`/`erin` through the finance group, independent of the
 *   `sensitive_review` gate above (a real permission a finance member
 *   has regardless of sensitive-review clearance).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { getPool, closePool } from '../src/store/client.js';
import { publishSchema } from '../src/schema/publish.js';
import { writeTuple, type TupleKey } from '../src/store/tuples.js';
import { env } from '../src/config/env.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(moduleDir, '../schema/example.authz');

function tuple(object: string, relation: string, subject: string): TupleKey {
  const [objectNs, objectId] = object.split(':') as [string, string];
  const hash = subject.indexOf('#');
  const subjectRaw = hash === -1 ? subject : subject.slice(0, hash);
  const [subjectNs, subjectId] = subjectRaw.split(':') as [string, string];
  const subjectRelation = hash === -1 ? undefined : subject.slice(hash + 1);
  return {
    objectNs,
    objectId,
    relation,
    subjectNs,
    subjectId,
    ...(subjectRelation !== undefined ? { subjectRelation } : {}),
  };
}

// object, relation, subject — same "namespace:id" / "namespace:id#relation"
// notation `authz tuple write` itself uses (build spec §7), so every line
// here reads exactly like the equivalent CLI invocation would.
const TUPLES: Array<[string, string, string]> = [
  // --- org:acme membership, and the one banned member ---
  ['org:acme', 'member', 'user:alice'],
  ['org:acme', 'member', 'user:bob'],
  ['org:acme', 'member', 'user:carol'],
  ['org:acme', 'member', 'user:dana'],
  ['org:acme', 'member', 'user:erin'],
  ['org:acme', 'member', 'user:mallory'],
  ['org:acme', 'banned', 'user:mallory'],

  // --- nested groups, two levels deep ---
  ['group:eng', 'member', 'user:alice'],
  ['group:eng', 'member', 'group:eng_backend#member'],
  ['group:eng_backend', 'member', 'group:eng_backend_interns#member'],
  ['group:eng_backend_interns', 'member', 'user:dana'],
  ['group:finance', 'member', 'user:carol'],
  ['group:finance', 'member', 'user:erin'],

  // --- folder hierarchy ---
  ['folder:eng_docs', 'editor', 'group:eng#member'],
  ['folder:eng_backend_docs', 'parent', 'folder:eng_docs'],
  ['folder:finance_docs', 'viewer', 'group:finance#member'],
  ['folder:finance_docs', 'sensitive_reviewer', 'user:carol'],

  // --- documents: a mix of direct and inherited grants ---
  ['document:eng_handbook', 'parent', 'folder:eng_docs'],
  ['document:eng_backend_runbook', 'parent', 'folder:eng_backend_docs'],
  ['document:roadmap', 'viewer', 'user:bob'],
  ['document:roadmap', 'owner', 'user:alice'],
  ['document:financials', 'parent', 'folder:finance_docs'],
];

async function main(): Promise<void> {
  if (!env.DATABASE_URL) {
    console.error('Postgres: DATABASE_URL is not set — see .env.example.');
    process.exitCode = 3;
    return;
  }

  const pool = getPool();
  try {
    const source = readFileSync(SCHEMA_PATH, 'utf8');
    const publishResult = await publishSchema(pool, source);
    if (!publishResult.ok) {
      console.error(`schema: ${publishResult.errors.length} error(s), nothing published:`);
      for (const error of publishResult.errors) console.error(`  ${error}`);
      process.exitCode = 2;
      return;
    }
    for (const { namespace, version } of publishResult.published) {
      console.log(`published ${namespace} v${version}`);
    }

    let lastToken = 0;
    for (const [object, relation, subject] of TUPLES) {
      const key = tuple(object, relation, subject);
      const result = await writeTuple(pool, key);
      if (!result.ok) {
        console.error(`tuple write rejected for ${object}#${relation}@${subject}:`);
        for (const error of result.errors) console.error(`  ${error.message}`);
        process.exitCode = 2;
        return;
      }
      lastToken = result.token;
      console.log(
        `wrote ${object}#${relation}@${subject}` + (result.created ? '' : ' (already existed)'),
      );
    }

    console.log('');
    console.log(`seeded ${TUPLES.length} tuples across 4 namespaces — latest token ${lastToken}`);
    console.log('');
    console.log('Try it:');
    console.log('  npx tsx src/cli/index.ts check user:dana edit document:eng_handbook');
    console.log('  npx tsx src/cli/index.ts expand document:eng_handbook edit');
    console.log('  npx tsx src/cli/index.ts check user:mallory view org:acme');
    console.log('  npx tsx src/cli/index.ts check user:erin sensitive_review folder:finance_docs');
    console.log('  npx tsx src/cli/index.ts soundness run');
  } catch (err) {
    console.error(`Postgres: ${(err as Error).message}`);
    process.exitCode = 3;
  } finally {
    await closePool();
  }
}

await main();
