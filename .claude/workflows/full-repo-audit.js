export const meta = {
  name: 'full-repo-audit',
  description:
    'Deep, multi-dimension audit of the whole Relationship-Based-Authorization repo — bugs, security issues, doc drift, test gaps, and improvements, adversarially verified before reporting.',
  whenToUse:
    'Run after a significant change lands, before a release, or periodically to catch drift between docs and code, weak test coverage, or regressions in the soundness/consistency guarantees this project exists to prove.',
  phases: [
    { title: 'Review', detail: '14 parallel dimension reviews across the whole codebase' },
    {
      title: 'Verify',
      detail: 'adversarial skeptic verification of bug/security/test-gap/doc-drift findings',
    },
    { title: 'Synthesize', detail: 'dedupe, rank by severity, final report' },
  ],
};

const REPO = '/home/user/Relationship-Based-Authorization';

const SHARED_CONTEXT = `You are reviewing a real, already-built, already-shipped production codebase at ${REPO} (a git repo, currently on branch main, fully merged, CI green). Work directly against this checkout.

PROJECT: A Zanzibar-style relationship-based authorization (ReBAC) service in Node 22 + TypeScript (strict), hand-written SQL against Postgres via 'pg' (no ORM, deliberately — see docs/DECISIONS.md D-004), Fastify API, commander CLI, Vitest + fast-check for testing. Core concept: namespaces declare relations (storable tuples) and permissions (computed via union/intersection/exclusion/tuple-to-userset rewrite rules over a schema DSL compiled from source). A production SQL-backed resolver and a deliberately naive, independently-written in-memory reference resolver (the "oracle") are differentially fuzz-tested against each other on every PR — any disagreement is either a false_grant (blocking, security-critical) or false_deny (non-blocking). Every allow decision logs the exact resolution path (the audit trail). Consistency tokens (write_log.id, monotonic) let a caller pin a check to observe a specific write and everything before it.

BEFORE flagging something as a bug: grep docs/DECISIONS.md for related keywords. Many non-obvious choices here are deliberate, already-reasoned-through tradeoffs with their own dedicated entry ("## D-0NN — <title>", each with Decision/Alternative rejected/Why it lost/Revisit if). If you disagree with an already-documented tradeoff's own reasoning, flag it as category 'improvement' explaining specifically why the stated reasoning is wrong or has changed — never as a 'bug'. If something has NO corresponding DECISIONS.md entry and looks unintentional, it's fair game to flag directly.

ALSO check PROGRESS.md for the real, current state and any already-known, already-disclosed open items — don't re-report something already tracked there as new unless you have something genuinely additional (a concrete reproduction, a worse consequence than documented, a case the existing note doesn't cover).

RULES — read carefully, several other agents are reviewing this same repo concurrently against a SHARED local Postgres instance:
- READ-ONLY review. Do not modify, create, or delete any file anywhere in the repo. Do not write scratch files inside the repo either — use /tmp if you need scratch space.
- Do NOT run anything that mutates the database or shared state: no 'psql ... drop/create/insert/update/delete', no 'npm run seed:example', no 'authz soundness run', no 'authz tuple write/delete', no 'authz schema publish', no 'authz doctor' (it applies migrations), no git commit/push/checkout -b/branch mutation. Any of these will corrupt other agents' concurrent work and produce false findings that aren't real bugs.
- Safe to run: 'npx tsc --noEmit', 'npx eslint <path>', 'npx prettier --check <path>', 'npx vitest run' (the fast unit suite only — excludes '*.integration.test.ts', needs no Postgres), 'git log/diff/show/blame', and any read-only shell command (grep, find, cat, wc, etc. — though prefer the Read/Grep/Glob tools where they fit).
- Every finding MUST cite a real file path (relative to the repo root) and, where applicable, a real line number you actually read yourself — never a guessed or approximate location.
- Every finding must be concrete: quote the actual problematic code/text in the 'detail' field, don't describe it vaguely.
- Categories: 'bug' (produces a wrong result, crashes, or violates a stated invariant), 'security' (a real, exploitable weakness — auth bypass, injection, timing attack, information disclosure, DoS), 'improvement' (works correctly today but could be clearer/simpler/more efficient/more robust), 'doc-drift' (a doc or comment states something the real code no longer does, or vice versa), 'test-gap' (a real behavior or edge case with no test coverage, or an existing test whose name/comment claims something its body doesn't actually verify), 'style' (formatting/naming/convention, low stakes), 'performance' (a real, demonstrable inefficiency, not a micro-optimization).
- Severity: 'critical' (a real security hole, or a bug that could let an unauthorized permission be granted, or something that makes the differential-fuzz soundness proof itself unreliable), 'high' (a real bug with real user-facing consequences, or a significant, provable security weakness), 'medium' (a real but narrower/edge-case bug or moderate risk), 'low' (a genuine but minor issue).
- If you find nothing wrong in your area, don't invent a finding just to have something to report — an empty or near-empty findings list for a genuinely clean area is a valid, honest, expected result.
- Be skeptical of your own findings before reporting them: if you're not sure a "bug" actually produces wrong behavior, either verify it (trace the actual code path, or run a real, safe check) before claiming it, or report it as 'improvement'/lower severity with your uncertainty stated plainly in the detail field — never report unconfirmed suspicion as a confident 'bug'/'critical'.`;

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    dimension: { type: 'string' },
    filesReviewed: { type: 'array', items: { type: 'string' } },
    notes: {
      type: 'string',
      description:
        'Anything worth saying that is not itself a finding — e.g. "this area is unusually solid" or "ran out of budget before reaching X".',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: [
              'bug',
              'security',
              'improvement',
              'doc-drift',
              'test-gap',
              'style',
              'performance',
            ],
          },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string', description: 'One sentence, specific.' },
          detail: {
            type: 'string',
            description:
              'The actual problematic code/text quoted, why it is wrong, and the concrete failure scenario.',
          },
          suggested_fix: { type: 'string' },
        },
        required: ['category', 'severity', 'file', 'summary', 'detail'],
      },
    },
  },
  required: ['dimension', 'findings', 'filesReviewed'],
};

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
  required: ['refuted', 'reasoning'],
};

