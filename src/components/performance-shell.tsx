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

export const PERFORMANCE_TABS = [
  { to: "/performance", label: "Active PIPs" },
  { to: "/performance-drafts", label: "Drafts" },
  { to: "/performance-completed", label: "Completed" },
  { to: "/performance-cancelled", label: "Cancelled" },
  { to: "/performance-templates", label: "Templates" },
  { to: "/performance-history", label: "History" },
] as const;

export function PerformanceShell({
  path,
  title,
  subtitle,
  children,
}: {
  path: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div>
      <h1 className="text-[19px] font-semibold tracking-tight">Performance Management</h1>
      <p className="mt-0.5 text-[13px] text-(--text-muted)">
        Confidential manager workspace — deterministic and evidence-based. The system stores and displays;
        every decision, observation, and conclusion is entered by a manager. Nothing here appears on rep-facing
        or comparison surfaces.
      </p>
      <nav aria-label="Performance Management sections" className="mt-3 flex flex-wrap items-center gap-1">
        {PERFORMANCE_TABS.map((t) => {
          const active = path === t.to;
          return (
            <Link
              key={t.to}
              to={t.to}
              aria-current={active ? "page" : undefined}
              className={
                "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors " +
                (active
                  ? "bg-(--accent-solid) text-(--accent-solid-fg)"
                  : "text-(--text-caption) hover:bg-(--surface-subtle) hover:text-(--text-primary)")
              }
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-5">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        <p className="mt-0.5 text-[13px] text-(--text-muted)">{subtitle}</p>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<PipStatus, string> = {
  draft: "Draft",
  issued: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function PipStatusChip({ status }: { status: PipStatus }) {
  const tone =
    status === "issued"
      ? "bg-(--surface-subtle) text-(--text-primary)"
      : status === "completed"
        ? "bg-(--surface-subtle) text-(--text-muted)"
        : status === "cancelled"
          ? "bg-(--surface-subtle) text-(--text-muted) line-through"
          : "bg-(--surface-subtle) text-(--text-caption)";
  return <span className={"inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " + tone}>{STATUS_LABEL[status]}</span>;
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
