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
 * The parser stores a date-only dateCreated as UTC midnight, so a created_at
 * of exactly 00:00:00.000Z is read back as a CALENDAR DATE, not as an ET
 * instant (reading it as ET would shift the anchor a day early). Rows whose
 * created_at is a real timestamp use its ET date. A legacy row with no
 * created_at falls back to the session datetime and the match is MARKED
 * `anchoredOn: "session-fallback"` — visible, never silent.
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
}

// ---------- output ----------

export type AttributionMethod = "contact_id" | "phone" | "email";

/** Audit/debug record of the window the match was evaluated against. */
export interface WindowMarker {
  /** First (earliest) ET calendar date whose calls qualify. */
  from: string;
  /** Last ET calendar date whose calls qualify (the booking's creation date). */
  to: string;
  /** Fixed marker: the window is DATE-GRANULARITY, not exact-hours. */
  marker: "date_granularity_window";
  /** Which row supplied the anchor: the booking creation, or a legacy session fallback. */
  anchoredOn: "created_at" | "session-fallback";
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
  /** Evidence tier that produced an attribution (attributed only). */
  method?: AttributionMethod;
  /**
   * Ambiguity evidence detail (auditable; feeds the manual-assignment queue):
   * which identity conflicted and how. Never present on attributed rows.
   */
  detail?: string;
  /**
   * Audit/debug: the exact window dates the match was evaluated against plus
   * the date_granularity_window marker (the limitation is persisted on the
   * attribution row by the sync wiring — never re-derived ad hoc).
   */
  window?: WindowMarker;
}

// ---------- window math (ET date granularity — owner-ratified 2026-09-26) ----------

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The booking's CREATION date (ET, YYYY-MM-DD) from the stored created_at.
 * Date-only encodings stay dates (Acuity dateCreated has no time — the parser
 * stores it as exactly UTC midnight, which must NOT be re-read as an ET
 * instant, or the anchor shifts a day early). Real timestamps become their ET
 * calendar date. Never uses the scheduled session date while created_at
 * exists; returns null only when nothing is parseable.
 */
export function bookingCreationDateEt(appt: {
  created_at?: string | null;
  appointment_datetime?: string | null;
}): { date: string; anchoredOn: "created_at" | "session-fallback" } | null {
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

  const out: AttributionMatch[] = [];

  for (const appt of appointments) {
    const apptId = appt.id;
    const apptContactId = (appt.contact_id ?? "").trim() || null;
    const apptPhone = normalizeUSPhone(appt.client_phone);
    const apptEmail = normalizeEmail(appt.client_email);

    // No identity at all → Unattributed queue with the honest reason.
    if (!apptContactId && !apptPhone && !apptEmail) {
      out.push({ appointmentId: apptId, status: "unattributed", reason: "no-contact-identity" });
      continue;
    }

    // DATE-GRANULARITY window anchor: the booking's creation date (ET). No
    // parseable creation/session time → honest "bad-datetime", never guessed.
    const anchor = bookingCreationDateEt(appt);
    if (!anchor) {
      out.push({ appointmentId: apptId, status: "unattributed", reason: "bad-datetime" });
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
        out.push(match);
        continue;
      }
    }

    // Tier (b): phone → exactly one contact; MULTIPLE distinct contacts is a
    // hard stop — never fall through to weaker evidence past an unclear
    // stronger identity (the guess the SPEC forbids).
    let phoneContactId: string | null = null;
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
        const match = decideForContact(contactId, "email");
        out.push(match);
        continue;
      }
    }

    // Identity known (or skipped as ambiguous-free) but nothing qualified.
    out.push({
      appointmentId: apptId,
      status: "unattributed",
      reason: "no-qualifying-call",
      window: windowMarker,
    });
  }

  return out;
}
