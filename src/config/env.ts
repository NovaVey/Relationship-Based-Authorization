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
dotenv.config({ path: path.resolve(moduleDir, '../../.env') });

export const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — see .env.example'),
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
  SOUNDNESS_FUZZ_SEED: z.string().optional(),

  MAX_CONCURRENCY: z.coerce.number().int().positive().default(8),

  ADMIN_API_KEY: z.string().min(1, 'ADMIN_API_KEY is required — see .env.example').optional(),
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
