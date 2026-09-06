#!/usr/bin/env -S npx tsx
/**
 * `translate-openfga <model-file> [--best-effort] [--out <file>]` — prints
 * the `.authz` DSL text an OpenFGA `.fga`/JSON model translates to, with
 * its own disclosed-translation-notes header (`../common/disclose.ts`).
 * Standalone from `verify-schema` (`../../cli/index.ts`) so a user can
 * inspect or save a translation without also having an `.invariant` file
 * ready — `verify-schema --from-openfga <file>` (wired in `../../cli/
 * verify.ts`) is the one-step version of "translate, then verify," reusing
 * this same `translateOpenfgaFile` function.
 *
 * Not registered as a `package.json` `bin` — see `../../cli/index.ts`'s
 * own top-of-file comment for why (this whole directory has no
 * `package.json` of its own, D-120's file-touch discipline). Invoke it
 * directly:
 *
 *   npx tsx tools/schema-verifier/src/frontends/openfga/cli.ts <model-file>
 */
import { writeFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';

import { translateOpenfgaFile } from './translate-file.js';

const program = new Command();

program
  .name('translate-openfga')
  .description(
    "Translate an OpenFGA .fga or JSON authorization model into this repository's own namespace DSL, printing the result (with a disclosed-translation-notes header) to stdout or --out.",
  )
  .argument('<model-file>', 'path to a .fga (DSL) or .json (AuthorizationModel) OpenFGA model file')
  .option(
    '--best-effort',
    'drop unsupported constructs (ABAC conditions) instead of failing, disclosing each drop in the output header',
  )
  .option('--out <file>', 'write the translated .authz text to this file instead of stdout')
  .exitOverride()
  .action((modelFile: string, options: { bestEffort?: boolean; out?: string }) => {
    const result = translateOpenfgaFile(modelFile, { bestEffort: options.bestEffort ?? false });
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
  // Mirrors ../../cli/index.ts's own exact handling of a Commander usage
  // error — see that file's own top-of-file comment for why 0/1, not a
  // reserved verify-schema-specific code: this is a different CLI with no
  // exit-code table of its own to protect.
  if (err instanceof CommanderError) {
    process.exitCode = err.exitCode === 0 ? 0 : 1;
  } else {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