const DIMENSIONS = [
  {
    key: 'schema-dsl',
    prompt: `DIMENSION: Schema DSL — src/schema/dsl/parser.ts, compiler.ts, types.ts, errors.ts; test/unit/schema/*.ts; test/isolation/identifier-and-tuple-validation.fuzz.test.ts.
Focus: grammar correctness (union '|' / intersection '&' / exclusion '-' precedence and associativity, parenthesized grouping); identifier validation (IDENTIFIER_PATTERN, MAX_IDENTIFIER_LENGTH, RESERVED_WORDS — check every place a name is declared actually goes through validateIdentifier); permission-to-permission cycle detection (does it correctly exclude tupleToUserset edges from the cycle graph as documented, does it correctly catch a mix of live and dead branches); tuple-to-userset target-namespace strictness vs. a plain relation subject-type's soft check (D-012) — is the asymmetry actually implemented as documented; error messages (do they name the exact line/construct as build spec §9 Phase 1's exit criterion requires); whether the compiled NamespaceConfig output is deterministic and JSON-safe (no undefined fields, no functions); edge cases: empty schema, a namespace with zero relations, a relation referencing itself, deeply nested parenthesization, unicode in identifiers (should be rejected — is it?).`,
  },
  {
    key: 'tuple-store',
    prompt: `DIMENSION: Tuple store — src/store/tuples.ts, tokens.ts, client.ts, migrate.ts; src/store/migrations/*.sql; test/unit/store/*.
Focus: SQL parameterization everywhere (grep for any template-literal SQL that interpolates a variable directly into the query text rather than using a $N placeholder — this is the single most security-critical thing to check in this file); the relation_tuples unique index using coalesce(subject_relation,'') — confirm the migration SQL actually matches this reasoning and that '' can never collide with a real identifier; write_log.token as a generated column equal to id (D-014) — confirm the migration actually defines it this way and nothing else writes to write_log outside the pattern this implies; idempotency of writeTuple/deleteTuple (on conflict do nothing, still logs to write_log, still advances token) — read the actual SQL and confirm this is exactly what it does; schema-validation-before-write correctness (undeclared_relation, relation_is_a_permission, subject_type_not_allowed, no_published_schema) — does every TupleError code actually get triggered by the code path it claims to; migration file ordering and whether re-running migrate.ts is safe (idempotent) against an already-migrated database; connection/pool handling for leaks (every client.connect() paired with a release() in a finally, every transaction properly BEGIN/COMMIT/ROLLBACK'd).`,
  },
  {
    key: 'reference-resolver',
    prompt: `DIMENSION: Reference resolver (the differential-fuzzing oracle) — src/resolve/reference/resolver.ts; test/unit/resolve/reference-resolver.*.test.ts.
Focus: this file's entire reason for existing is being an INDEPENDENT, obviously-correct oracle (D-005) — confirm directly, by reading imports, that it shares zero code with src/resolve/production/resolver.ts (no shared traversal function, no shared rewrite-rule evaluator); correctness of each rewrite-rule kind's evaluation (union/intersection/exclusion/tuple-to-userset) against the compiled schema shape in src/schema/dsl/types.ts; cycle detection (visited (namespace,id,relation) triples per branch) — does it actually terminate on every cyclic shape, not just the ones tests happen to cover; depth budget enforcement independent of cycle detection (a deep-but-acyclic chain should still terminate); purity — confirm it's genuinely pure/sync/no I/O as its own design requires (any accidental async, any accidental Postgres import would be a serious violation of its whole purpose).`,
  },
  {
    key: 'production-resolver',
    prompt: `DIMENSION: Production check engine — everything under src/resolve/production/ (resolver.ts and any sibling files — Glob to find them all, the build spec also names cache.ts/cycles.ts as possible files here, confirm what actually exists); test/unit/resolve/production/*.ts.
Focus: SQL correctness for the recursive graph walk (parameterization — same scrutiny as tuple-store; correct handling of subject_relation for tuple-to-userset joins); cycle detection semantics matching the reference resolver's own (would the two resolvers actually agree on a cyclic case, structurally, not just by coincidence); CHECK_MAX_DEPTH enforcement — is it actually read from env and actually enforced as a hard ceiling independent of cycle detection; consistency-token pinning (§6.3) — read the actual query/transaction logic for a pinned check and confirm it genuinely can never return a result that ignores a write with token <= the pinned value, not just that it looks like it tries to; if CHECK_CACHE_TTL_MS is nonzero anywhere in this codebase's default/tests, confirm cache invalidation-on-write is real and not just aspirational (§6.6 says this must hold or the default must stay 0 — check env.ts's actual default); resolution-path structural accuracy — does every ResolutionStep variant (union/intersection/exclusion/tupleToUserset/usersetMembership/directGrant) correctly reflect what the SQL actually walked, not a reconstruction that could diverge from the real query.`,
  },
  {
    key: 'soundness-harness',
    prompt: `DIMENSION: Differential-soundness fuzz harness — src/soundness/generators.ts, classify.ts, runner.ts; test/isolation/differential-soundness.fuzz.test.ts; test/unit/soundness/dry-run-cleanup.integration.test.ts.
Focus: generator coverage — does generateFixture genuinely exercise every rewrite-rule kind and at least one guaranteed cycle on every single call, as build spec §9 Phase 5 requires, or could some random seeds produce a fixture that skips a rewrite-rule kind entirely (read the actual generation logic, don't just trust a comment claiming this); classify.ts's false_grant/false_deny asymmetric-verdict logic (§6.5) — confirm a false_grant on a namespace flagged critical always fails the run regardless of aggregate rate, read the actual computeVerdict logic; the new dryRun cleanup in runner.ts (added recently, D-063) — re-read cleanupDryRunArtifacts and the try/catch structure around it with fresh, skeptical eyes: could cleanup ever leave the database in a WORSE state than not cleaning up at all (e.g. a partial delete that breaks a foreign-key-like invariant elsewhere)? Does the error-masking logic (never let a cleanup failure replace a real run failure) actually hold in every code path, including the success-path cleanup call inside the try block (trace exactly what happens if THAT one throws)? The new deletePublishedNamespaceVersion in src/schema/publish.ts — is it truly reachable only from runner.ts's dry-run cleanup, or could it be called from anywhere else in a way that would make its narrow-scope justification untrue?`,
  },
  {
    key: 'audit-trail',
    prompt: `DIMENSION: Audit trail — src/audit/checks.ts, src/audit/expand.ts; test/unit/audit/*.ts.
Focus: resolution-path logging (§6.7) — is every check, allowed or denied, actually persisted to the checks table, and does an allowed check's logged resolution_path genuinely match what productionCheck itself returned (not a lossy or reconstructed approximation); expand() correctness — does it return the complete subject tree for an object#relation including every tuple-to-userset member, and does it correctly terminate on a cyclic group-nesting case rather than looping forever or silently truncating; depth field accuracy — does checks.depth reflect the actual recursion depth reached, not just the configured ceiling (this was explicitly a named test somewhere in this repo — find it and confirm it's not just asserting a trivial case).`,
  },
  {
    key: 'report-ci',
    prompt: `DIMENSION: Report + CI surface — src/report/markdown.ts, json.ts, exitCodes.ts, prComment.ts; .github/workflows/ci.yml, .github/workflows/soundness.yml; scripts/post-soundness-comment.mjs, scripts/copy-migrations.mjs.
Focus: exit code mapping (§7's table: 0 sound, 1 unsound, 2 insufficient_coverage/malformed args/generator bug, 3 infra failure) — confirm src/report/exitCodes.ts actually implements exactly this table with no gaps or off-by-ones; markdown/json report accuracy against the real SoundnessRunResult shape (does every field the report claims to show actually exist and get populated correctly, especially divergences with their resolution paths); CI workflow security — read ci.yml and soundness.yml for anything that interpolates untrusted PR-controlled input (PR title, branch name, commit message) directly into a shell step rather than through an env var (a classic GitHub Actions injection vector), and confirm secrets (GITHUB_TOKEN, any other) are scoped minimally; whether soundness.yml's ephemeral per-job Postgres (D-045) is genuinely isolated — could two concurrent PR runs ever share state; scripts/post-soundness-comment.mjs's own handling of the PR number (there's a documented fix for validating pull_request.number before use — confirm it's actually still there and correct).`,
  },
  {
    key: 'api-surface',
    prompt: `DIMENSION: API surface — src/api/server.ts, auth.ts, errors.ts, responses.ts; test/unit/api/*.ts.
Focus: auth correctness — confirm ADMIN_API_KEY comparison actually uses crypto.timingSafeEqual (not ===) and that an unconfigured key fails every write closed, never open (D-050); rate limiting — read the actual @fastify/rate-limit configuration and confirm the per-route overrides (health vs. write routes) are what they're documented to be, and think adversarially about bypass vectors (spoofed X-Forwarded-For, a route not covered by any limiter); error envelope consistency — does every route, including one that fails before reaching any of report-designer's own constructors (e.g. malformed JSON body), still return the same ApiErrorBody shape; input validation completeness — walk every route's Zod schema and check for a field that's accepted but never actually validated (type coercion gaps, missing length/format checks that the CLI's own validateIdentifiers would catch but the API might skip); whether GET /health leaks anything beyond namespace names/versions that D-051 didn't intend to expose.`,
  },
  {
    key: 'cli-surface',
    prompt: `DIMENSION: CLI — src/cli/index.ts, src/cli/commands/*.ts.
Focus: argument parsing correctness (every --flag's validation matches what its own command's doc comment claims); exit code consistency with each command's own documented table (schema/tuple/check/expand have one exit-code shape, soundness run has a different one per §7 — confirm neither leaks into the other by mistake); whether every command handles DATABASE_URL-unset and DB-unreachable gracefully with the right exit code, not an uncaught stack trace; --dry-run flag correctness on soundness run (recently added) — does it default correctly when omitted vs explicitly false, does the --format markdown/json output genuinely stay untouched by the dry-run note (grep printText and confirm the note only appears in the text-format branch); consistency between what the CLI's tuple write/check commands accept and what the API's equivalent routes accept for the same operation — any drift would mean the two surfaces disagree about what's valid.`,
  },
  {
    key: 'schema-publish-and-demo',
    prompt: `DIMENSION: Schema publishing + demo data — src/schema/publish.ts; schema/*.authz (all of them: document.authz, folder.authz, group.authz, org.authz, malformed-example.authz, example.authz); scripts/seed-example.ts.
Focus: publishSchema's transaction correctness — confirm a multi-namespace source file really does publish all-or-nothing (one BEGIN/COMMIT/ROLLBACK spanning every namespace in the call, not per-namespace); the new deletePublishedNamespaceVersion — confirm its own doc comment's scoping claim is actually true structurally (search the whole repo for every call site, confirm there is exactly one, in runner.ts); getLatestNamespaceConfig and listLatestNamespaceVersions correctness (do they really return the highest version per namespace, deterministically ordered); whether schema/example.authz and scripts/seed-example.ts's TUPLES array are still internally consistent with each other and with what README.md/docs/RELATIONS.md claim about the demo graph (the dana chain, the mallory exclusion, the carol/erin intersection) — read all three and cross-check by hand, don't just trust that they were consistent when last touched.`,
  },
  {
    key: 'docs-accuracy',
    prompt: `DIMENSION: Documentation accuracy — README.md; docs/RELATIONS.md, CONSISTENCY.md, DELIVERY.md, DECISIONS.md, github-governance.md; docs/screens/*.html and docs/screens/README.md.
Focus: does every command shown in README.md's "Try it yourself" section match a real, currently-existing CLI command with the exact flags shown; any stale reference anywhere to a removed/renamed file, function, or namespace; whether every docs/DECISIONS.md entry whose own "Revisit if" condition has plainly already occurred is actually marked resolved/updated (this exact class of gap was found and fixed once already for D-060 — check whether any OTHER entry has a "Revisit if" that, reading the rest of the codebase, has quietly already fired without the entry being updated); whether the CLI/API reference table in README.md is complete against the real CLI command list (one gap — a missing 'authz doctor' row — was already found and fixed; check there isn't a second gap of the same kind, and cross-check the API route list too); whether docs/screens/*.html's claimed real data (tuple counts, resolution paths, seeds) still matches what's in schema/example.authz and scripts/seed-example.ts today.`,
  },
  {
    key: 'test-coverage-and-quality',
    prompt: `DIMENSION: Test suite coverage and quality — test/isolation/*.ts and test/unit/**/*.ts (Glob broadly, this is a wide sweep across every test file in the repo).
Focus: confirm there are genuinely zero live 'it.todo(' calls anywhere (grep for the literal pattern, distinguish real skipped tests from prose in comments that merely mentions '.todo()' historically); tests with weak assertions — anything that only checks '.ok === true' or a boolean without checking the actual returned data shape, especially for a security-relevant claim (a check result, a resolution path, an error code); any test whose own name/describe-block claims to test something its body doesn't actually exercise (read a sample of test names against their bodies, don't just trust the names); missing negative-case coverage for any critical path (does every 'allowed' assertion have a sibling 'denied' case nearby, does every happy-path have an error-path sibling); whether every '*.integration.test.ts' file correctly uses PostgreSqlContainer with no hardcoded local connection string accidentally left in from a LOCALVERIFY-style debugging session (grep for '127.0.0.1' or 'authz_dev_password' across test/ — a leftover hardcoded local credential in a COMMITTED test file would be a real, if minor, finding).`,
  },
  {
    key: 'config-and-env',
    prompt: `DIMENSION: Configuration and environment — src/config/env.ts; .env.example; package.json; package-lock.json; tsconfig.json; tsconfig.build.json; eslint.config.js; vitest.config.ts; vitest.integration.config.ts.
Focus: env schema completeness — grep 'process.env' and 'env\\.' usage across all of src/ and confirm every env var actually used has a corresponding zod schema field in env.ts with a sensible default or explicit required-ness, and that .env.example lists every one of them; dependency list accuracy — any package imported in src/ or test/ that isn't declared in package.json (would break a clean install), or any declared dependency that's never actually imported anywhere (dead weight); tsconfig rootDir/include correctness — this exact class of bug (test/ files leaking into dist/ output, breaking the bin entry) was already found and fixed once (D-009) — confirm it hasn't regressed, and confirm tsconfig.build.json's own include is still scoped to exactly src/**/*.ts; eslint.config.js coverage — does it actually lint every real file type in the repo (.ts, .mjs, .js in scripts/) or does something silently fall through a gap; any version pin in package.json that looks suspiciously outdated or inconsistent with what's actually used (e.g. a major-version mismatch between a declared range and an API only available in a newer version).`,
  },
  {
    key: 'security-crosscut',
    prompt: `DIMENSION: Security, cross-cutting — read across src/api/auth.ts, src/store/tuples.ts, src/schema/publish.ts, src/resolve/production/, .github/workflows/*.yml, package.json.
Focus (adversarial mindset — "how would I actually break authorization or leak data here", not a generic checklist pass): SQL injection — grep the ENTIRE src/ tree for any SQL string built via template-literal interpolation of a variable (backtick strings containing \${...} immediately followed by SQL-looking text) rather than a $N parameter placeholder, across every file, not just the ones other dimensions already cover, since this is the single highest-value thing an authorization system's own security review can catch; ReDoS — every regex in the codebase (IDENTIFIER_PATTERN and anything in parser.ts's tokenizer especially) checked for catastrophic backtracking potential on an adversarial input; timing side channels beyond the already-fixed ADMIN_API_KEY comparison — any OTHER place a secret or identity check uses '===' or '.includes()' on sensitive data; dependency vulnerabilities — read package.json's real dependency versions and flag anything you have specific, concrete knowledge is affected by a known CVE (don't speculate vaguely, only report if you actually know a specific issue); rate-limit bypass vectors (already covered partially by api-surface, but specifically here: could a caller with a valid ADMIN_API_KEY exhaust resources some other way, e.g. an unbounded --queries value on soundness run, or an unbounded tuple write batch); whether the consistency-token model has any real staleness-window exploit (a check that claims to be pinned but isn't actually gated on the token in the WHERE clause it should be).`,
  },
];

