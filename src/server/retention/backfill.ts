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
 *
 * PERFORMANCE (2026-10-20 live-fire): the first full run was RTT-bound —
 * ~6k subjects × per-row lookups over TLS ≈ tens of minutes per pass. Reads
 * are now served from a single bulk prefetch (listInternalClients /
 * listClientMatchLinks / getDataMatchExceptions) that is kept coherent as
 * this run writes; writes stay per-row if-absent through the store (the
 * store remains the only writer and stays race-safe). Read prefetching can
 * never change WHAT gets written: on a re-run every subject is already
 * present, so run 2 still writes nothing (byte-identical, gate G6). Loop
 * bodies run in bounded-parallel chunks (default 24) on DISTINCT keys only —
 * no two concurrent tasks ever address the same seed_key / link key /
 * dedupe_key, so counters and final rows are identical to the sequential
 * applier's.
 */
import type { Store, InternalClientRow, ClientMatchLinkRow } from "../store/types";
import { normalizeEmail, normalizeUSPhone } from "../identity/normalize";
import { matchIdentity, type IdentityCandidate, type MatchExceptionKind } from "./identity";
import { normalizeName } from "./identity";

export const RETENTION_BACKFILL_PROVIDER = "retention-identity-backfill";

/** Max concurrent store operations per chunk (bounded; each op targets a distinct key). */
const CHUNK = 24;

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

/** Bounded-parallel map over DISTINCT-key tasks; chunk order sequential, within-chunk concurrent. */
async function mapChunk<T, R>(items: T[], fn: (item: T) => Promise<R>, size = CHUNK): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

