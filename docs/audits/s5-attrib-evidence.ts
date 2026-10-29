/**
 * S5 TASK 1 — REP-ATTRIBUTABLE BOOKINGS INDEPENDENT OF THE >120s RULE.
 * READ-ONLY analysis over the NORMALIZED DB (source=DB=displayed; no live mixing).
 * For each of the 75 unattributed + 4 ambiguous stored bookings, evaluate
 * deterministic ownership evidence in priority order a→e, record the FIRST
 * method that succeeds, and produce the decision matrix + both scenario totals.
 * Never writes: no upserts, no attribution persistence.
 */
import { getStore } from "../src/server/store";
import { appointmentInScope } from "../src/server/metrics/availability";
import { normalizeUSPhone, normalizeEmail } from "../src/server/identity/normalize";
import { buildRosterEligibility, eligibleRepId, type RosterEligibility } from "../src/server/roster";
import { bookingCreationDateEt, attributionWindowDates, callDateEt } from "../src/server/metrics/attribution";
import { getSecret } from "../src/server/env";
import postgres from "postgres";

const store = await getStore();
const settings = await store.getSettings();
const THR = settings.meaningful_call_threshold_seconds;

// ---------- load ----------
const users = await store.getAllUsers();
const contacts = await store.getContacts();
const calls = (await store.getAllCallsSince("1970-01-01T00:00:00.000Z")) as Array<Record<string, unknown>>;
const appts = await store.getAppointmentsWithClientsSince("1970-01-01T00:00:00.000Z");
const attributions = await store.getAttributions();

// Direct SQL (same secret the store uses) for: appointments.raw + harvest tables.
const dbUrl = getSecret("DATABASE_URL")!;
const sql = postgres(dbUrl, { max: 2, ...(new URL(dbUrl).searchParams.get("sslmode") === null ? { ssl: "require" } : {}) });
const rawRows = await sql`SELECT id::text AS id, raw FROM appointments WHERE raw IS NOT NULL`;
const rawById = new Map(rawRows.map((r) => [r.id as string, r.raw as Record<string, unknown>]));
const convRows = await sql`SELECT conv_id, last_message_date, date_added, message_types, last_message_type, contact_id, assigned_to FROM harvest_conversations`;
await sql.end({ timeout: 1 });

// ---------- indexes ----------
const elig: RosterEligibility = buildRosterEligibility(
  users.map((u) => ({ id: u.id, is_active: u.is_active })),
  settings.rep_mappings ?? [],
);
const userById = new Map(users.map((u) => [u.id, u]));
const userByHlExt = new Map(
  users.filter((u) => u.provider === "highlevel" && u.external_id).map((u) => [u.external_id, u]),
);
const activeIds = elig.activeIds;
const rosterName = (repId: string | null) =>
  repId && userById.has(repId) ? userById.get(repId)!.name : null;

const contactById = new Map(contacts.map((c) => [c.id, c]));
const byPhone = new Map<string, string[]>();
const byEmail = new Map<string, string[]>();
for (const c of contacts) {
  const p = normalizeUSPhone(c.phone);
  if (p) { const l = byPhone.get(p) ?? []; if (!l.includes(c.id)) l.push(c.id); byPhone.set(p, l); }
  const e = normalizeEmail(c.email);
  if (e) { const l = byEmail.get(e) ?? []; if (!l.includes(c.id)) l.push(c.id); byEmail.set(e, l); }
}

const callsByContact = new Map<string, Array<Record<string, unknown>>>();
for (const c of calls) {
  const cid = c.contact_id as string | null;
  if (!cid) continue;
  const l = callsByContact.get(cid) ?? []; l.push(c); callsByContact.set(cid, l);
}
// harvest_calls ledger (call messages, independent of the `calls` table linkage)
const hcRows = await (async () => {
  const s2 = postgres(dbUrl, { max: 2, ...(new URL(dbUrl).searchParams.get("sslmode") === null ? { ssl: "require" } : {}) });
  const rows = await s2`SELECT message_id, conversation_id, user_external_id, contact_external_id, started_at, duration_seconds FROM harvest_calls`;
  await s2.end({ timeout: 1 });
  return rows as Array<Record<string, unknown>>;
})();
const hcByContactExt = new Map<string, Array<Record<string, unknown>>>();
for (const h of hcRows) {
  const ce = h.contact_external_id as string | null;
  if (!ce) continue;
  const l = hcByContactExt.get(ce) ?? []; l.push(h); hcByContactExt.set(ce, l);
}
const convsByContactExt = new Map<string, typeof convRows>();
for (const cv of convRows as Array<Record<string, unknown>>) {
  const ce = cv.contact_id as string | null;
  if (!ce) continue;
  const l = convsByContactExt.get(ce) ?? []; l.push(cv); convsByContactExt.set(ce, l);
}

