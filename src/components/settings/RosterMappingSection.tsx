import { useState } from "react";
import { rosterPanelVisibleRows } from "~/components/settings-views";
import type { SettingsData } from "~/routes/settings";
import type { NonRosterPanelRow } from "~/server/roster";
import type { RepMapping } from "~/server/store/types";

/** Users ride in the settings payload as id + name (+call_start_date). */
type SettingsUser = { id: string; name: string; call_start_date?: string };

export function RosterMappingSection({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (mappings: RepMapping[]) => void;
}) {
  // OWNER DIRECTIVE (2026-11-02, supersedes the 10/20 zero-call-only default):
  // INACTIVE users are never listed in the panel — and since the erase
  // follow-up the server payload carries NO inactive user at all (their names
  // never reach the browser). The row machinery below stays for any
  // non-inactive row the payload may ever carry; the visibility gate
  // (rosterPanelVisibleRows) remains as a second line of defense.
  // The payload rows arrive untyped (serializable-mapped server-fn return) —
  // the row shape is NonRosterPanelRow; pass it explicitly so the generic
  // doesn't collapse to its constraint.
  const visibleRows = rosterPanelVisibleRows<NonRosterPanelRow>(data.nonRosterUsers, false);
  // draft rep choice per non-roster HL user (prefilled with any existing mapping)
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.nonRosterUsers.filter((u: NonRosterPanelRow) => u.mappedTo).map((u: NonRosterPanelRow) => [u.externalId, u.mappedTo!])),
  );
  // Explicit K/V: the payload array arrives untyped (any), so inference
  // would fall back to Map<unknown, unknown> and break the dirty check.
  const currentByExternal = new Map<string, string>(data.repMappings.map((m: RepMapping): [string, string] => [m.external_user_id, m.rep_id]));
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
    <div className="space-y-3">
      <h3 className="section-heading">Roster Mapping</h3>
      <p className="text-[13px] text-(--text-caption)">
        Map a non-roster HighLevel user to a CC rep. From then on ALL historical calls under that HighLevel user id
        count for the rep&apos;s performance and the team totals — computed from the mapping at query time. Source
        records are never rewritten: the original HL user id, message ids and timestamps stay untouched, and removing
        a mapping excludes that user&apos;s calls from roster reporting again.
      </p>
      {/* ERASE FOLLOW-UP (owner directive 2026-11-02): the payload carries no
          inactive user, so this panel lists nobody by design — the line states
          that honestly instead of implying an empty database. */}
      <div className="card card-nest space-y-1 p-0">
        <p className="p-5 text-sm text-(--text-muted)">
          Inactive users are never listed here (owner directive 2026-11-02) — no inactive user&apos;s name reaches this
          panel or the page payload at all. Existing mappings below stay active.
        </p>
        {visibleRows.map((u) => {
          const val = draft[u.externalId] ?? "";
          return (
            <div key={u.externalId} className="flex flex-wrap items-center justify-between gap-4 border-b border-(--table-border-weak) px-5 py-2.5 last:border-0">
              <span className="text-[13px] font-medium text-(--text-body)">
                {u.name || u.externalId}
                <span className="ml-2 font-mono text-xs text-(--text-muted)">{u.externalId}</span>
              </span>
              <div className="flex items-center gap-3">
                <span className="text-xs tabular-nums text-(--text-muted)">
                  {u.callCount === 1 ? "1 call in last 30 days" : u.callCount > 0 ? `${u.callCount} calls in last 30 days` : "no calls in last 30 days"}
                </span>
                <select
                  aria-label={`Map ${u.name || u.externalId} to`}
                  className="input-field"
                  value={val}
                  onChange={(e) => setDraft({ ...draft, [u.externalId]: e.target.value })}
                >
                  <option value="">Non Roster (excluded)</option>
                  {data.users.map((r: SettingsUser) => (
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
            className="btn-primary"
            disabled={busy || !dirty}
            onClick={() => onSave(nextMappings())}
          >
            Save roster mappings
          </button>
        </div>
      </div>
      {data.repMappings.length > 0 && (
        <p className="text-xs text-(--text-muted)">
          Active mappings: {data.repMappings.map((m: RepMapping) => `${m.external_user_id} → ${data.users.find((u: SettingsUser) => u.id === m.rep_id)?.name ?? m.rep_id}`).join(" · ")}
        </p>
      )}
    </div>
  );
}
