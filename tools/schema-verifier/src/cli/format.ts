/**
 * Rendering for `verify-schema`'s two output modes — build spec §9:
 * "Human output leads with the verdict, then the counterexample tuples,
 * then the engine's confirmation. `--json` for machine use." Both modes
 * render from the exact same `InvariantVerification` values `verify.ts`
 * produces; neither one computes anything of its own.
 */
import type { CheckResult } from '../reachability/types.js';
import type { WitnessTuple } from '../reachability/types.js';
import type { ValidationOutcome } from '../validate/types.js';
import type { InvariantExitCode } from './exitCodes.js';

export interface InvariantVerification {
  readonly name: string;
  readonly result: CheckResult;
  readonly validation: ValidationOutcome;
  readonly exitCode: InvariantExitCode;
}

/** `namespace:id` or, when the witness's own subject is itself a userset, `namespace:id#relation` — the same `WitnessTuple` shape `examples/run.ts` renders, factored out here as this module's own source of truth so the two can't drift apart. */
export function formatWitnessTuple(t: WitnessTuple): string {
  const subject =
    t.subjectRelation === undefined
      ? `${t.subjectType}:${t.subject}`
      : `${t.subjectType}:${t.subject}#${t.subjectRelation}`;
  return `${t.objectType}:${t.object}#${t.relation}@${subject}`;
}

function formatValidationLine(validation: ValidationOutcome): string {
  switch (validation.kind) {
    case 'confirmed':
      return 'self-validation: confirmed — the real, unmodified production engine agrees (allowed).';
    case 'mismatch':
      return `self-validation: MISMATCH — ${validation.reason} (the verifier's own claim could not be substantiated; treat this result as unresolved, not as a confirmed finding).`;
    case 'empirically-clean':
      return `self-validation: empirically clean — ${validation.sampled} random type-valid tuple sets sampled, none granted the goal.`;
    case 'empirical-counterexample':
      return 'self-validation: EMPIRICAL COUNTEREXAMPLE — a random type-valid tuple set made the real engine grant the goal, contradicting this HOLDS verdict. This is a bug in the search itself, not a schema finding.';
    case 'not-applicable':
      return 'self-validation: not applicable.';
  }
}

/** One invariant's full human-readable block: verdict line, counterexample tuples (if any), self-validation line. No trailing blank line — callers join blocks with their own separator. */
export function formatInvariantHuman(v: InvariantVerification): string[] {
  const lines: string[] = [];
  const boundSuffix = v.result.bound !== undefined ? ` up to k = ${v.result.bound}` : '';
  lines.push(`${v.name}: ${v.result.verdict}${boundSuffix} (fragment: ${v.result.fragment})`);
  if (v.result.reason !== undefined) {
    lines.push(`  reason: ${v.result.reason}`);
  }
  if (v.result.witness !== undefined && v.result.witness.length > 0) {
    lines.push('  counterexample tuples:');
    for (const t of v.result.witness) {
      lines.push(`    ${formatWitnessTuple(t)}`);
    }
  }
  lines.push(`  ${formatValidationLine(v.validation)}`);
  lines.push(`  exit code: ${v.exitCode}`);
  return lines;
}

export function formatHuman(
  schemaFile: string,
  verifications: readonly InvariantVerification[],
): string {
  const blocks = verifications.map((v) => formatInvariantHuman(v).join('\n'));
  return [`schema: ${schemaFile}`, ...blocks].join('\n\n');
}

/** A JSON-serializable projection of `ValidationOutcome` — every field a `--json` consumer might need, none of the class distinctions TypeScript's own discriminated union carries. */
function validationToJson(validation: ValidationOutcome): Record<string, unknown> {
  switch (validation.kind) {
    case 'confirmed':
      return {
        kind: 'confirmed',
        allowed: validation.engineResult.allowed,
        depth: validation.engineResult.depth,
      };
    case 'mismatch':
      return {
        kind: 'mismatch',
        reason: validation.reason,
        allowed: validation.engineResult?.allowed,
        depth: validation.engineResult?.depth,
      };
    case 'empirically-clean':
      return { kind: 'empirically-clean', sampled: validation.sampled };
    case 'empirical-counterexample':
      return {
        kind: 'empirical-counterexample',
        tuples: validation.tuples.map(formatWitnessTuple),
        allowed: validation.engineResult.allowed,
        depth: validation.engineResult.depth,
      };
    case 'not-applicable':
      return { kind: 'not-applicable' };
  }
}

export interface JsonReport {
  readonly schema: string;
  readonly invariants: ReadonlyArray<{
    readonly name: string;
    readonly verdict: string;
    readonly fragment: string | undefined;
    readonly bound: number | undefined;
    readonly reason: string | undefined;
    readonly witness: readonly string[] | undefined;
    readonly validation: Record<string, unknown>;
    readonly exitCode: InvariantExitCode;
  }>;
  readonly exitCode: InvariantExitCode;
}

export function toJsonReport(
  schemaFile: string,
  verifications: readonly InvariantVerification[],
  exitCode: InvariantExitCode,
): JsonReport {
  return {
    schema: schemaFile,
    invariants: verifications.map((v) => ({
      name: v.name,
      verdict: v.result.verdict,
      fragment: v.result.fragment,
      bound: v.result.bound,
      reason: v.result.reason,
      witness: v.result.witness?.map(formatWitnessTuple),
      validation: validationToJson(v.validation),
      exitCode: v.exitCode,
    })),
    exitCode,
  };
}
