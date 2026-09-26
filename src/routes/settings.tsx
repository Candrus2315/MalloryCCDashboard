import { createFileRoute } from "@tanstack/react-router";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { WarningList } from "~/components/warnings";
import {
  addBlockedTime,
  assignAttribution,
  getSettingsData,
  removeBlockedTime,
  saveAcuityScope,
  saveRecurringBlocks,
  saveRepGoals,
  saveRepMappings,
  saveRepStartDates,
  saveSettings,
  saveSheetMapping,
  saveStudioRules,
  saveWeekGoal,
  setLeadCount,
  setLeadWorkDate,
  syncNow,
} from "~/server/queries";

export const Route = createFileRoute("/settings")({
  loader: () => getSettingsData(),
  component: SettingsPage,
});

import { SHEET_MODE_LABELS, type SheetMappingMode } from "~/server/sync/sheets-mapping";
import { DEFAULT_COLUMN_MAPPING, DEFAULT_COLUMN_MAPPING_DAY_COUNT } from "~/server/store/types";

const COLUMN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const SHEET_FIELDS_LEAD: { key: string; label: string }[] = [
  { key: "source_date", label: "Date" },
  { key: "name", label: "Name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "lead_type", label: "Lead Type (optional)" },
];
const SHEET_FIELDS_DAY: { key: string; label: string }[] = [
  { key: "source_date", label: "Date" },
  { key: "count", label: "Lead count" },
  { key: "lead_type", label: "Lead Type (optional)" },
];
const SHEET_MODE_OPTIONS: { value: SheetMappingMode; label: string; hint: string }[] = [
  { value: "row_per_day_count", label: SHEET_MODE_LABELS.row_per_day_count, hint: "one row per day, a count column says how many leads" },
  { value: "row_per_lead", label: SHEET_MODE_LABELS.row_per_lead, hint: "one row per lead, with phone/email" },
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function SettingsPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setFlash(null);
    try {
      await fn();
      setFlash(label);
      await router.invalidate();
    } catch (e) {
      setFlash(e instanceof Error ? `Error: ${e.message}` : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-sm text-stone-400">Goals, integrations, studio rules and manual corrections — every change persists and is audited.</p>
      </div>

      {!data.passphraseConfigured && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <span className="font-medium">Passphrase protection is not configured.</span> Set the DASHBOARD_PASSPHRASE secret to require a passphrase — the gate is enforced server-side on every page and endpoint.
        </div>
      )}
      {data.meta.mode === "memory" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <span className="font-medium">Running on in-memory demo data</span>
          {data.meta.dbReason ? ` — ${data.meta.dbReason}` : ""}. Edits persist for this server session only.
        </div>
      )}
      <WarningList items={data.staleWarnings} />
      {flash && <p className="text-sm font-medium text-emerald-700">{flash}</p>}

      {/* ---------- Weekly goals ---------- */}
      <section className="space-y-3">
        <div>
          <p className="section-title">Weekly booking goal &amp; lead budget</p>
          <p className="mt-1 text-[13px] text-stone-500">Edit any week — past weeks keep history, future weeks are the plan. Changes are audited.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table min-w-[720px]">
            <thead>
              <tr>
                <th className="text-left">Week</th>
                <th className="text-right">Booking goal</th>
                <th className="text-right">Lead budget</th>
                <th className="text-left"></th>
              </tr>
            </thead>
            <tbody>
              {data.editorWeeks.map((w) => (
                <WeekGoalRow key={w.weekStart} week={w} busy={busy} onSave={(goal, budget) => run(`Goal saved for week of ${w.weekStart}`, () => saveWeekGoal({ data: { weekStart: w.weekStart, bookingGoal: goal, leadBudget: budget } }))} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------- Rep goals ---------- */}
      <RepGoalsSection data={data} busy={busy} onSave={(weekStart, goals) => run(`Rep goals saved for ${weekStart}`, () => saveRepGoals({ data: { weekStart, goals } }))} />

      {/* ---------- Roster mapping (owner terminology: mapping drives eligibility) ---------- */}
      <RosterMappingSection data={data} busy={busy} onSave={(mappings) => run("Roster mappings saved", () => saveRepMappings({ data: { mappings } }))} />

      {/* ---------- Rep start dates (call_start_date → "Not Yet Active") ---------- */}
      <RepStartDatesSection data={data} busy={busy} onSave={(entries) => run("Rep start dates saved", () => saveRepStartDates({ data: { entries } }))} />

      {/* ---------- Core operational settings ---------- */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <CoreOpsCard data={data} busy={busy} onSave={(thresholdSeconds, windowHours) => run("Operational settings saved", () => saveSettings({ data: { thresholdSeconds, windowHours } }))} />
        <AcuityScopeCard data={data} busy={busy} onSave={(calendars, types) => run("Acuity scope saved", () => saveAcuityScope({ data: { calendars, types } }))} />
      </section>

      {/* ---------- Sheet column mapping ---------- */}
      <section className="space-y-3">
        <div>
          <p className="section-title">Sheet column mapping</p>
          <p className="mt-1 text-[13px] text-stone-500">Which columns of the Family / Animalia sheets hold each field, and whether each row is a day+count or a single lead. Test mapping fetches a REAL sample row from Google Sheets and parses it with the same code a live sync uses.</p>
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {(["family", "animalia"] as const).map((sheet) => (
            <SheetMappingCard key={sheet} sheet={sheet} columns={data.settings.sheets[sheet].columns} mode={data.settings.sheets[sheet].mode} sheetId={data.settings.sheets[sheet].sheet_id} busy={busy} onSave={(columns, mode) => run(`${sheet} mapping saved`, () => saveSheetMapping({ data: { sheet, columns, mode } }))} />
          ))}
        </div>
      </section>

      {/* ---------- Studio / availability ---------- */}
      <section className="space-y-3">
        <div>
          <p className="section-title">Studio &amp; availability</p>
          <p className="mt-1 text-[13px] text-stone-500">Slot engine inputs (used by Today&apos;s open-slot counts) plus blocked times. The operational time zone is a data-model decision and is intentionally read-only.</p>
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <StudioRulesCard data={data} busy={busy} onSave={(payload) => run("Studio rules saved", () => saveStudioRules({ data: payload }))} />
          <RecurringBlocksCard data={data} busy={busy} onSave={(blocks) => run("Recurring blocks saved", () => saveRecurringBlocks({ data: { blocks } }))} />
        </div>
        <BlockedTimesCard data={data} busy={busy} onAdd={(payload) => run("Blocked time added", () => addBlockedTime({ data: payload }))} onRemove={(id, label) => run("Blocked time removed", () => removeBlockedTime({ data: { id, label } }))} />
      </section>

      {/* ---------- Sync center ---------- */}
      <SyncCenter data={data} onSync={async () => {
        const res = await syncNow();
        await router.invalidate();
        return `Sync complete (${res.mode}): ${res.providers.map((p) => `${p.provider} ${p.count}`).join(", ")}`;
      }} />

      {/* ---------- Manual overrides ---------- */}
      <OverridesSection data={data} busy={busy} onAssign={(appointmentId, repId, callId) => run("Booking attributed", () => assignAttribution({ data: { appointmentId, repId, callId } }))} onWorkDate={(leadId, workDate, previousWorkDate, reason) => run("Lead work date corrected", () => setLeadWorkDate({ data: { leadId, workDate, previousWorkDate, reason } }))} onLeadCount={(date, sheet, count, reason) => run("Lead count corrected", () => setLeadCount({ data: { date, sheet, count, reason } }))} />

      {/* ---------- Override history ---------- */}
      <section className="space-y-3">
        <p className="section-title">Override history (audit trail)</p>
        <div className="overflow-x-auto">
          <table className="data-table min-w-[820px]">
            <thead>
              <tr>
                <th className="text-left">When</th>
                <th className="text-left">Entity</th>
                <th className="text-left">Field</th>
                <th className="text-left">Previous</th>
                <th className="text-left">New</th>
                <th className="text-left">Who</th>
              </tr>
            </thead>
            <tbody>
              {data.overrides.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-stone-400">
                    No overrides recorded yet.
                  </td>
                </tr>
              )}
              {data.overrides.map((o) => (
                <tr key={o.id}>
                  <td>{new Date(o.changed_at).toLocaleString("en-US")}</td>
                  <td className="font-medium text-stone-900">
                    {o.entity_type} <span className="text-stone-400">{o.entity_id.slice(0, 18)}</span>
                  </td>
                  <td>{o.field}</td>
                  <td className="text-stone-400">{o.previous_value ?? "—"}</td>
                  <td>{o.new_value}</td>
                  <td>{o.changed_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/* ================= weekly goals ================= */

interface EditorWeek {
  weekStart: string;
  isCurrent: boolean;
  label: string;
  goal: number | null;
  leadBudget: number | null;
}

function WeekGoalRow({ week, busy, onSave }: { week: EditorWeek; busy: boolean; onSave: (goal: number, budget: number) => void }) {
  const [goal, setGoal] = useState(String(week.goal ?? 79));
  const [budget, setBudget] = useState(String(week.leadBudget ?? 700));
  return (
    <tr className={week.isCurrent ? "bg-amber-50/40" : ""}>
      <td>
        <span className="font-medium text-stone-900">{week.label}</span>
        {week.isCurrent && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">current</span>}
        <span className="ml-2 text-[11px] text-stone-400">{week.weekStart}</span>
      </td>
      <td className="text-right">
        <input type="number" className="w-24 rounded-lg border border-stone-300 bg-white px-2 py-1 text-right text-[13px] outline-none focus:border-stone-500" value={goal} onChange={(e) => setGoal(e.target.value)} />
      </td>
      <td className="text-right">
        <input type="number" className="w-24 rounded-lg border border-stone-300 bg-white px-2 py-1 text-right text-[13px] outline-none focus:border-stone-500" value={budget} onChange={(e) => setBudget(e.target.value)} />
      </td>
      <td className="text-right">
        <button className="rounded-lg border border-stone-300 px-3 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50" disabled={busy} onClick={() => onSave(Number(goal), Number(budget))}>
          Save
        </button>
      </td>
    </tr>
  );
}

/* ================= rep goals ================= */

function RepGoalsSection({ data, busy, onSave }: {
  data: ReturnType<typeof Route.useLoaderData>;
  busy: boolean;
  onSave: (weekStart: string, goals: { repId: string; goal: number | null }[]) => void;
}) {
  const [week, setWeek] = useState(data.weekStart);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(data.users.map((u) => [u.id, String(data.repGoalsByWeek[data.weekStart]?.find((g) => g.rep_id === u.id)?.goal ?? "")])));
  const weekRow = data.editorWeeks.find((w) => w.weekStart === week);
  const teamGoal = weekRow?.goal ?? 79;
  const teamShare = data.repCount > 0 ? teamGoal / data.repCount : null;

  const switchWeek = (w: string) => {
    setWeek(w);
    setDraft(Object.fromEntries(data.users.map((u) => [u.id, String(data.repGoalsByWeek[w]?.find((g) => g.rep_id === u.id)?.goal ?? "")])));
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="section-title">Rep goals — week of {week}</p>
          <p className="mt-1 text-[13px] text-stone-500">
            Leave blank to use the team share: {teamGoal} ÷ {data.repCount || "—"} = {teamShare != null ? (Math.round(teamShare * 100) / 100).toFixed(2) : "—"} bookings per rep (labeled on rep pages).
          </p>
        </div>
        <select className="rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-[13px]" value={week} onChange={(e) => switchWeek(e.target.value)}>
          {data.editorWeeks.map((w) => (
            <option key={w.weekStart} value={w.weekStart}>
              {w.label}
              {w.isCurrent ? " (current)" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="card space-y-1 p-0">
        {data.users.length === 0 && <p className="p-5 text-sm text-stone-400">No reps found — sync HighLevel first.</p>}
        {data.users.map((u) => {
          const val = draft[u.id] ?? "";
          return (
            <div key={u.id} className="flex items-center justify-between gap-4 border-b border-stone-100 px-5 py-2.5 last:border-0">
              <span className="text-[13px] font-medium text-stone-800">{u.name}</span>
              <div className="flex items-center gap-3">
                {val.trim() === "" ? (
                  <span className="text-[11px] font-medium uppercase tracking-wide text-amber-700">team share ≈ {teamShare != null ? (Math.round(teamShare * 100) / 100).toFixed(2) : "—"}</span>
                ) : (
                  <span className="text-[11px] text-stone-400">own goal</span>
                )}
                <input
                  type="number"
                  placeholder="team share"
                  className="w-24 rounded-lg border border-stone-300 bg-white px-2 py-1 text-right text-[13px] outline-none focus:border-stone-500"
                  value={val}
                  onChange={(e) => setDraft({ ...draft, [u.id]: e.target.value })}
                />
              </div>
            </div>
          );
        })}
        <div className="flex justify-end px-5 py-3">
          <button
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
            disabled={busy || data.users.length === 0}
            onClick={() => onSave(week, data.users.map((u) => ({ repId: u.id, goal: (draft[u.id] ?? "").trim() === "" ? null : Number(draft[u.id]) })))}
          >
            Save rep goals
          </button>
        </div>
      </div>
    </section>
  );
}

/* ================= roster mapping (owner rule: mapping drives eligibility) ================= */

function RosterMappingSection({ data, busy, onSave }: {
  data: ReturnType<typeof Route.useLoaderData>;
  busy: boolean;
  onSave: (mappings: { external_user_id: string; rep_id: string }[]) => void;
}) {
  // draft rep choice per non-roster HL user (prefilled with any existing mapping)
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.nonRosterUsers.filter((u) => u.mappedTo).map((u) => [u.externalId, u.mappedTo!])),
  );
  const currentByExternal = new Map(data.repMappings.map((m) => [m.external_user_id, m.rep_id]));
  // the payload to save: every current mapping kept (unless changed below) + new drafts
  const nextMappings = () => {
    const merged = new Map<string, string>();
    for (const m of data.repMappings) merged.set(m.external_user_id, m.rep_id);
    for (const [ext, repId] of Object.entries(draft)) {
      if (repId) merged.set(ext, repId);
      else merged.delete(ext);
    }
    return [...merged.entries()].map(([external_user_id, rep_id]) => ({ external_user_id, rep_id }));
  };
  const dirty = [...currentByExternal.entries()].some(([ext, rep]) => (draft[ext] ?? rep) !== rep) ||
    Object.entries(draft).some(([ext, rep]) => rep && !currentByExternal.has(ext));

  return (
    <section className="space-y-3">
      <div>
        <p className="section-title">Roster Mapping</p>
        <p className="mt-1 text-[13px] text-stone-500">
          Map a non-roster HighLevel user to a CC rep. From then on ALL historical calls under that HighLevel user id
          count for the rep&apos;s performance and the team totals — computed from the mapping at query time. Source
          records are never rewritten: the original HL user id, message ids and timestamps stay untouched, and removing
          a mapping returns the calls to Non Roster.
        </p>
      </div>
      <div className="card space-y-1 p-0">
        {data.nonRosterUsers.length === 0 && (
          <p className="p-5 text-sm text-stone-400">No non-roster HighLevel users seen in calls yet.</p>
        )}
        {data.nonRosterUsers.map((u) => {
          const val = draft[u.externalId] ?? "";
          return (
            <div key={u.externalId} className="flex flex-wrap items-center justify-between gap-4 border-b border-stone-100 px-5 py-2.5 last:border-0">
              <span className="text-[13px] font-medium text-stone-800">
                {u.name || u.externalId}
                <span className="ml-2 font-mono text-[11px] text-stone-400">{u.externalId}</span>
              </span>
              <div className="flex items-center gap-3">
                <span className="text-[11px] tabular-nums text-stone-400">
                  {u.callCount > 0 ? `${u.callCount} calls in last 30 days` : "no calls in last 30 days"}
                </span>
                <select
                  aria-label={`Map ${u.name || u.externalId} to`}
                  className="rounded-lg border border-stone-300 bg-white px-2 py-1 text-[13px]"
                  value={val}
                  onChange={(e) => setDraft({ ...draft, [u.externalId]: e.target.value })}
                >
                  <option value="">Non Roster (excluded)</option>
                  {data.users.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
        <div className="flex justify-end px-5 py-3">
          <button
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
            disabled={busy || !dirty}
            onClick={() => onSave(nextMappings())}
          >
            Save roster mappings
          </button>
        </div>
      </div>
      {data.repMappings.length > 0 && (
        <p className="text-[11px] text-stone-400">
          Active mappings: {data.repMappings.map((m) => `${m.external_user_id} → ${data.users.find((u) => u.id === m.rep_id)?.name ?? m.rep_id}`).join(" · ")}
        </p>
      )}
    </section>
  );
}

/* ================= rep start dates (call_start_date) ================= */

function RepStartDatesSection({ data, busy, onSave }: {
  data: ReturnType<typeof Route.useLoaderData>;
  busy: boolean;
  onSave: (entries: { repId: string; date: string | null }[]) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.users.map((u) => [u.id, u.call_start_date ?? ""])),
  );
  const dirty = data.users.some((u) => (draft[u.id] ?? "") !== (u.call_start_date ?? ""));
  return (
    <section className="space-y-3">
      <div>
        <p className="section-title">Rep start dates</p>
        <p className="mt-1 text-[13px] text-stone-500">
          A rep with a future start date stays visible in the roster as <b>Not Yet Active</b>: zero calls expected, no
          coaching flags, no zero-activity alerts, no negative messaging. Normal performance monitoring begins ON the
          start date. Clear a date to monitor the rep from whenever their records begin.
        </p>
      </div>
      <div className="card space-y-1 p-0">
        {data.users.map((u) => (
          <div key={u.id} className="flex items-center justify-between gap-4 border-b border-stone-100 px-5 py-2.5 last:border-0">
            <span className="text-[13px] font-medium text-stone-800">{u.name}</span>
            <input
              type="date"
              aria-label={`Call start date for ${u.name}`}
              className="rounded-lg border border-stone-300 bg-white px-2 py-1 text-[13px]"
              value={draft[u.id] ?? ""}
              onChange={(e) => setDraft({ ...draft, [u.id]: e.target.value })}
            />
          </div>
        ))}
        <div className="flex justify-end px-5 py-3">
          <button
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
            disabled={busy || !dirty}
            onClick={() => onSave(data.users.map((u) => ({ repId: u.id, date: (draft[u.id] ?? "").trim() === "" ? null : draft[u.id] })))}
          >
            Save rep start dates
          </button>
        </div>
      </div>
    </section>
  );
}

/* ================= core ops + acuity scope ================= */

function CoreOpsCard({ data, busy, onSave }: {
  data: ReturnType<typeof Route.useLoaderData>;
  busy: boolean;
  onSave: (thresholdSeconds: number, windowHours: number) => void;
}) {
  const [threshold, setThreshold] = useState(String(data.settings.meaningful_call_threshold_seconds));
  const [windowHours, setWindowHours] = useState(String(data.settings.attribution_window_hours));
  return (
    <div className="card space-y-4">
      <p className="section-title">Operational defaults</p>
      <NumberField label="Meaningful Call Threshold (seconds)" value={threshold} onChange={setThreshold} />
      <NumberField label="Booking Attribution Window (hours)" value={windowHours} onChange={setWindowHours} />
      <div className="flex items-baseline justify-between gap-4 border-b border-stone-100 pb-2">
        <span className="text-[13px] text-stone-400">Operational Time Zone</span>
        <span className="text-[13px] font-medium text-stone-800">{data.settings.timezone}</span>
      </div>
      <p className="text-xs text-stone-400">
        The time zone is fixed to America/New_York on purpose — changing it re-dates every work_date, cohort and slot in the data model, so it is a data-model decision, not a setting. All existing records were stored in ET.
      </p>
      <button className="w-fit rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50" disabled={busy} onClick={() => onSave(Number(threshold), Number(windowHours))}>
        Save operational settings
      </button>
    </div>
  );
}

function AcuityScopeCard({ data, busy, onSave }: {
  data: ReturnType<typeof Route.useLoaderData>;
  busy: boolean;
  onSave: (calendars: string[], types: string[]) => void;
}) {
  // The catalog comes from the (demo) adapter; once Acuity credentials arrive
  // this card lists the real calendars/types without UI changes.
  const [calendars, setCalendars] = useState<string[]>(data.settings.acuity.calendars_included);
  const [types, setTypes] = useState<string[]>(data.settings.acuity.types_included);
  const catalogCalendars: { id: string; name: string }[] = [
    { id: "Family Studio", name: "Family Studio" },
    { id: "Animalia Studio", name: "Animalia Studio" },
  ];
  const catalogTypes = [
    "Family Portrait Session",
    "Family Mini Session",
    "Holiday Family Session",
    "Animalia Signature Session",
    "Animalia Pet Portrait",
    "Animalia Companion Session",
  ];
  const toggle = (list: string[], v: string, set: (l: string[]) => void) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="card space-y-4">
      <p className="section-title">Acuity calendars &amp; appointment types included</p>
      <p className="text-xs text-stone-400">Only selected calendars and types count toward CC reporting (demo catalog until Acuity connects). Empty selection = everything counts.</p>
      <div>
        <p className="kpi-label mb-1">Calendars</p>
        <div className="space-y-1">
          {catalogCalendars.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-[13px] text-stone-700">
              <input type="checkbox" checked={calendars.length === 0 || calendars.includes(c.id)} disabled={calendars.length === 0} onChange={() => toggle(calendars, c.id, setCalendars)} />
              {c.name}
            </label>
          ))}
          {calendars.length === 0 && <p className="text-[11px] text-amber-700">No calendars selected — all are included.</p>}
        </div>
      </div>
      <div>
        <p className="kpi-label mb-1">Appointment types</p>
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {catalogTypes.map((t) => (
            <label key={t} className="flex items-center gap-2 text-[13px] text-stone-700">
              <input type="checkbox" checked={types.length === 0 || types.includes(t)} disabled={types.length === 0} onChange={() => toggle(types, t, setTypes)} />
              <span className="truncate">{t}</span>
            </label>
          ))}
        </div>
        {types.length === 0 && <p className="text-[11px] text-amber-700">No types selected — all are included.</p>}
      </div>
      <button className="w-fit rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50" disabled={busy} onClick={() => onSave(calendars, types)}>
        Save Acuity scope
      </button>
    </div>
  );
}

/* ================= sheet mapping ================= */

function SheetMappingCard({ sheet, columns, mode: initialMode, sheetId, busy, onSave }: {
  sheet: "family" | "animalia";
  columns: Record<string, string>;
  mode: SheetMappingMode;
  sheetId: string;
  busy: boolean;
  onSave: (columns: Record<string, string>, mode: SheetMappingMode) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({ ...columns });
  const [mode, setMode] = useState<SheetMappingMode>(initialMode);
  const [test, setTest] = useState<{
    sample: { header: string[]; rows: string[][]; tab?: string; notice?: string | null };
    result: { parsed: Record<string, string | null>; warnings: string[] };
    workDate: string | null;
    sourceDate: string | null;
    source: "live" | "demo-fallback";
    liveError: string | null;
    mode: SheetMappingMode;
  } | null>(null);
  const fields = mode === "row_per_day_count" ? SHEET_FIELDS_DAY : SHEET_FIELDS_LEAD;
  // The out-of-the-box mapping for the current shape — shown so the default is
  // discoverable without digging through code (owner-corrected: date = Q).
  const defaultColumns = mode === "row_per_day_count" ? DEFAULT_COLUMN_MAPPING_DAY_COUNT : DEFAULT_COLUMN_MAPPING;
  const defaultNote = fields
    .map((f) => `${f.label.replace(" (optional)", "")} ${defaultColumns[f.key] ?? "—"}`)
    .join(" · ");
  return (
    <div className="card space-y-3">
      <div>
        <p className="section-title">{sheet === "family" ? "Family sheet" : "Animalia sheet"}</p>
        <p className="mt-1 truncate text-[11px] text-stone-400">Sheet ID {sheetId}</p>
        <p className="mt-0.5 text-[11px] text-stone-400">
          Default mapping: {defaultNote} (editable below)
        </p>
      </div>
      <div className="space-y-1">
        <span className="kpi-label">Sheet shape</span>
        {SHEET_MODE_OPTIONS.map((m) => (
          <label key={m.value} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-stone-50">
            <input type="radio" name={`${sheet}-mode`} className="mt-0.5" checked={mode === m.value} onChange={() => setMode(m.value)} />
            <span className="text-[13px]">
              <span className="font-medium text-stone-800">{m.label}</span>
              <span className="block text-[11px] text-stone-400">{m.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="kpi-label">{f.label}</span>
            <select className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-[13px]" value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}>
              {COLUMN_LETTERS.map((l) => (
                <option key={l} value={l}>
                  Column {l}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <button className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50" disabled={busy} onClick={() => onSave(draft, mode)}>
          Save mapping
        </button>
        <button
          className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
          disabled={busy}
          onClick={async () => {
            const { testSheetMapping } = await import("~/server/queries");
            const res = await testSheetMapping({ data: { sheet, columns: draft, mode } });
            setTest(res as typeof test);
          }}
        >
          Test mapping (live)
        </button>
      </div>
      {test && (
        <div className="rounded-lg bg-stone-50 p-3 text-xs text-stone-600">
          <p className="mb-1">
            <span className={"rounded-full px-2 py-0.5 text-[11px] font-medium " + (test.source === "live" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800")}>
              {test.source === "live" ? "live sample from Google Sheets" : "demo sample — Sheets API not reachable yet"}
            </span>
            {test.source === "live" && test.sample.tab ? <span className="ml-2 text-stone-400">tab “{test.sample.tab}”</span> : null}
          </p>
          {test.liveError && <p className="mt-1 text-red-600">{test.liveError}</p>}
          {test.sample.notice && <p className="mt-1 text-amber-700">{test.sample.notice}</p>}
          <p className="kpi-label mt-2 mb-1">Sample row (header: {test.sample.header.join(" | ") || "—"})</p>
          <p className="mb-2 font-mono text-[11px]">{test.sample.rows[0]?.join("  |  ")}</p>
          <p className="kpi-label mb-1">Parsed ({test.mode === "row_per_day_count" ? "row-per-day + count" : "row-per-lead"})</p>
          <ul className="space-y-0.5">
            {Object.entries(test.result.parsed).map(([k, v]) => (
              <li key={k}>
                <span className="text-stone-400">{k}:</span> <span className={v ? "font-medium text-stone-800" : "text-red-600"}>{v || "missing"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1">
            <span className="text-stone-400">source_date (normalized):</span> <span className="font-medium text-stone-800">{test.sourceDate ?? "—"}</span>
            <span className="text-stone-400"> · work_date:</span> <span className="font-medium text-stone-800">{test.workDate ?? "—"}</span>
          </p>
          {test.result.warnings.length > 0 && <p className="mt-1 text-amber-700">{test.result.warnings.join(" · ")}</p>}
        </div>
      )}
    </div>
  );
}

/* ================= studio ================= */

function StudioRulesCard({ data, busy, onSave }: {
  data: ReturnType<typeof Route.useLoaderData>;
  busy: boolean;
  onSave: (payload: { durationMin?: number; slotIntervalMin?: number; paddingMin?: number; hours?: { weekday: number; open_time: string; close_time: string; active: boolean }[] }) => void;
}) {
  const [duration, setDuration] = useState(String(data.settings.studio.appointment_duration_min));
  const [interval, setIntervalMin] = useState(String(data.settings.studio.slot_interval_min));
  const [padding, setPadding] = useState(String(data.settings.studio.padding_min));
  const [hours, setHours] = useState(data.settings.studio.hours.map((h) => ({ ...h })));
  return (
    <div className="card space-y-4">
      <p className="section-title">Studio hours &amp; slot rules</p>
      <div className="grid grid-cols-3 gap-2">
        <NumberField label="Duration (min)" value={duration} onChange={setDuration} />
        <NumberField label="Slot interval (min)" value={interval} onChange={setIntervalMin} />
        <NumberField label="Padding (min)" value={padding} onChange={setPadding} />
      </div>
      <div className="space-y-1">
        {hours.map((h, i) => (
          <div key={h.weekday} className="flex items-center gap-2 text-[13px]">
            <label className="flex w-24 items-center gap-1.5 text-stone-700">
              <input
                type="checkbox"
                checked={h.active}
                onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, active: e.target.checked } : x)))}
              />
              {WEEKDAYS[h.weekday].slice(0, 3)}
            </label>
            <input type="time" className="rounded-lg border border-stone-300 px-2 py-1 text-[13px]" value={h.open_time} disabled={!h.active} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, open_time: e.target.value } : x)))} />
            <span className="text-stone-400">–</span>
            <input type="time" className="rounded-lg border border-stone-300 px-2 py-1 text-[13px]" value={h.close_time} disabled={!h.active} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, close_time: e.target.value } : x)))} />
          </div>
        ))}
      </div>
      <button className="w-fit rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50" disabled={busy} onClick={() => onSave({ durationMin: Number(duration), slotIntervalMin: Number(interval), paddingMin: Number(padding), hours })}>
        Save studio rules
      </button>
    </div>
  );
}

function RecurringBlocksCard({ data, busy, onSave }: {
  data: ReturnType<typeof Route.useLoaderData>;
  busy: boolean;
  onSave: (blocks: { id: string; weekday: number; start_time: string; end_time: string; reason: string | null; active: boolean }[]) => void;
}) {
  const [blocks, setBlocks] = useState(data.settings.studio.recurring_blocks.map((b) => ({ ...b })));
  return (
    <div className="card space-y-3">
      <div>
        <p className="section-title">Recurring blocked times (weekly pattern)</p>
        <p className="mt-1 text-xs text-stone-400">Repeat every week on the chosen weekday — e.g. a standing lunch block. Feeds the same open-slot engine as one-off blocks.</p>
      </div>
      {blocks.map((b, i) => (
        <div key={b.id} className="flex flex-wrap items-center gap-2 text-[13px]">
          <select className="rounded-lg border border-stone-300 px-2 py-1" value={b.weekday} onChange={(e) => setBlocks(blocks.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)))}>
            {WEEKDAYS.map((d, wd) => (
              <option key={d} value={wd}>
                {d}
              </option>
            ))}
          </select>
          <input type="time" className="rounded-lg border border-stone-300 px-2 py-1" value={b.start_time} onChange={(e) => setBlocks(blocks.map((x, j) => (j === i ? { ...x, start_time: e.target.value } : x)))} />
          <span className="text-stone-400">–</span>
          <input type="time" className="rounded-lg border border-stone-300 px-2 py-1" value={b.end_time} onChange={(e) => setBlocks(blocks.map((x, j) => (j === i ? { ...x, end_time: e.target.value } : x)))} />
          <input type="text" placeholder="Reason" className="w-36 rounded-lg border border-stone-300 px-2 py-1" value={b.reason ?? ""} onChange={(e) => setBlocks(blocks.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))} />
          <label className="flex items-center gap-1 text-stone-600">
            <input type="checkbox" checked={b.active} onChange={(e) => setBlocks(blocks.map((x, j) => (j === i ? { ...x, active: e.target.checked } : x)))} />
            active
          </label>
          <button className="text-xs text-red-600 hover:underline" onClick={() => setBlocks(blocks.filter((_, j) => j !== i))}>
            remove
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <button className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-100" onClick={() => setBlocks([...blocks, { id: `rb-${Date.now()}`, weekday: 5, start_time: "12:00", end_time: "13:00", reason: "", active: true }])}>
          Add block
        </button>
        <button className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50" disabled={busy} onClick={() => onSave(blocks)}>
          Save recurring blocks
        </button>
      </div>
    </div>
  );
}

function BlockedTimesCard({ data, busy, onAdd, onRemove }: {
  data: ReturnType<typeof Route.useLoaderData>;
  busy: boolean;
  onAdd: (payload: { date: string; startHHMM: string; endHHMM: string; reason?: string }) => void;
  onRemove: (id: string, label: string) => void;
}) {
  const [date, setDate] = useState(data.today);
  const [start, setStart] = useState("12:00");
  const [end, setEnd] = useState("13:00");
  const [reason, setReason] = useState("");
  return (
    <div className="card space-y-3">
      <div>
        <p className="section-title">Blocked times (one-off)</p>
        <p className="mt-1 text-xs text-stone-400">Concrete availability blocks (manual corrections or imported). Removing one also writes the audit trail.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <input type="date" className="rounded-lg border border-stone-300 px-2 py-1" value={date} onChange={(e) => setDate(e.target.value)} />
        <input type="time" className="rounded-lg border border-stone-300 px-2 py-1" value={start} onChange={(e) => setStart(e.target.value)} />
        <span className="text-stone-400">–</span>
        <input type="time" className="rounded-lg border border-stone-300 px-2 py-1" value={end} onChange={(e) => setEnd(e.target.value)} />
        <input type="text" placeholder="Reason" className="w-40 rounded-lg border border-stone-300 px-2 py-1" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50" disabled={busy} onClick={() => onAdd({ date, startHHMM: start, endHHMM: end, reason })}>
          Add block
        </button>
      </div>
      <div className="space-y-1">
        {data.blockedTimes.length === 0 && <p className="text-xs text-stone-400">No blocked times in the next 30 days.</p>}
        {data.blockedTimes.map((b) => (
          <div key={b.id} className="flex items-center justify-between gap-3 border-b border-stone-100 pb-1 text-[13px] last:border-0">
            <span>
              {new Date(b.start_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} –{" "}
              {new Date(b.end_at).toLocaleTimeString("en-US", { timeStyle: "short" })}
              {b.reason ? <span className="ml-2 text-stone-400">{b.reason}</span> : null}
            </span>
            <button className="text-xs text-red-600 hover:underline disabled:opacity-50" disabled={busy} onClick={() => onRemove(b.id, `${new Date(b.start_at).toLocaleString("en-US")}${b.reason ? ` (${b.reason})` : ""}`)}>
              remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================= sync center ================= */

function SyncCenter({ data, onSync }: { data: ReturnType<typeof Route.useLoaderData>; onSync: () => Promise<string> }) {
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="section-title">Sync center</p>
          <p className="mt-1 text-[13px] text-stone-500">Background syncs are duplicate-safe; cancellations update in place. Google Sheets syncs live when its access is granted; HighLevel and Acuity run on demo adapters until their credentials arrive.</p>
        </div>
        <button
          className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
          disabled={syncing}
          onClick={async () => {
            setSyncing(true);
            setMsg(null);
            try {
              setMsg(await onSync());
            } catch (e) {
              setMsg(e instanceof Error ? e.message : "Sync failed");
            } finally {
              setSyncing(false);
            }
          }}
        >
          {syncing ? "Syncing…" : "SYNC NOW"}
        </button>
      </div>
      {msg && <p className="text-xs text-stone-500">{msg}</p>}
      <div className="overflow-x-auto">
        <table className="data-table min-w-[760px]">
          <thead>
            <tr>
              <th className="text-left">Provider</th>
              <th className="text-left">Status</th>
              <th className="text-left">Last Sync</th>
              <th className="text-left">Last Successful</th>
              <th className="text-left">Sync Errors</th>
            </tr>
          </thead>
          <tbody>
            {data.connections.length === 0 && (
              <tr>
                <td colSpan={5} className="text-stone-400">
                  No syncs recorded yet — press SYNC NOW.
                </td>
              </tr>
            )}
            {data.connections.map((c) => (
              <tr key={c.provider}>
                <td className="font-medium capitalize text-stone-900">{c.provider.replace("_", " ")}</td>
                <td>
                  <span className={"rounded-full px-2 py-0.5 text-xs font-medium " + (c.is_demo ? "bg-amber-100 text-amber-800" : c.status === "connected" ? "bg-emerald-100 text-emerald-700" : c.status === "error" ? "bg-red-100 text-red-700" : "bg-stone-200 text-stone-600")}>
                    {c.is_demo ? "demo" : c.status}
                  </span>
                </td>
                <td>{c.last_sync_at ? new Date(c.last_sync_at).toLocaleString("en-US") : "—"}</td>
                <td>{c.last_successful_sync_at ? new Date(c.last_successful_sync_at).toLocaleString("en-US") : "—"}</td>
                <td className="text-red-600">{c.last_error ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <p className="section-title mb-2">Recent sync runs</p>
        <div className="overflow-x-auto">
          <table className="data-table min-w-[720px]">
            <thead>
              <tr>
                <th className="text-left">Provider</th>
                <th className="text-left">Status</th>
                <th className="text-left">Started</th>
                <th className="text-right">Records upserted</th>
                <th className="text-left">Error</th>
              </tr>
            </thead>
            <tbody>
              {data.syncRuns.map((r) => (
                <tr key={r.id}>
                  <td>{r.provider}</td>
                  <td className={r.status === "error" ? "text-red-600" : ""}>{r.status}</td>
                  <td>{new Date(r.started_at).toLocaleString("en-US")}</td>
                  <td className="text-right">{r.records_upserted}</td>
                  <td className="text-red-600">{r.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/* ================= manual overrides ================= */

function OverridesSection({ data, busy, onAssign, onWorkDate, onLeadCount }: {
  data: ReturnType<typeof Route.useLoaderData>;
  busy: boolean;
  onAssign: (appointmentId: string, repId: string, callId?: string | null) => void;
  onWorkDate: (leadId: string, workDate: string, previousWorkDate: string, reason?: string) => void;
  onLeadCount: (date: string, sheet: string, count: number, reason?: string) => void;
}) {
  return (
    <section className="space-y-6">
      <div>
        <p className="section-title">Manual overrides</p>
        <p className="mt-1 text-[13px] text-stone-500">Corrections Christopher makes by hand — every one is written to the audit trail below with previous value, new value, who and when.</p>
      </div>

      {/* (a) unattributed bookings */}
      <div className="card space-y-2">
        <p className="kpi-label">Unattributed bookings — assign a rep manually</p>
        {data.unattributed.length === 0 ? (
          <p className="text-[13px] text-stone-400">Every active booking is attributed.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[980px]">
              <thead>
                <tr>
                  <th className="text-left">Client</th>
                  <th className="text-left">Type</th>
                  <th className="text-left">Session</th>
                  <th className="text-left">Why unattributed</th>
                  <th className="text-left">Suggested</th>
                  <th className="text-left">Call</th>
                  <th className="text-left">Assign to</th>
                  <th className="text-left"></th>
                </tr>
              </thead>
              <tbody>
                {data.unattributed.slice(0, 12).map((u) => (
                  <UnattributedRow key={u.appointment_id} row={u} users={data.users} busy={busy} onAssign={onAssign} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* (b) lead work date + lead count */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <LeadWorkDateCard data={data} busy={busy} onSave={onWorkDate} />
        <LeadCountCard data={data} busy={busy} onSave={onLeadCount} />
      </div>
    </section>
  );
}

/** Owner vocabulary for the engine's unattributed reasons (never guessed here). */
const UNATTRIBUTED_REASON_LABELS: Record<string, string> = {
  "no-qualifying-call": "No qualifying call in window",
  "no-contact-identity": "No contact identity",
  ambiguous: "Unclear match — decide who",
  "bad-datetime": "Unreadable booking time",
  "manually-assigned": "Manually assigned",
};

function UnattributedRow({ row, users, busy, onAssign }: {
  row: { appointment_id: string; client_name: string | null; client_phone: string | null; client_email: string | null; appointment_type: string; calendar_name: string | null; appointment_datetime: string; created_at: string; reason: string | null; suggested_rep_id: string | null; candidate_calls: { call_id: string; rep_id: string | null; started_at: string; duration_seconds: number }[] };
  users: { id: string; name: string }[];
  busy: boolean;
  onAssign: (appointmentId: string, repId: string, callId?: string | null) => void;
}) {
  const [repId, setRepId] = useState(row.suggested_rep_id ?? row.candidate_calls[0]?.rep_id ?? "");
  const [callId, setCallId] = useState(row.candidate_calls[0]?.call_id ?? "");
  return (
    <tr>
      <td className="font-medium text-stone-900">
        {row.client_name ?? "Unknown"}
        <span className="block text-[11px] font-normal text-stone-400">{row.client_phone ?? ""}</span>
        <span className="block text-[11px] font-normal text-stone-400">{row.client_email ?? ""}</span>
      </td>
      <td>
        {row.appointment_type}
        <span className="block text-[11px] text-stone-400">{row.calendar_name ?? ""}</span>
      </td>
      <td>
        {new Date(row.appointment_datetime).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}
        <span className="block text-[11px] text-stone-400">booked {new Date(row.created_at).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}</span>
      </td>
      <td>
        <span className="text-[12px] text-stone-600" title={row.reason ?? ""}>
          {row.reason ? (UNATTRIBUTED_REASON_LABELS[row.reason] ?? row.reason) : "—"}
        </span>
      </td>
      <td>{users.find((u) => u.id === row.suggested_rep_id)?.name ?? "—"}</td>
      <td>
        {row.candidate_calls.length > 0 ? (
          <select className="rounded-lg border border-stone-300 bg-white px-2 py-1 text-[13px]" value={callId} onChange={(e) => setCallId(e.target.value)}>
            {row.candidate_calls.map((c) => (
              <option key={c.call_id} value={c.call_id}>
                {new Date(c.started_at).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })} · {Math.round(c.duration_seconds / 60)}m · {users.find((u) => u.id === c.rep_id)?.name ?? "non-roster"}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-stone-400">—</span>
        )}
      </td>
      <td>
        <select className="rounded-lg border border-stone-300 bg-white px-2 py-1 text-[13px]" value={repId} onChange={(e) => setRepId(e.target.value)}>
          <option value="">Choose rep…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </td>
      <td>
        <button className="rounded-lg border border-stone-300 px-3 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50" disabled={busy || !repId} onClick={() => onAssign(row.appointment_id, repId, callId || null)}>
          Assign
        </button>
      </td>
    </tr>
  );
}

function LeadWorkDateCard({ data, busy, onSave }: {
  data: ReturnType<typeof Route.useLoaderData>;
  busy: boolean;
  onSave: (leadId: string, workDate: string, previousWorkDate: string, reason?: string) => void;
}) {
  const [selected, setSelected] = useState("");
  const [workDate, setWorkDate] = useState(data.today);
  const [reason, setReason] = useState("");
  const lead = data.recentLeads.find((l) => l.id === selected);
  return (
    <div className="card space-y-3">
      <p className="section-title">Correct a lead&apos;s work date</p>
      <select className="w-full rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-[13px]" value={selected} onChange={(e) => setSelected(e.target.value)}>
        <option value="">Choose a lead (recent cohorts)…</option>
        {data.recentLeads.slice(0, 80).map((l) => (
          <option key={l.id} value={l.id}>
            {l.source_date} · {l.lead_type} · {l.source_sheet} (works {l.work_date})
          </option>
        ))}
      </select>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-stone-500">Move to</span>
        <input type="date" className="rounded-lg border border-stone-300 px-2 py-1" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
        <input type="text" placeholder="Reason (optional)" className="w-40 rounded-lg border border-stone-300 px-2 py-1" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <button className="w-fit rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50" disabled={busy || !selected || !lead} onClick={() => selected && lead && onSave(selected, workDate, lead.work_date, reason)}>
        Save work date
      </button>
      <p className="text-xs text-stone-400">Operational reporting counts this lead under its work date (Mon folds Fri–Sun) — moving it moves every &quot;leads today&quot; number that includes it.</p>
    </div>
  );
}

function LeadCountCard({ data, busy, onSave }: {
  data: ReturnType<typeof Route.useLoaderData>;
  busy: boolean;
  onSave: (date: string, sheet: string, count: number, reason?: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const key = (d: string, s: string) => `${d}:${s}`;
  const currentWeekRows = data.observedCounts.filter((r) => r.observed > 0 || r.adjustedDelta != null);
  return (
    <div className="card space-y-3">
      <p className="section-title">Correct a day&apos;s lead count</p>
      {currentWeekRows.length === 0 && <p className="text-[13px] text-stone-400">No leads observed this week yet.</p>}
      <div className="space-y-1">
        {currentWeekRows.map((r) => {
          const effective = r.observed + (r.adjustedDelta ?? 0);
          const val = drafts[key(r.date, r.sheet)] ?? String(effective);
          return (
            <div key={key(r.date, r.sheet)} className="flex items-center justify-between gap-2 border-b border-stone-100 pb-1 text-[13px] last:border-0">
              <span>
                {r.date} · <span className="capitalize">{r.sheet}</span>
                <span className="ml-2 text-[11px] text-stone-400">
                  synced {r.observed}
                  {r.adjustedDelta ? ` ${r.adjustedDelta > 0 ? "+" : ""}${r.adjustedDelta}` : ""}
                </span>
              </span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  className="w-20 rounded-lg border border-stone-300 px-2 py-1 text-right text-[13px]"
                  value={val}
                  onChange={(e) => setDrafts({ ...drafts, [key(r.date, r.sheet)]: e.target.value })}
                />
                <button
                  className="rounded-lg border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
                  disabled={busy || Number(val) === effective}
                  onClick={() => onSave(r.date, r.sheet, Number(val), `corrected from ${effective}`)}
                >
                  Save
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-stone-400">Adjustments are deltas vs the synced rows and flow through the metrics layer, so Today, Daily Report and Team agree.</p>
    </div>
  );
}

/* ================= shared field ================= */

function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="kpi-label">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-stone-500"
      />
    </label>
  );
}