/** Roster rep for a `calls`-table row via the ONE eligibility machinery. */
function repOfCall(c: Record<string, unknown>): string | null {
  return eligibleRepId(
    { rep_id: (c.rep_id as string | null) ?? null, provider_rep_external_id: (c.provider_rep_external_id as string | null) ?? null },
    elig,
  );
}
/** Roster rep for a harvest_calls row: raw HL user external id → active HL user, else mapping. */
function repOfHarvest(h: Record<string, unknown>): string | null {
  const ext = (h.user_external_id as string | null) ?? "";
  if (!ext) return null;
  const u = userByHlExt.get(ext);
  if (u && u.is_active) return u.id;
  return elig.mapping.get(ext) ?? null;
}

const inScope = appts.filter(
  (a) => appointmentInScope(a, settings.acuity) && a.status !== "cancelled" && !a.cancelled,
);
const apptById = new Map(appts.map((a) => [a.id, a]));
const attributedRows = attributions.filter((r) => r.method !== "none");
const ambRows = attributions.filter((r) => (r.note ?? "").startsWith("ambiguous"));
const plainUnRows = attributions.filter((r) => r.method === "none" && !(r.note ?? "").startsWith("ambiguous"));
const analysisRows = [...ambRows, ...plainUnRows]; // the 79

// ---------- evidence evaluation ----------
interface Ev {
  apptId: string;
  acuityId: string | null;
  note: string | null;
  anchor: string | null;
  window: { from: string; to: string } | null;
  identity: { tiers: string[]; candidateContacts: string[]; multi: boolean };
  windowCalls: { src: "calls" | "harvest"; ids: string[]; reps: string[]; durs: (number | null)[] }[];
  convReps: string[];
  convIds: string[];
  c1: { id: string; src: string; rep: string; startedAt: string; dur: number | null } | null;
  c2: { id: string; src: string; rep: string; startedAt: string; dur: number | null } | null;
  assignedReps: string[];
  firstMethod: string | null; // a-calls | a-harvest | b-conversation | c1 | c2 | e-assignment
  contactRepChains: Array<{ method: string; evidenceId: string; evidenceSrc: string; conversationId: string | null; contactId: string; contactExt: string | null; phone: string | null; email: string | null; repId: string; repName: string | null; startedAt: string | null; duration: number | null }>;
  rawKeys: string[] | null;
}
const results: Ev[] = [];

