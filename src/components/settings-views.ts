/**
 * Pure presentation compositions for the Settings page (merged-build Phase 2).
 * Mirrors today-views / availability-views: no DOM, no server imports — every
 * piece of logic is unit-testable without rendering. The route owns state and
 * server fns; this file owns the 8-section IA constant (settings-redesign-spec
 * §IA + §MICROCOPY) and the honest Security & Status status views.
 *
 * Data honesty rules apply here too: connection states are rendered from the
 * payload as-is (demo stays demo, errors stay visible), never prettified.
 */
import { lastSyncLabel } from "./availability-views";

// ---------- 8-section IA (spec §IA; sticky sub-nav anchors) ----------

export interface SettingsSectionMeta {
  /** Anchor id used by the sticky sub-nav ("#goals"). */
  id: string;
  /** Short sub-nav label (spec: Security · Goals · Rules · Acuity · Sheets · Sync · Overrides · Audit). */
  nav: string;
  /** Section title (spec §MICROCOPY). */
  title: string;
  /** One-line description under the title. */
  description: string;
  /** Subsection headings rendered inside the section (spec §MICROCOPY). */
  subsections: string[];
}

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  {
    id: "security",
    nav: "Security",
    title: "Security & Status",
    description: "Passphrase gate, provider connections and last syncs — can the numbers on every page be trusted right now?",
    subsections: [],
  },
  {
    id: "goals",
    nav: "Goals",
    title: "Goals",
    description: "Weekly booking goal and lead budget, per-rep goals, and rep start dates.",
    subsections: ["Weekly Booking Goal & Lead Budget", "Rep Goals", "Rep Start Dates"],
  },
  {
    id: "rules",
    nav: "Rules",
    title: "Operational Rules",
    description: "What counts as a meaningful call, how bookings attribute to calls, and the fixed reporting time zone.",
    subsections: [],
  },
  {
    id: "acuity",
    nav: "Acuity",
    title: "Acuity Scope & Availability Rules",
    description: "Which Acuity bookings count toward reporting, plus the slot-engine inputs behind Today's availability.",
    subsections: ["Acuity Reporting Scope", "Studio Hours & Slot Rules", "Recurring Blocks", "One-off Blocks"],
  },
  {
    id: "sheets",
    nav: "Sheets",
    title: "Google Sheets Mapping",
    description: "Where the Family + Animalia lead counts come from and how each column is read.",
    subsections: [],
  },
  {
    id: "sync",
    nav: "Sync",
    title: "Sync Center",
    description: "Provider status, recent sync runs, and the manual SYNC NOW trigger.",
    subsections: [],
  },
  {
    id: "overrides",
    nav: "Overrides",
    title: "Manual Overrides",
    description: "Corrections made by hand — roster mapping, unattributed bookings, lead corrections. Every one is audited.",
    subsections: ["Roster Mapping", "Unattributed Bookings", "Corrections"],
  },
  {
    id: "audit",
    nav: "Audit",
    title: "Audit History",
    description: "Every settings change and manual override — what changed, previous value, new value, who, when.",
    subsections: [],
  },
];

/** Section meta by id — throws on a typo so a broken anchor can never ship silently. */
export function sectionMeta(id: string): SettingsSectionMeta {
  const found = SETTINGS_SECTIONS.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown settings section: ${id}`);
  return found;
}

/** 1-based, zero-padded position ("01"–"08") used as the section kicker. */
export function sectionNumber(id: string): string {
  return String(SETTINGS_SECTIONS.findIndex((s) => s.id === id) + 1).padStart(2, "0");
}

// ---------- Security & Status (spec §1 — honest states only) ----------

/** Verbatim passphrase warning — preserved word-for-word from the pre-redesign page. */
export const PASSPHRASE_WARNING_LEAD = "Passphrase protection is not configured.";
export const PASSPHRASE_WARNING_REST =
  "Set the DASHBOARD_PASSPHRASE secret to require a passphrase — the gate is enforced server-side on every page and endpoint.";

export function passphraseStatus(configured: boolean): {
  tone: "positive" | "risk";
  label: string;
  /** Full verbatim warning copy — null when configured (compact positive chip instead). */
  detail: string | null;
} {
  return configured
    ? { tone: "positive", label: "Passphrase protected", detail: null }
    : {
        tone: "risk",
        label: "Not configured",
        detail: `${PASSPHRASE_WARNING_LEAD} ${PASSPHRASE_WARNING_REST}`,
      };
}

/** Provider display labels — same vocabulary as the shared stale-warning helper. */
const PROVIDER_LABELS: Record<string, string> = {
  highlevel: "HighLevel",
  acuity: "Acuity",
  google_sheets: "Google Sheets",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

export interface ConnectionStatusView {
  provider: string;
  /** Honest state label: "Connected" / "Demo data" / "Error" / "Disconnected" (spec vocabulary). */
  label: string;
  tone: "positive" | "risk" | "neutral";
  /** "Last synced Xm ago" for the LAST SUCCESSFUL sync — null when there is none (never implies freshness). */
  lastSync: string | null;
  /** Last sync error, shown as-is when present. */
  error: string | null;
}

/**
 * One connection row of the Security strip. Demo mode stays visible as its own
 * honest state (spec: consistent vocabulary — Connected, Disconnected, Demo,
 * Running, Error — restrained color). Freshness deliberately reads the last
 * SUCCESSFUL sync: a failed attempt must never read as "Last synced Xm ago".
 */
export function connectionStatusView(
  c: {
    provider: string;
    status: string;
    is_demo: boolean;
    last_sync_at: string | null;
    last_successful_sync_at: string | null;
    last_error: string | null;
  },
  nowMs: number | null,
): ConnectionStatusView {
  const label = c.is_demo ? "Demo data" : c.status === "connected" ? "Connected" : c.status === "error" ? "Error" : "Disconnected";
  const tone: ConnectionStatusView["tone"] = c.is_demo
    ? "risk"
    : c.status === "connected"
      ? "positive"
      : c.status === "error"
        ? "risk"
        : "neutral";
  return {
    provider: c.provider,
    label,
    tone,
    lastSync: lastSyncLabel(c.last_successful_sync_at, nowMs),
    error: c.last_error,
  };
}

// ---------- Unattributed queue (spec §7) ----------

/**
 * Only MANUAL assignments can be unassigned back to the engine — the shipped
 * unassignAttribution fn deletes the derived attribution row; engine-computed
 * rows re-resolve on the next tick, so an Unassign action would be a no-op
 * dressed up as a fix. Rendered as a secondary action on manually-assigned rows.
 */
export function unassignable(reason: string | null): boolean {
  return reason === "manually-assigned";
}

// ---------- manual-assignment queue row states (owner directive 2026-09-27, S5b) ----------
/**
 * THE queue's rows are two DIFFERENT data states, never one bucket: ambiguous
 * verdicts (identity conflicts — e.g. "email resolves a different contact
 * than the stored contact id") stay Ambiguous until Christopher assigns them;
 * genuinely unattributed bookings (no qualifying call etc.) are the rest.
 * Mutually exclusive by construction — the engine's per-row reason decides.
 */
export type QueueRowState = "ambiguous" | "unattributed";

export function queueRowState(reason: string | null): QueueRowState {
  return reason === "ambiguous" ? "ambiguous" : "unattributed";
}

export const QUEUE_STATE_LABELS: Record<QueueRowState, string> = {
  ambiguous: "Ambiguous",
  unattributed: "Unattributed",
};
