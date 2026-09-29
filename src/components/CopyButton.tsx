/**
 * CopyButton — THE shared copy-to-clipboard button (Daily Report pattern,
 * now shared with the Weekly CC Report). Click copies `text`; the label flips
 * to a confirmation for 2.5s. Falls back to select-and-copy when the async
 * clipboard API is unavailable (permissions/plain HTTP).
 */
import { useState } from "react";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API unavailable (permissions/HTTP): select-and-copy fallback
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copyText(text);
        setState(ok ? "copied" : "failed");
        setTimeout(() => setState("idle"), 2500);
      }}
      className={
        "rounded-lg px-4 py-2 text-[13px] font-medium transition-colors " +
        (state === "copied"
          ? "bg-(--btn-success) text-white"
          : "bg-(--accent-solid) text-(--accent-solid-fg) hover:bg-(--accent-hover)")
      }
    >
      {state === "copied" ? "Copied ✓" : state === "failed" ? "Copy failed — select the text below" : label}
    </button>
  );
}
