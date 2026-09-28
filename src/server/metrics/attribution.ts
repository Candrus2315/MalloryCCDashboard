/**
 * THE BOOKING ATTRIBUTION ENGINE — one pure definition of "which HighLevel
 * call produced this Acuity booking" (docs/SPEC.md §BOOKING ATTRIBUTION).
 *
 *   matchAppointmentsToCalls(appointments, calls, contacts, settings, { today })
 *
 * Owner spec, verbatim: "Acuity bookings matched to HighLevel calls by contact
 * ID → phone → email, counting only calls over the meaningful-call threshold
 * within the attribution window; most recent qualifying call wins; unclear
 * matches go to an Unattributed queue for manual assignment — never silently
 * guessed."
 *
 * Matching chain (first match wins — the first tier that yields a qualifying
 * call decides):
 *   (a) contact id   — the appointment's stored contact_id equals the call's
 *       contact_id (the contacts table links the HL contact id ↔ email/phone).
 *   (b) phone        — the appointment's normalized phone resolves to exactly
 *       one contact; that contact's calls are the candidates.
 *   (c) email        — same, by normalized email.
 *
 * IDENTITY NORMALIZATION (owner-ratified attribution program, Session 2): the
 * ONE canonical pair of normalizers lives in src/server/identity/normalize.ts
 * and is used on BOTH sides of every Acuity↔HL comparison — a HighLevel
 * "+15088891019" and an Acuity "5088891019" normalize to the same key
 * (11-digit leading-1 dropped, 10-digit kept, emails trimmed+lowercased).
 * No fuzzy name matching anywhere; a value that matches multiple contacts is
 * ambiguous, never guessed.
 *
 * ATTRIBUTION WINDOW — DATE GRANULARITY (owner-ratified 2026-09-26; replaces
 * the old exact-24h rule): a qualifying call must have its call DATE (ET) equal
 * to the booking's CREATION date (ET) or the immediately preceding calendar
 * date. Reasons (owner directive):
 *   - Acuity dateCreated is DATE-ONLY: the intra-day ORDER of call vs booking
 *     is NOT known, so a call later on the creation date itself still qualifies
 *     and the scheduled session date is NEVER used as the anchor;
 *   - all date math is America/New_York (date-logic.ts), midnight crossings
 *     included.
 * S7c (owner directive 2026-09-28): the anchor is now the AUTHORITATIVE ET
 * BUSINESS DATE (created_business_date) the sync derives from Acuity's full
 * `datetimeCreated` (ISO 8601 with offset → the true instant → ET), falling
 * back to the dateCreated CALENDAR DATE for date-only rows — the window is
 * [created_business_date − 1, created_business_date] exactly, no longer
 * inferred from how the created_at instant happened to be encoded. The
 * created_at fallbacks below remain for legacy rows without the column.
 * A legacy row with no created_at falls back to the session datetime and the
 * match is MARKED `anchoredOn: "session-fallback"` — visible, never silent.
 *
 * Constraints on every candidate call:
 *   - duration_seconds is a real number STRICTLY GREATER than
 *     settings.meeting_threshold_seconds (null/0/voicemail-duration never
 *     qualifies — an unknown length is never counted as meaningful);
 *   - the call's ET date ∈ {creation date − 1, creation date} (see above);
 *   - among qualifying candidates the MOST RECENT started_at wins (tie broken
 *     deterministically by external_call_id so re-runs are stable).
 *
 * AMBIGUITY RULE (the "never silently guessed" clause):
 *   1. A phone or email identity that resolves to MULTIPLE DISTINCT contacts is
 *      ambiguous at its tier — the engine stops there and reports
 *      reason "ambiguous". It does NOT fall through to a weaker tier: picking
 *      the email match when the stronger phone evidence names two different
 *      people would be exactly the guess the SPEC forbids.
 *   2. The chosen match is additionally cross-checked: if a STRONGER tier's
 *      identity resolves unambiguously to a DIFFERENT contact than the chosen
 *      one and that contact also has a qualifying call, the evidence
 *      contradicts itself → "ambiguous".
 *   3. MULTI-REP (Session 2): when the matched contact's qualifying calls
 *      within the window come from MULTIPLE DISTINCT roster reps (resolved
 *      through the ONE roster-eligibility machinery, src/server/roster.ts) and
 *      no deterministic rule resolves ownership, the booking is ambiguous and
 *      routes to the manual attribution queue — a most-recent pick would be a
 *      silent choice made to raise coverage. Deterministic single-rep cases
 *      attribute normally.
 *   Everything ambiguous lands in the Unattributed queue with a reason string
 *   that says WHY — visible and auditable, ready for manual assignment.
 *
 * RULE B (owner-approved 2026-09-28): the ONE deterministic exception to the
 * stored-contact/email conflict above. When the STORED contact is a
 * junk/shared record (appointments stored against it carry ≥2 distinct client
 * emails — computeJunkContactIds) and the booking's email resolves via EXACT
 * case-insensitive equality to exactly one NON-junk contact, the booking's
 * identity resolves through the email-matched contact and attribution runs
 * under the UNCHANGED s1 rules (same window, most-recent verified roster
 * interaction, no all-time fallback, no fuzzy matching). Guards: multi-email
 * matches never resolve; a non-roster owner on the resolved contact queues the
 * row for manual assignment under reason_code "email-resolves-non-roster"; a
 * junk RESOLVED contact is never resolved onto; manual_override rows are never
 * re-processed. Resolved rows carry an "identity-resolved-via-email" audit
 * note.
 *
 * Rep identity flows through the EXISTING roster-eligibility machinery
 * (src/server/roster.ts — applyAttributionEligibility; NEVER re-implemented
 * here): the winning call's rep is resolved at query time through
 * buildRosterEligibility + the settings' rep_mappings. Source rows are never
 * mutated — mapped eligibility produces fresh result objects only.
 *
 * Purity: imports TYPES, date-logic and the roster pure functions only — no
 * runtime store, no fetch, no clock (the caller passes today).
 */
