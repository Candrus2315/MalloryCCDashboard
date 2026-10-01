/**
 * PERFORMANCE MANAGEMENT shell + shared views (PIP module, Phase 1).
 *
 * SENSITIVE HR MATERIAL: everything under this shell is manager-only. PIP
 * data appears ONLY here — never on Today/Reps/Team/leaderboards or any
 * comparison surface. The pages are behind the app's global passphrase gate
 * (src/start.ts). Module principle: the system stores and displays verified
 * facts; the manager decides everything (no AI, no auto-recommendations).
 */
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import type { PipListItem } from "~/server/pip-api";
import type { PipStatus } from "~/server/store/types";

/**
 * ONE Performance nav item (owner ruling 9/30) with THREE routed segments —
 * PIPs | Templates | History — styled exactly like the Settings SubNav pills
 * (see src/components/page-tabs.tsx for the shared mechanics).
 */
export const PERFORMANCE_TABS = [
  { to: "/performance", label: "PIPs" },
  { to: "/performance/templates", label: "Templates" },
  { to: "/performance/history", label: "History" },
] as const;

export function PerformanceShell({
  path,
  children,
}: {
  path: string;
  children: ReactNode;
}) {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Performance</h1>
      <p className="mt-0.5 text-[15px] text-(--text-caption)">Performance Management</p>
      <p className="mt-1 flex items-center gap-2 text-xs text-(--text-caption)">
        <span aria-hidden="true" className="inline-block h-1 w-1 rounded-full bg-(--dot-muted)" />
        Management record · changes audited · America/New_York
      </p>
      <nav
        aria-label="Performance sections"
        className="sticky top-[68px] z-[1] -mx-4 mt-3 border-b border-(--card-border) bg-(--sticky-header-bg) px-4 backdrop-blur-sm sm:-mx-6 sm:px-6 md:top-14"
      >
        <div className="flex items-center gap-1 overflow-x-auto py-2 whitespace-nowrap">
          {PERFORMANCE_TABS.map((t) => {
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

const STATUS_LABEL: Record<PipStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** Design-spec §4a: amber = attention/in force, emerald = resolved, neutral = administrative. Never red. */
export function PipStatusChip({ status }: { status: PipStatus }) {
  const tone =
    status === "issued"
      ? "chip chip-risk"
      : status === "completed"
        ? "chip chip-positive"
        : "chip chip-neutral";
  return <span className={tone}>{STATUS_LABEL[status]}</span>;
}

export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-lg border border-(--card-border) bg-(--card-bg) px-5 py-8 text-center">
      <p className="text-[14px] font-medium">{title}</p>
      <p className="mt-1 text-[13px] text-(--text-muted)">{hint}</p>
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-(--card-border) bg-(--card-bg) p-4">{children}</div>;
}

/** Compact PIP list — the shared table across Active/Drafts/Completed/Cancelled. */
export function PipTable({
  pips,
  actions,
}: {
  pips: PipListItem[];
  actions?: (pip: PipListItem) => ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-(--card-border) bg-(--card-bg)">
      <table className="data-table min-w-[860px] text-[13px]">
        <thead>
          <tr>
            <th scope="col" className="text-left">Rep</th>
            <th scope="col" className="text-left">Title</th>
            <th scope="col" className="text-left">Status</th>
            <th scope="col" className="text-left">PIP window</th>
            <th scope="col" className="text-right">Weekly goal</th>
            <th scope="col" className="text-left">Issued</th>
            {actions && <th scope="col" className="text-right">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {pips.map((p) => (
            <tr key={p.id}>
              <td className="py-2 font-medium">{p.rep_name ?? "—"}</td>
              <td className="py-2">{p.title}</td>
              <td className="py-2"><PipStatusChip status={p.status} /></td>
              <td className="py-2 text-(--text-muted)">
                {p.pip_start_date ?? "—"} → {p.pip_end_date ?? "—"}
              </td>
              <td className="py-2 text-right">
                {p.weekly_goal_min == null ? "—" : p.weekly_goal_min}
                {p.hard_weekly_minimum && <span className="ml-1 text-[11px] text-(--text-muted)">(hard min)</span>}
              </td>
              <td className="py-2 text-(--text-muted)">{p.issued_at ? p.issued_at.slice(0, 10) : "—"}</td>
              {actions && <td className="py-2 text-right">{actions(p)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Disclosure row wrapper for inline detail panels (no drawer dependency). */
export function useToggle(): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  return [open, () => setOpen((o) => !o)];
}

export function GhostButton({
  onClick,
  children,
  disabled,
  title,
}: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded-md border border-(--card-border) px-2 py-1 text-[12px] text-(--text-caption) transition-colors hover:border-(--input-border) hover:text-(--text-primary) disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-[13px]">
      <span className="mb-1 block font-medium text-(--text-caption)">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-(--input-border) bg-(--card-bg) px-3 py-2 text-[13px] outline-none focus:border-(--text-muted)";
