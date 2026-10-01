/**
 * ASSIGNED LEADS BY DAY (Reps page, owner directive 2026-10-01) — seeded
 * battery on BOTH stores (MemoryStore always; PgStore with TEST_DATABASE_URL,
 * rows cleaned up in finally — the pip-evidence playbook), plus a READ-ONLY
 * live anchor test that reproduces the owner's hand-built table
 * (/home/team/shared/assigned-leads-2026-09-21-to-27-by-day.csv) from real
 * production data, week 2026-09-21..27:
 *   Allison Wittner animalia 159 / family 111; Carmine Morgano 74/119;
 *   Jennifer Stitt 47/28; Laura Rivera 28/15; Amy Clark 1/0; Lexa Brandis 1/0;
 *   Mallory Portraits Accounts 2/1; Alliance: Allison Mon 2 only;
 *   Auction: Allison Mon 8 / Thu 1 / Fri 2 / Sat 2 / Sun 1 = 14.
 *
 * No new math: the battery reads through the SAME store methods the page-data
 * builder uses (getLeadsByWorkDates work-date cohort + getOpportunitiesByPipelines
 * channel leads) and asserts the pure grid builder's output.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { PgStore } from "../store/pg";
import type { Store } from "../store/types";
import { dateRange, addDays } from "../date-logic";
import {
  ALLIANCE_PIPELINE_ID,
  AUCTION_PIPELINE_ID,
} from "../metrics/weekly";
import {
  assignedLeadsCsv,
  buildAssignedLeadsByDay,
  type AssignedByDayGrid,
} from "../metrics/assigned-by-day";
import type { LeadRow } from "../metrics/compute";
import type { OpportunityRow } from "../store/types";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Fixed test identity prefix — idempotent upserts, complete cleanup. */
const P = "assigned-by-day-test";

/** The owner's hand-made week, as per-day arrays Mon..Fri (0..4). */
const SHEET_ANCHOR = {
  allison: { ani: [61, 31, 33, 17, 17], fam: [46, 19, 19, 11, 16] }, // 159/111
  carmine: { ani: [44, 7, 10, 8, 5], fam: [49, 28, 23, 10, 9] }, // 74/119
  jennifer: { ani: [20, 3, 8, 10, 6], fam: [11, 2, 6, 3, 6] }, // 47/28
  laura: { ani: [13, 5, 4, 3, 3], fam: [9, 2, 2, 1, 1] }, // 28/15
  amy: { ani: [1, 0, 0, 0, 0], fam: [0, 0, 0, 0, 0] }, // 1/0
  lexa: { ani: [0, 0, 1, 0, 0], fam: [0, 0, 0, 0, 0] }, // 1/0
  mpa: { ani: [0, 0, 0, 2, 0], fam: [1, 0, 0, 0, 0] }, // 2/1
} as const;

/** Channel opportunities: Alliance Mon ×2; Auction Mon 8 / Thu 1 / Fri 2 / Sat 2 / Sun 1. */
const CHANNEL_ANCHOR = {
  alliance: [2, 0, 0, 0, 0, 0, 0],
  auction: [8, 0, 0, 1, 2, 2, 1], // 14 total
} as const;

const REPS = [
  { key: "allison", name: "Allison Wittner" },
  { key: "carmine", name: "Carmine Morgano" },
  { key: "jennifer", name: "Jennifer Stitt" },
  { key: "laura", name: "Laura Rivera" },
  { key: "amy", name: "Amy Clark" },
  { key: "lexa", name: "Lexa Brandis" },
  { key: "mpa", name: "Mallory Portraits Accounts" },
] as const;

type RepKey = (typeof REPS)[number]["key"];

/** Sum of one rep's sheet anchor for a genre (whole week). */
function sheetTotal(key: RepKey, genre: "ani" | "fam"): number {
  return SHEET_ANCHOR[key][genre].reduce((a, b) => a + b, 0);
}

