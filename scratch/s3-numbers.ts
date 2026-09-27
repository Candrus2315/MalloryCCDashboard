/**
 * SESSION 3 — OWNER'S NUMBERS + RECONCILIATION + AUDIT CHAINS.
 * Read-only over the store; runs AFTER the call-contact backfill and the
 * attribution rerun. Prints the exact deliverable list from the brief.
 */
import { getStore } from "../src/server/store";
import { appointmentInScope } from "../src/server/metrics/availability";
import { normalizeUSPhone, normalizeEmail } from "../src/server/identity/normalize";

const store = await getStore();
const settings = await store.getSettings();

// ---------- contacts reconciliation ----------
const contactsCpRaw = await store.getSyncCheckpoint("hl_contacts_backfill_v1");
const contactsCp = contactsCpRaw ? JSON.parse(contactsCpRaw) : null;
const contacts = await store.getContacts();
const hl = contacts.filter((c) => c.provider === "highlevel");
const sourceTotal = contactsCp?.sourceTotal ?? null;

// ---------- calls by resolution method ----------
const calls = (await store.getAllCallsSince("1970-01-01T00:00:00.000Z")) as Array<Record<string, unknown>>;
const byMethod: Record<string, number> = {};
let nullContact = 0;
let nonNullNoMethod = 0;
for (const c of calls) {
  const m = (c.contact_resolution_method as string | null) ?? null;
  if (c.contact_id == null) { nullContact += 1; continue; }
  if (m) byMethod[m] = (byMethod[m] ?? 0) + 1;
  else nonNullNoMethod += 1;
}

// ---------- appointments / attribution ----------
const apptsAll = await store.getAppointmentsWithClientsSince("1970-01-01T00:00:00.000Z");
const inScope = apptsAll.filter(
  (a) => appointmentInScope(a, settings.acuity) && a.status !== "cancelled" && !a.cancelled,
);
const attributions = await store.getAttributions();
const attributed = attributions.filter((r) => r.method !== "none");
const unattributed = attributions.filter((r) => r.method === "none");
const ambiguous = attributions.filter((r) => (r.note ?? "").startsWith("ambiguous"));

// Bookings matched to HighLevel identities: an in-scope booking carries at
// least one identity tier that resolves into the HighLevel contacts table.
const hlByExternal = new Map(hl.filter((c) => c.external_id).map((c) => [c.external_id as string, c]));
const hlByPhone = new Map<string, string[]>();
const hlByEmail = new Map<string, string[]>();
for (const c of hl) {
  const p = normalizeUSPhone(c.phone);
  if (p) { const l = hlByPhone.get(p) ?? []; if (!l.includes(c.id)) l.push(c.id); hlByPhone.set(p, l); }
  const e = normalizeEmail(c.email);
  if (e) { const l = hlByEmail.get(e) ?? []; if (!l.includes(c.id)) l.push(c.id); hlByEmail.set(e, l); }
}
let matchedIdentity = 0;
const tierCounts = { contact_id: 0, phone: 0, email: 0, none: 0 };
for (const a of inScope) {
  const cid = (a.contact_id ?? "").trim() || null;
  const ph = normalizeUSPhone(a.client_phone ?? null);
  const em = normalizeEmail(a.client_email ?? null);
  if (cid && hlByExternal.has(cid)) { matchedIdentity += 1; tierCounts.contact_id += 1; continue; }
  if (ph && (hlByPhone.get(ph) ?? []).length > 0) { matchedIdentity += 1; tierCounts.phone += 1; continue; }
  if (em && (hlByEmail.get(em) ?? []).length > 0) { matchedIdentity += 1; tierCounts.email += 1; continue; }
  tierCounts.none += 1;
}

// Bookings from calls > 2 minutes (winning call strictly over threshold).
const callById = new Map(calls.map((c) => [c.id as string, c]));
let fromOverThreshold = 0;
let attributedMissingCall = 0;
for (const r of attributed) {
  const call = r.call_id ? callById.get(r.call_id) : undefined;
  if (!call) { attributedMissingCall += 1; continue; }
  const dur = call.duration_seconds as number | null;
  if (typeof dur === "number" && dur > settings.meaningful_call_threshold_seconds) fromOverThreshold += 1;
}

// ---------- report ----------
console.log(JSON.stringify({
  contactsCp: { sourceTotal, upserted: contactsCp?.upserted, pagesDone: contactsCp?.pagesDone, failedPages: contactsCp?.failedPages, nextPageUrl: contactsCp?.nextPageUrl },
  contactsDbProviderHighlevel: hl.length,
  contactsDbAllProviders: contacts.length,
  pctIngestedOfSource: sourceTotal ? +(100 * hl.length / sourceTotal).toFixed(4) : null,
  callsTotal: calls.length,
  callsByResolutionMethod: byMethod,
  callsResolvedPreBackfill_noMethod: nonNullNoMethod,
  callsStillWithoutContactId: nullContact,
  appointmentsWithClientsAllTime: apptsAll.length,
  inScopeNonCancelledBookings: inScope.length,
  bookingsMatchedToHLIdentity: matchedIdentity,
  identityTiers: tierCounts,
  attributions: { storedRows: attributions.length, attributed: attributed.length, ambiguousQueue: ambiguous.length, unattributed: unattributed.length },
  invariant: {
    total: attributions.length,
    attributedPlusUnattributed: attributed.length + unattributed.length,
    holds: attributions.length === attributed.length + unattributed.length,
    ambiguousIsSubsetOfUnattributed: ambiguous.every((a) => unattributed.some((u) => u.id === a.id)),
  },
  bookingsFromCallsOver2Min: fromOverThreshold,
  attributedRowsWithoutStoredCall: attributedMissingCall,
  thresholdSeconds: settings.meaningful_call_threshold_seconds,
}, null, 2));
process.exit(0);
