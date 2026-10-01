/**
 * PIP EVIDENCE ENGINE (Phase 2) — per-week verified numbers, seeded battery on
 * BOTH stores (MemoryStore always; PgStore with TEST_DATABASE_URL, rows cleaned
 * up in finally — the pip-store.test.ts playbook).
 *
 * What is under test (owner directive 9/30 — no second calc engine):
 *  - every number comes through the SAME chain the pages use (win-bucket
 *    selector → scope → eligibility → bookingsByRep; resolveRepGoal per week);
 *  - dashboard goal provenance: rep-goal when set, else team-share (default 79
 *    when no team-goal row), with basis + note captured per week;
 *  - paid-deposit rule: unpaid/pending rows NEVER count; unattributed/online
 *    paid wins NEVER count toward the rep (team totals only);
 *  - week states: completed → met evaluated against the PIP's weekly minimum
 *    (hard per-week comparison, never averaged); in-progress → partial count,
 *    met null; FUTURE → actual NULL (honest "—", never 0, never estimated);
 *  - aggregate shape: weeks_completed / weeks_goal_met / hit rate / totals;
 *  - structure guards (bad dates, unknown rep) throw before any computation;
 *  - LIVE sanity anchor (pg): team week 9/21–27 = 62 paid bookings.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { PgStore } from "../store/pg";
import { pipDateShort, pipEvidenceCore, pipGoalLabel } from "../pip-evidence";
import { statementsFromEvidence } from "../pip-statements";
import { isBookingWin, resolveRepGoal } from "../metrics/compute";
import type { AttributionRow, AppointmentRow } from "../metrics/compute";
import type { Store } from "../store/types";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Deterministic seeded battery — one function, run against each store. */
async function runEvidenceBattery(
  makeStore: () => Store,
  cfg: {
    reviewStart: string; // a Monday
    reviewEnd: string; // a Sunday, 4 full weeks later
    weeks: string[]; // the 4 Mondays
    today: string; // injected ET today (a Wednesday inside week 3)
    /** UTC window for internal-id resolution via getAppointmentsOverlapping (spans all seeded appointment_datetimes). */
    resolveWindowUtc: [string, string];
    /** MemoryStore variant seeds goals; the pg variant resolves against live goal rows. */
    seedGoals: boolean;
  },
  cleanup?: (ctx: { userIds: string[] }) => Promise<void>,
): Promise<void> {
  const { reviewStart, reviewEnd, weeks, today, seedGoals } = cfg;
  const [w1, w2, w3, w4] = weeks;
  const store = makeStore();
  const userIds: string[] = [];
  try {
    const stamp = Date.now();
    await store.upsertUsers([
      { provider: "highlevel", external_id: `test-pip-ev-a-${stamp}`, name: `PIP Evidence Rep A ${stamp}`, email: `pip-ev-a-${stamp}@example.com`, is_active: true, call_start_date: null },
      { provider: "highlevel", external_id: `test-pip-ev-b-${stamp}`, name: `PIP Evidence Rep B ${stamp}`, email: `pip-ev-b-${stamp}@example.com`, is_active: true, call_start_date: null },
    ]);
    const users = await store.getAllUsers();
    const repA = users.find((u) => u.external_id === `test-pip-ev-a-${stamp}`)!;
    const repB = users.find((u) => u.external_id === `test-pip-ev-b-${stamp}`)!;
    userIds.push(repA.id, repB.id);

    // ---- wins: 5 repA + 1 repB + 2 unattributed-online paid + 1 pending(repA) in week 1; 7 repA week 2; 2 repA week 3 (in progress); week 4 future
    // Seed rows satisfy the store's OWN Acuity scope config (the same settings
    // read the pages use) — on the live DB the scope includes calendars and
    // would otherwise filter out rows with no calendar id (honest scope, not a
    // test bypass: appointmentInScope is part of the engine chain under test).
    const scopeSettings = await store.getSettings();
    const seedCalendar = scopeSettings.acuity?.calendars_included?.[0] ?? null;
    const seedType = scopeSettings.acuity?.types_included?.[0] ?? "Animalia Session";
    const apptSeqs: { seq: number; winDate: string; paid: boolean }[] = [];
    let seq = 0;
    const add = (winDate: string, paid: boolean) => apptSeqs.push({ seq: ++seq, winDate, paid });
    for (let i = 0; i < 5; i++) add(w1, true); // repA week 1 wins
    add(w1, true); // repB week 1 win
    add(w1, true); // online, stays unattributed
    add(w1, true); // online, stays unattributed
    add(w1, false); // pending (attributed but unpaid — never counts)
    for (let i = 0; i < 7; i++) add(w2, true); // repA week 2 wins
    for (let i = 0; i < 2; i++) add(w3, true); // repA week 3 partials
    const stampForSeed = stamp;
    await store.upsertAppointments(
      apptSeqs.map(({ seq: n, winDate, paid }) =>
        ({
          id: `pip-ev-${stampForSeed}-${n}`,
          contact_id: null,
          calendar_id: seedCalendar,
          appointment_type: seedType,
          appointment_datetime: `${winDate}T14:00:00.000Z`,
          created_at: `${winDate}T14:00:00.000Z`,
          created_business_date: winDate,
          raw: paid ? { paid: "yes", price: "300.00", amountPaid: "300.00" } : { paid: "no", price: "300.00" },
          status: "scheduled",
          cancelled: false,
          acuity_appointment_id: `pip-ev-${stampForSeed}-${n}`,
          payment_state: paid ? "paid" : "pending_payment",
          booking_win_business_date: paid ? winDate : null,
        }) as unknown as Parameters<Store["upsertAppointments"]>[0][number],
      ),
    );
    // Resolve INTERNAL ids (upserts ignore supplied ids) via the overlapping
    // selector — the win-bucket selector strips acuity_appointment_id, the
    // availability path carries it (same store reads the pages use).
    const overlap = await store.getAppointmentsOverlapping(cfg.resolveWindowUtc[0], cfg.resolveWindowUtc[1]);
    const internalId = (acuityId: string) => overlap.find((a) => a.acuity_appointment_id === acuityId)!.id;

    // ---- activity seeds (audit 10/1 wiring): calls + assigned leads ----
    // Calls are the SAME rows summarizeCalls/repRangeSummaries consume (all
    // attempts; over-threshold = duration > the Settings threshold, read from
    // the store so the test holds against any live threshold value).
    const th = (await store.getSettings()).meaningful_call_threshold_seconds;
    const over = (d: number) => (d > th ? 1 : 0);
    await store.upsertCalls([
      // repA week 1: 10 attempts — 6 long (300s), 4 short (45s)
      ...Array.from({ length: 6 }, (_, i) => ({
        external_call_id: `pip-ev-call-${stamp}-ov-${i}`, provider: "highlevel", rep_id: repA.id, contact_id: null,
        started_at: `${w1}T15:00:00.000Z`, duration_seconds: 300, over_two_minutes: true,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        external_call_id: `pip-ev-call-${stamp}-sh-${i}`, provider: "highlevel", rep_id: repA.id, contact_id: null,
        started_at: `${w1}T16:00:00.000Z`, duration_seconds: 45, over_two_minutes: false,
      })),
      // repA week 2: 2 attempts, both long; week 3 (in progress): 1 short
      ...Array.from({ length: 2 }, (_, i) => ({
        external_call_id: `pip-ev-call-${stamp}-w2-${i}`, provider: "highlevel", rep_id: repA.id, contact_id: null,
        started_at: `${w2}T15:00:00.000Z`, duration_seconds: 300, over_two_minutes: true,
      })),
      {
        external_call_id: `pip-ev-call-${stamp}-w3`, provider: "highlevel", rep_id: repA.id, contact_id: null,
        started_at: `${w3}T15:00:00.000Z`, duration_seconds: 45, over_two_minutes: false,
      },
      // repB week 1 long call — must NOT leak into repA's counts
      {
        external_call_id: `pip-ev-call-${stamp}-b`, provider: "highlevel", rep_id: repB.id, contact_id: null,
        started_at: `${w1}T17:00:00.000Z`, duration_seconds: 300, over_two_minutes: true,
      },
    ]);
    const seededCalls = await store.getCallsBetween(
      new Date(Date.parse(`${w1}T00:00:00.000Z`)).toISOString(),
      new Date(Date.parse(`${w3}T23:59:59.000Z`)).toISOString(),
    );
    const joinedCallId = seededCalls.find((c) => c.external_call_id === `pip-ev-call-${stamp}-ov-0`)!.id;
    await store.upsertLeads([
      ...Array.from({ length: 3 }, (_, i) => ({
        source_id: `pip-ev-lead-${stamp}-w1-${i}`, provider: "google_sheets", lead_type: "family", source_sheet: "family",
        work_date: w1, contact_id: null, assigned_rep_id: repA.id, name: null, phone: null, email: null,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        source_id: `pip-ev-lead-${stamp}-w2-${i}`, provider: "google_sheets", lead_type: "family", source_sheet: "family",
        work_date: w2, contact_id: null, assigned_rep_id: repA.id, name: null, phone: null, email: null,
      })),
      {
        source_id: `pip-ev-lead-${stamp}-b`, provider: "google_sheets", lead_type: "family", source_sheet: "family",
        work_date: w1, contact_id: null, assigned_rep_id: repB.id, name: null, phone: null, email: null,
      },
      {
        source_id: `pip-ev-lead-${stamp}-un`, provider: "google_sheets", lead_type: "family", source_sheet: "family",
        work_date: w1, contact_id: null, assigned_rep_id: null, name: null, phone: null, email: null,
      },
    ]);

    const attrRows: AttributionRow[] = apptSeqs
      // repA's wins (seqs 1–5, 10–18) + repB's (6) + the pending row (9,
      // attributed but unpaid — never counts); the two online rows (7,8) stay UNATTRIBUTED.
      .filter(({ seq: n }) => n !== 7 && n !== 8)
      .map(({ seq: n }, i) => ({
        id: `pip-ev-attr-${stampForSeed}-${i}`,
        appointment_id: internalId(`pip-ev-${stampForSeed}-${n}`),
        // Week-1 win #1 rides an OVER-THRESHOLD call — the conversation-
        // conversion join (bookingsFromOverThresholdCalls) needs this to have
        // a non-null numerator; every other attribution stays call-less.
        call_id: n === 1 ? joinedCallId : null,
        rep_id: n === 6 ? repB.id : repA.id,
        method: "manual",
        confidence: 1,
        manual_override: true,
        note: "pip evidence test seed",
      }));
    await store.upsertAttributions(attrRows);

    // Goals (memory variant): team goal week 1 = 80 (→ 40 share for 2 reps),
    // repA goal week 2 = 15, team goal week 3 = 100 (the current week at issue
    // time — the header's provenance context), week 4 unset (default 79).
    if (seedGoals) {
      await store.upsertTeamGoal({ week_start: w1, booking_goal: 80, lead_budget: 700 });
      await store.upsertTeamGoal({ week_start: w3, booking_goal: 100, lead_budget: 700 });
      await store.upsertRepGoals([{ rep_id: repA.id, week_start: w2, goal: 15 }]);
    }

    const e = await pipEvidenceCore(store, {
      repId: repA.id,
      reviewStart,
      reviewEnd,
      weeklyGoalMin: 6,
      hardWeeklyMinimum: true,
      today,
    });

    // ---- header shape ----
    expect(e.rep_id).toBe(repA.id);
    expect(e.rep_name).toBe(`PIP Evidence Rep A ${stamp}`);
    expect(e.review_start).toBe(reviewStart);
    expect(e.review_end).toBe(reviewEnd);
    expect(e.current_week_start).toBe(w3);
    expect(e.hard_weekly_minimum).toBe(true);
    expect(Array.isArray(e.warnings)).toBe(true);

    // ---- weekly rows: states, actuals, met (hard per-week, never averaged) ----
    expect(e.weekly.map((w) => w.week_start)).toEqual(weeks);
    expect(e.weekly.map((w) => w.state)).toEqual(["completed", "completed", "in_progress", "future"]);
    // Paid-deposit rule + attribution rule: 5 attributed wins (pending + online never count).
    expect(e.weekly.map((w) => w.actual)).toEqual([5, 7, 2, null]); // future = null, never 0
    expect(e.weekly.map((w) => w.pip_goal)).toEqual([6, 6, 6, 6]);
    expect(e.weekly.map((w) => w.met)).toEqual([false, true, null, null]); // in-progress not yet evaluated
    expect(e.weekly.map((w) => [w.clamped_start, w.clamped_end])).toEqual([
      [w1, cfgWeekEnd(w1)],
      [w2, cfgWeekEnd(w2)],
      [w3, cfgWeekEnd(w3)],
      [w4, cfgWeekEnd(w4)],
    ]);

    // ---- dashboard goal + provenance (resolveRepGoal — rep goal > team share > default 79) ----
    if (seedGoals) {
      expect(e.rep_count).toBe(2);
      expect(e.weekly[0].dashboard_goal).toBe(40); // 80/2
      expect(e.weekly[0].dashboard_goal_basis).toBe("team-share");
      expect(e.weekly[0].dashboard_goal_note).toBe("team goal share — weekly team goal ÷ 2 reps");
      expect(e.weekly[1].dashboard_goal).toBe(15);
      expect(e.weekly[1].dashboard_goal_basis).toBe("rep-goal");
      expect(e.weekly[1].dashboard_goal_note).toBe("rep goal · week of " + w2);
    } else {
      // pg variant: resolve against whatever goal rows LIVE for those far-out weeks
      // (asserted from store reads, so the test holds whether or not a row exists).
      for (const [i, week] of weeks.entries()) {
        const teamRow = await store.getTeamGoal(week);
        const expected = (teamRow?.booking_goal ?? 79) / e.rep_count;
        expect(e.weekly[i].dashboard_goal).toBe(expected);
        expect(e.weekly[i].dashboard_goal_basis).toBe("team-share");
        expect(e.weekly[i].dashboard_goal_note).toBe("team goal share — weekly team goal ÷ " + e.rep_count + " reps");
      }
    }
    // current week = week 3 (the in-progress one). The battery seeds a team
    // goal for the CURRENT week (100 → 50 across 2 reps), so the header
    // resolves WITH provenance — the dashboard goal in force at issue time.
    if (seedGoals) {
      expect(e.current_week_start).toBe(w3);
      expect(e.current_dashboard_goal).toEqual({ value: 50, basis: "team-share", note: "team goal share — weekly team goal ÷ 2 reps" });
    } else {
      // pg variant: far-out week. Pin the engine's honest-null gate — the
      // header goal is null when NOTHING is in force for the current week
      // (no rep-goal row, no team-goal row), resolved from store reads so
      // the test holds whether or not a live row ever lands on that week.
      const [repRows3, teamRow3] = await Promise.all([store.getRepGoals(w3), store.getTeamGoal(w3)]);
      const repMap = new Map(repRows3.filter((g) => g.rep_id === repA.id).map((g) => [g.week_start, g.goal]));
      const teamMap = new Map(teamRow3 ? [[teamRow3.week_start, teamRow3.booking_goal]] : []);
      const expectedHeader = repMap.has(w3) || teamMap.has(w3)
        ? resolveRepGoal({ weeks: [w3], repGoalsByWeek: repMap, teamGoalByWeek: teamMap, repCount: e.rep_count })
        : null;
      expect(e.current_dashboard_goal).toEqual(expectedHeader);
    }

    // ---- aggregate shape ----
    expect(e.weeks_completed).toBe(2);
    expect(e.weeks_goal_met).toBe(1);
    expect(e.goal_hit_rate_pct).toBe(50);
    expect(e.total_wins_to_date).toBe(14); // 5 + 7 + 2 (partials count; future null adds nothing)
    expect(e.total_wins_completed_weeks).toBe(12);

    // ---- activity metrics (audit 10/1 wiring — SAME repRangeSummaries, windowed) ----
    // Calls = ALL attempts; >2min per the store's own threshold; conversion =
    // calls>2min → paid wins via attribution call_id (1 joined win); assigned
    // leads = work-date cohort; repB's call/lead must not leak into repA.
    expect(e.call_threshold_seconds).toBe(th);
    const w1a = e.weekly[0].activity!;
    expect(w1a.calls).toBe(10);
    expect(w1a.assigned_leads).toBe(3);
    expect(e.weekly[1].activity!.calls).toBe(2);
    expect(e.weekly[1].activity!.assigned_leads).toBe(2);
    expect(e.weekly[2].activity!.calls).toBe(1);
    expect(e.weekly[2].activity!.assigned_leads).toBe(0);
    expect(e.weekly[2].activity!.assigned_lead_conversion).toBeNull(); // no assigned leads → null, never 0
    expect(e.weekly[3].activity).toBeNull(); // future week: not yet evaluable
    expect(e.activity.calls).toBe(13);
    expect(e.activity.assigned_leads).toBe(5);
    if (th < 300) {
      // 6 + 2 long calls (300s) clear any sane threshold; 45s attempts never do.
      expect(w1a.calls_over_2min).toBe(6);
      expect(w1a.conversation_conversion).toBeCloseTo(1 / 6, 5); // 1 joined win ÷ 6 over-threshold calls
      expect(w1a.assigned_lead_conversion).toBeCloseTo(5 / 3, 5); // 5 wins ÷ 3 assigned leads
      expect(e.weekly[1].activity!.calls_over_2min).toBe(2);
      expect(e.weekly[1].activity!.conversation_conversion).toBe(0); // 2 over-threshold calls, 0 joined wins
      expect(e.weekly[2].activity!.calls_over_2min).toBe(0);
      expect(e.weekly[2].activity!.conversation_conversion).toBeNull(); // denominator 0 → null
      expect(e.activity.calls_over_2min).toBe(8);
      expect(e.activity.conversation_conversion).toBeCloseTo(1 / 8, 5);
      expect(e.activity.assigned_lead_conversion).toBeCloseTo(14 / 5, 5);
    }

    // ---- statements off the same payload (the issue path freezes THESE) ----
    const statements = statementsFromEvidence(e);
    expect(statements.map((s) => s.key)).toEqual(["goal_weeks", "total_wins", "best_week", "first_week", "hard_minimum"]);
    expect(statements.find((s) => s.key === "total_wins")!.text).toBe(
      `Across the 2 completed work week(s) reviewed (${pipDateShort(reviewStart)} – ${pipDateShort(cfgWeekEnd(w2))}), ` +
        `PIP Evidence Rep A ${stamp} was credited with 12 paid booking(s).`,
    );
    expect(statements.find((s) => s.key === "best_week")!.text).toBe(
      `The highest weekly total in the reviewed weeks was 7 paid booking(s), in the week of ${pipDateShort(w2)} – ${pipDateShort(cfgWeekEnd(w2))}.`,
    );
  } finally {
    if (cleanup) await cleanup({ userIds });
  }
}

