/**
 * Status chip (today-redesign-spec §3.6): compact text + dot, never
 * color-only. Vocabulary: Goal hit · Strong converter · Needs coaching ·
 * Below pace · On pace.
 */
import type { ChipKind } from "./today-views";

const STYLES: Record<ChipKind, { chip: string; dot: string }> = {
  positive: { chip: "chip-positive", dot: "bg-emerald-600" },
  risk: { chip: "chip-risk", dot: "bg-amber-500" },
  neutral: { chip: "chip-neutral", dot: "bg-stone-400" },
};

export function StatusChip({ kind, label }: { kind: ChipKind; label: string }) {
  const s = STYLES[kind];
  return (
    <span className={`chip ${s.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}
