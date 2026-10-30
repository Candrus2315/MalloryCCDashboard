/**
 * WORK-DATE COHORT ALIGNMENT (owner directive) — the six required test groups.
 *
 * The alignment doctrine in one line: a reporting week's LEADS are the leads
 * whose WORK DATE falls in the Mon–Sun window (the same cohort Team trends /
 * Reps / Today / Daily use), and its BOOKINGS are those cohort leads that
 * have produced a qualifying paid booking COUNTED TO DATE — a booking made
 * weeks later still bumps the ORIGINAL week, never the later one. Credit is
 * by LEAD ASSIGNMENT (rep cards); the booking-period three-category audit
 * keeps its source-date slice untouched.
 *
 * Groups (each maps to a directive requirement):
 *  1. cohort-window selection — the work-date window and its Fri→Mon roll;
 *  2. later-booking bump to ORIGINAL week;
 *  3. older-cohort isolation — pre-window cohorts never leak in;
 *  4. funnel/report alignment — funnel card ≡ primary table ≡ report input;
 *  5. rep-card assignment credit — computeAssignedCohortProduced;
 *  6. Weekly tab ↔ CC Report digit identity on the cohort rows.
 */
import { describe, expect, test } from "bun:test";
import { getWorkDate } from "../date-logic";
import {
  computeAssignedCohortProduced,
  computeLeadCohortOutcomes,
  weekCohortFunnelRows,
  type LeadJoinRow,
  type SourceBucket,
  type WinWithClients,
} from "../metrics/source-attribution";
import { weeklyPageData } from "../page-data";
import { MemoryStore } from "../store/memory";

// ---------- shared pure fixtures ----------

const joinLead = (over: Partial<LeadJoinRow> & { id: string }): LeadJoinRow => ({
  lead_type: "Family",
  source_date: "2026-10-20",
  contact_id: null,
  source_sheet: "family",
  name: null,
  phone: null,
  email: null,
  created_at: null,
  ...over,
});

const pureWin = (over: Partial<WinWithClients> & { id: string }): WinWithClients => ({
  contact_id: null,
  calendar_id: null,
  appointment_type: "Portrait Session",
  appointment_datetime: "2026-10-22T15:00:00Z",
  created_at: "2026-10-21T12:00:00Z",
  status: "scheduled",
  cancelled: false,
  created_business_date: "2026-10-21",
  payment_state: "paid",
  booking_win_business_date: "2026-10-22",
  ...over,
});

// ---------- 1. cohort-window selection ----------

describe("GROUP 1 — cohort-window selection (work-date window + Fri→Mon roll)", () => {
  test("getWorkDate rolls Fri/Sat/Sun sheet dates into the NEXT Monday (the frozen date logic the cohorts ride)", () => {
    expect(getWorkDate("2026-10-16")).toBe("2026-10-19"); // Fri → Mon
    expect(getWorkDate("2026-10-17")).toBe("2026-10-19"); // Sat → Mon
    expect(getWorkDate("2026-10-18")).toBe("2026-10-19"); // Sun → Mon
    expect(getWorkDate("2026-10-19")).toBe("2026-10-20"); // Mon → Tue
    expect(getWorkDate("2026-10-22")).toBe("2026-10-23"); // Thu → Fri
  });

  test("a lead whose SHEET date is the prior Friday belongs to the Mon 10/19 week's cohort — and to nothing else", () => {
    const rows = [
      joinLead({ id: "r1", source_date: "2026-10-16", work_date: "2026-10-19", contact_id: "k1" }), // Fri → Mon cohort
      joinLead({ id: "r2", source_date: "2026-10-15", work_date: "2026-10-16" }), // Thu → prior week
      joinLead({ id: "r3", source_date: "2026-10-23", work_date: "2026-10-26" }), // Fri → NEXT week
    ];
    const wins = [pureWin({ id: "w1", contact_id: "k1", created_business_date: "2026-10-20" })];
    const series = weekCohortFunnelRows(["2026-10-12", "2026-10-19", "2026-10-26"], rows, wins);
    expect(series.find((r) => r.weekStart === "2026-10-19")).toEqual({
      weekStart: "2026-10-19",
      weekEnd: "2026-10-25",
      leads: 1, // r1 ONLY — window selection rides work_date
      wins: 1, // r1 produced
      pct: 1,
    });
    // r2 (work 10/16) sits in the 10/12 week by ITS OWN work date — exactly one
    // cohort per lead; the win (created 10/20, k1) cannot reach it (no identity).
    expect(series.find((r) => r.weekStart === "2026-10-12")).toMatchObject({ leads: 1, wins: 0, pct: 0 });
    // r3 (work 10/26) belongs to the NEXT week's cohort by its own work date —
    // each lead sits in exactly one cohort; it has no identity, so no wins.
    expect(series.find((r) => r.weekStart === "2026-10-26")).toMatchObject({ leads: 1, wins: 0, pct: 0 });
  });
});