for (const r of analysisRows) {
  const appt = apptById.get(r.appointment_id);
  if (!appt) { results.push({ apptId: r.appointment_id, acuityId: null, note: r.note, anchor: null, window: null, identity: { tiers: [], candidateContacts: [], multi: false }, windowCalls: [], convReps: [], convIds: [], c1: null, c2: null, assignedReps: [], firstMethod: null, contactRepChains: [], rawKeys: null }); continue; }
  const a = appt as Record<string, unknown>;
  const apptId = r.appointment_id;
  const anchor = bookingCreationDateEt({ created_at: (a.created_at as string) ?? undefined, appointment_datetime: (a.appointment_datetime as string) ?? undefined });
  const window = anchor ? attributionWindowDates(anchor.date) : null;
  const apptContactId = ((a.contact_id as string) ?? "").trim() || null;
  const ph = normalizeUSPhone((a.client_phone as string) ?? null);
  const em = normalizeEmail((a.client_email as string) ?? null);

  // candidate contacts (ALL identity tiers — never guess between them)
  const tiers: string[] = [];
  const cands: string[] = [];
  if (apptContactId && contactById.has(apptContactId)) { tiers.push("contact_id"); cands.push(apptContactId); }
  if (ph) { const hit = byPhone.get(ph) ?? []; if (hit.length) { tiers.push(`phone(${hit.length})`); for (const id of hit) if (!cands.includes(id)) cands.push(id); } }
  if (em) { const hit = byEmail.get(em) ?? []; if (hit.length) { tiers.push(`email(${hit.length})`); for (const id of hit) if (!cands.includes(id)) cands.push(id); } }

  const chainFor = (method: string, contactId: string, evId: string, evSrc: string, rep: string, startedAt: string | null, dur: number | null, convId: string | null) => {
    const ct = contactById.get(contactId)!;
    return {
      method, evidenceId: evId, evidenceSrc: evSrc, conversationId: convId,
      contactId, contactExt: ct.external_id, phone: ct.phone_normalized ?? normalizeUSPhone(ct.phone) ?? null,
      email: ct.email_normalized ?? normalizeEmail(ct.email) ?? null,
      repId: rep, repName: rosterName(rep), startedAt, duration: dur,
    };
  };

  const ev: Ev = {
    apptId, acuityId: (a.acuity_appointment_id as string) ?? null, note: r.note,
    anchor: anchor?.date ?? null, window,
    identity: { tiers, candidateContacts: cands, multi: cands.length > 1 },
    windowCalls: [], convReps: [], convIds: [], c1: null, c2: null, assignedReps: [],
    firstMethod: null, contactRepChains: [],
    rawKeys: rawById.has(apptId) ? Object.keys(rawById.get(apptId)!).sort() : null,
  };

  const inWin = (iso: string | number | null): boolean => {
    if (!window || iso == null) return false;
    const ms = typeof iso === "number" ? iso : Date.parse(iso);
    if (!Number.isFinite(ms)) return false;
    const d = callDateEt(new Date(ms).toISOString());
    return d != null && d >= window.from && d <= window.to;
  };

  // (a) window calls — ANY duration — from the calls table
  const wCalls: Array<Record<string, unknown>> = [];
  for (const cid of cands) for (const c of callsByContact.get(cid) ?? []) if (inWin(c.started_at as string)) wCalls.push(c);
  const wReps = new Set<string>();
  for (const c of wCalls) { const rp = repOfCall(c); if (rp) wReps.add(rp); }
  if (wCalls.length) ev.windowCalls.push({ src: "calls", ids: wCalls.map((c) => (c.external_call_id as string) ?? (c.id as string)), reps: [...wReps], durs: wCalls.map((c) => (c.duration_seconds as number | null)) });
  // (a2) harvest ledger calls in window
  let hWinReps = new Set<string>();
  if (wReps.size === 0) {
    const hWin: Array<Record<string, unknown>> = [];
    for (const cid of cands) {
      const ct = contactById.get(cid)!;
      for (const h of hcByContactExt.get(ct.external_id) ?? []) if (inWin(h.started_at as string)) hWin.push(h);
    }
    for (const h of hWin) { const rp = repOfHarvest(h); if (rp) hWinReps.add(rp); }
    if (hWin.length) ev.windowCalls.push({ src: "harvest", ids: hWin.map((h) => h.message_id as string), reps: [...hWinReps], durs: hWin.map((h) => (h.duration_seconds as number | null)) });
    if (hWinReps.size === 1) {
      ev.firstMethod = "a-harvest";
      const h = hWin.find((x) => repOfHarvest(x) === [...hWinReps][0])!;
      const cid = cands.find((c) => (hcByContactExt.get(contactById.get(c)!.external_id) ?? []).includes(h))!;
      ev.contactRepChains.push(chainFor("a-harvest", cid, h.message_id as string, "harvest_calls", [...hWinReps][0], h.started_at as string, (h.duration_seconds as number | null), (h.conversation_id as string | null)));
    }
  } else if (wReps.size === 1) {
    ev.firstMethod = "a-calls";
    const c = wCalls.find((x) => repOfCall(x) === [...wReps][0])!;
    ev.contactRepChains.push(chainFor("a-calls", c.contact_id as string, (c.external_call_id as string) ?? (c.id as string), "calls", [...wReps][0], c.started_at as string, (c.duration_seconds as number | null), (c.conversation_id as string | null)));
  }

  // (b) conversation ownership
  if (!ev.firstMethod) {
    const convReps = new Set<string>();
    const convIds: string[] = [];
    for (const cid of cands) {
      const ct = contactById.get(cid)!;
      for (const cv of convsByContactExt.get(ct.external_id) ?? []) {
        convIds.push(cv.conv_id as string);
        const at = (cv.assigned_to as string | null) ?? "";
        if (!at) continue;
        const u = userByHlExt.get(at);
        if (u && u.is_active) convReps.add(u.id);
        else if (elig.mapping.has(at)) convReps.add(elig.mapping.get(at)!);
      }
    }
    ev.convReps = [...convReps]; ev.convIds = convIds.slice(0, 8);
    if (convReps.size === 1) {
      ev.firstMethod = "b-conversation";
      const rep = [...convReps][0];
      const cid = cands.find((c) => (convsByContactExt.get(contactById.get(c)!.external_id) ?? []).some((cv) => (cv.assigned_to as string | null) && (userByHlExt.get(cv.assigned_to as string)?.id === rep || elig.mapping.get(cv.assigned_to as string) === rep)))!;
      const cv = (convsByContactExt.get(contactById.get(cid)!.external_id) ?? []).find((x) => { const at = (x.assigned_to as string | null) ?? ""; const u = userByHlExt.get(at); return (u && u.is_active && u.id === rep) || elig.mapping.get(at) === rep; })!;
      ev.contactRepChains.push(chainFor("b-conversation", cid, cv.conv_id as string, "harvest_conversations", rep, null, null, cv.conv_id as string));
    }
  }

  // (c1)/(c2) most-recent roster-rep interaction (calls ∪ harvest, ANY duration)
  if (!ev.firstMethod) {
    const inter: Array<{ src: string; id: string; rep: string; startedMs: number; dur: number | null; contactId: string; convId: string | null }> = [];
    for (const cid of cands) {
      for (const c of callsByContact.get(cid) ?? []) {
        const rp = repOfCall(c);
        const ms = Date.parse(c.started_at as string);
        if (rp && Number.isFinite(ms)) inter.push({ src: "calls", id: (c.external_call_id as string) ?? (c.id as string), rep: rp, startedMs: ms, dur: (c.duration_seconds as number | null), contactId: cid, convId: (c.conversation_id as string | null) });
      }
      const ct = contactById.get(cid)!;
      for (const h of hcByContactExt.get(ct.external_id) ?? []) {
        const rp = repOfHarvest(h);
        const ms = Date.parse(h.started_at as string);
        if (rp && Number.isFinite(ms)) inter.push({ src: "harvest", id: h.message_id as string, rep: rp, startedMs: ms, dur: (h.duration_seconds as number | null), contactId: cid, convId: (h.conversation_id as string | null) });
      }
    }
    const inWinInter = inter.filter((i) => inWin(new Date(i.startedMs).toISOString()));
    const pick = (arr: typeof inter) => arr.length ? arr.reduce((b, x) => (x.startedMs > b.startedMs ? x : b)) : null;
    const c1 = pick(inWinInter);
    if (c1) {
      ev.c1 = { id: c1.id, src: c1.src, rep: c1.rep, startedAt: new Date(c1.startedMs).toISOString(), dur: c1.dur };
      ev.firstMethod = "c1-window-most-recent";
      ev.contactRepChains.push(chainFor("c1", c1.contactId, c1.id, c1.src, c1.rep, ev.c1.startedAt, c1.dur, c1.convId));
    } else {
      const c2 = pick(inter);
      if (c2) {
        ev.c2 = { id: c2.id, src: c2.src, rep: c2.rep, startedAt: new Date(c2.startedMs).toISOString(), dur: c2.dur };
        ev.firstMethod = "c2-alltime-most-recent";
        ev.contactRepChains.push(chainFor("c2", c2.contactId, c2.id, c2.src, c2.rep, ev.c2.startedAt, c2.dur, c2.convId));
      }
    }
    // window multi-rep conflicts are visible even when c1 resolves them
    if (wReps.size > 1) ev.windowCalls[0].reps = [...wReps];
  }

  // (e) contact-level HL assignment (assignedTo → roster rep), reached only when a–c produced nothing
  if (!ev.firstMethod && cands.length) {
    const asgReps = new Set<string>();
    for (const cid of cands) {
      const ct = contactById.get(cid)!;
      if (ct.assigned_rep_id && activeIds.has(ct.assigned_rep_id)) asgReps.add(ct.assigned_rep_id);
    }
    ev.assignedReps = [...asgReps];
    if (asgReps.size === 1) {
      ev.firstMethod = "e-assignment";
      const rep = [...asgReps][0];
      const cid = cands.find((c) => contactById.get(c)!.assigned_rep_id === rep)!;
      ev.contactRepChains.push(chainFor("e-assignment", cid, contactById.get(cid)!.external_id, "contacts.assigned_rep_id (HL assignedTo)", rep, null, null, null));
    }
  }
  results.push(ev);
}

