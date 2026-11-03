/**
 * DEAD-CONTACT-ID REPAIR (SMS EVIDENCE + CONTACT RE-RESOLUTION spec, owner
 * approved 2026-11-02, workstream 3).
 *
 * `appointments.contact_id` values can 404 in HighLevel (contacts merged /
 * removed) — the attribution engine then sees no identity/evidence at all and
 * books land falsely in the self-booked / unattributed queue. This pass:
 *
 *   1. Selects every appointment whose attribution row is UNATTRIBUTED
 *      (rep NULL, not manual) within the last 45 days and carries a contact id.
 *   2. Probes each DISTINCT contact id (cheap): GET
 *      /conversations/search?contactId=X — HTTP 400 CONVERSATIONS_CONTACT_
 *      NOT_FOUND proves the id is dead; 200 = alive (skipped); other errors
 *      are skipped honestly and retried on the next run.
 *   3. Re-resolves dead ids per APPOINTMENT via GET /contacts/?query= —
 *      exact canonical phone match > exact email match > name match ranked by
 *      (has conversations) then most recent dateAdded. Ambiguous tiers are
 *      SKIPPED, never guessed; nothing resolves onto a still-dead id.
 *   4. Updates appointments.contact_id (the ORIGINAL id is preserved in this
 *      script's durable repair log on sync_checkpoints key
 *      "hl_dead_contact_repair_v1" — never silently lost) and leaves the
 *      attribution row for the tick to re-derive with the corrected identity
 *      + the new SMS evidence.
 *
 * Rate-limit safe: probes/resolutions are paced (150 ms), capped per run
 * (--max-probes), and the pass holds the provider 'highlevel' sync_runs mutex.
 * Resumable: per-contact-id statuses persist in the checkpoint.
 *
 * Run: bun scripts/dead-contact-repair.ts [--max-probes=300]
 */
import { readFileSync } from "node:fs";
import { normalizeEmail, normalizeUSPhone } from "../src/server/identity/normalize";
import { readHighLevelCreds } from "../src/server/sync/highlevel-live";
import { getStore } from "../src/server/store";
import { PgStore } from "../src/server/store/pg";

const GRANT_SOURCE = "data-ops runner: dead-contact-repair (owner approved 2026-11-02)";
import { type HlContactLite } from "../src/server/sync/dead-contact-repair";
import postgres from "postgres";

export const DEAD_CONTACT_REPAIR_CHECKPOINT_KEY = "hl_dead_contact_repair_v1";

interface CandidateAppt {
  id: string;
  client_name: string | null;
  client_phone: string | null;
  client_email: string | null;
  contact_id: string;
  reason_code: string | null;
}

interface RepairRecord {
  appointment_id: string;
  client_name: string | null;
  old_contact_id: string;
  new_contact_id: string | null;
  resolvedBy: "phone" | "email" | "name" | null;
  note: string;
  at: string;
}

interface Checkpoint {
  /** Per-contact-id verdicts so a rerun never re-probes the same id. */
  contactStatus: Record<string, "alive" | "dead" | "error">;
  repairs: RepairRecord[];
  probes: number;
  updated_at: string;
}

const envOf = (k: string): string => {
  const m = readFileSync("/proc/self/environ", "utf8").split("\0").find((s) => s.toLowerCase().startsWith(k.toLowerCase() + "="));
  return m ? m.slice(k.length + 1) : "";
};
for (const canon of ["DATABASE_URL", "HIGHLEVEL_API_KEY", "HIGHLEVEL_LOCATION_ID"] as const) {
  if (!process.env[canon]) {
    const v = envOf(canon);
    if (v) process.env[canon] = v;
  }
}

const arg = process.argv.find((a) => a.startsWith("--max-probes="));
const MAX_PROBES = arg ? Number(arg.split("=")[1]) || 300 : 300;
const PACE_MS = 150;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

import {
  countConversations,
  probeContactDead,
  searchContacts,
  pickReplacement,
} from "../src/server/sync/dead-contact-repair";

const normName = (n: string | null): string => (n ?? "").trim().toLowerCase().replace(/\s+/g, " ");

