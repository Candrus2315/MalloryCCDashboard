/**
 * Compact segmented control (reps-redesign-spec: "redesigned as a compact
 * segmented filter control, not oversized buttons"). Generic presentational
 * component — the Reps page uses it for the date range; no styles of its own
 * beyond the shared design tokens (white pill strip, stone-900 active seg).
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-(--card-border) bg-(--card-bg) p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={
            "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) " +
            (o.value === value
              ? "bg-(--accent-solid) text-(--accent-solid-fg)"
              : "text-(--chip-neutral-fg) hover:bg-(--surface-subtle)")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Compact "Week of …" dropdown for the week-of range mode (owner directive
 * 9/26): lists recent Mondays (current operating week first) and navigates to
 * ?range=week-of&from=<monday>. Rendered next to the Segmented control when
 * the week-of segment is active. Options come from the centralized
 * recentMondays() helper — no page invents its own week list.
 */
export function WeekOfSelect({
  mondays,
  value,
  onChange,
}: {
  /** Monday week-starts, most recent first (recentMondays()). */
  mondays: string[];
  /** Currently selected Monday (weekStart of the resolved range). */
  value: string;
  onChange: (monday: string) => void;
}) {
  const label = (m: string) => {
    const [y, mo, d] = m.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
      new Date(Date.UTC(y, mo - 1, d)),
    );
  };
  const known = mondays.includes(value);
  return (
    <select
      aria-label="Select week"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={
        "rounded-lg border border-(--card-border) bg-(--card-bg) px-2.5 py-1.5 text-[13px] font-medium text-(--text-primary) outline-none focus:border-(--input-focus-border) " +
        (known ? "" : "text-(--text-muted)")
      }
    >
      {!known && <option value={value}>Week of {label(value)}</option>}
      {mondays.map((m) => (
        <option key={m} value={m}>
          Week of {label(m)}
        </option>
      ))}
    </select>
  );
}