// ---------- scenario totals ----------
const S1_METHODS = new Set(["a-calls", "a-harvest", "b-conversation", "c1-window-most-recent", "e-assignment"]);
const S2_METHODS = new Set([...S1_METHODS, "c2-alltime-most-recent"]);
const byFirst = new Map<string, number>();
for (const r of results) byFirst.set(r.firstMethod ?? "none", (byFirst.get(r.firstMethod ?? "none") ?? 0) + 1);

const s1Attributed = results.filter((r) => r.firstMethod && S1_METHODS.has(r.firstMethod)).length;
const s2Attributed = results.filter((r) => r.firstMethod && S2_METHODS.has(r.firstMethod)).length;
// ambiguous = evidence exists (roster reps appear somewhere) but no rule succeeded
const hasAnyRepEvidence = (r: Ev) => r.windowCalls.some((w) => w.reps.length > 0) || r.convReps.length > 0 || r.c1 != null || r.c2 != null || r.assignedReps.length > 0;
const s1Amb = results.filter((r) => !r.firstMethod && hasAnyRepEvidence(r)).length;
const s1Un = results.filter((r) => !r.firstMethod && !hasAnyRepEvidence(r)).length;
const s2Amb = s1Amb; // c2 resolves everything with an interaction; leftover ambiguous = rep-evidence with zero interactions
const s2Un = results.filter((r) => !r.firstMethod && !hasAnyRepEvidence(r)).length;

