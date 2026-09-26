/**
 * CALL→CONTACT RESTORATION BACKFILL (owner-ratified attribution program,
 * Session 2) — one-time, resumable, idempotent. Restores `calls.contact_id`
 * for historical call rows whose HL contact linkage was lost when the calls
 * were harvested against the old 119-contact DB (the harvest could only
 * resolve contact ids it could see at upsert time).
 *
 *   bun run scripts/call-contact-backfill.ts     (Session 3, after the
 *                                                contacts backfill completes)
 *
 * LOCALLY-DRIVEN: every resolution reads DB rows (calls, harvest_calls,
 * harvest_conversations, contacts, users, settings). HighLevel is touched
 * ONLY when a required source id is genuinely absent — the runner wires an
 * optional targeted fetch behind an explicit flag (the ledger verified to
 * carry contact_external_id for every harvested message, so live runs should
 * never need it).
 *
 * RESOLUTION HIERARCHY (owner-ratified, EXACTLY):
 *   1. direct_message_contact       — the call MESSAGE's own contactId
 *                                     (harvest_calls.contact_external_id, keyed
 *                                     by message id = calls.external_call_id).
 *   2. parent_conversation_contact  — the conversation's contactId
 *                                     (calls.conversation_id →
 *                                     harvest_conversations.contact_id).
 *   3. exact_phone                  — exact canonical-phone match against the
 *                                     contacts index (phone_normalized) using
 *                                     a source identity the record supplies.
 *   4. exact_email                  — exact canonical-email match
 *                                     (email_normalized).
 * First hit wins. NEVER overwrite an existing non-null contact_id — direct
 * source data always wins, inheritance only FILLS NULL (the store update is
 * fill-null-only AND the engine only feeds unresolved calls).
 *
 * Steps 3–4 resolve ONLY on exactly one distinct contact; multiple distinct
 * candidates (which includes the owner-stated "multiple distinct roster-rep
 * contacts" case) are recorded as method "ambiguous" with contact_id NULL —
 * never picked between. Steps 1–2 name at most one HL contact by id; when the
 * id is present but the contacts row is not yet backfilled, the call is
 * recorded "unresolved" and a later run fills it (idempotent).
 *
 * ROSTER SCOPE: rep linkage/eligibility comes from src/server/roster.ts
 * (buildRosterEligibility) — never re-implemented here. It answers "is this
 * contact linked to an active roster rep" for ambiguity detail; it never
 * changes WHICH contact a source id names.
 *
 * RESUMABILITY: progress persists under sync_checkpoints key
 * "hl_call_contact_backfill_v1" after every batch (cursor = last processed
 * call's started_at+id, plus running per-method counts). Interrupted runs
 * resume exactly; reruns are safe regardless (fill-null-only upserts).
 *
 * Purity: the engine reads the store through the Store interface and injects
 * the clock; tests run it against MemoryStore fixtures.
 */
import { normalizeEmail, normalizeUSPhone } from "../identity/normalize";
import { buildRosterEligibility, type RosterEligibility } from "../roster";
import type { CallContactBackfillUpdate, CallContactResolutionMethod, ContactRow, HarvestCallRow, Store } from "../store/types";

/** sync_checkpoints key — a NEW key, independent of the contacts backfill. */
export const CALL_CONTACT_BACKFILL_CHECKPOINT_KEY = "hl_call_contact_backfill_v1";

/** Checkpoint shape (stored as jsonb — pass the OBJECT to setSyncCheckpoint). */
export interface CallContactBackfillCheckpoint {
  /** Cursor: started_at of the last processed call (ISO), null = start. */
  lastStartedAt: string | null;
  /** Cursor: internal calls.id of the last processed call (tie-break). */
  lastCallId: string | null;
  /** True when a full pass found nothing left to process. */
  done: boolean;
  scanned: number;
  /** Calls whose contact_id was actually filled. */
  filled: number;
  byMethod: Record<CallContactResolutionMethod, number>;
  updated_at: string;
}

/** The minimal call view the engine resolves (store rows carry all of this). */
export interface BackfillCallRow {
  id: string;
  provider: string;
  external_call_id: string | null;
  conversation_id: string | null;
  contact_id: string | null;
  started_at: string;
}

/**
 * Extra source identity a targeted HL fetch may supply for a call whose ids
 * are absent from the local ledgers (phone/email never live on call rows —
 * they come from the conversation's contact record when fetched on purpose).
 */
export interface CallContactSourceIdentity {
  messageContactExternalId?: string | null;
  conversationContactExternalId?: string | null;
  phone?: string | null;
  email?: string | null;
}

