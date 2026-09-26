/**
 * Shared missing-data / stale-data warning list — the ONE pattern every page
 * uses for "this number can't be trusted right now" messages (SPEC: never
 * display incomplete metrics as though they are current).
 */
export function WarningList({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
      <ul className="space-y-1 text-xs text-amber-800">
        {items.map((w) => (
          <li key={w}>⚠ {w}</li>
        ))}
      </ul>
    </div>
  );
}