import type { AppSettings } from "../store/types";
import { normalizeEmail, normalizeUSPhone } from "../identity/normalize";
import { addDays, etDateStrFromInstant } from "../date-logic";
import {
  buildRosterEligibility,
  applyAttributionEligibility,
  eligibleRepId,
  type RosterEligibility,
} from "../roster";

// Canonical identity normalizers re-exported under the engine's historical
// names (callers keep compiling; the DEFINITION is the canonical one — the
// divergent engine-local versions were removed in Session 2).
export const normalizeAttributionEmail = normalizeEmail;
export const normalizeAttributionPhone = normalizeUSPhone;

/**
 * Phone EQUALITY after canonical normalization: "+15088891019" and
 * "5088891019" are the same number (the canonical normalizer drops the
 * leading 1). Exact digit equality otherwise — no looser matching, so two
 * genuinely different numbers can never collide.
 */
export function phonesEqual(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const na = normalizeUSPhone(a);
  const nb = normalizeUSPhone(b);
  return na != null && na === nb;
}

// ---------- input shapes (structural — call sites pass store rows directly) ----------

/** Minimal appointment view the engine needs (appointments table + client fields). */
export interface AttributionAppointment {
  /** Internal appointments.id — returned verbatim as `appointmentId`. */
  id: string;
  contact_id: string | null;
  /** Normalized at sync via the CANONICAL normalizer — digits, leading 1 dropped. */
  client_phone?: string | null;
  /** Normalized at sync (lowercase-trimmed) or null. */
  client_email?: string | null;
  /** ISO UTC session time. */
  appointment_datetime: string;
  /**
   * Booking-MADE time — the window anchor. Acuity dateCreated is DATE-ONLY;
   * the parser encodes that as exactly UTC midnight, which this engine reads
   * back as a calendar date (never as an ET instant). Falls back to the
   * session datetime only for legacy rows without one (marked in the result).
   */
  created_at?: string;
  /**
   * S7c AUTHORITATIVE ANCHOR (owner directive 2026-09-28): the booking's
   * creation BUSINESS DATE in America/New_York (created_at → ET, or the
   * dateCreated CALENDAR DATE for date-only rows). Preferred over every
   * created_at encoding when present — the window math becomes exact instead
   * of inferring the date from how the instant was stored.
   */
  created_business_date?: string | null;
  cancelled?: boolean;
  status?: string;
}

/** Minimal call view (calls table row; external_call_id is the HL message id). */
export interface AttributionCall {
  /** Internal calls.id — the eligibility machinery's join key. */
  id?: string;
  /** HighLevel call id — returned as `callExternalId`. */
  external_call_id: string;
  rep_id: string | null;
  /** RAW HL userId preserved verbatim (mapping-driven eligibility reads it). */
  provider_rep_external_id?: string | null;
  contact_id: string | null;
  /** ISO UTC. */
  started_at: string;
  /** null/NaN/0 = unknown or voicemail-length — never qualifies. */
  duration_seconds: number | null;
}

/** Minimal contact view (contacts table; the HL id ↔ email/phone linkage). */
export interface AttributionContact {
  id: string;
  phone?: string | null;
  email?: string | null;
  /** HL contact id — links s1 harvest interactions to this contact. */
  external_id?: string | null;
  /**
   * RULE B guard (b): the contact's stored OWNER (contacts.assigned_rep_id, an
   * internal user id). Read ONLY to decide whether the email-resolved contact
   * is owned by an ACTIVE ROSTER rep — never as an attribution source in
   * itself (ownership still flows exclusively through the s1 evidence rules).
   */
  assigned_rep_id?: string | null;
}

// ---------- output ----------

export type AttributionMethod = "contact_id" | "phone" | "email" | "window_interaction";

/**
 * ONE s1 window interaction (owner-frozen s1 rule, 2026-09-27): a VERIFIED
 * ROSTER-REP interaction — a normalized call (rep resolved through the roster
 * machinery) or a harvested conversation call message whose parent
 * conversation is owned by an active roster user. Duration is IRRELEVANT for
 * OWNERSHIP (a 30-second dial is workflow evidence); the >120s threshold
 * lives ONLY in the "Bookings From Calls >2 Minutes" metric. The caller
 * pre-resolves rep_id (the caller owns roster truth — same convention as the
 * engine's users option); rows without a resolved rep are NOT evidence.
 */
export interface AttributionHarvestInteraction {
  /** HL message id (stable audit evidence id). */
  id: string;
  /** HL contact id — linked to candidates through contacts.external_id. */
  contact_external_id: string | null;
  /** Resolved roster rep (internal user id) or null (not verified evidence). */
  rep_id: string | null;
  /** ISO UTC. */
  started_at: string;
  /** Any value (including null/0) qualifies for OWNERSHIP. */
  duration_seconds: number | null;
}

