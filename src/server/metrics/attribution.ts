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
 * Constraints on every candidate call:
 *   - duration_seconds is a real number STRICTLY GREATER than
 *     settings.meeting_threshold_seconds (null/0/voicemail-duration never
 *     qualifies — an unknown length is never counted as meaningful);
 *   - the call STARTED within [anchor − window, anchor] where anchor = the
 *     appointment's CREATED_AT (docs/SPEC.md §BOOKING ATTRIBUTION: "the
 *     appointment was CREATED within the configured attribution window" — a
 *     session is booked days ahead, and the sales call precedes the
 *     booking-MADE moment, not the session) falling back to the session
 *     datetime only when created_at is absent; window =
 *     settings.attribution_window_hours. The booking is the EVIDENCE the call
 *     worked, so the call precedes the booking; a call that starts after the
 *     anchor never qualifies;
 *   - among qualifying candidates the MOST RECENT started_at wins (tie broken
 *     deterministically by external_call_id so re-runs are stable).
 *
 * AMBIGUITY RULE (the "never silently guessed" clause):
 *   1. A phone or email identity that resolves to MULTIPLE DISTINCT contacts is
 *      ambiguous at its tier — the engine stops there and reports
 *      reason "ambiguous". It does NOT fall through to a weaker tier: picking
 *      the email match when the stronger phone evidence names two different
 *      people would be exactly the guess the SPEC forbids ("the chosen contact
 *      match is contradicted by a stronger identity match on a different
 *      call").
 *   2. The chosen match is additionally cross-checked: if a STRONGER tier's
 *      identity resolves unambiguously to a DIFFERENT contact than the chosen
 *      one and that contact also has a qualifying call, the evidence
 *      contradicts itself → "ambiguous". (Under the first-match-wins walk this
 *      can only fire when the stronger tier's candidates were hidden by an
 *      unparseable/absent id — the check makes the guarantee structural rather
 *      than incidental.)
 *   Everything ambiguous lands in the Unattributed queue with a reason string
 *   that says WHY — visible and auditable, ready for manual assignment.
 *
 * Rep identity flows through the EXISTING roster-eligibility machinery
 * (src/server/roster.ts — applyAttributionEligibility; NEVER re-implemented
 * here): the winning call's rep is resolved at query time through
 * buildRosterEligibility + the settings' rep_mappings. Source rows are never
 * mutated — mapped eligibility produces fresh result objects only.
 *
 * Purity: imports TYPES and the roster pure functions only — no runtime store,
 * no fetch, no clock (the caller passes today). Feeds the future scheduler
 * wiring + manual-assignment API through this one seam.
 */
import type { AppSettings } from "../store/types";
import { buildRosterEligibility, applyAttributionEligibility, type RosterEligibility } from "../roster";

// ---------- input shapes (structural — call sites pass store rows directly) ----------

/** Minimal appointment view the engine needs (appointments table + client fields). */
export interface AttributionAppointment {
  /** Internal appointments.id — returned verbatim as `appointmentId`. */
  id: string;
  contact_id: string | null;
  /** Normalized at sync (digits, leading 1 kept) — raw digits string or null. */
  client_phone?: string | null;
  /** Normalized at sync (lowercase-trimmed) or null. */
  client_email?: string | null;
  /** ISO UTC session time. */
  appointment_datetime: string;
  /**
   * ISO UTC booking-MADE time — the SPEC's window anchor ("the appointment was
   * created within the configured attribution window"). Falls back to
   * appointment_datetime when absent (legacy rows always carry it).
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
   * conflicts or names multiple people — manual assignment required),
   * "no-qualifying-call" (identity known but no call over threshold within
   * the window before the booking), "bad-datetime" (unparseable session time
   * — never guessed against a broken anchor).
   */
  reason?: string;
  /** Evidence tier that produced an attribution (attributed only). */
  method?: AttributionMethod;
  /**
   * Ambiguity evidence detail (auditable; feeds the manual-assignment queue):
   * which identity conflicted and how. Never present on attributed rows.
   */
  detail?: string;
}

// ---------- normalization (ONE definition — the Acuity sync reuses these) ----------

/** Email identity: trim + lowercase; empty → null. */
export function normalizeAttributionEmail(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim().toLowerCase();
  return t.length > 0 ? t : null;
}

/**
 * Phone identity: digits only, leading country code 1 KEPT when present —
 * the raw digits string is the stored form. Empty → null.
 */
export function normalizeAttributionPhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

/**
 * Phone EQUALITY with 1-prefix tolerance: "15551234567" and "5551234567" are
 * the same North-American number whether or not one side stored the country
 * code. Exact digit equality otherwise — no looser last-10 matching, so two
 * genuinely different numbers can never collide.
 */
export function phonesEqual(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length === 11 && a.startsWith("1") && a.slice(1) === b) return true;
  if (b.length === 11 && b.startsWith("1") && b.slice(1) === a) return true;
  return false;
}

// ---------- engine ----------

export interface AttributionSettings {
  meeting_threshold_seconds: number;
  attribution_window_hours: number;
  rep_mappings?: AppSettings["rep_mappings"];
}

