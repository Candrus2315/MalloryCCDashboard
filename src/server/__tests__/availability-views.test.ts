/**
 * AVAILABILITY REBUILD PR-2 — range-view payload tests (Month / 14-Day / Day).
 *
 * Fixture-driven from PR-1's committed probe snapshots (the 2026-10-06 live
 * Acuity answers): the October/November month indexes (including the EMPTY
 * December + January rows — that IS the coverage horizon), and the per-date
 * /availability/times answers for 10-08 and 10-13. Every count is the ONE
 * engine's (computeDayAvailability); every hole the ONE derivation
 * (deriveAvailabilityHoles); the MemoryStore is seeded with the store twins.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import {
  availabilityPageData,
  normalizeAvailabilityView,
  type AvailabilityRangeDay,
  type AvailabilitySlotView,
  type AvailabilityViewPayload,
} from "../page-data";
import { slotLabelToMinutes, slotLabelToTime, slotTimeToLabel } from "../metrics/availability";
import { deriveAvailabilityHoles } from "../sync/availability-feed";
import { addDays, etDayStartUtc } from "../date-logic";

// ---- PR-1 fixtures (raw probe snapshots) ----
import octDates from "./fixtures/availability-feed/dates-2026-10-cal1335091.json";
import novDates from "./fixtures/availability-feed/dates-2026-11-cal1335091.json";
import decDates from "./fixtures/availability-feed/dates-2026-12-cal1335091.json";
import janDates from "./fixtures/availability-feed/dates-2027-01-cal1335091.json";
import timesOct08 from "./fixtures/availability-feed/times-2026-10-08-cal1335091.json";
import timesOct13 from "./fixtures/availability-feed/times-2026-10-13-cal1335091.json";

const TODAY = "2026-10-06"; // Tuesday — the day the PR-1 probes ran
const RUN = "run-pr2-tests";
const CAL = "1335091";
const TYPE = "3599872";
const SWEEP_AT = "2026-10-06T21:00:00.000Z"; // the probe instant (ET date = TODAY)

/** Fixture month index → store row. */
function dateRow(month: string, dates: Array<{ date: string }>) {
  return { calendar_id: CAL, appointment_type_id: TYPE, month, dates_et: dates.map((d) => d.date) };
}

/** Fixture times answer → HH:mm ET list. */
function timesToHhmm(times: Array<{ time: string }>): string[] {
  return times.map((t) => t.time.slice(11, 16)).sort();
}

/** ET wall time on an ET date → UTC instant. DST-correct: anchored on the
 * date's REAL ET midnight (etDayStartUtc — two-pass offset), never a hardcoded
 * offset (EDT UTC−4 in October, EST UTC−5 from Nov 1 — the November seeds land
 * an hour off with a fixed +4). */
function etUtc(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(new Date(etDayStartUtc(date)).getTime() + (h * 60 + m) * 60_000).toISOString();
}

interface SeedAppt {
  datetime: string; // UTC ISO
  client: string;
  payment?: string;
  cancelled?: boolean;
  cancelledAt?: string;
  type?: string;
}

async function seedBase(store: MemoryStore) {
  // canonical availability_rules mirror = the demo two-block grid (9 slots/day)
  // — identical to DEFAULT_SETTINGS.studio.hours, so storedRules stays empty
  // and the settings rules drive the engine (the fresh-store fallback path).
  const appts: SeedAppt[] = [];
  const seed = {
    add(d: SeedAppt) {
      appts.push(d);
    },
  };
  return {
    seed,
    async flush() {
      if (appts.length === 0) return;
      await store.upsertAppointments(
        appts.map((a, i) => ({
          acuity_appointment_id: `apx-${i}-${a.datetime}`,
          contact_id: null,
          calendar_id: CAL,
          calendar_name: "MALLORY PORTRAITS",
          appointment_type: a.type ?? "Family Session",
          appointment_datetime: a.datetime,
          created_at: a.datetime,
          status: a.cancelled ? "cancelled" : "scheduled",
          cancelled: a.cancelled ?? false,
          ...(a.cancelledAt ? { cancelled_at: a.cancelledAt, cancellation_source: "acuity-reconciliation" } : {}),
          ...(a.payment ? { payment_state: a.payment } : {}),
          duration_minutes: 60,
          client_name: a.client,
        })),
      );
    },
  };
}

