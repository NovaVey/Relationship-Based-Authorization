#!/usr/bin/env -S npx tsx
/**
 * Writes `docs/openapi.json` — the hand-maintained OpenAPI 3.0.3 document
 * `src/api/openapi-document.ts`'s `buildOpenApiDocument()` produces,
 * pretty-printed to disk. Run via `npm run generate:openapi`
 * (`tsx scripts/generate-openapi.ts`).
 *
 * A `.ts` file run directly via `tsx`, not a plain `.mjs` importing from
 * `dist/` the way `scripts/copy-migrations.mjs`/`scripts/
 * post-soundness-comment.mjs` do — matching `scripts/seed-example.ts`'s own
 * precedent (see that file's own doc comment) for the identical reason:
 * this needs no build step, so regenerating the document after editing
 * `src/api/openapi-document.ts` is always exactly one command.
 *
 * **The one function this calls is the same one `GET /openapi.json`
 * (`src/api/server.ts`) calls at request time.** There is no second,
 * independently-hand-written copy of this document anywhere — see
 * `src/api/openapi-document.ts`'s own top-of-file doc comment for why that
 * single-source-of-truth design is the entire point of this generator.
 * This script's only job is choosing where the result lands on disk and
 * how it's formatted there; it decides nothing about the document's actual
 * content.
 *
 * No I/O beyond a single synchronous file write — no Postgres, no network —
 * so this always runs, in any environment, with nothing more than
 * `npm install` first.
 *
 * **`prettier` (already a `devDependency` — nothing new added for this
 * generator).** A plain `JSON.stringify(document, null, 2)` collapses every
 * array one-element-per-line regardless of length, which is *not* this
 * project's own `.prettierrc` JSON style (short arrays like `["ns", "id"]`
 * stay on one line — see `docs/dst-regression-corpus.json`, already checked
 * in and already `prettier --check`-clean). Formatting through this
 * project's own installed `prettier` — the exact same formatter
 * `npm run format`/`format:check` already run over every other file, with
 * this repo's own `.prettierrc` resolved for `docs/openapi.json`'s path —
 * keeps this generated file passing `npm run verify` exactly like every
 * hand-written file in this repo, rather than requiring a `.prettierignore`
 * carve-out for one generated artifact.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as prettier from 'prettier';

import { buildOpenApiDocument } from '../src/api/openapi-document.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(moduleDir, '../docs/openapi.json');

async function main(): Promise<void> {
  const document = buildOpenApiDocument();
  const config = await prettier.resolveConfig(OUTPUT_PATH);
  const formatted = await prettier.format(JSON.stringify(document), {
    ...config,
    filepath: OUTPUT_PATH,
  });
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, formatted, 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
}

await main();