/** Sunday of a stored Monday (local helper — addDays is the engine's own import in pip-evidence). */
function cfgWeekEnd(mon: string): string {
  const d = new Date(Date.parse(`${mon}T12:00:00Z`));
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

describe("pipEvidenceCore — MemoryStore (seeded scenario)", () => {
  test("per-week evidence: paid-deposit + attribution rules, goal provenance, states, aggregates, statements", async () => {
    // Review 2026-09-28 → 2026-10-25 (4 Mon–Sun weeks); ET today 2026-10-14 (Wed, week 3).
    await runEvidenceBattery(() => new MemoryStore(), {
      reviewStart: "2026-09-28",
      reviewEnd: "2026-10-25",
      weeks: ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"],
      today: "2026-10-14",
      resolveWindowUtc: ["2026-09-27T00:00:00.000Z", "2026-10-18T00:00:00.000Z"],
      seedGoals: true,
    });
  });
  test("structure guards throw before any computation (bad dates, unknown rep)", async () => {
    const store = new MemoryStore();
    await expect(
      pipEvidenceCore(store, { repId: "nobody", reviewStart: "9/28/2026", reviewEnd: "2026-10-25", weeklyGoalMin: 6, hardWeeklyMinimum: true }),
    ).rejects.toThrow(/YYYY-MM-DD/);
    await expect(
      pipEvidenceCore(store, { repId: "nobody", reviewStart: "2026-10-25", reviewEnd: "2026-09-28", weeklyGoalMin: 6, hardWeeklyMinimum: true }),
    ).rejects.toThrow(/cannot precede/i);
    await expect(
      pipEvidenceCore(store, { repId: "nobody", reviewStart: "2026-09-28", reviewEnd: "2026-10-25", weeklyGoalMin: 6, hardWeeklyMinimum: true }),
    ).rejects.toThrow(/Unknown rep/i);
  });
  test("pure formatters: ET short dates + goal labels (integers plain, fractions 1 decimal)", () => {
    expect(pipDateShort("2026-09-21")).toBe("Sep 21");
    expect(pipDateShort("2026-10-04")).toBe("Oct 4");
    expect(pipGoalLabel(12)).toBe("12");
    expect(pipGoalLabel(39.5)).toBe("39.5");
    expect(pipGoalLabel(39.25)).toBe("39.3");
  });
  test("no goals in force: header goal honest-null, weekly rows keep the documented 79-default fallback", async () => {
    const store = new MemoryStore();
    const stamp = Date.now();
    await store.upsertUsers([
      { provider: "highlevel", external_id: `test-pip-ev-ng-a-${stamp}`, name: `PIP NoGoals Rep A ${stamp}`, email: `pip-ev-ng-a-${stamp}@example.com`, is_active: true, call_start_date: null },
      { provider: "highlevel", external_id: `test-pip-ev-ng-b-${stamp}`, name: `PIP NoGoals Rep B ${stamp}`, email: `pip-ev-ng-b-${stamp}@example.com`, is_active: true, call_start_date: null },
    ]);
    const rep = (await store.getAllUsers()).find((u) => u.external_id === `test-pip-ev-ng-a-${stamp}`)!;
    const e = await pipEvidenceCore(store, {
      repId: rep.id,
      reviewStart: "2026-09-28",
      reviewEnd: "2026-10-25",
      weeklyGoalMin: 6,
      hardWeeklyMinimum: true,
      today: "2026-10-14",
    });
    // Header: NOTHING in force for the current week → null. The engine's
    // has() gate refuses to present a silently-defaulted number where
    // provenance matters (the goal in force at issue time).
    expect(e.rep_count).toBe(2);
    expect(e.current_dashboard_goal).toBeNull();
    // Weekly rows still resolve through the SAME chain — the documented 79
    // team-goal default as an even share, with its provenance intact.
    for (const w of e.weekly) {
      expect(w.dashboard_goal).toBe(39.5); // 79 ÷ 2 active reps
      expect(w.dashboard_goal_basis).toBe("team-share");
      expect(w.dashboard_goal_note).toBe("team goal share — weekly team goal ÷ 2 reps");
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("pipEvidenceCore — PgStore (real Postgres)", () => {
  test("same seeded battery against the live schema (far-out 2027 weeks; goals resolved from store reads)", async () => {
    const store = new PgStore(TEST_DATABASE_URL!);
    await store.ensureSchema();
    // The battery seeds appointments/attributions/test-reps; cleanup removes
    // exactly those rows (test markers — live data untouched).
    await runEvidenceBattery(
      () => store,
      {
        reviewStart: "2027-01-04",
        reviewEnd: "2027-01-31",
        weeks: ["2027-01-04", "2027-01-11", "2027-01-18", "2027-01-25"],
        today: "2027-01-20",
        resolveWindowUtc: ["2027-01-03T00:00:00.000Z", "2027-01-27T00:00:00.000Z"],
        seedGoals: false, // never write goals on the live DB — resolve against store reads
      },
      async ({ userIds }) => {
        const { default: postgres } = await import("postgres");
        const sql = postgres(TEST_DATABASE_URL!, { max: 1, ...(TEST_DATABASE_URL!.includes("sslmode=") ? {} : { ssl: "require" }) });
        try {
          await sql`DELETE FROM booking_attributions WHERE appointment_id IN (SELECT id FROM appointments WHERE acuity_appointment_id LIKE 'pip-ev-%')`;
          await sql`DELETE FROM manual_overrides WHERE entity_id IN (SELECT id::text FROM appointments WHERE acuity_appointment_id LIKE 'pip-ev-%')`;
          await sql`DELETE FROM appointments WHERE acuity_appointment_id LIKE 'pip-ev-%'`;
          await sql`DELETE FROM calls WHERE external_call_id LIKE 'pip-ev-call-%'`;
          await sql`DELETE FROM manual_overrides WHERE entity_id IN (SELECT id::text FROM calls WHERE external_call_id LIKE 'pip-ev-call-%')`;
          await sql`DELETE FROM leads WHERE source_id LIKE 'pip-ev-lead-%'`;
          await sql`DELETE FROM rep_goals WHERE rep_id = ANY(${userIds})`;
          if (userIds.length) {
            await sql`DELETE FROM manual_overrides WHERE entity_type = 'user' AND entity_id = ANY(${userIds})`;
            await sql`DELETE FROM users WHERE id = ANY(${userIds})`;
          }
        } finally {
          await sql.end({ timeout: 5 });
        }
      },
    );
  }, 90_000);

  test("LIVE sanity anchor: team week 2026-09-21 – 2026-09-27 = 62 paid bookings (win-bucket + paid rule)", async () => {
    const store = new PgStore(TEST_DATABASE_URL!);
    const rows = await store.getAppointmentsByWinBusinessDateBetween("2026-09-21", "2026-09-27");
    expect(rows.filter(isBookingWin)).toHaveLength(62);
  }, 60_000);
});
