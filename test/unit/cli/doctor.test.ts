/**
 * Regression test for a real bug: `authz doctor` reporting `Migrations:
 * 0/0 applied` — and exiting 0, `doctor: OK` — on Windows, because
 * `src/cli/commands/doctor.ts` used to compute `MIGRATIONS_DIR` via
 * `new URL('../../store/migrations', import.meta.url).pathname`.
 *
 * A `file://` URL's `.pathname` on a Windows path keeps the leading `/`
 * in front of the drive letter (`file:///C:/Users/...` ->
 * `/C:/Users/...`) — not a valid Windows filesystem path. `existsSync` on
 * that bogus path returns false, and `discoverMigrations` (deliberately
 * lenient about a missing directory — see its own doc comment, for the
 * legitimate case of a fresh clone before Phase 2's first migration ever
 * existed) reports zero total migrations with no error at all. The
 * failure is silent and looks identical to success — no exception, no
 * nonzero exit code, just an empty database nobody can `check` or
 * `expand` against.
 *
 * `src/config/env.ts` already got this right (`fileURLToPath`, not
 * `.pathname`) — this test doesn't re-test `doctor.ts` end to end (that's
 * `doctor: OK` printing correctly on this Linux CI runner, which the fix
 * doesn't change), it pins the actual mechanism of the platform-specific
 * bug directly, since nothing here runs on real Windows to catch a
 * regression the ordinary way. `fileURLToPath`'s `windows` option (Node
 * 20+, this project requires Node >=22 — see `package.json`) forces the
 * Windows code path deterministically on any host, which is what makes
 * this reproducible on Linux CI at all.
 */
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

describe('file:// URL -> filesystem path conversion on Windows', () => {
  const windowsFileUrl = new URL(
    'file:///C:/Users/dev/Relationship-Based-Authorization/dist/cli/commands/doctor.js',
  );

  it('`.pathname` leaves an invalid leading slash before the drive letter — the actual bug', () => {
    expect(windowsFileUrl.pathname).toBe(
      '/C:/Users/dev/Relationship-Based-Authorization/dist/cli/commands/doctor.js',
    );
  });

  it('`fileURLToPath` with the Windows code path forced strips it correctly — the fix', () => {
    expect(fileURLToPath(windowsFileUrl, { windows: true })).toBe(
      'C:\\Users\\dev\\Relationship-Based-Authorization\\dist\\cli\\commands\\doctor.js',
    );
  });
});
