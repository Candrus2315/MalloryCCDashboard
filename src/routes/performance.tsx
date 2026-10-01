import { createFileRoute, useRouter, type SearchParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  addPipCheckin,
  cancelPip,
  completePip,
  getPerformanceList,
  getPipDetail,
  listPipTemplates,
  type PipListItem,
} from "~/server/pip-api";
import type { PipDetail } from "~/server/pip-api";
import { Card, EmptyState, Field, GhostButton, PerformanceShell, PipStatusChip, PipTable, inputClass } from "~/components/performance-shell";

/** Owner ruling 9/30: statuses are FILTER CHIPS on one list, not separate pages. */
const STATUS_FILTERS = ["issued", "draft", "completed", "cancelled", "all"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
const FILTER_LABEL: Record<StatusFilter, string> = {
  issued: "Active",
  draft: "Drafts",
  completed: "Completed",
  cancelled: "Cancelled",
  all: "All",
};
function isStatusFilter(v: unknown): v is StatusFilter {
  return typeof v === "string" && (STATUS_FILTERS as readonly string[]).includes(v);
}

type PipSearch = { status?: string };

export const Route = createFileRoute("/performance")({
  validateSearch: (search: SearchParams): PipSearch => ({
    status: typeof search.status === "string" ? search.status : undefined,
  }),
  loader: () => getPerformanceList(),
  component: PipsPage,
});

function PipsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const filter: StatusFilter = isStatusFilter(search.status) ? search.status : "issued";
  const all = data.pips;
  const counts: Record<StatusFilter, number> = {
    issued: all.filter((p) => p.status === "issued").length,
    draft: all.filter((p) => p.status === "draft").length,
    completed: all.filter((p) => p.status === "completed").length,
    cancelled: all.filter((p) => p.status === "cancelled").length,
    all: all.length,
  };
  const shown = filter === "all" ? all : all.filter((p) => p.status === filter);

  // Template names for record chips ("Template: {name} v{n}") — read-only.
  const [templatesById, setTemplatesById] = useState<Map<string, { name: string; version: number }>>(new Map());
  useEffect(() => {
    let alive = true;
    listPipTemplates().then((t) => {
      if (alive) setTemplatesById(new Map(t.templates.map((x) => [x.id, { name: x.name, version: x.version }])));
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <PerformanceShell path="/performance">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-(--text-caption)">
          {filter === "draft"
            ? "Editable drafts, private to managers."
            : filter === "all"
              ? "Every record, every status — newest first."
              : filter === "issued"
                ? "Issued plans in force."
                : "Closed plans."}
        </p>
        <button
          type="button"
          className="rounded-md bg-(--accent-solid) px-3 py-2 text-[13px] font-medium text-(--accent-solid-fg) hover:bg-(--accent-hover)"
          onClick={() => navigate({ to: "/performance/new" })}
        >
          New PIP
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Status filter">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            className={
              "rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors " +
              (filter === f
                ? "border-transparent bg-(--accent-solid) text-(--accent-solid-fg)"
                : "border-(--card-border) bg-(--card-bg) text-(--text-caption) hover:border-(--input-border) hover:text-(--text-primary)")
            }
            onClick={() => navigate({ to: "/performance", search: { status: f } })}
          >
            {FILTER_LABEL[f]} <span className="tabular-nums">{counts[f]}</span>
          </button>
        ))}
      </div>

      <div className="mt-4">
        {shown.length === 0 ? (
          <EmptyState
            title={filter === "issued" ? "No active PIPs" : `No ${FILTER_LABEL[filter].toLowerCase()} PIPs`}
            hint={
              filter === "issued"
                ? "Issued plans appear here until completed or cancelled."
                : filter === "draft"
                  ? "Start a draft from the New PIP button or from a template."
                  : "Nothing recorded under this status yet."
            }
          />
        ) : (
          <PipTable
            pips={shown}
            templatesById={templatesById}
            actions={(pip) =>
              pip.status === "draft" ? (
                <DraftRowActions pip={pip} />
              ) : pip.status === "issued" ? (
                <ActivePipActions pip={pip} />
              ) : undefined
            }
          />
        )}
      </div>
    </PerformanceShell>
  );
}

function DraftRowActions({ pip }: { pip: PipListItem }) {
  const router = useRouter();
  return (
    <div className="flex justify-end">
      <GhostButton
        onClick={() => {
          // The 7-step wizard (/performance/new?pip=…) is the only draft editor now.
          void router.navigate({ to: "/performance/new", search: { step: "1", pip: pip.id } });
        }}
      >
        Continue draft
      </GhostButton>
    </div>
  );
}

// ---------- issued PIP management (Phase 1 panel, re-homed) ----------