/** Audit/debug record of the window the match was evaluated against. */
export interface WindowMarker {
  /** First (earliest) ET calendar date whose calls qualify. */
  from: string;
  /** Last ET calendar date whose calls qualify (the booking's creation date). */
  to: string;
  /** Fixed marker: the window is DATE-GRANULARITY, not exact-hours. */
  marker: "date_granularity_window";
  /**
   * Which row supplied the anchor: the authoritative ET business date
   * (created_business_date, S7c), the stored created_at instant/date encoding,
   * or a legacy session fallback.
   */
  anchoredOn: "created_business_date" | "created_at" | "session-fallback";
}

export interface AttributionMatch {
  appointmentId: string;
  status: "attributed" | "unattributed";
  /** HL call id of the winning call (attributed only). */
  callExternalId?: string;
  /** Eligible rep for the winning call (roster member or mapping-resolved). */
  repId?: string | null;
  /**
   * Unattributed reason: "no-contact-identity" (the appointment carries no
   * contact id, phone or email at all), "ambiguous" (identity evidence
   * conflicts, names multiple people, or the qualifying calls span multiple
   * roster reps — manual assignment required), "no-qualifying-call" (identity
   * known but no call over threshold within the window dates before the
   * booking), "bad-datetime" (unparseable creation/session time — never
   * guessed against a broken anchor).
   */
  reason?: string;
  /**
   * S4b REFINED NO-REP CLASSIFICATION — WHY no rep could be determined, as an
   * honest category derived ONLY from signals the engine already computed.
   * Present on UNATTRIBUTED matches only (never attributed, never ambiguous —
   * ambiguous keeps its identity-conflict detail). One of:
   *   - "no-window-interaction"       identity resolved to contact(s), but the
   *     attribution window contains NO interaction of any kind for them (no
   *     call, no harvested conversation message) — the team never touched
   *     this client inside the window;
   *   - "interaction-without-roster-rep"  in-window activity EXISTS (a call of
   *     any duration and/or a harvested message touching the candidate
   *     contacts) but none of it resolves to a VERIFIED ROSTER rep (inactive/
   *     non-roster HL user, unmapped) — and no >threshold call with a
   *     resolvable rep qualified. The work happened; the owner is unknown;
   *   - "no-matching-contact"         the booking carries phone/email but no
   *     contact record matches either (and there is no stored contact id) —
   *     identity cannot be tied to a contact to hang evidence on;
   *   - "no-contact-identity" / "bad-datetime" — the same cases as `reason`,
   *     restated as the category for grouped queue counts.
   * Persisted to booking_attributions.reason_code by the sync wiring (v3
   * writer) — triage-groupable, without overloading the audit note.
   */
  noRepReason?: string;
  /** Evidence tier that produced an attribution (attributed only). */
  method?: AttributionMethod;
  /**
   * Ambiguity evidence detail (auditable; feeds the manual-assignment queue):
   * which identity conflicted and how. Never present on attributed rows.
   */
  detail?: string;
  /**
   * s1 evidence audit (window_interaction rows only): the exact interaction
   * that owns the booking — id, source table, start, duration. Persisted in
   * the attribution row's note by the sync wiring, so every s1 ownership is
   * auditable without re-deriving.
   */
  evidence?: {
    id: string;
    source: "calls" | "harvest";
    started_at: string;
    duration_seconds: number | null;
  };
  /**
   * Audit/debug: the exact window dates the match was evaluated against plus
   * the date_granularity_window marker (the limitation is persisted on the
   * attribution row by the sync wiring — never re-derived ad hoc).
   */
  window?: WindowMarker;
  /**
   * RULE B (owner-approved 2026-09-28) — the booking's identity was RESOLVED
   * through an exact email match away from a junk/shared stored contact.
   * Persisted by the sync wiring as an `identity-resolved-via-email` note
   * segment (junk stored contact id + resolved contact id) so the owner can
   * audit every auto-resolution on the Audit page. Present on matches that
   * went through the resolution path AND received a verdict; the guard-(b)
   * manual-queue rows instead carry the distinct reason_code
   * "email-resolves-non-roster" (plus the same ids in their note).
   */
  emailResolution?: {
    storedContactId: string;
    resolvedContactId: string;
  };
  /**
   * DISTINCT queue reason_code override (RULE B guard b): the manual-queue
   * rows the rule routes stay visible in Settings under
   * "email-resolves-non-roster" instead of the generic "ambiguous". The sync
   * wiring persists this verbatim to booking_attributions.reason_code.
   */
  reasonCode?: string;
}

// ---------- window math (ET date granularity — owner-ratified 2026-09-26) ----------

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The booking's CREATION date (ET, YYYY-MM-DD) for the window anchor.
 *
 * S7c (owner directive 2026-09-28): `created_business_date` — the ingestion
 * layer's authoritative ET business date (created_at → America/New_York, or
 * the dateCreated CALENDAR DATE for date-only rows) — is THE anchor when
 * present; the window math no longer infers the date from the created_at
 * encoding. Legacy rows without the column fall back to the pre-S7c logic:
 * date-only encodings (created_at at exactly UTC midnight) stay calendar
 * dates, real timestamps become their ET calendar date. Never uses the
 * scheduled session date while a creation time exists; returns null only when
 * nothing is parseable.
 */
