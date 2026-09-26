/**
 * Guard for the Today-page presentation rules (design/today-redesign-spec §6)
 * — first-match-wins chips, attention ordering + TEAMDENOM gate, delta units.
 * Presentation-side only: everything here composes existing metric outputs.
 * Lives outside src/server so `bun test src/server` counts stay stable.
 */
import { describe, expect, test } from "bun:test";
import {
  attentionNotes,
  availabilityDayMessage,
  availabilityStatusView,
  chipFor,
  deltaValue,
  formatDelta,
  studioClosedOn,
  teamMeansExcluding,
  weekElapsedFraction,
} from "~/components/today-views";
import type { AvailabilityRule, RepPerformanceRow } from "~/server/metrics/compute";

const row = (o: Partial<RepPerformanceRow>): RepPerformanceRow => ({
  repId: "r",
  name: "R",
  totalCalls: 0,
  callsOverThreshold: 0,
  bookingsFromOverThreshold: 0,
  totalBookings: 0,
  conversationConversion: null,
  assignedLeadConversion: null,
  avgCallDurationSeconds: null,
  goal: 0,
  actual: 0,
  goalPercent: null,
  operatingState: "active" as const,
  callStartDate: null,
  ...o,
});

describe("today-views (spec §0/§6)", () => {
  // Fri Sep 25 → 1 working day left (agents work Mon–Fri) → elapsed 5/5 = 1.0
  test("weekElapsedFraction: working days only — Mon 1/5 … Fri 5/5, Sat/Sun 5/5", () => {
    expect(weekElapsedFraction("2026-09-21").toFixed(3)).toBe("0.200"); // Mon
    expect(weekElapsedFraction("2026-09-23").toFixed(3)).toBe("0.600"); // Wed
    expect(weekElapsedFraction("2026-09-25").toFixed(3)).toBe("1.000"); // Fri
    expect(weekElapsedFraction("2026-09-26").toFixed(3)).toBe("1.000"); // Sat — week's work done
    expect(weekElapsedFraction("2026-09-27").toFixed(3)).toBe("1.000"); // Sun
  });

  test("team means exclude self (buildTeamAverages semantics)", () => {
    const rows = [
      row({ repId: "a", totalCalls: 10, totalBookings: 5, conversationConversion: 0.5 }),
      row({ repId: "b", totalCalls: 4, totalBookings: 1, conversationConversion: null }),
    ];
    const a = teamMeansExcluding(rows, "a");
    expect(a.totalCalls).toBe(4);
    expect(a.totalBookings).toBe(1);
    expect(a.conversationConversion).toBeNull(); // b has no value
    expect(a.conversationOthers).toBe(0);
    const b = teamMeansExcluding(rows, "b");
    expect(b.totalCalls).toBe(10);
    expect(b.conversationConversion).toBe(0.5);
    expect(b.conversationOthers).toBe(1);
  });

  test("chips: first match wins + no-chip guard on data gaps", () => {
    expect(chipFor(row({ goalPercent: 1.1, goal: 14, actual: 16 }), 0.4, 0.714)?.label).toBe("Goal hit");
    expect(
      chipFor(row({ goal: 14, actual: 6, goalPercent: 0.4, conversationConversion: 0.6, callsOverThreshold: 5 }), 0.45, 0.714)
        ?.label,
    ).toBe("Strong converter");
    expect(
      chipFor(row({ goal: 14, actual: 6, goalPercent: 0.4, conversationConversion: 0.3, callsOverThreshold: 5 }), 0.45, 0.714)
        ?.label,
    ).toBe("Needs coaching");
    // conversion vs team is gated by TREND_MIN_DENOMINATOR qualifying calls
    expect(
      chipFor(row({ goal: 14, actual: 6, goalPercent: 0.4, conversationConversion: 0.3, callsOverThreshold: 2 }), 0.45, 0.714)
        ?.label,
    ).toBe("Below pace");
    expect(chipFor(row({ goal: 14, actual: 2, goalPercent: 0.14 }), null, 0.714)?.label).toBe("Below pace");
    expect(chipFor(row({ goal: 14, actual: 11, goalPercent: 0.79 }), null, 0.714)?.label).toBe("On pace");
    expect(chipFor(row({ goal: 0, actual: 0, totalCalls: 0 }), null, 0.714)).toBeNull();
  });

  test("attention: ordering (pace gaps, then deficits, positives last) + exact copy", () => {
    const rows = [
      row({ repId: "a", name: "Ann", goal: 14, actual: 2, goalPercent: 0.14, totalCalls: 10 }), // behind by 8.0
      row({ repId: "b", name: "Ben", goal: 0, actual: 0 }), // no activity (gap 0 — no goal)
      row({ repId: "c", name: "Cy", goal: 14, actual: 16, goalPercent: 1.14, totalCalls: 12 }), // positive
      row({ repId: "d", name: "Dee", goal: 14, actual: 9, goalPercent: 0.64, totalCalls: 4 }), // behind by 1.0
    ];
    const notes = attentionNotes(rows, "2026-09-25");
    expect(notes.map((n) => n.rep)).toEqual(["Ann", "Dee", "Ben", "Cy"]);
    expect(notes[0]!.text).toBe(
      "Ann is behind pace — 2 of 14 bookings with 1 day left (expected ≈ 14.0 by now).",
    );
    expect(notes.at(-1)!.severity).toBe("positive");
    expect(notes.at(-1)!.text).toBe("Cy hit the weekly goal — 16 of 14.");
  });
  test("attention on a WEEKEND: no working days left — honest copy, never '0 days'", () => {
    const rows = [row({ repId: "a", name: "Ann", goal: 14, actual: 2, goalPercent: 0.14, totalCalls: 10 })];
    const notes = attentionNotes(rows, "2026-09-26"); // Saturday
    expect(notes[0]!.text).toBe(
      "Ann is behind pace — 2 of 14 bookings, and the work week is done. Pace resumes Monday.",
    );
  });

  test("attention: conversion notes need TEAMDENOM ≥ 3 value-carrying others", () => {
    const rows = [
      row({ repId: "a", name: "Ann", goal: 14, actual: 12, goalPercent: 0.86, totalCalls: 10, callsOverThreshold: 5, conversationConversion: 0.5 }),
      row({ repId: "c", name: "Cy", goal: 14, actual: 12, goalPercent: 0.86, totalCalls: 12, callsOverThreshold: 6, conversationConversion: 0.7 }),
      row({ repId: "e", name: "Eve", goal: 14, actual: 12, goalPercent: 0.86, totalCalls: 6, callsOverThreshold: 4, conversationConversion: 0.4 }),
      row({ repId: "d", name: "Dee", goal: 14, actual: 11, goalPercent: 0.79, totalCalls: 4, callsOverThreshold: 4, conversationConversion: 0.25 }),
    ];
    // MID-WEEK date (Wed 2026-09-23, 3/5 of the week): expected-to-date for a
    // 14 goal is 8.4, so NO rep is behind pace and the conversion rules can
    // fire. (A Friday date would make the behind-pace rule legitimately win
    // first for Dee — 11 of 14 with the week done — which is its own rule.)
    // only 3 others carry values for each rep → gate passes (≥ 3)
    const notes = attentionNotes(rows, "2026-09-23");
    const dee = notes.find((n) => n.rep === "Dee");
    expect(dee!.text).toBe("Dee is below team average in Conversation Conversion (25.0% vs 53.3%).");
    // Ann (50%) and Cy (70%) sit ABOVE their team means — no conversion note for them.
    const ann = notes.find((n) => n.rep === "Ann");
    expect(ann).toBeUndefined();
    const eve = notes.find((n) => n.rep === "Eve");
    expect(eve!.text).toBe("Eve is below team average in Conversation Conversion (40.0% vs 48.3%).");
    // drop one value-carrying rep → gate fails → no conversion notes
    const thin = rows.map((r) => (r.repId === "e" ? { ...r, conversationConversion: null, callsOverThreshold: 0 } : r));
    expect(attentionNotes(thin, "2026-09-25").some((n) => n.text.includes("Conversation Conversion"))).toBe(false);
  });

  test("deltas: pts for rates, % for counts, null hides", () => {
    expect(formatDelta(deltaValue(0.64, 0.458, "pts"), "pts")).toBe("+18.2 pts vs team");
    expect(formatDelta(deltaValue(74, 68, "pct"), "pct")).toBe("+8.8% vs team");
    expect(formatDelta(deltaValue(2, 9, "pct"), "pct")).toBe("-77.8% vs team");
    expect(deltaValue(5, 0, "pct")).toBeNull();
    expect(deltaValue(null, 3, "pts")).toBeNull();
    expect(formatDelta(null, "pts")).toBeNull();
  });
});