async function seedFeed(store: MemoryStore) {
  // Month indexes straight from the PR-1 probe fixtures (December + January
  // cached EMPTY — that IS the coverage horizon). February 2027 is seeded by
  // NOBODY → the honest "no data" month.
  await store.putAvailabilityDates(
    [dateRow("2026-10", octDates as Array<{ date: string }>), dateRow("2026-11", novDates as Array<{ date: string }>), dateRow("2026-12", decDates as Array<{ date: string }>), dateRow("2027-01", janDates as Array<{ date: string }>)],
    RUN,
    SWEEP_AT, // the probe instant, PINNED — the sweep-age classification (feed-observed closed vs not-yet-observed) keys off fetched_at, and the wall clock here is not Oct 6 anymore
  );
  // per-date times probes (only 10-08 + 10-13 were probed)
  await store.putAvailabilitySlotsForDate(CAL, "2026-10-08", timesToHhmm(timesOct08 as Array<{ time: string }>).map((time_et) => ({ time_et, slots_available: 1 })), RUN);
  await store.putAvailabilitySlotsForDate(CAL, "2026-10-13", timesToHhmm(timesOct13 as Array<{ time: string }>).map((time_et) => ({ time_et, slots_available: 1 })), RUN);
}

const byDate = (days: AvailabilityRangeDay[], date: string): AvailabilityRangeDay =>
  days.find((d) => d.date === date) as AvailabilityRangeDay;
const slotOf = (slots: AvailabilitySlotView[], label: string): AvailabilitySlotView =>
  slots.find((s) => s.label === label) as AvailabilitySlotView;

// ---------- pure helpers ----------
describe("normalizeAvailabilityView (pure)", () => {
  test("no raw search → null (legacy 7-day payload contract keeps running)", () => {
    expect(normalizeAvailabilityView(undefined, TODAY)).toBeNull();
    expect(normalizeAvailabilityView({}, TODAY)).toBeNull();
  });
  test("month default: today's month; invalid values fall back honestly", () => {
    expect(normalizeAvailabilityView({ view: "month" }, TODAY)).toEqual({
      kind: "month", month: "2026-10", from: "", to: "", date: "",
      filters: { calendars: [], types: [], statuses: [] }, // PR-3 §3: empty = everything in scope
    });
    expect(normalizeAvailabilityView({ view: "month", month: "2026-13" }, TODAY)!.month).toBe("2026-10");
    expect(normalizeAvailabilityView({ view: "month", month: "2027-02" }, TODAY)!.month).toBe("2027-02");
    expect(normalizeAvailabilityView({ view: "nonsense" }, TODAY)!.kind).toBe("month");
  });
  test("14-day window: from..from+13; day: the single date", () => {
    expect(normalizeAvailabilityView({ view: "days" }, TODAY)).toEqual({
      kind: "days", month: "", from: TODAY, to: addDays(TODAY, 13), date: "",
      filters: { calendars: [], types: [], statuses: [] },
    });
    expect(normalizeAvailabilityView({ view: "days", from: "2026-11-01" }, TODAY)!.to).toBe("2026-11-14");
    expect(normalizeAvailabilityView({ view: "days", from: "garbage" }, TODAY)!.from).toBe(TODAY);
    expect(normalizeAvailabilityView({ view: "day" }, TODAY)!.date).toBe(TODAY);
    expect(normalizeAvailabilityView({ view: "day", date: "2026-10-13" }, TODAY)!.date).toBe("2026-10-13");
  });
});

