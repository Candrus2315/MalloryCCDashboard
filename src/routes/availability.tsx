import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { getAvailabilityData } from "~/server/queries";
import { OPERATIONAL_TIMEZONE, formatDateHuman, formatDateHumanFull, formatDateShort } from "~/server/date-logic";
import type { AvailabilityDay } from "~/server/page-data";
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

export const Route = createFileRoute("/availability")({
  loader: () => getAvailabilityData(),
  component: AvailabilityPage,
});

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
 * booked/total, utilization + capacity-status chip. When `suppressed`
 * (Acuity disconnected) every count renders "—" — dates are calendar facts,
 * availability numbers are not.
 */
function AvailabilityStrip({
  days,
  today,
  selectedKey,
  onSelect,
  suppressed,
}: {
  days: AvailabilityDay[];
  today: string;
  selectedKey: string;
  onSelect: (key: string) => void;
  suppressed: boolean;
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
        return (
          <button
            key={d.date}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onSelect(d.date)}
            className={`day-card ${isSelected ? "day-card-on" : "day-card-off"}`}
          >
            <span className="block text-xs font-medium uppercase tracking-wide text-(--text-caption)">
              {dayPrefix(d.date, today)}
            </span>
            <span className="block text-xs font-medium uppercase tracking-wide text-(--text-muted)">
              {formatDateShort(d.date)}
            </span>
            <span className="mt-2 block text-2xl font-semibold tracking-tight text-(--text-primary) tabular-nums">
              {open} <span className="text-xs font-normal text-(--text-muted)">open</span>
            </span>
            <span className="mt-1 block text-xs text-(--text-muted) tabular-nums">
              {detail} · {util}
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

  const connDot =
    conn.tone === "positive" ? "bg-(--dot-positive)" : conn.tone === "attention" ? "bg-(--dot-caution)" : "bg-(--dot-muted)";

  return (
    <div className="space-y-5">
      {/* 1 — header & context */}
      <header>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h1 className="text-xl font-semibold tracking-tight text-(--text-primary)">Availability</h1>
          <span className="text-[15px] font-medium text-(--text-faint)" aria-hidden="true">
            —
          </span>
          <span className="text-[15px] font-medium text-(--text-caption)">Studio Appointment Availability</span>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--text-caption)">
          <span className="flex items-center gap-1.5">
            <span className="h-1 w-1 shrink-0 rounded-full bg-(--dot-muted)" aria-hidden="true" />
            <span>
              Today · {formatDateHuman(data.today)} · {OPERATIONAL_TIMEZONE}
            </span>
          </span>
          <span className="text-(--text-faint)" aria-hidden="true">
            ·
          </span>
          <span className="flex items-center gap-1.5" suppressHydrationWarning>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${connDot}`} aria-hidden="true" />
            <span>
              {conn.label}
              {conn.lastSync ? ` · ${conn.lastSync}` : ""}
            </span>
          </span>
          <span className="text-(--text-faint)" aria-hidden="true">
            ·
          </span>
          <span>{scopeLine}</span>
        </p>
        {bannerMessages.length > 0 && (
          <div className="status-banner mt-2" role="status">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--dot-caution)" aria-hidden="true" />
            <span className="min-w-0 truncate" title={bannerMessages.join(" · ")}>
              {bannerMessages.join(" · ")}
            </span>
          </div>
        )}
      </header>

      {/* 2 — top KPI hierarchy: Open Today / Open Tomorrow dominant */}
      <section aria-label="Availability summary">
        <div className="card grid grid-cols-2 gap-y-6 p-0 sm:grid-cols-3 xl:grid-cols-6 xl:gap-y-0 xl:divide-x xl:divide-(--table-border-weak)">
          <KpiHero
            label="Open Slots Today"
            value={conn.unavailable ? "—" : String(k.openToday ?? "—")}
            sub={conn.unavailable ? "unavailable until Acuity connects" : "appointments remaining"}
          />
          <KpiHero
            label="Open Slots Tomorrow"
            value={conn.unavailable ? "—" : String(k.openTomorrow ?? "—")}
            sub={conn.unavailable ? "unavailable until Acuity connects" : "appointments remaining"}
          />
          <KpiHero
            label="Open Slots Next 7 Days"
            value={conn.unavailable ? "—" : String(k.openNext7)}
            sub={conn.unavailable ? "unavailable until Acuity connects" : `of ${k.totalCapacity} capacity`}
          />
          <KpiMid
            label="Total Capacity"
            value={conn.unavailable ? "—" : String(k.totalCapacity)}
            sub="slots in 7 days"
          />
          <KpiMid
            label="Booked Slots"
            value={conn.unavailable ? "—" : String(k.bookedSlots)}
            sub="of total capacity"
          />
          <KpiMid
            label="Utilization %"
            value={conn.unavailable ? "—" : pctFmt(k.utilization)}
            sub="booked ÷ capacity"
          />
        </div>
      </section>

      {/* 3 — 7-day outlook, full width */}
      <section aria-label="Next 7 days outlook">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
          <p className="section-heading">Next 7 Days</p>
          <CopyButton
            label="COPY FOR SLACK"
            variant="secondary"
            text={slackAvailabilitySummary(data.days, pushList)}
            disabled={conn.unavailable}
            disabledTitle="Connect Acuity first — no availability to copy"
          />
        </div>
        <div className="mt-3">
          <AvailabilityStrip
            days={data.days}
            today={data.today}
            selectedKey={selected?.date ?? ""}
            onSelect={setSelectedKey}
            suppressed={conn.unavailable}
          />
        </div>
      </section>

      {/* 4 — selected day detail + dates to push */}
      <section className="grid gap-4 lg:grid-cols-3" aria-label="Day detail and booking opportunities">
        {selected && (
          <div className="card card-dense lg:col-span-2">
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
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              <DetailStat label="Total Capacity" value={conn.unavailable ? "—" : String(selected.totalCapacity)} />
              <DetailStat label="Booked" value={conn.unavailable ? "—" : String(selected.booked)} />
              <DetailStat label="Open" value={conn.unavailable ? "—" : String(selected.openSlotTimes.length)} />
              <DetailStat label="Utilization" value={conn.unavailable ? "—" : pctFmt(selected.utilization)} />
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
        )}

        <div className="card card-dense">
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
      </section>
    </div>
  );
}

/** Hero KPI cell (Today-page pattern): label → big number → subtext. */
function KpiHero({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="px-5 py-4">
      <p className="kpi-label">{label}</p>
      <p className="kpi-hero mt-2">{num(value)}</p>
      {sub && <p className="kpi-sub mt-1.5">{sub}</p>}
    </div>
  );
}
/** Secondary KPI cell (Today-page pattern): same stack at text-3xl. */
function KpiMid({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="px-5 py-4">
      <p className="kpi-label">{label}</p>
      <p className="kpi-mid mt-2">{num(value)}</p>
      {sub && <p className="kpi-sub mt-1.5">{sub}</p>}
    </div>
  );
}
/** Day-detail stat — compact version of KpiMid inside the detail panel. */
function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="kpi-label">{label}</p>
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
