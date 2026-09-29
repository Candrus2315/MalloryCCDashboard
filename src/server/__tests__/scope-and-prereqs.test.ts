/**
 * SCOPE ON ALL BOOKING READS (owner directive 2026-09-26) + DESIGN PREREQS
 * (merged-build playbook E-strip / E1 lead split / E5 tripwire tolerance).
 *
 * Scope: appointmentInScope (the availability engine's ONE scope rule) must be
 * applied at EVERY place appointments feed numbers — Today, DailyReport, Reps,
 * Team — from the same getSettings() read the builder makes. Fixture: one
 * MALLORY PORTRAITS appointment + one Zoom appointment, both created today.
 * With scope ["MALLORY PORTRAITS"] the Zoom booking must not count anywhere;
 * with an empty scope (Settings copy: "empty selection = everything counts")
 * both count. Demo data is never special-cased: tests set the scope explicitly.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { dailyReportPageData, repsPageData, teamPageData, todayPageData } from "../page-data";
import { buildTeamTrends, splitLeadRows, type AttributionRow, type LeadRow } from "../metrics/compute";
import { appointmentInScope } from "../metrics/availability";
import type { UserRow } from "../store/types";

// Pinned clock: Friday 2026-09-25 (EDT, UTC-4) — the week-cadence fixture week.
const FRI = "2026-09-25";
const CUR_MON = "2026-09-21";
const ET = (date: string, time: string) => new Date(`${date}T${time}:00.000-04:00`).toISOString();

const MALLORY_SCOPE = { calendars_included: ["MALLORY PORTRAITS"], types_included: [] as string[] };
const EMPTY_SCOPE = { calendars_included: [] as string[], types_included: [] as string[] };

/** MemoryStore with one rep, two created-today appointments (Mallory + Zoom), one attribution. */
async function seedStore(scope: { calendars_included: string[]; types_included: string[] }) {
  const store = new MemoryStore();
  await store.upsertUsers([
    { id: "u-src-alpha", provider: "highlevel", external_id: "hl-alpha", name: "Rep Alpha", email: null, is_active: true, call_start_date: null },
  ]);
  await store.saveSettings({ acuity: scope }); // TEST sets the scope explicitly — no demo special-case
  await store.upsertAppointments([
    {
      id: "appt-mallory",
      acuity_appointment_id: "acuity-mallory",
      contact_id: "contact-1",
      calendar_id: "1335091",
      calendar_name: "MALLORY PORTRAITS",
      appointment_type: "Family Portrait Session",
      appointment_datetime: ET(FRI, "14:00"),
      created_at: ET(FRI, "10:00"),
      status: "scheduled",
      cancelled: false,
      duration_minutes: 60,
    },
    {
      id: "appt-zoom",
      acuity_appointment_id: "acuity-zoom",
      contact_id: "contact-2",
      calendar_id: "zoom-cal",
      calendar_name: "Zoom",
      appointment_type: "Zoom Consultation",
      appointment_datetime: ET(FRI, "15:00"),
      created_at: ET(FRI, "10:30"),
      status: "scheduled",
      cancelled: false,
      duration_minutes: 30,
    },
  ]);
  const appts = await store.getAllAppointmentsSince(ET(FRI, "00:00"));
  const malloryId = appts.find((a) => a.calendar_name === "MALLORY PORTRAITS")!.id;
  const repId = (await store.getAllUsers())[0].id;
  const attribution: AttributionRow = {
    id: "attr-1",
    appointment_id: malloryId,
    call_id: null,
    rep_id: repId,
    method: "manual",
    confidence: 1,
    manual_override: true,
  };
  const zoomId = appts.find((a) => a.calendar_name === "Zoom")!.id;
  await store.upsertAttributions([
    attribution,
    { id: "attr-2", appointment_id: zoomId, call_id: null, rep_id: repId, method: "manual", confidence: 1, manual_override: true },
  ]);
  return { store, repId };
}