describe("slot label ↔ feed time round-trip (pure)", () => {
  test("labels invert to minutes and feed times, both directions", () => {
    for (const [label, time] of [["9:00 AM", "09:00"], ["12:00 PM", "12:00"], ["1:30 PM", "13:30"], ["11:59 AM", "11:59"], ["5:30 PM", "17:30"]] as const) {
      expect(slotLabelToMinutes(label)).not.toBeNull();
      expect(slotLabelToTime(label)).toBe(time);
      expect(slotTimeToLabel(time)).toBe(label);
    }
    expect(slotLabelToMinutes("not a slot")).toBeNull();
    expect(slotTimeToLabel("24:00")).toBeNull();
  });
});

describe("deriveAvailabilityHoles — THE hole derivation (placeholder = current rule)", () => {
  test("holes = capacity − DISTINCT booked slots (clamped at zero)", () => {
    const slots = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:30", "14:30", "15:30", "16:30", "17:30"];
    expect(deriveAvailabilityHoles({ slotTimes: slots, bookedTimes: ["09:00", "10:00", "11:00", "12:00", "14:30", "15:30", "16:30", "17:30"] })).toEqual({
      holes: 2,
      holeSlots: ["08:00", "13:30"],
    });
    // doubles collapse: two appts on one slot occupy ONE slot (distinct counting)
    expect(deriveAvailabilityHoles({ slotTimes: ["09:00", "10:00"], bookedTimes: ["09:00", "09:00"] }).holes).toBe(1);
    // an overbooked day has no empty slots (never negative)
    expect(deriveAvailabilityHoles({ slotTimes: ["09:00"], bookedTimes: ["09:00", "10:00"] }).holes).toBe(0);
    // blocked times are inputs for the PR-3 swap — the current rule still counts them empty
    const r = deriveAvailabilityHoles({ slotTimes: ["09:00", "10:00"], bookedTimes: ["09:00"], blockedTimes: ["10:00"] });
    expect(r.holes).toBe(1);
    expect(r.holeSlots).toContain("10:00");
  });
});

