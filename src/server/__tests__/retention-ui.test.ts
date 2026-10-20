/**
 * RETENTION UI DATA tests (stage 3b) — the read-only aggregation between the
 * ret_* tables and the Retention tab / drill-down, MemoryStore end-to-end:
 * the 12-card overview (owner order + §16 formulas + honest "—" for the
 * unwritten cancellations ledger), drill row universes per kpi, range
 * presets (incl. no-shows by APPOINTMENT date), classification/employee
 * filters, the match-exceptions mode through the shipped queue API, the
 * needs-review signal grid conflicts, CSV export, and the retention owner
 * history read (effective-dated).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { computeRetention } from "../retention/compute";
import {
  retentionOverview,
  retentionDrillData,
  deriveSignalCells,
  retentionDrillCsv,
  currentRetentionOwner,
  CANCELLATIONS_ENGINE_NOTE,
  type RetentionDrillParams,
} from "../retention/ui-data";

// Fixed clock: 2026-10-20 ET (Tue) → current Mon–Sun week = 10/19..10/25.
const NOW = () => new Date("2026-10-20T15:00:00Z");
const APPT_1026 = "2026-10-26T14:00:00Z"; // due 10/19 — current week
const APPT_1024 = "2026-10-24T14:00:00Z"; // due 10/17 — last week
const APPT_1027 = "2026-10-27T18:00:00Z"; // due 10/20 — current week
const APPT_1013 = "2026-10-13T14:00:00Z"; // due 10/06 — passed session (no-show by appointment date 10/13… not in current week)

interface Seed {
  store: MemoryStore;
  lauraId: string;
  apptIds: Record<string, string>;
  clientIds: Record<string, string>;
}

async function seed(): Promise<Seed> {
  const store = new MemoryStore();
  await store.upsertUsers([
    { id: "", provider: "highlevel", external_id: "LAU", name: "Laura Rivera", email: "laura@mallory.test", is_active: false, call_start_date: null },
  ] as never);
  const users = await store.getAllUsers();
  const lauraId = users.find((u) => u.external_id === "LAU")!.id;

  await store.upsertContacts([
    { id: "", provider: "highlevel", external_id: "CT1", name: "Jane Doe", phone: "(603) 555-1212", email: "jane@example.com", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT2", name: "Bob Roe", phone: "2125550101", email: "bob@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT3", name: "Cara Lee", phone: "9175550143", email: "cara@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT4", name: "Dan Fox", phone: "9175550188", email: "dan@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
  ] as never);
  const contacts = await store.getContacts();
  const contactIds: Record<string, string> = {};
  for (const c of contacts) contactIds[c.external_id!] = c.id;

  const appt = (acuityId: string, contactId: string | null, datetime: string, notes: string | null, status = "scheduled") => ({
    id: "",
    acuity_appointment_id: acuityId,
    contact_id: contactId,
    calendar_id: "1335091",
    calendar_name: "MALLORY PORTRAITS",
    appointment_type: "Portrait Session",
    appointment_datetime: datetime,
    created_at: "2026-10-16T18:00:00Z",
    status,
    cancelled: false,
    raw: notes == null ? null : { notes },
  });
  await store.upsertAppointments([
    appt("A1", contactIds.CT1!, APPT_1026, "LVM LR 10/19/26\nPaid with invoice 2324"),
    appt("A2", contactIds.CT2!, APPT_1024, "SWC LR 10/19/26 intake done"),
    appt("A3", contactIds.CT3!, APPT_1027, "no notes yet"),
    appt("A4", contactIds.CT4!, APPT_1013, "past session, still marked scheduled (D10 no-show proxy)"),
  ] as never);
  const appts = await store.getAppointmentsWithClientsSince("2026-09-01T00:00:00Z");
  const apptIds: Record<string, string> = {};
  for (const a of appts) apptIds[a.acuity_appointment_id!] = a.id;

  const clients: Record<string, string> = {};
  const seeds: [string, string, string, string, string][] = [
    ["CT1", "Jane Doe", "6035551212", "jane@example.com", "CT1"],
    ["CT2", "Bob Roe", "2125550101", "bob@other.org", "CT2"],
    ["CT3", "Cara Lee", "9175550143", "cara@other.org", "CT3"],
    ["CT4", "Dan Fox", "9175550188", "dan@other.org", "CT4"],
  ];
  for (const [key, name, phone, email, ext] of seeds) {
    const c = await store.insertInternalClient({ seedKey: `hl-contact:${ext}`, displayName: name, normalizedPhone: phone, normalizedEmail: email, ghlContactExternalId: ext });
    clients[key] = c.id;
    await store.insertClientMatchLinkIfAbsent({ internalClientId: c.id, provider: "highlevel", entity: "contact", externalId: ext, matchMethod: "exact_id", confidence: "exact" });
  }
  for (const [ext, key] of [["A1", "CT1"], ["A2", "CT2"], ["A3", "CT3"], ["A4", "CT4"]] as const) {
    await store.insertClientMatchLinkIfAbsent({ internalClientId: clients[key]!, provider: "acuity", entity: "appointment", externalId: ext, matchMethod: "exact_id", confidence: "exact" });
  }

  // Calls: MSG1 voicemail→A1 (LVM consistent); MSG3 no-answer→A2; MSG5 no-answer→A3
  // (window open, zero answered → Still Unreached); MSG6 no-answer→A4 (session passed → no-show, not spoken).
  const call = (externalId: string, o: { direction: string; status: string; duration: number; contactId: string | null; repId?: string | null; at: string }) => ({
    provider: "highlevel",
    external_call_id: externalId,
    rep_id: o.repId ?? null,
    contact_id: o.contactId,
    started_at: o.at,
    duration_seconds: o.duration,
    over_two_minutes: o.duration > 120,
    direction: o.direction,
    call_status: o.status,
    provider_rep_external_id: o.repId === lauraId ? "LAU" : null,
  });
  await store.upsertCalls([
    call("MSG1", { direction: "outbound", status: "voicemail", duration: 47, contactId: contactIds.CT1!, repId: lauraId, at: "2026-10-19T15:00:00Z" }),
    call("MSG3", { direction: "outbound", status: "no-answer", duration: 0, contactId: contactIds.CT2!, repId: lauraId, at: "2026-10-18T15:00:00Z" }),
    call("MSG5", { direction: "outbound", status: "no-answer", duration: 0, contactId: contactIds.CT3!, repId: lauraId, at: "2026-10-21T14:00:00Z" }),
    call("MSG6", { direction: "outbound", status: "no-answer", duration: 0, contactId: contactIds.CT4!, repId: lauraId, at: "2026-10-08T14:00:00Z" }),
  ] as never);

  const res = await computeRetention(store, { now: NOW });
  expect(res.outcome).toBe("synced");
  return { store, lauraId, apptIds, clientIds: clients };
}

const params = (over: Partial<RetentionDrillParams> = {}): RetentionDrillParams => ({
  kpi: "clients-due",
  range: "this-week",
  classification: "all",
  outcome: "all",
  employee: "all",
  exc: "open",
  ...over,
});

describe("retentionOverview (the 12-card band, §16)", () => {
  test("cards come in the owner's exact order with verbatim labels", async () => {
    const s = await seed();
    const o = await retentionOverview(s.store, NOW);
    expect(o.cards.map((c) => c.label)).toEqual([
      "Clients Due",
      "Calls Attempted",
      "Clients Spoken With",
      "Still Unreached",
      "Contact Compliance %",
      "Active Cancellations",
      "Saves",
      "Reschedules",
      "Recovery Rate",
      "No-Shows",
      "Data Match Exceptions",
      "Needs Review",
    ]);
    expect(o.cards.map((c) => c.key)).toEqual([
      "clients-due",
      "calls-attempted",
      "spoken-with",
      "unreached",
      "compliance",
      "active-cancellations",
      "saves",
      "reschedules",
      "recovery",
      "no-shows",
      "match-exceptions",
      "needs-review",
    ]);
  });

  test("current-week due cohort math (A1 only due in 10/19–25) + all-clear attention", async () => {
    const s = await seed();
    const o = await retentionOverview(s.store, NOW);
    const byKey = Object.fromEntries(o.cards.map((c) => [c.key, c]));
    expect(byKey["clients-due"]!.value).toBe(2); // A1 (due 10/19) + A3 (due 10/20); A2 due 10/17 is last week
    expect(byKey["clients-due"]!.sub).toBe("due this week · due = appt date − 7");
    expect(byKey["calls-attempted"]!.value).toBe(2); // MSG1 → A1 + MSG5 → A3
    expect(byKey["spoken-with"]!.value).toBe(0); // voicemail/no-answer cohort — none verified
    expect(byKey["compliance"]!.ratio).toBe(0); // 0/1 — computed zero, muted in the UI
    expect(byKey["unreached"]!.value).toBe(1); // A3 no-answer, window open (appt 10/27)
    expect(byKey["unreached"]!.sub).toBe("1 window open · 0 closed");
    expect(byKey["match-exceptions"]!.value).toBe(0);
    expect(byKey["match-exceptions"]!.sub).toBe("all clear");
    expect(byKey["match-exceptions"]!.attention).toBe(false);
    expect(byKey["needs-review"]!.value).toBe(1); // A2: SWC note but no answered call (D5) — the open queue
    expect(byKey["needs-review"]!.attention).toBe(true);
    expect(byKey["needs-review"]!.sub).toBe("evidence conflicts");
    expect(o.computedAtIso).toBeTruthy();
  });

  test("cancellations family renders null (never 0) while no stage writes the ledger", async () => {
    const s = await seed();
    const o = await retentionOverview(s.store, NOW);
    const byKey = Object.fromEntries(o.cards.map((c) => [c.key, c]));
    for (const k of ["active-cancellations", "saves", "reschedules", "recovery"]) {
      expect(byKey[k]!.value).toBeNull();
    }
    expect(CANCELLATIONS_ENGINE_NOTE).toContain("never 0");
  });

  test("no-shows count by APPOINTMENT date (D10 proxy) with spoken split", async () => {
    const s = await seed();
    const o = await retentionOverview(s.store, NOW);
    const byKey = Object.fromEntries(o.cards.map((c) => [c.key, c]));
    // A4's session passed (10/13) and is still scheduled — but its appointment
    // date is NOT in the current week, so the current-week card is 0/0.
    expect(byKey["no-shows"]!.value).toBe(0);
    expect(byKey["no-shows"]!.sub).toBe("0 spoken · 0 not spoken");
  });

  test("attention accents flip on with real queue counts", async () => {
    const s = await seed();
    await s.store.insertDataMatchExceptionIfAbsent({
      kind: "ambiguous_phone",
      dedupeKey: "contact-identity:hl:CTX",
      payload: { subject: { name: "X", phone: "555" }, candidates: [] },
      context: { source: "test" },
    });
    const o = await retentionOverview(s.store, NOW);
    const byKey = Object.fromEntries(o.cards.map((c) => [c.key, c]));
    expect(byKey["match-exceptions"]!.value).toBe(1);
    expect(byKey["match-exceptions"]!.attention).toBe(true);
    expect(byKey["match-exceptions"]!.sub).toBe("match unresolved");
  });
});

describe("retentionDrillData (one shared drill, ?kpi=)", () => {
  test("clients-due this-week → the due cohort rows with evidence joins", async () => {
    const s = await seed();
    const d = await retentionDrillData(s.store, params({ kpi: "clients-due" }), NOW);
    expect(d.kpiLabel).toBe("Clients Due");
    expect(d.matchedCount).toBe(2);
    expect(d.rows).toHaveLength(2);
    const row = d.rows.find((r) => r.clientName === "Jane Doe")!;
    expect(d.rows[0]!.clientName).toBe("Cara Lee"); // newest due date first
    expect(row.dueDate).toBe("2026-10-19");
    expect(row.apptDateEt).toBe("2026-10-26");
    expect(row.apptTimeEt).toBeTruthy();
    expect(row.ghlContactId).toBe("CT1");
    expect(row.contactPhoneLast4).toBe("1212");
    expect(row.attemptsCount).toBe(1);
    expect(row.attempts[0]!.status).toBe("voicemail");
    expect(row.attempts[0]!.employeeName).toMatch(/Laura Rivera|HL user LAU/);
    expect(row.lastCallStatus).toBe("voicemail");
    expect(row.transcriptResult).toBeNull();
    expect(row.notes).toBe("LVM LR 10/19/26\nPaid with invoice 2324"); // verbatim, full
    expect(row.finalStatus).toBe("voicemail");
    expect(row.matchMethod).toBe("exact_id");
    expect(row.evidence.internal_client_id).toBe(s.clientIds.CT1);
  });

  test("spoken-with / calls-attempted / unreached universes per §16", async () => {
    const s = await seed();
    const spoken = await retentionDrillData(s.store, params({ kpi: "spoken-with" }), NOW);
    expect(spoken.rows).toHaveLength(0); // A2 (SWC? no — no answered call → needs_review... actually A2: no-answer + SWC note → needs_review)
    const attempted = await retentionDrillData(s.store, params({ kpi: "calls-attempted", range: "all" }), NOW);
    expect(attempted.matchedCount).toBe(4); // every appointment got ≥1 attempt (MSG1/3/5/6)
    const unreached = await retentionDrillData(s.store, params({ kpi: "unreached" }), NOW);
    // A3 (current week, no-answer, window open) + A2? A2 due 10/17 → last week → out of this-week range.
    expect(unreached.rows.map((r) => r.dueDate)).toEqual(["2026-10-20"]);
    const unreachedAll = await retentionDrillData(s.store, params({ kpi: "unreached", range: "all" }), NOW);
    expect(unreachedAll.rows.map((r) => r.clientName).sort()).toEqual(["Cara Lee", "Dan Fox"]); // A3 + A4 no-answer; A2 is needs_review (excluded per §16)
  });

  test("classification + employee filters are URL-param backed", async () => {
    const s = await seed();
    const d = await retentionDrillData(s.store, params({ kpi: "clients-due", range: "all", classification: "needs_review" }), NOW);
    // A2: no-answer call + SWC note (D5: notes corroborate, never replace → Needs Review)
    expect(d.rows.map((r) => r.clientName)).toEqual(["Bob Roe"]);
    const employeeId = (await retentionDrillData(s.store, params({ kpi: "clients-due", range: "all" }), NOW)).employees[0]!.id;
    const byEmployee = await retentionDrillData(s.store, params({ kpi: "clients-due", range: "all", employee: employeeId }), NOW);
    expect(byEmployee.rows).toHaveLength(4); // every attempt was Laura's
    const byOther = await retentionDrillData(s.store, params({ kpi: "clients-due", range: "all", employee: "someone-else" }), NOW);
    expect(byOther.rows).toHaveLength(0);
  });

  test("no-shows drill ranges by appointment date and splits spoken/not-spoken", async () => {
    const s = await seed();
    const d = await retentionDrillData(s.store, params({ kpi: "no-shows", range: "last-30" }), NOW);
    expect(d.rows.map((r) => r.clientName)).toEqual(["Dan Fox"]); // A4 passed + still scheduled
    expect(d.rows[0]!.finalStatus).not.toBe("verified_spoke_with");
  });

  test("cancellations-family kpis render an honest empty state", async () => {
    const s = await seed();
    for (const kpi of ["active-cancellations", "saves", "reschedules", "recovery"] as const) {
      const d = await retentionDrillData(s.store, params({ kpi }), NOW);
      expect(d.rows).toHaveLength(0);
      expect(d.emptyReason).toBe(CANCELLATIONS_ENGINE_NOTE);
    }
  });

  test("outcome filter honestly matches nothing while the ledger is unwritten", async () => {
    const s = await seed();
    const d = await retentionDrillData(s.store, params({ kpi: "clients-due", range: "all", outcome: "saved_original" }), NOW);
    expect(d.rows).toHaveLength(0);
  });

  test("match-exceptions mode rides the shipped queue API (open/resolved/dismissed)", async () => {
    const s = await seed();
    const exc = await s.store.insertDataMatchExceptionIfAbsent({
      kind: "name_only",
      dedupeKey: "contact-identity:hl:CTY",
      payload: { subject: { name: "Y" }, candidates: [s.clientIds.CT1] },
      context: { entity: "contact", external_id: "CTY" },
    });
    const open = await retentionDrillData(s.store, params({ kpi: "match-exceptions", exc: "open" }), NOW);
    expect(open.exceptions).not.toBeNull();
    expect(open.matchedCount).toBe(1);
    expect(open.exceptions!.rows[0]!.kind).toBe("name_only");
    expect(open.exceptions!.rows[0]!.candidates_expanded[0]!.id).toBe(s.clientIds.CT1);

    await s.store.dismissDataMatchException(exc.exception.id, { resolvedBy: "management-test" });
    const after = await retentionDrillData(s.store, params({ kpi: "match-exceptions", exc: "open" }), NOW);
    expect(after.matchedCount).toBe(0);
    expect(after.emptyReason).toContain("No Data Match Exceptions");
    const dismissed = await retentionDrillData(s.store, params({ kpi: "match-exceptions", exc: "dismissed" }), NOW);
    expect(dismissed.matchedCount).toBe(1);
  });

  test("CSV export mirrors the table columns with verbatim notes", async () => {
    const s = await seed();
    const d = await retentionDrillData(s.store, params({ kpi: "clients-due" }), NOW);
    const csv = retentionDrillCsv(d.rows, { kpi: d.kpi, range: d.range, ownerName: d.ownerName, dueDaysSetting: d.dueDaysSetting });
    expect(csv).toContain("# retention clients-due");
    expect(csv).toContain("client,appointment_et,contact_due_date,ghl_contact,call_attempts,last_call_status,transcript_result,acuity_notes,final_contact_classification,appointment_outcome");
    expect(csv).toContain('"LVM LR 10/19/26\nPaid with invoice 2324"'); // quoted multiline verbatim
    expect(csv).toContain("Voicemail");
    expect(csv).toContain("Cara Lee");
  });
});

describe("deriveSignalCells (§5b — four honest cells)", () => {
  test("SWC note against a non-verified call log = notes cell conflicts", () => {
    const cells = deriveSignalCells({
      final_status: "attempted_unclear",
      needs_review_reason: "test",
      evidence: {
        attempts: [
          { call_status: "no-answer", duration_seconds: 0, attempt_class: "no_answer" },
          { call_status: "no-answer", duration_seconds: 0, attempt_class: "no_answer" },
        ],
        note_evidence: { spokeMarkers: [{ token: "SWC", initials: "LR", date: null, raw: "SWC LR 10/19/26" }], voicemailMarkers: [], paraphraseSpoke: [], paraphraseVoicemail: [], rescheduleMention: false, cancelMention: false, confirmMention: false, notesPresent: true },
        transcript_basis: "probe verdict 2026-10-19: none",
      },
    });
    expect(cells.map((c) => c.label)).toEqual(["GHL call status", "Transcript", "Acuity notes", "Duration"]);
    expect(cells[0]!.value).toBe("2 attempts: no-answer");
    expect(cells[0]!.conflict).toBe(false); // nothing answered — no contradiction
    expect(cells[1]!.value).toContain("no transcripts in GHL payload");
    expect(cells[1]!.conflict).toBe(false);
    expect(cells[2]!.value).toContain("SWC LR 10/19/26");
    expect(cells[2]!.conflict).toBe(true); // the note claims contact the log lacks
    expect(cells[3]!.value).toBe("0s · 0s");
    expect(cells[3]!.note).toBe("supporting only — never decides");
    expect(cells[3]!.conflict).toBe(false);
  });

  test("answered evidence that failed to verify conflicts in the call-status cell", () => {
    const cells = deriveSignalCells({
      final_status: "needs_review",
      needs_review_reason: "test",
      evidence: {
        attempts: [{ call_status: "completed", duration_seconds: 0, attempt_class: "answered_uncorroborated" }],
        note_evidence: undefined,
      },
    });
    expect(cells[0]!.conflict).toBe(true);
    expect(cells[0]!.value).toBe("1 attempt: completed");
  });
});

describe("retention owner history (read-only store method)", () => {
  test("memory store: empty by default, seed helper + effective dates resolve the owner", async () => {
    const s = await seed();
    expect(await s.store.listRetentionOwnerHistory()).toEqual([]);
    expect(currentRetentionOwner(await s.store.listRetentionOwnerHistory(), "2026-10-20")).toBeNull();
    s.store.seedRetentionOwnerHistory([
      { employee_user_id: s.lauraId, name: "Laura Rivera", initials: "LR", active: true, effective_start: "2026-10-01", effective_end: null },
      { employee_user_id: s.lauraId, name: "Laura Rivera (prior)", initials: "LR", active: false, effective_start: "2026-09-01", effective_end: "2026-09-30" },
    ]);
    const rows = await s.store.listRetentionOwnerHistory();
    expect(rows).toHaveLength(2);
    expect(currentRetentionOwner(rows, "2026-10-20")).toBe("Laura Rivera");
    expect(currentRetentionOwner(rows, "2026-09-15")).toBe("Laura Rivera (prior)");
    expect(currentRetentionOwner(rows, "2026-08-15")).toBeNull();
    // The drill scope line + employee default light up from the same read.
    const d = await retentionDrillData(s.store, params({ kpi: "clients-due" }), NOW);
    expect(d.ownerName).toBe("Laura Rivera");
  });
});
