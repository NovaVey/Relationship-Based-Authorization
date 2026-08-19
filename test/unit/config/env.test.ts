/**
 * `EnvSchema` (`src/config/env.ts`) — had zero dedicated unit tests anywhere
 * in the repo before this file (full-repo audit finding #9, MEDIUM, third
 * audit, 2026-08-17; confirmed via `grep -rn "EnvSchema|optionalString"
 * test/` before writing a single test here: zero hits). Everything this
 * project knows about the schema's actual validation behavior — including
 * D-008's own "blank placeholder means use the default" contract and this
 * same audit's finding #12 fix (every defaulted field, not just the three
 * `optionalString()` ones, now gets that same treatment) — was previously
 * only exercised indirectly, by running the real CLI against a real `.env`.
 *
 * Exercises `EnvSchema.safeParse()` directly, never the loaded `env`
 * singleton (`export const env = loadEnv()` runs once, at import time,
 * against the real `process.env`/`.env` this repo happens to have —
 * re-parsing arbitrary fixture objects through the singleton isn't
 * possible, and isn't the point; this file is about the schema's own
 * validation rules, not about what this particular checkout's `.env`
 * happens to contain).
 *
 * **A premise worth stating explicitly, checked directly rather than
 * assumed:** this schema has no field that is "required" in the sense of
 * "must be present in the input object or parsing fails" — every field is
 * either `optionalString()`-wrapped (`DATABASE_URL`, `SOUNDNESS_FUZZ_SEED`,
 * `ADMIN_API_KEY`) or carries a `.default(...)` (every other field), by
 * D-008's own deliberate design (`authz --help` must work on a fresh clone
 * with no `.env` at all). So "each required field individually omitted"
 * doesn't apply literally here — there's nothing to omit that isn't already
 * handled by falling through to its default or to `undefined`. What this
 * file tests instead, which is the real property worth pinning: omitting
 * every field at once still succeeds, and produces exactly the documented
 * defaults (see the second describe block below) — not a crash, not a
 * silent wrong value.
 */
import { describe, expect, it } from 'vitest';

import { EnvSchema } from '../../../src/config/env.js';

/** A fully-populated, entirely valid input — every field set to a real, distinct, non-default value so a bug that silently ignores one field's own supplied value (falls back to its default instead) would show up in the equality check below. */
const FULLY_POPULATED_VALID_ENV = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/authz_service',
  PORT: '4000',
  NODE_ENV: 'production',
  LOG_LEVEL: 'warn',
  CHECK_MAX_DEPTH: '10',
  CHECK_CACHE_TTL_MS: '500',
  SOUNDNESS_FUZZ_QUERIES: '2000',
  SOUNDNESS_FUZZ_SEED: 'a-fixed-reproducible-seed',
  MAX_CONCURRENCY: '4',
  ADMIN_API_KEY: 'a'.repeat(40),
};

describe('EnvSchema.safeParse — a fully-populated, valid env object', () => {
  it('succeeds-and-coerces-every-field-to-its-own-real-supplied-value-not-a-default', () => {
    const result = EnvSchema.safeParse(FULLY_POPULATED_VALID_ENV);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      DATABASE_URL: 'postgres://user:pass@localhost:5432/authz_service',
      PORT: 4000,
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      CHECK_MAX_DEPTH: 10,
      CHECK_CACHE_TTL_MS: 500,
      SOUNDNESS_FUZZ_QUERIES: 2000,
      SOUNDNESS_FUZZ_SEED: 'a-fixed-reproducible-seed',
      MAX_CONCURRENCY: 4,
      ADMIN_API_KEY: 'a'.repeat(40),
    });
  });
});

describe('EnvSchema.safeParse({}) — nothing is genuinely required; every field falls through to its documented default or to undefined', () => {
  it('an-entirely-empty-input-object-still-succeeds-with-every-documented-default', () => {
    const result = EnvSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      DATABASE_URL: undefined,
      PORT: 3000,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      CHECK_MAX_DEPTH: 25,
      CHECK_CACHE_TTL_MS: 0,
      SOUNDNESS_FUZZ_QUERIES: 5000,
      SOUNDNESS_FUZZ_SEED: undefined,
      MAX_CONCURRENCY: 8,
      ADMIN_API_KEY: undefined,
    });
  });
});