export function bookingCreationDateEt(appt: {
  created_at?: string | null;
  created_business_date?: string | null;
  appointment_datetime?: string | null;
}): { date: string; anchoredOn: "created_business_date" | "created_at" | "session-fallback" } | null {
  const tryParse = (raw: string): string | null => {
    if (DATE_ONLY_RE.test(raw)) return raw; // already a calendar date
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) return null;
    const iso = new Date(ms).toISOString();
    if (iso.endsWith("T00:00:00.000Z")) {
      // Date-only encoding (Acuity dateCreated): keep the calendar date the
      // source meant instead of converting UTC midnight into the previous ET day.
      return iso.slice(0, 10);
    }
    return etDateStrFromInstant(ms);
  };
  if (appt.created_business_date && DATE_ONLY_RE.test(appt.created_business_date)) {
    return { date: appt.created_business_date, anchoredOn: "created_business_date" };
  }
  if (appt.created_at) {
    const d = tryParse(appt.created_at);
    if (d) return { date: d, anchoredOn: "created_at" };
  }
  if (appt.appointment_datetime) {
    const d = tryParse(appt.appointment_datetime);
    if (d) return { date: d, anchoredOn: "session-fallback" };
  }
  return null;
}

/** The ET dates whose calls can qualify for a booking created on `date`. */
export function attributionWindowDates(date: string): { from: string; to: string } {
  return { from: addDays(date, -1), to: date };
}

/** The ET calendar date of one call (unparseable → null — never qualifies). */
export function callDateEt(startedAt: string): string | null {
  const ms = Date.parse(startedAt);
  return Number.isFinite(ms) ? etDateStrFromInstant(ms) : null;
}

// ---------- engine ----------

/** Identity-tier candidate union: dedup, drop empties (stable order). */
function unionCandidates(...ids: Array<string | null>): string[] {
  const out: string[] = [];
  for (const id of ids) if (id && !out.includes(id)) out.push(id);
  return out;
}

/**
 * RULE B (owner-approved 2026-09-28) — JUNK/SHARED CONTACT DETECTION.
 *
 * A contact record is a junk/shared record when the appointments STORED
 * against it carry TWO OR MORE DISTINCT client emails — one contact record
 * cannot be several different clients, so the link is source-side garbage
 * (the HighLevel/Acuity shared-record defect: many clients all landing on one
 * contact). COMputed from the current appointment set the engine evaluates —
 * never hardcoded, so future junk records are caught automatically.
 *
 * Distinctness is EXACT case-insensitive email equality (the canonical
 * normalizer) — "A@x.com" and "a@x.com" are ONE email, not two. Appointments
 * with no email contribute nothing. The junk set gates ONLY the Rule B email
 * resolution; every other tier behaves exactly as before.
 */
export function computeJunkContactIds(
  appointments: Array<{ contact_id?: string | null; client_email?: string | null }>,
): Set<string> {
  const emailsByContact = new Map<string, Set<string>>();
  for (const a of appointments) {
    const cid = (a.contact_id ?? "").trim();
    const email = normalizeEmail(a.client_email);
    if (!cid || !email) continue;
    let set = emailsByContact.get(cid);
    if (!set) {
      set = new Set();
      emailsByContact.set(cid, set);
    }
    set.add(email);
  }
  const junk = new Set<string>();
  for (const [cid, emails] of emailsByContact) {
    if (emails.size >= 2) junk.add(cid);
  }
  return junk;
}

export interface AttributionSettings {
  meeting_threshold_seconds: number;
  /**
   * LEGACY (kept for signature stability): the old exact-hours window. The
   * owner-ratified 2026-09-26 rule is DATE GRANULARITY (see header) and no
   * longer derives the window from this value; the field stays in settings
   * for UI compatibility.
   */
  attribution_window_hours: number;
  rep_mappings?: AppSettings["rep_mappings"];
}

export interface AttributionOptions {
  /**
   * ET calendar date the evaluation runs for (date-logic convention).
   * Accepted for signature stability with the scheduler wiring; the pure
   * matching math is anchored on each appointment's own creation date, never
   * on wall-clock. Defaults to etToday().
   */
  today?: string;
  /**
   * User rows for roster eligibility (active roster + rep_mappings). When
   * omitted, every rep_id present on the calls is treated as active — the
   * engine stays pure and the CALLER owns roster truth (the wiring passes
   * store.getAllUsers()).
   */
  users?: { id: string; is_active: boolean }[];
  /**
   * s1 window interactions harvested from the HL conversation ledger
   * (harvest_calls; parent-conversation user ownership). The caller
   * pre-resolves rep_id through the roster machinery and passes ONLY rows it
   * could resolve — the engine treats a non-null rep_id as a VERIFIED
   * ROSTER-REP interaction. Pure input: the engine never fetches.
   */
  s1Interactions?: AttributionHarvestInteraction[];
}

interface Candidate {
  call: AttributionCall;
  startMs: number;
}

