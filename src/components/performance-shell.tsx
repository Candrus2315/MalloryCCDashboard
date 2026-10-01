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
import type { PipActionItem, PipStatus } from "~/server/store/types";
import { StatusChip } from "./StatusChip";
import { InfoTip } from "./InfoTip";

/**
 * ONE Performance nav item (owner ruling 9/30) with THREE routed segments —
 * PIPs | Templates | History — styled exactly like the Settings SubNav pills
 * (see src/components/page-tabs.tsx for the shared mechanics).
 *
 * ROUTE NOTE (refinement pass 9/30): the segment routes are the DASH-NAMED
 * literal routes (/performance-templates, /performance-history) that actually
 * exist in the route tree — the nested /performance/* restructure is deferred
 * to Phase 3 (needs a layout + Outlet change).
 */
export const PERFORMANCE_TABS = [
  { to: "/performance", label: "PIPs" },
  { to: "/performance-templates", label: "Templates" },
  { to: "/performance-history", label: "History" },
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
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Performance</h1>
          <p className="mt-0.5 text-[15px] text-(--text-caption)">
            <span className="text-(--text-primary)">Management workspace</span>
          </p>
        </div>
        <span className="pt-1">
          <InfoTip
            align="right"
            tip="Management only — visible to authorized managers, never ordinary CC users, never a leaderboard. The system stores and displays verified data; every decision, observation, and conclusion is entered by a manager."
          />
        </span>
      </div>
      <p className="mt-1 flex items-center gap-2 text-xs text-(--text-caption)">
        <span aria-hidden="true" className="inline-block h-1 w-1 rounded-full bg-(--dot-muted)" />
        America/New_York
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

/**
 * Design-spec §4a tones, re-pointed at the SHARED StatusChip (refinement spec
 * §2): issued/active = risk + caution dot, completed = positive, draft +
 * cancelled = neutral. NO line-through on Cancelled — plain neutral chip.
 */
export function PipStatusChip({ status }: { status: PipStatus }) {
  const kind: "risk" | "positive" | "neutral" =
    status === "issued" ? "risk" : status === "completed" ? "positive" : "neutral";
  return <StatusChip kind={kind} label={STATUS_LABEL[status]} />;
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
  templatesById,
  actions,
}: {
  pips: PipListItem[];
  /** Template names for record provenance chips ("Template: {name} v{n}") — Unit 3. */
  templatesById?: Map<string, { name: string; version: number }>;
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
          {pips.map((p) => {
            const tpl = p.template_id ? templatesById?.get(p.template_id) : undefined;
            return (
              <tr key={p.id}>
                <td className="py-2 font-medium">{p.rep_name ?? "—"}</td>
                <td className="py-2">
                  {p.title}
                  {tpl && (
                    <span className="chip chip-neutral ml-2 align-middle text-[11px]">
                      Template: {tpl.name} v{p.template_version ?? tpl.version}
                    </span>
                  )}
                </td>
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
            );
          })}
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

/** Add/remove list editor for PipActionItem rows (wizard steps 4–5 + template editor). */
export function ListEditor({
  items,
  onChange,
  addLabel,
}: {
  items: PipActionItem[];
  onChange: (items: PipActionItem[]) => void;
  addLabel: string;
}) {
  if (items.length === 0) {
    return (
      <button
        type="button"
        onClick={() => onChange([{ text: "", completed: false, completed_at: null }])}
        className="rounded-md border border-(--card-border) px-3 py-2 text-[12px] text-(--text-caption) transition-colors hover:border-(--input-border) hover:text-(--text-primary)"
      >
        {addLabel}
      </button>
    );
  }
  return (
    <div>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              className={inputClass}
              value={item.text}
              placeholder="Describe the action…"
              onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
            />
            <button
              type="button"
              aria-label={`Remove action ${i + 1}`}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-(--text-muted) transition-colors hover:bg-(--surface-subtle) hover:text-(--text-primary)"
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...items, { text: "", completed: false, completed_at: null }])}
        className="mt-1.5 rounded-md border border-(--card-border) px-3 py-2 text-[12px] text-(--text-caption) transition-colors hover:border-(--input-border) hover:text-(--text-primary)"
      >
        {addLabel}
      </button>
    </div>
  );
}

export const inputClass =
  "w-full rounded-md border border-(--input-border) bg-(--card-bg) px-3 py-2 text-[13px] outline-none focus:border-(--text-muted)";