// ---------- MONTH view (default) — fixture-driven ----------
describe("availabilityPageData view=month — coverage from PR-1 fixtures", () => {
  test("October 2026: per-day states — past / feed-closed / feed-probed / feed-pending; holes; summary", async () => {
    const store = new MemoryStore();
    const s = await seedBase(store);
    // Thu 10-08: DB booked 09,10,11,12,14:30,16:30,17:30 — the probe's EXACT-match day (§1.5), with 15:30 left free for the unexplained case
    for (const t of ["09:00", "10:00", "11:00", "12:00", "14:30", "16:30", "17:30"]) {
      s.seed.add({ datetime: etUtc("2026-10-08", t), client: `Booked ${t}` });
    }
    // Tue 10-13: paid 09:00 + cancelled row on the same slot; pending 13:30; paid 15:30; double 17:30
    s.seed.add({ datetime: etUtc("2026-10-13", "09:00"), client: "Anna Grid" });
    s.seed.add({ datetime: etUtc("2026-10-13", "09:00"), client: "Xavier Cancelled", cancelled: true, cancelledAt: "2026-10-09T15:00:00.000Z" });
    s.seed.add({ datetime: etUtc("2026-10-13", "13:30"), client: "Bea Pending", payment: "pending_payment" });
    s.seed.add({ datetime: etUtc("2026-10-13", "15:30"), client: "Cara Paid" });
    s.seed.add({ datetime: etUtc("2026-10-13", "17:30"), client: "Dan One" });
    s.seed.add({ datetime: etUtc("2026-10-13", "17:30"), client: "Dan Two" });
    await s.flush();
    await seedFeed(store);
    await store.insertBlockedTime({ start_at: etUtc("2026-10-13", "11:00"), end_at: etUtc("2026-10-13", "12:00"), reason: "Studio maintenance" });

    const data = await availabilityPageData({ store, today: TODAY, view: { view: "month", month: "2026-10" } });
    const view = data.view as AvailabilityViewPayload;
    expect(view.kind).toBe("month");
    expect(view.label).toBe("October 2026");
    expect(view.dates).toHaveLength(31);
    expect(view.coverage.horizonDate).toBe("2026-11-01");
    expect(view.coverage.coveredMonths).toEqual(["2026-10", "2026-11", "2026-12", "2027-01"]);
    expect(view.coverage.noFeedData).toBe(false);

    // PAST days (Oct 1–5): booked-truth territory, engine numbers, no feed claims
    expect(byDate(view.days, "2026-10-01").acuity).toBe("past");
    expect(byDate(view.days, "2026-10-01").openCount).toBe(9);
    // TODAY (Oct 6): not observed by the sweep snapshot → estimate, honestly labeled
    expect(byDate(view.days, "2026-10-06").acuity).toBe("estimated");
    expect(byDate(view.days, "2026-10-06").openCount).toBe(9);
    // Oct 7: inside the horizon, after the sweep snapshot, not in the month row → feed-observed closed (REAL zero, not a bare placeholder)
    expect(byDate(view.days, "2026-10-07").acuity).toBe("feed");
    expect(byDate(view.days, "2026-10-07").openCount).toBe(0);
    expect(byDate(view.days, "2026-10-07").feedOpenTimes).toBeNull(); // feed-closed: open is a REAL 0, no per-time feed answer exists
    // OWNER RULING 2026-10-06: holes = empty slots = capacity − booked — a
    // feed-closed (fully-unbookable) day counts ALL its grid slots as holes
    // (9 in the demo grid; 10 on a real non-Tue schedule), never 0.
    expect(byDate(view.days, "2026-10-07").holes).toBe(9);
    // Oct 8: probed → Acuity-authoritative (feed ∖ booked)
    const d08 = byDate(view.days, "2026-10-08");
    expect(d08.acuity).toBe("feed");
    expect(d08.feedOpenTimes).toEqual(["08:00", "13:30"]);
    expect(d08.openCount).toBe(2);
    expect(d08.booked).toBe(7);
    expect(d08.holes).toBe(2); // current rule: 9 grid slots − 7 booked
    // Oct 9: listed NOWHERE in the probe's October answer → feed-closed
    expect(byDate(view.days, "2026-10-09").openCount).toBe(0);
    // Oct 12: the month row marks it open but no probe ran → pending estimate
    const d12 = byDate(view.days, "2026-10-12");
    expect(d12.feedPending).toBe(true);
    expect(d12.acuity).toBe("feed");
    expect(d12.openCount).toBe(9);
    // summary recomputed for the SELECTED range (the whole month)
    expect(view.summary.capacity).toBe(31 * 9);
    expect(view.summary.booked).toBe(11); // 7 (10-08) + 4 distinct slots (10-13)
    expect(view.summary.openKnown).toBe(true);
    expect(view.summary.utilization).toBeCloseTo(11 / (31 * 9), 5);
    expect(view.beyondHorizon).toBe(false);
    expect(view.warnings.some((w) => w.startsWith("Acuity open times not probed yet for 8 days"))).toBe(true);
  });

  test("November 2026: horizon label + pending probe on 11-01; December 2026 (cached empty) keeps grid−booked arithmetic; February 2027 renders honest —", async () => {
    const store = new MemoryStore();
    await seedFeed(store);
    const nov = (await availabilityPageData({ store, today: TODAY, view: { view: "month", month: "2026-11" } })).view as AvailabilityViewPayload;
    expect(nov.beyondHorizon).toBe(true);
    expect(nov.warnings.some((w) => w.includes("Beyond Acuity booking horizon (the booking template ends 2026-11-01)"))).toBe(true);
    expect(byDate(nov.days, "2026-11-01").feedPending).toBe(true);
    expect(byDate(nov.days, "2026-11-01").openCount).toBe(9);
    const d15 = byDate(nov.days, "2026-11-15");
    expect(d15.acuity).toBe("estimated");
    expect(d15.beyondHorizon).toBe(true);
    expect(d15.openCount).toBe(9); // grid − booked arithmetic past the horizon
    expect(nov.summary.openKnown).toBe(true);

    const dec = (await availabilityPageData({ store, today: TODAY, view: { view: "month", month: "2026-12" } })).view as AvailabilityViewPayload;
    expect(byDate(dec.days, "2026-12-05").acuity).toBe("estimated");
    expect(byDate(dec.days, "2026-12-05").openCount).toBe(9); // NEVER a bare 0 for a cached month
    expect(dec.coverage.months.find((m) => m.month === "2026-12")!.offeredDates).toBe(0);

    const feb = (await availabilityPageData({ store, today: TODAY, view: { view: "month", month: "2027-02" } })).view as AvailabilityViewPayload;
    expect(byDate(feb.days, "2027-02-01").acuity).toBe("none");
    expect(byDate(feb.days, "2027-02-01").openCount).toBeNull(); // honest "—" until cached
    expect(feb.summary.openKnown).toBe(false);
    expect(feb.warnings.some((w) => w.includes("No Acuity availability data for February 2027 yet"))).toBe(true);
  });

  test("no feed data at all (demo/first boot): engine output renders everywhere — the existing page behavior", async () => {
    const store = new MemoryStore();
    const s = await seedBase(store);
    s.seed.add({ datetime: etUtc("2026-10-08", "09:00"), client: "Demo Booking" });
    await s.flush();
    const data = await availabilityPageData({ store, today: TODAY, view: { view: "month", month: "2026-10" } });
    const view = data.view as AvailabilityViewPayload;
    expect(view.coverage.noFeedData).toBe(true);
    expect(byDate(view.days, "2026-10-08").acuity).toBe("estimated");
    expect(byDate(view.days, "2026-10-08").openCount).toBe(7); // 9 − 1 booked − 1 turnover-buffer slot (demo continuity — engine output, never "—")
    expect(view.warnings.some((w) => w.startsWith("No Acuity availability data yet"))).toBe(true);
  });
});