/** Deterministic seeded battery — one function, run against each store. */
async function runAssignedByDayBattery(
  makeStore: () => Store,
  cfg: { mon: string; sun: string },
  cleanup?: () => Promise<void>,
): Promise<AssignedByDayGrid> {
  const { mon, sun } = cfg;
  const dates = dateRange(mon, sun);
  const store = makeStore();
  try {
    await store.upsertUsers(
      REPS.map((r) => ({
        provider: "highlevel",
        external_id: `${P}-${r.key}`,
        name: r.name,
        email: `${P}-${r.key}@example.com`,
        is_active: true,
        call_start_date: null,
      })),
    );
    const allUsers = await store.getAllUsers();
    const idOf = new Map(allUsers.filter((u) => u.external_id?.startsWith(`${P}-`)).map((u) => [u.external_id, u.id] as const));
    expect(idOf.size).toBe(REPS.length);
    const repId = (key: RepKey) => idOf.get(`${P}-${key}`)!;

    // ---- sheet leads: the exact owner-table day grid (source_date REQUIRED —
    // leads.source_date is NOT NULL; the Monday sources here map 1:1 to their
    // work_date, same convention as the pip-evidence battery) ----
    const leadRows: Parameters<Store["upsertLeads"]>[0] = [];
    for (const r of REPS) {
      (["ani", "fam"] as const).forEach((genre) => {
        const leadType = genre === "ani" ? "animalia" : "family";
        SHEET_ANCHOR[r.key][genre].forEach((n, dayIdx) => {
          const workDate = dates[dayIdx];
          for (let i = 0; i < n; i++) {
            leadRows.push({
              source_id: `${P}-lead-${r.key}-${leadType}-${dayIdx}-${i}`,
              provider: "google_sheets",
              lead_type: leadType,
              source_sheet: leadType,
              source_date: workDate,
              work_date: workDate,
              contact_id: null,
              assigned_rep_id: repId(r.key),
              name: null,
              phone: null,
              email: null,
            });
          }
        });
      });
    }
    // one UNASSIGNED lead — excluded from every cell (owner: assigned only)
    leadRows.push({
      source_id: `${P}-lead-unassigned`,
      provider: "google_sheets",
      lead_type: "family",
      source_sheet: "family",
      source_date: dates[0],
      work_date: dates[0],
      contact_id: null,
      assigned_rep_id: null,
      name: null,
      phone: null,
      email: null,
    });
    await store.upsertLeads(leadRows);

    // ---- channel opportunities (status mix proves every status counts) ----
    const oppRows: OpportunityRow[] = [];
    let oppSeq = 0;
    const addOpp = (pipeline: string, dayIdx: number, status: string) =>
      oppRows.push({
        provider: "highlevel",
        external_id: `${P}-opp-${pipeline === ALLIANCE_PIPELINE_ID ? "al" : "au"}-${oppSeq++}`,
        name: `${P} channel lead ${oppSeq}`,
        status, // open | won | lost | abandoned — a lead is a lead however it resolved
        monetary_value: null,
        contact_id: null,
        rep_id: repId("allison"),
        pipeline_id: pipeline,
        stage_id: null,
        // midday UTC → safely the same ET calendar date in any DST regime
        source_created_at: `${dates[dayIdx]}T12:00:00.000Z`,
        source_updated_at: `${dates[dayIdx]}T12:00:00.000Z`,
      });
    for (let i = 0; i < CHANNEL_ANCHOR.alliance[0]; i++) addOpp(ALLIANCE_PIPELINE_ID, 0, "open");
    CHANNEL_ANCHOR.auction.forEach((n, dayIdx) => {
      for (let i = 0; i < n; i++) addOpp(AUCTION_PIPELINE_ID, dayIdx, dayIdx % 2 === 0 ? "won" : "lost");
    });
    // noise: other-pipeline + out-of-week + rep-less opportunities never count
    oppRows.push({
      provider: "highlevel", external_id: `${P}-opp-other-pipeline`, name: "website opp", status: "open",
      monetary_value: null, contact_id: null, rep_id: repId("allison"), pipeline_id: "some-other-pipeline",
      stage_id: null, source_created_at: `${dates[0]}T12:00:00.000Z`, source_updated_at: null,
    });
    // out-of-week noise: the Sunday BEFORE the picked week (valid instant,
    // strictly outside [mon, sun]) — never counts
    oppRows.push({
      provider: "highlevel", external_id: `${P}-opp-out-of-week`, name: "last week opp", status: "open",
      monetary_value: null, contact_id: null, rep_id: repId("allison"), pipeline_id: AUCTION_PIPELINE_ID,
      stage_id: null, source_created_at: `${addDays(dates[0], -1)}T12:00:00.000Z`, source_updated_at: null,
    });
    oppRows.push({
      provider: "highlevel", external_id: `${P}-opp-unowned`, name: "no owner yet", status: "open",
      monetary_value: null, contact_id: null, rep_id: null, pipeline_id: AUCTION_PIPELINE_ID,
      stage_id: null, source_created_at: `${dates[1]}T12:00:00.000Z`, source_updated_at: null,
    });
    await store.upsertOpportunities(oppRows);

    // ---- read back through the SAME chain the page-data builder uses ----
    const [leads, opps, rosterUsers, names] = await Promise.all([
      store.getLeadsByWorkDates(dates),
      store.getOpportunitiesByPipelines([ALLIANCE_PIPELINE_ID, AUCTION_PIPELINE_ID]),
      store.getUsers(),
      store.getAllUsers(),
    ]);
    return buildAssignedLeadsByDay({
      leads,
      opps,
      rosterReps: rosterUsers.map((u) => ({ id: u.id, name: u.name })),
      nameById: new Map(names.map((u) => [u.id, u.name])),
      mon,
      sun,
    });
  } finally {
    if (cleanup) await cleanup();
  }
}

