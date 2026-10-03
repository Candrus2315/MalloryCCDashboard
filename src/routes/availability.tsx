import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { getAvailabilityData } from "~/server/queries";
import { OPERATIONAL_TIMEZONE, formatDateHuman, formatDateHumanFull, formatDateShort } from "~/server/date-logic";
import type { AvailabilityDay, DayHoleDetail } from "~/server/page-data";
import {
  availabilityCopyText,
  availabilityKpis,
  capacityStatus,
  connectionView,
  datesToPush,
  dayPrefix,
  slackAvailabilitySummary,
} from "~/components/availability-views";
import { TONE_BADGE_STYLES } from "~/components/DayCardStrip";
import { InfoTip } from "~/components/InfoTip";
// Harmonization Wave 2: the page composes from the shared page primitives
// (Panel / Eyebrow / RatioBar) — same building blocks as Daily/Weekly/Today.
import { Eyebrow, Panel, RatioBar } from "~/components/page-panel";

export const Route = createFileRoute("/availability")({
  loader: () => getAvailabilityData(),
  component: AvailabilityPage,
});

/* ---------------------------------------------------------------------------
   COMMAND-CENTER COMPOSITION (harmonization wave 2 — presentation only; every
   number renders through the SAME payload/formatters as before, so all values
   are identical to the previous page):
     1. compact header — title + the Acuity connection as the live-state chip
     2. AVAILABILITY HERO — Open Today / Open Tomorrow anchors + 7-day totals
     3. NEXT 7 DAYS — the day-card strip (schedule grid), holes adjacency
     4. selected-day detail + dates to push — one two-panel row
   Holes come from the SAME server-side deriveWeeklyHoles the Weekly report
   uses (#34): this page only renders them next to utilization — nothing is
   recomputed here and no number is redefined.
--------------------------------------------------------------------------- */