// ---------- 2. later-booking bump to ORIGINAL week ----------

describe("GROUP 2 — later-booking bump to the ORIGINAL week (cohort-to-date)", () => {
  test("a win created WEEKS after the cohort week bumps the original week's produced count, never the later week's", () => {
    const rows = [joinLead({ id: "r1", source_date: "2026-10-16", work_date: "2026-10-19", contact_id: "k1" })];
    const wins = [
      pureWin({ id: "w-later", contact_id: "k1", created_business_date: "2026-11-05", booking_win_business_date: "2026-11-05" }),
    ];
    const series = weekCohortFunnelRows(["2026-10-19", "2026-10-26", "2026-11-02"], rows, wins);
    expect(series.find((r) => r.weekStart === "2026-10-19")).toMatchObject({ leads: 1, wins: 1, pct: 1 });
    // the week the booking happened in has NO cohort of its own — it must not
    // absorb the win (a lead stays in its original cohort forever)
    expect(series.find((r) => r.weekStart === "2026-11-02")).toMatchObject({ leads: 0, wins: 0, pct: null });
    expect(series.find((r) => r.weekStart === "2026-10-26")).toMatchObject({ leads: 0, wins: 0 });
  });

  test("the causality guard holds across the bump: a win created BEFORE the lead's sheet date never produces it", () => {
    const rows = [joinLead({ id: "r1", source_date: "2026-10-16", work_date: "2026-10-19", contact_id: "k1" })];
    const wins = [pureWin({ id: "w-early", contact_id: "k1", created_business_date: "2026-10-10" })];
    const series = weekCohortFunnelRows(["2026-10-19"], rows, wins);
    expect(series[0]).toMatchObject({ leads: 1, wins: 0, pct: 0 });
  });
});

// ---------- 3. older-cohort isolation ----------

describe("GROUP 3 — older-cohort isolation (pre-window cohorts never leak)", () => {
  test("a produced lead from BEFORE the selected week contributes nothing to it (funnel series)", () => {
    const rows = [
      joinLead({ id: "old", source_date: "2026-10-09", work_date: "2026-10-12", contact_id: "kOld" }),
      joinLead({ id: "in", source_date: "2026-10-20", work_date: "2026-10-21", contact_id: "kIn" }),
    ];
    const wins = [
      pureWin({ id: "w-old", contact_id: "kOld", created_business_date: "2026-10-20" }), // produced, but the lead is pre-window
      pureWin({ id: "w-in", contact_id: "kIn", created_business_date: "2026-10-22" }),
    ];
    const series = weekCohortFunnelRows(["2026-10-19"], rows, wins);
    expect(series[0]).toMatchObject({ leads: 1, wins: 1, pct: 1 }); // only the in-window lead
    // and the older week (probed for contrast) owns its own production
    const older = weekCohortFunnelRows(["2026-10-12"], rows, wins);
    expect(older[0]).toMatchObject({ leads: 1, wins: 1, pct: 1 });
  });

  test("computeAssignedCohortProduced only sees the cohort slice its caller passes — an out-of-window lead cannot appear", () => {
    const outOfWindow = [joinLead({ id: "old", source_date: "2026-10-09", work_date: "2026-10-12", contact_id: "kOld", assigned_rep_id: "repA" })];
    const wins = [pureWin({ id: "w-old", contact_id: "kOld", created_business_date: "2026-10-20" })];
    // production slices the join rows to the period's work dates BEFORE calling
    const produced = computeAssignedCohortProduced(
      outOfWindow.filter((l) => l.work_date != null && l.work_date >= "2026-10-19" && l.work_date <= "2026-10-25"),
      wins,
      { start: "2026-10-19", end: "2026-10-25" },
    );
    expect(produced.producedByRep.size).toBe(0);
    expect(produced.producedInPeriodByRep.size).toBe(0);
  });
});

// ---------- 5. rep-card assignment credit ----------

