import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/availability")({
  component: StubPage,
});

const SECTIONS = [
  "By selected date: Total Capacity · Booked Slots · Open Slots · Utilization % · Specific Open Times",
  "COPY AVAILABILITY → e.g. “Saturday Availability — 4 appointments remaining: 10:00 AM, 12:30 PM, 3:00 PM, 5:30 PM”",
  "Acuity direct availability when provided; otherwise computed from studio hours, duration, slot interval, existing appointments, blocked times, padding (all editable in Settings)",
];

function StubPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Availability</h1>
        <p className="mt-0.5 text-sm text-stone-400">Acuity studio availability — planned next phase. Today already shows open slots for today/tomorrow using the slot engine.</p>
      </div>
      <div className="card">
        <p className="section-title mb-3">Planned structure</p>
        <ul className="space-y-2 text-[13px] text-stone-600">
          {SECTIONS.map((s) => (
            <li key={s} className="border-b border-stone-100 pb-2 last:border-0 last:pb-0">
              {s}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
