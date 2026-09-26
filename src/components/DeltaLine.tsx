/**
 * Delta line (today-redesign-spec §3.6): the vs-team sub under a table
 * number. No color — the sign carries direction. Hidden entirely (never
 * "0.0") when the rep or team value is null, or the team mean is 0 for a
 * %-unit delta.
 */
import { deltaValue, formatDelta, type DeltaUnit } from "./today-views";

export function DeltaLine({
  rep,
  team,
  unit,
}: {
  rep: number | null;
  team: number | null;
  unit: DeltaUnit;
}) {
  const text = formatDelta(deltaValue(rep, team, unit), unit);
  if (text == null) return null;
  return <span className="delta-line mt-0.5 block text-right">{text}</span>;
}
