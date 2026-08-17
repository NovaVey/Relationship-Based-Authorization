/**
 * `authz soundness run --format text|markdown|json` — build spec
 * `.claude/commands/build-authz-service.md` §7 ("authz soundness run
 * [--queries N] [--seed S]" plus the `--format` option
 * `src/cli/commands/soundness.ts`'s own doc comment states was added this
 * phase) and §9 Phase 7's exit criterion. A sibling of
 * `test/unit/cli/soundness.test.ts` (which already covers the exit-code
 * table itself) — this file is only about format *dispatch*: does
 * `--format markdown` print exactly `renderSoundnessMarkdown`'s own output
 * and nothing else, does `--format json` print exactly
 * `renderSoundnessJsonString`'s own output and nothing else, and does an
 * invalid `--format` value fail closed the same way a malformed `--queries`
 * value already does (`src/cli/commands/soundness.ts`'s own source: both are
 * argument-validation failures reported before `runSoundnessFuzz` is ever
 * called, at exit code 2). This is *not* re-testing that the renderers
 * produce correct markdown/JSON — `test/unit/report/markdown.test.ts` and
 * `test/unit/report/json.test.ts` already do that from the spec; this file
 * only proves the CLI calls the real renderer and prints its result
 * verbatim.
 *
 * `runSoundnessFuzz` is mocked via `vi.spyOn` — matching
 * `test/unit/cli/soundness.test.ts`'s own established, documented rationale
 * for doing so (the fuzz harness's own detection power is proven elsewhere;
 * this file is testing the CLI's own format-dispatch wiring, not the
 * resolvers or the fuzz harness).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as runnerModule from '../../../src/soundness/runner.js';
import { env } from '../../../src/config/env.js';
import { soundnessRun } from '../../../src/cli/commands/soundness.js';
import { closePool } from '../../../src/store/client.js';
import { renderSoundnessMarkdown } from '../../../src/report/markdown.js';
import { renderSoundnessJsonString } from '../../../src/report/json.js';
import type { SoundnessRunResult } from '../../../src/soundness/runner.js';

function cannedResult(): SoundnessRunResult {
  return {
    id: 'format-test-run-id',
    graphSeed: 'format-test-seed',
    namespaceCount: 3,
    tupleCount: 10,
    queryCount: 5,
    falseGrantCount: 1,
    falseDenyCount: 0,
    criticalNamespaceFalseGrants: 1,
    verdict: 'unsound',
    divergences: [
      {
        query: {
          subject: { ns: 'user', id: 'mallory' },
          object: { ns: 'critical_ns', id: 'o0' },
          relationOrPermission: 'view',
        },
        expected: false,
        actual: true,
        kind: 'false_grant',
        critical: true,
        productionPath: {
          kind: 'directGrant',
          object: { ns: 'critical_ns', id: 'o0' },
          relation: 'viewer',
          subject: { ns: 'user', id: 'mallory' },
        },
      },
    ],
  };
}

describe('authz soundness run — --format dispatch', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closePool();
    process.exitCode = undefined;
  });

  it('format-markdown-prints-exactly-rendersoundnessmarkdowns-output-and-nothing-else', async () => {
    const result = cannedResult();
    vi.spyOn(runnerModule, 'runSoundnessFuzz').mockResolvedValue(result);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({ format: 'markdown' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(renderSoundnessMarkdown(result));
    expect(process.exitCode).toBe(1); // verdict 'unsound' — format never changes what's computed.
  });

  it('format-json-prints-exactly-rendersoundnessjsonstrings-output-and-nothing-else', async () => {
    const result = cannedResult();
    vi.spyOn(runnerModule, 'runSoundnessFuzz').mockResolvedValue(result);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({ format: 'json' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(renderSoundnessJsonString(result));
    expect(process.exitCode).toBe(1);
  });

  it('an-invalid-format-value-exits-two-before-runsoundnessfuzz-is-ever-called-matching-the-malformed-queries-precedent', async () => {
    const spy = vi.spyOn(runnerModule, 'runSoundnessFuzz');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({ format: 'yaml' });

    expect(spy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('the-default-format-with-no-format-option-is-text-unchanged-multi-line-console-output-not-a-single-rendered-document', async () => {
    const result = cannedResult();
    vi.spyOn(runnerModule, 'runSoundnessFuzz').mockResolvedValue(result);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    process.exitCode = undefined;

    await soundnessRun({});

    // The original Phase 5 text summary prints several separate lines via
    // several separate `console.log` calls — the opposite shape of the
    // markdown/json formats' single verbatim-document call.
    expect(logSpy.mock.calls.length).toBeGreaterThan(1);
    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).not.toBe(renderSoundnessMarkdown(result));
    expect(allOutput).not.toBe(renderSoundnessJsonString(result));
  });
});

describe('authz soundness run — --dry-run leaves markdown/json stdout untouched', () => {
  // `src/cli/commands/soundness.ts`'s own top-of-file doc comment states
  // this as a load-bearing contract: "Only affects `--format text`'s extra
  // note below; `markdown`/`json` output is untouched either way, since
  // both modes' own contract is 'stdout is the report and nothing else.'"
  // — true by inspection (the dry-run note is only ever appended inside
  // `printText`, never reached by the markdown/json branches), but nothing
  // committed exercised `soundnessRun` itself with `dryRun: true` through
  // those two branches before this file; the existing dedicated dry-run
  // tests call `runSoundnessFuzz` directly, bypassing `--format` dispatch
  // entirely. These two prove the contract by calling `soundnessRun` twice
  // — once with `dryRun: false`, once with `dryRun: true`, same mocked
  // result both times — and asserting the two stdout writes are literally
  // identical, not merely "both look like markdown/JSON."
  afterEach(async () => {
    vi.restoreAllMocks();
    await closePool();
    process.exitCode = undefined;
  });

  it('dry-run-combined-with-format-markdown-produces-byte-identical-stdout-to-the-non-dry-run-call-carrying-no-dry-run-note', async () => {
    const result = cannedResult();
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    vi.spyOn(runnerModule, 'runSoundnessFuzz').mockResolvedValue(result);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    process.exitCode = undefined;
    await soundnessRun({ format: 'markdown', dryRun: false });
    process.exitCode = undefined;
    await soundnessRun({ format: 'markdown', dryRun: true });

    expect(logSpy).toHaveBeenCalledTimes(2);
    const [nonDryOutput] = logSpy.mock.calls[0] ?? [];
    const [dryOutput] = logSpy.mock.calls[1] ?? [];
    expect(dryOutput).toBe(nonDryOutput);
    // Independently anchored, not merely self-consistent with each other:
    // both calls equal the renderer's own output verbatim, so a bug that
    // corrupted *both* calls identically (e.g. a dry-run note baked into
    // `renderSoundnessMarkdown` itself) would still be caught.
    expect(nonDryOutput).toBe(renderSoundnessMarkdown(result));
    expect(dryOutput).toBe(renderSoundnessMarkdown(result));
  });

  it('dry-run-combined-with-format-json-produces-byte-identical-stdout-to-the-non-dry-run-call-carrying-no-dry-run-note', async () => {
    const result = cannedResult();
    env.DATABASE_URL = 'postgres://mock:mock@127.0.0.1:1/mock';
    vi.spyOn(runnerModule, 'runSoundnessFuzz').mockResolvedValue(result);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    process.exitCode = undefined;
    await soundnessRun({ format: 'json', dryRun: false });
    process.exitCode = undefined;
    await soundnessRun({ format: 'json', dryRun: true });

    expect(logSpy).toHaveBeenCalledTimes(2);
    const [nonDryOutput] = logSpy.mock.calls[0] ?? [];
    const [dryOutput] = logSpy.mock.calls[1] ?? [];
    expect(dryOutput).toBe(nonDryOutput);
    expect(nonDryOutput).toBe(renderSoundnessJsonString(result));
    expect(dryOutput).toBe(renderSoundnessJsonString(result));
  });
});