interface Prefetch {
  clientBySeedKey: Map<string, InternalClientRow>;
  clientById: Map<string, InternalClientRow>;
  linkByKey: Map<string, ClientMatchLinkRow>;
  exceptionByDedupe: Set<string>;
}
const linkKey = (provider: string, entity: string, externalId: string) => `${provider}:${entity}:${externalId}`;

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

  // ---- bulk read prefetch (pure observation; updated as this run writes) ----
  const [allClients0, allLinks, allExceptions] = await Promise.all([
    store.listInternalClients(),
    store.listClientMatchLinks(),
    store.getDataMatchExceptions(),
  ]);
  const pf: Prefetch = {
    clientBySeedKey: new Map(),
    clientById: new Map(),
    linkByKey: new Map(),
    exceptionByDedupe: new Set(allExceptions.map((e) => e.dedupe_key)),
  };
  for (const c of allClients0) {
    pf.clientById.set(c.id, c);
    if (c.seed_key) pf.clientBySeedKey.set(c.seed_key, c);
  }
  for (const l of allLinks) pf.linkByKey.set(linkKey(l.provider, l.entity, l.external_id), l);

  const ensureClientForContact = async (contact: BackfillContact): Promise<string> => {
    const seedKey = clientSeedKey(contact.externalId);
    const cached = pf.clientBySeedKey.get(seedKey);
    if (cached) return cached.id;
    // Store double-check keeps the applier correct even against a store the
    // prefetch could not fully observe (concurrent external writer).
    const existing = await store.getInternalClientBySeedKey(seedKey);
    if (existing) {
      pf.clientBySeedKey.set(seedKey, existing);
      pf.clientById.set(existing.id, existing);
      return existing.id;
    }
    const created = await store.insertInternalClient({
      seedKey,
      displayName: contact.name ?? null,
      normalizedPhone: normalizeUSPhone(contact.phone ?? null),
      normalizedEmail: normalizeEmail(contact.email ?? null),
      ghlContactExternalId: contact.externalId,
      matchState: "auto_matched",
    });
    pf.clientBySeedKey.set(seedKey, created);
    pf.clientById.set(created.id, created);
    result.clientsCreated += 1;
    return created.id;
  };

  /** If-absent exception write with prefetch dedupe; counts only genuinely new rows. */
  const ensureException = async (
    dedupeKey: string,
    input_: Parameters<Store["insertDataMatchExceptionIfAbsent"]>[0],
  ): Promise<void> => {
    if (pf.exceptionByDedupe.has(dedupeKey)) return;
    const exc = await store.insertDataMatchExceptionIfAbsent(input_);
    pf.exceptionByDedupe.add(dedupeKey);
    if (exc.created) result.exceptionsCreated += 1;
  };

  // ---- pass A: appointments with a resolved contact (exact_id chain) ----
  // Distinct contacts first (one client + one contact link each), then one
  // appointment link per appointment — same rows the sequential applier wrote.
  const apptContactIds = [...new Set(input.appointments.filter((a) => a.contactExternalId).map((a) => a.contactExternalId!))];
  const contactByExt = new Map(input.contacts.map((c) => [c.externalId, c]));
  await mapChunk(apptContactIds, async (extId) => {
    const linkK = linkKey("highlevel", "contact", extId);
    if (!pf.linkByKey.has(linkK)) {
      const firstAppt = input.appointments.find((a) => a.contactExternalId === extId)!;
      const contact = contactByExt.get(extId);
      const clientId = await ensureClientForContact(contact ?? { externalId: extId, hasRecentCall: false });
      const contactLink = await store.insertClientMatchLinkIfAbsent({
        internalClientId: clientId,
        provider: "highlevel",
        entity: "contact",
        externalId: extId,
        matchMethod: "exact_id",
        confidence: "exact",
        resolvedBy: "auto",
        evidence: { basis: "appointments_contact_id", appointment_acuity_id: firstAppt.acuityAppointmentId },
      });
      pf.linkByKey.set(linkK, contactLink.link);
      if (contactLink.created) result.contactLinksCreated += 1;
      else result.alreadyLinked += 1;
    } else {
      result.alreadyLinked += 1;
    }
  });
  await mapChunk(
    input.appointments.filter((a) => a.contactExternalId),
    async (appt) => {
      const apptK = linkKey("acuity", "appointment", appt.acuityAppointmentId);
      if (pf.linkByKey.has(apptK)) {
        result.alreadyLinked += 1;
        return;
      }
      const contact = contactByExt.get(appt.contactExternalId!);
      const clientId = await ensureClientForContact(contact ?? { externalId: appt.contactExternalId!, hasRecentCall: false });
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
      pf.linkByKey.set(apptK, apptLink.link);
      if (apptLink.created) result.appointmentLinksCreated += 1;
      else result.alreadyLinked += 1;
    },
  );

  // ---- pass C: contacts with recent calls not yet covered ----
  // Runs BEFORE the unresolved-appointment fallback (pass B below) so an
  // appointment whose contact was never resolved can still match the client
  // created here from the same human's GHL contact (phone/email ladder).
  const candidatesC = [...pf.clientById.values()].map(candidateFromClient);
  const recentContacts = input.contacts.filter((c) => c.hasRecentCall);
  await mapChunk(recentContacts, async (contact) => {
    result.recentCallContacts += 1;
    const linkK = linkKey("highlevel", "contact", contact.externalId);
    const existingLink = pf.linkByKey.get(linkK);
    if (existingLink) {
      result.alreadyLinked += 1;
      return;
    }
    // Prefer the seed client for this contact when pass A already created it
    // (the client row itself carries this exact GHL contact id).
    const seedClient = pf.clientBySeedKey.get(clientSeedKey(contact.externalId));
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
      pf.linkByKey.set(linkK, link.link);
      if (link.created) result.contactLinksCreated += 1;
      else result.alreadyLinked += 1;
      return;
    }
    const outcome = matchIdentity(
      {
        displayName: contact.name ?? null,
        phone: contact.phone ?? null,
        email: contact.email ?? null,
        supportingPhonePrefix: (normalizeUSPhone(contact.phone ?? null) ?? "").slice(0, 7) || null,
        supportingEmailDomain: (normalizeEmail(contact.email ?? null) ?? "").split("@")[1] ?? null,
      },
      candidatesC,
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
      pf.linkByKey.set(linkK, link.link);
      if (link.created) result.fallbackLinksCreated += 1;
      else result.alreadyLinked += 1;
      return;
    }
    if (outcome.status === "ambiguous") {
      // ≥2 candidate clients on a shared phone/email — NEVER guessed.
      await ensureException(`contact-identity:hl:${contact.externalId}`, {
        kind: (outcome as { kind: MatchExceptionKind }).kind,
        dedupeKey: `contact-identity:hl:${contact.externalId}`,
        payload: {
          subject: { source: "ghl_contact", contact_external_id: contact.externalId, name: contact.name ?? null, phone: contact.phone ?? null, email: contact.email ?? null },
          candidates: outcome.candidateIds,
          tier: outcome.evidence.tier,
        },
        context: { stage: "backfill", source_table: "contacts", trigger: "recent_calls" },
      });
      return;
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
      pf.linkByKey.set(linkK, link.link);
      if (link.created) result.contactLinksCreated += 1;
      else result.alreadyLinked += 1;
      return;
    }
    // No phone, no email → name alone (or nothing at all) → exception.
    await ensureException(`contact-identity:hl:${contact.externalId}`, {
      kind: (outcome as { kind: MatchExceptionKind }).kind,
      dedupeKey: `contact-identity:hl:${contact.externalId}`,
      payload: {
        subject: { source: "ghl_contact", contact_external_id: contact.externalId, name: contact.name ?? null, phone: contact.phone ?? null, email: contact.email ?? null },
        candidates: [],
        tier: outcome.evidence.tier,
      },
      context: { stage: "backfill", source_table: "contacts", trigger: "recent_calls" },
    });
  });

  // Fresh candidate universe for pass B — passes A/C may have created clients
  // this run, and an unresolved appointment should find them (e.g. an
  // appointment whose GHL contact had no link until pass C created one).
  const candidatesB = [...pf.clientById.values()].map(candidateFromClient);

  // ---- pass B: appointments WITHOUT a resolved contact → identity fallback ----
  await mapChunk(
    input.appointments.filter((a) => !a.contactExternalId),
    async (appt) => {
      result.fallbackAppointments += 1;
      const apptK = linkKey("acuity", "appointment", appt.acuityAppointmentId);
      const existingLink = pf.linkByKey.get(apptK);
      if (existingLink) {
        result.alreadyLinked += 1; // manual resolve (or earlier pass) — sticky, never re-matched
        return;
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
        pf.linkByKey.set(apptK, link.link);
        if (link.created) result.fallbackLinksCreated += 1;
        else result.alreadyLinked += 1;
        return;
      }
      const kind = exceptionKindOf(outcome);
      if (!kind) return;
      await ensureException(`appt-identity:${appt.acuityAppointmentId}`, {
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
    },
  );

  // ---- pass D: calls that cannot reach any client — never silent ----
  await mapChunk(input.callsWithoutClient, async (call) => {
    await ensureException(`call-identity:${call.provider}:${call.externalCallId}`, {
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
  });

  return result;
}

/** True when the subject is name-only (helper reused by tests to assert the owner rule end-to-end). */
export function isNameOnlySubject(name: string | null | undefined, phone: string | null | undefined, email: string | null | undefined): boolean {
  return !!normalizeName(name) && !normalizeUSPhone(phone ?? null) && !normalizeEmail(email ?? null);
}