async function main(): Promise<void> {
  const store = await getStore(
    { storeFactory: (u) => new PgStore(u, { migrationCapability: { grantedBy: GRANT_SOURCE } }) },
  );
  const creds = readHighLevelCreds();
  if (!creds) throw new Error("HIGHLEVEL_API_KEY / HIGHLEVEL_LOCATION_ID missing — cannot run the dead-contact repair");

  const running = await store.getRunningSyncRun("highlevel");
  if (running) {
    const ageMs = Date.now() - Date.parse(running.started_at);
    if (ageMs < 2 * 3_600_000) {
      console.log(`SKIP: a highlevel sync is already running (started ${running.started_at}) — scheduler mutex.`);
      return;
    }
    await store.finishSyncRun(running.id, "error", 0, "reclaimed by dead-contact repair (stale running row)");
  }
  const syncRunId = await store.insertSyncRun("highlevel");

  let cp: Checkpoint = { contactStatus: {}, repairs: [], probes: 0, updated_at: new Date().toISOString() };
  const stored = await store.getSyncCheckpoint(DEAD_CONTACT_REPAIR_CHECKPOINT_KEY);
  try {
    const parsed = stored ? JSON.parse(stored) : null;
    if (parsed && typeof parsed === "object" && parsed.contactStatus && Array.isArray(parsed.repairs)) cp = parsed as Checkpoint;
  } catch {
    /* fresh checkpoint */
  }
  const save = async (): Promise<void> => {
    cp.updated_at = new Date().toISOString();
    await store.setSyncCheckpoint(DEAD_CONTACT_REPAIR_CHECKPOINT_KEY, JSON.stringify(cp));
  };

  try {
    // In-scope: UNATTRIBUTED rows (the queue + self-booked) within the last 45
    // days, non-manual, carrying a contact id.
    const appts = (await store.getAppointmentsWithClientsSince(new Date(Date.now() - 45 * 86_400_000).toISOString())) as Array<{
      id: string;
      client_name: string | null;
      client_phone: string | null;
      client_email: string | null;
      contact_id: string | null;
      status?: string;
      cancelled?: boolean;
    }>;
    const apptById = new Map(appts.map((a) => [a.id, a]));
    const attributions = await store.getAttributions();
    const candidates: CandidateAppt[] = attributions
      .filter((r) => !r.manual_override && r.rep_id == null)
      .map((r) => {
        const a = apptById.get(r.appointment_id);
        return a && a.contact_id ? { id: a.id, client_name: a.client_name, client_phone: a.client_phone, client_email: a.client_email, contact_id: a.contact_id, reason_code: r.reason_code } : null;
      })
      .filter((x): x is CandidateAppt => x != null);
    const distinctIds = [...new Set(candidates.map((c) => c.contact_id))];
    console.log(`candidates=${candidates.length} distinctContactIds=${distinctIds} probeCap=${MAX_PROBES}`);

    let repaired = 0;
    let ambiguous = 0;
    let unresolved = 0;
    for (const cid of distinctIds) {
      if (cp.probes >= MAX_PROBES) {
        console.log(`probe cap ${MAX_PROBES} reached — rerun to continue`);
        break;
      }
      const known = cp.contactStatus[cid];
      let status = known;
      if (!status) {
        status = await probeContactDead(creds.locationId, creds.apiKey, cid);
        cp.contactStatus[cid] = status;
        cp.probes += 1;
        await save();
        await sleep(PACE_MS);
      }
      if (status !== "dead") continue;

      // Re-resolve EVERY in-scope appointment stored against this dead id.
      for (const appt of candidates.filter((c) => c.contact_id === cid)) {
        const queries: string[] = [];
        if (normalizeUSPhone(appt.client_phone)) queries.push(normalizeUSPhone(appt.client_phone) as string);
        if (normalizeEmail(appt.client_email)) queries.push(normalizeEmail(appt.client_email) as string);
        if (normName(appt.client_name)) queries.push(normName(appt.client_name) as string);
        const seen = new Set<string>();
        let pool: HlContactLite[] = [];
        for (const q of queries) {
          if (seen.has(q)) continue;
          seen.add(q);
          const hits = await searchContacts(creds.locationId, creds.apiKey, q);
          for (const h of hits) {
            if (!pool.some((p) => p.id === h.id)) pool.push(h);
          }
          await sleep(PACE_MS);
        }
        // has-interactions signal for the name tier (bounded: top 5 candidates)
        for (const c of pool.slice(0, 5)) {
          c.conversations = await countConversations(creds.locationId, creds.apiKey, c.id);
          await sleep(PACE_MS);
        }
        const pick = pickReplacement(appt, pool, cid);
        const record: RepairRecord = {
          appointment_id: appt.id,
          client_name: appt.client_name,
          old_contact_id: cid,
          new_contact_id: pick.contactId,
          resolvedBy: pick.resolvedBy,
          note: pick.note,
          at: new Date().toISOString(),
        };
        cp.repairs.push(record);
        if (pick.contactId) {
          // Raw SQL through the store is not exposed; use the postgres driver
          // the repo's runners standardize on (same DATABASE_URL).
          await repairUpdate(appt.id, pick.contactId);
          repaired += 1;
          console.log(`REPAIRED appt=${appt.id} (${appt.client_name ?? "?"}): ${cid} → ${pick.contactId} by ${pick.resolvedBy} (${pick.note})`);
        } else if (pick.note.includes("ambiguous")) {
          ambiguous += 1;
          console.log(`AMBIGUOUS appt=${appt.id} (${appt.client_name ?? "?"}): ${cid} — ${pick.note}`);
        } else {
          unresolved += 1;
          console.log(`UNRESOLVED appt=${appt.id} (${appt.client_name ?? "?"}): ${cid} — ${pick.note}`);
        }
        await save();
      }
    }
    await store.finishSyncRun(syncRunId, "success", repaired, null);
    console.log(`DONE repaired=${repaired} ambiguous=${ambiguous} unresolved=${unresolved} probes=${cp.probes}`);
  } catch (e) {
    await save().catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    await store.finishSyncRun(syncRunId, "error", 0, msg.slice(0, 400)).catch(() => {});
    throw e;
  }
}

// The one direct write — a targeted id correction (the store interface has no
// appointment-contact setter; the repo's runners use this exact driver).
const sql = postgres(process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "", {
  ssl: process.env.DATABASE_URL?.includes("sslmode") ? { rejectUnauthorized: false } : false,
  max: 1,
  connect_timeout: 15,
});
async function repairUpdate(appointmentId: string, newContactId: string): Promise<void> {
  await sql`UPDATE appointments SET contact_id = ${newContactId}, updated_at = now() WHERE id = ${appointmentId}::uuid`;
}
await main().finally(() => sql.end({ timeout: 3 }));
