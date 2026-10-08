import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { getAvailabilityData, refreshAvailabilityFeed } from "~/server/queries";
import { OPERATIONAL_TIMEZONE, addDays, etSyncStamp, formatDateHuman, formatDateHumanFull, formatDateShort } from "~/server/date-logic";
import type {
  AvailabilityPageView,
  AvailabilityRangeDay,
  AvailabilitySlotView,
  AvailabilityViewRawSearch,
} from "~/server/page-data";
import { availabilityCopyText, capacityStatus, connectionView } from "~/components/availability-views";
import { TONE_BADGE_STYLES } from "~/components/DayCardStrip";
import { InfoTip } from "~/components/InfoTip";
import { Eyebrow, Panel, RatioBar } from "~/components/page-panel";

/* ---------------------------------------------------------------------------
   AVAILABILITY REBUILD PR-3 — the rebuilt page over the range-view payload
   (Month default / 14-Day / Day + Dates to Push + Copy + Filters + Sync).
   Every number renders the payload (ONE engine + ONE hole derivation + the
   PR-1 feed cache); the copy texts are the byte-frozen server formatters.
--------------------------------------------------------------------------- */

export const Route = createFileRoute("/availability")({
  validateSearch: (search: Record<string, unknown>): AvailabilityViewRawSearch => {
    const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
    return {
      view: s(search.view) ?? "month", // month is the DEFAULT view (owner §2 directive)
      month: s(search.month),
      from: s(search.from),
      date: s(search.date),
      cal: s(search.cal),
      type: s(search.type),
      st: s(search.st),
    };
  },
  loader: ({ search }) => getAvailabilityData({ data: search }),
  component: AvailabilityPage,
});