const cellOf = (grid: AssignedByDayGrid, name: string, dayIdx: number) => {
  const row = grid.rows.find((r) => r.rep_name === name);
  expect(row).toBeDefined();
  return row!.days[dayIdx];
};

describe("buildAssignedLeadsByDay — pure edge cases (no store)", () => {
  const mon = "2026-09-21";
  const mkLead = (over: Partial<LeadRow>): LeadRow => ({
    id: "l", lead_type: "family", source_date: mon, work_date: mon,
    contact_id: null, assigned_rep_id: "r1", source_sheet: "family", ...over,
  });
  const base = (over: Partial<Parameters<typeof buildAssignedLeadsByDay>[0]>) =>
    buildAssignedLeadsByDay({
      leads: [], opps: [], rosterReps: [{ id: "r1", name: "Rep One" }],
      nameById: new Map([["r1", "Rep One"]]), mon, sun: "2026-09-27", ...over,
    });

  test("roster rep with an empty week keeps its zero row", () => {
    const g = base({});
    expect(g.rows).toHaveLength(1);
    expect(g.rows[0].total).toEqual({ animalia: 0, family: 0, alliance: 0, auction: 0 });
    expect(g.weekTotal).toEqual({ animalia: 0, family: 0, alliance: 0, auction: 0 });
  });

  test("unassigned sheet leads are excluded; non-animalia lead types count family", () => {
    const g = base({
      leads: [
        mkLead({ id: "u", assigned_rep_id: null }),
        mkLead({ id: "f", lead_type: "Family" }),
        mkLead({ id: "a", lead_type: "animalia", work_date: "2026-09-22" }),
      ],
    });
    expect(g.rows[0].days[0]).toEqual({ animalia: 0, family: 1, alliance: 0, auction: 0 });
    expect(g.rows[0].days[1].animalia).toBe(1);
  });

  test("channel bucketing follows splitChannelLeads semantics (ET date, status-blind, week-bounded)", () => {
    const g = base({
      opps: [
        { pipeline_id: AUCTION_PIPELINE_ID, source_created_at: "2026-09-22T03:30:00.000Z", rep_id: "r1" }, // 9/21 23:30 ET → Mon
        { pipeline_id: ALLIANCE_PIPELINE_ID, source_created_at: "2026-09-27T04:00:00.000Z", rep_id: "r1" }, // Sun ET
        { pipeline_id: ALLIANCE_PIPELINE_ID, source_created_at: "2026-09-28T04:00:00.000Z", rep_id: "r1" }, // next Mon → out
        { pipeline_id: ALLIANCE_PIPELINE_ID, source_created_at: "not-a-date", rep_id: "r1" }, // never guessed
      ],
    });
    expect(g.rows[0].days[0].auction).toBe(1);
    expect(g.rows[0].days[6].alliance).toBe(1);
    expect(g.rows[0].total.alliance).toBe(1);
    expect(g.warnings.join(" ")).toContain("no parsable created time");
  });

  test("rep-less channel leads warn instead of landing on a guessed row", () => {
    const g = base({
      opps: [{ pipeline_id: AUCTION_PIPELINE_ID, source_created_at: "2026-09-21T12:00:00.000Z", rep_id: null }],
    });
    expect(g.rows[0].total.auction).toBe(0);
    expect(g.warnings.join(" ")).toContain("no owning rep");
  });

  test("an off-roster rep appears only when the week's data names them; sort is total desc", () => {
    const g = base({
      leads: [mkLead({ id: "x", assigned_rep_id: "ghost" }), mkLead({ id: "y", assigned_rep_id: "r1" })],
      nameById: new Map([["r1", "Rep One"], ["ghost", "Ghost Rep"]]),
    });
    // Ghost Rep has the same total as the roster rep but sorts first by name;
    // the off-roster "ghost" row EXISTS only because the week's data names it.
    expect(g.rows.map((r) => r.rep_name)).toEqual(["Ghost Rep", "Rep One"]);
  });

  test("CSV: owner schema, day labels, non-zero cells only, quoting", () => {
    const g = base({
      leads: [mkLead({ id: "f" }), mkLead({ id: "a2", lead_type: "animalia" })],
      opps: [{ pipeline_id: ALLIANCE_PIPELINE_ID, source_created_at: "2026-09-21T12:00:00.000Z", rep_id: "r1" }],
    });
    const csv = assignedLeadsCsv(g);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("rep,day,genre,assigned_leads");
    expect(lines).toContain("Rep One,2026-09-21 Mon,Animalia,1");
    expect(lines).toContain("Rep One,2026-09-21 Mon,Family,1");
    expect(lines).toContain("Rep One,2026-09-21 Mon,Alliance,1");
    expect(lines).toHaveLength(4); // header + 3 non-zero rows (no zero cells)
    expect(csv).not.toContain(",0\n");
  });
});

