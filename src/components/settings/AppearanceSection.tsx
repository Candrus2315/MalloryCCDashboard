import { useAppearance } from "~/components/appearance";
import { Segmented } from "~/components/Segmented";
import { Eyebrow, Panel } from "~/components/page-panel";

/**
 * Appearance (P5): System / Light / Dark via the existing Segmented control.
 * Prefers-color-scheme live-tracking happens inside useAppearance while
 * pref === "system"; manual modes unsubscribe. Writes localStorage
 * mallory-appearance and toggles the <html> class immediately — no reload.
 */
export function AppearanceSection() {
  const { pref, setPref } = useAppearance();
  return (
    <div id="appearance" className="scroll-mt-28">
      <Panel className="p-4 sm:p-5">
        <Eyebrow>Appearance</Eyebrow>
        <div className="mt-3">
          <Segmented
            ariaLabel="Appearance"
            value={pref}
            onChange={setPref}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </div>
        <p className="mt-1.5 text-xs text-(--text-muted)">System / Uses your device appearance automatically.</p>
      </Panel>
    </div>
  );
}
