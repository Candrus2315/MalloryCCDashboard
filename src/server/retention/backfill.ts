/**
 * RETENTION IDENTITY BACKFILL (stage 2 — plan §7.5; owner-approved D1–D14).
 *
 * Seeds the canonical identity chain from data that ALREADY exists (reuse
 * mandate — no new sync, no new API client):
 *   A. appointments with a resolved contact_id (99.7% live) → one internal
 *      client per distinct GHL contact, linked both sides `exact_id` (the
 *      appointments→contacts chain IS the explicit cross-system pointer);
 *   B. appointments with NO resolved contact → owner-priority identity
 *      fallback (phone → email → name+supporting; name alone NEVER matches)
 *      against the current client universe; anything else → exception;
 *   C. contacts with recent calls not yet covered → match by phone/email,
 *      else CREATE a new client, else exception;
 *   D. calls that cannot reach any client (null contact_id / missing contact
 *      row) → exception rows — NOTHING is silent (gate criterion).
 *
 * IDEMPOTENCE CONTRACT (gate criterion: re-run is byte-identical):
 *   - internal clients are addressed by a deterministic seed_key
 *     (`hl-contact:<external_id>`) — looked up before insert;
 *   - every link insert is if-absent on the (provider, entity, external_id)
 *     UNIQUE — an existing link is returned UNCHANGED, never overwritten
 *     (manual resolves are therefore sticky by construction);
 *   - every exception insert is if-absent on its dedupe_key;
 *   - the applier performs NO update of an existing row, ever. A second run
 *     can only observe, never mutate.
 */
import type { Store } from "../store/types";
import { normalizeEmail, normalizeUSPhone } from "../identity/normalize";
import { matchIdentity, type IdentityCandidate, type MatchExceptionKind } from "./identity";
import { normalizeName } from "./identity";

export const RETENTION_BACKFILL_PROVIDER = "retention-identity-backfill";

export interface BackfillAppointment {
  acuityAppointmentId: string;
  status: string;
  clientName?: string | null;
  clientPhone?: string | null;
  clientEmail?: string | null;
  /** Resolved appointments.contact_id → contacts.external_id (null = unresolved). */
  contactExternalId: string | null;
}

export interface BackfillContact {
  externalId: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  /** True when the contact has ≥1 call inside the backfill window (plan §7.5.2: 90 days). */
  hasRecentCall: boolean;
}

export interface BackfillOrphanCall {
  provider: string;
  externalCallId: string;
  startedAtIso: string | null;
  direction: string | null;
  callStatus: string | null;
  durationSeconds: number | null;
  contactInternalId: string | null;
  /** Why this call cannot reach a client today. */
  reason: "null_contact_id" | "contact_row_missing";
}

export interface BackfillInput {
  appointments: BackfillAppointment[];
  contacts: BackfillContact[];
  callsWithoutClient: BackfillOrphanCall[];
}

export interface BackfillResult {
  clientsCreated: number;
  contactLinksCreated: number;
  appointmentLinksCreated: number;
  fallbackLinksCreated: number;
  exceptionsCreated: number;
  /** Entities skipped because a link already existed (the idempotence counter). */
  alreadyLinked: number;
  clientsSeen: number;
  fallbackAppointments: number;
  recentCallContacts: number;
  orphanCalls: number;
}

const CLIENT_SEED_PREFIX = "hl-contact:";

function clientSeedKey(contactExternalId: string): string {
  return `${CLIENT_SEED_PREFIX}${contactExternalId}`;
}

function candidateFromClient(c: { id: string; display_name: string | null; normalized_phone: string | null; normalized_email: string | null }): IdentityCandidate {
  return { internalClientId: c.id, displayName: c.display_name, normalizedPhone: c.normalized_phone, normalizedEmail: c.normalized_email };
}

function exceptionKindOf(outcome: { status: string; kind?: MatchExceptionKind }): MatchExceptionKind | null {
  if (outcome.status === "ambiguous") return (outcome as { kind: MatchExceptionKind }).kind;
  if (outcome.status === "unmatched") return (outcome as { kind: MatchExceptionKind }).kind;
  return null;
}

/**
 * Apply the backfill through the store's write API (both stores implement
 * the same semantics; memory-store tests exercise this exact function).
 */
