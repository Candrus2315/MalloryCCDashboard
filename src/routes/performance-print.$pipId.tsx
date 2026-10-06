/**
 * PIP PRINT / PDF EXPORT (Phase 5 — owner directive 9/30: "Mallory-branded
 * print/PDF export"). A print-optimized rendering of ONE PIP that the manager
 * prints to PDF via the browser's print dialog (print CSS + window.print() —
 * no heavyweight PDF library).
 *
 * DATA HONESTY — THE CONTRACT: the printed document IS the FROZEN issue
 * snapshot (pip_evidence_snapshots v1), served verbatim by getPipPrintDoc —
 * the weekly goal-met table, factual statements, goal text, observations and
 * action plans all render the STORED snapshot content, never a recomputation
 * (a recompute would drift as live data changes; the issued document must
 * not). Check-ins, the acknowledgment state and the terminal
 * conclusion/cancellation are appended FACTS from the row/child tables — the
 * same records the Manage drawer serves — rendered in their own sections.
 * Drafts have nothing frozen yet: they print from the live row, honestly
 * labeled DRAFT — not issued.
 *
 * RBAC: the loader goes through getPipPrintDoc → assertPipManager (server-side
 * manager assertion). Employee PIP material prints for the manager only.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { getPipPrintDoc, type PipPrintDoc } from "~/server/pip-api";
import type { PipActionItem, PipCheckinRow, PipRow } from "~/server/store/types";
import { pipDateShort, type PipEvidence } from "~/server/pip-evidence";

export const Route = createFileRoute("/performance-print/$pipId")({
  loader: async ({ params }): Promise<PipPrintDoc | null> =>
    (await getPipPrintDoc({ data: { pipId: params.pipId } })) as PipPrintDoc | null,
  component: PipPrintPage,
});

/** Honest ET stamps for the document (dates + date-times). */
function etDate(v: string | null): string {
  if (!v) return "—";
  return pipDateShort(v.length > 10 ? v.slice(0, 10) : v);
}
function etDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/** The frozen document shape (written at issue; read defensively at render). */
interface PrintSnapshotDoc {
  pip: PipRow;
  employee: { id: string; name: string; email: string | null; call_start_date: string | null } | null;
  evidence: PipEvidence | null;
  statements: { key: string; text: string }[];
  template: { id: string; version: number | null; name: string | null } | null;
  evidence_note: string | null;
  captured_at: string;
  captured_by: string | null;
}

function readSnapshotDoc(raw: Record<string, unknown> | null): PrintSnapshotDoc | null {
  if (!raw) return null;
  const pip = raw.pip as PipRow | undefined;
  if (!pip || typeof pip.title !== "string") return null;
  return {
    pip,
    employee: (raw.employee as PrintSnapshotDoc["employee"]) ?? null,
    evidence: (raw.evidence as PipEvidence | null) ?? null,
    statements: Array.isArray(raw.statements) ? (raw.statements as { key: string; text: string }[]) : [],
    template: (raw.template as PrintSnapshotDoc["template"]) ?? null,
    evidence_note: typeof raw.evidence_note === "string" ? raw.evidence_note : null,
    captured_at: typeof raw.captured_at === "string" ? raw.captured_at : "",
    captured_by: typeof raw.captured_by === "string" ? raw.captured_by : null,
  };
}

const WEEK_STATE_LABEL: Record<string, string> = {
  completed: "completed",
  in_progress: "week in progress",
  future: "not started",
};

function goalLabel(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/** Meta cell in the document header band. */
function DocMeta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="pp-label">{label}</p>
      <p className="mt-0.5 text-[13px] text-[#1c1917]">{children}</p>
    </div>
  );
}

/** Section heading (uppercase micro-label — the same hierarchy as the app). */
function DocSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pp-section">
      <p className="pp-label">{title}</p>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