describe("GROUP 5 — rep-card assignment credit (computeAssignedCohortProduced)", () => {
  const PERIOD = { start: "2026-10-19", end: "2026-10-25" };

  test("credit rides LEAD ASSIGNMENT: a lead assigned to repA counts for repA no matter who later worked the booking (no verdict input at all)", () => {
    const rows = [
      joinLead({ id: "la", source_date: "2026-10-16", work_date: "2026-10-19", contact_id: "kA", assigned_rep_id: "repA", source_sheet: "family" }),
      joinLead({ id: "lb", source_date: "2026-10-20", work_date: "2026-10-21", contact_id: "kB", assigned_rep_id: "repB", source_sheet: "animalia", lead_type: "Animalia" }),
    ];
    const wins = [
      pureWin({ id: "w1", contact_id: "kA", created_business_date: "2026-10-20" }), // causal for la
      pureWin({ id: "w2", contact_id: "kB", created_business_date: "2026-10-23" }), // causal for lb, in period
    ];
    const produced = computeAssignedCohortProduced(rows, wins, PERIOD);
    // la → repA (assignment), lb → repB — even though in production the wins'
    // verdict reps could be anyone: the machinery never sees a verdict.
    expect(produced.producedByRep.get("repA")?.get("family")).toEqual(new Set(["la"]));
    expect(produced.producedByRep.get("repB")?.get("animalia")).toEqual(new Set(["lb"]));
    expect(produced.producedByRep.has("repC")).toBe(false); // no invented reps
    // both causal wins created ≤ period end → both in-period
    expect(produced.producedInPeriodByRep.get("repA")?.get("family")).toEqual(new Set(["la"]));
    expect(produced.producedInPeriodByRep.get("repB")?.get("animalia")).toEqual(new Set(["lb"]));
  });

  test("the in-period/later split is exact by period end: a lead whose wins ALL fall after the end is produced-later only", () => {
    const rows = [joinLead({ id: "lc", source_date: "2026-10-20", work_date: "2026-10-21", contact_id: "kC", assigned_rep_id: "repA" })];
    const wins = [pureWin({ id: "w-late", contact_id: "kC", created_business_date: "2026-10-28" })]; // after 10/25
    const produced = computeAssignedCohortProduced(rows, wins, PERIOD);
    expect(produced.producedByRep.get("repA")?.get("family")).toEqual(new Set(["lc"])); // cohort-to-date: counts
    expect(produced.producedInPeriodByRep.get("repA")?.get("family")).toBeUndefined(); // …but never claimed in-period
  });

  test("form-source leads are skipped (team totals, never rep metrics) and unassigned leads credit nobody", () => {
    const rows = [
      joinLead({ id: "lf", source_date: "2026-10-20", work_date: "2026-10-21", contact_id: "kF", assigned_rep_id: "repA", source_sheet: "google_ads_leads" }),
      joinLead({ id: "ln", source_date: "2026-10-20", work_date: "2026-10-21", contact_id: "kN", assigned_rep_id: null }),
    ];
    const wins = [
      pureWin({ id: "wf", contact_id: "kF", created_business_date: "2026-10-22" }),
      pureWin({ id: "wn", contact_id: "kN", created_business_date: "2026-10-22" }),
    ];
    const produced = computeAssignedCohortProduced(rows, wins, PERIOD);
    expect(produced.producedByRep.size).toBe(0); // form lead skipped, unassigned lead credits nobody
    expect(produced.producedInPeriodByRep.size).toBe(0);
  });
});

// ---------- 4 + 6. builder end-to-end (MemoryStore, pinned today) ----------
// Week labeled Mon 10/19–Sun 10/25 (TODAY = Tue 10/27 pins lastCompletedWeekStart).
// Leads: F (sheet Fri 10/16 → work Mon 10/19, ASSIGNED, contact kF) and A
// (sheet Tue 10/20 → work Wed 10/21, unassigned, contact kA2).
// Wins: wF (created Thu 10/22, deposit Thu 10/22 — operational win of the week)
// and wLater (created MON 10/26, deposit 10/26 — NEXT week's deposit bucket,
// but it bumps the ORIGINAL 10/19 cohort per the doctrine).

const TODAY = "2026-10-27"; // Tue
const H = (date: string, time: string) => new Date(`${date}T${time}:00.000-04:00`).toISOString(); // EDT

