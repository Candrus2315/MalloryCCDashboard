/**
 * SEED THE FIVE MALLORY PIP TEMPLATES (refinement spec §4, lead-approved
 * Part 4). Idempotent: a template whose name already exists is SKIPPED, so
 * re-running never duplicates. Every creation goes through the store
 * (createPipTemplate) — the module audit trail records pip_template_created
 * for each, exactly as a manager-created template would.
 *
 * Run: bun /home/team/shared/site/scripts/pip-seed-templates.ts
 */
import { PgStore } from "../src/server/store/pg";
import { createPipTemplateCore } from "../src/server/pip-api";
import { getSecret } from "../src/server/env";

const url = getSecret("DATABASE_URL");
if (!url) {
  console.error("DATABASE_URL not resolvable — aborted, nothing written.");
  process.exit(1);
}
const store = new PgStore(url);

const T = (items: string[]) => items.map((text) => ({ text, completed: false, completed_at: null }));

const TEMPLATES = [
  {
    name: "Booking Performance",
    category: "Booking",
    default_goal_text:
      "Meet or exceed the weekly paid-booking minimum for the full PIP window. Each week is evaluated individually against the weekly minimum — weeks are never averaged.",
    action: T([
      "Review the week's paid bookings against the weekly minimum at the Monday check-in.",
      "Log every client conversation and identify the step where bookings stall.",
      "Collect the required deposit at the point of booking for every appointment.",
      "Follow up every pending-payment appointment before the 18:30 pace cutoff.",
    ]),
    personal: T(["Bring one self-identified booking improvement area to each check-in."]),
    professional: T(["Shadow one booking conversation with a top-performing rep each week."]),
    cadence: 7,
    weeks: 6,
  },
  {
    name: "Conversion Performance",
    category: "Conversion",
    default_goal_text:
      "Improve conversation conversion — paid bookings from calls over the two-minute threshold — across the PIP window. Each week is evaluated individually against the weekly minimum.",
    action: T([
      "Review the week's conversation conversion (calls over 2 minutes → paid bookings) at the Monday check-in.",
      "Listen back to two recorded calls per week and note where the conversation stalls.",
      "Prepare a written talk track for the two most common stall points.",
      "Work the pending-payment list daily until each invoice is resolved.",
    ]),
    personal: T(["Set a personal weekly conversion target and review it at each check-in."]),
    professional: T(["Complete one call-review session with the manager every two weeks."]),
    cadence: 7,
    weeks: 6,
  },
  {
    name: "Call Activity",
    category: "Call activity",
    default_goal_text:
      "Reach the call activity standard every week of the PIP window: the weekly call count and calls over the two-minute threshold set in this plan. Each week is evaluated individually.",
    action: T([
      "Record the week's total calls and calls over two minutes at the Monday check-in.",
      "Block daily call time on the calendar and protect it.",
      "Work the assigned-lead list before starting new conversations each day.",
      "Escalate any lead-list gap to the manager at the weekly check-in.",
    ]),
    personal: T(["Agree a daily call-time routine with the manager at the first check-in."]),
    professional: T(["Review one recorded call with the manager every two weeks."]),
    cadence: 7,
    weeks: 6,
  },
  {
    name: "Attendance/Reliability",
    category: "Attendance",
    default_goal_text:
      "Maintain the schedule standard for the full PIP window: arrive on time for every scheduled shift and studio appointment, and give notice per the handbook for any absence. Each week is evaluated individually.",
    action: T([
      "Record attendance and punctuality at each weekly check-in.",
      "Give written notice for any scheduled absence before the shift starts.",
      "Confirm the next-day schedule in writing at the end of each shift.",
      "Raise any scheduling conflict with the manager at the earliest opportunity.",
    ]),
    personal: T(["Agree a morning routine checkpoint with the manager at the first check-in."]),
    professional: T(["Review schedule-adherence tools with the manager at the first check-in."]),
    cadence: 7,
    weeks: 4,
  },
  {
    name: "Custom",
    category: "General",
    default_goal_text:
      "Set the improvement expectation for this plan in your own words. Each week is evaluated individually against the weekly minimum.",
    action: [],
    personal: [],
    professional: [],
    cadence: 7,
    weeks: 6,
  },
];

const existing = new Set((await store.listPipTemplates()).map((t) => t.name));
for (const t of TEMPLATES) {
  if (existing.has(t.name)) {
    console.log(`SKIP (exists): ${t.name}`);
    continue;
  }
  const row = await createPipTemplateCore(store, {
    name: t.name,
    category: t.category,
    defaultGoalText: t.default_goal_text,
    defaultActionPlan: t.action,
    defaultPersonal: t.personal,
    defaultProfessional: t.professional,
    defaultCheckinCadenceDays: t.cadence,
    defaultDurationWeeks: t.weeks,
    actor: "christopher",
  });
  console.log(`CREATED: ${row.name} v${row.version} (${row.id})`);
}
console.log("DONE");
process.exit(0);
