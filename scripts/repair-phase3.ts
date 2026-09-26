/**
 * One-off Phase-3 finishing repair (run once, safe to re-run):
 *  - The 71-minute backfill stored users/contacts/calls but crashed the
 *    highlevel provider fn at fetchOpportunities (live 422: offset rejected).
 *    The provider fn throw left: connection row demo-flagged, no watermark,
 *    and a stale 'running' sync_runs row.
 *  - This script re-syncs ONLY the cheap pieces (users + opportunities) with
 *    the FIXED cursor-paged adapter, closes the stale running row, sets the
 *    incremental watermark to the backfill's completion instant, and writes
 *    the honest connected/not-demo connection row.
 */
import { LiveHighLevelAdapter, readHighLevelCreds } from "/home/team/shared/site/src/server/sync/highlevel-live";
import { getStore } from "/home/team/shared/site/src/server/store";

const BACKFILL_FINISHED_AT = "2026-09-26T03:24:26.736Z";
const STALE_RUN_ID = "2f2554ca-f733-45b9-99c8-834922887e2b";

const store = await getStore();
const creds = readHighLevelCreds();
if (!creds) throw new Error("no HighLevel credentials");

const adapter = new LiveHighLevelAdapter({ creds });
const users = await adapter.fetchUsers();
const opportunities = await adapter.fetchOpportunities();
console.log("fetched:", { users: users.length, opportunities: opportunities.length, warnings: adapter.lastRun.warnings });

const storedUsers = await store.getUsers();
const userIdByExt = new Map(storedUsers.map((u) => [`${u.provider}:${u.external_id}`, u.id]));
await store.upsertUsers(users.map((u) => ({ id: "", provider: "highlevel", external_id: u.external_id, name: u.name, email: u.email, is_active: true })));
const storedContacts = await store.getContacts();
const contactIdByExt = new Map(storedContacts.map((c) => [`${c.provider}:${c.external_id}`, c.id]));
await store.upsertOpportunities(
  opportunities.map((p) => ({
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
  })),
);

// close the stale running row left by the backfill process
await store.finishSyncRun(STALE_RUN_ID, "error", 0, "Backfill process ended without finishing this run row (opportunities 422) — closed by Phase-3 finishing pass; data was stored.");

// watermark = backfill completion (everything before it is stored)
await store.setSyncWatermark("highlevel", BACKFILL_FINISHED_AT);

// honest connection row
const now = new Date().toISOString();
await store.upsertConnection({
  provider: "highlevel",
  status: "connected",
  is_demo: false,
  last_sync_at: now,
  last_successful_sync_at: now,
  last_error: null,
  config: {
    source: "highlevel-api",
    note: "Backfill verified (users/contacts/calls live) + opportunities repaired via cursor paging. Incremental background sync active (watermark set at backfill completion).",
  },
});

console.log("watermark:", await store.getSyncWatermark("highlevel"));
console.log("opportunities stored:", (await store.getOpportunities()).length);
process.exit(0);