// ---------- DAY view — the per-slot state machine (owner §9 example) ----------
describe("availabilityPageData view=day — slot states", () => {
  test("Tue 2026-10-13: BOOKED(+cancelled pair) / BOOKED-PENDING / doubles +1 / BLOCKED(reason) / buffer / feed-beats-buffer OPEN·HOLE", async () => {
    const store = new MemoryStore();
    const s = await seedBase(store);
    s.seed.add({ datetime: etUtc("2026-10-13", "09:00"), client: "Anna Grid" });
    s.seed.add({ datetime: etUtc("2026-10-13", "09:00"), client: "Xavier Cancelled", cancelled: true, cancelledAt: "2026-10-09T15:00:00.000Z" });
    s.seed.add({ datetime: etUtc("2026-10-13", "13:30"), client: "Bea Pending", payment: "pending_payment" });
    s.seed.add({ datetime: etUtc("2026-10-13", "15:30"), client: "Cara Paid" });
    s.seed.add({ datetime: etUtc("2026-10-13", "17:30"), client: "Dan One" });
    s.seed.add({ datetime: etUtc("2026-10-13", "17:30"), client: "Dan Two" });
    await s.flush();
    await seedFeed(store);
    await store.insertBlockedTime({ start_at: etUtc("2026-10-13", "11:00"), end_at: etUtc("2026-10-13", "12:00"), reason: "Studio maintenance" });

    const data = await availabilityPageData({ store, today: TODAY, view: { view: "day", date: "2026-10-13" } });
    const view = data.view as AvailabilityViewPayload;
    expect(view.kind).toBe("day");
    expect(view.label).toBe("Tue, Oct 13, 2026");
    expect(view.slots).not.toBeNull();
    const slots = view.slots as AvailabilitySlotView[];
    // the demo two-block grid, chronological: 9 slots
    expect(slots.map((x) => x.label)).toEqual([
      "9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM",
      "1:30 PM", "2:30 PM", "3:30 PM", "4:30 PM", "5:30 PM",
    ]);

    const booked = slotOf(slots, "9:00 AM");
    expect(booked.status).toBe("booked");
    expect(booked.appointments.map((a) => a.clientName)).toEqual(["Anna Grid"]);
    expect(booked.cancelledAppointments.map((a) => a.clientName)).toEqual(["Xavier Cancelled"]); // struck-through row (Day view only)
    expect(booked.extraCount).toBe(0);

    expect(slotOf(slots, "10:00 AM")).toMatchObject({ status: "blocked", blocked: true, reason: "Turnover buffer (studio padding)" });
    expect(slotOf(slots, "11:00 AM")).toMatchObject({ status: "blocked", blocked: true, reason: "Blocked — Studio maintenance", unexplained: false });

    const pending = slotOf(slots, "1:30 PM");
    expect(pending.status).toBe("booked-pending"); // the placeholder until the owner's pending_payment ruling
    expect(pending.appointments[0].paymentState).toBe("pending_payment");

    // feed offers 2:30 PM and the engine's turnover buffer flags it — Acuity wins inside the horizon
    const feedOpen = slotOf(slots, "2:30 PM");
    expect(feedOpen.status).toBe("open");
    expect(feedOpen.reason).toBe("Offered by Acuity — the engine's turnover buffer flags it");
    expect(feedOpen.isHole).toBe(true); // the ONE hole derivation counts it (current rule)

    expect(slotOf(slots, "3:30 PM").status).toBe("booked");
    const dbl = slotOf(slots, "5:30 PM");
    expect(dbl.status).toBe("booked");
    expect(dbl.appointments).toHaveLength(2); // doubles render as ONE slot
    expect(dbl.extraCount).toBe(1); // the "+1" badge (distinct-slot counting)

    // invariants: the statuses partition the grid; booked-status === engine booked; displayed open = feed ∖ booked
    const dayRow = byDate(view.days, "2026-10-13");
    const countBy = (st: string) => slots.filter((x) => x.status === st).length;
    expect(countBy("booked") + countBy("booked-pending")).toBe(dayRow.booked); // 4 distinct slots
    expect(dayRow.booked).toBe(4);
    expect(dayRow.openCount).toBe(1); // feed ∖ booked = {2:30 PM}
    expect(dayRow.holes).toBe(5); // 9 − 4
    expect(countBy("open") + countBy("blocked")).toBe(5);
    expect(slots.filter((x) => x.isHole).map((x) => x.label)).toEqual(["2:30 PM"]);
    expect(view.offGridAppointments).toHaveLength(0);
  });

  test("Thu 2026-10-08: UNEXPLAINED gray slot (feed silent, free, unblocked) + off-grid feed time row", async () => {
    const store = new MemoryStore();
    const s = await seedBase(store);
    for (const t of ["09:00", "10:00", "11:00", "12:00", "14:30", "16:30", "17:30"]) {
      s.seed.add({ datetime: etUtc("2026-10-08", t), client: `Booked ${t}` });
    }
    await s.flush();
    await seedFeed(store);

    const data = await availabilityPageData({ store, today: TODAY, view: { view: "day", date: "2026-10-08" } });
    const view = data.view as AvailabilitySlotView ? (data.view as AvailabilityViewPayload) : (data.view as AvailabilityViewPayload);
    const slots = view.slots as AvailabilitySlotView[];
    const unexplained = slotOf(slots, "3:30 PM");
    expect(unexplained).toMatchObject({
      status: "blocked",
      blocked: true,
      unexplained: true,
      reason: "Unexplained — not offered by Acuity (candidate block)",
    });
    // the feed's 8:00 AM is OFF the demo two-block grid → an honest extra OPEN row
    const offGrid = slots.find((x) => x.offGrid);
    expect(offGrid).toMatchObject({ time: "08:00", label: "8:00 AM", status: "open" });
    const feedGridOpen = slotOf(slots, "1:30 PM");
    expect(feedGridOpen.status).toBe("open");
    expect(feedGridOpen.offGrid).toBe(false);
    const dayRow = byDate(view.days, "2026-10-08");
    expect(dayRow.openCount).toBe(2); // feed ∖ booked = {08:00 off-grid, 13:30 grid}
    expect(dayRow.holes).toBe(2);
  });

  test("Day view past the horizon (Nov 15): estimated open slots, honest reason; cancelled-only slot renders struck rows", async () => {
    const store = new MemoryStore();
    const s = await seedBase(store);
    s.seed.add({ datetime: etUtc("2026-11-15", "10:00"), client: "Future Booked" });
    s.seed.add({ datetime: etUtc("2026-11-15", "11:00"), client: "Gone Later", cancelled: true, cancelledAt: "2026-11-10T12:00:00.000Z" });
    await s.flush();
    await seedFeed(store);

    const data = await availabilityPageData({ store, today: TODAY, view: { view: "day", date: "2026-11-15" } });
    const view = data.view as AvailabilityViewPayload;
    const slots = view.slots as AvailabilitySlotView[];
    const booked = slotOf(slots, "10:00 AM");
    expect(booked.status).toBe("booked");
    expect(booked.estimated).toBe(true);
    expect(booked.reason).toBe("Beyond the Acuity booking horizon — studio-schedule estimate");
    const freed = slotOf(slots, "11:00 AM");
    expect(freed.status).toBe("open"); // a cancelled record frees its slot
    expect(freed.cancelledAppointments.map((a) => a.clientName)).toEqual(["Gone Later"]);
    expect(freed.reason).toBe("Cancelled — the slot is free again");
    const plain = slotOf(slots, "12:00 PM");
    expect(plain.status).toBe("open");
    expect(plain.estimated).toBe(true);
    expect(view.beyondHorizon).toBe(true);
    // horizon label also present in the month-view warnings of the same range family
    expect(view.warnings.some((w) => w.includes("Beyond Acuity booking horizon"))).toBe(true);
  });
});