/** Store plus the optional targeted-HL hook (the runner decides whether to wire it). */
export type CallContactBackfillPort = Store & {
  /** Optional targeted HighLevel fetch — used ONLY when no local source id exists. */
  fetchSourceIdentity?: (call: BackfillCallRow) => Promise<CallContactSourceIdentity | null>;
};

export interface CallContactResolution {
  call_id: string;
  contact_id: string | null;
  method: CallContactResolutionMethod;
  /** Human-readable provenance (logs/debug): which source id decided. */
  detail: string;
}

const METHOD_ORDER: CallContactResolutionMethod[] = [
  "direct_message_contact",
  "parent_conversation_contact",
  "exact_phone",
  "exact_email",
  "ambiguous",
  "unresolved",
];

export function emptyCheckpoint(updatedAt: string): CallContactBackfillCheckpoint {
  return {
    lastStartedAt: null,
    lastCallId: null,
    done: false,
    scanned: 0,
    filled: 0,
    byMethod: emptyByMethod(),
    updated_at: updatedAt,
  };
}

/** Zeroed per-method counters (a fresh chunk's result, or a fresh checkpoint). */
export function emptyByMethod(): Record<CallContactResolutionMethod, number> {
  return METHOD_ORDER.reduce((acc, m) => ({ ...acc, [m]: 0 }), {} as Record<CallContactResolutionMethod, number>);
}

/**
 * Defensive checkpoint parse (the contacts-backfill lesson: a double-encoded
 * jsonb string must never crash the runner). Accepts both encodings; a shape
 * without a cursor is treated as corrupt → null (restart from the beginning;
 * fill-null-only makes that safe, just slower).
 */
export function parseCallContactCheckpoint(v: string | null): CallContactBackfillCheckpoint | null {
  if (!v) return null;
  let out: unknown = v;
  try {
    out = JSON.parse(v);
  } catch {
    return null;
  }
  if (typeof out === "string") {
    try {
      out = JSON.parse(out);
    } catch {
      return null;
    }
  }
  const cp = out as CallContactBackfillCheckpoint;
  if (!cp || typeof cp !== "object" || (cp.lastStartedAt == null && cp.lastCallId == null && !cp.done)) return null;
  return {
    ...cp,
    byMethod: { ...emptyCheckpoint(cp.updated_at ?? "").byMethod, ...(cp.byMethod ?? {}) },
  };
}

// ---------- the resolution hierarchy (pure, per call) ----------

export interface ResolveInputs {
  call: BackfillCallRow;
  /** Ledger row keyed by the call's message id (direct tier). */
  ledger?: HarvestCallRow | null;
  /** Conversation ledger row keyed by the call's conversation id (parent tier). */
  conversationContactExternalId?: string | null;
  /** Result of the OPTIONAL targeted HL fetch (only wired when ledgers miss). */
  fetched?: CallContactSourceIdentity | null;
  /** HL external contact id → internal contacts row (provider highlevel). */
  contactByExternalId: Map<string, ContactRow>;
  /** Canonical phone → contacts (phone_normalized index). */
  contactByPhone: Map<string, ContactRow[]>;
  /** Canonical email → contacts (email_normalized index). */
  contactByEmail: Map<string, ContactRow[]>;
  /** Roster eligibility (roster.ts) — for ambiguity detail only. */
  elig: RosterEligibility;
}

/** Roster-rep linkage of one contact: assigned_rep_id when it is an active roster member. */
export function contactRosterRep(contact: ContactRow | undefined, elig: RosterEligibility): string | null {
  const rep = contact?.assigned_rep_id ?? null;
  return rep != null && elig.activeIds.has(rep) ? rep : null;
}

