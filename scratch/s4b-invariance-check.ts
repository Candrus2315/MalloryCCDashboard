/** S4b invariance check: modified engine must reproduce the pre-change baseline verdicts. */
import { matchAppointmentsToCalls, type AttributionAppointment, type AttributionCall, type AttributionContact, type AttributionHarvestInteraction } from "../src/server/metrics/attribution";

const USERS = [
  { id: "u_r1", is_active: true },
  { id: "u_r2", is_active: true },
  { id: "u_x", is_active: false },
];
const SETTINGS = { meeting_threshold_seconds: 120, attribution_window_hours: 24, rep_mappings: [] };
const mkAppt = (id: string, extra: Partial<AttributionAppointment> = {}): AttributionAppointment => ({
  id, contact_id: null, client_phone: null, client_email: null,
  appointment_datetime: "2026-09-16T18:00:00.000Z", created_at: "2026-09-15T14:00:00.000Z",
  created_business_date: "2026-09-15", cancelled: false, status: "confirmed", ...extra,
});
const mkCall = (id: string, extra: Partial<AttributionCall> = {}): AttributionCall => ({
  external_call_id: id, rep_id: null, contact_id: "c1", started_at: "2026-09-15T15:00:00.000Z",
  duration_seconds: 300, id, ...extra,
});
const contact = (id: string, extra: Partial<AttributionContact> = {}): AttributionContact => ({ id, phone: null, email: null, external_id: null, ...extra });
const mkH = (id: string, extra: Partial<AttributionHarvestInteraction> = {}): AttributionHarvestInteraction => ({ id, contact_external_id: "hl_c1", rep_id: null, started_at: "2026-09-15T15:00:00.000Z", duration_seconds: 5, ...extra });