describe("assigned-leads-by-day battery — MemoryStore (owner table, week 2026-09-21)", () => {
  test("full per-rep per-day grid reproduces the owner's hand-built table", async () => {
    const grid = await runAssignedByDayBattery(() => new MemoryStore(), {
      mon: "2026-09-21",
      sun: "2026-09-27",
    });

    // rows: all 7 seeded reps (roster) sorted by week total desc
    expect(grid.rows.map((r) => r.rep_name)).toEqual([
      "Allison Wittner", // 159+111+2+14 = 286
      "Carmine Morgano", // 193
      "Jennifer Stitt", // 75
      "Laura Rivera", // 43
      "Mallory Portraits Accounts", // 3
      "Amy Clark", // 1
      "Lexa Brandis", // 1
    ]);

    // week totals per rep (genre order: animalia/family/alliance/auction)
    const totalOf = (name: string) => grid.rows.find((r) => r.rep_name === name)!.total;
    expect(totalOf("Allison Wittner")).toEqual({ animalia: 159, family: 111, alliance: 2, auction: 14 });
    expect(totalOf("Carmine Morgano")).toEqual({ animalia: 74, family: 119, alliance: 0, auction: 0 });
    expect(totalOf("Jennifer Stitt")).toEqual({ animalia: 47, family: 28, alliance: 0, auction: 0 });
    expect(totalOf("Laura Rivera")).toEqual({ animalia: 28, family: 15, alliance: 0, auction: 0 });
    expect(totalOf("Amy Clark")).toEqual({ animalia: 1, family: 0, alliance: 0, auction: 0 });
    expect(totalOf("Lexa Brandis")).toEqual({ animalia: 1, family: 0, alliance: 0, auction: 0 });
    expect(totalOf("Mallory Portraits Accounts")).toEqual({ animalia: 2, family: 1, alliance: 0, auction: 0 });

    // pinned day cells (CSV rows)
    expect(cellOf(grid, "Allison Wittner", 0)).toEqual({ animalia: 61, family: 46, alliance: 2, auction: 8 });
    expect(cellOf(grid, "Allison Wittner", 4)).toEqual({ animalia: 17, family: 16, alliance: 0, auction: 2 });
    expect(cellOf(grid, "Allison Wittner", 5)).toEqual({ animalia: 0, family: 0, alliance: 0, auction: 2 }); // Sat
    expect(cellOf(grid, "Allison Wittner", 6)).toEqual({ animalia: 0, family: 0, alliance: 0, auction: 1 }); // Sun
    expect(cellOf(grid, "Carmine Morgano", 0)).toEqual({ animalia: 44, family: 49, alliance: 0, auction: 0 });
    expect(cellOf(grid, "Carmine Morgano", 3)).toEqual({ animalia: 8, family: 10, alliance: 0, auction: 0 });
    expect(cellOf(grid, "Jennifer Stitt", 2)).toEqual({ animalia: 8, family: 6, alliance: 0, auction: 0 });
    expect(cellOf(grid, "Laura Rivera", 1)).toEqual({ animalia: 5, family: 2, alliance: 0, auction: 0 });
    expect(cellOf(grid, "Amy Clark", 0)).toEqual({ animalia: 1, family: 0, alliance: 0, auction: 0 });
    expect(cellOf(grid, "Lexa Brandis", 2)).toEqual({ animalia: 1, family: 0, alliance: 0, auction: 0 });
    expect(cellOf(grid, "Mallory Portraits Accounts", 3)).toEqual({ animalia: 2, family: 0, alliance: 0, auction: 0 });

    // day totals: Monday across all reps
    expect(grid.dayTotals[0]).toEqual({ animalia: 139, family: 116, alliance: 2, auction: 8 });
    // week totals: 312 animalia / 274 family / 2 alliance / 14 auction
    expect(grid.weekTotal).toEqual({ animalia: 312, family: 274, alliance: 2, auction: 14 });
    // the unassigned lead and the rep-less auction opp never landed anywhere
    expect(grid.warnings.join(" ")).toContain("no owning rep");
  });

  test("CSV download payload matches the owner's shared file for the anchor week", async () => {
    const grid = await runAssignedByDayBattery(() => new MemoryStore(), {
      mon: "2026-09-21",
      sun: "2026-09-27",
    });
    const csv = assignedLeadsCsv(grid);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("rep,day,genre,assigned_leads");
    expect(lines[1]).toBe("Allison Wittner,2026-09-21 Mon,Animalia,61");
    expect(lines).toContain("Allison Wittner,2026-09-21 Mon,Family,46");
    expect(lines).toContain("Allison Wittner,2026-09-21 Mon,Alliance,2");
    expect(lines).toContain("Allison Wittner,2026-09-21 Mon,Auction,8");
    expect(lines).toContain("Allison Wittner,2026-09-27 Sun,Auction,1");
    expect(lines).toContain("Carmine Morgano,2026-09-24 Thu,Animalia,8");
    expect(lines).toContain("Amy Clark,2026-09-21 Mon,Animalia,1");
    expect(lines).toContain("Lexa Brandis,2026-09-23 Wed,Animalia,1");
    expect(lines).toContain("Mallory Portraits Accounts,2026-09-24 Thu,Animalia,2");
    // same row COUNT as the owner's file (schema-identical; row order is
    // deterministic rep → day → genre rather than the hand-file's grouping)
    const owner = (await Bun.file("/home/team/shared/assigned-leads-2026-09-21-to-27-by-day.csv").text()).trimEnd().split("\n");
    expect(lines.length).toBe(owner.length);
  });
});