export function resolveCallContact(inputs: ResolveInputs): CallContactResolution {
  const { call, contactByExternalId, contactByPhone, contactByEmail, elig } = inputs;

  // ---- Tier 1: the call MESSAGE's own contactId (direct source data) ----
  const messageContactExternalId =
    inputs.ledger?.contact_external_id ?? inputs.fetched?.messageContactExternalId ?? null;
  if (messageContactExternalId) {
    const contact = contactByExternalId.get(messageContactExternalId);
    if (contact) {
      return { call_id: call.id, contact_id: contact.id, method: "direct_message_contact", detail: `message contactId ${messageContactExternalId}` };
    }
    // Source id present but the contacts row is not backfilled yet — an
    // honest "unresolved"; a later run (contacts complete) fills it.
    return { call_id: call.id, contact_id: null, method: "unresolved", detail: `message contactId ${messageContactExternalId} not in contacts yet` };
  }

  // ---- Tier 2: the PARENT CONVERSATION's contactId (ledger join) ----
  const conversationContactExternalId =
    inputs.conversationContactExternalId ?? inputs.fetched?.conversationContactExternalId ?? null;
  if (conversationContactExternalId) {
    const contact = contactByExternalId.get(conversationContactExternalId);
    if (contact) {
      return { call_id: call.id, contact_id: contact.id, method: "parent_conversation_contact", detail: `conversation contactId ${conversationContactExternalId}` };
    }
    return { call_id: call.id, contact_id: null, method: "unresolved", detail: `conversation contactId ${conversationContactExternalId} not in contacts yet` };
  }

  // ---- Tier 3: exact canonical-phone match ----
  const phone = normalizeUSPhone(inputs.fetched?.phone ?? null);
  if (phone) {
    const hits = contactByPhone.get(phone) ?? [];
    const distinct = [...new Map(hits.map((c) => [c.id, c])).values()];
    if (distinct.length === 1) {
      return { call_id: call.id, contact_id: distinct[0].id, method: "exact_phone", detail: `phone ${phone} → 1 contact` };
    }
    if (distinct.length > 1) {
      const reps = [...new Set(distinct.map((c) => contactRosterRep(c, elig)).filter((r): r is string => r != null))];
      return {
        call_id: call.id,
        contact_id: null,
        method: "ambiguous",
        detail: `phone ${phone} matches ${distinct.length} distinct contacts (${reps.length} roster-rep)`,
      };
    }
  }

  // ---- Tier 4: exact canonical-email match ----
  const email = normalizeEmail(inputs.fetched?.email ?? null);
  if (email) {
    const hits = contactByEmail.get(email) ?? [];
    const distinct = [...new Map(hits.map((c) => [c.id, c])).values()];
    if (distinct.length === 1) {
      return { call_id: call.id, contact_id: distinct[0].id, method: "exact_email", detail: `email ${email} → 1 contact` };
    }
    if (distinct.length > 1) {
      const reps = [...new Set(distinct.map((c) => contactRosterRep(c, elig)).filter((r): r is string => r != null))];
      return {
        call_id: call.id,
        contact_id: null,
        method: "ambiguous",
        detail: `email ${email} matches ${distinct.length} distinct contacts (${reps.length} roster-rep)`,
      };
    }
  }

  return { call_id: call.id, contact_id: null, method: "unresolved", detail: "no usable source identity" };
}

// ---------- the chunk runner ----------

export interface CallContactBackfillChunkResult {
  /** Calls examined in this chunk. */
  scanned: number;
  /** Calls whose contact_id was actually filled. */
  filled: number;
  /** THIS CHUNK's resolutions per method (per-chunk, like scanned/filled —
   * the running totals live on checkpoint.byMethod). */
  byMethod: Record<CallContactResolutionMethod, number>;
  /** True when a full pass over unresolved calls found nothing left. */
  done: boolean;
  checkpoint: CallContactBackfillCheckpoint;
}

export interface CallContactBackfillChunkOpts {
  store: CallContactBackfillPort;
  /** Calls examined per batch (default 200). */
  batchSize?: number;
  /** Resume from this checkpoint instead of the stored one (tests). */
  checkpoint?: CallContactBackfillCheckpoint | null;
  /** Skip reading/writing sync_checkpoints (tests drive the checkpoint). */
  persistCheckpoint?: boolean;
  log?: (line: string) => void;
  now?: () => Date;
}

/**
 * Process ONE batch of contact-less calls, oldest first, and persist the
 * verdicts fill-null-only. Returns the running checkpoint (persisted under
 * CALL_CONTACT_BACKFILL_CHECKPOINT_KEY unless persistCheckpoint = false).
 */
