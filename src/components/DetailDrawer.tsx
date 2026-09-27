/**
 * DetailDrawer — the reusable drill-down panel (merged-build Phase 3, §12).
 *
 * Fixed right-hand panel with backdrop. Presentation only: WHAT the drawer
 * shows per metric is composed by the page (team.tsx) from drawer-views.ts —
 * this shell owns focus, Escape, backdrop-close and body-scroll-lock only.
 * Focus moves into the panel on open and is restored to the previously
 * focused element on close, so chart points opened via keyboard keep their
 * place (§14).
 */
import { useEffect, useRef, type ReactNode } from "react";

export function DetailDrawer(props: {
  open: boolean;
  onClose(): void;
  /** e.g. "Calls — Sep 24" */
  title: string;
  /** Context preservation lines, e.g. ["Historical · Week of Sep 21", "Roster calls · threshold 120s", "38 records"]. */
  contextLines: string[];
  loading?: boolean;
  /** Honest empty/unavailable message rendered when there is nothing to list. */
  emptyMessage?: string;
  children?: ReactNode;
}) {
  const { open, onClose, title, contextLines, loading, emptyMessage, children } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      {/* backdrop click closes — the panel itself does not */}
      <div className="absolute inset-0 bg-stone-900/30" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-stone-200 shadow-xl outline-none"
        style={{ backgroundColor: "var(--card-bg)" }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-stone-100 px-5 py-4">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold tracking-tight text-stone-900">{title}</p>
            {contextLines.length > 0 && (
              <p className="mt-1 text-[11px] leading-snug text-stone-500">
                {contextLines.map((line, i) => (
                  <span key={i} className="block">
                    {line}
                  </span>
                ))}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail panel"
            className="shrink-0 rounded-lg p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          >
            <span aria-hidden="true" className="block text-sm leading-none">
              ✕
            </span>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && <p className="text-xs text-stone-400">Loading…</p>}
          {!loading && emptyMessage && (
            <p className="text-[13px] leading-relaxed text-stone-500">{emptyMessage}</p>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
