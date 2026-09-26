/**
 * Demo dataset generator — realistic Mallory CC demo data, generated relative
 * to "today" (ET) so the dashboard always shows a live-looking day.
 *
 * Deterministic per (day, index): external IDs embed the ET date, so re-running
 * the demo sync produces the SAME provider IDs → the upsert layer replaces
 * rows instead of duplicating. New days add new rows; history accumulates.
 */
import { addDays, etDayEndUtc, etDayStartUtc, etToday, getWorkDate, weekday } from "../date-logic";
import type { AppointmentRow, AttributionRow, AvailabilityRule } from "../metrics/compute";
import { computeAttributions } from "../attribution";
import type { BlockedTimeRow } from "../metrics/compute";

// seeded PRNG (mulberry32) — deterministic
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const DEMO_REPS = [
  { external_id: "demo-rep-maya", name: "Maya Chen" },
  { external_id: "demo-rep-jordan", name: "Jordan Rivera" },
  { external_id: "demo-rep-sam", name: "Sam Patel" },
  { external_id: "demo-rep-alexis", name: "Alexis Moore" },
  { external_id: "demo-rep-devon", name: "Devon Brooks" },
  { external_id: "demo-rep-riley", name: "Riley Nguyen" },
];

const FAMILY_FIRST = ["Emma", "Liam", "Sophia", "Noah", "Olivia", "Ethan", "Ava", "Lucas", "Mia", "James", "Amelia", "Ben"];
const FAMILY_LAST = ["Carter", "Nguyen", "Walsh", "Okafor", "Silva", "Kim", "Torres", "Brooks", "Patel", "Reed", "Ivanov", "Moreau"];
const ANIMAL_NAMES = ["Biscuit", "Maple", "Ziggy", "Willow", "Pepper", "Rufus", "Clementine", "Scout", "Juniper", "Mochi"];

const FAMILY_TYPES = ["Family Portrait Session", "Family Mini Session", "Holiday Family Session"];
const ANIMALIA_TYPES = ["Animalia Signature Session", "Animalia Pet Portrait", "Animalia Companion Session"];

export interface DemoBatch {
  users: { external_id: string; name: string }[];
  contacts: { external_id: string; name: string; phone: string; email: string; repExternalId: string; createdAt: string }[];
  calls: { external_call_id: string; repExternalId: string; contactExternalId: string; startedAt: string; durationSeconds: number; direction: string; status: string }[];
  appointments: {
    acuity_appointment_id: string;
    calendarId: string;
    calendarName: string;
    appointmentType: string;
    appointmentDatetime: string;
    createdAt: string;
    status: string;
    cancelled: boolean;
    clientName: string;
    clientPhone: string;
    clientEmail: string;
    durationMinutes: number;
  }[];
  leads: { source_id: string; leadType: string; sourceDate: string; workDate: string; name: string; phone: string; email: string; sheet: string }[];
  blockedTimes: { external_id: string; startAt: string; endAt: string; reason: string }[];
  availabilityRules: AvailabilityRule[];
}

/** ET "today" bounds → we only generate data up to the current ET hour for today. */
function dayWindow(dateStr: string): { startUtcMs: number; endUtcMs: number } {
  return { startUtcMs: Date.parse(etDayStartUtc(dateStr)), endUtcMs: Date.parse(etDayEndUtc(dateStr)) };
}

const SLOT_HOURS = [10, 11.5, 13, 14.5, 16, 17]; // ET hours used for session times

/**
 * Generate one demo batch covering the last `days` ET days (inclusive of
 * today, truncated to "now"). Call repeatedly as days advance.
 */
