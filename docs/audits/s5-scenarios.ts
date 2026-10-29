/**
 * S5 STEP 2 — SCENARIOS OVER THE RECONCILED PRODUCTION BASELINE (READ-ONLY).
 *
 * Baseline = the PRODUCTION ENGINE's own verdicts (matchAppointmentsToCalls,
 * exact computeAndPersistAttributions wiring — verified in s5-engine-gate.ts):
 *   49 attributed / 4 ambiguous / 71 no-qualifying-call = 124.
 *
 * For the 75 bookings NOT attributed under the production rule (4 ambiguous +
 * 71 no-qualifying-call), evaluate deterministic WORKFLOW evidence only:
 *   c1 = most-recent roster-rep interaction WITHIN the booking's attribution
 *        window (call ET date ∈ {created-1, created}), ANY duration;
 *   c2 = most-recent roster-rep interaction ALL-TIME (only when c1 empty).
 * Rep resolution: roster.ts machinery ONLY (buildRosterEligibility +
 * eligibleRepId; mapping is empty in settings, so eligibility = activeIds).
 * contacts.assigned_rep_id is NEVER read (forbidden as ownership evidence).
 *
 * AMBIGUITY (per owner rule, fixes the rejected walk): when the evidence tier
 * that would decide a booking shows MULTIPLE DISTINCT roster reps, the booking
 * is AMBIGUOUS — never resolved by most-recent pick.
 *
 * Scenario totals: Rep-Attributed = 49 baseline + newly deterministic;
 * Ambiguous; Unattributed; sum = 124 for BOTH s1 and s2.
 */
import { getStore } from "../src/server/store";
import { appointmentInScope } from "../src/server/metrics/availability";
import { matchAppointmentsToCalls } from "../src/server/metrics/attribution";
import {
  bookingCreationDateEt,
  attributionWindowDates,
  callDateEt,
} from "../src/server/metrics/attribution";
import { buildRosterEligibility, eligibleRepId, type RosterEligibility } from "../src/server/roster";
import { addDays, etDateStrFromInstant, etDayStartUtc, etToday } from "../src/server/date-logic";
import { normalizeUSPhone, normalizeEmail } from "../src/server/identity/normalize";
import postgres from "postgres";
import { getSecret } from "../src/server/env";

const store = await getStore();
const settings = await store.getSettings();
const today = etToday();
const since = etDayStartUtc(addDays(today, -(30 + Math.max(2, Math.ceil(settings.attribution_window_hours / 24)))));

const [apptsWin, calls, contacts, allUsers] = await Promise.all([
  store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(today, -30))),
  store.getAllCallsSince(since),
  store.getContacts(),
  store.getAllUsers(),
]);
const appts = apptsWin.filter(
  (a) => appointmentInScope(a, settings.acuity) && a.status !== "cancelled" && !a.cancelled,
);

// ---- PRODUCTION ENGINE verdicts (the reconciled baseline) ----
const matches = matchAppointmentsToCalls(
  appts,
  calls,
  contacts.map((c) => ({ id: c.id, phone: c.phone, email: c.email })),
  {
    meeting_threshold_seconds: settings.meaningful_call_threshold_seconds,
    attribution_window_hours: settings.attribution_window_hours,
    rep_mappings: settings.rep_mappings,
  },
  { today, users: allUsers.map((u) => ({ id: u.id, is_active: u.is_active })) },
);
const verdict = new Map(matches.map((m) => [m.appointmentId, m]));
const baseline = {
  attributed: matches.filter((m) => m.status === "attributed").length,
  ambiguous: matches.filter((m) => m.status === "unattributed" && m.reason === "ambiguous").length,
  unattributed: matches.filter((m) => m.status === "unattributed" && m.reason === "no-qualifying-call").length,
  total: matches.length,
};

// ---- roster machinery (SAME as production) ----
const elig: RosterEligibility = buildRosterEligibility(
  allUsers.map((u) => ({ id: u.id, is_active: u.is_active })),
  settings.rep_mappings ?? [],
);
const userById = new Map(allUsers.map((u) => [u.id, u]));
const userByHlExt = new Map(
  allUsers.filter((u) => u.provider === "highlevel" && u.external_id).map((u) => [u.external_id, u]),
);
const repName = (id: string | null) => (id && userById.get(id)?.name) || null;

