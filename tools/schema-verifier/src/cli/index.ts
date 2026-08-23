#!/usr/bin/env -S npx tsx
/**
 * `verify-schema` — build spec §9:
 *
 *   verify-schema <schema-file> --invariants <file> [--bound k] [--json]
 *
 * Not registered as a `package.json` `bin` — this module lives entirely
 * under `tools/schema-verifier/`, and this branch's own file-touch
 * discipline (`docs/DECISIONS.md` D-120) scopes it there, so there is no
 * root `package.json` this file can add a `bin` entry to. Invoke it
 * directly:
 *
 *   npx tsx tools/schema-verifier/src/cli/index.ts <schema-file> --invariants <file>
 *
 * `commander` is already a dependency of this repository's root
 * `package.json` (the `authz` CLI, `src/cli/index.ts`) — reused here, not
 * newly added, so this needed no "ask before adding any dependency"
 * conversation (§0 rule 5).
 *
 * `.exitOverride()` + the `try`/`catch` around `parseAsync` mirrors
 * `src/cli/index.ts`'s own fix for the same problem (full-repo audit
 * finding #16): without it, Commander calls `process.exit(1)` directly on
 * a usage error (an unknown flag, a missing required option), and `1` is
 * exactly the code this CLI's own table (`exitCodes.ts`) reserves for a
 * confirmed `VIOLATED` verdict — a CLI typo and a real schema-safety
 * finding must never be indistinguishable to a script branching on exit
 * code alone.
 *
 * Usage errors here get `3` ("tool error"), not `2` — an earlier draft of
 * this file invented a fifth code for them instead, reasoning that `2`
 * ("unknown/bound exceeded") is already a real verifier-result category
 * for *this* CLI, unlike the root `authz` CLI, where reusing `2` for a
 * malformed argument was safe because nothing else in that table claimed
 * it. That reasoning was right about the collision — but the fix wasn't
 * "invent a fifth code," it was "use the code build spec §9 already
 * reserves for exactly this situation." `3`, "tool error," is defined by
 * that same table to mean "the verifier crashed" as opposed to "your
 * schema is unsafe" — and a usage error (bad flag, missing `--invariants`)
 * is precisely that: no real verdict was produced, for a reason that has
 * nothing to do with the schema. Folding it into `3` alongside
 * `verify.ts`'s own "ran and failed" cases (a file that won't parse, an
 * unexpected exception) keeps every code inside §9's own literal four-
 * entry table rather than introducing an undocumented fifth one, while
 * still fully avoiding the collision with `2` that motivated a change in
 * the first place.
 */
import { Command, CommanderError } from 'commander';

import { runVerify } from './verify.js';

const program = new Command();

program
  .name('verify-schema')
  .description(
    'Statically verify a namespace DSL schema against an invariant — proves it holds under every possible tuple set, or produces a real counterexample confirmed against the production check engine.',
  )
  .argument('<schema-file>', 'path to a .authz schema file')
  .requiredOption('--invariants <file>', 'path to a .invariant file (may declare more than one)')
  .option(
    '--bound <k>',
    "bound for the non-monotone fragment's bounded search (§7); ignored for the monotone fragment (default: 1 — see docs/DECISIONS.md D-118 for why)",
  )
  .option('--json', 'machine-readable JSON output instead of the human-readable default')
  .exitOverride()
  .action(
    async (schemaFile: string, options: { invariants: string; bound?: string; json?: boolean }) => {
      let bound: number | undefined;
      if (options.bound !== undefined) {
        bound = Number(options.bound);
        if (!Number.isInteger(bound) || bound < 1) {
          console.error(`invalid --bound '${options.bound}' — must be a positive integer`);
          process.exitCode = 3;
          return;
        }
      }

      const { exitCode } = await runVerify({
        schemaFile,
        invariantsFile: options.invariants,
        ...(bound !== undefined ? { bound } : {}),
        json: options.json ?? false,
      });
      process.exitCode = exitCode;
    },
  );

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CommanderError) {
    // --help is non-error display (Commander's own exitCode 0) — left
    // alone, never remapped. (No `.version()` is registered on this
    // program — unlike the root `authz` CLI — so `--version` is not a
    // recognized flag here; it hits the usage-error branch below like
    // any other unknown flag, confirmed directly, not assumed.) Every
    // real usage error is exitCode 1
    // (confirmed by the same source read `src/cli/index.ts`'s own doc
    // comment cites — Commander only ever constructs 0 or 1), remapped to
    // 3 here — see this file's own top-of-file comment for why 3, not a
    // fifth code, is the right home for a usage error.
    process.exitCode = err.exitCode === 0 ? 0 : 3;
  } else {
    // Not a Commander usage error and not anything runVerify() itself
    // ever throws (it catches everything and returns a coded result) —
    // a genuine, unanticipated bug in this file's own wiring. Mapped to
    // 3 ("tool error"), not left to crash with Node's own default exit
    // code, so it still reads as "the verifier itself is broken," per
    // §9's own exit-code table, rather than an unexplained non-zero exit.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 3;
  }
}
