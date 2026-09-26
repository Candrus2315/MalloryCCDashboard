/**
 * Presentation-side compositions for the Availability page
 * (design/availability-spec.md + merged-build playbook Phase 1). Everything
 * here is arithmetic on the AV1 payload (`availabilityPageData`) — no new
 * metrics, no new queries, nothing redefines a number the slot engine
 * (`computeDayAvailability`) produced. Pure functions so page logic is
 * unit-testable without DOM, mirroring today-views.ts / team-views.ts.
 */
import { addDays, formatDateHuman } from "~/server/date-logic";
import type { AvailabilityConnection, AvailabilityDay } from "~/server/page-data";

// ---------- capacity status (spec §capacity labels — configurable, no letter grades) ----------

export interface CapacityThresholds {
  /** Utilization fraction at/above which a day reads "Full" (spec: 100%). */
  full: number;
  /** At/above → "Nearly full" (spec: 85%). */
  nearlyFull: number;
  /** At/above → "Healthy"; below → "Needs bookings" (spec: 60%). */
  healthy: number;
}

/** Spec thresholds, in the payload's utilization unit (booked/capacity, 0..1). */
export const DEFAULT_CAPACITY_THRESHOLDS: CapacityThresholds = { full: 1, nearlyFull: 0.85, healthy: 0.6 };

export type CapacityStatus = "full" | "nearly-full" | "healthy" | "needs-bookings" | "no-data";

export interface CapacityStatusView {
  status: CapacityStatus;
  label: string;
  /** Presentation tone — same five-tone family as DayCardStrip (no red/green alarms). */
  tone: "positive" | "strong" | "neutral" | "attention" | "muted";
}

/**
 * The spec ladder: 100% Full · 85%+ Nearly Full · 60–84% Healthy · <60% Needs
 * Bookings; null → "—". `utilization` is the payload's FRACTION (0..1) — the
 * spec's percentages are the same boundaries ×100. First match wins.
 */
export function capacityStatus(
  utilization: number | null,
  thresholds: CapacityThresholds = DEFAULT_CAPACITY_THRESHOLDS,
): CapacityStatusView {
  if (utilization == null) return { status: "no-data", label: "—", tone: "muted" };
  if (utilization >= thresholds.full) return { status: "full", label: "Full", tone: "positive" };
  if (utilization >= thresholds.nearlyFull) return { status: "nearly-full", label: "Nearly full", tone: "strong" };
  if (utilization >= thresholds.healthy) return { status: "healthy", label: "Healthy", tone: "neutral" };
  return { status: "needs-bookings", label: "Needs bookings", tone: "attention" };
}

// ---------- day labels (ET calendar dates, UTC-formatted like date-logic) ----------

/** "Today" / "Tomorrow" / short weekday, relative to the payload's ET today. */
export function dayPrefix(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  return formatDateHuman(date).split(",")[0];
}

