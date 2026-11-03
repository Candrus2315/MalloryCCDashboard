import { useEffect, useState } from "react";
import { StatusChip } from "~/components/StatusChip";
import { WarningList } from "~/components/warnings";
import {
  PASSPHRASE_WARNING_LEAD,
  PASSPHRASE_WARNING_REST,
  connectionStatusView,
  passphraseStatus,
  providerLabel,
} from "~/components/settings-views";
import { Panel } from "~/components/page-panel";
import { SectionHeader } from "~/components/settings/SectionHeader";
import type { SettingsData } from "~/routes/settings";

export function SecuritySection({ data }: { data: SettingsData }) {
  // Hydration-safe clock: ages render after mount (SSR shows chips without ages).
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => setNowMs(Date.now()), []);
  const pass = passphraseStatus(data.passphraseConfigured);
  const conns = data.connections.map((c) => connectionStatusView(c, nowMs));
  const demo = data.meta.mode === "memory";
  return (
    <section id="security" className="scroll-mt-28">
      <Panel className="p-4 sm:p-5">
        <SectionHeader id="security" />
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <StatusChip kind={pass.tone} label={pass.label} />
            {conns.map((c) => (
              <span key={c.provider} className="flex items-center gap-2 text-[13px]">
                <span className="font-medium text-(--text-body)">{providerLabel(c.provider)}</span>
                <StatusChip kind={c.tone} label={c.label} />
                {c.lastSync && <span className="text-xs text-(--text-muted)">{c.lastSync}</span>}
                {c.error && (
                  <span className="max-w-[220px] truncate text-xs text-(--neg-text)" title={c.error}>
                    {c.error}
                  </span>
                )}
              </span>
            ))}
            {conns.length === 0 && <span className="text-[13px] text-(--text-muted)">No connections recorded yet — press SYNC NOW.</span>}
          </div>
          {pass.detail && (
            <p className="status-banner">
              <span className="font-medium">{PASSPHRASE_WARNING_LEAD}</span> {PASSPHRASE_WARNING_REST}
            </p>
          )}
          {demo && (
            <p className="status-banner">
              <span className="font-medium">Running on in-memory demo data</span>
              {data.meta.dbReason ? ` — ${data.meta.dbReason}` : ""}. Edits persist for this server session only.
            </p>
          )}
          <WarningList items={data.staleWarnings} />
        </div>
      </Panel>
    </section>
  );
}