export async function runCallContactBackfillChunk(opts: CallContactBackfillChunkOpts): Promise<CallContactBackfillChunkResult> {
  const { store } = opts;
  const batchSize = opts.batchSize ?? 200;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});

  const prior = opts.checkpoint !== undefined ? opts.checkpoint : parseCallContactCheckpoint(await store.getSyncCheckpoint(CALL_CONTACT_BACKFILL_CHECKPOINT_KEY));
  const cp: CallContactBackfillCheckpoint =
    prior ?? emptyCheckpoint(now().toISOString());

  // Unresolved calls after the cursor, oldest first (deterministic order).
  const allCalls = (await store.getAllCallsSince("1970-01-01T00:00:00.000Z")) as (BackfillCallRow & { provider: string })[];
  const unresolved = allCalls
    .filter((c) => c.contact_id == null)
    .sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let startIdx = 0;
  if (cp.lastStartedAt) {
    startIdx = unresolved.findIndex((c) => c.started_at === cp.lastStartedAt && c.id === cp.lastCallId);
    startIdx = startIdx === -1 ? 0 : startIdx + 1;
  }
  const batch = unresolved.slice(startIdx, startIdx + batchSize);
  const done = startIdx + batch.length >= unresolved.length;

  if (batch.length === 0) {
    cp.done = true;
    cp.updated_at = now().toISOString();
    if (opts.persistCheckpoint !== false) {
      await store.setSyncCheckpoint(CALL_CONTACT_BACKFILL_CHECKPOINT_KEY, JSON.stringify(cp));
    }
    return { scanned: 0, filled: 0, byMethod: emptyByMethod(), done: true, checkpoint: cp };
  }

  // Contacts index (canonical keys — the same normalizers the boundaries store through).
  const contacts = await store.getContacts();
  const contactByExternalId = new Map<string, ContactRow>();
  const contactByPhone = new Map<string, ContactRow[]>();
  const contactByEmail = new Map<string, ContactRow[]>();
  for (const c of contacts) {
    if (c.provider === "highlevel" && c.external_id) contactByExternalId.set(c.external_id, c);
    const p = c.phone_normalized ?? normalizeUSPhone(c.phone);
    if (p) {
      const list = contactByPhone.get(p) ?? [];
      if (!list.some((x) => x.id === c.id)) list.push(c);
      contactByPhone.set(p, list);
    }
    const e = c.email_normalized ?? normalizeEmail(c.email);
    if (e) {
      const list = contactByEmail.get(e) ?? [];
      if (!list.some((x) => x.id === c.id)) list.push(c);
      contactByEmail.set(e, list);
    }
  }

  // Roster eligibility via the ONE machinery (roster.ts).
  const settings = await store.getSettings();
  const users = await store.getAllUsers();
  const elig = buildRosterEligibility(users, settings.rep_mappings ?? []);

  // Source ledgers, batched.
  const messageIds = batch.map((c) => c.external_call_id).filter((x): x is string => !!x);
  const ledgerRows = await store.getHarvestCallsByMessageIds(messageIds);
  const ledgerByMessage = new Map(ledgerRows.map((r) => [r.message_id, r]));
  const convIds = [...new Set(batch.map((c) => c.conversation_id).filter((x): x is string => !!x))];
  const convRows = await store.getHarvestConversationsByIds(convIds);
  const convContactByConv = new Map(convRows.filter((r) => r.contact_id).map((r) => [r.conv_id, r.contact_id as string]));

  const updates: CallContactBackfillUpdate[] = [];
  let filled = 0;
  const chunkByMethod = emptyByMethod();
  for (const call of batch) {
    const ledger = call.external_call_id ? ledgerByMessage.get(call.external_call_id) ?? null : null;
    let fetched: CallContactSourceIdentity | null = null;
    const haveSourceId =
      (ledger?.contact_external_id != null) ||
      (call.conversation_id != null && convContactByConv.has(call.conversation_id));
    if (!haveSourceId && store.fetchSourceIdentity) {
      fetched = await store.fetchSourceIdentity(call);
    }
    const resolution = resolveCallContact({
      call,
      ledger,
      conversationContactExternalId: call.conversation_id ? convContactByConv.get(call.conversation_id) ?? null : null,
      fetched,
      contactByExternalId,
      contactByPhone,
      contactByEmail,
      elig,
    });
    log(`call ${call.external_call_id ?? call.id}: ${resolution.method}${resolution.contact_id ? ` → ${resolution.contact_id}` : ""} (${resolution.detail})`);
    updates.push({
      call_id: call.id,
      contact_id: resolution.contact_id,
      resolution_method: resolution.method,
      contact_resolved_at: now().toISOString(),
    });
    chunkByMethod[resolution.method] = (chunkByMethod[resolution.method] ?? 0) + 1;
    if (resolution.contact_id) filled += 1;
  }

  // Fill-null-only verdicts (store enforces the guarantee too — belt and braces).
  await store.applyCallContactBackfill(updates);

  const last = batch[batch.length - 1];
  cp.lastStartedAt = last.started_at;
  cp.lastCallId = last.id;
  cp.scanned += batch.length;
  cp.filled += filled;
  for (const m of METHOD_ORDER) cp.byMethod[m] = (cp.byMethod[m] ?? 0) + (chunkByMethod[m] ?? 0);
  cp.done = done;
  cp.updated_at = now().toISOString();
  if (opts.persistCheckpoint !== false) {
    // Pass the JSON STRING (the store casts ::jsonb — the double-encoding
    // lesson lives in parseCallContactCheckpoint).
    await store.setSyncCheckpoint(CALL_CONTACT_BACKFILL_CHECKPOINT_KEY, JSON.stringify(cp));
  }

  return { scanned: batch.length, filled, byMethod: { ...chunkByMethod }, done, checkpoint: cp };
}
