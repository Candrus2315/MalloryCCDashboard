/**
 * ONE-TIME CONTROLLED BACKFILL: the COMPLETE HighLevel contact population →
 * normalized contacts table (owner-approved; location reports ~116k).
 *
 *   bun run scripts/contacts-backfill.ts
 *
 * - CHECKPOINTED: the pagination cursor is persisted to sync_checkpoints
 *   after EVERY page — interrupt at any point and rerun the SAME command;
 *   it resumes exactly where it stopped (never restarts from page 1).
 * - IDEMPOTENT: upserts keyed by HL contact ID (reruns duplicate nothing).
 * - UPSERT-ONLY: never deletes contacts absent from a page.
 * - PACING: ~4 req/s (CONTACTS_BACKFILL_DELAY_MS to override), exponential
 *   backoff + retry on 429/5xx; a page that fails after sustained retries is
 *   recorded in the checkpoint and the run stops cleanly at that checkpoint.
 * - CURSOR: follows meta.nextPageUrl verbatim (startAfterId alone does NOT
 *   advance on this account — the proven root cause of the old 119-contact
 *   DB; see src/server/sync/contacts-backfill.ts header).
 *
 * Status / progress:
 *   SELECT value FROM sync_checkpoints WHERE key='hl_contacts_backfill_v1';
 *
 * Reset (only if you really mean it — drops the cursor and restarts at page 1):
 *   DELETE FROM sync_checkpoints WHERE key='hl_contacts_backfill_v1';
 */
import { runContactsBackfill, CONTACTS_BACKFILL_CHECKPOINT_KEY, type ContactsBackfillCheckpoint, type ContactsPage } from "../src/server/sync/contacts-backfill";
import { readHighLevelCreds } from "../src/server/sync/highlevel-live";
import { getStore } from "../src/server/store";

const PAGE_DELAY_MS = Number(process.env.CONTACTS_BACKFILL_DELAY_MS ?? 250);
const MAX_PAGES_THIS_RUN = process.env.CONTACTS_BACKFILL_MAX_PAGES ? Number(process.env.CONTACTS_BACKFILL_MAX_PAGES) : undefined;

const creds = readHighLevelCreds();
if (!creds) throw new Error("HIGHLEVEL_API_KEY / HIGHLEVEL_LOCATION_ID secrets are required");
const store = await getStore();

// assigned users → internal rep ids (best effort; raw HL id preserved regardless)
const users = await store.getAllUsers();
const userIdByExternal = new Map(users.map((u) => [`${u.provider}:${u.external_id}`, u.id]));

const headers = {
  authorization: `Bearer ${creds.apiKey}`,
  version: "2021-07-28",
  accept: "application/json",
};

async function fetchPage(url: string): Promise<ContactsPage> {
  const res = await fetch(url, { headers });
  if (res.status === 429 || (res.status >= 500 && res.status <= 504)) {
    throw new Error(`HTTP ${res.status} from HighLevel (retryable)`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from HighLevel (non-retryable)`);
  const body = (await res.json()) as { contacts?: unknown[]; meta?: { nextPageUrl?: unknown; total?: unknown } };
  const nextPageUrl = typeof body.meta?.nextPageUrl === "string" && body.meta.nextPageUrl.length ? body.meta.nextPageUrl : null;
  const total = typeof body.meta?.total === "number" ? body.meta.total : null;
  return { rows: Array.isArray(body.contacts) ? (body.contacts as ContactsPage["rows"]) : [], nextPageUrl, total };
}

const startUrl = `https://services.leadconnectorhq.com/contacts/?locationId=${creds.locationId}&limit=100`;

const existing = await store.getSyncCheckpoint(CONTACTS_BACKFILL_CHECKPOINT_KEY);
if (existing) {
  const cp = JSON.parse(existing) as ContactsBackfillCheckpoint;
  console.log(`RESUMING: ${cp.pagesDone} pages / ${cp.upserted} contacts already upserted${cp.failedPages.length ? `, ${cp.failedPages.length} failed page(s) recorded` : ""}`);
} else {
  console.log("STARTING from page 1 (no checkpoint)");
}

const outcome = await runContactsBackfill(
  {
    fetchPage,
    upsertContacts: (rows) => store.upsertContacts(rows),
    loadCheckpoint: async () => {
      const v = await store.getSyncCheckpoint(CONTACTS_BACKFILL_CHECKPOINT_KEY);
      return v ? (JSON.parse(v) as ContactsBackfillCheckpoint) : null;
    },
    saveCheckpoint: (cp) => store.setSyncCheckpoint(CONTACTS_BACKFILL_CHECKPOINT_KEY, JSON.stringify(cp)),
    pageDelayMs: PAGE_DELAY_MS,
    maxPagesThisRun: MAX_PAGES_THIS_RUN,
    userIdByExternal,
    log: (line) => console.log(line),
  },
  startUrl,
);

console.log(JSON.stringify({ done: outcome.done, pagesDoneThisRun: outcome.pagesDoneThisRun, upsertedTotal: outcome.upsertedTotal, sourceTotal: outcome.sourceTotal }));
const stored = await store.getContacts();
console.log(`DB contacts now: ${stored.filter((c) => c.provider === "highlevel").length}`);
process.exit(0);