phase('Review');
log(`Starting full-repo audit — ${DIMENSIONS.length} parallel review dimensions.`);

async function verifyFinding(finding, dimensionKey) {
  const skipCategories = new Set(['style']);
  if (skipCategories.has(finding.category) || finding.severity === 'low') {
    return { ...finding, verification: 'not-verified (low stakes — style or low severity)' };
  }
  const skepticCount = finding.severity === 'critical' || finding.severity === 'high' ? 2 : 1;

  const prompt = `${SHARED_CONTEXT}

You are adversarially verifying ONE specific finding from a code review of this repo. Your job is to try to REFUTE it — find a reason it's wrong, already handled elsewhere, not actually reachable, based on a misreading, or not actually a problem in practice. Read the actual file(s) yourself and confirm or refute independently — do not just trust the finding's own description. Default to refuted:true if you cannot personally confirm the problem is real by reading the actual code.

FINDING TO VERIFY:
Dimension: ${dimensionKey}
Category: ${finding.category}
Severity: ${finding.severity}
File: ${finding.file}${finding.line ? ':' + finding.line : ''}
Summary: ${finding.summary}
Detail: ${finding.detail}
${finding.suggested_fix ? 'Suggested fix: ' + finding.suggested_fix : ''}`;

  const votes = await parallel(
    Array.from(
      { length: skepticCount },
      () => () =>
        agent(prompt, {
          label: `verify:${dimensionKey}`,
          phase: 'Verify',
          effort: 'high',
          schema: VERDICT_SCHEMA,
        }),
    ),
  );
  const validVotes = votes.filter(Boolean);
  if (validVotes.length === 0) {
    return { ...finding, verification: 'not-verified (verifier agents failed to return)' };
  }
  const refutedCount = validVotes.filter((v) => v.refuted).length;
  // Conservative: only drop confidence on UNANIMOUS refutation, so a finding
  // never silently disappears on a single skeptic's disagreement — the final
  // report still shows refuted findings, just clearly marked.
  const survived = refutedCount < validVotes.length;
  return {
    ...finding,
    verification: survived
      ? `verified (${validVotes.length - refutedCount}/${validVotes.length} skeptics confirmed)`
      : `REFUTED (${refutedCount}/${validVotes.length} skeptics refuted it)`,
    verdictDetails: validVotes.map((v) => v.reasoning),
  };
}

