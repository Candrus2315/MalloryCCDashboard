/**
 * InfoTip — THE shared info-icon/tooltip primitive (microcopy pass 2026-09-28).
 * One small "i" button that reveals secondary/helper copy on hover, focus, or
 * tap — never a permanent paragraph. Used everywhere explanatory text moved
 * one layer deeper; no per-page hand-rolls.
 *
 * Touch-safe: it is a real <button> (tap toggles open, tap-outside/Esc closes),
 * so it works on phones exactly like the shipped drawer/queue controls.
 * Desktop: hover or keyboard-focus opens it; Esc closes. `align="right"`
 * flips the popover for icons sitting at a container's right edge.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export function InfoTip({
  tip,
  label = "More information",
  align = "left",
  side = "below",
  className = "",
}: {
  tip: ReactNode;
  label?: string;
  align?: "left" | "right";
  /** "below" for icons beside section headings (default); "above" for page footers. */
  side?: "below" | "above";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();

  // close on outside pointer-down and Escape (tap + keyboard parity)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={ref} className={"relative inline-flex " + className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={
          "inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full border text-xs font-semibold leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) " +
          (open
            ? "border-(--accent-solid) bg-(--accent-solid) text-(--accent-solid-fg)"
            : "border-(--table-border-strong) text-(--text-muted) hover:border-(--text-muted) hover:text-(--text-primary)")
        }
      >
        <span aria-hidden="true">i</span>
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={
            "absolute z-30 block w-64 rounded-lg border border-(--card-border) bg-(--card-bg) px-3 py-2 text-xs font-normal normal-case leading-relaxed text-(--text-body) shadow-md " +
            (side === "above" ? "bottom-full mb-1.5" : "top-full mt-1.5") +
            " " +
            (align === "right" ? "right-0" : "left-0")
          }
        >
          {tip}
        </span>
      )}
    </span>
  );
}