const S: Array<[string, AttributionAppointment[], AttributionCall[], AttributionContact[], AttributionHarvestInteraction[]]> = [
  ["cid-attributed", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1" })], [contact("c1")], []],
  ["cid-most-recent", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1", started_at: "2026-09-15T14:00:00.000Z" }), mkCall("h2", { rep_id: "u_r1", started_at: "2026-09-15T16:00:00.000Z" })], [contact("c1")], []],
  ["cid-multi-rep-ambiguous", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1" }), mkCall("h2", { rep_id: "u_r2" })], [contact("c1")], []],
  ["s1-below-threshold-call-owns", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1", duration_seconds: 30 })], [contact("c1")], []],
  ["no-window-interaction", [mkAppt("a1", { contact_id: "c1" })], [], [contact("c1")], []],
  ["interaction-without-roster-rep-call", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_x", duration_seconds: 30 })], [contact("c1")], []],
  ["interaction-without-roster-rep-call-over-threshold", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_x", duration_seconds: 900 })], [contact("c1")], []],
  ["interaction-without-roster-rep-harvest", [mkAppt("a1", { contact_id: "c1" })], [], [contact("c1", { external_id: "hl_c1" })], [mkH("m1")]],
  ["s1-harvest-owns", [mkAppt("a1", { contact_id: "c1" })], [], [contact("c1", { external_id: "hl_c1" })], [mkH("m1", { rep_id: "u_r1" })]],
  ["s1-harvest-multi-rep-ambiguous", [mkAppt("a1", { contact_id: "c1" })], [], [contact("c1", { external_id: "hl_c1" })], [mkH("m1", { rep_id: "u_r1" }), mkH("m2", { rep_id: "u_r2", started_at: "2026-09-15T16:00:00.000Z" })]],
  ["no-contact-identity", [mkAppt("a1")], [mkCall("h1", { rep_id: "u_r1" })], [contact("c1")], []],
  ["bad-datetime", [mkAppt("a1", { contact_id: "c1", created_at: "not-a-date", created_business_date: null, appointment_datetime: "also-bad" })], [mkCall("h1", { rep_id: "u_r1" })], [contact("c1")], []],
  ["dangling-cid-no-window", [mkAppt("a1", { contact_id: "c_missing" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1")], []],
  ["phone-no-matching-contact", [mkAppt("a1", { client_phone: "5088891019" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1", { phone: "9998887777" })], []],
  ["phone-attributed", [mkAppt("a1", { client_phone: "5088891019" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1", { phone: "+15088891019" })], []],
  ["phone-multi-contact-ambiguous", [mkAppt("a1", { client_phone: "5088891019" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1", { phone: "+15088891019" }), contact("c2", { phone: "5088891019" })], []],
  ["phone-contradicts-cid-ambiguous", [mkAppt("a1", { contact_id: "c1", client_phone: "5088891019" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c2" })], [contact("c1"), contact("c2", { phone: "+15088891019" })], []],
  ["email-different-contact-than-cid-ambiguous", [mkAppt("a1", { contact_id: "c1", client_email: "A@B.com" })], [mkCall("h1", { rep_id: "u_r2", contact_id: "c2" })], [contact("c1"), contact("c2", { email: "a@b.com" })], []],
  ["phone-tier-wins-before-email-reached", [mkAppt("a1", { client_phone: "5088891019", client_email: "a@b.com" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1", { phone: "+15088891019" }), contact("c2", { email: "a@b.com" })], []],
  ["window-day-minus-one", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1", started_at: "2026-09-14T20:00:00.000Z" })], [contact("c1")], []],
  ["window-day-minus-two-out", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1", started_at: "2026-09-13T20:00:00.000Z" })], [contact("c1")], []],
  ["threshold-equal-out", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1", duration_seconds: 120 })], [contact("c1")], []],
  ["mapping-resolved-attributes", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: null, provider_rep_external_id: "hl_u9" })], [contact("c1")], []],
  ["cancelled-still-judged", [mkAppt("a1", { contact_id: "c1", cancelled: true, status: "cancelled" })], [mkCall("h1", { rep_id: "u_r1" })], [contact("c1")], []],
  ["legacy-date-only-anchor", [mkAppt("a1", { contact_id: "c1", created_at: "2026-09-15", created_business_date: null })], [mkCall("h1", { rep_id: "u_r1", started_at: "2026-09-15T15:00:00.000Z" })], [contact("c1")], []],
];

const baseline = (await Bun.file("src/server/__tests__/fixtures/s4b-verdict-baseline.json").json()).scenarios as Array<{ name: string; matches: Array<Record<string, unknown>> }>;
const KEYS = ["appointmentId", "status", "repId", "callExternalId", "method", "reason", "detail", "evidence", "window"] as const;
let fails = 0;
const noRep: Record<string, number> = {};
for (const [name, appts, calls, contacts, s1] of S) {
  const got = matchAppointmentsToCalls(appts, calls, contacts, SETTINGS, { today: "2026-09-27", users: USERS, s1Interactions: s1 });
  const want = baseline.find((b) => b.name === name)!.matches;
  const strip = (m: Record<string, unknown>) => Object.fromEntries(KEYS.map((k) => [k, m[k] === undefined ? null : m[k]]));
  if (JSON.stringify(got.map(strip)) !== JSON.stringify(want.map(strip))) {
    fails++;
    console.log(`MISMATCH ${name}\n  want ${JSON.stringify(want.map(strip))}\n  got  ${JSON.stringify(got.map(strip))}`);
  }
  for (const m of got) if (m.status === "unattributed" && m.reason !== "ambiguous") noRep[m.noRepReason ?? "MISSING"] = (noRep[m.noRepReason ?? "MISSING"] ?? 0) + 1;
  for (const m of got) if (m.status === "attributed" || m.reason === "ambiguous") { if (m.noRepReason !== undefined) { fails++; console.log(`LEAK ${name}: noRepReason on non-unattributed`); } }
}
console.log(fails === 0 ? `INVARIANCE OK — ${S.length} scenarios reproduce baseline verdicts exactly` : `${fails} FAILURES`);
console.log("noRepReason distribution:", JSON.stringify(noRep));