const dimensionResults = await pipeline(
  DIMENSIONS,
  (d) =>
    agent(SHARED_CONTEXT + '\n\n' + d.prompt, {
      label: `review:${d.key}`,
      phase: 'Review',
      schema: FINDINGS_SCHEMA,
    }),
  async (reviewResult, d) => {
    if (!reviewResult) {
      log(`${d.key}: review agent did not return a result.`);
      return {
        dimension: d.key,
        findings: [],
        filesReviewed: [],
        notes: 'review agent failed to return a result',
      };
    }
    const rawFindings = reviewResult.findings ?? [];
    log(`${d.key}: ${rawFindings.length} raw finding(s) — verifying...`);
    const verifiedFindings = await Promise.all(rawFindings.map((f) => verifyFinding(f, d.key)));
    const survivedCount = verifiedFindings.filter(
      (f) => !String(f.verification).startsWith('REFUTED'),
    ).length;
    log(`${d.key}: ${survivedCount}/${rawFindings.length} finding(s) survived verification.`);
    return {
      dimension: d.key,
      filesReviewed: reviewResult.filesReviewed ?? [],
      notes: reviewResult.notes ?? '',
      findings: verifiedFindings,
    };
  },
);

phase('Synthesize');
log('All dimensions reviewed and verified — synthesizing the final report.');