function qualifyingCandidates(
  calls: AttributionCall[],
  window: { from: string; to: string },
  settings: AttributionSettings,
): Candidate[] {
  const threshold = settings.meeting_threshold_seconds;
  const out: Candidate[] = [];
  for (const call of calls) {
    const dur = call.duration_seconds;
    // STRICTLY over the threshold; null/NaN (voicemail/unknown length) never qualifies.
    if (typeof dur !== "number" || !Number.isFinite(dur) || dur <= threshold) continue;
    const day = callDateEt(call.started_at);
    // DATE-GRANULARITY window: the call's ET date must equal the booking's
    // creation date or the immediately preceding one. A call on any earlier
    // (or later) date is out; intra-day order is unknowable and never assumed.
    if (!day || day < window.from || day > window.to) continue;
    out.push({ call, startMs: Date.parse(call.started_at) });
  }
  return out;
}

/** Most recent qualifying call wins; deterministic tie-break by HL call id. */
function pickWinner(candidates: Candidate[]): AttributionCall | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  for (const c of candidates.slice(1)) {
    if (c.startMs > best.startMs) best = c;
    else if (c.startMs === best.startMs && c.call.external_call_id > best.call.external_call_id) best = c;
  }
  return best.call;
}

export function matchAppointmentsToCalls(
  appointments: AttributionAppointment[],
  calls: AttributionCall[],
  contacts: AttributionContact[],
  settings: AttributionSettings,
  options: AttributionOptions = {},
): AttributionMatch[] {
  // today anchors NOTHING in the matching math (each appointment is its own
  // anchor) — accepted + documented for the wiring seam's signature stability.
  void options.today;

  // Roster eligibility through the ONE existing machinery (roster.ts) —
  // mapping-driven rep resolution at query time, source rows immutable.
  const users =
    options.users ??
    [...new Set(calls.map((c) => c.rep_id).filter((r): r is string => r != null && r.length > 0))].map((id) => ({
      id,
      is_active: true,
    }));
  const elig: RosterEligibility = buildRosterEligibility(users, settings.rep_mappings ?? []);
  const eligibleCalls = calls.map((c) => ({
    id: c.id ?? c.external_call_id,
    provider_rep_external_id: c.provider_rep_external_id ?? null,
  }));

  // Identity indexes over the contacts table (CANONICAL normalization — the
  // same normalizer both sync boundaries store through, so a "+1"-prefixed HL
  // value and a 10-digit Acuity value land on one key).
  const byPhone = new Map<string, string[]>(); // canonical phone → distinct contact ids
  const byEmail = new Map<string, string[]>();
  for (const c of contacts) {
    const phone = normalizeUSPhone(c.phone);
    if (phone) {
      const list = byPhone.get(phone) ?? [];
      if (!list.includes(c.id)) list.push(c.id);
      byPhone.set(phone, list);
    }
    const email = normalizeEmail(c.email);
    if (email) {
      const list = byEmail.get(email) ?? [];
      if (!list.includes(c.id)) list.push(c.id);
      byEmail.set(email, list);
    }
  }

  const repFor = (winner: AttributionCall): string | null => {
    const pseudo = {
      id: "pseudo",
      appointment_id: "pseudo",
      call_id: winner.id ?? winner.external_call_id,
      rep_id: winner.rep_id,
      method: "engine",
      confidence: 1,
      manual_override: false,
    };
    const [applied] = applyAttributionEligibility([pseudo], eligibleCalls, elig);
    return applied.rep_id;
  };

  // ---- s1 evidence indexes (built once over the call set) ----
  // Calls grouped by contact (ANY duration is s1-eligible) and harvest
  // interactions grouped by HL contact id. Harvest rows are pre-resolved by
  // the caller: a row without rep_id is not verified roster evidence and is
  // dropped here.
  const callsByContact = new Map<string, AttributionCall[]>();
  for (const c of calls) {
    if (!c.contact_id) continue;
    const list = callsByContact.get(c.contact_id);
    if (list) list.push(c);
    else callsByContact.set(c.contact_id, [c]);
  }
  const harvestByContactExt = new Map<string, AttributionHarvestInteraction[]>();
  // S4b: UNRESOLVED harvest rows (contact known, HL user not a verified roster
  // rep) are kept in a parallel index — NOT evidence, but proof that
  // in-window interaction happened whose owner the engine cannot determine
  // (the "interaction-without-roster-rep" triage category).
  const harvestUnresolvedByContactExt = new Map<string, AttributionHarvestInteraction[]>();
  for (const h of options.s1Interactions ?? []) {
    if (!h.contact_external_id) continue;
    if (h.rep_id) {
      const list = harvestByContactExt.get(h.contact_external_id);
      if (list) list.push(h);
      else harvestByContactExt.set(h.contact_external_id, [h]);
    } else {
      const list = harvestUnresolvedByContactExt.get(h.contact_external_id);
      if (list) list.push(h);
      else harvestUnresolvedByContactExt.set(h.contact_external_id, [h]);
    }
  }
  const contactExtById = new Map(contacts.map((c) => [c.id, c.external_id ?? null]));

  // RULE B indexes: the junk/shared contact set (computed from the current
  // appointment set — see computeJunkContactIds) and each contact's stored
  // OWNER, read only for the guard-(b) active-roster check.
  const junkContactIds = computeJunkContactIds(appointments);
  const ownerByContactId = new Map(contacts.map((c) => [c.id, c.assigned_rep_id ?? null]));

  const out: AttributionMatch[] = [];

  for (const appt of appointments) {
    const apptId = appt.id;
    const apptContactId = (appt.contact_id ?? "").trim() || null;
    const apptPhone = normalizeUSPhone(appt.client_phone);
    const apptEmail = normalizeEmail(appt.client_email);

    // No identity at all → Unattributed queue with the honest reason.
    if (!apptContactId && !apptPhone && !apptEmail) {
      out.push({
        appointmentId: apptId,
        status: "unattributed",
        reason: "no-contact-identity",
        noRepReason: "no-contact-identity",
      });
      continue;
    }

    // DATE-GRANULARITY window anchor: the booking's creation date (ET). No
    // parseable creation/session time → honest "bad-datetime", never guessed.
    const anchor = bookingCreationDateEt(appt);
    if (!anchor) {
      out.push({
        appointmentId: apptId,
        status: "unattributed",
        reason: "bad-datetime",
        noRepReason: "bad-datetime",
      });
      continue;
    }
    const window = attributionWindowDates(anchor.date);
    const windowMarker: WindowMarker = {
      from: window.from,
      to: window.to,
      marker: "date_granularity_window",
      anchoredOn: anchor.anchoredOn,
    };

    /**
     * S4b NO-REP CLASSIFIER (triage metadata — NEVER a verdict input). Given
     * the candidate contact ids the engine's identity tiers resolved, name the
     * honest category for "why is there no rep". Runs only on paths that end
     * unattributed with reason "no-qualifying-call" (the s1 layer already ran
     * and found no verified roster-rep ownership). Reads exactly the signals
     * the engine holds: the candidate set, the calls table index, the harvest
     * index and the roster-eligibility machinery.
     *
     * Reaching here guarantees NO in-window call of any duration resolves to a
     * roster rep (a resolvable >threshold call would have attributed in
     * decideForContact; a resolvable interaction of any duration would have
     * attributed in s1Verdict), so any in-window call or unresolved harvest
     * message found here is by definition owner-less activity.
     */
    const noRepReasonFor = (candidates: string[]): string => {
      if (candidates.length === 0) return "no-matching-contact";
      const inWindow = (iso: string): boolean => {
        const day = callDateEt(iso);
        return day != null && day >= window.from && day <= window.to;
      };
      for (const cid of candidates) {
        for (const c of callsByContact.get(cid) ?? []) {
          if (inWindow(c.started_at)) {
            // Defensive mirror of the guarantee above: a rep-resolving call
            // here would mean s1Verdict should have attributed; classify by
            // what the row actually is.
            const resolvable = eligibleRepId(
              { rep_id: c.rep_id, provider_rep_external_id: c.provider_rep_external_id ?? null },
              elig,
            );
            if (!resolvable) return "interaction-without-roster-rep";
          }
        }
        const ext = contactExtById.get(cid);
        for (const h of (ext ? harvestUnresolvedByContactExt.get(ext) : undefined) ?? []) {
          if (inWindow(h.started_at)) return "interaction-without-roster-rep";
        }
      }
      return "no-window-interaction";
    };

    /**
     * s1 OWNERSHIP LAYER (owner-frozen rule, 2026-09-27). Fires ONLY when the
     * >threshold rule produced NO verdict (no-qualifying-call): rep ownership
     * = the most-recent VERIFIED ROSTER-REP interaction within the SAME
     * date-granularity window, REGARDLESS of duration — a 30-second dial is
     * workflow evidence. Evidence = normalized calls (rep resolved through
     * the roster machinery, the same eligibleRepId path as qualifying calls)
     * + harvested conversation interactions (parent-conversation user
     * ownership, pre-resolved by the caller). NO all-time fallback (s2 stays
     * diagnostic-only), NO fuzzy identity, NO auto-assigned web/self-service
     * bookings. Multi-rep evidence is AMBIGUOUS — manual queue, never a
     * silent most-recent pick. Returns null when there is no evidence at all
     * (the caller keeps the honest no-qualifying-call verdict).
     */
    const s1Verdict = (candidates: string[]): AttributionMatch | null => {
      const inter: Array<{
        rep: string;
        ms: number;
        id: string;
        source: "calls" | "harvest";
        started_at: string;
        dur: number | null;
      }> = [];
      for (const cid of candidates) {
        for (const c of callsByContact.get(cid) ?? []) {
          const rep = eligibleRepId(
            { rep_id: c.rep_id, provider_rep_external_id: c.provider_rep_external_id ?? null },
            elig,
          );
          if (!rep) continue;
          const ms = Date.parse(c.started_at);
          if (!Number.isFinite(ms)) continue;
          const day = callDateEt(c.started_at);
          if (!day || day < window.from || day > window.to) continue;
          inter.push({ rep, ms, id: c.external_call_id, source: "calls", started_at: c.started_at, dur: c.duration_seconds });
        }
        const ext = contactExtById.get(cid);
        for (const h of (ext ? harvestByContactExt.get(ext) : undefined) ?? []) {
          if (!h.rep_id) continue;
          const ms = Date.parse(h.started_at);
          if (!Number.isFinite(ms)) continue;
          const day = callDateEt(h.started_at);
          if (!day || day < window.from || day > window.to) continue;
          inter.push({ rep: h.rep_id, ms, id: h.id, source: "harvest", started_at: h.started_at, dur: h.duration_seconds });
        }
      }
      if (inter.length === 0) return null;
      const reps = new Set(inter.map((i) => i.rep));
      if (reps.size > 1) {
        return {
          appointmentId: apptId,
          status: "unattributed",
          reason: "ambiguous",
          detail: `s1 rep-ownership evidence spans ${reps.size} distinct roster reps in ${window.from}..${window.to} ET`,
          window: windowMarker,
        };
      }
      // Most recent wins; deterministic tie-break by evidence id (stable re-runs).
      let best = inter[0];
      for (const i of inter.slice(1)) {
        if (i.ms > best.ms || (i.ms === best.ms && i.id > best.id)) best = i;
      }
      return {
        appointmentId: apptId,
        status: "attributed",
        callExternalId: best.id,
        repId: best.rep,
        method: "window_interaction",
        evidence: { id: best.id, source: best.source, started_at: best.started_at, duration_seconds: best.dur },
        window: windowMarker,
      };
    };

    /**
     * Decide from one contact's qualifying candidates: multi-rep evidence is
     * ambiguous (ambiguity rule 3 — never silently choose to raise coverage);
     * a deterministic single-rep set attributes normally (most recent wins).
     */
    const decideForContact = (contactId: string, method: AttributionMethod): AttributionMatch => {
      const candidates = qualifyingCandidates(
        calls.filter((c) => c.contact_id === contactId),
        window,
        settings,
      );
      if (candidates.length === 0) {
        return { appointmentId: apptId, status: "unattributed", reason: "no-qualifying-call", window: windowMarker };
      }
      const reps = new Set<string>();
      for (const c of candidates) {
        const r = eligibleRepId(
          { rep_id: c.call.rep_id, provider_rep_external_id: c.call.provider_rep_external_id ?? null },
          elig,
        );
        if (r != null) reps.add(r);
      }
      if (reps.size > 1) {
        return {
          appointmentId: apptId,
          status: "unattributed",
          reason: "ambiguous",
          detail: `qualifying calls from ${reps.size} distinct roster reps in ${window.from}..${window.to} ET`,
          window: windowMarker,
        };
      }
      const winner = pickWinner(candidates)!;
      return {
        appointmentId: apptId,
        status: "attributed",
        callExternalId: winner.external_call_id,
        repId: repFor(winner),
        method,
        window: windowMarker,
      };
    };

    // Tier (a): contact id — strongest evidence, needs no contact row.
    if (apptContactId) {
      const match = decideForContact(apptContactId, "contact_id");
      if (match.status === "attributed") {
        out.push(match);
        continue;
      }
      if (match.reason === "ambiguous") {
        out.push(match);
        continue;
      }
      // no-qualifying-call at this tier: weaker tiers may still resolve a
      // DIFFERENT contact (the id may point at a contact with no stored calls).
      if (!apptPhone && !apptEmail) {
        // s1: no >threshold call, but a verified roster-rep interaction (ANY
        // duration) within the window still owns the booking.
        out.push(
          s1Verdict(unionCandidates(apptContactId)) ?? {
            ...match,
            noRepReason: noRepReasonFor(unionCandidates(apptContactId)),
          },
        );
        continue;
      }
    }

    // Tier (b): phone → exactly one contact; MULTIPLE distinct contacts is a
    // hard stop — never fall through to weaker evidence past an unclear
    // stronger identity (the guess the SPEC forbids).
    let phoneContactId: string | null = null;
    let emailContactId: string | null = null;
    if (apptPhone) {
      const hit = byPhone.get(apptPhone) ?? [];
      const distinct = new Set(hit);
      if (distinct.size > 1) {
        out.push({
          appointmentId: apptId,
          status: "unattributed",
          reason: "ambiguous",
          detail: `phone matches ${distinct.size} distinct contacts`,
          window: windowMarker,
        });
        continue;
      }
      if (distinct.size === 1) {
        const contactId = [...distinct][0];
        // Ambiguity clause 1 ("contradicted by a stronger identity match"): the
        // stored contact id is the STRONGER evidence and names a DIFFERENT
        // contact than the phone does — the identity evidence disagrees about
        // WHO booked. Ambiguous regardless of either contact's calls (a stale
        // sync linkage or a shared family phone/email); Christopher decides.
        if (apptContactId && apptContactId !== contactId) {
          out.push({
            appointmentId: apptId,
            status: "unattributed",
            reason: "ambiguous",
            detail: "phone resolves a different contact than the stored contact id",
            window: windowMarker,
          });
          continue;
        }
        phoneContactId = contactId;
        const match = decideForContact(contactId, "phone");
        if (match.status === "attributed" || match.reason === "ambiguous") {
          out.push(match);
          continue;
        }
        // phone-tier no-qual: fall through — the email tier (if any) may still
        // resolve; the s1 layer runs at the final fallback with the union.
      }
    }

    // Tier (c): email — same shape as phone.
    if (apptEmail) {
      const hit = byEmail.get(apptEmail) ?? [];
      const distinct = new Set(hit);
      if (distinct.size > 1) {
        out.push({
          appointmentId: apptId,
          status: "unattributed",
          reason: "ambiguous",
          detail: `email matches ${distinct.size} distinct contacts`,
          window: windowMarker,
        });
        continue;
      }
      if (distinct.size === 1) {
        const contactId = [...distinct][0];
        // Clause 1 vs BOTH stronger identities: the stored contact id, and a
        // phone that resolved cleanly to a different contact.
        if (apptContactId && apptContactId !== contactId) {
          // RULE B (owner-approved 2026-09-28): when the STORED contact is a
          // junk/shared record (appointments stored against it carry ≥2
          // distinct client emails) and the booking's email resolves via EXACT
          // case-insensitive equality to exactly one NON-junk contact, resolve
          // the booking's identity through the email-matched contact and
          // attribute under the UNCHANGED s1 rules — same attribution window
          // (created_business_date ET + preceding calendar day), most-recent
          // verified roster interaction in window regardless of duration, NO
          // all-time fallback. The junk contact's own calls/interactions are
          // NEVER evidence (they belong to other clients). Guards, each
          // test-pinned:
          //   (a) the email matching MULTIPLE contacts never resolves (the
          //       distinct.size > 1 hard stop above is unchanged);
          //   (b) the resolved contact has no ACTIVE-ROSTER owner (no stored
          //       owner, or an owner who is not an active roster rep) → do
          //       NOT attribute; manual-assignment queue with the distinct
          //       reason_code "email-resolves-non-roster";
          //   (c) the resolved contact is itself junk → do NOT resolve; the
          //       conflict stays ambiguous (the fall-through push below);
          //   (d) manual_override rows are never re-processed (store-level:
          //       the upsert skips manual rows; the wiring carries them
          //       verbatim) — the engine never sees them change;
          //   (e) EXACT case-insensitive email equality is the ONLY
          //       resolution key — no fuzzy matching of any kind (no name
          //       similarity, no phone matching).
          // A phone that resolved to the stored (junk) contact is not a
          // counter-evidence: it resolved to the same garbage record. A phone
          // that resolved to a DIFFERENT contact is a real conflict — the
          // resolution is refused and the booking stays ambiguous.
          const storedIsJunk = junkContactIds.has(apptContactId);
          const resolvedIsJunk = junkContactIds.has(contactId);
          const phoneConflict = phoneContactId != null && phoneContactId !== apptContactId;
          if (storedIsJunk && !resolvedIsJunk && !phoneConflict) {
            const resolution = { storedContactId: apptContactId, resolvedContactId: contactId };
            const match = decideForContact(contactId, "email");
            if (match.status === "attributed" || match.reason === "ambiguous") {
              out.push({ ...match, emailResolution: resolution });
              continue;
            }
            // No >threshold call at the resolved contact → the s1 layer runs
            // over the RESOLVED identity ONLY (the junk contact never joins
            // the candidate set — its calls belong to other clients).
            const s1 = s1Verdict([contactId]);
            if (s1) {
              out.push({ ...s1, emailResolution: resolution });
              continue;
            }
            // Guard (b): the resolved contact does NOT have an active-roster
            // owner — either no stored owner at all (assigned_rep_id NULL,
            // the live 3b649d31 follow-up shape: the email-matched contact is
            // an unowned record) or an owner who is not an active roster rep.
            // No rep signal exists under the frozen s1 rules, so the row queues
            // for manual assignment under its own reason_code (still an
            // identity-conflict row: the note keeps the "ambiguous" prefix so
            // queue counting stays stable).
            const owner = ownerByContactId.get(contactId) ?? null;
            if (!owner || !elig.activeIds.has(owner)) {
              out.push({
                appointmentId: apptId,
                status: "unattributed",
                reason: "ambiguous",
                reasonCode: "email-resolves-non-roster",
                detail: `email resolves a different contact than the stored contact id — stored contact ${apptContactId} is a junk/shared record; resolved via email to ${contactId}, whose owner is not an active roster rep`,
                window: windowMarker,
              });
              continue;
            }
            // Owner is an active roster rep (or unset) but no in-window
            // evidence: the honest no-qualifying-call verdict on the resolved
            // identity, marked as an email resolution for the audit trail.
            out.push({
              ...match,
              noRepReason: noRepReasonFor([contactId]),
              emailResolution: resolution,
            });
            continue;
          }
          out.push({
            appointmentId: apptId,
            status: "unattributed",
            reason: "ambiguous",
            detail: "email resolves a different contact than the stored contact id",
            window: windowMarker,
          });
          continue;
        }
        if (phoneContactId && phoneContactId !== contactId) {
          out.push({
            appointmentId: apptId,
            status: "unattributed",
            reason: "ambiguous",
            detail: "email resolves a different contact than the phone",
            window: windowMarker,
          });
          continue;
        }
        emailContactId = contactId;
        const match = decideForContact(contactId, "email");
        if (match.status === "unattributed" && match.reason === "no-qualifying-call") {
          // s1: email-tier no-qual → the union of every resolved identity
          // tier's contact is the candidate set (exactly the scenario
          // machinery's cands accumulation).
          const emailUnion = unionCandidates(apptContactId, phoneContactId, contactId);
          out.push(s1Verdict(emailUnion) ?? { ...match, noRepReason: noRepReasonFor(emailUnion) });
          continue;
        }
        out.push(match);
        continue;
      }
    }

    // Identity known (or skipped as ambiguous-free) but nothing qualified.
    const finalUnion = unionCandidates(apptContactId, phoneContactId, emailContactId);
    out.push(
      s1Verdict(finalUnion) ?? {
        appointmentId: apptId,
        status: "unattributed",
        reason: "no-qualifying-call",
        noRepReason: noRepReasonFor(finalUnion),
        window: windowMarker,
      },
    );
  }

  return out;
}