// ---------- 14-DAY view ----------
describe("availabilityPageData view=days — the rolling two weeks", () => {
  test("14 rows from the anchor, exact open times where the feed answers, range summary", async () => {
    const store = new MemoryStore();
    const s = await seedBase(store);
    for (const t of ["09:00", "10:00", "11:00", "12:00", "14:30", "16:30", "17:30"]) {
      s.seed.add({ datetime: etUtc("2026-10-08", t), client: `Booked ${t}` });
    }
    await s.flush();
    await seedFeed(store);

    const data = await availabilityPageData({ store, today: TODAY, view: { view: "days", from: "2026-10-06" } });
    const view = data.view as AvailabilityViewPayload;
    expect(view.kind).toBe("days");
    expect(view.days).toHaveLength(14);
    expect(view.days[0].date).toBe("2026-10-06");
    expect(view.days[13].date).toBe("2026-10-19");
    const d08 = view.days[2];
    expect(d08.date).toBe("2026-10-08");
    expect(d08.feedOpenTimes).toEqual(["08:00", "13:30"]);
    expect(d08.openCount).toBe(2);
    // 14-day label composes from the same date formatters
    expect(view.label).toContain("Oct 6");
    expect(view.label).toContain("Oct 19, 2026");
    // summary: capacity 14×9, booked 7, open sums only known days (all known here)
    expect(view.summary.capacity).toBe(14 * 9);
    expect(view.summary.booked).toBe(7);
    expect(view.summary.openKnown).toBe(true);
    expect(view.summary.open).toBeGreaterThan(0);
    // every day row is clickable (the payload carries the date + counts)
    for (const d of view.days) expect(d.totalCapacity).toBe(9);
  });
});

// __PART3__


