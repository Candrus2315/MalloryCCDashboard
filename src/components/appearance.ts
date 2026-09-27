/**
 * Appearance preference (P5 dark theme, Part 2 of the execution spec):
 * System / Light / Dark. Client-only theming — no loader, no param, no
 * server state. localStorage key `mallory-appearance` holds the raw string
 * "system" | "light" | "dark"; unknown/null → "system"; every storage access
 * is wrapped in try/catch (private-mode safe). setPref writes the key and
 * immediately toggles the <html> class — no reload. While pref === "system"
 * the hook live-tracks the OS's prefers-color-scheme (owner requirement);
 * the subscription is removed on manual modes.
 *
 * The no-flash half lives in __root.tsx as an inline pre-paint script using
   the same key and the same resolution rule (kept in sync by this comment).
 */
import { useCallback, useEffect, useState } from "react";

export type AppearancePref = "system" | "light" | "dark";

export const APPEARANCE_STORAGE_KEY = "mallory-appearance";

const PREFS: AppearancePref[] = ["system", "light", "dark"];

/** Pure resolution rule — also mirrored by the __root.tsx pre-paint script. */
export function resolveTheme(pref: AppearancePref, systemPrefersDark: boolean): "light" | "dark" {
  if (pref === "dark") return "dark";
  if (pref === "light") return "light";
  return systemPrefersDark ? "dark" : "light";
}

function readStoredPref(): AppearancePref {
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return PREFS.includes(raw as AppearancePref) ? (raw as AppearancePref) : "system";
  } catch {
    return "system";
  }
}

/**
 * Applies the resolved theme to a DOM element's class list. The force flag
 * MUST be a boolean: classList.toggle(name, force) coerces its second arg —
 * a truthy STRING ("light"!) would add the dark class (the Light-switch bug).
 * Exported + test-pinned for exactly that reason.
 */
export function applyThemeClass(
  el: { classList: { toggle(name: string, force?: boolean): void } },
  theme: "light" | "dark",
) {
  el.classList.toggle("dark", theme === "dark");
}

function applyTheme(pref: AppearancePref) {
  applyThemeClass(document.documentElement, resolveTheme(pref, window.matchMedia("(prefers-color-scheme: dark)").matches));
}

export function useAppearance(): { pref: AppearancePref; setPref: (p: AppearancePref) => void } {
  const [pref, setPrefState] = useState<AppearancePref>(() => readStoredPref());

  const setPref = useCallback((next: AppearancePref) => {
    setPrefState(next);
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, next);
    } catch {
      // storage unavailable — keep in-memory pref for this session
    }
    applyTheme(next);
  }, []);

  useEffect(() => {
    applyTheme(pref);
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  return { pref, setPref };
}
