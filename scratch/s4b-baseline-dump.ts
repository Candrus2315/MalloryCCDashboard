/**
 * S4b PRE-CHANGE BASELINE (run BEFORE the engine modification): dumps
 * matchAppointmentsToCalls verdicts for a fixed scenario matrix to
 * src/server/__tests__/fixtures/s4b-verdict-baseline.json. The committed test
 * then asserts the MODIFIED engine reproduces every verdict exactly
 * (status/repId/callExternalId/method/reason) — the before/after
 * verdict-invariance net for the reason-classification change.
 */
import { matchAppointmentsToCalls, type AttributionAppointment, type AttributionCall, type AttributionContact, type AttributionHarvestInteraction } from "../src/server/metrics/attribution";

const USERS = [
  { id: "u_r1", is_active: true },
  { id: "u_r2", is_active: true },
  { id: "u_x", is_active: false },
];
const SETTINGS = { meeting_threshold_seconds: 120, attribution_window_hours: 24, rep_mappings: [] };

const mkAppt = (id: string, extra: Partial<AttributionAppointment> = {}): AttributionAppointment => ({
  id,
  contact_id: null,
  client_phone: null,
  client_email: null,
  appointment_datetime: "2026-09-16T18:00:00.000Z",
  created_at: "2026-09-15T14:00:00.000Z", // Tue 2026-09-15, 10:00 ET
  created_business_date: "2026-09-15",
  cancelled: false,
  status: "confirmed",
  ...extra,
});
const mkCall = (id: string, extra: Partial<AttributionCall> = {}): AttributionCall => ({
  external_call_id: id,
  rep_id: null,
  contact_id: "c1",
  started_at: "2026-09-15T15:00:00.000Z", // 11:00 ET on the creation date
  duration_seconds: 300,
  id: id,
  ...extra,
});

const contact = (id: string, extra: Partial<AttributionContact> = {}): AttributionContact => ({
  id,
  phone: null,
  email: null,
  external_id: null,
  ...extra,
});

const scenarios: Array<Record<string, unknown>> = [];
const run = (name: string, appts: AttributionAppointment[], calls: AttributionCall[], contacts: AttributionContact[], s1: AttributionHarvestInteraction[] = []) => {
  const matches = matchAppointmentsToCalls(appts, calls, contacts, SETTINGS, { today: "2026-09-27", users: USERS, s1Interactions: s1 });
  scenarios.push({ name, matches });
};

