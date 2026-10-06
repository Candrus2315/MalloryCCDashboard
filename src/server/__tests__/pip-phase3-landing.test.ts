/**
 * PIP PHASE 3 — server-side attention-queue derivations on the landing
 * (MemoryStore always; PgStore when TEST_DATABASE_URL is set — the
 * pip-store.test.ts playbook). The known Phase-3 gap: "awaiting
 * acknowledgment" and "weekly minimums missed" must be derived in the SERVER
 * data layer, never approximated client-side.
 *
 * Under test (owner directive 9/30 — no second calc engine, no AI):
 *  - weeks_missed comes through pipEvidenceCore — the ONE evidence engine —
 *    its per-week `met` flags are the hard-minimum evaluation (never averaged;
 *    only COMPLETED weeks evaluate; in-progress/future never count);
 *  - ack_awaiting = issued && manager_acked_at == null (the manager records
 *    acknowledgment — no employee logins);
 *  - the attention ladder surfaces the highest-priority derived rule, with
 *    minimum_missed (2) above awaiting_ack (4);
 *  - not-evaluable cases (no minimum / no review window) degrade to null —
 *    never a silent 0;
 *  - review_week_index = the SAME mondaysInRange list the evidence engine
 *    uses, so the workspace label and the weekly goal-met table agree.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { performanceLandingCore } from "../pip-api";
import type { AttributionRow } from "../metrics/compute";
import type { Store } from "../store/types";

/**
 * Deterministic seeded battery. Weeks: w1 (5 attributed wins), w2 (1 win,
 * today sits inside it), review window = w1..w2-end (2 full weeks).
 * Returns the created ids so the pg variant cleans up every test row.
 */
async function runLandingBattery(makeStore: () => Store): Promise<{ pipIds: string[]; userIds: string[] }> {
  const pipIds: string[] = [];
  const userIds: string[] = [];
  const store = makeStore();
  const stamp = Date.now();
  await store.upsertUsers([
    {
      provider: "highlevel",
      external_id: `test-pip3-${stamp}`,
      name: `PIP Phase3 Rep ${stamp}`,
      email: `pip3-${stamp}@example.com`,
      is_active: true,
      call_start_date: null,
    },
  ]);
  const rep = (await store.getAllUsers()).find((u) => u.external_id === `test-pip3-${stamp}`)!;
  userIds.push(rep.id);

  // Scope: seed rows satisfy the store's OWN Acuity scope config (same read
  // the engine chain applies — no test bypass of appointmentInScope).
  const scopeSettings = await store.getSettings();
  const seedCalendar = scopeSettings.acuity?.calendars_included?.[0] ?? null;
  const seedType = scopeSettings.acuity?.types_included?.[0] ?? "Animalia Session";

  // Monday of a Monday..Sunday two-week review window, anchored safely in the
  // past relative to the injected `today` (a Wednesday inside w2).
  const today = "2026-09-30"; // a Wednesday
  const w2 = "2026-09-28"; // Monday of today's week
  const w1 = "2026-09-21"; // the previous Monday
  const w2End = "2026-10-04";

  const apptSeqs: { n: number; winDate: string }[] = [];
  let seq = 0;
  const add = (winDate: string) => apptSeqs.push({ n: ++seq, winDate });
  for (let i = 0; i < 5; i++) add(w1); // week 1: 5 wins
  add(w2); // week 2 (in progress): 1 win
  await store.upsertAppointments(
    apptSeqs.map(({ n, winDate }) =>
      ({
        id: `pip3-${stamp}-${n}`,
        contact_id: null,
        calendar_id: seedCalendar,
        appointment_type: seedType,
        appointment_datetime: `${winDate}T14:00:00.000Z`,
        created_at: `${winDate}T14:00:00.000Z`,
        created_business_date: winDate,
        raw: { paid: "yes", price: "300.00", amountPaid: "300.00" },
        status: "scheduled",
        cancelled: false,
        acuity_appointment_id: `pip3-${stamp}-${n}`,
        payment_state: "paid",
        booking_win_business_date: winDate,
      }) as unknown as Parameters<Store["upsertAppointments"]>[0][number],
    ),
  );
  const overlap = await store.getAppointmentsOverlapping(
    new Date(Date.parse(`${w1}T00:00:00.000Z`)).toISOString(),
    new Date(Date.parse(`${w2End}T23:59:59.000Z`)).toISOString(),
  );
  const internalId = (acuityId: string) => overlap.find((a) => a.acuity_appointment_id === acuityId)!.id;
  await store.upsertAttributions(
    apptSeqs.map(({ n }, i) => ({
      id: `pip3-attr-${stamp}-${i}`,
      appointment_id: internalId(`pip3-${stamp}-${n}`),
      call_id: null,
      rep_id: rep.id,
      method: "manual",
      confidence: 1,
      manual_override: true,
      note: "pip phase3 landing test seed",
    })) as unknown as AttributionRow[],
  );

  const mkIssued = async (title: string, weeklyGoalMin: number | null) => {
    const draft = await store.createPip({
      rep_id: rep.id,
      title,
      goal_text: "Reach the weekly minimum in every review week.",
      weekly_goal_min: weeklyGoalMin,
      hard_weekly_minimum: true,
      review_start_date: w1,
      review_end_date: w2End,
      pip_start_date: w1,
      pip_end_date: w2End,
      created_by: "christopher",
    });
    return store.issuePip(draft.id, { issuedBy: "christopher" });
  };

  // A: min 3 — week 1 met (5 ≥ 3); week 2 in progress (1 so far, not evaluated).
  const pipA = await mkIssued("Phase3 A — met week 1", 3);
  // B: min 8 — week 1 missed (5 < 8).
  const pipB = await mkIssued("Phase3 B — week 1 missed", 8);
  // C: no minimum — not evaluable, weeks_missed null, nothing invented.
  const pipC = await mkIssued("Phase3 C — no weekly minimum", null);
  // D: draft — no attention, no ack state, ever.
  const pipD = await store.createPip({ rep_id: rep.id, title: "Phase3 D — draft", created_by: "christopher" });
  pipIds.push(pipA.id, pipB.id, pipC.id, pipD.id);

  const landing = await performanceLandingCore(store, { today });
  const byId = new Map(landing.pips.map((p) => [p.id, p]));

  const A = byId.get(pipA.id)!;
  expect(A.status).toBe("issued");
  // review window w1..w2End covers both Mondays; today (Wed) sits in week 2.
  expect(A.review_week_index).toBe(2);
  expect(A.review_weeks_total).toBe(2);
  expect(A.weeks_missed).toBe(0); // evaluated: week 1 met, week 2 in progress
  expect(A.ack_awaiting).toBe(true); // issued, manager_acked_at null
  expect(A.this_week_wins).toBe(1); // the w2 win, through the current-week chain
  expect(A.attention?.code).toBe("awaiting_ack");
  expect(A.attention?.text).toBe(`Acknowledgment not yet recorded — ${rep.name}`);

  const B = byId.get(pipB.id)!;
  expect(B.weeks_missed).toBe(1); // week 1: 5 < 8 — hard per-week, never averaged
  expect(B.attention?.code).toBe("minimum_missed");
  expect(B.attention?.text).toBe(`Weekly minimum missed in 1 completed week — ${rep.name}`);

  const C = byId.get(pipC.id)!;
  expect(C.weeks_missed).toBeNull(); // no minimum → not evaluable — never a fake 0
  expect(C.attention?.code).toBe("awaiting_ack"); // the only signal left
  expect(C.review_week_index).toBe(2);

  const D = byId.get(pipD.id)!;
  expect(D.status).toBe("draft");
  expect(D.ack_awaiting).toBe(false); // drafts never raise ack state
  expect(D.attention).toBeNull();
  expect(D.weeks_missed).toBeNull();
  expect(D.review_week_index).toBeNull(); // no review window on the draft

  // KPIs unchanged by Phase 3: active/drafts counts only.
  expect(landing.kpis.active).toBe(3);
  expect(landing.kpis.drafts).toBe(1);
  expect(landing.kpis.checkins_due).toBe(0);

  // Completion records the manager acknowledgment → ack_awaiting clears.
  await store.completePip(pipA.id, {
    conclusionCategory: "Successful completion",
    conclusionNotes: "Week met the minimum.",
    actor: "christopher",
  });
  const after = await performanceLandingCore(store, { today });
  const A2 = after.pips.find((p) => p.id === pipA.id)!;
  expect(A2.status).toBe("completed");
  expect(A2.ack_awaiting).toBe(false);
  expect(A2.attention).toBeNull(); // closed plans never raise attention
  return { pipIds, userIds };
}

