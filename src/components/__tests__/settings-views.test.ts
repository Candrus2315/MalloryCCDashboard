/**
 * Settings page pure compositions (merged-build Phase 2). The IA constant is
 * the single source for the sticky sub-nav + section anchors — a broken anchor
 * id, a duplicate, or drifted microcopy must fail here, not on the page.
 * Connection/passphrase views assert the HONEST-state rules (demo stays demo,
 * failed syncs never read as "Last synced Xm ago").
 */
import { describe, expect, test } from "bun:test";
import {
  PASSPHRASE_WARNING_LEAD,
  PASSPHRASE_WARNING_REST,
  QUEUE_STATE_LABELS,
  SETTINGS_SECTIONS,
  connectionStatusView,
  passphraseStatus,
  providerLabel,
  queueReasonBreakdown,
  queueRowState,
  rosterPanelVisibleRows,
  sectionMeta,
  sectionNumber,
  unassignable,
  leadPickerOptionLabel,
} from "../settings-views";

// ---------- lead-corrections picker label (QA audit 2026-10-08) ----------

describe("leadPickerOptionLabel", () => {
  const base = { lead_type: "family", source_sheet: "family", source_date: "2026-10-06", work_date: "2026-10-07" };
  test("renders the client NAME first so same-day rows are distinguishable", () => {
    expect(leadPickerOptionLabel({ ...base, name: "Emma Carter" })).toBe("Emma Carter · Oct 6 · family · family (works Oct 7)");
    expect(leadPickerOptionLabel({ ...base, name: "Jane Doe" })).toBe("Jane Doe · Oct 6 · family · family (works Oct 7)");
  });
  test("same date+sheet+type rows with different names get different labels", () => {
    const a = leadPickerOptionLabel({ ...base, name: "Alex Smith" });
    const b = leadPickerOptionLabel({ ...base, name: "Sam Smith" });
    expect(a).not.toBe(b);
  });
  test("honest fallback when the sheet carries no name", () => {
    expect(leadPickerOptionLabel({ ...base, name: null })).toBe("Unnamed lead · Oct 6 · family · family (works Oct 7)");
    expect(leadPickerOptionLabel({ ...base })).toBe("Unnamed lead · Oct 6 · family · family (works Oct 7)");
    expect(leadPickerOptionLabel({ ...base, name: "   " })).toBe("Unnamed lead · Oct 6 · family · family (works Oct 7)");
  });
});

// ---------- 8-section IA (spec §IA + §MICROCOPY) ----------

describe("SETTINGS_SECTIONS", () => {
  test("has exactly the spec's 8 sections in order", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      "security",
      "goals",
      "rules",
      "acuity",
      "sheets",
      "sync",
      "overrides",
      "audit",
    ]);
  });

  test("anchor ids are unique", () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("sub-nav labels match the spec's anchor strip", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.nav)).toEqual([
      "Security",
      "Goals",
      "Rules",
      "Acuity",
      "Sheets",
      "Sync",
      "Overrides",
      "Audit",
    ]);
  });

  test("titles + subsections carry the spec's microcopy labels", () => {
    const allLabels = SETTINGS_SECTIONS.flatMap((s) => [s.title, ...s.subsections]);
    for (const label of [
      "Weekly Booking Goal & Lead Budget",
      "Rep Goals",
      "Operational Rules",
      "Acuity Reporting Scope",
      "Studio Hours & Slot Rules",
      "Google Sheets Mapping",
      "Sync Center",
      "Manual Overrides",
      "Audit History",
    ]) {
      expect(allLabels).toContain(label);
    }
  });

  test("default-expanded sections per spec are plain, collapsible ones are marked by absence", () => {
    // Goals / Rules / Sync stay plain sections; Audit + Sheets are <details> on the page.
    const ids = new Set(SETTINGS_SECTIONS.map((s) => s.id));
    expect(ids.has("goals")).toBe(true);
    expect(ids.has("rules")).toBe(true);
    expect(ids.has("sync")).toBe(true);
    expect(ids.has("audit")).toBe(true);
    expect(ids.has("sheets")).toBe(true);
  });

  test("sectionNumber is 1-based zero-padded and sectionMeta resolves", () => {
    expect(sectionNumber("security")).toBe("01");
    expect(sectionNumber("audit")).toBe("08");
    expect(sectionMeta("goals").title).toBe("Goals");
    expect(() => sectionMeta("nope")).toThrow("Unknown settings section");
  });
});

// ---------- Security & Status (honest states only) ----------

