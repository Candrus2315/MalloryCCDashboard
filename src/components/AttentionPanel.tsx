/**
 * Management Attention panel (today-redesign-spec §3.5; reused by the Team
 * redesign as "Team Attention" per design/team-redesign-spec.md §6 — pass
 * `title`/`subtitle` to retitle; defaults keep the Today page unchanged).
 * Notes arrive fully composed from the *-views modules (rule-based, existing
 * outputs only) — this component is presentation only: severity dot → note →
 * right-aligned rep name, hairline dividers, all-clear line when nothing
 * fired.
 */
import type { AttentionNote } from "./today-views";

export function AttentionPanel({
  notes,
  title = "Management Attention",
  subtitle = "Rule-based from current week metrics — no scores.",
}: {
  notes: AttentionNote[];
  title?: string;
  subtitle?: string;
}) {
  return (
    <section className="card card-dense">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="section-heading">{title}</p>
        <p className="text-xs font-normal text-(--text-muted)">{subtitle}</p>
      </div>
      {notes.length === 0 ? (
        <p className="mt-3 text-[13px] text-(--text-body)">
          No attention items — no rep is behind pace or below team conversion.
        </p>
      ) : (
        <ul className="mt-1">
          {notes.map((n, i) => (
            <li
              key={`${n.rep}-${i}`}
              className="flex items-start gap-2.5 border-b border-(--table-border-weak) py-2 first:pt-2.5 last:border-0 last:pb-0"
            >
              <span
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${n.severity === "risk" ? "bg-(--dot-caution)" : "bg-(--dot-positive)"}`}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 text-[13px] text-(--text-body)">{n.text}</span>
              {n.rep && <span className="shrink-0 text-xs font-medium text-(--text-caption)">{n.rep}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
