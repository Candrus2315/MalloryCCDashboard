/**
 * RETENTION SETTINGS SURFACE (owner build-order item after transfers — the
 * delegation that makes the module's two owner-facing rules owner-editable):
 *
 *  1. DEFAULTS BYTE-IDENTICAL when settings are absent — data-start cutoff is
 *     still "the week containing Mon Oct 12 2026 ET" (directive 10/21) and the
 *     excitement-call window is still 7 days; every pre-existing
 *     RetentionSettings field keeps its ratified default/clamp.
 *  2. DEFENSIVE MERGE — a partial retention patch never wipes the owner's
 *     other saved retention fields; absent fields fall back to defaults
 *     (existing deployments keep behavior). ONE merge (mergeRetentionSettings)
 *     used by BOTH stores' saveSettings.
 *  3. SINGLE CONSUMER CONTRACT — every place that reads the old constant
 *     reads CURRENT settings at call time (the sheets-adapter per-tick
 *     contract, regression-pinned here): a settings change BETWEEN two calls
 *     is seen by the second. No boot-frozen snapshot.
 *  4. AUDIT — a save through the app path writes manual_overrides rows
 *     (entity_type retention_settings, old → new, actor) exactly like
 *     sheet-config saves; unchanged fields write nothing.
 *  5. VALIDATION — the save rejects a non-date cutoff, a non-positive-integer
 *     excitement window (bar: whole number 1–60), and an empty save, with an
 *     honest error; the date lands on any day of the intended week and is
 *     stored as that week's Monday.
 *  6. SURFACE — Settings is the ONLY mutation surface (page pins); the
 *     Retention tab stays read-only; display-layer-only semantics (a settings
 *     change never rewrites stored rows).
 *
 * Store-backed tests use MemoryStore directly — NEVER getStore(), which would
 * touch the live Postgres from tests.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MemoryStore } from "../store/memory";
import {
  DEFAULT_RETENTION_SETTINGS,
  mergeRetentionSettings,
  normalizeRetentionSettings,
  weekStartOfDateOrUndefined,
  type RetentionOutcomeWrite,
} from "../store/types";
import { saveRetentionSettingsCore } from "../queries";
import { retentionOverview } from "../retention/ui-data";
// Fixed clock: 2026-10-20 ET (Tue) → current Mon–Sun week = 10/19..10/25.
const NOW = () => new Date("2026-10-20T15:00:00Z");

// ---------- 1. week-start normalization (the cutoff's stored form) ----------
describe("weekStartOfDateOrUndefined — a date becomes its week's Monday, or null", () => {
  test("a Monday is itself", () => {
    expect(weekStartOfDateOrUndefined("2026-10-12")).toBe("2026-10-12");
    expect(weekStartOfDateOrUndefined("2026-10-19")).toBe("2026-10-19");
  });
  test("mid-week and Sunday dates land on their week's Monday", () => {
    expect(weekStartOfDateOrUndefined("2026-10-14")).toBe("2026-10-12"); // Wednesday
    expect(weekStartOfDateOrUndefined("2026-10-18")).toBe("2026-10-12"); // Sunday
    expect(weekStartOfDateOrUndefined("2026-10-11")).toBe("2026-10-05"); // the Sunday BEFORE — previous week
  });
  test("whitespace tolerated; garbage, rollover dates, and non-strings rejected", () => {
    expect(weekStartOfDateOrUndefined(" 2026-10-12 ")).toBe("2026-10-12");
    expect(weekStartOfDateOrUndefined("not-a-date")).toBeNull();
    expect(weekStartOfDateOrUndefined("2026-10")).toBeNull();
    expect(weekStartOfDateOrUndefined("2026-02-30")).toBeNull(); // rollover would fabricate Mar 3
    expect(weekStartOfDateOrUndefined("")).toBeNull();
    expect(weekStartOfDateOrUndefined(42)).toBeNull();
    expect(weekStartOfDateOrUndefined(null)).toBeNull();
  });
});

// ---------- 2. defaults byte-identical when settings absent ----------
describe("retention settings defaults — byte-identical when absent", () => {
  test("normalizeRetentionSettings(undefined) returns the ratified defaults exactly", () => {
    expect(normalizeRetentionSettings(undefined)).toEqual(DEFAULT_RETENTION_SETTINGS);
    expect(normalizeRetentionSettings(undefined).data_start_week_start).toBe("2026-10-12"); // the week of Mon Oct 12 2026 ET
    expect(normalizeRetentionSettings(undefined).due_days).toBe(7); // the 7-day excitement-call rule
  });
  test("pre-existing fields keep their ratified defaults and clamps", () => {
    const n = normalizeRetentionSettings({ due_days: 61, reschedule_days: 0 });
    expect(n.due_days).toBe(60); // the existing 0–60 clamp (unchanged)
    expect(n.reschedule_days).toBe(1); // the existing 1–90 clamp (unchanged)
  });
  test("an unparsable stored cutoff falls back to the default — never a guessed date", () => {
    expect(normalizeRetentionSettings({ data_start_week_start: "garbage" }).data_start_week_start).toBe("2026-10-12");
    expect(normalizeRetentionSettings({ data_start_week_start: 12345 }).data_start_week_start).toBe("2026-10-12");
  });
  test("a mid-week stored date normalizes to that week's Monday", () => {
    expect(normalizeRetentionSettings({ data_start_week_start: "2026-09-09" }).data_start_week_start).toBe("2026-09-07");
  });
});

// ---------- 3. defensive merge (the ONE merge both stores use) ----------
describe("mergeRetentionSettings — field-wise, defensive, change-detecting", () => {
  test("a partial patch never wipes the other saved retention fields", () => {
    const current = normalizeRetentionSettings({ due_days: 5, data_start_week_start: "2026-10-05" });
    const { retention, changes } = mergeRetentionSettings(current, { data_start_week_start: "2026-09-09" });
    expect(retention.due_days).toBe(5); // preserved
    expect(retention.data_start_week_start).toBe("2026-09-07"); // normalized to the week's Monday
    expect(changes).toEqual([{ field: "data_start_week_start", from: "2026-10-05", to: "2026-09-07" }]);
  });
  test("no changes when the patch is a no-op (idempotent save, no spurious audit)", () => {
    const current = normalizeRetentionSettings(undefined);
    const { changes } = mergeRetentionSettings(current, { due_days: 7, data_start_week_start: "2026-10-12" });
    expect(changes).toEqual([]);
  });
  test("absent current settings start from the defaults (existing deployments keep behavior)", () => {
    const { retention, changes } = mergeRetentionSettings(undefined, { due_days: 5 });
    expect(retention).toEqual({ ...DEFAULT_RETENTION_SETTINGS, due_days: 5 });
    expect(changes).toEqual([{ field: "due_days", from: "7", to: "5" }]);
  });
});

// ---------- 4. store save through the app path is audited ----------
describe("MemoryStore saveSettings — retention merge + manual_overrides audit", () => {
  test("a retention patch lands field-wise and writes one audit row per changed field (owner actor)", async () => {
    const store = new MemoryStore();
    await store.saveSettings({ retention: { due_days: 5, data_start_week_start: "2026-09-09" } }, "christopher");
    const r = (await store.getSettings()).retention!;
    expect(r.due_days).toBe(5);
    expect(r.data_start_week_start).toBe("2026-09-07"); // normalized to the week's Monday
    const rows = (await store.getManualOverrides(40)).filter((o) => o.entity_type === "retention_settings");
    const byField = Object.fromEntries(rows.map((o) => [o.field, o]));
    expect(byField.due_days!.previous_value).toBe("7");
    expect(byField.due_days!.new_value).toBe("5");
    expect(byField.due_days!.changed_by).toBe("christopher");
    expect(byField.data_start_week_start!.previous_value).toBe("2026-10-12");
    expect(byField.data_start_week_start!.new_value).toBe("2026-09-07");
    expect(byField.data_start_week_start!.changed_by).toBe("christopher");
  });
  test("an idempotent save writes NO audit rows", async () => {
    const store = new MemoryStore();
    await store.saveSettings({ retention: { due_days: 5 } }, "christopher");
    const before = (await store.getManualOverrides(40)).filter((o) => o.entity_type === "retention_settings").length;
    await store.saveSettings({ retention: { due_days: 5 } }, "christopher");
    const after = (await store.getManualOverrides(40)).filter((o) => o.entity_type === "retention_settings").length;
    expect(after).toBe(before);
  });
  test("a partial patch preserves the owner's other saved retention fields", async () => {
    const store = new MemoryStore();
    await store.saveSettings({ retention: { due_days: 3 } }, "christopher");
    await store.saveSettings({ retention: { data_start_week_start: "2026-09-07" } }, "christopher");
    const r = (await store.getSettings()).retention!;
    expect(r.due_days).toBe(3); // the earlier save survived
    expect(r.data_start_week_start).toBe("2026-09-07");
  });
  test("defaults byte-identical when the settings row predates the field (absent group)", async () => {
    const store = new MemoryStore();
    const r = (await store.getSettings()).retention!;
    expect(r).toEqual(DEFAULT_RETENTION_SETTINGS);
  });
});

// ---------- 5. saveRetentionSettingsCore — validation + the audited app path ----------
describe("saveRetentionSettingsCore — honest validation, owner-labeled audited save", () => {
  test("rejects a non-positive-integer excitement window (bar: whole number 1–60)", async () => {
    const store = new MemoryStore();
    for (const bad of [0, -1, 61, 2.5, Number.NaN]) {
      await expect(saveRetentionSettingsCore(store, { excitementDays: bad as number })).rejects.toThrow(/between 1 and 60/);
    }
  });
  test("rejects a cutoff that does not parse as a date", async () => {
    const store = new MemoryStore();
    await expect(saveRetentionSettingsCore(store, { dataStartWeekStart: "not-a-date" })).rejects.toThrow(/calendar date/);
    await expect(saveRetentionSettingsCore(store, { dataStartWeekStart: "2026-02-30" })).rejects.toThrow(/calendar date/);
  });
  test("rejects an empty save; both bad fields report together", async () => {
    const store = new MemoryStore();
    await expect(saveRetentionSettingsCore(store, {})).rejects.toThrow(/Nothing to save/);
    await expect(saveRetentionSettingsCore(store, { excitementDays: 0, dataStartWeekStart: "junk" })).rejects.toThrow(/between 1 and 60.*calendar date|calendar date.*between 1 and 60/);
  });
  test("a valid save lands (normalized) and is audited through the app path", async () => {
    const store = new MemoryStore();
    await saveRetentionSettingsCore(store, { dataStartWeekStart: "2026-09-09", excitementDays: 5 });
    const r = (await store.getSettings()).retention!;
    expect(r.data_start_week_start).toBe("2026-09-07");
    expect(r.due_days).toBe(5);
    const rows = (await store.getManualOverrides(40)).filter((o) => o.entity_type === "retention_settings");
    expect(rows.some((o) => o.field === "data_start_week_start" && o.new_value === "2026-09-07")).toBe(true);
    expect(rows.some((o) => o.field === "due_days" && o.new_value === "5" && o.changed_by === "christopher")).toBe(true);
  });
  test("same-week date input is a no-op save (no audit, no change)", async () => {
    const store = new MemoryStore();
    await saveRetentionSettingsCore(store, { dataStartWeekStart: "2026-10-14" }); // Wednesday of the default week
    const r = (await store.getSettings()).retention!;
    expect(r.data_start_week_start).toBe("2026-10-12");
    expect((await store.getManualOverrides(40)).filter((o) => o.entity_type === "retention_settings")).toEqual([]);
  });
});

// ---------- 6. the SINGLE CONSUMER CONTRACT regression (sheets-adapter analog) ----------
describe("per-tick settings contract — a settings change between two calls is seen by the second", () => {
  async function seeded(): Promise<{ store: MemoryStore; apptId: string; clientId: string }> {
    const store = new MemoryStore();
    await store.upsertAppointments([
      {
        id: "",
        acuity_appointment_id: "A-PRE",
        contact_id: null,
        calendar_id: "1335091",
        calendar_name: "MALLORY PORTRAITS",
        appointment_type: "Portrait Session",
        // ET date 2026-10-08 — BEFORE the default data-start week (Oct 12).
        appointment_datetime: "2026-10-08T14:00:00Z",
        created_at: "2026-10-01T18:00:00Z",
        status: "scheduled",
        cancelled: false,
        raw: null,
      },
    ] as never);
    const appts = await store.getAppointmentsWithClientsSince("2026-09-01T00:00:00Z");
    const appt = appts.find((a) => a.acuity_appointment_id === "A-PRE")!;
    const client = await store.insertInternalClient({ seedKey: "hl-contact:PRE", displayName: "Pre Cutoff", normalizedPhone: "9175550001", normalizedEmail: "pre@example.com", ghlContactExternalId: "PRE" });
    await store.insertClientMatchLinkIfAbsent({ internalClientId: client.id, provider: "acuity", entity: "appointment", externalId: "A-PRE", matchMethod: "exact_id", confidence: "exact" });
    const write: RetentionOutcomeWrite = {
      appointmentId: appt.id,
      internalClientId: client.id,
      contactDueDate: "2026-10-01",
      eligible: true,
      eligibilityBasis: "test",
      attemptsCount: 0,
      firstAttemptAtIso: null,
      lastAttemptAtIso: null,
      anyAnswered: false,
      finalStatus: "needs_review",
      evidence: {},
      needsReviewReason: "test conflict",
    };
    await store.insertRetentionAppointmentOutcomes([write]);
    return { store, apptId: appt.id, clientId: client.id };
  }
  const needsReview = (cards: { key: string; value: number | null }[]) => cards.find((c) => c.key === "needs-review")!.value;

  test("default boundary hides the pre-cutoff row; the OWNER-EDITED boundary seen by the SECOND call shows it", async () => {
    const { store } = await seeded();
    // Call 1 — defaults: the 10/08 appointment is pre-cutoff → hidden.
    const first = await retentionOverview(store, NOW);
    expect(needsReview(first.cards)).toBe(0);
    // The owner saves a wider boundary through the app path (audited).
    await saveRetentionSettingsCore(store, { dataStartWeekStart: "2026-09-07" });
    // Call 2 — CURRENT settings at call time: the SAME stored row now shows.
    const second = await retentionOverview(store, NOW);
    expect(needsReview(second.cards)).toBe(1);
  });
  test("the stored outcome row is never rewritten by a settings change (display-layer only)", async () => {
    const { store, apptId, clientId } = await seeded();
    const before = (await store.listRetentionAppointmentOutcomes()).find((o) => o.appointment_id === apptId);
    await saveRetentionSettingsCore(store, { dataStartWeekStart: "2026-09-07" });
    const after = (await store.listRetentionAppointmentOutcomes()).find((o) => o.appointment_id === apptId);
    expect(after).toEqual(before);
    expect(after!.internal_client_id).toBe(clientId);
    expect(after!.final_status).toBe("needs_review");
  });
  test("the helpers keep their 1-arg default (byte-identical) and honor an explicit boundary", async () => {
    const { inRetentionDataScope, inRetentionScorecardScope } = await import("../retention/ui-data");
    const preCutoffMs = Date.parse("2026-10-08T14:00:00Z");
    expect(inRetentionDataScope(preCutoffMs)).toBe(false); // default — unchanged behavior
    expect(inRetentionDataScope(preCutoffMs, "2026-09-07")).toBe(true); // the owner-edited boundary
    expect(inRetentionScorecardScope("2026-10-05")).toBe(false); // default — unchanged
    expect(inRetentionScorecardScope("2026-10-05", "2026-09-07")).toBe(true);
  });
  test("the excitement window is read at call time too (dueDays reaches the cards)", async () => {
    const { store } = await seeded();
    const first = await retentionOverview(store, NOW);
    expect(first.cards[0]!.sub).toContain("− 7");
    await saveRetentionSettingsCore(store, { excitementDays: 5 });
    const second = await retentionOverview(store, NOW);
    expect(second.cards[0]!.sub).toContain("− 5");
  });
});

// ---------- 7. surface pins — Settings is the ONLY mutation surface ----------
describe("settings surface pins — owner-labeled save through the app path", () => {
  const settingsSrc = () => readFileSync(new URL("../../routes/settings.tsx", import.meta.url), "utf8");
  const viewsSrc = () => readFileSync(new URL("../../components/settings-views.ts", import.meta.url), "utf8");
  const queriesSrc = () => readFileSync(new URL("../queries.ts", import.meta.url), "utf8");
  const retentionSrc = () => readFileSync(new URL("../../routes/retention.tsx", import.meta.url), "utf8");

  test("the Settings page renders the Retention section with both owner rules + the display-scope note", () => {
    const src = settingsSrc();
    expect(src).toContain(`id="retention"`);
    expect(src).toContain(`<SectionHeader id="retention" />`);
    expect(src).toContain("Data-start week");
    expect(src).toContain("Excitement-call window (days)");
    expect(src).toContain("stored history is never rewritten");
    expect(src).toContain("saveRetentionSettings({ data: { dataStartWeekStart, excitementDays } })");
  });
  test("the save is client-gated on validation and disabled while busy/invalid", () => {
    expect(settingsSrc()).toContain("disabled={busy || !dateOk || !daysOk}");
  });
  test("the section lives in the IA constant right after Operational Rules", () => {
    const src = viewsSrc();
    expect(src).toContain(`id: "retention"`);
    const rulesAt = src.indexOf(`id: "rules"`);
    const retentionAt = src.indexOf(`id: "retention"`);
    const acuityAt = src.indexOf(`id: "acuity"`);
    expect(rulesAt).toBeGreaterThan(-1);
    expect(retentionAt).toBeGreaterThan(rulesAt);
    expect(retentionAt).toBeLessThan(acuityAt);
  });
  test("the server fn saves owner-labeled through store.saveSettings and normalizes via the ONE merge", () => {
    const src = queriesSrc();
    expect(src).toContain("export async function saveRetentionSettingsCore");
    expect(src).toContain("normalizeRetentionSettings({ ...current.retention, ...patch })");
    expect(src).toContain("await store.saveSettings({ retention }, SETTINGS_OWNER_ACTOR)");
  });
  test("the Retention tab stays read-only (no save path there — Settings is the ONLY mutation surface)", () => {
    expect(retentionSrc()).not.toContain("saveRetentionSettings");
    expect(retentionSrc()).not.toContain("saveSettings");
  });
  test("the scorecard display filter resolves the boundary from CURRENT settings", () => {
    expect(queriesSrc()).toContain("ui.inRetentionScorecardScope(r.week_start, settings.retention.data_start_week_start)");
  });
});