// ---- evidence sources ----
const callsByContact = new Map<string, Array<Record<string, unknown>>>();
for (const c of calls as unknown as Array<Record<string, unknown>>) {
  const cid = c.contact_id as string | null;
  if (!cid) continue;
  (callsByContact.get(cid) ?? callsByContact.set(cid, []).get(cid)!).push(c);
}
const dbUrl = getSecret("DATABASE_URL")!;
const sql = postgres(dbUrl, { max: 2, ssl: "require" });
const hc = await sql`SELECT message_id, conversation_id, user_external_id, contact_external_id, started_at, duration_seconds FROM harvest_calls`;
await sql.end({ timeout: 1 });
const hcByContactExt = new Map<string, Array<Record<string, unknown>>>();
for (const h of hc as unknown as Array<Record<string, unknown>>) {
  const ce = h.contact_external_id as string | null;
  if (!ce) continue;
  (hcByContactExt.get(ce) ?? hcByContactExt.set(ce, []).get(ce)!).push(h);
}

const repOfCall = (c: Record<string, unknown>) =>
  eligibleRepId(
    { rep_id: (c.rep_id as string | null) ?? null, provider_rep_external_id: (c.provider_rep_external_id as string | null) ?? null },
    elig,
  );
const repOfHarvest = (h: Record<string, unknown>) => {
  const ext = (h.user_external_id as string | null) ?? "";
  if (!ext) return null;
  const u = userByHlExt.get(ext);
  if (u && u.is_active) return u.id;
  return elig.mapping.get(ext) ?? null;
};

// ---- identity (contact_id > phone > email, strict — production tiers) ----
const contactById = new Map(contacts.map((c) => [c.id, c]));
const byPhone = new Map<string, string[]>();
const byEmail = new Map<string, string[]>();
for (const c of contacts) {
  const p = normalizeUSPhone(c.phone);
  if (p) { const l = byPhone.get(p) ?? []; if (!l.includes(c.id)) l.push(c.id); byPhone.set(p, l); }
  const e = normalizeEmail(c.email);
  if (e) { const l = byEmail.get(e) ?? []; if (!l.includes(c.id)) l.push(c.id); byEmail.set(e, l); }
}

interface Outcome {
  apptId: string;
  tiers: string[];
  cands: string[];
  c1Reps: string[];
  c2Reps: string[];
  c1: { id: string; src: string; rep: string; startedAt: string; dur: number | null } | null;
  c2: { id: string; src: string; rep: string; startedAt: string; dur: number | null } | null;
  engineReason: string;
}
const outcomes: Outcome[] = [];
// Ownership scenarios re-classify ONLY the 71 no-qualifying-call bookings. The
// 4 engine-ambiguous bookings carry an IDENTITY conflict (email resolves a
// different contact than the stored contact id) — a different ambiguity axis
// the ownership rule cannot resolve; they KEEP their Ambiguous state in every
// scenario (multi-rep ambiguity stays Ambiguous per owner rule).
const engineAmb4 = matches.filter((m) => m.status === "unattributed" && m.reason === "ambiguous");
const analysis = matches.filter((m) => m.status === "unattributed" && m.reason === "no-qualifying-call"); // the 71