describe("PIP Phase 3 server derivations — MemoryStore", () => {
  test("weeks_missed via the evidence engine + awaiting-ack on the landing", async () => {
    await runLandingBattery(() => new MemoryStore());
  });
});

const RESTART = process.env.TEST_DATABASE_URL;

describe.skipIf(!RESTART)("PIP Phase 3 server derivations — PgStore (real Postgres)", () => {
  test("weeks_missed via the evidence engine + awaiting-ack on the landing", async () => {
    const { PgStore } = await import("../store/pg");
    const store = new PgStore(RESTART!);
    await store.ensureSchema();
    let created: { pipIds: string[]; userIds: string[] } = { pipIds: [], userIds: [] };
    try {
      created = await runLandingBattery(() => store);
    } finally {
      const { pipIds, userIds } = created;
      const { default: postgres } = await import("postgres");
      const sql = postgres(RESTART!, { max: 1, ...(RESTART!.includes("sslmode=") ? {} : { ssl: "require" }) });
      try {
        if (pipIds.length) {
          await sql`DELETE FROM pip_event_log WHERE pip_id = ANY(${pipIds})`;
          await sql`DELETE FROM pip_evidence_snapshots WHERE pip_id = ANY(${pipIds})`;
          await sql`DELETE FROM pip_checkins WHERE pip_id = ANY(${pipIds})`;
          await sql`DELETE FROM manual_overrides WHERE entity_type = 'pip' AND entity_id = ANY(${pipIds})`;
          await sql`DELETE FROM pips WHERE id = ANY(${pipIds})`;
        }
        if (userIds.length) {
          await sql`DELETE FROM users WHERE id = ANY(${userIds})`;
        }
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  }, 90_000);
});