const seedWin = (id: string, createdDate: string, type = "Portrait Session") => ({
  id,
  acuity_appointment_id: id,
  contact_id: null as string | null,
  calendar_id: "cal-1",
  appointment_type: type,
  appointment_datetime: H(createdDate, "14:00"),
  created_at: H(createdDate, "12:00"),
  created_business_date: createdDate,
  booking_win_business_date: createdDate,
  raw: { priceSold: "300.00", amountPaid: "300.00" },
  status: "scheduled",
  cancelled: false,
});

async function seedAlignmentStore(): Promise<{ store: MemoryStore; repId: string }> {
  const store = new MemoryStore();
  await store.saveSettings({ acuity: { calendars_included: [], types_included: [] } });
  await store.upsertUsers([
    { id: "Allison Wittner", provider: "highlevel", external_id: "allison", name: "Allison Wittner", email: null, is_active: true, call_start_date: null },
  ]);
  const repId = (await store.getAllUsers()).find((u) => u.name === "Allison Wittner")!.id;

  const wF = { ...seedWin("w-f", "2026-10-22"), contact_id: "kF" };
  const wLater = { ...seedWin("w-later", "2026-10-26", "Animalia Session"), contact_id: "kA2" }; // NEXT week's deposit — bumps the ORIGINAL cohort
  await store.upsertAppointments([wF, wLater]);

  await store.upsertLeads([
    {
      id: "F",
      lead_type: "family",
      source_date: "2026-10-16", // Fri — rolls to Mon 10/19 (getWorkDate)
      work_date: "2026-10-19",
      contact_id: "kF",
      assigned_rep_id: repId,
      source_sheet: "family",
      source_id: "F",
      provider: "google_sheets",
    },
    {
      id: "A",
      lead_type: "animalia",
      source_date: "2026-10-20",
      work_date: "2026-10-21",
      contact_id: "kA2",
      assigned_rep_id: null,
      source_sheet: "animalia",
      source_id: "A",
      provider: "google_sheets",
    },
  ]);
  return { store, repId };
}