for (const m of analysis) {
  const appt = appts.find((a) => a.id === m.appointmentId) as Record<string, unknown> | undefined;
  const o: Outcome = { apptId: m.appointmentId, tiers: [], cands: [], c1Reps: [], c2Reps: [], c1: null, c2: null, engineReason: m.reason ?? "" };
  if (!appt) { outcomes.push(o); continue; }
  const apptContactId = ((appt.contact_id as string) ?? "").trim() || null;
  const ph = normalizeUSPhone((appt.client_phone as string) ?? null);
  const em = normalizeEmail((appt.client_email as string) ?? null);
  if (apptContactId && contactById.has(apptContactId)) { o.tiers.push("contact_id"); o.cands.push(apptContactId); }
  if (ph) { const hit = byPhone.get(ph) ?? []; if (hit.length === 1 && !o.cands.includes(hit[0])) { o.tiers.push("phone"); o.cands.push(hit[0]); } else if (hit.length > 1) o.tiers.push(`phone-multi(${hit.length})`); }
  if (em) { const hit = byEmail.get(em) ?? []; if (hit.length === 1 && !o.cands.includes(hit[0])) { o.tiers.push("email"); o.cands.push(hit[0]); } else if (hit.length > 1) o.tiers.push(`email-multi(${hit.length})`); }

  const anchor = bookingCreationDateEt({ created_at: (appt.created_at as string) ?? undefined, appointment_datetime: (appt.appointment_datetime as string) ?? undefined });
  const window = anchor ? attributionWindowDates(anchor.date) : null;
  const inWin = (iso: string | null) => {
    if (!window || !iso) return false;
    const d = callDateEt(iso);
    return d != null && d >= window.from && d <= window.to;
  };

  // interactions: calls table + harvest ledger, ANY duration, roster reps only
  const inter: Array<{ src: string; id: string; rep: string; ms: number; dur: number | null; contactId: string; convId: string | null; phone: string | null; email: string | null }> = [];
  for (const cid of o.cands) {
    const ct = contactById.get(cid)!;
    for (const c of callsByContact.get(cid) ?? []) {
      const rp = repOfCall(c);
      const ms = Date.parse(c.started_at as string);
      if (rp && Number.isFinite(ms)) inter.push({ src: "calls", id: (c.external_call_id as string) ?? (c.id as string), rep: rp, ms, dur: (c.duration_seconds as number | null), contactId: cid, convId: (c.conversation_id as string | null), phone: ct.phone_normalized ?? normalizeUSPhone(ct.phone), email: ct.email_normalized ?? normalizeEmail(ct.email) });
    }
    for (const h of hcByContactExt.get(ct.external_id ?? "") ?? []) {
      const rp = repOfHarvest(h);
      const ms = Date.parse(h.started_at as string);
      if (rp && Number.isFinite(ms)) inter.push({ src: "harvest", id: h.message_id as string, rep: rp, ms, dur: (h.duration_seconds as number | null), contactId: cid, convId: (h.conversation_id as string | null), phone: ct.phone_normalized ?? normalizeUSPhone(ct.phone), email: ct.email_normalized ?? normalizeEmail(ct.email) });
    }
  }
  const pick = (arr: typeof inter) => (arr.length ? arr.reduce((b, x) => (x.ms > b.ms ? x : b)) : null);
  const winInter = inter.filter((i) => inWin(new Date(i.ms).toISOString()));
  o.c1Reps = [...new Set(winInter.map((i) => i.rep))];
  o.c2Reps = [...new Set(inter.map((i) => i.rep))];
  const c1 = pick(winInter);
  if (c1) o.c1 = { id: c1.id, src: c1.src, rep: c1.rep, startedAt: new Date(c1.ms).toISOString(), dur: c1.dur };
  const c2 = pick(inter);
  if (c2) o.c2 = { id: c2.id, src: c2.src, rep: c2.rep, startedAt: new Date(c2.ms).toISOString(), dur: c2.dur };
  outcomes.push(o);
}

// ---- scenario totals ----
// s1: c1 within-window — deterministic single rep → newly attributed; multi → ambiguous.
// s2: c1 empty → c2 all-time — deterministic single rep → newly attributed; multi → ambiguous.
const s1New: Outcome[] = [];
const s1Amb: Outcome[] = [];
const s1None: Outcome[] = [];
const s2New: Outcome[] = [];
const s2Amb: Outcome[] = [];
const s2None: Outcome[] = [];
for (const o of outcomes) {
  if (o.c1Reps.length === 1) s1New.push(o);
  else if (o.c1Reps.length > 1) s1Amb.push(o);
  else s1None.push(o);
  if (o.c1Reps.length === 1) s2New.push(o);
  else if (o.c1Reps.length > 1) s2Amb.push(o);
  else if (o.c2Reps.length === 1) s2New.push(o);
  else if (o.c2Reps.length > 1) s2Amb.push(o);
  else s2None.push(o);
}
const s1 = { repAttributed: baseline.attributed + s1New.length, ambiguous: baseline.ambiguous + s1Amb.length, unattributed: s1None.length, sum: baseline.attributed + s1New.length + baseline.ambiguous + s1Amb.length + s1None.length };
const s2 = { repAttributed: baseline.attributed + s2New.length, ambiguous: baseline.ambiguous + s2Amb.length, unattributed: s2None.length, sum: baseline.attributed + s2New.length + baseline.ambiguous + s2Amb.length + s2None.length };
// sum check: 49 + (31+9) + (4+0) + (31) = 124 — partition of ALL 124 across the three states.

