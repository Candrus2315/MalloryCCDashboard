/**
 * Drawer + tooltip content composition tests (merged-build Phase 3).
 * Pure units: tooltip templates per unit (incl. null / thin-sample / partial /
 * non-working honesty), conversion components (numerator + denominator, §2),
 * drawer heading/context, the §16 reconciliation helper, and trend meta
 * markers. September 2026: the 24th (Thu) is a workday, the 26th (Sat) is not.
 */
import { describe, expect, test } from "bun:test";
import {
  assignedConversionLines,
  avgDurationLine,
  buildTrendMeta,
  callRowViews,
  conversionComponents,
  drawerContextLines,
  drawerHeading,
  isPartialBucket,
  leadCohortView,
  overThresholdRows,
  reconciliationText,
  trendTooltip,
  type TrendTooltipInput,
} from "../drawer-views";
import type { TrendPoint } from "~/server/metrics/compute";
import type { AuditCallRow } from "~/server/store/types";

const DAY = "2026-09-24"; // Thursday
const SAT = "2026-09-26"; // Saturday (closed)
const TODAY = "2026-09-24";

const point = (over: Partial<TrendPoint> = {}): TrendPoint => ({
  key: DAY,
  label: "Sep 24",
  bookings: 14,
  calls: 402,
  callsOverThreshold: 38,
  bookingsFromOverThreshold: 14,
  conversationConversion: 14 / 38,
  assignedLeadConversion: 14 / 152,
  avgCallDurationSeconds: 252,
  leads: 152,
  family: 95,
  animalia: 57,
  budgetRef: 100,
  ...over,
});

const tip = (over: Partial<TrendTooltipInput> = {}) =>
  trendTooltip({
    value: 402,
    label: "Sep 24",
    unit: "int",
    noun: "calls",
    point: point(),
    today: "2026-09-30",
    bucketMode: "day",
    ...over,
  });

describe("tooltip templates per unit (exact playbook shapes)", () => {
  test("int (calls): 'Sep 24 · 402 calls'", () => {
    expect(tip()).toEqual({ title: "Sep 24", lines: ["Sep 24 · 402 calls"] });
  });

  test("int (bookings): 'Sep 24 · 14 bookings'", () => {
    expect(tip({ value: 14, noun: "bookings" }).lines).toEqual(["Sep 24 · 14 bookings"]);
  });

  test("int null renders '—', never 0", () => {
    expect(tip({ value: null }).lines).toEqual(["Sep 24 · —"]);
  });

  test("pct conversation: components, never a bare % — '36.8% · 14 of 38'", () => {
    const v = tip({ value: 14 / 38, unit: "pct", pctKind: "conversation", noun: undefined });
    expect(v.lines).toEqual(["36.8% · 14 of 38"]);
  });

  test("pct conversation null → honest thin-sample line (TREND_MIN_DENOMINATOR)", () => {
    const v = tip({ value: null, unit: "pct", pctKind: "conversation", noun: undefined });
    expect(v.lines).toEqual(["— · fewer than 3 calls > threshold"]);
  });

  test("pct assigned-lead conversion: '…% · N of M assigned leads worked'", () => {
    const v = tip({ value: 14 / 152, unit: "pct", pctKind: "assigned", noun: undefined });
    expect(v.lines).toEqual(["9.2% · 14 of 152 assigned leads worked"]);
  });

  test("pct assigned null → thin-sample line", () => {
    const v = tip({ value: null, unit: "pct", pctKind: "assigned", noun: undefined });
    expect(v.lines).toEqual(["— · fewer than 3 assigned leads worked"]);
  });

  test("duration: '4m 12s avg · 38 calls'", () => {
    const v = tip({ value: 252, unit: "duration", noun: undefined, point: point({ calls: 38 }) });
    expect(v.lines).toEqual(["4m 12s avg · 38 calls"]);
  });

  test("duration null renders '—'", () => {
    expect(tip({ value: null, unit: "duration", noun: undefined }).lines).toEqual(["Sep 24 · —"]);
  });

  test("leads: 'Total 402 · Family 250 · Animalia 152 · budget pace 100/day'", () => {
    const v = tip({ noun: "leads", point: point({ leads: 402, family: 250, animalia: 152 }) });
    expect(v.lines).toEqual(["Total 402 · Family 250 · Animalia 152 · budget pace 100/day"]);
  });

  test("leads weekly bucket: weekly budget label", () => {
    const v = tip({ noun: "leads", bucketMode: "week", point: point({ budgetRef: 700 }) });
    expect(v.lines[0]).toContain("budget 700/wk");
  });
});

describe("tooltip honesty markers (partial / non-working)", () => {
  test("today's day bucket → title 'Today · In Progress'", () => {
    expect(tip({ today: TODAY }).title).toBe("Today · In Progress");
  });

  test("past day bucket → plain label title", () => {
    expect(tip({ point: point({ key: "2026-09-23", label: "Sep 23" }), label: "Sep 23" }).title).toBe("Sep 23");
  });

  test("in-progress week bucket (contains today) is partial too", () => {
    const wk = point({ key: "2026-09-21", label: "Wk of Sep 21" });
    expect(isPartialBucket(wk, "2026-09-24", "week")).toBe(true);
    expect(isPartialBucket(wk, "2026-09-28", "week")).toBe(false);
  });

  test("non-working day → '(closed)' line, title unchanged", () => {
    const v = tip({ point: point({ key: SAT, label: "Sep 26", calls: 0 }), value: 0, label: "Sep 26" });
    expect(v.title).toBe("Sep 26");
    expect(v.lines).toContain("(closed)");
    expect(v.lines[0]).toBe("Sep 26 · 0 calls"); // zero shown, never re-labeled as null
  });

  test("week buckets are never 'closed' (Monday keys are workdays)", () => {
    const meta = buildTrendMeta([point({ key: "2026-09-21" })], TODAY, "week");
    expect(meta[0].isNonWorking).toBe(false);
  });
});

