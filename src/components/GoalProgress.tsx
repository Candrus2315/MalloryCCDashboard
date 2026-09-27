import { goalCell } from "~/components/team-views";

/**
 * §7/§8 goal-progress visualization — SUPPLEMENTS the exact numbers, never
 * replaces them: "8 / 15.8" + a 4px bar + "50.6%" (1dp). The bar fills
 * stone-900 and turns emerald at ≥100%; over-achievement caps the fill (the
 * pct keeps the real math). goal == null → "—" and no bar (never an invented
 * goal — E-strip's RepStripRow.goal feeds this; null means no range goal).
 * size "sm" is the By-Rep table cell; "md" is a card block.
 */
export function GoalProgress(props: {
  actual: number;
  goal: number | null;
  size?: "sm" | "md";
}) {
  const cell = goalCell(props.actual, props.goal);
  const big = props.size === "md";
  if (cell.goal == null) {
    return <span className={"text-stone-300 " + (big ? "text-2xl" : "text-[13px]")}>—</span>;
  }
  return (
    <span className={big ? "block" : "inline-block w-full max-w-[150px]"}>
      <span className="flex items-baseline justify-between gap-2">
        <span
          className={
            "tabular-nums font-semibold tracking-tight text-stone-900 " + (big ? "text-2xl" : "text-[13px]")
          }
        >
          {cell.actual}{" "}
          <span className={"font-normal text-stone-400 " + (big ? "text-lg" : "text-xs")}>/ {cell.goal}</span>
        </span>
        {cell.pct != null && (
          <span className={"tabular-nums text-stone-500 " + (big ? "text-sm" : "text-[11px]")}>{cell.pct}</span>
        )}
      </span>
      {cell.barPct != null && (
        <span
          className={
            "block w-full overflow-hidden rounded-full bg-stone-200 " + (big ? "mt-2 h-1.5" : "mt-1 h-1")
          }
          aria-hidden="true"
        >
          <span
            className={"block h-full rounded-full " + (cell.hit ? "bg-emerald-600" : "bg-stone-900")}
            style={{ width: `${cell.barPct}%` }}
          />
        </span>
      )}
    </span>
  );
}