// what the 4 currently-ambiguous become
const ambOutcomes = ambRows.map((r) => {
  const res = results.find((x) => x.apptId === r.appointment_id)!;
  return { acuityId: res.acuityId, note: (r.note ?? "").slice(0, 90), firstMethod: res.firstMethod, windowCallReps: res.windowCalls.flatMap((w) => w.reps.map((rp) => `${rosterName(rp)}(${w.src})`)), convReps: res.convReps.map((rp) => rosterName(rp)), c1: res.c1, c2: res.c2, assignedReps: res.assignedReps.map((rp) => rosterName(rp)), identity: res.identity };
});

// ---------- >2min recheck ----------
const callById = new Map(calls.map((c) => [c.id as string, c]));
const storedRepNotRoster: string[] = [];
let subsetHolds = true;
const subsetDetail: Array<{ acuityId: string | null; repName: string | null }> = [];
for (const r of attributedRows) {
  const call = r.call_id ? callById.get(r.call_id) : undefined;
  if (!call) { storedRepNotRoster.push(`${r.appointment_id}: attributed row without stored call`); subsetHolds = false; continue; }
  const rep = repOfCall(call);
  const dur = call.duration_seconds as number | null;
  if (rep == null) { storedRepNotRoster.push(`${r.appointment_id}: winning call rep NOT a roster member`); subsetHolds = false; continue; }
  if (!(typeof dur === "number" && dur > THR)) { storedRepNotRoster.push(`${r.appointment_id}: winning call NOT >${THR}s (${dur})`); subsetHolds = false; continue; }
  subsetDetail.push({ acuityId: (apptById.get(r.appointment_id) as Record<string, unknown> | undefined)?.acuity_appointment_id as string ?? null, repName: rosterName(rep) });
}
// any booking connected to a >120s window call that is NOT rep-attributable?
const over2NotAttributable: Array<Record<string, unknown>> = [];
for (const r of attributions) {
  if (r.method !== "none") continue; // only unattributed side
  const res = results.find((x) => x.apptId === r.appointment_id);
  if (!res) continue;
  const appt = apptById.get(r.appointment_id)!;
  const anchor = bookingCreationDateEt({ created_at: (appt as Record<string, unknown>).created_at as string, appointment_datetime: (appt as Record<string, unknown>).appointment_datetime as string });
  if (!anchor) continue;
  const window = attributionWindowDates(anchor.date);
  const cands = res.identity.candidateContacts;
  const over2: string[] = [];
  for (const cid of cands) for (const c of callsByContact.get(cid) ?? []) {
    const dur = c.duration_seconds as number | null;
    const d = callDateEt(c.started_at as string);
    if (typeof dur === "number" && dur > THR && d && d >= window.from && d <= window.to) over2.push(`${c.external_call_id} dur=${dur} rep=${rosterName(repOfCall(c)) ?? "NON-ROSTER"}`);
  }
  const repAttributableS1 = res.firstMethod ? S1_METHODS.has(res.firstMethod) : false;
  const repAttributableS2 = res.firstMethod ? S2_METHODS.has(res.firstMethod) : false;
  if (over2.length && (!repAttributableS1 || !repAttributableS2)) {
    over2NotAttributable.push({ acuityId: res.acuityId, firstMethod: res.firstMethod, s1: repAttributableS1, s2: repAttributableS2, over2WindowCalls: over2.slice(0, 6), note: (r.note ?? "").slice(0, 80) });
  }
}