export function generateDemoBatch(opts: { days?: number; now?: number; todayOverride?: string } = {}): DemoBatch {
  const nowMs = opts.now ?? Date.now();
  const today = opts.todayOverride ?? etToday();
  const days = opts.days ?? 12;

  const users = DEMO_REPS.map((r) => ({ ...r }));
  const contacts: DemoBatch["contacts"] = [];
  const calls: DemoBatch["calls"] = [];
  const appointments: DemoBatch["appointments"] = [];
  const leads: DemoBatch["leads"] = [];
  const blockedTimes: DemoBatch["blockedTimes"] = [];

  // Leads volume by weekday: heavy Mon–Thu, light Fri–Sun (operational week ~640 leads).
  const leadCounts = (date: string): { family: number; animalia: number } => {
    const wd = weekday(date);
    const r = rng(hashStr(`leadvol:${date}`));
    const base = wd >= 1 && wd <= 4 ? 24 : wd === 5 ? 18 : 12; // family-ish base
    const scale = wd >= 1 && wd <= 4 ? 2.6 : wd === 5 ? 2.2 : 1.5;
    return {
      family: base + Math.floor(r() * 6),
      animalia: Math.floor(base * scale) + Math.floor(r() * 8),
    };
  };

  for (let d = days - 1; d >= 0; d--) {
    const date = addDays(today, -d);
    const isToday = date === today;
    const { startUtcMs, endUtcMs } = dayWindow(date);
    const dayEndMs = isToday ? Math.min(endUtcMs, nowMs) : endUtcMs;

    // ---- leads (sheets) ----
    const { family: famCount, animalia: aniCount } = leadCounts(date);
    const fam = rng(hashStr(`fam:${date}`));
    const ani = rng(hashStr(`ani:${date}`));
    for (let i = 0; i < famCount; i++) {
      const name = `${FAMILY_FIRST[Math.floor(fam() * FAMILY_FIRST.length)]} ${FAMILY_LAST[Math.floor(fam() * FAMILY_LAST.length)]}`;
      leads.push({
        source_id: `demo-fam-${date}-${i}`,
        leadType: "family",
        sourceDate: date,
        workDate: getWorkDate(date),
        name,
        phone: `+1917555${String(1000 + Math.floor(fam() * 8999))}`,
        email: `${name.toLowerCase().replace(/[^a-z]/g, ".")}@example.com`,
        sheet: "family",
      });
    }
    for (let i = 0; i < aniCount; i++) {
      const owner = FAMILY_FIRST[Math.floor(ani() * FAMILY_FIRST.length)];
      const pet = ANIMAL_NAMES[Math.floor(ani() * ANIMAL_NAMES.length)];
      const name = `${owner} & ${pet}`;
      leads.push({
        source_id: `demo-ani-${date}-${i}`,
        leadType: "animalia",
        sourceDate: date,
        workDate: getWorkDate(date),
        name,
        phone: `+1917556${String(1000 + Math.floor(ani() * 8999))}`,
        email: `${owner.toLowerCase()}.${pet.toLowerCase()}@example.com`,
        sheet: "animalia",
      });
    }

    // ---- contacts + calls ----
    // A sample of each day's leads becomes a HighLevel contact the reps call.
    const dayLeads = leads.filter((l) => l.sourceDate === date);
    const workedSample = dayLeads.filter((_, i) => i % 3 === 0); // ~1/3 of leads are contacted
    for (const lead of workedSample) {
      const repIdx = hashStr(`${lead.source_id}:rep`) % DEMO_REPS.length;
      const rep = DEMO_REPS[repIdx];
      contacts.push({
        external_id: `demo-contact-${lead.source_id}`,
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        repExternalId: rep.external_id,
        createdAt: new Date(startUtcMs + 9 * 3600_000 + (hashStr(lead.source_id) % (8 * 3600_000))).toISOString(),
      });

      const crng = rng(hashStr(`calls:${lead.source_id}`));
      const nCalls = 1 + Math.floor(crng() * 3); // 1-3 calls per contacted lead
      for (let ci = 0; ci < nCalls; ci++) {
        // Calls happen the work day between 10:00 and 18:00 ET (8h window ≈ 13-17 UTC)
        const callMs = startUtcMs + (13 * 3600_000 + Math.floor(crng() * 5 * 3600_000));
        if (callMs >= dayEndMs) continue;
        // ~42% meaningful (2–9 min), 58% short (20–110s)
        const dur = crng() < 0.42 ? 130 + Math.floor(crng() * 410) : 20 + Math.floor(crng() * 90);
        calls.push({
          external_call_id: `demo-call-${lead.source_id}-${ci}`,
          repExternalId: rep.external_id,
          contactExternalId: `demo-contact-${lead.source_id}`,
          startedAt: new Date(callMs).toISOString(),
          durationSeconds: dur,
          direction: crng() < 0.7 ? "outbound" : "inbound",
          status: "completed",
        });
      }
    }
  }

  // ---- appointments from meaningful calls (attribution candidates) ----
  for (const call of calls) {
    const arng = rng(hashStr(`appt:${call.external_call_id}`));
    if (call.durationSeconds <= 120) continue; // only meaningful calls convert
    if (arng() > 0.52) continue; // ~52% of meaningful calls book (owner's real range: conv ≈ 55-65%)
    const createdMs = Date.parse(call.startedAt) + (10 + Math.floor(arng() * 80)) * 60_000;
    const isContact = contacts.find((c) => c.external_id === call.contactExternalId);
    const isFamily = isContact ? !isContact.email.includes(".") || hashStr(isContact.external_id) % 2 === 0 : true;
    const types = isFamily ? FAMILY_TYPES : ANIMALIA_TYPES;
    const calendarName = isFamily ? "Family Studio" : "Animalia Studio";
    // Session 1–6 days out, on a studio slot hour
    const sessionDate = new Date(createdMs + (1 + Math.floor(arng() * 6)) * 86400_000);
    const slotHour = SLOT_HOURS[Math.floor(arng() * SLOT_HOURS.length)];
    const h = Math.floor(slotHour);
    const m = slotHour % 1 ? 30 : 0;
    // ET slot hour → UTC (EDT: +4, EST: +5); approximate with fixed +4 (Sep window)
    sessionDate.setUTCHours(h + 4, m, 0, 0);
    const cancelled = arng() < 0.1;
    appointments.push({
      acuity_appointment_id: `demo-appt-${call.external_call_id}`,
      calendarId: isFamily ? "cal-family" : "cal-animalia",
      calendarName,
      appointmentType: types[Math.floor(arng() * types.length)],
      appointmentDatetime: sessionDate.toISOString(),
      createdAt: new Date(createdMs).toISOString(),
      status: cancelled ? "cancelled" : "scheduled",
      cancelled,
      clientName: isContact?.name ?? "Unknown Client",
      clientPhone: isContact?.phone ?? "",
      clientEmail: isContact?.email ?? "",
      durationMinutes: 60,
    });
  }

  // ---- a few direct bookings with NO qualifying call → unattributed queue ----
  const urng = rng(hashStr(`unattr:${today}`));
  const nUnattributed = 3 + Math.floor(urng() * 3);
  for (let i = 0; i < nUnattributed; i++) {
    const createdMs = dayWindow(addDays(today, -(i % 5))).startUtcMs + 15 * 3600_000;
    const isFamily = urng() < 0.6;
    appointments.push({
      acuity_appointment_id: `demo-appt-direct-${i}-${today}`,
      calendarId: isFamily ? "cal-family" : "cal-animalia",
      calendarName: isFamily ? "Family Studio" : "Animalia Studio",
      appointmentType: isFamily ? FAMILY_TYPES[0] : ANIMALIA_TYPES[0],
      appointmentDatetime: new Date(createdMs + 3 * 86400_000).toISOString(),
      createdAt: new Date(createdMs).toISOString(),
      status: "scheduled",
      cancelled: false,
      clientName: `Direct Booking ${i + 1}`,
      clientPhone: `+1917559${String(1000 + Math.floor(urng() * 8999))}`,
      clientEmail: "",
      durationMinutes: 60,
    });
  }

  // ---- blocked times (studio lunch blocks, today + tomorrow) ----
  for (const off of [0, 1]) {
    const date = addDays(today, off);
    const { startUtcMs } = dayWindow(date);
    blockedTimes.push({
      external_id: `demo-block-lunch-${date}`,
      startAt: new Date(startUtcMs + 16 * 3600_000).toISOString(), // 12:00 ET
      endAt: new Date(startUtcMs + 17 * 3600_000).toISOString(), // 13:00 ET
      reason: "Studio lunch / turnaround",
    });
  }

  const availabilityRules: AvailabilityRule[] = [
    { weekday: 1, open_time: "10:00", close_time: "18:00", active: true },
    { weekday: 2, open_time: "10:00", close_time: "18:00", active: true },
    { weekday: 3, open_time: "10:00", close_time: "18:00", active: true },
    { weekday: 4, open_time: "10:00", close_time: "18:00", active: true },
    { weekday: 5, open_time: "10:00", close_time: "18:00", active: true },
    { weekday: 6, open_time: "10:00", close_time: "16:00", active: true },
    { weekday: 0, open_time: "10:00", close_time: "16:00", active: false },
  ];

  return { users, contacts, calls, appointments, leads, blockedTimes, availabilityRules };
}

