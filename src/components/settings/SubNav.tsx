import { SETTINGS_SECTIONS } from "~/components/settings-views";

/** Sub-nav — wrapped pill row from md up, sticky like Today's sticky table
 * header (offsets pair with the shell header: md:top-14; negative margins
 * match main's responsive padding so the bar spans edge-to-edge). On phones
 * it is a static vertical divided list (owner directive 10/11 — same
 * treatment as the Reps selector). */
export function SubNav() {
  return (
    <nav aria-label="Settings sections" className="sticky max-md:static top-[68px] z-[1] -mx-4 border-b border-(--card-border) bg-(--sticky-header-bg) px-4 backdrop-blur-sm sm:-mx-6 sm:px-6 md:top-14">
      <div className="flex items-center py-2 max-md:flex-col max-md:items-stretch max-md:divide-y max-md:divide-(--table-border-weak) md:gap-1 md:flex-wrap">
        {SETTINGS_SECTIONS.map((s, i) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="whitespace-nowrap rounded-md px-2.5 py-2 text-[13px] font-medium text-(--text-caption) transition-colors hover:bg-(--surface-subtle) hover:text-(--text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) max-md:inline-flex max-md:w-full max-md:min-h-[44px] max-md:items-center max-md:rounded-none max-md:px-3"
          >
            <span className="mr-1.5 text-xs tabular-nums text-(--text-faint)">{String(i + 1).padStart(2, "0")}</span>
            {s.nav}
          </a>
        ))}
      </div>
    </nav>
  );
}
