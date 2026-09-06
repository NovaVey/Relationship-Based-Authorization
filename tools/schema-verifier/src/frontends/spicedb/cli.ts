#!/usr/bin/env -S npx tsx
/**
 * `translate-spicedb <schema-file> [--best-effort] [--out <file>]` —
 * prints the `.authz` DSL text a SpiceDB `.zed` schema translates to,
 * with its own disclosed-translation-notes header
 * (`../common/disclose.ts`). Mirrors the OpenFGA front end's own
 * `translate-openfga` CLI exactly — see that file's own top-of-file
 * comment for the reasoning this one shares (standalone from
 * `verify-schema`, not registered as a `package.json` `bin`).
 *
 *   npx tsx tools/schema-verifier/src/frontends/spicedb/cli.ts <schema-file>
 */
import { writeFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';

import { translateSpicedbFile } from './translate-file.js';

const program = new Command();

program
  .name('translate-spicedb')
  .description(
    "Translate a SpiceDB .zed schema into this repository's own namespace DSL, printing the result (with a disclosed-translation-notes header) to stdout or --out.",
  )
  .argument('<schema-file>', 'path to a .zed SpiceDB schema file')
  .option(
    '--best-effort',
    "drop unsupported constructs (SpiceDB's 'self' keyword, where it appears as one term of a union) instead of failing, disclosing each drop in the output header",
  )
  .option('--out <file>', 'write the translated .authz text to this file instead of stdout')
  .exitOverride()
  .action((schemaFile: string, options: { bestEffort?: boolean; out?: string }) => {
    const result = translateSpicedbFile(schemaFile, { bestEffort: options.bestEffort ?? false });
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    if (options.out !== undefined) {
      writeFileSync(options.out, result.dslText, 'utf8');
    } else {
      console.log(result.dslText);
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CommanderError) {
    process.exitCode = err.exitCode === 0 ? 0 : 1;
  } else {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