/** Null renders "—" in stone-300 (never 0) — the Today/Team pages' rule. */
function num(v: string) {
  return v === "—" ? <span className="text-(--text-faint)">—</span> : v;
}
function pctFmt(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

/** Clipboard helper + flash-state copy button — the settings/daily-report pattern. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API unavailable (permissions/HTTP): select-and-copy fallback
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
  variant = "primary",
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
        "rounded-lg px-4 py-2 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
        (state === "copied" ? "bg-(--btn-success) text-white " : base)
      }
    >
      {state === "copied" ? "Copied ✓" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}

/**
 * Capacity-status tone → chip classes. THE shared five-tone map (P5): same
 * constant DayCardStrip uses (quiet success, charcoal, stone, muted amber,
 * plain gray) — no aggressive red/green anywhere (spec §design language).
 */
const TONE_BADGE = TONE_BADGE_STYLES;

/**
 * The 7-day outlook strip — horizontally scrollable row of .day-card buttons,
 * `aria-pressed` on the selected day. Per day: prefix · date, open count,
 * booked/total, utilization + holes (the owner-definition holes, from the
 * payload's deriveWeeklyHoles output — rendered, never recomputed), and the
 * capacity-status chip. When `suppressed` (Acuity disconnected) every count
 * renders "—" — dates are calendar facts, availability numbers are not.
 */
function AvailabilityStrip({
  days,
  today,
  selectedKey,
  onSelect,
  suppressed,
  holesByDate,
}: {
  days: AvailabilityDay[];
  today: string;
  selectedKey: string;
  onSelect: (key: string) => void;
  suppressed: boolean;
  holesByDate: Record<string, DayHoleDetail>;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Availability by day">
      {days.map((d) => {
        const isSelected = d.date === selectedKey;
        const status = suppressed
          ? { label: "Unavailable", tone: "muted" as const }
          : capacityStatus(d.utilization);
        const tone = TONE_BADGE[status.tone];
        const open = suppressed ? "—" : String(d.openSlotTimes.length);
        const detail = suppressed ? "—" : `${d.booked}/${d.totalCapacity} booked`;
        const util = suppressed ? "—" : pctFmt(d.utilization);
        // Holes adjacency: the owner-definition holes for this date ( Weekly
        // report derivation) sits right next to utilization. A day the
        // schedule gives no capacity (closed) has NO holes — "—" would be a
        // value, so the token is omitted entirely; suppressed stays "— · —".
        const hole = holesByDate[d.date];
        const holesTxt = suppressed || !hole || hole.capacity === 0 ? null : `${hole.holes} hole${hole.holes === 1 ? "" : "s"}`;
        return (
          <button
            key={d.date}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onSelect(d.date)}
            className={`day-card ${isSelected ? "day-card-on" : "day-card-off"}`}
          >
            <span className="block whitespace-nowrap text-xs font-medium uppercase tracking-wide text-(--text-caption)">
              {dayPrefix(d.date, today)}
            </span>
            <span className="mt-1.5 block whitespace-nowrap text-xs font-medium uppercase tracking-wide text-(--text-muted)">
              {formatDateShort(d.date)}
            </span>
            <span className="mt-2 block text-2xl font-semibold tracking-tight text-(--text-primary) tabular-nums">
              {open} <span className="text-xs font-normal text-(--text-muted)">open</span>
            </span>
            <span className="mt-1 block text-xs text-(--text-muted) tabular-nums">
              {detail} · {util}
              {holesTxt ? ` · ${holesTxt}` : ""}
            </span>
            <span
              className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${tone.badge}`}
            >
              {tone.dot && <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />}
              {status.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AvailabilityPage() {
  const data = Route.useLoaderData();

  // Hydration-safe clock: the "Xm ago" suffix appears after mount (SSR renders
  // the state label alone), then re-renders every 30s — the shell's trick.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const [selectedKey, setSelectedKey] = useState<string>(data.days[0]?.date ?? "");
  const conn = connectionView(data.connection, nowMs);
  const k = availabilityKpis(data.days);
  const pushList = useMemo(() => datesToPush(data.days), [data.days]);
  const selected = data.days.find((d) => d.date === selectedKey) ?? data.days[0];
  const selectedHole = selected ? data.holesByDate[selected.date] ?? null : null;

  // Honesty banner: store/db clauses + the payload's Acuity warnings
  // (stale/outdated + disconnected sentences arrive pre-composed from the server).
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

  // Scope caption (filters MVP: default all-included view; dropdowns deferred —
  // the scope is stated honestly instead of a control that does nothing).
  const scopeLine =
    data.filters.calendars.length > 0 || data.filters.types.length > 0
      ? `Scope — calendars: ${data.filters.calendars.join(", ") || "all"} · appointment types: ${data.filters.types.join(", ") || "all"}`
      : "Scope — all calendars & appointment types (empty selection = everything counts)";

  // Live-state chip (the connection IS this page's live state) — same chip
  // anatomy as the Current Week/Historical badges on Today/Daily/Team.
  const chipCls =
    conn.tone === "positive"
      ? "border-(--chip-positive-bg) bg-(--chip-positive-bg) text-(--pos-text)"
      : conn.tone === "attention"
        ? "border-(--chip-risk-bg) bg-(--chip-risk-bg) text-(--banner-fg)"
        : "border-(--chip-neutral-bg) bg-(--chip-neutral-bg) text-(--chip-neutral-fg)";
  const chipDot = conn.tone === "positive" ? "bg-(--dot-positive)" : conn.tone === "attention" ? "bg-(--dot-caution)" : "bg-(--dot-muted)";

  return (
    <div className="space-y-5">
      {/* 1 — header & context: title + connection chip on line 1; date · sync ·
             scope demoted to the meta line (Today/Daily anatomy) */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[22px] font-semibold tracking-tight text-(--text-primary)">Availability</h1>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold ${chipCls}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${chipDot}`} aria-hidden="true" />
              {conn.label}
            </span>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-(--text-muted)">
            <span className="tabular-nums">
              Today · {formatDateHuman(data.today)} · {OPERATIONAL_TIMEZONE}
            </span>
            <span aria-hidden="true">·</span>
            <span className="flex items-center gap-1.5" suppressHydrationWarning>
              <span>
                {conn.label}
                {conn.lastSync ? ` · ${conn.lastSync}` : ""}
              </span>
            </span>
            <span aria-hidden="true">·</span>
            <span>{scopeLine}</span>
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

      {/* 2 — AVAILABILITY HERO: Open Today / Open Tomorrow are the anchors
             (what Christopher scans first); the 7-day totals support. The
             utilization bar visualizes the same figure the totals carry. */}
      <section aria-label="Availability summary">
        <Panel className="overflow-hidden">
          <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:divide-x lg:divide-(--table-border-weak)">
            {/* left / primary — today & tomorrow */}
            <div className="p-5 sm:p-6">
              <Eyebrow>Studio Appointment Availability</Eyebrow>
              <div className="mt-4 flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
                <div className="min-w-0">
                  <p className="kpi-label">Open Slots Today</p>
                  <p className="mt-2 text-6xl font-semibold leading-none tracking-tight tabular-nums text-(--text-primary)">
                    {num(conn.unavailable ? "—" : String(k.openToday ?? "—"))}
                  </p>
                  <p className="kpi-sub mt-1.5">
                    {conn.unavailable ? "unavailable until Acuity connects" : "appointments remaining"}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="kpi-label">Open Slots Tomorrow</p>
                  <p className="mt-2 text-4xl font-semibold leading-none tracking-tight tabular-nums text-(--text-primary)">
                    {num(conn.unavailable ? "—" : String(k.openTomorrow ?? "—"))}
                  </p>
                  <p className="kpi-sub mt-1.5">
                    {conn.unavailable ? "unavailable until Acuity connects" : "appointments remaining"}
                  </p>
                </div>
              </div>
              {k.utilization != null && !conn.unavailable && (
                <div className="mt-6">
                  <RatioBar ratio={k.utilization} />
                </div>
              )}
            </div>
            {/* right / supporting — the 7-day totals */}
            <div className="border-t border-(--table-border-weak) p-5 lg:border-t-0">
              <Eyebrow>7-Day Totals</Eyebrow>
              <dl className="mt-4 space-y-4">
                <div>
                  <dt className="text-[13px] font-medium text-(--text-body)">Open Slots Next 7 Days</dt>
                  <dd className="mt-0.5 flex items-baseline gap-2">
                    <span className="text-2xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                      {num(conn.unavailable ? "—" : String(k.openNext7))}
                    </span>
                    <span className="kpi-sub">
                      {conn.unavailable ? "unavailable until Acuity connects" : `of ${k.totalCapacity} capacity`}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-[13px] font-medium text-(--text-body)">Total Capacity</dt>
                  <dd className="mt-0.5 flex items-baseline gap-2">
                    <span className="text-2xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                      {num(conn.unavailable ? "—" : String(k.totalCapacity))}
                    </span>
                    <span className="kpi-sub">slots in 7 days</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-[13px] font-medium text-(--text-body)">Booked Slots</dt>
                  <dd className="mt-0.5 flex items-baseline gap-2">
                    <span className="text-2xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                      {num(conn.unavailable ? "—" : String(k.bookedSlots))}
                    </span>
                    <span className="kpi-sub">of total capacity</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-[13px] font-medium text-(--text-body)">Utilization %</dt>
                  <dd className="mt-0.5 flex items-baseline gap-2">
                    <span className="text-2xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
                      {num(conn.unavailable ? "—" : pctFmt(k.utilization))}
                    </span>
                    <span className="kpi-sub">booked ÷ capacity</span>
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </Panel>
      </section>

      {/* 3 — NEXT 7 DAYS: the schedule grid (day cards), COPY FOR SLACK restrained */}
      <section aria-label="Next 7 days outlook">
        <Panel className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 pt-5">
            <Eyebrow>Next 7 Days</Eyebrow>
            <CopyButton
              label="COPY FOR SLACK"
              variant="secondary"
              text={slackAvailabilitySummary(data.days, pushList)}
              disabled={conn.unavailable}
              disabledTitle="Connect Acuity first — no availability to copy"
            />
          </div>
          <div className="px-5 pb-5 pt-3">
            <AvailabilityStrip
              days={data.days}
              today={data.today}
              selectedKey={selected?.date ?? ""}
              onSelect={setSelectedKey}
              suppressed={conn.unavailable}
              holesByDate={data.holesByDate}
            />
          </div>
        </Panel>
      </section>

      {/* 4 — selected day detail + dates to push */}
      <section className="grid gap-4 lg:grid-cols-3" aria-label="Day detail and booking opportunities">
        {selected && (
          <Panel className="overflow-hidden lg:col-span-2">
            <div className="p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
                <p className="section-heading">
                  {dayPrefix(selected.date, data.today)} — {formatDateHumanFull(selected.date)}
                </p>
                <CopyButton
                  label="COPY AVAILABILITY"
                  text={availabilityCopyText(selected)}
                  disabled={conn.unavailable}
                  disabledTitle="Connect Acuity first — no availability to copy"
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
                <DetailStat label="Total Capacity" value={conn.unavailable ? "—" : String(selected.totalCapacity)} />
                <DetailStat label="Booked" value={conn.unavailable ? "—" : String(selected.booked)} />
                <DetailStat label="Open" value={conn.unavailable ? "—" : String(selected.openSlotTimes.length)} />
                <DetailStat label="Utilization" value={conn.unavailable ? "—" : pctFmt(selected.utilization)} />
                {/* Holes adjacency (wave 2): the owner-definition holes from the
                    payload's deriveWeeklyHoles output — same derivation as the
                    Weekly report; undefined (never 0) on a closed day. */}
                <DetailStat
                  label="Holes"
                  info="Empty booking slots = derived schedule capacity (10/day, 9 on Tuesday) − booked sessions (cancelled excluded) — the same deriveWeeklyHoles the Weekly report and the copied CC Report use. A day with no schedule capacity has no holes."
                  value={conn.unavailable || !selectedHole || selectedHole.capacity === 0 ? "—" : String(selectedHole.holes)}
                />
              </div>
              <div className="mt-4 border-t border-(--table-border-weak) pt-3">
                <p className="kpi-label">Open Times</p>
                <div className="mt-2">
                  {conn.unavailable ? (
                    <p className="text-sm text-(--text-muted)">
                      Acuity connection required — no slots are shown (none are invented) until Acuity connects.
                    </p>
                  ) : selected.totalCapacity === 0 ? (
                    <p className="text-sm text-(--text-muted)">Studio closed — no bookable slots configured for this day.</p>
                  ) : selected.openSlotTimes.length === 0 ? (
                    <p className="text-sm font-medium text-(--text-body)">Fully booked — no appointments remaining.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {selected.openSlotTimes.map((s) => (
                        <span
                          key={s}
                          className="rounded-md bg-(--chip-neutral-bg) px-2 py-1 text-xs font-medium text-(--chip-neutral-fg) tabular-nums"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {/* Availability audit (spec: admin/debug, not prominent) */}
              <details className="mt-4">
                <summary className="cursor-pointer select-none text-xs font-medium text-(--text-muted) hover:text-(--chip-neutral-fg)">
                  Availability audit
                </summary>
                <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-xs text-(--chip-neutral-fg) sm:grid-cols-4">
                  <AuditStat label="Configured Capacity" value={selected.totalCapacity} />
                  <AuditStat label="Acuity Booked" value={selected.booked} />
                  <AuditStat label="Blocked Slots" value={selected.blockedCount} />
                  <AuditStat label="Calculated Open" value={selected.openSlotTimes.length} />
                </div>
                <p className="mt-2 text-xs text-(--text-muted)">
                  booked + blocked + open = configured capacity · computed by the slot engine from studio hours,
                  appointments, blocks and padding
                </p>
              </details>
            </div>
          </Panel>
        )}

        <Panel className="overflow-hidden">
          <div className="p-5">
            <p className="section-heading flex flex-wrap items-center gap-x-2 gap-y-1">
              Dates to Push
              <InfoTip
                tip="Rule-based from actual open capacity — full and closed days excluded."
                label="How Dates to Push is chosen"
              />
            </p>
            <div className="mt-3 space-y-2">
              {conn.unavailable ? (
                <p className="text-sm text-(--text-muted)">Acuity connection required — nothing to push yet.</p>
              ) : pushList.length === 0 ? (
                <p className="text-sm text-(--text-muted)">Nothing to push — every day is fully booked or closed.</p>
              ) : (
                pushList.map((p) => (
                  <div key={p.date} className="flex items-baseline justify-between gap-3 border-b border-(--table-border-weak) pb-2 last:border-0 last:pb-0">
                    <span className="text-[13px] font-medium text-(--text-primary)">{p.label}</span>
                    <span className="text-[13px] text-(--text-caption) tabular-nums">
                      {p.open} opening{p.open === 1 ? "" : "s"} · {pctFmt(p.utilization)} full
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </Panel>
      </section>
    </div>
  );
}

/** Day-detail stat — compact version of KpiMid inside the detail panel. */
function DetailStat({ label, value, info }: { label: string; value: string; info?: string }) {
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
/** Audit row — plain small numbers inside the collapsed details. */
function AuditStat({ label, value }: { label: string; value: number }) {
  return (
    <p>
      <span className="text-(--text-muted)">{label}: </span>
      <span className="font-medium text-(--text-body) tabular-nums">{value}</span>
    </p>
  );
}