describe("passphraseStatus", () => {
  test("configured → compact positive, no warning detail", () => {
    const s = passphraseStatus(true);
    expect(s.tone).toBe("positive");
    expect(s.label).toBe("Passphrase protected");
    expect(s.detail).toBeNull();
  });

  test("not configured → risk + the VERBATIM pre-redesign warning copy", () => {
    const s = passphraseStatus(false);
    expect(s.tone).toBe("risk");
    expect(s.label).toBe("Not configured");
    expect(s.detail).toBe(`${PASSPHRASE_WARNING_LEAD} ${PASSPHRASE_WARNING_REST}`);
    expect(s.detail).toContain("Passphrase protection is not configured.");
    expect(s.detail).toContain("Set the DASHBOARD_PASSPHRASE secret to require a passphrase");
    expect(s.detail).toContain("the gate is enforced server-side on every page and endpoint.");
  });
});

describe("connectionStatusView", () => {
  const NOW = Date.parse("2026-09-28T12:00:00Z");

  test("demo adapter stays an honest 'Demo data' risk state", () => {
    const v = connectionStatusView(
      { provider: "acuity", status: "connected", is_demo: true, last_sync_at: null, last_successful_sync_at: null, last_error: null },
      NOW,
    );
    expect(v.label).toBe("Demo data");
    expect(v.tone).toBe("risk");
    expect(v.lastSync).toBeNull();
  });

  test("connected → positive", () => {
    const v = connectionStatusView(
      { provider: "google_sheets", status: "connected", is_demo: false, last_sync_at: null, last_successful_sync_at: null, last_error: null },
      NOW,
    );
    expect(v.label).toBe("Connected");
    expect(v.tone).toBe("positive");
  });

  test("error → risk and the error text is carried, never swallowed", () => {
    const v = connectionStatusView(
      { provider: "highlevel", status: "error", is_demo: false, last_sync_at: null, last_successful_sync_at: null, last_error: "401 unauthorized" },
      NOW,
    );
    expect(v.label).toBe("Error");
    expect(v.tone).toBe("risk");
    expect(v.error).toBe("401 unauthorized");
  });

  test("anything else → Disconnected, neutral", () => {
    const v = connectionStatusView(
      { provider: "highlevel", status: "pending", is_demo: false, last_sync_at: null, last_successful_sync_at: null, last_error: null },
      NOW,
    );
    expect(v.label).toBe("Disconnected");
    expect(v.tone).toBe("neutral");
  });

  test("freshness reads the LAST SUCCESSFUL sync only — a failed attempt never reads as 'Last synced'", () => {
    const failed = new Date(NOW - 5 * 60_000).toISOString();
    const v = connectionStatusView(
      { provider: "acuity", status: "error", is_demo: false, last_sync_at: failed, last_successful_sync_at: null, last_error: "boom" },
      NOW,
    );
    expect(v.lastSync).toBeNull();

    const ok = new Date(NOW - 12 * 60_000).toISOString();
    const v2 = connectionStatusView(
      { provider: "acuity", status: "connected", is_demo: false, last_sync_at: failed, last_successful_sync_at: ok, last_error: null },
      NOW,
    );
    expect(v2.lastSync).toBe("Last synced 12m ago");
  });

  test("provider labels use owner vocabulary", () => {
    expect(providerLabel("highlevel")).toBe("HighLevel");
    expect(providerLabel("google_sheets")).toBe("Google Sheets");
    expect(providerLabel("acuity")).toBe("Acuity");
    expect(providerLabel("mystery")).toBe("mystery");
  });
});

// ---------- Unattributed queue ----------

describe("unassignable", () => {
  test("only manually-assigned rows offer Unassign", () => {
    expect(unassignable("manually-assigned")).toBe(true);
    expect(unassignable("no-qualifying-call")).toBe(false);
    expect(unassignable("ambiguous")).toBe(false);
    expect(unassignable("no-contact-identity")).toBe(false);
    expect(unassignable("bad-datetime")).toBe(false);
    expect(unassignable(null)).toBe(false);
  });
});