/** Long weekday for copy text, e.g. "Saturday" (date-logic only ships short). */
export function weekdayLong(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

/** Push-list label, e.g. "Sun Sep 27" — the spec's "Sun Sep 27 — 8 openings" shape. */
export function pushDayLabel(date: string): string {
  return formatDateHuman(date).replace(", ", " "); // "Sun, Sep 27" → "Sun Sep 27"
}

// ---------- page KPIs (presentation sums over the 7-day payload) ----------

export interface AvailabilityKpis {
  openToday: number | null;
  openTomorrow: number | null;
  openNext7: number;
  totalCapacity: number;
  bookedSlots: number;
  utilization: number | null;
}

/**
 * The spec's top-summary numbers, summed over the 7-day payload. Pure
 * aggregation — Open Today/Tomorrow read days[0]/days[1]; the 7-day totals
 * sum every day; utilization is booked ÷ capacity over the same window
 * (null when the studio has no configured capacity — never a fake 0%).
 */
export function availabilityKpis(days: AvailabilityDay[]): AvailabilityKpis {
  let openNext7 = 0;
  let totalCapacity = 0;
  let bookedSlots = 0;
  for (const d of days) {
    openNext7 += d.openSlotTimes.length;
    totalCapacity += d.totalCapacity;
    bookedSlots += d.booked;
  }
  return {
    openToday: days[0] ? days[0].openSlotTimes.length : null,
    openTomorrow: days[1] ? days[1].openSlotTimes.length : null,
    openNext7,
    totalCapacity,
    bookedSlots,
    utilization: totalCapacity > 0 ? bookedSlots / totalCapacity : null,
  };
}

// ---------- dates to push (spec §booking opportunities — rule-based, not AI) ----------

export interface PushItem {
  date: string;
  /** "Sun Sep 27" */
  label: string;
  /** Open slot count — the actual number being pushed. */
  open: number;
  utilization: number | null;
}

/**
 * Best dates to push, ranked from ACTUAL open capacity: Full days (nothing
 * left to fill) and closed/no-hours days (capacity 0) are excluded — there
 * is nothing to push on either. Most open slots first; ties break by date
 * ascending (chronological when the room is equal). Default top 3 — "best
 * dates" reads as the short list a morning scan can act on.
 */
export function datesToPush(days: AvailabilityDay[], limit = 3): PushItem[] {
  return days
    .filter((d) => d.totalCapacity > 0 && d.openSlotTimes.length > 0)
    .sort(
      (a, b) =>
        b.openSlotTimes.length - a.openSlotTimes.length ||
        (a.date < b.date ? -1 : a.date > b.date ? 1 : 0),
    )
    .slice(0, limit)
    .map((d) => ({
      date: d.date,
      label: pushDayLabel(d.date),
      open: d.openSlotTimes.length,
      utilization: d.utilization,
    }));
}

// ---------- copy actions (spec §copy actions) ----------

/**
 * COPY AVAILABILITY — the spec's exact shape:
 * "Saturday Availability — 5 appointments remaining: 10:00 AM / 11:30 AM / …"
 * Honest zero states: fully booked vs studio closed are different sentences.
 */
export function availabilityCopyText(day: AvailabilityDay): string {
  const head = `${weekdayLong(day.date)} Availability`;
  if (day.totalCapacity === 0) return `${head} — studio closed (no bookable slots configured)`;
  if (day.openSlotTimes.length === 0) return `${head} — fully booked (no appointments remaining)`;
  return `${head} — ${day.openSlotTimes.length} appointments remaining: ${day.openSlotTimes.join(" / ")}`;
}

/** "Best dates to push: Sun Sep 27 — 8 openings · Mon Sep 28 — 6 openings". */
export function bestDatesToPushLine(pushList: PushItem[]): string {
  if (pushList.length === 0) return "Best dates to push: none — every day is fully booked or closed.";
  return `Best dates to push: ${pushList.map((p) => `${p.label} — ${p.open} opening${p.open === 1 ? "" : "s"}`).join(" · ")}`;
}

/**
 * COPY FOR SLACK — per-day openings for the whole payload window plus the
 * best-dates line, all from actual payload numbers.
 */
export function slackAvailabilitySummary(days: AvailabilityDay[], pushList: PushItem[]): string {
  const lines: string[] = ["Studio availability — next 7 days (ET):"];
  for (const d of days) {
    const util = d.utilization == null ? "—" : `${(d.utilization * 100).toFixed(1)}%`;
    lines.push(`• ${formatDateHuman(d.date)}: ${d.openSlotTimes.length} open of ${d.totalCapacity} (${util} full)`);
  }
  lines.push("", bestDatesToPushLine(pushList));
  return lines.join("\n");
}

// ---------- connection freshness (spec §data freshness — honest states only) ----------

export interface ConnectionView {
  /** Honest state label: "Connected" / "Demo data" / "Acuity connection required." */
  label: string;
  /** "Last synced 12m ago" — null until mounted or when there is no timestamp. */
  lastSync: string | null;
  /** true → the page suppresses slot numbers (no fabrication while Acuity is away). */
  unavailable: boolean;
  /** Presentation dot tone. */
  tone: "positive" | "neutral" | "attention";
}

/** Same wording family as the shell's formatAge (root FreshnessIndicator). */
export function lastSyncLabel(lastSyncAt: string | null, nowMs: number | null): string | null {
  if (!lastSyncAt || nowMs == null) return null;
  const ms = Date.parse(lastSyncAt);
  if (!Number.isFinite(ms)) return null;
  const mins = Math.max(0, Math.round((nowMs - ms) / 60_000));
  if (mins < 1) return "Last synced just now";
  if (mins < 60) return `Last synced ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Last synced ${hours}h ${mins % 60}m ago`;
  return `Last synced ${Math.floor(hours / 24)}d ago`;
}

/**
 * The header freshness view. Disconnected is the loud honest state ("Acuity
 * connection required." + unavailable → the page renders no slot numbers);
 * live turns attention-toned when stale (the exact "Availability may be
 * outdated — …" sentence ships in the payload's warnings banner).
 */
export function connectionView(c: AvailabilityConnection, nowMs: number | null): ConnectionView {
  const lastSync = lastSyncLabel(c.lastSyncAt, nowMs);
  if (!c.connected || c.mode === "disconnected") {
    return { label: "Acuity connection required.", lastSync: null, unavailable: true, tone: "attention" };
  }
  if (c.mode === "demo") {
    return { label: "Demo data", lastSync, unavailable: false, tone: "neutral" };
  }
  return { label: "Connected", lastSync, unavailable: false, tone: c.stale ? "attention" : "positive" };
}
