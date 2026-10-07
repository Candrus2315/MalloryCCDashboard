/**
 * Phase 9 tests: settings persistence, week goal + team-share fallback,
 * manual-override audit trail, server-side passphrase gate, and sync_runs
 * recording on SYNC NOW. Store-backed tests use MemoryStore directly —
 * NEVER getStore(), which would touch the live Postgres from tests.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import {
  createSessionToken,
  isPassphraseConfigured,
  readSessionCookie,
  resolveGate,
  safeRedirectTarget,
  verifySessionToken,
  SESSION_COOKIE,
} from "../auth";
import { runDemoSync } from "../sync/run";
import { applySheetMapping, columnLetterToIndex, sampleSheetRow } from "../sync/adapters";
import { leadsToday, leadsForWeek, materializeRecurringBlocks } from "../metrics/compute";
import { buildNonRosterPanel } from "../roster";
import { rosterPanelVisibleRows } from "../../components/settings-views";

const PASSPHRASE = "test-pass-1234";
const ORIGIN = "https://dashboard.example.com";

function req(path: string, opts: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, opts);
}

async function withPassphrase<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.DASHBOARD_PASSPHRASE;
  process.env.DASHBOARD_PASSPHRASE = PASSPHRASE;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DASHBOARD_PASSPHRASE;
    else process.env.DASHBOARD_PASSPHRASE = prev;
  }
}

describe("settings persistence round-trip (MemoryStore)", () => {
  test("save then get returns the same settings, including nested groups", async () => {
    const store = new MemoryStore();
    const saved = await store.saveSettings({
      meaningful_call_threshold_seconds: 90,
      attribution_window_hours: 36,
      studio: {
        appointment_duration_min: 45,
        slot_interval_min: 30,
        padding_min: 10,
        recurring_blocks: [{ id: "rb1", weekday: 5, start_time: "12:00", end_time: "13:00", reason: "lunch", active: true }],
        hours: [{ weekday: 1, open_time: "09:00", close_time: "17:00", active: true }],
      },
      sheets: { family: { sheet_id: "abc", mode: "row_per_lead", columns: { source_date: "C", name: "A", phone: "D", email: "E", lead_type: "B" } }, animalia: { sheet_id: "def", mode: "row_per_lead", columns: { source_date: "A", name: "B", phone: "C", email: "D", lead_type: "E" } } },
      acuity: { calendars_included: ["Family Studio"], types_included: ["Family Mini Session"] },
    });
    expect(saved.meaningful_call_threshold_seconds).toBe(90);
    expect(saved.studio.recurring_blocks).toHaveLength(1);
    const got = await store.getSettings();
    expect(got.meaningful_call_threshold_seconds).toBe(90);
    expect(got.attribution_window_hours).toBe(36);
    expect(got.studio.appointment_duration_min).toBe(45);
    expect(got.studio.recurring_blocks[0].weekday).toBe(5);
    expect(got.sheets.family.columns.source_date).toBe("C");
    expect(got.sheets.animalia.columns.name).toBe("B");
    expect(got.acuity.calendars_included).toEqual(["Family Studio"]);
  });

  test("partial patch preserves unspecified nested fields", async () => {
    const store = new MemoryStore();
    await store.saveSettings({ studio: { appointment_duration_min: 30, slot_interval_min: 60, padding_min: 5, recurring_blocks: [], hours: [] } });
    await store.saveSettings({ attribution_window_hours: 48 });
    const got = await store.getSettings();
    expect(got.studio.appointment_duration_min).toBe(30);
    expect(got.attribution_window_hours).toBe(48);
  });
});

describe("week goals + team-share fallback", () => {
  test("upsertTeamGoal persists per week; getTeamGoals lists all ordered", async () => {
    const store = new MemoryStore();
    await store.upsertTeamGoal({ week_start: "2026-10-05", booking_goal: 85, lead_budget: 650 });
    await store.upsertTeamGoal({ week_start: "2026-09-28", booking_goal: 79, lead_budget: 700 });
    await store.upsertTeamGoal({ week_start: "2026-10-05", booking_goal: 90, lead_budget: 660 }); // edit
    const all = await store.getTeamGoals();
    expect(all.map((g) => g.week_start)).toEqual(["2026-09-28", "2026-10-05"]);
    expect(all[1].booking_goal).toBe(90);
    expect((await store.getTeamGoal("2026-09-28"))?.booking_goal).toBe(79);
  });

  test("rep goal unset → deleted so the team-share fallback is authoritative", async () => {
    const store = new MemoryStore();
    await store.upsertRepGoals([{ rep_id: "r1", week_start: "2026-10-05", goal: 20 }]);
    expect(await store.getRepGoals("2026-10-05")).toHaveLength(1);
    await store.deleteRepGoal("r1", "2026-10-05");
    expect(await store.getRepGoals("2026-10-05")).toHaveLength(0);
  });

  test("lead count adjustments apply inside the metrics layer", () => {
    const mk = (id: string, type: string, work: string) => ({ id, lead_type: type, source_date: work, work_date: work, contact_id: null, assigned_rep_id: null, source_sheet: type });
    const leads = [mk("a", "family", "2026-10-05"), mk("b", "family", "2026-10-05"), mk("c", "animalia", "2026-10-05")];
    const adj = [{ work_date: "2026-10-05", sheet: "family", delta: -1 }];
    expect(leadsToday(leads, "2026-10-05")).toEqual({ family: 2, animalia: 1, total: 3 });
    expect(leadsToday(leads, "2026-10-05", adj)).toEqual({ family: 1, animalia: 1, total: 2 });
    expect(leadsForWeek(leads, "2026-10-05", adj).total).toBe(2);
  });

  test("recurring blocks materialize into UTC rows for the matching weekday only", () => {
    const blocks = [{ id: "rb1", weekday: 1, start_time: "12:00", end_time: "13:00", reason: "lunch", active: true }];
    // 2026-10-05 is a Monday
    const rows = materializeRecurringBlocks("2026-10-05", blocks);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("recurring:rb1:2026-10-05");
    expect(new Date(rows[0].start_at).getUTCHours()).toBe(16); // 12:00 ET = 16:00 UTC (EDT)
    expect(materializeRecurringBlocks("2026-10-06", blocks)).toHaveLength(0); // Tuesday
    expect(materializeRecurringBlocks("2026-10-05", blocks.map((b) => ({ ...b, active: false })))).toHaveLength(0);
  });
});

describe("manual override audit trail", () => {
  test("insertManualOverride records previous/new/who and a timestamp", async () => {
    const store = new MemoryStore();
    await store.insertManualOverride({ entity_type: "team_goal", entity_id: "2026-10-05", field: "booking_goal", previous_value: "79", new_value: "85", changed_by: "christopher" });
    const rows = await store.getManualOverrides(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].previous_value).toBe("79");
    expect(rows[0].new_value).toBe("85");
    expect(rows[0].changed_by).toBe("christopher");
    expect(rows[0].changed_at).toBeTruthy();
    expect(Number.isFinite(new Date(rows[0].changed_at).getTime())).toBe(true);
  });

  test("setManualAttribution wins and upsertAttributions preserves it (pg semantics mirrored)", async () => {
    const store = new MemoryStore();
    await store.upsertAttributions([{ id: "x", appointment_id: "appt1", call_id: null, rep_id: null, method: "none", confidence: 0, manual_override: false }]);
    await store.setManualAttribution({ id: "x", appointment_id: "appt1", call_id: "call9", rep_id: "r2", method: "manual", confidence: 1, manual_override: true });
    let attrs = await store.getAttributions();
    expect(attrs[0].method).toBe("manual");
    expect(attrs[0].manual_override).toBe(true);
    // engine re-run must not clobber the manual assignment
    await store.upsertAttributions([{ id: "x", appointment_id: "appt1", call_id: "call1", rep_id: "r1", method: "phone", confidence: 0.8, manual_override: false }]);
    attrs = await store.getAttributions();
    expect(attrs[0].rep_id).toBe("r2");
    expect(attrs[0].manual_override).toBe(true);
  });

  test("lead work-date update moves the row and lead count adjustment stores the delta", async () => {
    const store = new MemoryStore();
    await store.upsertLeads([{ id: "", provider: "google_sheets", source_id: "s1", lead_type: "family", source_date: "2026-10-04", work_date: "2026-10-05", contact_id: null, assigned_rep_id: null, source_sheet: "family" }]);
    const stored = await store.getLeadsByWorkDates(["2026-10-05"]);
    expect(stored).toHaveLength(1);
    await store.updateLeadWorkDate(stored[0].id, "2026-10-06");
    expect(await store.getLeadsByWorkDates(["2026-10-05"])).toHaveLength(0);
    expect(await store.getLeadsByWorkDates(["2026-10-06"])).toHaveLength(1);
    await store.upsertLeadCountAdjustment({ work_date: "2026-10-06", sheet: "family", delta: 2, reason: "two missed rows" });
    expect(await store.getLeadCountAdjustments(["2026-10-06"])).toHaveLength(1);
    await store.upsertLeadCountAdjustment({ work_date: "2026-10-06", sheet: "family", delta: 0, reason: null });
    expect(await store.getLeadCountAdjustments(["2026-10-06"])).toHaveLength(0); // zero delta → removed
  });
});

describe("server-side passphrase gate", () => {
  test("unset passphrase → everything open, isPassphraseConfigured false", async () => {
    delete process.env.DASHBOARD_PASSPHRASE;
    expect(isPassphraseConfigured()).toBe(false);
    const gate = await resolveGate(req("/"));
    expect(gate.kind).toBe("allow");
  });

  test("set passphrase: page without cookie → 401 lock-screen HTML; RPC → 401 JSON", async () => {
    withPassphrase(async () => {
      const page = await resolveGate(req("/", { headers: { accept: "text/html" } }));
      if (page.kind === "response") {
        expect(page.response.status).toBe(401);
        expect(await page.response.text()).toContain("passphrase");
      } else throw new Error("page request should be blocked");
      const rpc = await resolveGate(req("/_serverFn/fake", { method: "POST" }));
      expect(rpc.kind).toBe("response");
      if (rpc.kind === "response") {
        expect(rpc.response.status).toBe(401);
        expect(await rpc.response.text()).toContain("unauthorized");
      }
    });
  });

  test("set passphrase: valid signed cookie → allowed; invalid/forged → blocked", async () => {
    withPassphrase(async () => {
      const token = createSessionToken(PASSPHRASE);
      const ok = await resolveGate(req("/settings", { headers: { cookie: `${SESSION_COOKIE}=${token}`, accept: "text/html" } }));
      expect(ok.kind).toBe("allow");
      for (const bad of ["forged.deadbeef", "v1.999999999999999.deadbeef", createSessionToken("other-passphrase")]) {
        const g = await resolveGate(req("/settings", { headers: { cookie: `${SESSION_COOKIE}=${bad}`, accept: "text/html" } }));
        expect(g.kind).toBe("response");
      }
    });
  });

  test("expired token is rejected", () => {
    const token = createSessionToken(PASSPHRASE, Date.now() - 10_000, 5_000);
    expect(verifySessionToken(token, PASSPHRASE)).toBe(false);
    expect(verifySessionToken(createSessionToken(PASSPHRASE), PASSPHRASE)).toBe(true);
  });

  test("POST /auth/login sets a signed cookie and redirects; wrong passphrase re-locks", async () => {
    withPassphrase(async () => {
      const good = await resolveGate(req("/auth/login", { method: "POST", body: new URLSearchParams({ passphrase: PASSPHRASE, redirectTo: "/settings" }) }));
      expect(good.kind).toBe("response");
      if (good.kind === "response") {
        expect(good.response.status).toBe(303);
        expect(good.response.headers.get("location")).toBe("/settings");
        const cookie = good.response.headers.get("set-cookie") ?? "";
        expect(cookie).toContain("HttpOnly");
        const token = readSessionCookie(cookie);
        expect(verifySessionToken(token, PASSPHRASE)).toBe(true);
      }
      const bad = await resolveGate(req("/auth/login", { method: "POST", body: new URLSearchParams({ passphrase: "wrong", redirectTo: "/" }) }));
      expect(bad.kind).toBe("response");
      if (bad.kind === "response") expect(bad.response.status).toBe(401);
    });
  });

  test("asset prefixes stay open; redirect targets are sanitized", async () => {
    withPassphrase(async () => {
      const g = await resolveGate(req("/assets/app-abc123.js"));
      expect(g.kind).toBe("allow");
      expect(safeRedirectTarget("https://evil.example.com")).toBe("/");
      expect(safeRedirectTarget("//evil.example.com")).toBe("/");
      expect(safeRedirectTarget("/team")).toBe("/team");
    });
  });
});

describe("sync runs recorded on SYNC NOW", () => {
  test("runDemoSync writes one sync_runs row per provider + connection status", async () => {
    const store = new MemoryStore();
    // sheetsAdapter: null pins the demo path (the machine may hold a live
    // service-account secret; the live path has its own tests in sheets.test.ts).
    const res = await runDemoSync({ store, sheetsAdapter: null, highlevelAdapter: null });
    expect(res.providers.map((p) => p.provider)).toEqual(["highlevel", "acuity", "google_sheets", "attribution"]);
    for (const p of res.providers) {
      expect(p.error).toBeNull();
      expect(p.count).toBeGreaterThan(0);
    }
    const runs = await store.getSyncRuns(10);
    expect(runs.length).toBeGreaterThanOrEqual(4);
    for (const r of runs) {
      expect(r.status).toBe("success");
      expect(r.finished_at).toBeTruthy();
    }
    const conns = await store.getConnections();
    const providers = conns.map((c) => c.provider).sort();
    expect(providers).toEqual(["acuity", "google_sheets", "highlevel"]);
    for (const c of conns) {
      expect(c.is_demo).toBe(true);
      expect(c.last_sync_at).toBeTruthy();
      expect(c.last_successful_sync_at).toBeTruthy();
    }
  });
});

describe("sheet column mapping mechanism", () => {
  test("columnLetterToIndex and applySheetMapping parse a sample row", () => {
    expect(columnLetterToIndex("A")).toBe(0);
    expect(columnLetterToIndex("E")).toBe(4);
    expect(columnLetterToIndex("zz")).toBe(701);
    expect(columnLetterToIndex("1")).toBeNull();
    const sample = sampleSheetRow("family");
    const res = applySheetMapping(sample.rows[0], { source_date: "A", name: "B", phone: "C", email: "D", lead_type: "E" });
    expect(res.parsed).toEqual({ source_date: "2026-09-24", name: "Emma Carter", phone: "+19175550142", email: "emma.carter@example.com", lead_type: "family" });
    expect(res.warnings).toEqual([]);
    const missing = applySheetMapping(sample.rows[0], { source_date: "A", name: "Z" });
    expect(missing.parsed.name).toBeNull();
    expect(missing.warnings.length).toBeGreaterThan(0);
  });
});

describe("roster mapping payload (non-roster panel)", () => {
  // Fixture mirrors the live shape: 2 active roster users + inactive users with
  // a mix of call counts (calls carry the RAW HL external user id).
  const user = (id: string, external_id: string, name: string, is_active: boolean) => ({
    id,
    provider: "highlevel",
    external_id,
    name,
    email: null,
    is_active,
    call_start_date: null,
  });
  const ALL_USERS = [
    user("r_laura", "u_laura", "Laura Rivera", true),
    user("r_admin", "u_admin", "Admin Person", true), // active but not a CC rep
    user("i1", "u_christy", "Christy West", false), // 349 calls, live top row
    user("i2", "u_meg", "Meg Morton", false), // 1 call
    user("i3", "u_test", "TEST BOOKER", false), // zero — test account
    user("i4", "u_rocket", "Rocket App", false), // zero — app account
    user("i5", "u_moe1", "Moe Ahm", false), // zero — duplicate 1
    user("i6", "u_moe2", "Moe Ahm", false), // zero — duplicate 2
  ];
  const CALLS = new Map<string, number>([
    ["u_christy", 349],
    ["u_meg", 1],
    ["u_laura", 500], // active rep — never appears in the panel
  ]);

  test("payload carries callCount + zeroCallCount; server sends ALL inactive users (zero-call rows included, never server-filtered)", () => {
    const { nonRosterUsers, zeroCallCount } = buildNonRosterPanel(ALL_USERS, new Set(["r_laura", "r_admin"]), CALLS, []);
    expect(nonRosterUsers).toHaveLength(6); // every inactive user — the panel hides zero-call rows client-side only
    expect(nonRosterUsers.map((u) => [u.name, u.callCount])).toEqual([
      ["Christy West", 349], // sort: callCount desc…
      ["Meg Morton", 1],
      ["Moe Ahm", 0], // …then name; the two Moe Ahm duplicates both survive
      ["Moe Ahm", 0],
      ["Rocket App", 0],
      ["TEST BOOKER", 0],
    ]);
    expect(zeroCallCount).toBe(4); // toggle label "Show all (4)"
  });

  test("zero-call user stays in the payload WITH its mapping — select still works when shown (UI-default filter only)", () => {
    const mappings = [{ external_user_id: "u_test", rep_id: "r_laura" }];
    const { nonRosterUsers, zeroCallCount } = buildNonRosterPanel(ALL_USERS, new Set(["r_laura", "r_admin"]), CALLS, mappings);
    expect(nonRosterUsers.find((u) => u.externalId === "u_test")).toEqual({
      externalId: "u_test",
      name: "TEST BOOKER",
      callCount: 0,
      mappedTo: "r_laura", // mapping resolves even with zero calls
    });
    expect(zeroCallCount).toBe(4);
    // panel default hides it; show-all reveals it with the select's data intact
    expect(rosterPanelVisibleRows(nonRosterUsers, false).some((u) => u.externalId === "u_test")).toBe(false);
    expect(rosterPanelVisibleRows(nonRosterUsers, true).find((u) => u.externalId === "u_test")?.mappedTo).toBe("r_laura");
  });

  test("empty inactive set → empty rows, zeroCallCount 0 (never a guessed count)", () => {
    const { nonRosterUsers, zeroCallCount } = buildNonRosterPanel([], new Set(), CALLS, []);
    expect(nonRosterUsers).toEqual([]);
    expect(zeroCallCount).toBe(0);
  });
});
