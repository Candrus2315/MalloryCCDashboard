/**
 * DEAD-CONTACT-ID REPAIR — pure resolution core (SMS EVIDENCE + CONTACT
 * RE-RESOLUTION spec, owner approved 2026-11-02, workstream 3).
 *
 * `appointments.contact_id` values can 404 in HighLevel (contacts merged /
 * removed); the engine then sees no identity/evidence at all. This module
 * provides the PURE pieces the resumable runner (scripts/dead-contact-repair.ts)
 * drives: the liveness probe verdict, the /contacts/?query= search wrappers and
 * the resolution hierarchy — exact canonical phone > exact email > name
 * (has-conversations desc, then most recent dateAdded). Ambiguous tiers are
 * SKIPPED, never guessed; a dead id is never its own replacement.
 *
 * Purity: pickReplacement touches no network and no store (unit-tested);
 * the probe/search helpers wrap fetch for the runner and tests-inject nothing.
 */
import { normalizeEmail, normalizeUSPhone } from "../identity/normalize";

const API = "https://services.leadconnectorhq.com";
function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Version: "2021-07-28", Accept: "application/json" };
}

/** True when the contact id is DEAD (GHL answers CONVERSATIONS_CONTACT_NOT_FOUND). */
async function probeContactDead(locationId: string, apiKey: string, contactId: string): Promise<"alive" | "dead" | "error"> {
  try {
    const res = await fetch(`${API}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}&limit=1`, { headers: headers(apiKey) });
    if (res.status === 200) return "alive";
    if (res.status === 400) {
      const body = await res.text();
      if (body.includes("CONVERSATIONS_CONTACT_NOT_FOUND") || body.includes("Contact not found")) return "dead";
      return "error";
    }
    return "error";
  } catch {
    return "error";
  }
}

interface HlContactLite {
  id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  dateAdded: string | null;
  conversations: number;
}

async function searchContacts(locationId: string, apiKey: string, query: string): Promise<HlContactLite[]> {
  const res = await fetch(`${API}/contacts/?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(query)}&limit=20`, { headers: headers(apiKey) });
  if (!res.ok) return [];
  const body = (await res.json()) as { contacts?: Record<string, unknown>[] };
  return (body.contacts ?? []).map((c) => ({
    id: String(c["id"] ?? ""),
    phone: typeof c["phone"] === "string" ? c["phone"] : null,
    email: typeof c["email"] === "string" ? c["email"] : null,
    name: typeof c["firstName"] === "string" || typeof c["lastName"] === "string" ? `${String(c["firstName"] ?? "")} ${String(c["lastName"] ?? "")}`.trim() : null,
    dateAdded: typeof c["dateAdded"] === "string" ? c["dateAdded"] : null,
    conversations: 0,
  }));
}

/** Count live conversations for a candidate (the "has interactions" signal). */
async function countConversations(locationId: string, apiKey: string, contactId: string): Promise<number> {
  try {
    const res = await fetch(`${API}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}&limit=20`, { headers: headers(apiKey) });
    if (!res.ok) return 0;
    const body = (await res.json()) as { conversations?: unknown[]; total?: number };
    return Number(body.total ?? (body.conversations ?? []).length) || 0;
  } catch {
    return 0;
  }
}

const normName = (n: string | null): string => (n ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * THE pure resolution hierarchy (unit-tested): phone exact > email exact >
 * name (has-conversations desc, then most recent dateAdded). Ambiguity at a
 * tier skips to the next tier; nothing is guessed.
 */
export function pickReplacement(
  appt: { client_phone: string | null; client_email: string | null; client_name: string | null },
  candidates: HlContactLite[],
  deadId: string,
): { contactId: string | null; resolvedBy: "phone" | "email" | "name" | null; note: string } {
  const pool = candidates.filter((c) => c.id && c.id !== deadId);
  const apptPhone = normalizeUSPhone(appt.client_phone);
  if (apptPhone) {
    const byPhone = pool.filter((c) => normalizeUSPhone(c.phone) === apptPhone);
    const distinct = [...new Set(byPhone.map((c) => c.id))];
    if (distinct.length === 1) return { contactId: distinct[0], resolvedBy: "phone", note: `exact phone ${apptPhone}` };
    if (distinct.length > 1) return { contactId: null, resolvedBy: null, note: `phone ${apptPhone} matches ${distinct.length} contacts — ambiguous, skipped` };
  }
  const apptEmail = normalizeEmail(appt.client_email);
  if (apptEmail) {
    const byEmail = pool.filter((c) => normalizeEmail(c.email) === apptEmail);
    const distinct = [...new Set(byEmail.map((c) => c.id))];
    if (distinct.length === 1) return { contactId: distinct[0], resolvedBy: "email", note: `exact email ${apptEmail}` };
    if (distinct.length > 1) return { contactId: null, resolvedBy: null, note: `email ${apptEmail} matches ${distinct.length} contacts — ambiguous, skipped` };
  }
  const name = normName(appt.client_name);
  if (name) {
    const byName = pool.filter((c) => normName(c.name) === name);
    if (byName.length === 1) return { contactId: byName[0].id, resolvedBy: "name", note: `exact name "${name}"` };
    if (byName.length > 1) {
      const ranked = [...byName].sort((a, b) => (b.conversations - a.conversations) || (Date.parse(b.dateAdded ?? "") || 0) - (Date.parse(a.dateAdded ?? "") || 0));
      const top = ranked[0];
      const runnerUp = ranked[1];
      const better = top.conversations > 0 && top.conversations > runnerUp.conversations;
      const newer = !better && (Date.parse(top.dateAdded ?? "") || 0) > (Date.parse(runnerUp.dateAdded ?? "") || 0) && top.conversations === runnerUp.conversations;
      if (better || newer) {
        return { contactId: top.id, resolvedBy: "name", note: `name "${name}" ×${byName.length} — picked has-conversations=${top.conversations} added=${(top.dateAdded ?? "").slice(0, 10)}` };
      }
      return { contactId: null, resolvedBy: null, note: `name "${name}" matches ${byName.length} contacts with no separating signal — ambiguous, skipped` };
    }
  }
  return { contactId: null, resolvedBy: null, note: "no candidate matched phone/email/name" };
}