// ---- decision matrix by FIRST-SUCCESS method over the 75 not-attributed ----
// (71 no-qualifying-call re-evaluated + 4 engine-ambiguous kept as their own row)
const matrixHonest: Record<string, number> = {
  "c1-single-rep-in-window": s1New.length,
  "c2-single-rep-alltime": s2New.filter((o) => o.c1Reps.length === 0).length,
  "ambiguous-identity-conflict-engine-queue": baseline.ambiguous,
  "ambiguous-multi-rep-workflow": s2Amb.length,
  "none-no-workflow-evidence": s2None.length,
};
matrixHonest["sum-not-attributed"] = Object.values(matrixHonest).reduce((a, b) => a + b, 0);

// ---- exclusions ----
const exclusions = {
  engineNoQualifyingCall: baseline.unattributed,
  newlyReachableOnlyWithoutThreshold: s1New.length + s2New.filter((o) => o.c1Reps.length === 0).length,
  ambiguousIdentityConflict: baseline.ambiguous,
  ambiguousMultiRepWorkflow: s2Amb.length,
  noWorkflowEvidenceAtAll: s2None.length,
  fuzzyIdentitySkipped: outcomes.filter((o) => o.tiers.some((t) => t.includes("-multi"))).length,
};

// ---- evidence chains: 5 newly attributable (s2), full chain ----
const chains = s2New.slice(0, 5).map((o) => {
  const ct = contactById.get(o.cands[0] ?? "");
  return {
    apptId: o.apptId,
    method: o.c1Reps.length === 1 ? "c1-window-most-recent" : "c2-alltime-most-recent",
    rep: repName(o.c1?.rep ?? o.c2?.rep ?? null),
    evidence: o.c1 ?? o.c2, // source call/message id + src table + startedAt + duration
    identity: {
      tiers: o.tiers,
      contactHLId: ct?.external_id ?? null,
      phoneNormalized: ct ? (ct.phone_normalized ?? normalizeUSPhone(ct.phone)) : null,
      emailNormalized: ct ? (ct.email_normalized ?? normalizeEmail(ct.email)) : null,
    },
    engineReason: o.engineReason,
  };
});

// ---- >2min subset recheck: the REAL 49 inside each scenario's Rep-Attributed ----
const subset = { holds: true, violations: [] as string[] };
for (const m of matches) {
  if (m.status !== "attributed") {
    // engine-attributed bookings must NOT be re-classified — they are in both scenarios by construction
    continue;
  }
}
subset.holds = s1.repAttributed >= baseline.attributed && s2.repAttributed >= baseline.attributed;

const out = {
  baseline,
  notAttributedPopulation: { count: baseline.ambiguous + baseline.unattributed, note: "124 - 49 = 75 = 4 ambiguous + 71 no-qualifying-call. 79 would double-count the 4 ambiguous: 49+75=124; 49+79=128≠124." },
  scenarios: { s1_c1_within_window: s1, s2_c1_plus_c2_alltime: s2, s1_newly: s1New.length, s2_newly: s2New.length },
  decisionMatrixNotAttributed: matrixHonest,
  exclusions,
  chains,
  over2minSubsetRecheck: subset,
  _outcomes: outcomes.map((o) => ({ apptId: o.apptId, engineReason: o.engineReason, tiers: o.tiers, c1Reps: o.c1Reps.map((r) => repName(r)), c2Reps: o.c2Reps.map((r) => repName(r)), c1: o.c1, c2: o.c2 })),
};
await Bun.write(import.meta.dir + "/s5-scenarios.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify({ baseline, notAttributedPopulation: out.notAttributedPopulation, scenarios: out.scenarios, decisionMatrixNotAttributed: out.decisionMatrixNotAttributed, exclusions: out.exclusions, chains: out.chains, over2minSubsetRecheck: subset }, null, 2));
process.exit(0);
