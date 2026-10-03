/**
 * HISTORY SEGMENT (management-redesign spec §3C, command-center pass 10/2) —
 * a human-readable activity log instead of a database table:
 *   "Oct 1 · 4:19 PM — Christopher created the 'Booking Performance' template"
 * Each row expands (native details/summary) for the technical audit detail —
 * Field, Before, After, Record ID, raw Timestamp, stored details — so the
 * normal view communicates what happened and audit detail remains available.
 * Filters (Action · Subject · Actor · Date range) are CLIENT-SIDE views over
 * the one server read — no route/API/data change, and no record is ever
 * removed from the system: with no filters applied every event is listed.
 *
 * SUBJECT FIX (refinement spec §5, kept): subjects render as EMPLOYEE NAME +
 * PIP TITLE (template name for template events) resolved server-side — raw
 * IDs never render as a subject/employee anywhere. An event whose PIP row is
 * gone still names what it can: "Deleted record" is never shown as a raw ID.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { getPerformanceHistory } from "~/server/pip-api";
import type { PipEventView } from "~/server/pip-api";
import { EmptyState, PerformanceShell, inputClass } from "~/components/performance-shell";
import { InfoTip } from "~/components/InfoTip";

export const Route = createFileRoute("/performance-history")({
  loader: () => getPerformanceHistory(),
  component: HistoryPage,
});

const EVENT_LABELS: Record<string, string> = {
  pip_created: "Draft created",
  pip_edited: "Draft edited",
  pip_observation_changed: "Observations changed",
  pip_issued: "Issued (snapshot v1 frozen)",
  pip_completed: "Completed",
  pip_cancelled: "Cancelled",
  pip_checkin_added: "Check-in added",
  pip_template_created: "Template created",
  pip_template_updated: "Template updated",
  pip_template_deleted: "Template deleted",
};

/** Human sentence for one event — the actor renders separately. */
function eventSentence(e: PipEventView, subject: string): string {
  const subj = `“${subject}”`;
  switch (e.event_type) {
    case "pip_created":
      return `created draft ${subj}`;
    case "pip_edited":
      return e.field ? `edited ${e.field} on ${subj}` : `edited draft ${subj}`;
    case "pip_observation_changed":
      return `changed manager observations on ${subj}`;
    case "pip_issued":
      return `issued ${subj} — document snapshot frozen`;
    case "pip_completed":
      return `completed ${subj}`;
    case "pip_cancelled":
      return `cancelled ${subj}`;
    case "pip_checkin_added":
      return `recorded a check-in on ${subj}`;
    case "pip_template_created":
      return `created the ${subj} template`;
    case "pip_template_updated":
      return `updated the ${subj} template`;
    case "pip_template_deleted":
      return `deleted the ${subj} template`;
    default:
      return `${e.event_type} — ${subj}`;
  }
}

const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

/** ET date (YYYY-MM-DD) of a stored ISO stamp, or null when unparseable. */
function etDateKey(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(t);
}

