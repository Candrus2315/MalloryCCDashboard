/**
 * One-off diagnostic: current stored lead counts per sheet + recent sync runs +
 * connection rows. Run: bun scripts/sync-state.ts
 */
import { getStore } from "../src/server/store";

const store = await getStore();
console.log("store mode:", store.mode);

// leads per sheet
const leads = await (store as any).getLeadsByWorkDates(
  Array.from({ length: 60 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    return d.toISOString().slice(0, 10);
  }),
);
const bySheet = new Map<string, number>();
for (const l of leads as { source_sheet: string | null }[]) {
  const k = l.source_sheet ?? "(null)";
  bySheet.set(k, (bySheet.get(k) ?? 0) + 1);
}
console.log("leads stored (last 60 work_dates) by sheet:", Object.fromEntries(bySheet));

const runs = await store.getSyncRuns(12);
for (const r of runs) {
  console.log(`run ${r.provider} ${r.status} up=${r.records_upserted} started=${r.started_at} err=${(r.error ?? "").slice(0, 160)}`);
}
for (const c of await store.getConnections()) {
  console.log(`conn ${c.provider} status=${c.status} demo=${c.is_demo} last=${c.last_sync_at} err=${(c.last_error ?? "").slice(0, 200)}`);
}
process.exit(0);