// ---------- raw payload inventory (method d) ----------
const keyCounts = new Map<string, number>();
for (const r of results) for (const k of r.rawKeys ?? []) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
const calDist = new Map<string, number>();
for (const a of inScope) {
  const k = `${(a as Record<string, unknown>).calendar_name ?? "∅"} | id=${(a as Record<string, unknown>).calendar_id ?? "∅"}`;
  calDist.set(k, (calDist.get(k) ?? 0) + 1);
}

// ---------- chains sample (≤2 per method, across methods) ----------
const chainSample: Record<string, unknown>[] = [];
for (const m of ["a-calls", "a-harvest", "b-conversation", "c1-window-most-recent", "c2-alltime-most-recent", "e-assignment"]) {
  for (const r of results.filter((x) => x.firstMethod === m).slice(0, 2)) {
    chainSample.push({ acuityId: r.acuityId, method: m, window: r.window, identity: r.identity, chains: r.contactRepChains });
  }
}

const out = {
  baseline: {
    inScopeNonCancelled: inScope.length,
    attributed: attributedRows.length,
    ambiguousQueue: ambRows.length,
    plainUnattributed: plainUnRows.length,
    thresholdSeconds: THR,
    activeRoster: users.filter((u) => u.is_active).map((u) => `${u.name} (${u.provider}:${u.external_id})`),
    repMappings: settings.rep_mappings ?? [],
    contactsAssignedRepPopulated: contacts.filter((c) => c.assigned_rep_id != null).length,
    harvestConversationsTotal: (convRows as unknown[]).length,
    harvestCallsTotal: hcRows.length,
    callsTotal: calls.length,
  },
  decisionMatrixByFirstMethod: Object.fromEntries([...byFirst.entries()].sort()),
  scenarios: {
    s1_c1_only: { repAttributed: attributedRows.length + s1Attributed, ambiguous: s1Amb, unattributed: s1Un, sum: attributedRows.length + s1Attributed + s1Amb + s1Un },
    s2_c1_plus_c2: { repAttributed: attributedRows.length + s2Attributed, ambiguous: s2Amb, unattributed: s2Un, sum: attributedRows.length + s2Attributed + s2Amb + s2Un },
    s1_newlyAttributed: s1Attributed,
    s2_newlyAttributed: s2Attributed,
  },
  perMethodCounts: Object.fromEntries(["a-calls", "a-harvest", "b-conversation", "c1-window-most-recent", "c2-alltime-most-recent", "e-assignment"].map((m) => [m, results.filter((r) => r.firstMethod === m).length])),
  noEvidenceUnattributed: results.filter((r) => !r.firstMethod && !hasAnyRepEvidence(r)).map((r) => ({ acuityId: r.acuityId, identity: r.identity, anchor: r.anchor, window: r.window, note: (r.note ?? "").slice(0, 60) })),
  ambiguousRemainingDetail: results.filter((r) => !r.firstMethod && hasAnyRepEvidence(r)).map((r) => ({ acuityId: r.acuityId, windowCallReps: r.windowCalls.flatMap((w) => w.reps.map((rp) => rosterName(rp))), convReps: r.convReps.map((rp) => rosterName(rp)), assignedReps: r.assignedReps.map((rp) => rosterName(rp)), identity: r.identity, note: (r.note ?? "").slice(0, 80) })),
  fourCurrentlyAmbiguousBecome: ambOutcomes,
  over2minRecheck: {
    attributedRowsChecked: attributedRows.length,
    strictSubsetOfRepAttributedHolds: subsetHolds,
    violations: storedRepNotRoster,
    bookingsWithOver120sWindowCallButNotRepAttributable: over2NotAttributable,
  },
  acuityRawPayload: { distinctKeys: Object.fromEntries([...keyCounts.entries()].sort()), calendarDistribution: Object.fromEntries([...calDist.entries()]) },
  chainSample,
  _allResults: results,
};
await Bun.write("scratch/s5-attrib-results.json", JSON.stringify(out, null, 2));
const { _allResults, ...report } = out;
console.log(JSON.stringify(report, null, 2));
process.exit(0);