function HistoryPage() {
  const data = Route.useLoaderData();
  const pipSubjects = useMemo(() => new Map(data.pipSubjects), [data.pipSubjects]);
  const templateNames = useMemo(() => new Map(data.templateNames), [data.templateNames]);

  const subjectOf = (e: PipEventView): string => {
    if (e.template_id) return templateNames.get(e.template_id) ?? "Deleted template";
    if (e.pip_id) {
      const s = pipSubjects.get(e.pip_id);
      if (s && (s.employee || s.title)) return [s.employee ?? "Unassigned", s.title].filter(Boolean).join(" — ");
      return "Deleted record";
    }
    return "—";
  };

  // Client-side filters (presentation only) — no filters = every event listed.
  const [action, setAction] = useState("");
  const [subject, setSubject] = useState("");
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const filtersActive = action !== "" || subject !== "" || actor !== "" || from !== "" || to !== "";

  const allEvents = useMemo(
    () =>
      [...data.events].sort(
        (a, b) => b.created_at.localeCompare(a.created_at) || (a.id < b.id ? 1 : -1),
      ),
    [data.events],
  );

  const actionOptions = useMemo(() => {
    const set = new Set(allEvents.map((e) => e.event_type));
    return [...set].sort((a, b) => (EVENT_LABELS[a] ?? a).localeCompare(EVENT_LABELS[b] ?? b));
  }, [allEvents]);
  const subjectOptions = useMemo(() => {
    const set = new Set(allEvents.map((e) => subjectOf(e)));
    return [...set].sort((a, b) => a.localeCompare(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allEvents, data.pipSubjects, data.templateNames]);
  const actorOptions = useMemo(() => {
    const set = new Set(allEvents.map((e) => e.actor ?? "—"));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [allEvents]);

  const filtered = useMemo(
    () =>
      allEvents.filter((e) => {
        if (action && e.event_type !== action) return false;
        if (subject && subjectOf(e) !== subject) return false;
        if (actor && (e.actor ?? "—") !== actor) return false;
        if (from || to) {
          const d = etDateKey(e.created_at);
          if (!d) return false;
          if (from && d < from) return false;
          if (to && d > to) return false;
        }
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allEvents, action, subject, actor, from, to, data.pipSubjects, data.templateNames],
  );

  // Group by ET day for the human log ("Oct 1" header, entries beneath).
  const groups = useMemo(() => {
    const out: { day: string; label: string; items: PipEventView[] }[] = [];
    for (const e of filtered) {
      const day = etDateKey(e.created_at) ?? "—";
      let g = out[out.length - 1];
      if (!g || g.day !== day) {
        const t = Date.parse(e.created_at);
        g = { day, label: Number.isNaN(t) ? day : dayFmt.format(t), items: [] };
        out.push(g);
      }
      g.items.push(e);
    }
    return out;
  }, [filtered]);

  const clearFilters = () => {
    setAction("");
    setSubject("");
    setActor("");
    setFrom("");
    setTo("");
  };

  return (
    <PerformanceShell path="/performance-history" tabCounts={{ history: data.events.length }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-[13px] text-(--text-caption)">Every action, with actor and before/after.</p>
          <InfoTip tip="History is never deleted. Technical audit detail stays available inside each row." />
        </div>
        <p className="text-[12px] text-(--text-caption)">
          Showing {filtered.length} of {data.events.length} {data.events.length === 1 ? "event" : "events"}
        </p>
      </div>

      {/* Filters — client-side views over the one read; nothing is removed from the record */}
      <div className="mt-3 flex flex-wrap items-end gap-2" role="group" aria-label="History filters">
        <FilterSelect label="Action" value={action} onChange={setAction} options={actionOptions.map((a) => ({ value: a, label: EVENT_LABELS[a] ?? a }))} />
        <FilterSelect label="Subject" value={subject} onChange={setSubject} options={subjectOptions.map((s) => ({ value: s, label: s }))} />
        <FilterSelect label="Actor" value={actor} onChange={setActor} options={actorOptions.map((a) => ({ value: a, label: a }))} />
        <label className="block text-[13px]">
          <span className="mb-1 block font-medium text-(--text-caption)">From</span>
          <input type="date" className={inputClass + " w-auto"} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="block text-[13px]">
          <span className="mb-1 block font-medium text-(--text-caption)">To</span>
          <input type="date" className={inputClass + " w-auto"} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {filtersActive && (
          <button type="button" className="btn-secondary" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      <div className="mt-4">
        {data.events.length === 0 ? (
          <EmptyState title="No history yet" hint="Actions appear here automatically as they happen." />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No events match these filters"
            hint="Every record is kept — clear a filter to widen the view."
            action={
              <button type="button" className="btn-secondary" onClick={clearFilters}>
                Clear filters
              </button>
            }
          />
        ) : (
          <div className="card overflow-hidden p-0">
            {groups.map((g) => (
              <section key={`${g.day}-${g.items[0]?.id ?? ""}`} aria-label={g.label}>
                <p className="px-4 pb-1 pt-4 text-[11px] font-medium uppercase tracking-[0.12em] text-(--text-muted)">
                  {g.label}
                </p>
                <ul>
                  {g.items.map((e) => (
                    <HistoryRow key={e.id} e={e} subject={subjectOf(e)} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </PerformanceShell>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="block text-[13px]">
      <span className="mb-1 block font-medium text-(--text-caption)">{label}</span>
      <select className={inputClass + " w-auto max-w-[240px]"} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const menuDetailLabel = "text-[11px] font-medium uppercase tracking-[0.08em] text-(--text-muted)";

/** One log entry: time · event kicker · human sentence; expands to audit detail. */
function HistoryRow({ e, subject }: { e: PipEventView; subject: string }) {
  const t = Date.parse(e.created_at);
  const time = Number.isNaN(t) ? "—" : timeFmt.format(t);
  const kicker = EVENT_LABELS[e.event_type] ?? e.event_type;
  const sentence = eventSentence(e, subject);
  const recordId = e.pip_id ? `PIP ${e.pip_id}` : e.template_id ? `Template ${e.template_id}` : "—";
  const detailEntries = Object.entries(e.details ?? {});

  return (
    <li className="border-b border-(--table-border-weak) last:border-0">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-2.5 transition-colors hover:bg-(--hover-row) [&::-webkit-details-marker]:hidden">
          <span className="w-14 shrink-0 pt-0.5 text-[12px] tabular-nums text-(--text-muted)">{time}</span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-(--text-muted)">{kicker}</span>
            </span>
            <span className="mt-0.5 block text-[13px] leading-snug text-(--text-body)">
              <span className="font-medium text-(--text-primary)">{e.actor ?? "—"}</span> {sentence}
            </span>
          </span>
          <span
            aria-hidden="true"
            className="mt-1 shrink-0 text-[10px] text-(--text-muted) transition-transform group-open:rotate-90"
          >
            ▶
          </span>
        </summary>
        {/* Technical audit detail — the record stays fully inspectable */}
        <div className="mb-3 ml-[68px] rounded-md bg-(--surface-inset) px-3 py-3 text-[12px]">
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
            <div className="min-w-0">
              <p className={menuDetailLabel}>Field</p>
              <p className="mt-0.5 break-words text-(--text-body)">{e.field ?? "—"}</p>
            </div>
            <div className="min-w-0">
              <p className={menuDetailLabel}>Record ID</p>
              <p className="mt-0.5 break-all text-(--text-caption)">{recordId}</p>
            </div>
            <div className="min-w-0">
              <p className={menuDetailLabel}>Event ID</p>
              <p className="mt-0.5 break-all text-(--text-caption)">{e.id}</p>
            </div>
          </div>
          <div className="mt-3">
            <p className={menuDetailLabel}>Before → After</p>
            <p className="mt-0.5 break-words text-(--text-caption)">
              <span className="tabular-nums">{e.previous_value == null || e.previous_value === "" ? "—" : e.previous_value}</span>
              <span className="mx-1.5 text-(--text-faint)">→</span>
              <span className="tabular-nums">{e.new_value == null || e.new_value === "" ? "—" : e.new_value}</span>
            </p>
          </div>
          <p className="mt-3">
            <span className={menuDetailLabel}>Timestamp (stored)</span>
            <span className="ml-2 tabular-nums text-(--text-caption)">{e.created_at.replace("T", " ").slice(0, 19)}</span>
          </p>
          {detailEntries.length > 0 && (
            <div className="mt-3">
              <p className={menuDetailLabel}>Details</p>
              <dl className="mt-1 space-y-1">
                {detailEntries.map(([k, v]) => (
                  <div key={k} className="flex flex-wrap gap-x-2">
                    <dt className="text-(--text-caption)">{k}</dt>
                    <dd className="min-w-0 flex-1 break-words text-(--text-body)">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      </details>
    </li>
  );
}
