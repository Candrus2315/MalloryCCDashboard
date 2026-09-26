/**
 * WEEK-BOUNDARY VERIFICATION (part 3 of docs/reconciliation-2026-09-26.md):
 * reads the LIVE database through the page builders' real range resolution —
 * the SAME code path the "Week of…" selector uses — and prints rep-by-rep
 * calls / calls-over-2-min for the PRIOR week (Mon 9/14–Sun 9/20 ET) and the
 * current week-to-date. NO ledger, NO harvesting: dashboard DB via the one
 * metrics engine, exactly what the pages display.
 *
 * Run: source /etc/profile.d/cto-env-vars.sh && bun scripts/week-boundary-verify.ts
 */
import { etToday, formatDateHuman } from "../src/server/date-logic";
import { repsPageData, teamPageData } from "../src/server/page-data";

async function main() {
  const today = etToday();
  console.log(`RUN at ${new Date().toISOString()} · today (ET) = ${today} (${formatDateHuman(today)})`);

  const prior = await repsPageData({ range: "week-of", from: "2026-09-14" });
  const wtd = await repsPageData({ range: "this-week" });
  const priorTeam = await teamPageData({ range: "week-of", from: "2026-09-14" });
  const wtdTeam = await teamPageData({ range: "this-week" });

  console.log(`store mode = ${prior.meta.mode}`);
  console.log("\n== PRIOR WEEK (Week of Sep 14 · Mon 9/14–Sun 9/20 ET) — rep / totalCalls / over-2-min ==");
  console.log(`range resolved: ${prior.range.mode} ${prior.range.start}..${prior.range.end} label="${prior.range.label}"`);
  for (const r of prior.repList) console.log(`  ${r.name.padEnd(22)} ${r.totalCalls} / ${r.callsOverThreshold}`);
  console.log(
    `  TEAM(roster)          ${priorTeam.metrics.totalCalls} / ${priorTeam.metrics.callsOverThreshold} · bookings ${priorTeam.metrics.totalBookings} · goal ${priorTeam.metrics.goal.value}`,
  );

  console.log("\n== WTD (Mon 9/21 → now ET) — rep / totalCalls / over-2-min ==");
  console.log(`range resolved: ${wtd.range.mode} ${wtd.range.start}..${wtd.range.end} label="${wtd.range.label}" isCurrentWeek=${wtd.range.isCurrentWeek}`);
  for (const r of wtd.repList) console.log(`  ${r.name.padEnd(22)} ${r.totalCalls} / ${r.callsOverThreshold}`);
  console.log(
    `  TEAM(roster)          ${wtdTeam.metrics.totalCalls} / ${wtdTeam.metrics.callsOverThreshold} · bookings ${wtdTeam.metrics.totalBookings} · goal ${wtdTeam.metrics.goal.value}`,
  );

  // Completed-day stability: prior week must be immutable now that 9/14–9/20
  // are all past (only late-arriving back-dated messages could move it).
  console.log("\n== Completed-day check: per-day prior-week team totals from the selector range ==");
  for (const d of ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"]) {
    const day = await repsPageData({ range: "week-of", from: d });
    // A single-day week-of is impossible (always full Mon..Sun) — use custom-free
    // per-day snapshot via today/tomorrow custom range instead.
    const single = await teamPageData({ range: "custom", from: d, to: d });
    console.log(
      `  ${d} ${single.range.start === d && single.range.end === d ? "" : "(range!=day!)"} team ${single.metrics.totalCalls} / ${single.metrics.callsOverThreshold}`,
    );
    void day;
  }
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
