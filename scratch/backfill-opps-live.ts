/**
 * LIVE opportunities backfill (prod DB) — uses the BRANCH code: the new
 * page-based full-window snapshot + batched upsert. Then verifies the
 * Alliance/Auction lead counts against the lead's reference numbers.
 * Run: . /etc/profile.d/cto-env-vars.sh; bun scratch/backfill-opps-live.ts
 */
import { createHighLevelAdapter } from "../src/server/sync/highlevel-live";
import { getStore } from "../src/server/store";
import { ALLIANCE_PIPELINE_ID, AUCTION_PIPELINE_ID } from "../src/server/metrics/weekly";
import { etDateStrFromInstant } from "../src/server/date-logic";

const adapter = createHighLevelAdapter();
if (!adapter) throw new Error("HighLevel credentials not resolvable — aborting");
console.log("fetching opportunities snapshot (page-based)…");
const opps = await adapter.fetchOpportunities();
console.log(`fetched ${opps.length}; notes: ${adapter.lastRun.endpointNotes.join(" | ")}`);
if (adapter.lastRun.warnings.length) console.log(`warnings: ${adapter.lastRun.warnings.join(" | ")}`);

const store = await getStore();
console.log("store mode:", store.mode);

// Resolve contact/rep references the same way the full sync does (run.ts) so
// stored rows are fully consistent, not just counted.
const storedUsers = await store.getAllUsers();
const userIdByExt = new Map(storedUsers.map((u) => [`${u.provider}:${u.external_id}`, u.id]));
const storedContacts = await store.getContacts();
const contactIdByExt = new Map(storedContacts.map((c) => [`${c.provider}:${c.external_id}`, c.id]));

const rows = opps
  .filter((p) => typeof p.external_id === "string" && p.external_id.length > 0)
  .map((p) => ({
  provider: "highlevel",
  external_id: p.external_id,
  name: p.name,
  status: p.status,
  monetary_value: p.monetaryValue,
  contact_id: p.contactExternalId ? contactIdByExt.get(`highlevel:${p.contactExternalId}`) ?? null : null,
  rep_id: p.assignedRepExternalId ? userIdByExt.get(`highlevel:${p.assignedRepExternalId}`) ?? null : null,
  pipeline_id: p.pipelineId,
  stage_id: p.stageId,
  source_created_at: p.createdAt,
  source_updated_at: p.updatedAt,
}));
console.log("upserting in batches…");
// DEBUG: pinpoint any undefined bind (postgres.js throws UNDEFINED_VALUE without saying which)
const badIdx = rows.findIndex((r) => Object.values(r).some((v) => v === undefined));
if (badIdx >= 0) console.log(`UNDEF ROW ${badIdx}:`, JSON.stringify(rows[badIdx])); else console.log("no undefined row fields pre-upsert");
const t0 = Date.now();
const written = await store.upsertOpportunities(rows);
console.log(`upsert returned ${written} in ${Date.now() - t0}ms`);

const channelOpps = await store.getOpportunitiesByPipelines([ALLIANCE_PIPELINE_ID, AUCTION_PIPELINE_ID]);
const byDay = new Map<string, { al: number; au: number }>();
for (const o of channelOpps) {
  if (!o.source_created_at) continue;
  const d = etDateStrFromInstant(Date.parse(o.source_created_at));
  const cur = byDay.get(d) ?? { al: 0, au: 0 };
  if (o.pipeline_id === ALLIANCE_PIPELINE_ID) cur.al += 1;
  if (o.pipeline_id === AUCTION_PIPELINE_ID) cur.au += 1;
  byDay.set(d, cur);
}
const days = [...byDay.entries()].sort();
console.log("AA leads by ET created day (from DB):", JSON.stringify(days.map(([d, v]) => `${d}: ${v.al + v.au}`)));
const sum = (a: string, b: string) => days.filter(([d]) => d >= a && d <= b).reduce((s, [, v]) => s + v.al + v.au, 0);
console.log(`DB totals → Sep 21–27 (last completed week): ${sum("2026-09-21", "2026-09-27")} (reference 16) · current week so far: ${sum("2026-09-28", "2099-12-31")} (lead's morning scan: 31) · alliance rows: ${channelOpps.filter((o) => o.pipeline_id === ALLIANCE_PIPELINE_ID).length} (ref 18) · auction rows: ${channelOpps.filter((o) => o.pipeline_id === AUCTION_PIPELINE_ID).length} (ref 60, wall-limited)`);
const stored = await store.getOpportunities();
console.log(`stored opportunities total in DB: ${stored.length}`);
process.exit(0);