// 1 contact_id tier, single rep qualifying call → attributed
run("cid-attributed", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1" })], [contact("c1")]);
// 2 most-recent wins across two qualifying calls same rep
run("cid-most-recent", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1", started_at: "2026-09-15T14:00:00.000Z" }), mkCall("h2", { rep_id: "u_r1", started_at: "2026-09-15T16:00:00.000Z" })], [contact("c1")]);
// 3 multi-rep qualifying calls → ambiguous
run("cid-multi-rep-ambiguous", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1" }), mkCall("h2", { rep_id: "u_r2" })], [contact("c1")]);
// 4 call below threshold only → no-qualifying-call (then s1 picks it up: any duration)
run("s1-below-threshold-call-owns", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1", duration_seconds: 30 })], [contact("c1")]);
// 5 no calls at all → no-qualifying-call, nothing in window
run("no-window-interaction", [mkAppt("a1", { contact_id: "c1" })], [], [contact("c1")]);
// 6 in-window call with UNRESOLVABLE rep (inactive user) any duration → interaction exists, no roster rep
run("interaction-without-roster-rep-call", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_x", duration_seconds: 30 })], [contact("c1")]);
// 7 same but over threshold (still unresolvable rep → no qualifying ownership)
run("interaction-without-roster-rep-call-over-threshold", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_x", duration_seconds: 900 })], [contact("c1")]);
// 8 harvest interaction unresolved user → interaction-without-roster-rep via harvest
run("interaction-without-roster-rep-harvest", [mkAppt("a1", { contact_id: "c1" })], [], [contact("c1", { external_id: "hl_c1" })], [{ id: "m1", contact_external_id: "hl_c1", rep_id: null, started_at: "2026-09-15T15:00:00.000Z", duration_seconds: 60 }]);
// 9 harvest interaction with roster rep → ATTRIBUTED via s1 (regression pin)
run("s1-harvest-owns", [mkAppt("a1", { contact_id: "c1" })], [], [contact("c1", { external_id: "hl_c1" })], [{ id: "m1", contact_external_id: "hl_c1", rep_id: "u_r1", started_at: "2026-09-15T15:00:00.000Z", duration_seconds: 5 }]);
// 10 harvest multi-rep → ambiguous
run("s1-harvest-multi-rep-ambiguous", [mkAppt("a1", { contact_id: "c1" })], [], [contact("c1", { external_id: "hl_c1" })], [
  { id: "m1", contact_external_id: "hl_c1", rep_id: "u_r1", started_at: "2026-09-15T15:00:00.000Z", duration_seconds: 5 },
  { id: "m2", contact_external_id: "hl_c1", rep_id: "u_r2", started_at: "2026-09-15T16:00:00.000Z", duration_seconds: 5 },
]);
// 11 no identity at all → no-contact-identity
run("no-contact-identity", [mkAppt("a1")], [mkCall("h1", { rep_id: "u_r1" })], [contact("c1")]);
// 12 unparseable anchor → bad-datetime
run("bad-datetime", [mkAppt("a1", { contact_id: "c1", created_at: "not-a-date", created_business_date: null, appointment_datetime: "also-bad" })], [mkCall("h1", { rep_id: "u_r1" })], [contact("c1")]);
// 13 dangling contact id (no contact row), no calls for the id → no-window-interaction
run("dangling-cid-no-window", [mkAppt("a1", { contact_id: "c_missing" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1")]);
// 14 phone only, no matching contact → no-matching-contact
run("phone-no-matching-contact", [mkAppt("a1", { client_phone: "5088891019" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1", { phone: "9998887777" })]);
// 15 phone resolves → contact's qualifying call attributes via phone tier
run("phone-attributed", [mkAppt("a1", { client_phone: "5088891019" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1", { phone: "+15088891019" })]);
// 16 phone resolves to TWO contacts → ambiguous
run("phone-multi-contact-ambiguous", [mkAppt("a1", { client_phone: "5088891019" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1", { phone: "+15088891019" }), contact("c2", { phone: "5088891019" })]);
// 17 phone resolves a DIFFERENT contact than stored id → ambiguous (clause 1)
run("phone-contradicts-cid-ambiguous", [mkAppt("a1", { contact_id: "c1", client_phone: "5088891019" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c2" })], [contact("c1"), contact("c2", { phone: "+15088891019" })]);
// 18 email resolves after contact-id tier no-qual → attributes via email tier
run("email-different-contact-than-cid-ambiguous", [mkAppt("a1", { contact_id: "c1", client_email: "A@B.com" })], [mkCall("h1", { rep_id: "u_r2", contact_id: "c2" })], [contact("c1"), contact("c2", { email: "a@b.com" })]);
// 19 email contradicts phone → ambiguous
run("phone-tier-wins-before-email-reached", [mkAppt("a1", { client_phone: "5088891019", client_email: "a@b.com" })], [mkCall("h1", { rep_id: "u_r1", contact_id: "c1" })], [contact("c1", { phone: "+15088891019" }), contact("c2", { email: "a@b.com" })]);
// 20 window edges: call on creation date −1 qualifies; −2 does not
run("window-day-minus-one", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1", started_at: "2026-09-14T20:00:00.000Z" })], [contact("c1")]);
run("window-day-minus-two-out", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1", started_at: "2026-09-13T20:00:00.000Z" })], [contact("c1")]);
// 21 call exactly AT threshold (120s) never qualifies
run("threshold-equal-out", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: "u_r1", duration_seconds: 120 })], [contact("c1")]);
// 22 mapping-resolved rep attributes (rep_mappings drive eligibility)
run("mapping-resolved-attributes", [mkAppt("a1", { contact_id: "c1" })], [mkCall("h1", { rep_id: null, provider_rep_external_id: "hl_u9" })], [contact("c1")]);
// 23 cancelled booking still gets a verdict row (engine judges; wiring filters)
run("cancelled-still-judged", [mkAppt("a1", { contact_id: "c1", cancelled: true, status: "cancelled" })], [mkCall("h1", { rep_id: "u_r1" })], [contact("c1")]);
// 24 legacy anchor: no created_business_date, created_at date-only encoding
run("legacy-date-only-anchor", [mkAppt("a1", { contact_id: "c1", created_at: "2026-09-15", created_business_date: null })], [mkCall("h1", { rep_id: "u_r1", started_at: "2026-09-15T15:00:00.000Z" })], [contact("c1")]);

const out = { _meta: "S4b verdict baseline — captured from the PRE-S4b engine (commit b64041e). The verdict-invariance test asserts the engine still reproduces every match exactly after the reason-classification change.", scenarios };
await Bun.write("src/server/__tests__/fixtures/s4b-verdict-baseline.json", JSON.stringify(out, null, 2));
console.log(`WROTE baseline with ${scenarios.length} scenarios, ${scenarios.reduce((n, s) => n + ((s.matches as unknown[]).length), 0)} matches`);