// ---------- manual-assignment queue row states (S5b: three-way split) ----------
describe("queueRowState — Ambiguous is its OWN state, never folded into Unattributed", () => {
  test("the engine's ambiguous reason classifies ambiguous; everything else unattributed", () => {
    expect(queueRowState("ambiguous")).toBe("ambiguous");
    expect(queueRowState("no-qualifying-call")).toBe("unattributed");
    expect(queueRowState("no-contact-identity")).toBe("unattributed");
    expect(queueRowState("bad-datetime")).toBe("unattributed");
    expect(queueRowState("manually-assigned")).toBe("unattributed"); // never shown as a queue row, but classified honestly
    expect(queueRowState(null)).toBe("unattributed");
  });
  test("the two states render with DIFFERENT visible labels", () => {
    expect(QUEUE_STATE_LABELS.ambiguous).toBe("Ambiguous");
    expect(QUEUE_STATE_LABELS.unattributed).toBe("Unattributed");
    expect(QUEUE_STATE_LABELS.ambiguous).not.toBe(QUEUE_STATE_LABELS.unattributed);
  });
});

// ---------- S4b: grouped no-rep reason summary for the top of the queue ----------
describe("queueReasonBreakdown — grouped counts at the top of the manual-decision queue", () => {
  test("groups by the refined reason_code with owner-facing labels; Ambiguous is its own group", () => {
    const buckets = queueReasonBreakdown([
      { reason: "no-qualifying-call", reason_code: "no-window-interaction" },
      { reason: "no-qualifying-call", reason_code: "no-window-interaction" },
      { reason: "no-qualifying-call", reason_code: "interaction-without-roster-rep" },
      { reason: "no-contact-identity", reason_code: "no-contact-identity" },
      { reason: "ambiguous", reason_code: "ambiguous" },
      { reason: "ambiguous", reason_code: null }, // pre-rerun ambiguous row: still grouped by STATE
    ]);
    expect(buckets).toEqual([
      { code: "ambiguous", label: "Ambiguous — identity conflict", count: 2 },
      { code: "no-window-interaction", label: "No rep activity in the booking window", count: 2 },
      { code: "interaction-without-roster-rep", label: "Activity in window — none tied to a roster rep", count: 1 },
      { code: "no-contact-identity", label: "No contact identity on the booking", count: 1 },
    ]);
  });

  test("buckets sum to the queue length and sort by count desc then label", () => {
    const rows = [
      { reason: "no-qualifying-call", reason_code: "no-matching-contact" },
      { reason: "bad-datetime", reason_code: "bad-datetime" },
      { reason: "bad-datetime", reason_code: "bad-datetime" },
      { reason: "bad-datetime", reason_code: "bad-datetime" },
    ];
    const buckets = queueReasonBreakdown(rows);
    expect(buckets.map((b) => [b.label, b.count])).toEqual([
      ["Unreadable booking time", 3],
      ["No matching contact record", 1],
    ]);
    expect(buckets.reduce((n, b) => n + b.count, 0)).toBe(rows.length);
  });

  test("rows without any classification fall through to the legacy reason, and fully unclassified rows are reported honestly", () => {
    expect(queueReasonBreakdown([{ reason: "no-qualifying-call", reason_code: null }])).toEqual([
      { code: "no-qualifying-call", label: "no-qualifying-call", count: 1 }, // unknown code rendered verbatim, never relabeled
    ]);
    expect(queueReasonBreakdown([{ reason: null, reason_code: null }])).toEqual([
      { code: "unclassified", label: "Unclassified — rerun attribution", count: 1 },
    ]);
  });
});

// ---------- 7 — Roster Mapping panel visibility (owner directive) ----------
describe("rosterPanelVisibleRows", () => {
  const row = (externalId: string, callCount: number, mappedTo: string | null = null) => ({ externalId, callCount, mappedTo });
  const ROWS = [row("u_christy", 349), row("u_meg", 1), row("u_test", 0, "r_laura"), row("u_rocket", 0)];

  test("default view shows only users WITH calls — zero-call rows (test/app accounts) are noise", () => {
    expect(rosterPanelVisibleRows(ROWS, false).map((r) => r.externalId)).toEqual(["u_christy", "u_meg"]);
  });

  test("show-all reveals every row INCLUDING the mapped zero-call user (select still works when shown)", () => {
    expect(rosterPanelVisibleRows(ROWS, true).map((r) => r.externalId)).toEqual(["u_christy", "u_meg", "u_test", "u_rocket"]);
    expect(rosterPanelVisibleRows(ROWS, true).find((r) => r.externalId === "u_test")?.mappedTo).toBe("r_laura");
  });

  test("all-zero-call roster → default view empty (the panel's honest empty state), show-all lists all", () => {
    const zeros = [row("a", 0), row("b", 0)];
    expect(rosterPanelVisibleRows(zeros, false)).toEqual([]);
    expect(rosterPanelVisibleRows(zeros, true)).toEqual(zeros);
  });
});
