/**
 * COMMISSION CENTER shell + shared chips (Phase B, presentation-only).
 *
 * Payroll workspace — same sensitivity class as the Performance module: the
 * pages live behind the app's global passphrase gate (src/start.ts). NO
 * approval/submit/copy-payroll actions exist in Phase B (they arrive with
 * Phase C — a muted placeholder note stands in the payroll zone; dead chrome
 * is dishonest).
 *
 * Shell mirrors performance-shell.tsx (title block + sticky SubNav) —
 * including the mandatory mobile contract: the phone header is 68px, so any
 * new sticky in-page element pairs top-[68px] md:top-14 with the -mx/px
 * mirroring of the main container.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { StatusChip } from "./StatusChip";
import { InfoTip } from "./InfoTip";
import type { ChipView } from "./commission-views";

export const COMMISSION_TABS = [
  { to: "/commissions", label: "Center" },
  { to: "/commissions-validation", label: "Validation" },
] as const;

export function CommissionsShell({
  path,
  title,
  statusChip,
  children,
}: {
  path: string;
  title: string;
  /** Cycle status chip beside the h1 (§3.1) — optional (validation page has none). */
  statusChip?: ChipView;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {statusChip && <CommissionChip view={statusChip} />}
          </div>
          <p className="mt-0.5 text-[15px] text-(--text-caption)">
            <span className="text-(--text-primary)">Payroll workspace</span>
          </p>
        </div>
        <span className="pt-1">
          <InfoTip
            align="right"
            tip="Payroll workspace — commission cycles are assembled from completed Mon–Sun weeks and finalized automatically at the Sunday cutoff. The manager never types counts; corrections are reason-required and audited (Phase C)."
          />
        </span>
      </div>
      <p className="mt-1 flex items-center gap-2 text-xs text-(--text-caption)">
        <span aria-hidden="true" className="inline-block h-1 w-1 rounded-full bg-(--dot-muted)" />
        America/New_York
      </p>
      <nav
        aria-label="Commission sections"
        className="sticky top-[68px] z-[1] -mx-4 mt-3 border-b border-(--card-border) bg-(--sticky-header-bg) px-4 backdrop-blur-sm sm:-mx-6 sm:px-6 md:top-14"
      >
        <div className="flex items-center gap-1 overflow-x-auto py-2 whitespace-nowrap">
          {COMMISSION_TABS.map((t) => {
            const active = path === t.to;
            return (
              <Link
                key={t.to}
                to={t.to}
                aria-current={active ? "page" : undefined}
                className={
                  "rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors " +
                  (active
                    ? "bg-(--surface-subtle) text-(--text-primary)"
                    : "text-(--text-caption) hover:bg-(--surface-subtle) hover:text-(--text-primary)")
                }
              >
                {t.label}
              </Link>
            );
          })}
        </div>
      </nav>
      <div className="mt-4">{children}</div>
    </div>
  );
}

/**
 * Status chip with the §6 dot overrides (StatusChip kinds + the one hybrid
 * §6.2 asks for: neutral chip, positive dot). Never color-only.
 */
export function CommissionChip({ view }: { view: ChipView }) {
  if (view.dotOverride) {
    const dot = view.dotOverride === "positive" ? "bg-(--dot-positive)" : "bg-(--dot-muted)";
    return (
      <span className={`chip chip-${view.kind}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
        {view.label}
      </span>
    );
  }
  return <StatusChip kind={view.kind} label={view.label} />;
}
