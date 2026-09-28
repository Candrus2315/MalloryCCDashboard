/**
 * RULE B gate-failure probe (STOP-and-investigate): the live gate showed
 * ambiguous 3→1 with emailResolvesNonRoster=0. Dump the three email-identity
 * conflict rows and what their booking emails resolve to, INCLUDING the
 * resolved contact's assigned_rep_id and the owner user's is_active.
 */
import { getStore } from "../src/server/store";
import { normalizeEmail } from "../src/server/identity/normalize";

const store = await getStore();
const settings = await store.getSettings();
const users = await store.getAllUsers();
const contacts = await store.getContacts();
const since = new Date(Date.now() - 40 * 86400_000).toISOString().slice(0, 10);
const appts = (await store.getAppointmentsWithClientsSince(since + "T00:00:00Z"));
const attrs = await store.getAttributions();

console.log("===PROBE-START===");
const rows = attrs.filter((r) => r.rep_id == null && (r.note ?? "").startsWith("ambiguous"));
console.log("current ambiguous-prefixed rows:", rows.length);
for (const r of rows) {
  console.log(JSON.stringify({ appt: r.appointment_id, manual: r.manual_override, reason_code: r.reason_code, note: (r.note ?? "").slice(0, 160) }));
}

// rebuild the engine's junk set from the same appointment view the tick uses
const { appointmentInScope } = await import("../src/server/metrics/availability");
const inScope = appts.filter((a) => appointmentInScope(a, settings.acuity) && a.status !== "cancelled" && !a.cancelled);
const emailsByContact = new Map<string, Set<string>>();
for (const a of inScope) {
  const cid = (a.contact_id ?? "").trim();
  const e = normalizeEmail(a.client_email);
  if (!cid || !e) continue;
  (emailsByContact.get(cid) ?? emailsByContact.set(cid, new Set()).get(cid)!).add(e);
}
const junk = new Set([...emailsByContact.entries()].filter(([, s]) => s.size >= 2).map(([id]) => id));
console.log("junk contacts (in-scope window):", [...junk]);

const userById = new Map(users.map((u) => [u.id, u]));
const byEmail = new Map<string, string[]>();
for (const c of contacts) {
  const e = normalizeEmail(c.email);
  if (!e) continue;
  (byEmail.get(e) ?? byEmail.set(e, []).get(e)!).push(c.id);
}
// every in-scope appointment currently ambiguous or recently changed
const interesting = new Set(rows.map((r) => r.appointment_id));
// the two rows the failed gate flipped: find their appts by id from attrs history is gone —
// take ALL in-scope appts whose stored contact is junk (superset of the conflict population)
for (const a of inScope) {
  const cid = (a.contact_id ?? "").trim();
  if (!cid || !junk.has(cid)) continue;
  const apptId = (a as unknown as { id: string }).id;
  const attr = attrs.find((r) => r.appointment_id === apptId);
  if (!attr) continue;
  const email = normalizeEmail(a.client_email);
  const matches = email ? byEmail.get(email) ?? [] : [];
  const distinct = [...new Set(matches)];
  const resolvedId = distinct.length === 1 ? distinct[0] : null;
  const resolved = resolvedId ? contacts.find((c) => c.id === resolvedId) : null;
  const owner = resolved?.assigned_rep_id ?? null;
  const ownerUser = owner ? userById.get(owner) : null;
  console.log("===APPT===");
  console.log(JSON.stringify({
    apptId,
    storedContact: cid,
    clientEmail: a.client_email,
    attrReason: attr.reason_code,
    manual: attr.manual_override,
    emailMatchCount: distinct.length,
    resolvedContact: resolvedId,
    resolvedOwner: owner,
    ownerActive: ownerUser ? ownerUser.is_active : null,
    ownerProvider: ownerUser ? ownerUser.provider : null,
    resolvedContactAlsoJunk: resolvedId ? junk.has(resolvedId) : null,
  }));
}
console.log("===PROBE-END===");
process.exit(0);
