/**
 * AUDIT endpoint tests — ET day-boundary handling, rep/date filtering, the
 * over-threshold flag (live threshold rule), and the Reps-page Unassigned
 * rollup. The store-level tests run against MemoryStore (same getAuditCalls
 * semantics as PgStore — see its mirror-of-PG comment); the endpoint's date /
 * rep resolution is pure and tested directly.
 */
import { describe, expect, test } from "bun:test";
import {
  auditRowView,
  handleAuditQuery,
  resolveAuditDayBounds,
  resolveAuditRepFilter,
  type AuditUserRef,
} from "../audit-api";
import { buildUnassignedRollup } from "../../components/reps-views";
import { MemoryStore } from "../store/memory";
import type { UserRow } from "../store/types";

// Sep 2026 = EDT (UTC-4): ET midnight = 04:00Z. 2026-09-25 is a Friday.
const user = (id: string, externalId: string, name: string, isActive: boolean): UserRow => ({
  id,
  provider: "highlevel",
  external_id: externalId,
  name,
  email: `${externalId}@example.com`,
  is_active: isActive,
});
const call = (
  extId: string,
  repId: string | null,
  startedAt: string,
  dur: number,
  extra: { conversation_id?: string | null; provider_rep_external_id?: string | null; direction?: string | null } = {},
) => ({
  id: `c-${extId}`,
  rep_id: repId,
  contact_id: null,
  started_at: startedAt,
  duration_seconds: dur,
  over_two_minutes: dur > 120,
  external_call_id: extId,
  provider: "highlevel",
  ...extra,
});

describe("resolveAuditDayBounds (ET day boundaries — centralized helpers, never server TZ)", () => {
  test("ET midnight is 04:00Z in September (EDT)", () => {
    const r = resolveAuditDayBounds("2026-09-25", "2026-09-25");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.startUtc).toBe("2026-09-25T04:00:00.000Z");
      expect(r.endUtc).toBe("2026-09-26T04:00:00.000Z");
    }
  });
  test("ET midnight is 05:00Z in January (EST) — DST survives", () => {
    const r = resolveAuditDayBounds("2026-01-15", "2026-01-15");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.startUtc).toBe("2026-01-15T05:00:00.000Z");
      expect(r.endUtc).toBe("2026-01-16T05:00:00.000Z");
    }
  });
  test("null/empty date → today; future date → note, not an error", () => {
    const r = resolveAuditDayBounds(null, "2026-09-25");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.date).toBe("2026-09-25");
      expect(r.note).toBeNull();
    }
    const f = resolveAuditDayBounds("2026-12-01", "2026-09-25");
    expect(f.ok).toBe(true);
    if (f.ok) expect(f.note).toContain("future ET date");
  });
  test("invalid date → 400-style error", () => {
    expect(resolveAuditDayBounds("09/25/2026", "2026-09-25").ok).toBe(false);
    expect(resolveAuditDayBounds("2026-9-25", "2026-09-25").ok).toBe(false);
    expect(resolveAuditDayBounds("not-a-date", "2026-09-25").ok).toBe(false);
  });
});

describe("resolveAuditRepFilter", () => {
  const users: AuditUserRef[] = [
    { id: "u1", name: "Allison Wittner", is_active: true },
    { id: "u2", name: "Christy West", is_active: false },
  ];
  test("null/empty/'all' → every call", () => {
    expect(resolveAuditRepFilter(null, users)).toEqual({ ok: true, spec: null, label: expect.stringContaining("All calls") });
    expect(resolveAuditRepFilter("", users).ok).toBe(true);
    expect(resolveAuditRepFilter("all", users).ok).toBe(true);
  });
  test("'unassigned' → non-roster spec with explicit label", () => {
    const r = resolveAuditRepFilter("unassigned", users);
    expect(r).toEqual({ ok: true, spec: "unassigned", label: expect.stringContaining("non-roster") });
  });
  test("a known user id → that user (roster or not); unknown id → error", () => {
    expect(resolveAuditRepFilter("u2", users)).toEqual({ ok: true, spec: "u2", label: expect.stringContaining("Christy") });
    expect(resolveAuditRepFilter("u1", users).ok).toBe(true);
    expect(resolveAuditRepFilter("nope", users).ok).toBe(false);
  });
});