describe("GROUP 4 — funnel/report alignment (one cohort definition everywhere)", () => {
  test("funnel card ≡ primary-table Total row: leads, produced, pct — and produced ≠ operational deposit-week wins", async () => {
    const { store } = await seedAlignmentStore();
    const data = await weeklyPageData({ store, today: TODAY });
    const total = data.sourcePerformance.cohort.find((r) => r.source === "total")!;
    expect(data.funnel.leads).toBe(total.leads); // 2 — the work-date cohort (Fri-roll included)
    expect(data.funnel.leads).toBe(2);
    expect(data.funnel.produced).toBe(total.bookedLeads); // 2 — F (w-f) + A (w-later bumps 10/19)
    expect(data.funnel.produced).toBe(2);
    expect(data.funnel.pct).toBe(total.conv);
    expect(data.funnel.pct).toBe(1);
    // the OPERATIONAL deposit-week tracker stays deposit-week: w-later's
    // deposit landed 10/26 → next week. Produced (cohort-to-date) ≠ wins.
    expect(data.funnel.wins).toBe(1);
    expect(data.funnel.wins).not.toBe(data.funnel.produced);
    // the funnel SERIES' last row is the same cohort doctrine (later win included)
    const last = data.funnelSeries[data.funnelSeries.length - 1];
    expect(last).toMatchObject({ weekStart: "2026-10-19", leads: 2, wins: 2, pct: 1 });
  });

  test("the CC report's 'Bookings from Leads' line is GONE (Final Booking Logic 10/28 §6) and LEAD SOURCE PERFORMANCE is ERASED (owner directive 10/28) — no per-source section survives anywhere", async () => {
    const { store } = await seedAlignmentStore();
    const data = await weeklyPageData({ store, today: TODAY });
    const lines = data.report.reportText.split("\n");
    expect(lines.some((l) => l.startsWith("Bookings from Leads:"))).toBe(false); // cohort funnel removed
    // ERASED section (owner directive 10/28): no per-source lead lines of any
    // shape — the genre counts render ONLY in the kept "Leads (week…)" block
    // ("Family: 1"), never as "<Label> — Leads: N"
    expect(lines.some((l) => l.startsWith("LEAD SOURCE PERFORMANCE"))).toBe(false);
    expect(lines).toContain("Family: 1");
    expect(lines).toContain("Animalia: 1");
    expect(lines.some((l) => l.startsWith("Total — Leads:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("Booking-period audit:"))).toBe(false);
    // the four-number hero rides the SAME produced machinery (tab ↔ report
    // identity) — REV-97 (owner 10/30): the ±goal comparison is the QUALIFYING
    // count (bookings.total, the goal-tracker chain) vs the same goal, while
    // Gross / Cancellations / Net stay as the production figures
    const qual = data.bookings.total;
    const gross = data.bookings.production.gross;
    const goal = data.bookings.goal;
    const dq = goal == null ? null : qual - goal;
    const signQ = dq == null ? "" : dq > 0 ? "+" : dq < 0 ? "−" : "±";
    expect(data.report.reportText).toContain(
      `Bookings (Week): ${qual}/${goal == null ? "—" : goal}${dq == null ? "" : ` (${signQ}${Math.abs(dq)})`} qualifying · Gross: ${gross} · Cancellations: ${data.bookings.production.cancellations} · Net: ${data.bookings.production.net}`,
    );
  });
});

describe("GROUP 6 — Weekly tab ↔ CC Report digit identity (cohort rows)", () => {
  test("report source-performance rows are the tab's primary cohort rows digit for digit; totals agree; audit footnote rides the untouched audit table", async () => {
    const { store } = await seedAlignmentStore();
    const data = await weeklyPageData({ store, today: TODAY });
    const tabRows = data.sourcePerformance.cohort.filter((r) => r.source !== "total");
    const reportRows = data.report.sourcePerformance!.rows;
    expect(reportRows).toHaveLength(tabRows.length);
    for (let i = 0; i < tabRows.length; i++) {
      expect(reportRows[i].source).toBe(tabRows[i].source);
      expect(reportRows[i].label).toBe(tabRows[i].label);
      expect(reportRows[i].leads).toBe(tabRows[i].leads);
      expect(reportRows[i].bookings).toBe(tabRows[i].bookedLeads); // cohort-to-date produced
      expect(reportRows[i].conv).toBe(tabRows[i].conv);
    }
    // totals digit-identical: the (former) report section input's Total line = the tab's Total row.
    // NOTE (owner directive 10/28): the CC Report no longer RENDERS this
    // section — data.report.sourcePerformance survives as the Weekly tab's
    // Attribution detail input; these identity pins guard the payload, not the
    // copied text.
    const tabTotal = data.sourcePerformance.cohort.find((r) => r.source === "total")!;
    expect(data.report.sourcePerformance!.totalLeads).toBe(tabTotal.leads);
    expect(data.report.sourcePerformance!.totalCurrentBookings).toBe(tabTotal.bookedLeads);
    expect(data.report.sourcePerformance!.totalConv).toBe(tabTotal.conv);
    // the methodology sentence is ERASED from the report text (owner directive 10/28)
    expect(data.report.reportText).not.toContain(
      "Leads = leads received for this work week",
    );
    // the footnote's audit aggregates come from the UNTOUCHED booking-period
    // audit table (deposit-week wins, source-date slice): w-f resolved to its
    // lead whose sheet date (10/16) predates the week → prior-period; w-later
    // (deposit 10/26) is outside the audit's win window entirely. The audit
    // line itself is ERASED from the report text (owner directive 10/28) —
    // the aggregates stay pinned on the payload object.
    expect(data.report.sourcePerformance!.totalBookings).toBe(data.sourcePerformance.table.totalBookings);
    expect(data.report.reportText).not.toContain("Booking-period audit:");
    // and the three-category audit table itself keeps its source-date slice:
    // its lead counts count SHEET dates in the week (A only), not the rolled F.
    expect(data.sourcePerformance.table.rows.find((r) => r.source === "family")?.leads).toBe(0);
    expect(data.sourcePerformance.table.rows.find((r) => r.source === "animalia")?.leads).toBe(1);
  });

  test("per-source cohort rows classify like the Lead Composition panel (genre sheets by lead type)", async () => {
    const { store } = await seedAlignmentStore();
    const data = await weeklyPageData({ store, today: TODAY });
    const family = data.sourcePerformance.cohort.find((r) => r.source === "family")!;
    const animalia = data.sourcePerformance.cohort.find((r) => r.source === "animalia")!;
    expect(family).toMatchObject({ leads: 1, bookedLeads: 1, conv: 1 }); // F — rolled in, produced
    expect(animalia).toMatchObject({ leads: 1, bookedLeads: 1, conv: 1 }); // A — produced via the later win
    expect(data.leads.total).toBe(2); // composition panel agrees with the cohort
  });
});
