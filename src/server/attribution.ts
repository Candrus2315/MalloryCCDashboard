/**
 * Booking Attribution Engine (SPEC): connect Acuity appointments with
 * HighLevel calls.
 *
 * Match contacts by priority: 1) Contact ID  2) Phone  3) Email.
 * A booking counts as "Bookings From Calls Over Threshold" when a rep had a
 * call with that contact lasting MORE than the meaningful-call threshold AND
 * the appointment was created within the attribution window (default 24h)
 * after that call. If multiple reps qualify, attribute to the MOST RECENT
 * qualifying call before the booking. Unclear attribution → unattributed
 * queue (rep_id null, method 'none') — never silently guessed. Christopher
 * can override manually (manual_override).
 */

import type { AppointmentRow, AttributionRow, CallRow } from "./metrics/compute";

export interface ContactRow {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  assigned_rep_id: string | null;
}

export interface AttributionComputation {
  attributions: AttributionRow[];
  unattributedAppointmentIds: string[];
}

export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  // keep last 10 digits so country codes/formatting don't break matching
  return digits.length >= 10 ? digits.slice(-10) : digits.length > 0 ? digits : null;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  return email ? email.trim().toLowerCase() || null : null;
}

const METHOD_CONFIDENCE: Record<string, number> = {
  contact_id: 1,
  phone: 0.8,
  email: 0.8,
  manual: 1,
  none: 0,
};

/**
 * Pure attribution computation. Runs at sync time (results persisted to
 * booking_attributions, keyed unique by appointment_id) and in tests.
 */
export function computeAttributions(input: {
  appointments: AppointmentRow[];
  calls: CallRow[];
  contacts: ContactRow[];
  thresholdSeconds: number;
  windowHours: number;
}): AttributionComputation {
  const { appointments, calls, contacts, thresholdSeconds, windowHours } = input;

  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const contactsByPhone = new Map<string, ContactRow>();
  const contactsByEmail = new Map<string, ContactRow>();
  for (const c of contacts) {
    const p = normalizePhone(c.phone);
    if (p && !contactsByPhone.has(p)) contactsByPhone.set(p, c);
    const e = normalizeEmail(c.email);
    if (e && !contactsByEmail.has(e)) contactsByEmail.set(e, c);
  }

  const callsByContact = new Map<string, CallRow[]>();
  for (const call of calls) {
    if (!call.contact_id) continue;
    const arr = callsByContact.get(call.contact_id) ?? [];
    arr.push(call);
    callsByContact.set(call.contact_id, arr);
  }

  const windowMs = windowHours * 3600_000;
  const attributions: AttributionRow[] = [];
  const unattributedAppointmentIds: string[] = [];

  for (const appt of appointments) {
    // 1) Contact ID, 2) phone, 3) email — first match wins.
    let contact: ContactRow | undefined;
    let method = "none";
    if (appt.contact_id && contactsById.has(appt.contact_id)) {
      contact = contactsById.get(appt.contact_id);
      method = "contact_id";
    }
    if (!contact) {
      const apptPhone = normalizePhone((appt as AppointmentRow & { client_phone?: string | null }).client_phone);
      const p = apptPhone && contactsByPhone.get(apptPhone);
      if (p) {
        contact = p;
        method = "phone";
      }
    }
    if (!contact) {
      const apptEmail = normalizeEmail((appt as AppointmentRow & { client_email?: string | null }).client_email);
      const e = apptEmail && contactsByEmail.get(apptEmail);
      if (e) {
        contact = e;
        method = "email";
      }
    }

    if (!contact) {
      unattributedAppointmentIds.push(appt.id);
      attributions.push({
        id: `attr:${appt.id}`,
        appointment_id: appt.id,
        call_id: null,
        rep_id: null,
        method: "none",
        confidence: 0,
        manual_override: false,
      });
      continue;
    }

    // Qualifying calls: same contact, duration > threshold, appointment created
    // after the call and within the attribution window. Most recent wins.
    const created = new Date(appt.created_at).getTime();
    const candidates = (callsByContact.get(contact.id) ?? [])
      .filter((c) => c.duration_seconds > thresholdSeconds)
      .filter((c) => {
        const started = new Date(c.started_at).getTime();
        return created >= started && created - started <= windowMs;
      })
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

    const winner = candidates[0];
    if (!winner) {
      unattributedAppointmentIds.push(appt.id);
      attributions.push({
        id: `attr:${appt.id}`,
        appointment_id: appt.id,
        call_id: null,
        rep_id: null,
        method: "none",
        confidence: 0,
        manual_override: false,
      });
      continue;
    }

    attributions.push({
      id: `attr:${appt.id}`,
      appointment_id: appt.id,
      call_id: winner.id,
      rep_id: winner.rep_id,
      method,
      confidence: METHOD_CONFIDENCE[method] ?? 0.5,
      manual_override: false,
    });
  }

  return { attributions, unattributedAppointmentIds };
}