/** Frozen action plan list (verbatim from the snapshot; honest completion state). */
function ActionList({ items }: { items: PipActionItem[] }) {
  if (items.length === 0) return <p className="text-[13px] text-[#78716c]">— none recorded</p>;
  return (
    <ul className="space-y-1">
      {items.map((item, i) => (
        <li key={i} className="text-[13px] leading-relaxed text-[#1c1917]">
          <span aria-hidden="true" className="mr-2">{item.completed ? "☑" : "☐"}</span>
          {item.text}
          {item.completed && item.completed_at ? (
            <span className="text-[11px] text-[#78716c]"> · completed {etDate(item.completed_at.slice(0, 10))}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The check-in log (appended facts after issue — same records the Manage
 * drawer's timeline serves). Print-friendly: entries, no decorative rail.
 */
function CheckinList({ checkins }: { checkins: PipCheckinRow[] }) {
  const sorted = [...checkins].sort(
    (a, b) => a.checkin_date.localeCompare(b.checkin_date) || a.created_at.localeCompare(b.created_at),
  );
  if (sorted.length === 0) {
    return <p className="text-[13px] text-[#78716c]">No check-ins recorded yet — the log starts at issue.</p>;
  }
  return (
    <div className="space-y-3">
      {sorted.map((c) => (
        <div key={c.id} className="pp-checkin">
          <p className="text-[13px] font-medium text-[#1c1917]">
            {etDate(c.checkin_date)}
            {c.manager_name ? ` · ${c.manager_name}` : ""}
            <span className="ml-2 text-[11px] font-normal text-[#78716c]">logged {etDateTime(c.created_at)}</span>
          </p>
          {c.current_performance && <p className="mt-1 text-[13px] leading-relaxed text-[#1c1917]">{c.current_performance}</p>}
          {c.topics_discussed && <p className="mt-1 text-[12px] text-[#44403c]">Topics: {c.topics_discussed}</p>}
          {c.coaching_provided && <p className="mt-1 text-[12px] text-[#44403c]">Coaching: {c.coaching_provided}</p>}
          {c.employee_comments && <p className="mt-1 text-[12px] text-[#44403c]">Employee: {c.employee_comments}</p>}
          {c.manager_notes && <p className="mt-1 text-[12px] text-[#44403c]">{c.manager_notes}</p>}
          {c.next_actions && <p className="mt-1 text-[12px] text-[#44403c]">Next actions: {c.next_actions}</p>}
          {c.next_checkin_date && (
            <p className="mt-1 text-[12px] text-[#78716c]">Next check-in recorded: {etDate(c.next_checkin_date)}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function PipPrintPage() {
  const data = Route.useLoaderData();

  // Scope print CSS to this page: hide the app shell chrome when printing.
  useEffect(() => {
    document.body.classList.add("pip-print-page");
    return () => {
      document.body.classList.remove("pip-print-page");
    };
  }, []);

  if (!data) {
    return (
      <div className="card mx-auto mt-6 max-w-xl">
        <p className="text-[14px] font-medium">PIP not found</p>
        <p className="mt-1 text-[13px] text-(--text-muted)">This record does not exist in the database.</p>
        <Link to="/performance" className="btn-secondary mt-3 inline-flex">
          Back to Performance
        </Link>
      </div>
    );
  }

  const { pip: liveRow, checkins, generated_at } = data;
  const doc = readSnapshotDoc(data.document);
  const isDraft = liveRow.status === "draft" || !doc;
  // The frozen pip row carries the DOCUMENT content; the live row carries the
  // permanent record fields (status, ack, conclusion/cancellation).
  const drow: PipRow = doc?.pip ?? liveRow;

  return (
    <div>
      {/* Screen-only toolbar (hidden in print) */}
      <div className="pip-print-toolbar mx-auto mt-2 flex max-w-[820px] flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link to="/performance" className="btn-secondary">
            ← Back to Performance
          </Link>
          <span className="text-[12px] text-(--text-muted)">
            {isDraft ? "Draft preview — not issued" : `v${liveRow.current_version} frozen snapshot`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-[12px] text-(--text-muted) sm:inline">Use the browser print dialog → Save as PDF</span>
          <button type="button" className="btn-primary" onClick={() => window.print()}>
            Print / Save PDF
          </button>
        </div>
      </div>

      <article className="pip-print-doc" lang="en">
        {/* Masthead — the app's brand hierarchy: wordmark + hairline + uppercase micro-label */}
        <header className="pp-masthead">
          <div className="pp-brand">
            <span className="pp-wordmark">Mallory Portraits</span>
            <span className="pp-microlabel">Client Concierge — Performance</span>
          </div>
          <div className="pp-brand-right">
            <span className="pp-doctitle-kicker">Performance Improvement Plan</span>
            <span className="pp-versionline">
              {isDraft ? "DRAFT — not issued" : `Issued document · v${liveRow.current_version} frozen snapshot`}
            </span>
          </div>
        </header>

        {/* Document title band */}
        <div className="pp-titleband">
          <h1 className="pp-title">{drow.title}</h1>
          <div className="pp-metagrid">
            <DocMeta label="Employee">{doc?.employee?.name ?? drow.rep_id ?? "—"}</DocMeta>
            <DocMeta label="Status">{liveRow.status.charAt(0).toUpperCase() + liveRow.status.slice(1)}</DocMeta>
            <DocMeta label="PIP window">
              {drow.pip_start_date ? etDate(drow.pip_start_date) : "—"} – {drow.pip_end_date ? etDate(drow.pip_end_date) : "—"}
            </DocMeta>
            <DocMeta label="Review period">
              {drow.review_start_date ? etDate(drow.review_start_date) : "—"} – {drow.review_end_date ? etDate(drow.review_end_date) : "—"}
            </DocMeta>
            <DocMeta label="Weekly minimum">
              {drow.weekly_goal_min == null
                ? "— not set"
                : `${goalLabel(drow.weekly_goal_min)} paid bookings · ${drow.hard_weekly_minimum ? "hard minimum, never averaged" : "soft goal"}`}
            </DocMeta>
            <DocMeta label="Check-in cadence">{drow.checkin_cadence_days != null ? `Every ${drow.checkin_cadence_days} days` : "Not set"}</DocMeta>
            <DocMeta label="Issued">{drow.issued_at ? `${etDateTime(drow.issued_at)} ET${drow.issued_by ? ` · by ${drow.issued_by}` : ""}` : "— draft"}</DocMeta>
            {doc?.template?.name && (
              <DocMeta label="Template">
                {doc.template.name}
                {doc.template.version != null ? ` · v${doc.template.version} at creation` : ""}
              </DocMeta>
            )}
          </div>
        </div>

        {isDraft && (
          <p className="pp-draftnote">
            Draft preview — this plan has not been issued. The issued document freezes permanently at issue; this content
            is still editable in the guided creation flow.
          </p>
        )}

        {/* Goal + manager observations (verbatim from the frozen document) */}
        <DocSection title="Goal">
          {drow.goal_text ? (
            <p className="pp-prose">{drow.goal_text}</p>
          ) : (
            <p className="text-[13px] text-[#78716c]">— no goal recorded</p>
          )}
        </DocSection>
        {drow.manager_observations && (
          <DocSection title="Manager observations">
            <p className="pp-prose">{drow.manager_observations}</p>
          </DocSection>
        )}

        {/* Action plans (frozen verbatim) */}
        {(drow.action_plan.length > 0 || drow.personal_development_actions.length > 0 || drow.professional_development_actions.length > 0) && (
          <DocSection title="Action plans">
            <div className="space-y-3">
              <div>
                <p className="pp-sublabel">Action plan</p>
                <ActionList items={drow.action_plan} />
              </div>
              {drow.personal_development_actions.length > 0 && (
                <div>
                  <p className="pp-sublabel">Personal development</p>
                  <ActionList items={drow.personal_development_actions} />
                </div>
              )}
              {drow.professional_development_actions.length > 0 && (
                <div>
                  <p className="pp-sublabel">Professional development</p>
                  <ActionList items={drow.professional_development_actions} />
                </div>
              )}
            </div>
          </DocSection>
        )}

        {/* Weekly goal-met table — THE FROZEN EVIDENCE, verbatim */}
        {doc && (
          <>
            {doc.evidence ? (
              <DocSection title="Weekly goal-met record (frozen at issue)">
                <table className="pp-table">
                  <thead>
                    <tr>
                      <th className="pp-th text-left">Week</th>
                      <th className="pp-th text-right">PIP minimum</th>
                      <th className="pp-th text-right">Dashboard goal</th>
                      <th className="pp-th text-right">Actual</th>
                      <th className="pp-th text-left">Met</th>
                      <th className="pp-th text-left">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doc.evidence.weekly.map((w) => (
                      <tr key={w.week_start}>
                        <td className="pp-td">
                          {etDate(w.clamped_start)}
                          {w.clamped_start !== w.clamped_end ? <>–{etDate(w.clamped_end)}</> : null}
                        </td>
                        <td className="pp-td text-right">{w.pip_goal ?? "—"}</td>
                        <td className="pp-td text-right text-[#78716c]">
                          {w.dashboard_goal == null ? "—" : goalLabel(w.dashboard_goal)}
                        </td>
                        <td className="pp-td text-right">{w.actual == null ? "—" : w.actual}</td>
                        <td className="pp-td">
                          {w.met === true ? (
                            <span className="pp-met">Met</span>
                          ) : w.met === false ? (
                            <span className="pp-notmet">Not met</span>
                          ) : (
                            <span className="text-[#78716c]">—</span>
                          )}
                        </td>
                        <td className="pp-td text-[#78716c]">{WEEK_STATE_LABEL[w.state] ?? w.state}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="pp-finenote">
                  {doc.evidence.weeks_goal_met}/{doc.evidence.weeks_completed} weeks met · Each week is evaluated
                  individually against the weekly minimum; weeks are never averaged. The dashboard goal column is
                  provenance (rep goal or team share) — the met evaluation uses the PIP's own minimum.
                </p>
                {(doc.evidence.warnings?.length ?? 0) > 0 && (
                  <div className="pp-warnbox">
                    <p className="pp-label">Data warnings at capture</p>
                    <ul className="mt-1 space-y-0.5">
                      {doc.evidence.warnings.map((wtext, i) => (
                        <li key={i} className="text-[12px] text-[#78350f]">{wtext}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </DocSection>
            ) : doc.evidence_note ? (
              <DocSection title="Weekly goal-met record">
                <p className="text-[13px] text-[#78716c]">{doc.evidence_note}</p>
              </DocSection>
            ) : null}

            {/* Frozen factual statements — verbatim */}
            {doc.statements.length > 0 && (
              <DocSection title="Verified performance statements">
                <p className="pp-finenote">Generated from verified dashboard data at issue — frozen verbatim.</p>
                <ul className="mt-1.5 space-y-2">
                  {doc.statements.map((s) => (
                    <li key={s.key} className="pp-statement">{s.text}</li>
                  ))}
                </ul>
              </DocSection>
            )}
          </>
        )}

        {/* Check-in log (appended after issue) */}
        {!isDraft && (
          <DocSection title="Check-in log (appended after issue)">
            <CheckinList checkins={checkins} />
          </DocSection>
        )}

        {/* Acknowledgment state (permanent record; no employee logins — the manager records it) */}
        {!isDraft && (
          <DocSection title="Acknowledgment">
            {liveRow.manager_acked_at ? (
              <p className="pp-prose">
                Employee acknowledgment of this plan was recorded{" "}
                {etDateTime(liveRow.manager_acked_at)} ET
                {liveRow.manager_acked_by ? ` by ${liveRow.manager_acked_by} (manager)` : ""}.
              </p>
            ) : (
              <p className="text-[13px] text-[#92400e]">
                Acknowledgment not yet recorded — the manager records it during the acknowledgment meeting.
              </p>
            )}
          </DocSection>
        )}

        {/* Terminal record: conclusion or cancellation (permanent record fields) */}
        {liveRow.status === "completed" && (
          <DocSection title="Conclusion (completed plan)">
            <p className="pp-prose">
              {liveRow.conclusion_category ?? "—"}
              {liveRow.completed_at ? ` · ${etDateTime(liveRow.completed_at)} ET` : ""}
              {liveRow.conclusion_notes ? ` — ${liveRow.conclusion_notes}` : ""}
            </p>
          </DocSection>
        )}
        {liveRow.status === "cancelled" && (
          <DocSection title="Cancellation record">
            <p className="pp-prose">
              Cancelled {etDateTime(liveRow.cancelled_at)} ET{liveRow.cancelled_by ? ` by ${liveRow.cancelled_by}` : ""} —
              reason: {liveRow.cancellation_reason ?? "—"}
            </p>
          </DocSection>
        )}

        {/* Footer — honest print provenance */}
        <footer className="pp-footer">
          <p>
            Printed {etDateTime(generated_at)} ET ·{" "}
            {isDraft
              ? "Draft preview — no frozen snapshot exists until issue."
              : `Issued document v${liveRow.current_version} — frozen snapshot, content unchanged since issue (captured ${etDateTime(doc?.captured_at ?? null)} ET${doc?.captured_by ? ` by ${doc.captured_by}` : ""}).`}
          </p>
          <p className="mt-0.5">Mallory Portraits · CC Performance Dashboard · Manager-only document</p>
        </footer>
      </article>
    </div>
  );
}