describe("MemoryStore.getAuditCalls (same semantics as PgStore)", () => {
  async function seed() {
    const s = new MemoryStore();
    await s.upsertUsers([user("x", "ext-allison", "Allison Wittner", true), user("y", "ext-christy", "Christy West", false)]);
    // internal ids are store-generated — resolve them from the external ids
    const stored = await s.getAllUsers();
    const allisonId = stored.find((u) => u.external_id === "ext-allison")!.id;
    const christyId = stored.find((u) => u.external_id === "ext-christy")!.id;
    await s.upsertCalls([
      // 9/24 ET (before the 04:00Z boundary), roster rep, 121s
      call("msg-a", allisonId, "2026-09-25T03:59:59.000Z", 121),
      // 9/25 ET 00:00 ET exactly — the boundary instant belongs to 9/25
      call("msg-b", allisonId, "2026-09-25T04:00:00.000Z", 120),
      // 9/25 ET, non-roster user (held unassigned), 180s
      call("msg-c", christyId, "2026-09-25T14:30:00.000Z", 180, { conversation_id: "conv-1", provider_rep_external_id: "ext-christy", direction: "outbound" }),
      // 9/25 ET, no user at all — unassigned
      call("msg-d", null, "2026-09-25T23:10:00.000Z", 30, { provider_rep_external_id: null }),
      // 9/26 ET — outside the 9/25 day
      call("msg-e", allisonId, "2026-09-26T05:00:00.000Z", 200),
    ]);
    return { s, allisonId, christyId };
  }

  test("ET day boundary: 03:59:59Z is the previous ET day, 04:00:00Z is in-day", async () => {
    const { s } = await seed();
    const rows = await s.getAuditCalls("2026-09-25T04:00:00.000Z", "2026-09-26T04:00:00.000Z", null, 120);
    const ids = rows.map((r) => r.external_call_id);
    expect(ids).not.toContain("msg-a"); // 9/24 ET
    expect(ids).not.toContain("msg-e"); // 9/26 ET
    expect(ids).toEqual(["msg-d", "msg-c", "msg-b"]); // newest first
  });

  test("over-threshold uses the PASSED threshold, like summarizeCalls", async () => {
    const { s } = await seed();
    const rows120 = await s.getAuditCalls("2026-09-25T04:00:00.000Z", "2026-09-26T04:00:00.000Z", null, 120);
    const byId = new Map(rows120.map((r) => [r.external_call_id, r]));
    expect(byId.get("msg-b")!.over_threshold).toBe(false); // exactly 120s is not over 120
    expect(byId.get("msg-c")!.over_threshold).toBe(true);
    const rows60 = await s.getAuditCalls("2026-09-25T04:00:00.000Z", "2026-09-26T04:00:00.000Z", null, 60);
    expect(new Map(rows60.map((r) => [r.external_call_id, r])).get("msg-b")!.over_threshold).toBe(true);
  });

  test("rep filtering: roster rep / unassigned (complement of the roster set) / unknown id", async () => {
    const { s, allisonId } = await seed();
    const allison = await s.getAuditCalls("2026-09-25T04:00:00.000Z", "2026-09-26T04:00:00.000Z", allisonId, 120);
    expect(allison.map((r) => r.external_call_id)).toEqual(["msg-b"]);
    expect(allison[0].rep_name).toBe("Allison Wittner");
    expect(allison[0].rep_is_active).toBe(true);

    const unassigned = await s.getAuditCalls("2026-09-25T04:00:00.000Z", "2026-09-26T04:00:00.000Z", "unassigned", 120);
    // msg-c (non-roster user) + msg-d (no user) — NOT msg-b (roster) — exact
    // complement of keepRosterRepCalls' kept set
    expect(unassigned.map((r) => r.external_call_id).sort()).toEqual(["msg-c", "msg-d"]);
    expect(unassigned.find((r) => r.external_call_id === "msg-c")!.rep_name).toBe("Christy West");
    expect(unassigned.find((r) => r.external_call_id === "msg-d")!.rep_id).toBeNull();

    const none = await s.getAuditCalls("2026-09-25T04:00:00.000Z", "2026-09-26T04:00:00.000Z", "user-does-not-exist", 120);
    expect(none).toEqual([]);
  });

  test("rows carry the raw ids the audit table shows (HL message id, conversation, HL user id)", async () => {
    const { s } = await seed();
    const rows = await s.getAuditCalls("2026-09-25T04:00:00.000Z", "2026-09-26T04:00:00.000Z", null, 120);
    const c = rows.find((r) => r.external_call_id === "msg-c")!;
    expect(c.conversation_id).toBe("conv-1");
    expect(c.provider_rep_external_id).toBe("ext-christy");
    expect(c.direction).toBe("outbound");
    expect(c.duration_seconds).toBe(180);
  });

  test("auditRowView stamps the ET calendar date + ET clock time", () => {
    const v = auditRowView({
      external_call_id: "x",
      conversation_id: null,
      rep_id: null,
      rep_name: null,
      rep_is_active: null,
      provider_rep_external_id: null,
      contact_id: null,
      contact_name: null,
      contact_external_id: null,
      direction: null,
      call_status: null,
      started_at: "2026-09-25T04:00:00.000Z",
      duration_seconds: 120,
      over_threshold: false,
    });
    expect(v.et_date).toBe("2026-09-25");
    expect(v.started_at_et).toBe("00:00:00");
  });
});

