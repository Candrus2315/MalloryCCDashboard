import { sectionMeta, sectionNumber } from "~/components/settings-views";

/** Numbered panel header — IA number + eyebrow title + one-line description,
 * from the IA constant. Lives INSIDE its section's Panel (wave-3 anatomy). */
export function SectionHeader({ id }: { id: string }) {
  const meta = sectionMeta(id);
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs font-medium tabular-nums text-(--text-faint)" aria-hidden="true">
        {sectionNumber(id)}
      </span>
      <div>
        <h2 className="kpi-label">{meta.title}</h2>
        <p className="mt-0.5 text-[13px] text-(--text-caption)">{meta.description}</p>
      </div>
    </div>
  );
}