function ActivePipActions({ pip }: { pip: PipListItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex justify-end">
      <GhostButton onClick={() => setOpen((o) => !o)}>{open ? "Close" : "Manage"}</GhostButton>
      {open && <ActivePipPanel pip={pip} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ActivePipPanel({ pip, onClose }: { pip: PipListItem; onClose: () => void }) {
  const router = useRouter();
  const [detail, setDetail] = useState<PipDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [checkinDate, setCheckinDate] = useState(new Date().toISOString().slice(0, 10));
  const [checkinNotes, setCheckinNotes] = useState("");
  const [nextCheckin, setNextCheckin] = useState("");

  useEffect(() => {
    let alive = true;
    getPipDetail({ data: { pipId: pip.id } }).then((d) => {
      if (alive) setDetail(d);
    });
    return () => {
      alive = false;
    };
  }, [pip.id]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await router.invalidate();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-(--scrim)" onClick={onClose}>
      <div
        className="h-full w-[560px] max-w-[92vw] overflow-y-auto border-l border-(--card-border) bg-(--page-bg) p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[15px] font-semibold">{pip.title}</p>
            <p className="text-[13px] text-(--text-muted)">
              {pip.rep_name ?? "—"} · {pip.pip_start_date ?? "—"} → {pip.pip_end_date ?? "—"}
            </p>
          </div>
          <GhostButton onClick={onClose}>Close</GhostButton>
        </div>

        {error && <p className="mt-3 rounded-md bg-(--surface-subtle) px-3 py-2 text-[12px] text-red-600">{error}</p>}

        <Card>
          <p className="text-[13px] font-medium">Goal</p>
          <p className="mt-1 whitespace-pre-wrap text-[13px] text-(--text-body)">{pip.goal_text ?? "—"}</p>
          {pip.manager_observations && (
            <>
              <p className="mt-3 text-[13px] font-medium">Manager observations (frozen at issue)</p>
              <p className="mt-1 whitespace-pre-wrap text-[13px] text-(--text-body)">{pip.manager_observations}</p>
            </>
          )}
          {detail && detail.snapshots.length > 0 && (
            <p className="mt-3 text-[12px] text-(--text-muted)">
              Evidence snapshot v{detail.snapshots[detail.snapshots.length - 1].version} written {detail.snapshots[detail.snapshots.length - 1].created_at.slice(0, 10)} — the issued document is immutable.
            </p>
          )}
        </Card>

        <Card>
          <p className="text-[13px] font-medium">Check-ins ({detail?.checkins.length ?? 0})</p>
          <div className="mt-2 space-y-2">
            {(detail?.checkins ?? []).map((c) => (
              <div key={c.id} className="rounded-md border border-(--card-border) px-3 py-2">
                <p className="text-[12px] font-medium">{c.checkin_date}{c.manager_name ? ` · ${c.manager_name}` : ""}</p>
                {c.current_performance && <p className="mt-1 text-[12px] text-(--text-body)">{c.current_performance}</p>}
                {c.manager_notes && <p className="mt-1 text-[12px] text-(--text-muted)">{c.manager_notes}</p>}
              </div>
            ))}
            {(detail?.checkins.length ?? 0) === 0 && <p className="text-[12px] text-(--text-muted)">No check-ins yet.</p>}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Field label="Check-in date">
              <input type="date" className={inputClass} value={checkinDate} onChange={(e) => setCheckinDate(e.target.value)} />
            </Field>
            <Field label="Next check-in (optional)">
              <input type="date" className={inputClass} value={nextCheckin} onChange={(e) => setNextCheckin(e.target.value)} />
            </Field>
          </div>
          <Field label="Notes (performance, topics, coaching, next actions)">
            <textarea className={inputClass + " mt-1 min-h-[64px]"} value={checkinNotes} onChange={(e) => setCheckinNotes(e.target.value)} />
          </Field>
          <div className="mt-2">
            <button
              type="button"
              disabled={busy || !checkinDate || !checkinNotes.trim()}
              className="rounded-md bg-(--accent-solid) px-3 py-1.5 text-[12px] font-medium text-(--accent-solid-fg) disabled:opacity-50"
              onClick={() =>
                run(() =>
                  addPipCheckin({
                    data: {
                      pipId: pip.id,
                      checkinDate,
                      currentPerformance: checkinNotes,
                      managerNotes: checkinNotes,
                      nextCheckinDate: nextCheckin || null,
                      managerName: "christopher",
                    },
                  }),
                )
              }
            >
              Add check-in
            </button>
          </div>
        </Card>

        <Card>
          <p className="text-[13px] font-medium">Complete the PIP</p>
          <p className="mt-0.5 text-[12px] text-(--text-muted)">Requires a conclusion category and notes — both entered by you.</p>
          <div className="mt-2">
            <Field label="Conclusion category">
              <input className={inputClass} placeholder="e.g. Successful completion / Extended / Terminated" value={category} onChange={(e) => setCategory(e.target.value)} />
            </Field>
          </div>
          <Field label="Conclusion notes">
            <textarea className={inputClass + " mt-1 min-h-[64px]"} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <div className="mt-2">
            <button
              type="button"
              disabled={busy || !category.trim() || !notes.trim()}
              className="rounded-md bg-(--accent-solid) px-3 py-1.5 text-[12px] font-medium text-(--accent-solid-fg) disabled:opacity-50"
              onClick={() => run(() => completePip({ data: { pipId: pip.id, conclusionCategory: category, conclusionNotes: notes } }))}
            >
              Mark completed
            </button>
          </div>
        </Card>

        <Card>
          <p className="text-[13px] font-medium">Cancel the PIP</p>
          <p className="mt-0.5 text-[12px] text-(--text-muted)">Ends the plan without completion; the reason is recorded permanently.</p>
          <Field label="Cancellation reason">
            <textarea className={inputClass + " mt-1 min-h-[48px]"} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          </Field>
          <div className="mt-2">
            <button
              type="button"
              disabled={busy || !cancelReason.trim()}
              className="rounded-md border border-(--card-border) px-3 py-1.5 text-[12px] font-medium text-(--text-body) hover:border-(--input-border) disabled:opacity-50"
              onClick={() => run(() => cancelPip({ data: { pipId: pip.id, reason: cancelReason } }))}
            >
              Cancel PIP
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}