describe("buildUnassignedRollup (Reps page Unassigned section)", () => {
  const calls = [
    { rep_id: "u1", duration_seconds: 121 },
    { rep_id: "u2", duration_seconds: 180 },
    { rep_id: "u2", duration_seconds: 60 },
    { rep_id: null, duration_seconds: 150 },
    { rep_id: "u3", duration_seconds: 130 }, // active? u3 NOT in activeRepIds → unassigned, unknown name
  ];
  const activeRepIds = new Set(["u1"]);
  const userById = new Map([
    ["u1", { name: "Allison Wittner", external_id: "ext-a" }],
    ["u2", { name: "Christy West", external_id: "ext-c" }],
    ["u3", { name: "Ghost User", external_id: "ext-g" }],
  ]);

  test("unassigned = every call NOT kept by keepRosterRepCalls; roster rep excluded", () => {
    const r = buildUnassignedRollup({ calls, activeRepIds, userById, thresholdSeconds: 120 });
    expect(r.totalCalls).toBe(4); // u2×2 + null + u3
    expect(r.totalOverThreshold).toBe(3); // 180, 150, 130 (60s under)
    const names = r.users.map((u) => u.name ?? u.key);
    // sorted by calls desc; ties broken by key ("(no user)" < "Ghost User")
    expect(names).toEqual(["Christy West", "(no user)", "Ghost User"]);
    expect(r.users[0]).toMatchObject({ externalId: "ext-c", calls: 2, overThreshold: 1 });
    expect(r.users[1]).toMatchObject({ key: "(no user)", name: null, externalId: null, calls: 1, overThreshold: 1 });
    expect(r.users[2]).toMatchObject({ key: "ext-g", name: "Ghost User", calls: 1, overThreshold: 1 });
  });
});

describe("handleAuditQuery (orchestration — 400s + response shape)", () => {
  test("rejects bad dates and unknown reps with 400 before any row read", async () => {
    const bad = await handleAuditQuery({ rep: "all", date: "oops" });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: expect.stringContaining("Invalid date") });
    const badRep = await handleAuditQuery({ rep: "who-is-this", date: "2026-09-25" });
    expect(badRep.status).toBe(400);
    expect(badRep.body).toEqual({ error: expect.stringContaining("Unknown rep") });
  });

  test("happy path returns the audit envelope with ET bounds + live threshold", async () => {
    const ok = await handleAuditQuery({ rep: "all", date: "2026-09-25" });
    expect(ok.status).toBe(200);
    if (ok.status === 200) {
      expect(ok.body.timezone).toBe("America/New_York");
      expect(ok.body.threshold_seconds).toBe(120); // default settings in this environment
      expect(ok.body.range.startUtc).toBe("2026-09-25T04:00:00.000Z");
      expect(ok.body.range.endUtc).toBe("2026-09-26T04:00:00.000Z");
      expect(ok.body.rep).toBe("all");
      expect(Array.isArray(ok.body.rows)).toBe(true);
      // every row carries the audit view fields (ids visible)
      for (const r of ok.body.rows) {
        expect(typeof r.external_call_id).toBe("string");
        expect(typeof r.et_date).toBe("string");
      }
    }
  });
});