describe("chip fix (ux-charts-tables-spec §9): positive chips need a genuine sample", () => {
  const MIN = 5; // MIN_CONVERSION_SAMPLE — keep in sync with the constant

  test("owner's bug case: 0.0% conversion / 0.0 pts vs team → NO positive chip", () => {
    // rep qualified 6 calls but booked none: 0.0%, team also 0.0% → tied, not exceeding
    const chip = chipFor(
      row({ goal: 0, conversationConversion: 0, callsOverThreshold: 6 }),
      0,
      0.6,
    );
    expect(chip?.kind).not.toBe("positive");
    expect(chip?.label).not.toBe("Strong converter");
  });

  test("all-zero team → no chips at all", () => {
    const rows = [row({ repId: "a", name: "A" }), row({ repId: "b", name: "B" })];
    for (const r of rows) {
      expect(chipFor(r, null, 0.6)).toBeNull();
    }
  });

  test("tiny sample (<5 qualifying calls) → no positive chip, no auto-substituted negative", () => {
    // 60% conversion over only 4 qualifying calls, clearly above the 40% team —
    // still NO Strong converter (sample too thin), and no negative chip either.
    const tiny = row({ goal: 0, conversationConversion: 0.6, callsOverThreshold: MIN - 1 });
    expect(chipFor(tiny, 0.4, 0.6)).toBeNull();
    // boundary: exactly MIN qualifying calls now qualifies
    const ok = row({ goal: 0, conversationConversion: 0.6, callsOverThreshold: MIN });
    expect(chipFor(ok, 0.4, 0.6)).toEqual({ kind: "positive", label: "Strong converter" });
  });

  test("tied with the team average → no positive chip (must EXCEED)", () => {
    const tied = row({ goal: 0, conversationConversion: 0.5, callsOverThreshold: MIN });
    expect(chipFor(tied, 0.5, 0.6)?.kind).not.toBe("positive");
  });

  test("genuine strong performer (valid denominator + ≥5 sample + above team) → chip shows", () => {
    const strong = row({ goal: 0, conversationConversion: 0.9, callsOverThreshold: 12 });
    expect(chipFor(strong, 0.4, 0.6)).toEqual({ kind: "positive", label: "Strong converter" });
  });

  test("no conversion denominator (0 qualifying calls) → never a positive chip", () => {
    const noDenom = row({ goal: 0, conversationConversion: null, callsOverThreshold: 0 });
    expect(chipFor(noDenom, 0.4, 0.6)?.kind).not.toBe("positive");
  });
});