const allFindings = dimensionResults
  .filter(Boolean)
  .flatMap((r) => r.findings.map((f) => ({ ...f, dimension: r.dimension })));

const stats = {
  totalFindings: allFindings.length,
  byCategory: {},
  bySeverity: {},
  refutedCount: 0,
};
for (const f of allFindings) {
  stats.byCategory[f.category] = (stats.byCategory[f.category] || 0) + 1;
  stats.bySeverity[f.severity] = (stats.bySeverity[f.severity] || 0) + 1;
  if (String(f.verification).startsWith('REFUTED')) stats.refutedCount += 1;
}

const synthesisPrompt = `${SHARED_CONTEXT}

You are writing the FINAL, polished audit report from ${allFindings.length} findings already gathered across 14 independent review dimensions of this codebase and already adversarially verified (each bug/security/test-gap/doc-drift/improvement/performance finding above 'low' severity was independently challenged by 1-2 skeptic agents who tried to refute it).

Your job:
1. Deduplicate: if two or more findings from different dimensions describe the same underlying issue, merge them into one entry and note that multiple dimensions independently found it (a stronger signal — say so explicitly).
2. For findings marked REFUTED: drop them from the main report UNLESS, after reading the finding and the refutation reasoning yourself, you think the refutation is itself wrong — if so, keep the finding but say explicitly why you're overriding the skeptics. Otherwise, list refuted findings only in a short "considered and ruled out" appendix at the end, one line each, so nothing is silently thrown away.
3. Rank surviving findings: critical severity first, then high, then medium, then low — with 'bug'/'security' categories weighted above 'improvement'/'style'/'doc-drift'/'test-gap'/'performance' at the same severity.
4. For each surviving finding: file:line, one-sentence problem statement, why it matters (a concrete failure scenario — who is affected, how, under what conditions — not a vague generality), and a specific suggested fix (use the finding's own suggested_fix if it has one and it's good; otherwise write your own).
5. Write a short executive summary at the very top: overall health assessment of the codebase, a count of real (non-refuted) findings by severity, and — if anything is critical or high — the single most important thing to fix first and why.
6. Output clean GitHub-flavored Markdown, structured so it could be handed directly to a human reviewer or turned into individual GitHub issues.

RAW FINDINGS DATA (JSON):
${JSON.stringify(allFindings, null, 2)}

STATS: ${JSON.stringify(stats, null, 2)}`;

const report = await agent(synthesisPrompt, {
  label: 'synthesize-report',
  phase: 'Synthesize',
  effort: 'high',
});

return { report, allFindings, stats, dimensionResults };
