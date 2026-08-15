/**
 * Loads and validates the process environment before anything else runs.
 * Fails fast with a specific, actionable message rather than letting a
 * missing `DATABASE_URL` surface later as an opaque connection error three
 * layers down.
 *
 * This is the one piece of Phase 0 scaffolding intentionally checked in
 * ahead of the phased build described in
 * `.claude/commands/build-authz-service.md` — every later phase needs
 * config to exist before it needs any domain logic, the same way this
 * project's own sibling services (see docs/DECISIONS.md) each did. The
 * schema below reflects the full env footprint documented in that build
 * spec's §2, matching `.env.example` exactly — later phases consume
 * variables this file already validates; they don't add new ones without
 * updating both files in the same commit.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// quiet: true — dotenv's own startup tip line otherwise prints ahead of
// every CLI command's actual output, including `authz --help`.
dotenv.config({ path: path.resolve(moduleDir, '../../.env'), quiet: true });

/**
 * An optional, non-empty string — for env vars that `.env.example` commits
 * with a blank value (`KEY=`) as a "fill this in" placeholder. dotenv
 * parses that as the empty string, not as an absent key, so a plain
 * `z.string().min(1).optional()` rejects the exact blank-placeholder shape
 * `.env.example` itself uses — caught live running `authz doctor` against
 * a real `.env` copied from the example and only partially filled in.
 * Preprocessing '' to undefined first is what actually makes "optional"
 * mean optional here.
 */
function optionalString() {
  return z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).optional());
}

export const EnvSchema = z.object({
  // Deliberately optional at this layer — see docs/DECISIONS.md D-008.
  // `authz --help` and other commands that touch no store must work on a
  // fresh clone with no `.env` at all; anything that actually needs
  // Postgres (starting with `authz doctor`) checks for this itself and
  // fails with a specific, actionable message at the point of use instead
  // of crashing before the CLI has even parsed its arguments.
  DATABASE_URL: optionalString(),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Graph-walk recursion/BFS depth budget — see build spec §6.4 (cycle
  // detection and termination).
  CHECK_MAX_DEPTH: z.coerce.number().int().positive().default(25),
  // 0 disables the check-result cache entirely.
  CHECK_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(0),

  // Differential-soundness fuzz run — see build spec §6.2 and §9 Phase 5.
  SOUNDNESS_FUZZ_QUERIES: z.coerce.number().int().positive().default(5000),
  SOUNDNESS_FUZZ_SEED: optionalString(),

  MAX_CONCURRENCY: z.coerce.number().int().positive().default(8),

  ADMIN_API_KEY: optionalString(),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    console.error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