describe("Not Yet Active (call_start_date, owner spec §10)", () => {
  test("not-yet-active rep shows ONLY the Not Yet Active chip — never activity/risk chips", () => {
    const dan = row({ goal: 14, actual: 0, goalPercent: 0, operatingState: "not-yet-active" });
    expect(chipFor(dan, 0.4, 1)).toEqual({ kind: "neutral", label: "Not Yet Active" });
    // even a behind-pace goal state must not surface
    expect(chipFor(dan, null, 1)?.label).toBe("Not Yet Active");
  });

  test("attention rules skip not-yet-active reps entirely (zero calls EXPECTED)", () => {
    const rows = [
      row({ repId: "a", name: "Ann", totalBookings: 3 }),
      row({ repId: "d", name: "Dan", goal: 14, actual: 0, goalPercent: 0, operatingState: "not-yet-active" }),
    ];
    const notes = attentionNotes(rows, "2026-09-24");
    expect(notes.some((n) => n.rep === "Dan")).toBe(false);
  });
});

describe("availability status ladder (owner directive)", () => {
  // The ladder runs only when the studio is OPEN. Low availability is GOOD:
  // 0 open is a success state, never a negative one.
  test("open-day ladder by open-slot count: 0 / 1–2 / 3–5 / 6+ ", () => {
    expect(availabilityStatusView(0, false)).toEqual({ status: "fully-booked", label: "Fully booked", tone: "positive" });
    expect(availabilityStatusView(1, false)).toEqual({ status: "nearly-full", label: "Nearly full", tone: "strong" });
    expect(availabilityStatusView(2, false).status).toBe("nearly-full");
    expect(availabilityStatusView(3, false)).toEqual({
      status: "openings-available",
      label: "Openings available",
      tone: "neutral",
    });
    expect(availabilityStatusView(5, false).status).toBe("openings-available");
    expect(availabilityStatusView(6, false)).toEqual({
      status: "needs-bookings",
      label: "Needs bookings",
      tone: "attention",
    });
    expect(availabilityStatusView(17, false).status).toBe("needs-bookings");
  });

  // CRITICAL RULE: closed is NEVER merged into fully booked — 0-open because
  // every slot is booked and 0-open because the studio is closed are
  // operationally different. Closed wins over every open-day state.
  test("closed day: 'Closed' regardless of count — never 'Fully booked'", () => {
    expect(availabilityStatusView(0, true)).toEqual({ status: "closed", label: "Closed", tone: "muted" });
    expect(availabilityStatusView(0, true).label).not.toBe("Fully booked");
    expect(availabilityStatusView(9, true).status).toBe("closed");
  });

  test("closed test mirrors the open-slot engine (no ACTIVE rule for the weekday)", () => {
    const rule = (weekday: number, active: boolean): AvailabilityRule => ({
      weekday,
      open_time: "09:00",
      close_time: "17:00",
      active,
    });
    const hours = [rule(1, true), rule(5, false), rule(6, true)]; // Mon active, Fri inactive, Sat active
    // 2026-09-25 is a Friday (wd 5): only an INACTIVE rule → closed.
    expect(studioClosedOn("2026-09-25", hours)).toBe(true);
    // 2026-09-21 Monday (wd 1): active rule → open.
    expect(studioClosedOn("2026-09-21", hours)).toBe(false);
    // 2026-09-27 Sunday (wd 0): no rule at all → closed.
    expect(studioClosedOn("2026-09-27", hours)).toBe(true);
    // 2026-09-26 Saturday (wd 6): active rule → open.
    expect(studioClosedOn("2026-09-26", hours)).toBe(false);
    // no rules configured at all → closed (never silently "fully booked")
    expect(studioClosedOn("2026-09-25", [])).toBe(true);
  });

  test("selected-day message: owner-directed copy, closed and booked never share one message", () => {
    expect(availabilityDayMessage("fully-booked")).toBe("Fully booked for today.");
    expect(availabilityDayMessage("closed")).toBe("Studio closed today.");
    expect(availabilityDayMessage("nearly-full")).toBeNull();
    expect(availabilityDayMessage("openings-available")).toBeNull();
    expect(availabilityDayMessage("needs-bookings")).toBeNull();
  });

  test("end-to-end composition: rules + slot counts produce the directed status", () => {
    const hours: AvailabilityRule[] = [
      { weekday: 5, open_time: "09:00", close_time: "17:00", active: true }, // Fri open
      { weekday: 6, open_time: "09:00", close_time: "17:00", active: false }, // Sat inactive = closed
    ];
    const view = (date: string, slots: number) =>
      availabilityStatusView(slots, studioClosedOn(date, hours));
    // Friday with every slot booked: FULLY BOOKED (positive), not "low".
    expect(view("2026-09-25", 0).status).toBe("fully-booked");
    // Friday with openings: ladder by count.
    expect(view("2026-09-25", 2).status).toBe("nearly-full");
    expect(view("2026-09-25", 8).status).toBe("needs-bookings");
    // Saturday with zero slots: CLOSED, never "fully booked".
    expect(view("2026-09-26", 0).status).toBe("closed");
  });
});