describe('EnvSchema.safeParse — the optionalString() fields resolve the .env.example blank-placeholder shape ("") to undefined, per D-008', () => {
  it.each(['DATABASE_URL', 'SOUNDNESS_FUZZ_SEED', 'ADMIN_API_KEY'] as const)(
    '%s: "" resolves to undefined, the same as an absent key, never a validation failure',
    (field) => {
      const result = EnvSchema.safeParse({ ...FULLY_POPULATED_VALID_ENV, [field]: '' });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data[field]).toBeUndefined();
    },
  );
});

describe('EnvSchema.safeParse — finding #12\'s fix: every defaulted field, not just the optionalString() ones, resolves "" to its own documented default', () => {
  it.each([
    ['PORT', 3000],
    ['NODE_ENV', 'development'],
    ['LOG_LEVEL', 'info'],
    ['CHECK_MAX_DEPTH', 25],
    ['CHECK_CACHE_TTL_MS', 0],
    ['SOUNDNESS_FUZZ_QUERIES', 5000],
    ['MAX_CONCURRENCY', 8],
  ] as const)(
    '%s: "" resolves to its documented default (%j), not a too_small/invalid_enum_value failure',
    (field, expectedDefault) => {
      // Before the finding #12 fix, this exact case failed: `Number('')`
      // is `0`, not `NaN`, so a blank numeric field cleared to 0 and then
      // failed whatever positivity/non-negativity check the field itself
      // carries — never reaching `.default(...)` at all. An enum field
      // failed for a different reason ('' isn't one of the declared
      // values). Both are now closed by the same `blankToUndefined`
      // preprocessing `optionalString()` already had.
      const result = EnvSchema.safeParse({ ...FULLY_POPULATED_VALID_ENV, [field]: '' });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data[field]).toBe(expectedDefault);
    },
  );
});

describe('EnvSchema.safeParse — an invalid NODE_ENV/LOG_LEVEL value fails, "" aside', () => {
  it('an-unrecognized-node-env-value-fails', () => {
    const result = EnvSchema.safeParse({ ...FULLY_POPULATED_VALID_ENV, NODE_ENV: 'staging' });
    expect(result.success).toBe(false);
  });

  it('an-unrecognized-log-level-value-fails', () => {
    const result = EnvSchema.safeParse({ ...FULLY_POPULATED_VALID_ENV, LOG_LEVEL: 'verbose' });
    expect(result.success).toBe(false);
  });
});

describe('EnvSchema.safeParse — a non-numeric or out-of-range PORT fails', () => {
  it('a-non-numeric-port-fails', () => {
    const result = EnvSchema.safeParse({ ...FULLY_POPULATED_VALID_ENV, PORT: 'not-a-number' });
    expect(result.success).toBe(false);
  });

  it('a-zero-port-fails-positive-is-required-not-merely-non-negative', () => {
    const result = EnvSchema.safeParse({ ...FULLY_POPULATED_VALID_ENV, PORT: '0' });
    expect(result.success).toBe(false);
  });

  it('a-negative-port-fails', () => {
    const result = EnvSchema.safeParse({ ...FULLY_POPULATED_VALID_ENV, PORT: '-1' });
    expect(result.success).toBe(false);
  });

  it('a-non-integer-port-fails', () => {
    const result = EnvSchema.safeParse({ ...FULLY_POPULATED_VALID_ENV, PORT: '3000.5' });
    expect(result.success).toBe(false);
  });
});

describe('EnvSchema.safeParse — ADMIN_API_KEY (finding #10): set-but-too-short fails fast with a specific message, unset is still fine', () => {
  it('a-31-character-key-one-short-of-the-new-minimum-fails', () => {
    const result = EnvSchema.safeParse({
      ...FULLY_POPULATED_VALID_ENV,
      ADMIN_API_KEY: 'a'.repeat(31),
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((issue) => issue.message.includes('at least 32 characters')),
    ).toBe(true);
  });

  it('a-32-character-key-exactly-at-the-new-minimum-succeeds', () => {
    const result = EnvSchema.safeParse({
      ...FULLY_POPULATED_VALID_ENV,
      ADMIN_API_KEY: 'a'.repeat(32),
    });
    expect(result.success).toBe(true);
  });

  it('an-unset-admin-api-key-is-still-a-valid-deliberate-writes-disabled-state-not-an-error', () => {
    const { ADMIN_API_KEY: _omit, ...withoutAdminKey } = FULLY_POPULATED_VALID_ENV;
    const result = EnvSchema.safeParse(withoutAdminKey);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ADMIN_API_KEY).toBeUndefined();
  });
});