function num(v: string) {
  return v === "—" ? <span className="text-(--text-faint)">—</span> : v;
}
function pctFmt(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}
function pctWhole(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

/** Clipboard helper + flash-state copy button (the settings/daily-report pattern). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
function CopyButton({
  label,
  text,
  variant = "secondary",
  disabled = false,
  disabledTitle,
}: {
  label: string;
  text: string;
  variant?: "primary" | "secondary";
  disabled?: boolean;
  disabledTitle?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const base =
    variant === "primary"
      ? "bg-(--accent-solid) text-(--accent-solid-fg) hover:bg-(--accent-hover)"
      : "border border-(--card-border) text-(--text-caption) hover:border-(--input-border) hover:text-(--text-primary)";
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? disabledTitle : undefined}
      onClick={async () => {
        const ok = await copyText(text);
        setState(ok ? "copied" : "failed");
        setTimeout(() => setState("idle"), 2500);
      }}
      className={
        "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
        (state === "copied" ? "bg-(--btn-success) text-white " : base)
      }
    >
      {state === "copied" ? "Copied ✓" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}

const TONE_BADGE = TONE_BADGE_STYLES;

/** Per-slot chip styling — the shared five-tone family (no red/green alarms). */
const SLOT_CHIP: Record<AvailabilitySlotView["status"], { label: string; tone: keyof typeof TONE_BADGE }> = {
  booked: { label: "BOOKED", tone: "strong" },
  "booked-pending": { label: "BOOKED-PENDING", tone: "attention" },
  open: { label: "OPEN", tone: "positive" },
  blocked: { label: "BLOCKED", tone: "neutral" },
  cancelled: { label: "CANCELLED", tone: "muted" },
  closed: { label: "CLOSED", tone: "muted" }, // PR-3 §5: chips agree with the day's real 0 open
};

/** The displayed open set for one day — the copy's honest input. */
function displayedOpenTimes(d: AvailabilityRangeDay): string[] | null {
  if (d.feedOpenTimes) return d.feedOpenTimes;
  if (d.openCount == null) return null;
  if (d.openCount === 0) return [];
  return d.openSlotTimes;
}

function dayPrefix(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  return formatDateHuman(date).split(",")[0];
}

function monthWeeks(dates: string[]): (string | null)[][] {
  if (dates.length === 0) return [];
  const firstDow = new Date(`${dates[0]}T12:00:00Z`).getUTCDay();
  const cells: (string | null)[] = [...Array<null>(firstDow).fill(null), ...dates];
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function AvailabilityPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const view = data.view as AvailabilityPageView | undefined;
  const conn = connectionView(data.connection, null);
  const suppressed = conn.unavailable;

  const go = (patch: Partial<AvailabilityViewRawSearch>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }) });

  const selectedDay = useMemo(() => {
    if (!view || view.kind !== "day") return null;
    return view.days.find((d) => d.date === view.date) ?? null;
  }, [view]);

  // month navigation (pure string math over the view's month key)
  const monthNav = (dir: 1 | -1) => {
    if (!view) return;
    const [y, m] = view.month.split("-").map(Number);
    const zero = y * 12 + (m - 1) + dir;
    const nm = `${String(Math.floor(zero / 12)).padStart(4, "0")}-${String((zero % 12) + 1).padStart(2, "0")}`;
    go({ view: "month", month: nm, date: undefined, from: undefined });
  };

  // ---- refresh control state ----
  const [refresh, setRefresh] = useState<{ state: "idle" | "busy" | "done"; line?: string }>({ state: "idle" });
  const doRefresh = async () => {
    setRefresh({ state: "busy" });
    try {
      const res = await refreshAvailabilityFeed({ data: { dates: view?.dates ?? [] } });
      const line =
        res.outcome === "synced"
          ? `Refreshed — ${res.callsMade ?? 0} Acuity calls, ${res.datesProbed ?? 0} dates probed.`
          : res.reason === "no-credentials"
            ? "Refresh skipped — demo mode never calls Acuity."
            : res.reason === "sync-in-progress"
              ? "Refresh skipped — a feed sync is already running."
              : `Refresh failed — ${res.error ?? res.reason ?? "unknown"}.`;
      setRefresh({ state: "done", line });
    } catch {
      setRefresh({ state: "done", line: "Refresh failed — the server could not run the feed sync." });
    }
  };

  // ---- filter state (from the search params; the payload already applied them) ----
  const activeCal = (search.cal ?? "").split(",").filter(Boolean);
  const activeType = (search.type ?? "").split(",").filter(Boolean);
  const activeSt = (search.st ?? "").split(",").filter(Boolean);
  const typeOptions = activeCal.length === 1
    ? (view?.filterOptions.types ?? []).filter((t) => t.calendarIds.includes(activeCal[0]))
    : (view?.filterOptions.types ?? []);
  const setFilters = (patch: { cal?: string; type?: string; st?: string }) => go(patch);
  const filtersActive = activeCal.length > 0 || activeType.length > 0 || activeSt.length > 0;

  // honesty banner
  const bannerMessages = useMemo(() => {
    const msgs: string[] = [];
    if (data.meta.mode === "memory") {
      let s = "In-memory store";
      if (data.meta.dbReason) s += ` — Database not connected: ${data.meta.dbReason}`;
      msgs.push(s);
    } else if (data.meta.dbReason) {
      msgs.push(`Database warning: ${data.meta.dbReason}`);
    }
    return [...msgs, ...data.warnings];
  }, [data.meta, data.warnings]);

  // header connection chip classes — declared BEFORE the fail-closed guard,
  // which renders the same chip in its unavailable panel (TDZ: a const used
  // in a return above its declaration throws ReferenceError at runtime).
  const chipCls =
    conn.tone === "positive"
      ? "border-(--chip-positive-bg) bg-(--chip-positive-bg) text-(--pos-text)"
      : conn.tone === "attention"
        ? "border-(--chip-risk-bg) bg-(--chip-risk-bg) text-(--banner-fg)"
        : "border-(--chip-neutral-bg) bg-(--chip-neutral-bg) text-(--chip-neutral-fg)";
  const chipDot = conn.tone === "positive" ? "bg-(--dot-positive)" : conn.tone === "attention" ? "bg-(--dot-caution)" : "bg-(--dot-muted)";

  // FAIL-CLOSED GUARD (2026-10-07 outage): a payload without a view (loader
  // error, legacy shape, any future fail-closed variant) must render the
  // honest unavailable panel — never crash SSR/hydration into a blank page.
  // All hooks above already ran, so hook order stays stable across renders.
  if (!view) {
    return (
      <div className="space-y-5">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-[22px] font-semibold tracking-tight text-(--text-primary)">Availability</h1>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold ${chipCls}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${chipDot}`} aria-hidden="true" />
                {conn.label}
              </span>
            </div>
            <p className="mt-0.5 text-[13px] text-(--text-muted)">
              Today · {formatDateHuman(data.today)} · {OPERATIONAL_TIMEZONE}
            </p>
          </div>
          {bannerMessages.length > 0 && (
            <p className="status-banner" role="status">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--dot-caution)" aria-hidden="true" />
              <span className="min-w-0 truncate" title={bannerMessages.join(" · ")}>
                {bannerMessages.join(" · ")}
              </span>
            </p>
          )}
        </header>
        <section aria-label="Unavailable">
          <Panel className="p-5 sm:p-6">
            <Eyebrow>Availability unavailable</Eyebrow>
            <p className="mt-2 max-w-prose text-sm text-(--text-body)">
              The availability payload could not be built, so no calendar is rendered — no invented slots (fail-closed rule). Check the Sync Center in Settings; a failing sync names its cause there.
            </p>
            {data.warnings.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs text-(--text-caption)">
                {data.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </Panel>
        </section>
      </div>
    );
  }

  const dayByDate = new Map(view.days.map((d) => [d.date, d]));
  const summary = view.summary;

  return (
    <div className="space-y-5">
      {/* 1 — header */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[22px] font-semibold tracking-tight text-(--text-primary)">Availability</h1>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold ${chipCls}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${chipDot}`} aria-hidden="true" />
              {conn.label}
            </span>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-(--text-muted)">
            <span className="tabular-nums">
              Today · {formatDateHuman(data.today)} · {OPERATIONAL_TIMEZONE}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Scope — {activeCal.length > 0 || activeType.length > 0 ? "page filters active" : "all calendars & types (Settings scope)"}
              {filtersActive ? "" : " (empty = everything counts)"}
            </span>
          </p>
        </div>
        {bannerMessages.length > 0 && (
          <p className="status-banner" role="status">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--dot-caution)" aria-hidden="true" />
            <span className="min-w-0 truncate" title={bannerMessages.join(" · ")}>
              {bannerMessages.join(" · ")}
            </span>
          </p>
        )}
      </header>

      {/* 2 — summary + view switcher */}
      <section aria-label="Range summary">
        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 pt-5">
            <Eyebrow>{view.label}</Eyebrow>
            <div className="flex items-center gap-1" role="group" aria-label="View">
              {(
                [
                  ["month", "Month"],
                  ["days", "14-Day"],
                  ["day", "Day"],
                ] as const
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={view.kind === kind}
                  onClick={() =>
                    kind === "month"
                      ? go({ view: "month", month: undefined, date: undefined, from: undefined })
                      : kind === "days"
                        ? go({ view: "days", from: data.today, month: undefined, date: undefined })
                        : go({ view: "day", date: view.kind === "day" ? view.date : data.today, month: undefined, from: undefined })
                  }
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    view.kind === kind ? "bg-(--accent-solid) text-(--accent-solid-fg)" : "border border-(--card-border) text-(--text-caption) hover:text-(--text-primary)"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 pb-5 pt-3 sm:grid-cols-5">
            <SummaryStat label="Capacity" value={num(String(summary.capacity))} />
            <SummaryStat label="Booked" value={num(String(summary.booked))} />
            <SummaryStat label="Open" value={summary.openKnown ? num(String(summary.open)) : "—"} />
            <SummaryStat
              label="Holes"
              info="The ONE hole derivation — the locked rule: schedule capacity − booked (cancelled excluded). A feed-closed day counts ALL its grid slots as holes (owner ruling 2026-10-06); BLOCKED slots render BLOCKED, never pushable."
              value={num(String(summary.holes))}
            />
            <SummaryStat label="Utilization" value={pctFmt(summary.utilization)} />
          </div>
        </Panel>
      </section>

      {/* 3 — the view body */}
      <section aria-label="Availability views">
        <Panel className="overflow-hidden">
          {view.kind === "month" && (
            <div className="p-5">
              <div className="flex items-center justify-between pb-3">
                <button type="button" onClick={() => monthNav(-1)} className="rounded-lg border border-(--card-border) px-3 py-1.5 text-xs font-medium text-(--text-caption) hover:text-(--text-primary)">
                  ← Previous
                </button>
                <p className="text-sm font-medium text-(--text-primary)">{view.label}</p>
                <button type="button" onClick={() => monthNav(1)} className="rounded-lg border border-(--card-border) px-3 py-1.5 text-xs font-medium text-(--text-caption) hover:text-(--text-primary)">
                  Next →
                </button>
              </div>
              <div className="grid grid-cols-7 gap-1.5">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((w) => (
                  <p key={w} className="pb-1 text-center text-xs font-medium uppercase tracking-wide text-(--text-faint)">
                    {w}
                  </p>
                ))}
                {monthWeeks(view.dates).flatMap((week, wi) =>
                  week.map((date, di) => {
                    if (date == null) return <div key={`${wi}-${di}`} />;
                    const d = dayByDate.get(date)!;
                    const status = suppressed ? null : capacityStatus(d.utilization);
                    const tone = status ? TONE_BADGE[status.tone] : null;
                    return (
                      <button
                        key={date}
                        type="button"
                        onClick={() => go({ view: "day", date })}
                        className={`day-card day-card-off flex min-h-[92px] flex-col items-start rounded-xl p-2 text-left ${date === data.today ? "ring-1 ring-(--input-border)" : ""}`}
                      >
                        <span className={`text-xs font-medium ${date === data.today ? "text-(--text-primary)" : "text-(--text-caption)"}`}>
                          {Number(date.slice(8))}
                        </span>
                        <span className="mt-1 text-xl font-semibold leading-none tabular-nums text-(--text-primary)">
                          {suppressed || d.openCount == null ? "—" : d.openCount}
                          {!suppressed && d.openCount != null && <span className="ml-1 text-[10px] font-normal text-(--text-muted)">open</span>}
                        </span>
                        <span className="mt-1 text-[10px] tabular-nums text-(--text-muted)">
                          {suppressed ? "—" : `${d.holes}h · ${pctWhole(d.utilization)}`}
                          {d.acuity === "estimated" ? " · est" : ""}
                        </span>
                        {tone && status && (
                          <span className={`mt-auto inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tone.badge}`}>
                            {tone.dot && <span className={`mr-1 h-1 w-1 rounded-full ${tone.dot}`} aria-hidden="true" />}
                            {status.label}
                          </span>
                        )}
                      </button>
                    );
                  }),
                )}
              </div>
              {view.beyondHorizon && (
                <p className="mt-3 text-xs text-(--text-muted)">
                  Beyond the Acuity booking horizon{view.coverage.horizonDate ? ` (the booking template ends ${view.coverage.horizonDate})` : ""} — capacity from the studio schedule; open times estimated (grid − booked).
                </p>
              )}
            </div>
          )}

          {view.kind === "days" && (
            <div className="p-5">
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-(--table-border-weak) text-left text-xs uppercase tracking-wide text-(--text-faint)">
                      <th className="py-2 pr-3 font-medium">Date</th>
                      <th className="py-2 pr-3 text-right font-medium">Openings</th>
                      <th className="py-2 pr-3 text-right font-medium">Holes</th>
                      <th className="py-2 pr-3 text-right font-medium">Capacity</th>
                      <th className="py-2 pr-3 text-right font-medium">Booked</th>
                      <th className="py-2 pr-3 text-right font-medium">Utilization</th>
                      <th className="py-2 font-medium">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.days.map((d) => {
                      const status = suppressed ? null : capacityStatus(d.utilization);
                      const tone = status ? TONE_BADGE[status.tone] : null;
                      return (
                        <tr key={d.date} className="cursor-pointer border-b border-(--table-border-weak) last:border-0 hover:bg-(--chip-neutral-bg)" onClick={() => go({ view: "day", date: d.date })}>
                          <td className="py-2 pr-3 font-medium text-(--text-primary)">
                            {dayPrefix(d.date, data.today)} — {formatDateHumanFull(d.date)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{suppressed || d.openCount == null ? "—" : d.openCount}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{suppressed ? "—" : d.holes}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{suppressed ? "—" : d.totalCapacity}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{suppressed ? "—" : d.booked}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{suppressed ? "—" : pctFmt(d.utilization)}</td>
                          <td className="py-2">
                            {tone && status ? (
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${tone.badge}`}>
                                {tone.dot && <span className={`mr-1 h-1 w-1 rounded-full ${tone.dot}`} aria-hidden="true" />}
                                {status.label}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {view.kind === "day" && (
            <div className="p-5">
              {selectedDay && (
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 pb-4 sm:grid-cols-5">
                  <SummaryStat label="Total Capacity" value={suppressed ? "—" : String(selectedDay.totalCapacity)} />
                  <SummaryStat label="Booked" value={suppressed ? "—" : String(selectedDay.booked)} />
                  <SummaryStat label="Open" value={suppressed || selectedDay.openCount == null ? "—" : String(selectedDay.openCount)} />
                  <SummaryStat label="Utilization" value={suppressed ? "—" : pctFmt(selectedDay.utilization)} />
                  <SummaryStat label="Holes" value={suppressed ? "—" : String(selectedDay.holes)} />
                </div>
              )}
              <div className="border-t border-(--table-border-weak) pt-3">
                <p className="kpi-label">Slots</p>
                <div className="mt-2 space-y-1.5">
                  {(view.slots ?? []).map((s) => {
                    const chip = SLOT_CHIP[s.status];
                    const tone = TONE_BADGE[chip.tone];
                    const isHole = s.isHole && (s.status === "open" || s.status === "cancelled");
                    const names = s.appointments.map((a) => a.clientName ?? a.id);
                    const detail =
                      s.status === "booked" || s.status === "booked-pending"
                        ? `${names.join(", ")}${s.extraCount > 0 ? ` (+${s.extraCount})` : ""}${s.appointments[0]?.appointmentType ? ` — ${s.appointments[0].appointmentType}` : ""}`
                        : s.reason ?? "";
                    return (
                      <div key={`${s.time}-${s.offGrid ? "off" : "grid"}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-(--table-border-weak) pb-1.5 last:border-0">
                        <span className="w-20 shrink-0 text-[13px] font-medium tabular-nums text-(--text-primary)">{s.label}</span>
                        <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone.badge}`}>
                          {isHole ? "OPEN · HOLE" : chip.label}
                        </span>
                        <span className={`min-w-0 flex-1 truncate text-xs ${s.unexplained ? "text-(--text-faint) italic" : "text-(--text-muted)"}`} title={s.reason ?? undefined}>
                          {detail}
                          {s.offGrid ? " (off-grid Acuity time)" : ""}
                        </span>
                        {s.cancelledAppointments.length > 0 && (
                          <span className="min-w-0 flex-1 text-xs text-(--text-faint) line-through">
                            cancelled: {s.cancelledAppointments.map((a) => a.clientName ?? a.id).join(", ")}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {(view.slots ?? []).length === 0 && (
                    <p className="text-sm text-(--text-muted)">
                      {suppressed
                        ? "Acuity connection required — no slots are shown (none are invented) until Acuity connects."
                        : activeSt.length > 0
                          ? "No slots match the active status filters."
                          : "Studio closed — no bookable slots configured for this day."}
                    </p>
                  )}
                </div>
              </div>
              {view.offGridAppointments.length > 0 && (
                <div className="mt-4 border-t border-(--table-border-weak) pt-3">
                  <p className="kpi-label">Off-grid appointments</p>
                  <p className="mt-1 text-xs text-(--text-muted)">
                    {view.offGridAppointments.map((a) => `${a.clientName ?? a.id} — ${a.appointmentType}`).join(" · ")}
                  </p>
                </div>
              )}
              {selectedDay && displayedOpenTimes(selectedDay) != null && (
                <div className="mt-4 border-t border-(--table-border-weak) pt-3">
                  <div className="flex items-center justify-between">
                    <p className="kpi-label">Open Times</p>
                    <CopyButton
                      label="COPY AVAILABILITY"
                      text={availabilityCopyText({
                        date: selectedDay.date,
                        totalCapacity: selectedDay.totalCapacity,
                        booked: selectedDay.booked,
                        openSlotTimes: displayedOpenTimes(selectedDay) ?? [],
                        utilization: selectedDay.utilization,
                        blockedCount: selectedDay.blockedCount,
                      } as Parameters<typeof availabilityCopyText>[0])}
                      disabled={suppressed || selectedDay.totalCapacity === 0}
                      disabledTitle={selectedDay.totalCapacity === 0 ? "Studio closed — nothing to copy" : "Connect Acuity first"}
                    />
                  </div>
                  <p className="mt-1.5 text-sm tabular-nums text-(--text-body)">
                    {(displayedOpenTimes(selectedDay) ?? []).length === 0
                      ? selectedDay.totalCapacity === 0
                        ? "Studio closed — no bookable slots configured for this day."
                        : "Fully booked — no appointments remaining."
                      : (displayedOpenTimes(selectedDay) ?? []).join(" / ")}
                  </p>
                </div>
              )}
            </div>
          )}
        </Panel>
      </section>

      {/* 4 — filters bar */}
      <section aria-label="Filters">
        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-end gap-x-5 gap-y-3 p-5">
            <div>
              <p className="kpi-label">Studio</p>
              <select
                value={activeCal[0] ?? ""}
                onChange={(e) => setFilters({ cal: e.target.value, type: "" })}
                className="mt-1 rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1.5 text-[13px] text-(--text-body)"
              >
                <option value="">All Studios</option>
                {view.filterOptions.calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <p className="kpi-label">Appointment type</p>
              <select
                value={activeType[0] ?? ""}
                onChange={(e) => setFilters({ type: e.target.value })}
                className="mt-1 rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1.5 text-[13px] text-(--text-body)"
              >
                <option value="">All types</option>
                {typeOptions.map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
              {view.filterOptions.calendars.length === 0 && <p className="mt-1 text-[11px] text-(--text-faint)">Options appear after the first availability feed sync caches the catalog.</p>}
            </div>
            <div>
              <p className="kpi-label">Status (Day view slot list)</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {(["booked", "open", "holes", "cancelled", "blocked"] as const).map((st) => {
                  const on = activeSt.includes(st);
                  return (
                    <button
                      key={st}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setFilters({ st: (on ? activeSt.filter((x) => x !== st) : [...activeSt, st]).join(",") || undefined })
                      }
                      className={`rounded-full px-2.5 py-1 text-xs font-medium uppercase tracking-wide transition-colors ${
                        on ? "bg-(--accent-solid) text-(--accent-solid-fg)" : "border border-(--card-border) text-(--text-caption) hover:text-(--text-primary)"
                      }`}
                    >
                      {st}
                    </button>
                  );
                })}
              </div>
            </div>
            {filtersActive && (
              <button type="button" onClick={() => setFilters({ cal: undefined, type: undefined, st: undefined })} className="rounded-lg border border-(--card-border) px-3 py-1.5 text-xs font-medium text-(--text-caption) hover:text-(--text-primary)">
                Clear filters
              </button>
            )}
            <p className="ml-auto max-w-xs text-[11px] leading-snug text-(--text-faint)">
              Calendar/type filters narrow what Settings already includes (server-side). Status toggles filter the Day view's slot list — counts stay whole-day.
            </p>
          </div>
        </Panel>
      </section>

      {/* 5 — Dates to Push + Copy + Sync */}
      <section className="grid gap-4 lg:grid-cols-3" aria-label="Push, copy and sync">
        <Panel className="overflow-hidden">
          <div className="p-5">
            <p className="section-heading flex flex-wrap items-center gap-x-2 gap-y-1">
              Dates to Push
              <InfoTip
                tip="Priority-sorted: (1) holes, (2) large open counts, (3) low utilization, (4) near-term. Full days, closed days, past days and uncovered days are never listed. Click a date to open its Day view."
                label="How Dates to Push is chosen"
              />
            </p>
            <p className="mt-1 text-[11px] uppercase tracking-wide text-(--text-faint)">{view.pushRangeLabel}</p>
            <div className="mt-3 space-y-2">
              {suppressed ? (
                <p className="text-sm text-(--text-muted)">Acuity connection required — nothing to push yet.</p>
              ) : view.datesToPush.length === 0 ? (
                <p className="text-sm text-(--text-muted)">Nothing to push — every day is fully booked or closed.</p>
              ) : (
                view.datesToPush.map((p) => (
                  <button
                    key={p.date}
                    type="button"
                    onClick={() => go({ view: "day", date: p.date, month: undefined, from: undefined })}
                    className="flex w-full items-baseline justify-between gap-3 border-b border-(--table-border-weak) pb-2 text-left last:border-0 last:pb-0 hover:text-(--text-primary)"
                  >
                    <span className="text-[13px] font-medium text-(--text-primary)">{p.label}</span>
                    <span className="text-[13px] tabular-nums text-(--text-caption)">
                      {p.openings} open · {p.holes} hole{p.holes === 1 ? "" : "s"} · {p.booked}/{p.capacity} · {pctWhole(p.utilization)} full
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </Panel>

        <Panel className="overflow-hidden">
          <div className="p-5">
            <p className="section-heading">Copy Availability</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <CopyButton label="TODAY" text={view.copy.today} disabled={suppressed} disabledTitle="Connect Acuity first" />
              <CopyButton label="NEXT 7 DAYS" text={view.copy.next7} disabled={suppressed} disabledTitle="Connect Acuity first" />
              <CopyButton label="NEXT 14 DAYS" text={view.copy.next14} disabled={suppressed} disabledTitle="Connect Acuity first" />
              <CopyButton label="DATES TO PUSH" text={view.copy.datesToPush} disabled={suppressed || view.datesToPush.length === 0} disabledTitle="Nothing to push" />
              {view.copy.day && <CopyButton label="THIS DAY" text={view.copy.day} variant="primary" />}
            </div>
            <div className="mt-3 flex items-end gap-2 border-t border-(--table-border-weak) pt-3">
              <div>
                <p className="kpi-label">A specific date (next 14 days)</p>
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) void copyText(view.copy.byDate[e.target.value] ?? "");
                  }}
                  className="mt-1 w-full rounded-lg border border-(--input-border) bg-(--input-bg) px-2 py-1.5 text-[13px] text-(--text-body)"
                >
                  <option value="">Pick a date to copy…</option>
                  {view.copy.copyDates.map((d) => (
                    <option key={d} value={d}>
                      {formatDateShort(d)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-snug text-(--text-faint)">Format frozen — "AVAILABILITY TO PUSH" + one line per day ("Wed Oct 7 — 2 Open | 1 Hole | 80% Full").</p>
          </div>
        </Panel>

        <Panel className="overflow-hidden">
          <div className="p-5">
            <div className="flex items-center justify-between gap-2">
              <p className="section-heading">Sync</p>
              <button
                type="button"
                onClick={doRefresh}
                disabled={refresh.state === "busy"}
                className="rounded-lg border border-(--card-border) px-3 py-1.5 text-xs font-medium text-(--text-caption) hover:border-(--input-border) hover:text-(--text-primary) disabled:opacity-50"
              >
                {refresh.state === "busy" ? "Refreshing…" : "REFRESH"}
              </button>
            </div>
            <dl className="mt-3 space-y-2 text-[13px]">
              <div className="flex justify-between gap-3">
                <dt className="text-(--text-muted)">Acuity (appointments)</dt>
                <dd className="tabular-nums text-(--text-body)">
                  {data.connection.connected ? `Last synced ${data.connection.lastSyncAt ? etSyncStamp(data.connection.lastSyncAt) : "—"}` : "Disconnected"}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-(--text-muted)">Availability feed</dt>
                <dd className="tabular-nums text-(--text-body)">
                  {view.sync.feedLastSuccessAt ? etSyncStamp(view.sync.feedLastSuccessAt) : "never ran"}
                  {view.sync.feedRuns[0]?.callsMade != null ? ` · ${view.sync.feedRuns[0].callsMade} calls` : ""}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="flex items-center gap-1 text-(--text-muted)">
                  Coverage horizon
                  <InfoTip tip="The Acuity booking template's end — the last date any calendar still offers slots. Months past it answer [] (empty ≠ closed); capacity there comes from the studio schedule." label="About the coverage horizon" />
                </dt>
                <dd className="tabular-nums text-(--text-body)">{view.sync.coverageHorizonDate ? `Template ends ${view.sync.coverageHorizonDate}` : "no cached data"}</dd>
              </div>
            </dl>
            {refresh.line && <p className="mt-2 text-xs text-(--text-caption)">{refresh.line}</p>}
            <div className="mt-3 border-t border-(--table-border-weak) pt-3">
              <p className="kpi-label flex items-center gap-2">
                Discrepancies
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${view.sync.discrepancies.count > 0 ? "bg-(--chip-risk-bg) text-(--banner-fg)" : "bg-(--chip-neutral-bg) text-(--chip-neutral-fg)"}`}>
                  {view.sync.discrepancies.count}
                </span>
                <InfoTip tip="Feed-vs-truth mismatches: expected open = canonical grid − booked; the feed's answer compared against it, both sides shown. Rows drop off when a later run no longer sees them." label="About discrepancies" />
              </p>
              <div className="mt-2 space-y-2">
                {view.sync.discrepancies.rows.length === 0 ? (
                  <p className="text-xs text-(--text-muted)">None — the feed and the booked truth agree on every probed slot.</p>
                ) : (
                  view.sync.discrepancies.rows.map((r) => (
                    <div key={`${r.calendarId}-${r.dateEt}-${r.timeEt}-${r.kind}`} className="text-xs">
                      <p className="font-medium tabular-nums text-(--text-primary)">
                        {r.dateEt} {r.timeEt} · <span className="uppercase text-(--text-caption)">{r.kind.replaceAll("-", " ")}</span>
                      </p>
                      <p className="text-(--text-muted)">
                        Acuity: {r.acuitySide}
                        {r.acuitySide === "open" ? " (offers the slot)" : " (silent)"} · Booked:{" "}
                        {r.bookedCount === 0 ? "none" : r.booked.map((b) => `${b.client ?? b.type ?? "unknown"}`).join(", ")} · Grid: {r.grid}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </Panel>
      </section>
    </div>
  );
}

function SummaryStat({ label, value, info }: { label: string; value: string; info?: string }) {
  return (
    <div>
      <p className="kpi-label flex items-center gap-1.5">
        {label}
        {info && <InfoTip tip={info} label={`About ${label}`} />}
      </p>
      <p className="kpi-mid mt-1.5">{num(value)}</p>
    </div>
  );
}