export interface AttributionOptions {
  /**
   * ET calendar date the evaluation runs for (date-logic convention).
   * Accepted for signature stability with the scheduler wiring; the pure
   * matching math is anchored on each appointment's own datetime, never on
   * wall-clock. Defaults to etToday().
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
  apptStartMs: number,
  settings: AttributionSettings,
): Candidate[] {
  const windowMs = Math.max(0, settings.attribution_window_hours) * 3_600_000;
  const threshold = settings.meeting_threshold_seconds;
  const out: Candidate[] = [];
  for (const call of calls) {
    const dur = call.duration_seconds;
    // STRICTLY over the threshold; null/NaN (voicemail/unknown length) never qualifies.
    if (typeof dur !== "number" || !Number.isFinite(dur) || dur <= threshold) continue;
    const startMs = Date.parse(call.started_at);
    if (!Number.isFinite(startMs)) continue;
    // [apptStart − window, apptStart] — both ends inclusive (exactly 24h00m
    // before is IN, 24h01m is OUT; a call after the booking is OUT).
    if (startMs > apptStartMs) continue;
    if (startMs < apptStartMs - windowMs) continue;
    out.push({ call, startMs });
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

  // Identity indexes over the contacts table (normalized).
  const byPhone = new Map<string, string[]>(); // normalized phone → distinct contact ids
  const byEmail = new Map<string, string[]>();
  for (const c of contacts) {
    const phone = normalizeAttributionPhone(c.phone);
    if (phone) {
      // 1-prefix tolerance on the index key: index under BOTH forms when they differ.
      for (const key of new Set([phone, phone.length === 11 && phone.startsWith("1") ? phone.slice(1) : phone])) {
        const list = byPhone.get(key) ?? [];
        if (!list.includes(c.id)) list.push(c.id);
        byPhone.set(key, list);
      }
    }
    const email = normalizeAttributionEmail(c.email);
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
    const apptPhone = normalizeAttributionPhone(appt.client_phone);
    const apptEmail = normalizeAttributionEmail(appt.client_email);

    // No identity at all → Unattributed queue with the honest reason.
    if (!apptContactId && !apptPhone && !apptEmail) {
      out.push({ appointmentId: apptId, status: "unattributed", reason: "no-contact-identity" });
      continue;
    }

    // SPEC window anchor: the booking-MADE time (created_at), falling back to
    // the session datetime for rows without one. Neither parseable → honest
    // "bad-datetime", never guessed against a broken anchor.
    const anchorRaw = appt.created_at ?? appt.appointment_datetime;
    const apptStartMs = Date.parse(anchorRaw);
    if (!Number.isFinite(apptStartMs)) {
      out.push({ appointmentId: apptId, status: "unattributed", reason: "bad-datetime" });
      continue;
    }

    // Tier (a): contact id — strongest evidence, needs no contact row.
    let winner: AttributionCall | null = null;
    let method: AttributionMethod | null = null;
    if (apptContactId) {
      winner = pickWinner(qualifyingCandidates(calls.filter((c) => c.contact_id === apptContactId), apptStartMs, settings));
      if (winner) method = "contact_id";
    }

    // Tier (b): phone → exactly one contact; MULTIPLE distinct contacts is a
    // hard stop — never fall through to weaker evidence past an unclear
    // stronger identity (the guess the SPEC forbids).
    let phoneContactId: string | null = null;
    if (!winner && apptPhone) {
      const phoneKey = apptPhone.length === 11 && apptPhone.startsWith("1") ? apptPhone.slice(1) : apptPhone;
      const hit = byPhone.get(apptPhone) ?? byPhone.get(phoneKey) ?? [];
      const distinct = new Set(hit);
      if (distinct.size > 1) {
        out.push({
          appointmentId: apptId,
          status: "unattributed",
          reason: "ambiguous",
          detail: `phone matches ${distinct.size} distinct contacts`,
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
          });
          continue;
        }
        phoneContactId = contactId;
        winner = pickWinner(qualifyingCandidates(calls.filter((c) => c.contact_id === contactId), apptStartMs, settings));
        if (winner) method = "phone";
      }
    }

    // Tier (c): email — same shape as phone.
    if (!winner && apptEmail) {
      const hit = byEmail.get(apptEmail) ?? [];
      const distinct = new Set(hit);
      if (distinct.size > 1) {
        out.push({
          appointmentId: apptId,
          status: "unattributed",
          reason: "ambiguous",
          detail: `email matches ${distinct.size} distinct contacts`,
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
          });
          continue;
        }
        if (phoneContactId && phoneContactId !== contactId) {
          out.push({
            appointmentId: apptId,
            status: "unattributed",
            reason: "ambiguous",
            detail: "email resolves a different contact than the phone",
          });
          continue;
        }
        winner = pickWinner(qualifyingCandidates(calls.filter((c) => c.contact_id === contactId), apptStartMs, settings));
        if (winner) method = "email";
      }
    }

    if (winner) {
      out.push({
        appointmentId: apptId,
        status: "attributed",
        callExternalId: winner.external_call_id,
        repId: repFor(winner),
        method: method ?? undefined,
      });
      continue;
    }

    // Identity known (or skipped as ambiguous-free) but nothing qualified.
    out.push({ appointmentId: apptId, status: "unattributed", reason: "no-qualifying-call" });
  }

  return out;
}