/**
 * Compute attributions over the full demo batch (external-ID space; the sync
 * maps to internal UUIDs afterwards).
 */
export function demoAttributions(batch: DemoBatch, thresholdSeconds: number, windowHours: number): Map<string, { callExternalId: string | null; method: string }> {
  const repByExt = new Map(batch.users.map((u) => [u.external_id, u]));
  const contactRows = batch.contacts.map((c) => ({
    id: c.external_id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    assigned_rep_id: repByExt.get(c.repExternalId)?.external_id ?? null,
  }));
  const callRows = batch.calls.map((c) => ({
    id: c.external_call_id,
    rep_id: c.repExternalId,
    contact_id: c.contactExternalId,
    started_at: c.startedAt,
    duration_seconds: c.durationSeconds,
    over_two_minutes: c.durationSeconds > thresholdSeconds,
  }));
  const apptRows: AppointmentRow[] = batch.appointments.map((a) => ({
    id: a.acuity_appointment_id,
    contact_id: null,
    calendar_id: a.calendarId,
    appointment_type: a.appointmentType,
    appointment_datetime: a.appointmentDatetime,
    created_at: a.createdAt,
    status: a.status,
    cancelled: a.cancelled,
    // attribute via phone/email fallbacks
    client_phone: a.clientPhone,
    client_email: a.clientEmail,
  } as AppointmentRow & { client_phone: string; client_email: string }));

  const res = computeAttributions({ appointments: apptRows, calls: callRows, contacts: contactRows, thresholdSeconds, windowHours });
  const out = new Map<string, { callExternalId: string | null; method: string }>();
  for (const attr of res.attributions) {
    out.set(attr.appointment_id, { callExternalId: attr.call_id, method: attr.method });
  }
  return out;
}

export type { BlockedTimeRow, AttributionRow };
