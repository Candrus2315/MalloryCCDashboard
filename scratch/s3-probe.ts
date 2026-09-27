/** Session-3 pre-flight probe: checkpoint, call/contact state. Read-only. */
import { getStore } from "../src/server/store";

const store = await getStore();
const cpRaw = await store.getSyncCheckpoint("hl_call_contact_backfill_v1");
const contactsCp = await store.getSyncCheckpoint("hl_contacts_backfill_v1");
const calls = await store.getAllCallsSince("1970-01-01T00:00:00.000Z");
const contacts = await store.getContacts();
const users = await store.getAllUsers();
const settings = await store.getSettings();
const attributions = await store.getAttributions();
const appts = await store.getAppointmentsWithClientsSince("1970-01-01T00:00:00.000Z");

const unresolved = calls.filter((c) => c.contact_id == null);
const byProvider: Record<string, number> = {};
for (const c of calls) byProvider[c.provider] = (byProvider[c.provider] ?? 0) + 1;
const contactsHl = contacts.filter((c) => c.provider === "highlevel");

console.log(JSON.stringify({
  checkpointCallBackfill: cpRaw ? JSON.parse(cpRaw) : null,
  checkpointContacts: contactsCp ? (() => { try { const p = JSON.parse(contactsCp); return { done: p.done, upserted: p.upserted, pages: p.pages ?? p.scannedPages }; } catch { return contactsCp.slice(0, 120); } })() : null,
  callsTotal: calls.length,
  callsByProvider: byProvider,
  callsUnresolved: unresolved.length,
  callsResolved: calls.length - unresolved.length,
  contactsTotal: contacts.length,
  contactsHighlevel: contactsHl.length,
  users: users.length,
  rosterMappings: settings.rep_mappings?.length ?? 0,
  attributionWindowHours: settings.attribution_window_hours,
  threshold: settings.meaningful_call_threshold_seconds,
  attributionsRows: attributions.length,
  apptsWithClientsTotal: appts.length,
}, null, 2));
process.exit(0);
