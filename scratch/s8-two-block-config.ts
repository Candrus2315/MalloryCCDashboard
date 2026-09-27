/**
 * S8 TWO-BLOCK DAILY SCHEDULE (owner directive 2026-09-27) — live config update.
 * Replaces the interim hack (slot_interval_min=50 + single 10:00–18:00 block/day)
 * with the REAL studio schedule: every weekday two active blocks
 * 09:00–13:00 + 13:30–18:30, slot_interval_min=60, appointment duration stays 60.
 * Writes app_settings(key='app').studio AND the availability_rules mirror
 * (REPLACE semantics — stale interim rows cannot survive), then reads both
 * back and computes Monday through the real engine as verification.
 */
import { getStore } from "../src/server/store";
import { computeDayAvailability } from "../src/server/metrics/availability";

const blocks = (weekday: number) => [
  { weekday, open_time: "09:00", close_time: "13:00", active: true },
  { weekday, open_time: "13:30", close_time: "18:30", active: true },
];
const hours = [0, 1, 2, 3, 4, 5, 6].flatMap(blocks);

const store = await getStore();
const before = await store.getSettings();
console.log("BEFORE:", JSON.stringify({
  slot_interval_min: before.studio.slot_interval_min,
  appointment_duration_min: before.studio.appointment_duration_min,
  padding_min: before.studio.padding_min,
  hours_count: before.studio.hours.length,
  hours_summary: before.studio.hours.map((h) => `${h.weekday}:${h.open_time}-${h.close_time}:${h.active ? "on" : "off"}`),
}));

await store.saveSettings({
  studio: {
    ...before.studio,
    slot_interval_min: 60,
    appointment_duration_min: 60, // stays 60 (idempotent with the directive)
    hours,
  },
});
await store.upsertAvailabilityRules(hours);

const after = await store.getSettings();
const mirror = await store.getAvailabilityRules();
console.log("AFTER:", JSON.stringify({
  slot_interval_min: after.studio.slot_interval_min,
  appointment_duration_min: after.studio.appointment_duration_min,
  padding_min: after.studio.padding_min,
  hours_count: after.studio.hours.length,
  hours_weekdays: [...new Set(after.studio.hours.map((h) => h.weekday))].sort(),
  mirror_rows: mirror.length,
  mirror_first4: mirror.slice(0, 4),
}));

// engine check on the STORED config: Monday through computeDayAvailability
const rules = mirror.length > 0 ? mirror : after.studio.hours;
const mon = computeDayAvailability({
  date: "2026-09-28",
  rules,
  blocked: [],
  appointments: [],
  slotIntervalMin: after.studio.slot_interval_min,
  durationMin: after.studio.appointment_duration_min,
  paddingMin: after.studio.padding_min,
});
console.log("MONDAY_FROM_STORED:", JSON.stringify(mon));
const ok =
  mon.totalCapacity === 9 &&
  JSON.stringify(mon.openSlotTimes) ===
    JSON.stringify(["9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "1:30 PM", "2:30 PM", "3:30 PM", "4:30 PM", "5:30 PM"]);
console.log("CONFIG_OK:", ok);
process.exit(ok ? 0 : 1);