describe("repsPageData integration — the section rides the REAL loader chain (MemoryStore)", () => {
  test("default week = last COMPLETED week; ?week= honored; grid travels in the payload", async () => {
    const { repsPageData } = await import("../page-data");
    const store = new MemoryStore();
    await runAssignedByDayBattery(() => store, { mon: "2026-09-21", sun: "2026-09-27" });
    // battery cleaned nothing (memory); the same store now backs the page load.
    // Seeded store HAS the anchor data; today pinned mid-week AFTER the anchor
    // week so the last completed week IS 2026-09-21.
    const payload = await repsPageData({ week: "2026-09-24" }, { store, today: "2026-10-01" });
    expect(payload.assignedWeek.mon).toBe("2026-09-21"); // any day in the week normalizes to its Monday
    expect(payload.assignedByDay.week_start).toBe("2026-09-21");
    const allison = payload.assignedByDay.rows.find((r) => r.rep_name === "Allison Wittner");
    expect(allison?.total).toEqual({ animalia: 159, family: 111, alliance: 2, auction: 14 });

    const defaulted = await repsPageData({}, { store, today: "2026-10-01" });
    expect(defaulted.assignedWeek.mon).toBe("2026-09-21"); // Wed 10/1 → last completed week = 9/21
    expect(defaulted.assignedWeek.mondays[0]).toBe("2026-09-28"); // picker: current week first
    expect(defaulted.assignedByDay.week_start).toBe("2026-09-21");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("assigned-leads-by-day battery — PgStore (real Postgres, far-out week)", () => {
  test("same seeded battery against the live schema (2027 week; rows cleaned up)", async () => {
    const store = new PgStore(TEST_DATABASE_URL!);
    await store.ensureSchema();
    const grid = await runAssignedByDayBattery(
      () => store,
      { mon: "2027-01-04", sun: "2027-01-10" },
      async () => {
        const { default: postgres } = await import("postgres");
        const sql = postgres(TEST_DATABASE_URL!, { max: 1, ...(TEST_DATABASE_URL!.includes("sslmode=") ? {} : { ssl: "require" }) });
        try {
          await sql`DELETE FROM opportunities WHERE external_id LIKE ${P + "-opp-%"} OR name LIKE ${P + " channel lead%"}`;
          await sql`DELETE FROM leads WHERE source_id LIKE ${P + "-lead-%"}`;
          await sql`DELETE FROM users WHERE external_id LIKE ${P + "-%"}`;
        } finally {
          await sql.end({ timeout: 5 });
        }
      },
    );
    // the same anchor numbers, on the shifted week
    expect(grid.rows.map((r) => r.rep_name)[0]).toBe("Allison Wittner");
    const allison = grid.rows.find((r) => r.rep_name === "Allison Wittner")!;
    expect(allison.total).toEqual({ animalia: 159, family: 111, alliance: 2, auction: 14 });
    expect(allison.days[0]).toEqual({ animalia: 61, family: 46, alliance: 2, auction: 8 });
    expect(allison.days[6].auction).toBe(1);
    expect(grid.weekTotal).toEqual({ animalia: 312, family: 274, alliance: 2, auction: 14 });
    const csv = assignedLeadsCsv(grid);
    expect(csv).toContain("Allison Wittner,2027-01-04 Mon,Animalia,61");
    expect(csv).toContain("Carmine Morgano,2027-01-07 Thu,Family,10");
  }, 90_000);

  test("LIVE READ-ONLY anchor: real week 2026-09-21..27 reproduces the owner's table", async () => {
    const store = new PgStore(TEST_DATABASE_URL!);
    const mon = "2026-09-21";
    const sun = "2026-09-27";
    const [leads, opps, rosterUsers, names] = await Promise.all([
      store.getLeadsByWorkDates(dateRange(mon, sun)),
      store.getOpportunitiesByPipelines([ALLIANCE_PIPELINE_ID, AUCTION_PIPELINE_ID]),
      store.getUsers(),
      store.getAllUsers(),
    ]);
    // genre-label discovery: anything outside family/animalia is reported, not guessed
    const leadTypes = [...new Set(leads.map((l: LeadRow) => l.lead_type))];
    expect(leadTypes.filter((t) => !/^(family|animalia)$/i.test(t))).toEqual([]);

    const grid = buildAssignedLeadsByDay({
      leads,
      opps,
      rosterReps: rosterUsers.map((u) => ({ id: u.id, name: u.name })),
      nameById: new Map(names.map((u) => [u.id, u.name])),
      mon,
      sun,
    });
    const totalOf = (name: string) => {
      const row = grid.rows.find((r) => r.rep_name === name);
      expect(row).toBeDefined();
      return row!.total;
    };
    expect(totalOf("Allison Wittner")).toEqual({ animalia: 159, family: 111, alliance: 2, auction: 14 });
    expect(totalOf("Carmine Morgano")).toEqual({ animalia: 74, family: 119, alliance: 0, auction: 0 });
    expect(totalOf("Jennifer Stitt")).toEqual({ animalia: 47, family: 28, alliance: 0, auction: 0 });
    expect(totalOf("Laura Rivera")).toEqual({ animalia: 28, family: 15, alliance: 0, auction: 0 });
    expect(totalOf("Amy Clark")).toEqual({ animalia: 1, family: 0, alliance: 0, auction: 0 });
    expect(totalOf("Lexa Brandis")).toEqual({ animalia: 1, family: 0, alliance: 0, auction: 0 });
    expect(totalOf("Mallory Portraits Accounts")).toEqual({ animalia: 2, family: 1, alliance: 0, auction: 0 });
    // Alliance: Allison, Mon only = 2; Auction: Mon 8 / Thu 1 / Fri 2 / Sat 2 / Sun 1
    const allisonDays = grid.rows.find((r) => r.rep_name === "Allison Wittner")!.days;
    expect(allisonDays.map((d) => d.alliance)).toEqual([2, 0, 0, 0, 0, 0, 0]);
    expect(allisonDays.map((d) => d.auction)).toEqual([8, 0, 0, 1, 2, 2, 1]);
    expect(grid.warnings).toEqual([]);
  }, 60_000);
});