describe("JOB 1: the Acuity scope gates every booking number", () => {
  test("Today: Zoom excluded (1 not 2); empty scope → both count", async () => {
    const { store } = await seedStore(MALLORY_SCOPE);
    const scoped = await todayPageData({ store, today: FRI });
    expect(scoped.metrics.bookings.today).toBe(1);
    expect(scoped.metrics.bookings.wtd).toBe(1);
    expect(scoped.metrics.bookings.yesterday).toBe(0);

    const open = await todayPageData({ store: (await seedStore(EMPTY_SCOPE)).store, today: FRI });
    expect(open.metrics.bookings.today).toBe(2);
    expect(open.metrics.bookings.wtd).toBe(2);
  });

  test("Team: Zoom excluded (1 not 2); empty scope → both count", async () => {
    const { store } = await seedStore(MALLORY_SCOPE);
    const scoped = await teamPageData(undefined, { store, today: FRI });
    expect(scoped.metrics.totalBookings).toBe(1);
    expect(scoped.repRows).toHaveLength(1);
    expect(scoped.repRows[0].totalBookings).toBe(1); // rep-level via the attribution

    const open = await teamPageData(undefined, { store: (await seedStore(EMPTY_SCOPE)).store, today: FRI });
    expect(open.metrics.totalBookings).toBe(2);
  });

  test("Reps: Zoom excluded (selected rep 1 not 2); empty scope → both count", async () => {
    const { store } = await seedStore(MALLORY_SCOPE);
    const scoped = await repsPageData(undefined, { store, today: FRI });
    expect(scoped.repList[0].totalBookings).toBe(1);

    const open = await repsPageData(undefined, { store: (await seedStore(EMPTY_SCOPE)).store, today: FRI });
    expect(open.repList[0].totalBookings).toBe(2);
  });

  test("DailyReport: Zoom excluded from WTD (1 not 2); empty scope → both count", async () => {
    const { store } = await seedStore(MALLORY_SCOPE);
    // Pinned morning clock: before 18:30 ET the anchor is the prior workday
    // (Thursday), so the anchor-day wins bucket is 0 — never the live clock.
    const scoped = await dailyReportPageData({ store, today: FRI, etNowMinutes: 9 * 60 });
    expect(scoped.metrics.bookingsWtd).toBe(1);
    expect(scoped.metrics.bookingsAnchorDay).toBe(0);

    const open = await dailyReportPageData({ store: (await seedStore(EMPTY_SCOPE)).store, today: FRI, etNowMinutes: 9 * 60 });
    expect(open.metrics.bookingsWtd).toBe(2);
  });

  test("calendar-ID scope entries still match (id fallback, same rule as availability)", async () => {
    const { store } = await seedStore({ calendars_included: ["1335091"], types_included: [] });
    const scoped = await teamPageData(undefined, { store, today: FRI });
    expect(scoped.metrics.totalBookings).toBe(1);
  });

  test("appointmentInScope: unnamed rows vs a set scope are out (the demo-data rule)", () => {
    expect(
      appointmentInScope(
        { id: "a", contact_id: null, calendar_id: "cal-1", calendar_name: undefined, appointment_type: "t", appointment_datetime: ET(FRI, "10:00"), created_at: ET(FRI, "10:00"), status: "scheduled", cancelled: false },
        MALLORY_SCOPE,
      ),
    ).toBe(false);
    expect(appointmentInScope({ id: "a", contact_id: null, calendar_id: null, appointment_type: "t", appointment_datetime: ET(FRI, "10:00"), created_at: ET(FRI, "10:00"), status: "scheduled", cancelled: false }, EMPTY_SCOPE)).toBe(true);
  });
});

describe("E-strip: RepStripRow carries totalCalls, avgCallDurationSeconds, goal", () => {
  test("teamPageData repRows carry the summary fields + resolveRepGoal goal (team-share)", async () => {
    const { store, repId } = await seedStore(EMPTY_SCOPE);
    await store.upsertCalls([
      {
        id: "call-1",
        external_call_id: "ext-1",
        provider: "highlevel",
        rep_id: repId,
        contact_id: "contact-1",
        started_at: ET(FRI, "09:00"),
        duration_seconds: 300,
        over_two_minutes: true,
      },
      {
        id: "call-2",
        external_call_id: "ext-2",
        provider: "highlevel",
        rep_id: repId,
        contact_id: "contact-2",
        started_at: ET(FRI, "09:30"),
        duration_seconds: 60,
        over_two_minutes: false,
      },
    ]);
    const data = await teamPageData(undefined, { store, today: FRI });
    const row = data.repRows[0];
    expect(row.totalCalls).toBe(2);
    expect(row.callsOverThreshold).toBe(1);
    expect(row.avgCallDurationSeconds).toBe(180); // (300 + 60) / 2
    // no rep goal rows set → resolveRepGoal falls back to team share (79 ÷ 1 rep)
    expect(row.goal).not.toBeNull();
    expect(row.goal!.value).toBe(79);
    expect(row.goal!.basis).toBe("team-share");
  });

  test("an explicit rep goal wins over the team share (same resolveRepGoal as the rep table)", async () => {
    const { store } = await seedStore(EMPTY_SCOPE);
    await store.upsertRepGoals([{ rep_id: (await store.getAllUsers())[0].id, week_start: CUR_MON, goal: 5 }]);
    const data = await teamPageData(undefined, { store, today: FRI });
    expect(data.repRows[0].goal!.value).toBe(5);
    expect(data.repRows[0].goal!.basis).toBe("rep-goal");
  });
});

describe("E1: TrendPoint carries the family/animalia lead split (no new math)", () => {
  const lead = (id: string, leadType: string, sheet: string): LeadRow & { source_id: string; provider: string } => ({
    id: `lead-${id}`,
    source_id: id,
    provider: "google_sheets",
    lead_type: leadType,
    source_date: FRI,
    work_date: FRI,
    contact_id: null,
    assigned_rep_id: null,
    source_sheet: sheet,
  });

  test("summarizeLeadRows: splits by lead_type (source_sheet fallback); unknown type stays out of both", () => {
    expect(splitLeadRows([lead("f1", "family", "family"), lead("a1", "animalia", "animalia"), lead("f2", "", "family"), lead("u1", "other", "other")])).toEqual({
      family: 2,
      animalia: 1,
    });
    expect(splitLeadRows([])).toEqual({ family: 0, animalia: 0 });
  });

  test("buildTeamTrends points carry the split of the SAME leads the totals count", () => {
    const leads = [lead("f1", "family", "family"), lead("f2", "family", "family"), lead("a1", "animalia", "animalia"), lead("u1", "unknown", "unknown")];
    const t = buildTeamTrends({
      calls: [],
      appts: [],
      attributions: [],
      allCallsForJoin: [],
      leads,
      leadCountAdjustments: [],
      start: FRI,
      end: FRI,
      weeklyBudgetByWeek: new Map(),
      thresholdSeconds: 120,
    });
    expect(t.points).toHaveLength(1);
    expect(t.points[0].leads).toBe(4); // unchanged total (adjustments have no split — never guessed)
    expect(t.points[0].family).toBe(2);
    expect(t.points[0].animalia).toBe(1);
    expect(t.points[0].family + t.points[0].animalia).toBeLessThanOrEqual(t.points[0].leads);
  });
});
