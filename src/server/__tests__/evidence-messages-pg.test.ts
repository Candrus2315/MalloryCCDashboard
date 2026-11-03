/**
 * REGRESSION (PR #143, owner approved 2026-11-02): upsertEvidenceMessages with
 * N>1 rows through the REAL PgStore path against a real Postgres.
 *
 * The original implementation interpolated a raw JSON.stringify string inside
 * `jsonb_to_recordset($1::jsonb)`. Under postgres.js 3.4.9 that plain-string
 * param binds through the server-described jsonb type and the value reaches
 * the function as a non-array scalar — every tick carrying NEW evidence
 * messages failed with SQLSTATE 22023 "cannot call jsonb_to_recordset on a
 * non-array". The fix binds the chunk with a TYPED json parameter
 * (this.sql.json(chunk), same convention as app_settings).
 *
 * The memory store cannot catch this class of bug (the SQL is never parsed),
 * so this file is deliberately a REAL-database regression probe. It creates a
 * throwaway database, runs the real migration registry through the real
 * migration gate, and drops the database afterwards. It SKIPS when no local
 * Postgres is reachable (e.g. CI without one) — the memory-store behavior is
 * covered by sms-evidence.test.ts.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PgStore } from "../store/pg";
import type { EvidenceMessageRow } from "../store/types";

const LOCAL_URL = process.env.PG_REGRESSION_URL ?? "postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable";
const DB_NAME = `evidence_reg_${Date.now().toString(36)}${process.pid}`;
const STORE_URL = LOCAL_URL.replace(/\/postgres(\?|$)/, `/${DB_NAME}$1`);

const admin = postgres(LOCAL_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
let pgAvailable = false;
try {
  await admin`SELECT 1`;
  pgAvailable = true;
} catch {
  pgAvailable = false;
}
if (!pgAvailable) await admin.end({ timeout: 1 }).catch(() => undefined);

const row = (i: number): EvidenceMessageRow => ({
  message_id: `reg-msg-${i}`,
  conversation_id: i % 2 === 0 ? `reg-conv-${i}` : null,
  contact_external_id: `reg-contact-${i % 3}`,
  message_type: i % 2 === 0 ? "TYPE_SMS" : "TYPE_LIVE_CHAT",
  direction: i % 3 === 0 ? "outbound" : "inbound",
  user_external_id: i % 3 === 0 ? `reg-user-${i}` : null,
  date_added: new Date(Date.parse("2026-10-28T17:00:00Z") + i * 60_000).toISOString(),
  body: i % 4 === 0 ? null : `regression body ${i}`,
});

describe.skipIf(!pgAvailable)("evidence_messages upsert — real-store pg regression (PR #143)", () => {
  let store: PgStore;
  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    store = new PgStore(STORE_URL, {
      migrationCapability: { grantedBy: "test: evidence-messages-pg regression (PR #143)" },
    });
  });

  afterAll(async () => {
    try {
      await store?.close();
    } catch {
      /* already closed */
    }
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    } catch {
      /* best-effort cleanup */
    }
    await admin.end({ timeout: 1 });
  });

  test("upserts N>1 rows through the real store path (jsonb_to_recordset on a JSON ARRAY)", async () => {
    const rows: EvidenceMessageRow[] = [0, 1, 2, 3, 4].map(row);
    const before = (await store.getEvidenceMessagesSince("2026-10-01T00:00:00Z")).length;
    const written = await store.upsertEvidenceMessages(rows);
    expect(written).toBe(rows.length);
    const back = await store.getEvidenceMessagesSince("2026-10-01T00:00:00Z");
    expect(back.length - before).toBe(rows.length);

    // Field round-trip incl. NULL conversation/user/body vs. populated ones.
    const byId = new Map(back.map((r) => [r.message_id, r]));
    const first = byId.get("reg-msg-0");
    expect(first?.message_type).toBe("TYPE_SMS");
    expect(first?.conversation_id).toBe("reg-conv-0");
    expect(first?.body).toBeNull();
    expect(first?.date_added).toBe(rows[0].date_added);
    const second = byId.get("reg-msg-1");
    expect(second?.conversation_id).toBeNull();
    expect(second?.body).toBe("regression body 1");
    expect(second?.direction).toBe("inbound");
  });

  test("replay is idempotent — ON CONFLICT (message_id) DO NOTHING keeps exactly N rows", async () => {
    const rows: EvidenceMessageRow[] = [0, 1, 2, 3, 4].map(row);
    await store.upsertEvidenceMessages(rows);
    const afterFirst = (await store.getEvidenceMessagesSince("2026-10-01T00:00:00Z")).filter((r) => r.message_id.startsWith("reg-msg-")).length;
    await store.upsertEvidenceMessages(rows);
    const afterReplay = (await store.getEvidenceMessagesSince("2026-10-01T00:00:00Z")).filter((r) => r.message_id.startsWith("reg-msg-")).length;
    expect(afterFirst).toBe(rows.length);
    expect(afterReplay).toBe(rows.length);
  });

  test("chunked writes across the 500-row chunk boundary (501 rows = 2 statements)", async () => {
    const rows: EvidenceMessageRow[] = Array.from({ length: 501 }, (_, i) => row(i));
    const written = await store.upsertEvidenceMessages(rows);
    expect(written).toBe(501);
    const stored = (await store.getEvidenceMessagesSince("2026-10-01T00:00:00Z")).filter((r) => r.message_id.startsWith("reg-msg-")).length;
    expect(stored).toBe(501);
  });
});