export async function applyInternalClientBackfill(store: Store, input: BackfillInput): Promise<BackfillResult> {
  const result: BackfillResult = {
    clientsCreated: 0,
    contactLinksCreated: 0,
    appointmentLinksCreated: 0,
    fallbackLinksCreated: 0,
    exceptionsCreated: 0,
    alreadyLinked: 0,
    clientsSeen: input.appointments.length,
    fallbackAppointments: 0,
    recentCallContacts: 0,
    orphanCalls: input.callsWithoutClient.length,
  };

  const ensureClientForContact = async (contact: BackfillContact): Promise<string> => {
    const seedKey = clientSeedKey(contact.externalId);
    const existing = await store.getInternalClientBySeedKey(seedKey);
    if (existing) return existing.id;
    const created = await store.insertInternalClient({
      seedKey,
      displayName: contact.name ?? null,
      normalizedPhone: normalizeUSPhone(contact.phone ?? null),
      normalizedEmail: normalizeEmail(contact.email ?? null),
      ghlContactExternalId: contact.externalId,
      matchState: "auto_matched",
    });
    result.clientsCreated += 1;
    return created.id;
  };

  // ---- pass A: appointments with a resolved contact (exact_id chain) ----
  for (const appt of input.appointments) {
    if (!appt.contactExternalId) continue;
    const contact = input.contacts.find((c) => c.externalId === appt.contactExternalId);
    const clientId = await ensureClientForContact(
      contact ?? { externalId: appt.contactExternalId, hasRecentCall: false },
    );
    const contactLink = await store.insertClientMatchLinkIfAbsent({
      internalClientId: clientId,
      provider: "highlevel",
      entity: "contact",
      externalId: appt.contactExternalId,
      matchMethod: "exact_id",
      confidence: "exact",
      resolvedBy: "auto",
      evidence: { basis: "appointments_contact_id", appointment_acuity_id: appt.acuityAppointmentId },
    });
    if (contactLink.created) result.contactLinksCreated += 1;
    else result.alreadyLinked += 1;
    const apptLink = await store.insertClientMatchLinkIfAbsent({
      internalClientId: clientId,
      provider: "acuity",
      entity: "appointment",
      externalId: appt.acuityAppointmentId,
      matchMethod: "exact_id",
      confidence: "exact",
      resolvedBy: "auto",
      evidence: { basis: "appointments_contact_id", contact_external_id: appt.contactExternalId },
    });
    if (apptLink.created) result.appointmentLinksCreated += 1;
    else result.alreadyLinked += 1;
  }

  // ---- pass C: contacts with recent calls not yet covered ----
  // Runs BEFORE the unresolved-appointment fallback (pass B below) so an
  // appointment whose contact was never resolved can still match the client
  // created here from the same human's GHL contact (phone/email ladder).
  const allClients = await store.listInternalClients();
  const candidates = allClients.map(candidateFromClient);
  for (const contact of input.contacts) {
    if (!contact.hasRecentCall) continue;
    result.recentCallContacts += 1;
    const existingLink = await store.getClientMatchLink("highlevel", "contact", contact.externalId);
    if (existingLink) {
      result.alreadyLinked += 1;
      continue;
    }
    // Prefer the seed client for this contact when pass A already created it
    // (the client row itself carries this exact GHL contact id).
    const seedClient = await store.getInternalClientBySeedKey(clientSeedKey(contact.externalId));
    if (seedClient) {
      const link = await store.insertClientMatchLinkIfAbsent({
        internalClientId: seedClient.id,
        provider: "highlevel",
        entity: "contact",
        externalId: contact.externalId,
        matchMethod: "exact_id",
        confidence: "exact",
        resolvedBy: "auto",
        evidence: { basis: "client_origin", note: "client row carries this ghl_contact_external_id" },
      });
      if (link.created) result.contactLinksCreated += 1;
      else result.alreadyLinked += 1;
      continue;
    }
    const outcome = matchIdentity(
      {
        displayName: contact.name ?? null,
        phone: contact.phone ?? null,
        email: contact.email ?? null,
        supportingPhonePrefix: (normalizeUSPhone(contact.phone ?? null) ?? "").slice(0, 7) || null,
        supportingEmailDomain: (normalizeEmail(contact.email ?? null) ?? "").split("@")[1] ?? null,
      },
        candidates,
    );
    if (outcome.status === "matched") {
      const link = await store.insertClientMatchLinkIfAbsent({
        internalClientId: outcome.internalClientId,
        provider: "highlevel",
        entity: "contact",
        externalId: contact.externalId,
        matchMethod: outcome.matchMethod,
        confidence: outcome.confidence,
        resolvedBy: "auto",
        evidence: { basis: "identity_fallback", tier: outcome.evidence.tier, supporting: outcome.evidence.supporting },
      });
      if (link.created) result.fallbackLinksCreated += 1;
      else result.alreadyLinked += 1;
      continue;
    }
    if (outcome.status === "ambiguous") {
      // ≥2 candidate clients on a shared phone/email — NEVER guessed.
      const exc = await store.insertDataMatchExceptionIfAbsent({
        kind: (outcome as { kind: MatchExceptionKind }).kind,
        dedupeKey: `contact-identity:hl:${contact.externalId}`,
        payload: {
          subject: { source: "ghl_contact", contact_external_id: contact.externalId, name: contact.name ?? null, phone: contact.phone ?? null, email: contact.email ?? null },
          candidates: outcome.candidateIds,
          tier: outcome.evidence.tier,
        },
        context: { stage: "backfill", source_table: "contacts", trigger: "recent_calls" },
      });
      if (exc.created) result.exceptionsCreated += 1;
      continue;
    }
    if (contact.phone || contact.email) {
      // Identity attributes exist but matched nobody → CREATE a new client
      // (§7.5.2 "else create new"). The contact is the client's origin.
      const clientId = await ensureClientForContact(contact);
      const link = await store.insertClientMatchLinkIfAbsent({
        internalClientId: clientId,
        provider: "highlevel",
        entity: "contact",
        externalId: contact.externalId,
        matchMethod: "exact_id",
        confidence: "exact",
        resolvedBy: "auto",
        evidence: { basis: "new_client_origin" },
      });
      if (link.created) result.contactLinksCreated += 1;
      else result.alreadyLinked += 1;
      continue;
    }
    // No phone, no email → name alone (or nothing at all) → exception.
    const exc = await store.insertDataMatchExceptionIfAbsent({
      kind: (outcome as { kind: MatchExceptionKind }).kind,
      dedupeKey: `contact-identity:hl:${contact.externalId}`,
      payload: {
        subject: { source: "ghl_contact", contact_external_id: contact.externalId, name: contact.name ?? null, phone: contact.phone ?? null, email: contact.email ?? null },
        candidates: [],
        tier: outcome.evidence.tier,
      },
      context: { stage: "backfill", source_table: "contacts", trigger: "recent_calls" },
    });
    if (exc.created) result.exceptionsCreated += 1;
  }

  // Fresh client universe for pass B — passes A/C may have created clients
  // this run, and an unresolved appointment should find them (e.g. an
  // appointment whose GHL contact had no link until pass C created one).
  const allClientsAfterC = await store.listInternalClients();
  const candidatesB = allClientsAfterC.map(candidateFromClient);

  // ---- pass B: appointments WITHOUT a resolved contact → identity fallback ----
  for (const appt of input.appointments) {
    if (appt.contactExternalId) continue;
    result.fallbackAppointments += 1;
    const existingLink = await store.getClientMatchLink("acuity", "appointment", appt.acuityAppointmentId);
    if (existingLink) {
      result.alreadyLinked += 1; // manual resolve (or earlier pass) — sticky, never re-matched
      continue;
    }
    const outcome = matchIdentity(
      {
        displayName: appt.clientName ?? null,
        phone: appt.clientPhone ?? null,
        email: appt.clientEmail ?? null,
        supportingPhonePrefix: (normalizeUSPhone(appt.clientPhone ?? null) ?? "").slice(0, 7) || null,
        supportingEmailDomain: (normalizeEmail(appt.clientEmail ?? null) ?? "").split("@")[1] ?? null,
      },
      candidatesB,
    );
    if (outcome.status === "matched") {
      const link = await store.insertClientMatchLinkIfAbsent({
        internalClientId: outcome.internalClientId,
        provider: "acuity",
        entity: "appointment",
        externalId: appt.acuityAppointmentId,
        matchMethod: outcome.matchMethod,
        confidence: outcome.confidence,
        resolvedBy: "auto",
        evidence: { basis: "identity_fallback", tier: outcome.evidence.tier, supporting: outcome.evidence.supporting },
      });
      if (link.created) result.fallbackLinksCreated += 1;
      else result.alreadyLinked += 1;
      continue;
    }
    const kind = exceptionKindOf(outcome);
    if (!kind) continue;
    const exc = await store.insertDataMatchExceptionIfAbsent({
      kind,
      dedupeKey: `appt-identity:${appt.acuityAppointmentId}`,
      payload: {
        subject: {
          source: "acuity_appointment",
          acuity_appointment_id: appt.acuityAppointmentId,
          name: appt.clientName ?? null,
          phone: appt.clientPhone ?? null,
          email: appt.clientEmail ?? null,
        },
        candidates: outcome.status === "ambiguous" ? outcome.candidateIds : [],
        tier: outcome.evidence.tier,
        normalized_phone: outcome.evidence.normalizedPhone,
        normalized_email: outcome.evidence.normalizedEmail,
      },
      context: { appointment_status: appt.status, stage: "backfill", source_table: "appointments" },
    });
    if (exc.created) result.exceptionsCreated += 1;
  }

  // ---- pass D: calls that cannot reach any client — never silent ----
  for (const call of input.callsWithoutClient) {
    const exc = await store.insertDataMatchExceptionIfAbsent({
      kind: "no_identity",
      dedupeKey: `call-identity:${call.provider}:${call.externalCallId}`,
      payload: {
        subject: { source: "ghl_call", provider: call.provider, external_call_id: call.externalCallId },
        reason: call.reason,
        contact_internal_id: call.contactInternalId,
      },
      context: {
        stage: "backfill",
        source_table: "calls",
        started_at: call.startedAtIso,
        direction: call.direction,
        call_status: call.callStatus,
        duration_seconds: call.durationSeconds,
      },
    });
    if (exc.created) result.exceptionsCreated += 1;
  }

  return result;
}

/** True when the subject is name-only (helper reused by tests to assert the owner rule end-to-end). */
export function isNameOnlySubject(name: string | null | undefined, phone: string | null | undefined, email: string | null | undefined): boolean {
  return !!normalizeName(name) && !normalizeUSPhone(phone ?? null) && !normalizeEmail(email ?? null);
}
