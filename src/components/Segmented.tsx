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
      className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-stone-200 bg-white p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={
            "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 " +
            (o.value === value ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