describe("trend meta (chart honesty markers)", () => {
  test("partial only on today; non-working only on closed day buckets; split carried", () => {
    const pts = [
      point({ key: "2026-09-23", label: "Sep 23" }),
      point({ key: DAY }), // today
      point({ key: SAT, label: "Sep 26" }),
    ];
    const meta = buildTrendMeta(pts, TODAY, "day");
    expect(meta.map((m) => m.isPartial)).toEqual([false, true, false]);
    expect(meta.map((m) => m.isNonWorking)).toEqual([false, false, true]);
    expect(meta[0].family).toBe(95);
    expect(meta[0].animalia).toBe(57);
    expect(meta.map((m) => m.key)).toEqual(["2026-09-23", DAY, SAT]);
  });
});

describe("drawer heading + context lines (§3 context preservation)", () => {
  test("heading: 'Calls — Sep 24'", () => {
    expect(drawerHeading("Calls", "Sep 24")).toBe("Calls — Sep 24");
  });

  test("historical week label surfaces verbatim as the first context line", () => {
    const lines = drawerContextLines({
      rangeLabel: "Week of Sep 21",
      isHistorical: true,
      thresholdSeconds: 120,
      count: 38,
      scopeLabel: "Roster calls",
    });
    expect(lines[0]).toBe("Historical · Week of Sep 21");
    expect(lines[1]).toBe("Roster calls · threshold 120s");
    expect(lines[2]).toBe("38 records");
  });

  test("live range keeps the plain label; count omitted when null", () => {
    const lines = drawerContextLines({
      rangeLabel: "This Week",
      isHistorical: false,
      thresholdSeconds: 120,
      count: null,
    });
    expect(lines).toEqual(["This Week", "threshold 120s"]);
  });
});

describe("§16 reconciliation helper", () => {
  test("match → affirmative text", () => {
    const r = reconciliationText(38, 38);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("matches the chart");
  });

  test("mismatch → never silently hidden", () => {
    const r = reconciliationText(402, 38);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("402");
    expect(r.text).toContain("38");
  });
});

describe("per-metric drawer content", () => {
  const auditRow = (over: Partial<AuditCallRow> = {}): AuditCallRow => ({
    external_call_id: "ext-1",
    conversation_id: null,
    rep_id: "u1",
    rep_name: "Christy",
    rep_is_active: true,
    provider_rep_external_id: null,
    contact_id: null,
    contact_name: null,
    contact_external_id: null,
    contact_resolution_method: null,
    direction: "Outbound",
    call_status: null,
    started_at: "2026-09-24T14:30:00.000Z",
    duration_seconds: 185,
    over_threshold: true,
    et_date: DAY,
    started_at_et: "10:30:00",
    ...over,
  });

  test("conversion components line — numerator + denominator always (§2)", () => {
    expect(conversionComponents(14, 38)).toBe(
      "14 bookings from qualifying calls / 38 calls > 2 min / 36.8%",
    );
  });

  test("conversion components with thin denominator: components stay, pct goes '—'", () => {
    expect(conversionComponents(2, 2)).toBe("2 bookings from qualifying calls / 2 calls > 2 min / —");
  });

  test("avg duration line: '4m 12s average across 38 calls'; null → honest empty", () => {
    expect(avgDurationLine(point({ calls: 38 }))).toBe("4m 12s average across 38 calls");
    expect(avgDurationLine(point({ avgCallDurationSeconds: null }))).toBe("— · no calls in this bucket");
  });

  test("assigned conversion lines: components from the same point; null → thin-sample", () => {
    expect(assignedConversionLines(point())).toEqual(["9.2% · 14 of 152 assigned leads worked"]);
    expect(assignedConversionLines(point({ assignedLeadConversion: null }))).toEqual([
      "— · fewer than 3 assigned leads worked",
    ]);
  });

  test("call row views map audit fields; missing data renders '—', never blank", () => {
    const [v] = callRowViews([auditRow()]);
    expect(v.time).toBe("10:30:00");
    expect(v.rep).toBe("Christy");
    expect(v.contact).toBe("—");
    expect(v.direction).toBe("Outbound");
    expect(v.duration).toBe("3m 05s");
    expect(v.status).toBe("—");
  });

  test("over-threshold filter feeds the Calls Over 2 Min drawer", () => {
    const rows = [auditRow(), auditRow({ external_call_id: "ext-2", over_threshold: false })];
    expect(overThresholdRows(rows).map((r) => r.external_call_id)).toEqual(["ext-1"]);
  });

  test("lead cohort view: split + getLeadCohort source dates (Thu → previous day) + honesty note", () => {
    const lc = leadCohortView(point({ leads: 402, family: 250, animalia: 152 }), "day");
    expect(lc.split).toBe("Total 402 · Family 250 · Animalia 152 · budget pace 100/day");
    expect(lc.cohort).toHaveLength(1);
    expect(lc.cohort[0]).toContain("Sep 23");
    expect(lc.note).toContain("not loaded yet");
  });

  test("lead cohort view in week mode omits the per-day cohort (a cohort is per-day)", () => {
    const lc = leadCohortView(point({ key: "2026-09-21" }), "week");
    expect(lc.cohort).toEqual([]);
  });
});
