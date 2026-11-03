import { useEffect, useState } from "react";
import { etSyncStamp } from "~/server/date-logic";
import { providerLabel, providerLatestRunView } from "~/components/settings-views";
import type { SettingsData } from "~/routes/settings";

/* etSyncStamp moved to date-logic.ts (QA audit 2026-10-08) — the availability
   sync panel renders the SAME ET stamp; imported above. */

export function SyncCenter({ data, onSync }: { data: SettingsData; onSync: () => Promise<string> }) {
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Hydration-safe clock: a live "running" chip resolves after mount (SSR
  // shows the latest finished run's state — same pattern as the age clocks).
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => setNowMs(Date.now()), []);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-(--text-caption)">Background syncs are duplicate-safe; cancellations update in place. Google Sheets syncs live when its access is granted; HighLevel and Acuity run on demo adapters until their credentials arrive.</p>
        <button
          className="btn-primary"
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
      {msg && <p className="text-xs text-(--text-caption)">{msg}</p>}
      <div className="overflow-x-auto scroll-x">
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
                <td colSpan={5} className="text-(--text-muted)">
                  No syncs recorded yet — press SYNC NOW.
                </td>
              </tr>
            )}
            {data.connections.map((c) => {
              // Owner directive 2026-10-09: Status/Last Sync/Sync Errors read
              // the LATEST sync_runs run for the provider (success / running /
              // error + its stamp) — an earlier error never outlives a later
              // success. "Last Successful" stays the connection row's
              // last_successful_sync_at (preserved across failed attempts).
              const run = providerLatestRunView(
                c,
                data.runWindow.filter((r) => r.provider === c.provider),
                data.runningSyncRuns.find((r) => r.provider === c.provider) ?? null,
                nowMs,
              );
              const chip =
                run.label === "demo" || run.label === "running"
                  ? "bg-(--chip-current-bg) text-(--chip-current-fg)"
                  : run.label === "connected"
                    ? "bg-(--chip-good-bg) text-(--chip-good-fg)"
                    : run.label === "error"
                      ? "bg-(--chip-bad-bg) text-(--chip-bad-fg)"
                      : "bg-(--bar-track) text-(--chip-neutral-fg)";
              return (
                <tr key={c.provider}>
                  <td className="font-medium text-(--text-primary)">{providerLabel(c.provider)}</td>
                  <td>
                    <span className={"rounded-full px-2 py-0.5 text-xs font-medium " + chip}>{run.label}</span>
                  </td>
                  <td>{run.lastRunAt ? etSyncStamp(run.lastRunAt) : "—"}</td>
                  <td>{c.last_successful_sync_at ? etSyncStamp(c.last_successful_sync_at) : "—"}</td>
                  <td className="text-(--neg-text)">{run.lastRunError ?? "—"}</td>
                </tr>
              );
            })}
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
                  <td>{providerLabel(r.provider)}</td>
                  <td className={r.status === "error" ? "text-(--neg-text)" : ""}>{r.status}</td>
                  <td>{etSyncStamp(r.started_at)}</td>
                  <td className="text-right">{r.records_upserted}</td>
                  <td className="text-(--neg-text)">{r.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
