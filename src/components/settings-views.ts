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
import { formatDateShort } from "~/server/date-logic";

/**
 * QA audit 2026-10-08 (designer report §5): the lead-corrections picker's
 * option label. The sheet row's own NAME comes first so rows that share a
 * date + sheet + type are distinguishable at a glance (the select's value
 * always carried the distinct lead id — this is display-only); honest
 * "Unnamed lead" fallback when the sheet carries no name; dates in the app's
 * human convention ("Oct 6") via the compact picker format.
 */
export function leadPickerOptionLabel(l: { name?: string | null; source_date: string; lead_type: string; source_sheet: string; work_date: string }): string {
  const who = l.name && l.name.trim() ? l.name.trim() : "Unnamed lead";
  return `${who} · ${formatDateShort(l.source_date)} · ${l.lead_type} · ${l.source_sheet} (works ${formatDateShort(l.work_date)})`;
}

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
  acuity_availability: "Acuity Availability",
  google_sheets: "Google Sheets",
  attribution: "Attribution",
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

// ---------- S4b no-rep reason categories (grouped queue counts) ----------
/**
 * The refined no-rep categories the attribution engine derives from its own
 * signals (src/server/metrics/attribution.ts) and the sync persists to
 * booking_attributions.reason_code. Labels are the owner-facing vocabulary;
 * the codes are stable data. Ambiguous keeps its existing identity-conflict
 * presentation (its reason stays "ambiguous"; the engine adds no category).
 */
export const NO_REP_REASON_LABELS: Record<string, string> = {
  "no-window-interaction": "No rep activity in the booking window",
  "interaction-without-roster-rep": "Activity in window — none tied to a roster rep",
  "no-matching-contact": "No matching contact record",
  "no-contact-identity": "No contact identity on the booking",
  "bad-datetime": "Unreadable booking time",
  ambiguous: "Ambiguous — identity conflict",
};

export interface QueueReasonBucket {
  /** Stable category code (reason_code / engine reason). */
  code: string;
  label: string;
  count: number;
}

/**
 * Grouped count summary for the top of the manual-decision queue: one bucket
 * per no-rep category (by reason_code, falling back to the engine reason when
 * a row predates the S4b classification) plus a single Ambiguous bucket —
 * ambiguous rows keep their own identity-conflict presentation and are never
 * folded into a no-rep category. Sorted by count desc, then label. Rows for
 * bookings without any engine verdict (reason_code and reason both null) are
 * reported honestly as "Unclassified — rerun attribution".
 */
export function queueReasonBreakdown(rows: { reason: string | null; reason_code?: string | null }[]): QueueReasonBucket[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (queueRowState(r.reason) === "ambiguous") {
      counts.set("ambiguous", (counts.get("ambiguous") ?? 0) + 1);
      continue;
    }
    const code = r.reason_code ?? r.reason ?? "unclassified";
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({
      code,
      label: NO_REP_REASON_LABELS[code] ?? (code === "unclassified" ? "Unclassified — rerun attribution" : code),
      count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// ---------- 7 — Roster Mapping panel visibility (owner directive) ----------
/**
 * Roster Mapping panel rows for the CURRENT view state. Owner directive
 * ("erase everyone not on my roster"): by default the panel lists only
 * non-roster HighLevel users WITH calls in the last 30-day window — zero-call
 * rows (test/app/marketing accounts) stay behind a show-all toggle. This is a
 * CLIENT-DEFAULT filter only: the server payload always sends every inactive
 * user, and a zero-call user stays mappable once revealed (select untouched).
 * Client-local state, never persisted.
 */
export function rosterPanelVisibleRows<T extends { callCount: number }>(rows: T[], showAll: boolean): T[] {
  return showAll ? rows : rows.filter((u) => u.callCount > 0);
}
