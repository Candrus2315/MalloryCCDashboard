/**
 * db:migrate — standalone, versioned schema migration runner (portability
 * 2026-11-05, PART 1 deliverable 3).
 *
 * WHY: on an independent managed host the owner can (and should) stamp the
 * schema BEFORE first boot instead of letting the first serve request pay for
 * it. The serve path still auto-migrates inside its migration-acceptance
 * gate; this script is the controlled, explicit alternative.
 *
 * GATE CONTRACT (src/server/store/migration-gate.ts): the managed serve
 * context OR AN EXPLICIT GRANT may migrate. This script IS an explicit grant
 * — but only when the operator STATES who authorized it:
 *
 *   bun run db:migrate -- --grant "operator console, 2026-11-05"
 *   DB_MIGRATE_GRANT="operator console" bun run db:migrate
 *
 * Without --grant/DB_MIGRATE_GRANT the script REFUSES with a named error and
 * runs nothing (fail-visible, same posture as the gate). The grantedBy string
 * is recorded verbatim in the boot log ("migrations authorized by: …") and in
 * schema_migrations timing — never in secret material.
 *
 * DATABASE_URL resolves through the centralized secret resolver (env-cased
 * DATABASE_URL/Database_URL), never from argv (a URL in a process listing is
 * a leaked secret). The run uses the small test pool profile and closes it.
 */
import { PgStore } from "../src/server/store/pg";
import { getSecret } from "../src/server/env";
import { MigrationGateError } from "../src/server/store/migrations/runner";

function parseGrant(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--grant") {
      const value = argv[i + 1];
      return value && value.trim().length > 0 ? value.trim() : null;
    }
    const m = argv[i]?.match(/^--grant=(.+)$/);
    if (m) return m[1].trim().length > 0 ? m[1].trim() : null;
  }
  const envGrant = process.env.DB_MIGRATE_GRANT?.trim();
  return envGrant && envGrant.length > 0 ? envGrant : null;
}

async function main(): Promise<number> {
  const grantedBy = parseGrant(process.argv.slice(2));
  if (!grantedBy) {
    throw new MigrationGateError(
      "db:migrate refuses to run without an explicit grant: pass --grant \"<who authorized this migration>\" " +
        "(or set DB_MIGRATE_GRANT). Nothing was executed — migrations are gated exactly like the serve path " +
        "(managed context or explicit grant; see src/server/store/migration-gate.ts).",
    );
  }
  const url = getSecret("DATABASE_URL");
  if (!url) {
    console.error("[db:migrate] DATABASE_URL is not set (or has no readable value) — nothing to migrate.");
    return 1;
  }
  const store = new PgStore(url, {
    profile: "test",
    migrationCapability: { grantedBy: `db:migrate script (${grantedBy})` },
  });
  try {
    console.log(`[db:migrate] running versioned migrations (authorized by: db:migrate script (${grantedBy}))…`);
    await store.ensureSchema();
    console.log("[db:migrate] done — database is at the registry's current version.");
    return 0;
  } finally {
    await store.close();
  }
}

const code = await main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[db:migrate] FAILED: ${msg}`);
  return 1;
});
process.exit(code);
