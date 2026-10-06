/**
 * Sync runner — one sync_runs record per provider per run; duplicate-safe
 * upserts by provider external ID; cancellations update existing rows (history
 * kept via status/cancelled, never duplicated); attribution computed with the
 * real engine and persisted to booking_attributions.
 *
 * Phase 1: demo adapters only (flagged in integration_connections). Real HTTP
 * adapters plug into the same runProvider flow later.
 */
import { addDays, etDayStartUtc, weekStart } from "../date-logic";
import { isRosterUser } from "../roster";
import { getStore, type Store } from "../store";
import type { AppSettings } from "../store/types";
import { createDemoAdapters } from "./adapters";
import type { HighLevelAdapter, NormalizedLead } from "./adapters";
import { createSheetsAdapter, type SheetsLiveRunReport } from "./sheets-live";
import { isLegacySheetsSourceId, sheetLeadKey } from "./sheets-mapping";
import { migrateSheetsLeadKeys } from "./sheets-rekey";
import { createHighLevelAdapter, type LiveHighLevelAdapter } from "./highlevel-live";
import { reconcileCancellations, resolveAcuityAdapterForSync, upsertAcuityAppointments, writeAcuityConnection, type AcuityLiveAdapter } from "./acuity-live";
import type { GoogleSheetsAdapter } from "./adapters";

async function runProvider(
  store: Store,
  provider: string,
  fn: () => Promise<{ count: number; error?: string } & Record<string, unknown>>,
): Promise<{ count: number; error?: string } & Record<string, unknown>> {
  const runId = await store.insertSyncRun(provider);
  try {
    const res = await fn();
    await store.finishSyncRun(runId, res.error ? "error" : "success", res.count, res.error ?? null);
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await store.finishSyncRun(runId, "error", 0, msg);
    return { count: 0, error: msg };
  }
}

/**
 * Recompute booking attributions from STORED rows and persist them. One source
 * of truth for the engine invocation — used by the full sync (manual SYNC NOW
 * included) AND by the background scheduler after each incremental HighLevel
 * tick. Delegates to computeAndPersistAttributions (attribution-tick.ts): the
 * PURE engine (metrics/attribution.ts), appointmentInScope applied, manual
 * overrides preserved.
 */
export async function recomputeAttributions(
  store: Store,
  settings: AppSettings,
  options?: { force?: boolean },
): Promise<number> {
  const { computeAndPersistAttributions } = await import("./attribution-tick");
  const res = await computeAndPersistAttributions(store, settings, options);
  return (res.attributed ?? 0) + (res.unattributed ?? 0);
}

export interface SyncResult {
  mode: "postgres" | "memory";
  providers: { provider: string; count: number; error: string | null }[];
  startedAt: string;
  finishedAt: string;
}

/**
 * Full sync: users → contacts → calls → opportunities → appointments + blocked
 * times → leads → attributions. HighLevel, Google Sheets AND Acuity are LIVE
 * when their credentials resolve (demo fallback with the real error recorded
 * on failure — EXCEPT Acuity/HighLevel live failures, which skip demo seeding
 * so fake rows never mask real data). Upserts keyed by external IDs; safe to
 * re-run any time.
 */
export async function runDemoSync(options?: {
  settings?: AppSettings;
  store?: Store;
  sheetsAdapter?: GoogleSheetsAdapter | null;
  highlevelAdapter?: LiveHighLevelAdapter | null;
  acuityAdapter?: AcuityLiveAdapter | null;
  /** BOOTSTRAP ONLY (set by the scheduler's watermark-less branch): the
   * full-sync attribution recompute may replace demo-computed verdicts
   * wholesale — the fresh-writer takeover, not a stale-writer shape. Never
   * set on the manual SYNC NOW / incremental paths (guard stays enforced). */
  attributionForce?: boolean;
}): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const store = options?.store ?? (await getStore());
  const settings = options?.settings ?? (await store.getSettings());
  const { highlevel: demoHl, acuity } = createDemoAdapters({
    thresholdSeconds: settings.meaningful_call_threshold_seconds,
    windowHours: settings.attribution_window_hours,
  });
  // Google Sheets is LIVE when GOOGLE_SERVICE_ACCOUNT_JSON resolves; HighLevel
  // is LIVE when HIGHLEVEL_API_KEY + HIGHLEVEL_LOCATION_ID resolve; both fall
  // back to the demo adapter (with the real error recorded) if the live call
  // fails. Acuity stays on demo until its credentials arrive.
  const liveSheets: GoogleSheetsAdapter | null = options && "sheetsAdapter" in options
    ? options.sheetsAdapter ?? null
    : createSheetsAdapter(settings.sheets);
  const liveHl: LiveHighLevelAdapter | null = options && "highlevelAdapter" in options
    ? options.highlevelAdapter ?? null
    : createHighLevelAdapter();

  const results: SyncResult["providers"] = [];

  // --- HighLevel (LIVE when credentials resolve; demo fallback on failure) ---
  // Live failures fall back to the demo seed so pages still have honest,
  // demo-flagged data — the real error lands in the connection row.
  const hlRes = await runProvider(store, "highlevel", async () => {
    let adapter: HighLevelAdapter = demoHl;
    let hlLive: LiveHighLevelAdapter | null = null;
    let liveUsers: Awaited<ReturnType<LiveHighLevelAdapter["fetchUsers"]>> = [];
    let liveError: string | undefined;
    if (liveHl) {
      try {
        liveUsers = await liveHl.fetchUsers();
        // A valid key + wrong locationId often returns an empty list; treat
        // that as a failure so we never wipe demo data for an empty snapshot.
        if (liveUsers.length === 0) {
          throw new Error("Location returned 0 users — check HIGHLEVEL_LOCATION_ID (wrong location, or the key cannot see its users).");
        }
        adapter = liveHl;
        hlLive = liveHl;
      } catch (e) {
        liveError = e instanceof Error ? e.message : String(e);
      }
    }
    const live = !!hlLive;
    const report = hlLive?.lastRun ?? null;

    // LIVE configured but the fetch failed → do NOT seed demo rows. Demo reps
    // must never (re-)enter a live-connected database — the earlier "demo
    // fallback" is exactly how demo users resurfaced after cleanups. Pages
    // keep showing the last successfully synced live data (stale-data warnings
    // fire via the connection row); a DB that is still empty simply waits for
    // the next successful sync.
    if (liveHl && !hlLive) {
      return {
        count: 0,
        error: liveError,
        live: false,
        liveError,
        note: "Live sync failed — demo seed skipped (active-roster protection); showing last synced data",
      };
    }

    let count = 0;
    const users = live ? liveUsers : await adapter.fetchUsers();
    // ROSTER RULE (live only): a user is active iff name AND email match the
    // configured active roster. Non-matching users keep their rows (calls and
    // contacts may reference them) but never appear on rep surfaces. The pure
    // demo dataset (no HighLevel credentials) stays fully viewable and keeps
    // its demo banner — it is explicitly labeled, not masquerading as real.
    await store.upsertUsers(
      users.map((u) => ({
        id: "",
        provider: "highlevel",
        external_id: u.external_id,
        name: u.name,
        email: u.email,
        is_active: live ? isRosterUser(u.name, u.email, settings.active_roster) : true,
      })),
    );
    count += users.length;

    // Linkage map needs EVERY user (inactive included) so excluded users'
    // calls/contacts keep their rep references — raw rows stay resolvable.
    const storedUsers = await store.getAllUsers();
    const userIdByExt = new Map(storedUsers.map((u) => [`${u.provider}:${u.external_id}`, u.id]));

    const contacts = await adapter.fetchContacts();
    await store.upsertContacts(
      contacts.map((c) => ({
        id: "",
        provider: "highlevel",
        external_id: c.external_id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        assigned_rep_id: c.assignedRepExternalId ? userIdByExt.get(`highlevel:${c.assignedRepExternalId}`) ?? null : null,
      })),
    );
    count += contacts.length;

    const storedContacts = await store.getContacts();
    const contactIdByExt = new Map(storedContacts.map((c) => [`${c.provider}:${c.external_id}`, c.id]));

    const calls = await adapter.fetchCalls();
    await store.upsertCalls(
      calls.map((c) => ({
        provider: "highlevel",
        external_call_id: c.external_call_id,
        rep_id: userIdByExt.get(`highlevel:${c.repExternalId}`) ?? null,
        contact_id: contactIdByExt.get(`highlevel:${c.contactExternalId}`) ?? null,
        started_at: c.startedAt,
        duration_seconds: c.durationSeconds,
        over_two_minutes: c.durationSeconds > settings.meaningful_call_threshold_seconds,
        direction: c.direction,
        call_status: c.status,
      })),
    );
    count += calls.length;

    // Opportunities: only the live adapter exposes them (cheap list endpoint);
    // the demo generator doesn't seed opportunities.
    let opportunities = 0;
    if (hlLive) {
      const opps = await hlLive.fetchOpportunities();
      await store.upsertOpportunities(
        opps.map((p) => ({
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
      opportunities = opps.length;
      count += opportunities;
    }

    // LIVE success → real data replaces demo content (demo rows all carry
    // external ids prefixed "demo-"; removal is FK-safe + idempotent).
    let replacedDemo: { users: number; contacts: number; calls: number } | null = null;
    if (hlLive) {
      replacedDemo = await store.deleteDemoHighLevelRows();
    }

    const note = live
      ? [
          ...(report?.endpointNotes ?? []),
          replacedDemo && replacedDemo.users + replacedDemo.contacts + replacedDemo.calls > 0
            ? `demo rows replaced: ${replacedDemo.users} users, ${replacedDemo.contacts} contacts, ${replacedDemo.calls} calls`
            : null,
          ...(report?.warnings ?? []).slice(0, 4),
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 500)
      : "Demo dataset — HIGHLEVEL_API_KEY / HIGHLEVEL_LOCATION_ID not set";
    return {
      count,
      error: live ? undefined : liveError,
      live,
      liveError,
      note,
      opportunities,
    };
  });
  results.push({ provider: "highlevel", count: hlRes.count, error: hlRes.error ?? null });
  // Watermark: after a successful LIVE sync, everything up to the run's start
  // is stored — the background incremental scheduler resumes from here
  // (demo runs leave the watermark untouched; they never fetched live data).
  if (hlRes.live === true && !hlRes.error) {
    await store.setSyncWatermark("highlevel", startedAt);
    // S4: a successful FULL sync also refreshes the contacts walk checkpoint —
    // the full-sync contact upsert resets any no-new streak (the walk itself
    // resumes from page 1 every tick; the deep backfill cursor is never reused).
    await store.setSyncCheckpoint("hl_contacts_incremental_v1", JSON.stringify({
      lastRunAt: new Date().toISOString(),
      lastNewCount: null,
      pagesLastRun: 0,
      noNewStreak: 0,
      note: "full-sync",
      updatedAt: new Date().toISOString(),
    }));
  }

  // --- Rep goals for the current week (idempotent; only seeded if missing) ---
  {
    const storedUsers = await store.getUsers();
    const ws = weekStart(new Date().toISOString().slice(0, 10));
    const existing = await store.getRepGoals(ws);
    if (storedUsers.length && existing.length === 0) {
      await store.upsertRepGoals(
        storedUsers.map((u, i) => ({ rep_id: u.id, week_start: ws, goal: 12 + (i % 4) })),
      );
    }
  }

  // --- Acuity (LIVE when credentials resolve; demo otherwise; cancellations update in place) ---
  // Live failures do NOT seed demo rows — demo slots must never mix with (or
  // mask) live Acuity data; the pages keep the last successfully synced live
  // appointments and the connection row records the real error.
  const liveAcuity: AcuityLiveAdapter | null = options && "acuityAdapter" in options
    ? options.acuityAdapter ?? null
    : resolveAcuityAdapterForSync();
  const acuityRes = await runProvider(store, "acuity", async () => {
    if (liveAcuity) {
      try {
        const appts = await liveAcuity.fetchAppointments();
        // first thing a successful live sync does: purge demo Acuity rows so
        // demo slots can never blend into live availability
        const purged = await store.deleteDemoAcuityRows();
        const count = await upsertAcuityAppointments(store, appts);
        // CANCELLATION RECONCILIATION (owner report 10/6): rows absent from
        // the list are probed against the single-appointment GET and marked
        // cancelled — the list endpoint never returns cancelled rows.
        const reconciliation = await reconcileCancellations(store, liveAcuity, appts);
        const report = liveAcuity.lastRun;
        const note = [
          report ? `window ${report.window.minDate} → ${report.window.maxDate}` : null,
          `${count} appointments`,
          purged.appointments + purged.blocked > 0 ? `demo rows purged: ${purged.appointments} appointments, ${purged.blocked} blocks` : null,
          reconciliation.markedCancelled > 0 ? `cancellations confirmed: ${reconciliation.markedCancelled}` : null,
          reconciliation.notFound > 0 ? `missing-from-list rows probed: ${reconciliation.probed}, not found: ${reconciliation.notFound}` : null,
          report?.truncated ? "TRUNCATED at cap" : null,
          ...(report?.warnings ?? []).slice(0, 2),
          ...reconciliation.warnings.slice(0, 2),
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 500);
        return { count, live: true, note, purged };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          count: 0,
          error: msg,
          live: false,
          liveError: msg,
          note: "Live Acuity sync failed — demo seed skipped; showing last synced data",
        };
      }
    }
    // Demo path (no credentials): the seeded demo dataset, labeled demo.
    let count = 0;
    const appts = await acuity.fetchAppointments();
    count += await upsertAcuityAppointments(store, appts);
    const blocked = await acuity.fetchBlockedTimes();
    await store.upsertBlockedTimes(
      blocked.map((b) => ({ provider: "acuity", external_id: b.external_id, start_at: b.startAt, end_at: b.endAt, reason: b.reason })),
    );
    count += blocked.length;
    return { count, live: false, note: null };
  });
  results.push({ provider: "acuity", count: acuityRes.count, error: acuityRes.error ?? null });

  // --- Google Sheets (leads with work_date applied; UPSERT-ONLY under v2 content keys) ---
  // ONE implementation shared with the background sheets tick (sheets-tick.ts):
  // live adapter when the service-account secret resolves, demo seed otherwise
  // (see runSheetsSync for the demo-replace guard). The sync_runs row + result
  // wrapping stays here; the connection row is written inside runSheetsSync.
  const sheetsRes = await runProvider(store, "google_sheets", () => runSheetsSync(store, settings, liveSheets));
  results.push({ provider: "google_sheets", count: sheetsRes.count, error: sheetsRes.error ?? null });

  // --- Attributions (engine over STORED rows; re-runs replace, manual overrides preserved by store) ---
  const attrRes = await runProvider(store, "attribution", async () => {
    const attributions = await recomputeAttributions(store, settings, { force: options?.attributionForce === true });
    return { count: attributions };
  });
  results.push({ provider: "attribution", count: attrRes.count, error: attrRes.error ?? null });

  // --- connection status ---
  const now = new Date().toISOString();
  // HighLevel: provider-aware honesty. Live success → connected; live failure
  // → demo fallback shown with the real error; no credentials → demo.
  {
    const live = hlRes.live === true;
    const liveError = typeof hlRes.liveError === "string" ? hlRes.liveError : null;
    const note = typeof hlRes.note === "string" ? hlRes.note : null;
    await store.upsertConnection({
      provider: "highlevel",
      status: live ? "connected" : liveError ? "error" : "demo",
      // A failed LIVE attempt leaves the last synced LIVE data on the pages —
      // that is stale real data, not demo data (demo seeding is skipped).
      is_demo: !live && !liveError,
      last_sync_at: now,
      // demo data that synced cleanly counts as a completed sync (same
      // semantics as the sheets demo fallback); a failed live attempt does not
      last_successful_sync_at: live || !liveError ? now : null,
      last_error: liveError ?? null,
      config: {
        source: live ? "highlevel-api" : liveError ? "highlevel-api (failed — showing last synced data)" : "demo-seed",
        note: liveError ? `Live sync failed — demo seed skipped (roster protection); showing last synced data until fixed. ${liveError}` : note,
      },
    });
  }
  // Acuity: provider-aware honesty via the shared writer — live success →
  // connected; live failure → error (last successful timestamp preserved); no
  // credentials → demo.
  {
    const live = acuityRes.live === true;
    const liveError = typeof acuityRes.liveError === "string" ? acuityRes.liveError : null;
    const note = typeof acuityRes.note === "string" ? acuityRes.note : null;
    await writeAcuityConnection(store, {
      live,
      error: liveError,
      note: liveError
        ? `Live sync failed — demo seed skipped; showing last synced data until fixed. ${liveError}`.slice(0, 500)
        : live
          ? note ?? "Live Acuity sync"
          : "Demo dataset — ACUITY_USER_ID / ACUITY_API_KEY not set",
      nowIso: now,
    });
  }
  // Google Sheets: provider-aware honesty is written by runSheetsSync above
  // (live → connected; partial → connected with last_error; failed live
  // attempt → error with the last successful timestamp preserved; demo →
  // demo-flagged with the real error).

  return { mode: store.mode, providers: results, startedAt, finishedAt: new Date().toISOString() };
}

// ---------- Google Sheets sync core (full sync + background tick) ----------

export interface SheetsSyncResult {
  count: number;
  error?: string;
  live: boolean;
  liveFailed?: boolean;
  liveError?: string;
  note: string | null;
}

/**
 * The Google Sheets portion of a sync — ONE implementation shared by the full
 * sync (runDemoSync above; manual SYNC NOW included) and the background sheets
 * tick (sheets-tick.ts): fetch → link to HighLevel contacts (phone → email) →
 * UPSERT-ONLY storage under v2 CONTENT keys → provider-honest connection row.
 * Throws only on store failures; the adapter's fetch outcome is returned,
 * never thrown.
 *
 * UPSERT-ONLY, NO REPLACE (owner directive 2026-09-28): leads are keyed by
 * CONTENT (sheets-mapping.sheetLeadKey — sheet + source_date + phone/email),
 * never by row position, and a sync NEVER mass-deletes stored leads the fetch
 * didn't include. Reordering/inserting/deleting source rows cannot scramble
 * stored data: unchanged rows upsert to themselves (no-op), genuinely new
 * rows are added, and a deleted source row's lead stays stored (history — the
 * cohort math depends on stored rows; the sheets backfill window is
 * 2026-08-24 onward). The old per-sheet REPLACE (delete-all + reinsert) was
 * the scrambler: any transient mid-edit fetch then rewrote the whole sheet's
 * stored dates (observed live: 315 → 262 → 183 → 315 within an hour).
 *
 * DEMO-REPLACE GUARD (owner directive 2026-09-28): demo lead rows may only
 * ever seed a dataset that has NO stored google_sheets leads at all — a failed
 * or absent live fetch NEVER demo-REPLACEs stored leads. Demo rows already
 * stored (a demo-mode database) are purged — by their `demo-` source_id
 * prefix, a targeted delete — on the first SUCCESSFUL live sync, so live data
 * never blends with demo rows. Real rows are never touched by the purge.
 */
export async function runSheetsSync(
  store: Store,
  settings: AppSettings,
  adapter: GoogleSheetsAdapter | null,
  options?: { nowIso?: string },
): Promise<SheetsSyncResult> {
  const { sheets: demoSheets } = createDemoAdapters({
    thresholdSeconds: settings.meaningful_call_threshold_seconds,
    windowHours: settings.attribution_window_hours,
  });

  let leads: NormalizedLead[] | null = null;
  let liveReport: SheetsLiveRunReport | null = null;
  let liveFailed = false;
  let liveError: string | undefined;
  let demoSeeded = false;
  let storedBefore = 0;

  const lastRunOf = (a: GoogleSheetsAdapter) => ("lastRun" in a ? ((a as { lastRun?: SheetsLiveRunReport | null }).lastRun ?? null) : null);
  if (adapter) {
    try {
      leads = await adapter.fetchLeads();
      liveReport = lastRunOf(adapter);
    } catch (e) {
      // ALL sheets failed → the actionable error is preserved for the
      // connection row and page warnings; stored leads are left untouched.
      liveFailed = true;
      liveReport = lastRunOf(adapter);
      liveError = e instanceof Error ? e.message : String(e);
    }
  }
  if (leads === null) {
    // Demo path (no adapter, or the live fetch failed): demo rows may only
    // ever seed a dataset with no stored google_sheets leads.
    storedBefore = await store.countLeads("google_sheets");
    if (storedBefore === 0) {
      leads = await demoSheets.fetchLeads();
      demoSeeded = true;
    }
  }

  let count = 0;
  let purgeNote: string | null = null;
  let rekeyNote: string | null = null;
  let driftNote: string | null = null;
  if (leads !== null) {
    // LIVE content only: normalize every incoming lead's id to its v2 CONTENT
    // key (parseSheetRows already emits v2; hand-rolled adapters/stubs may
    // not). Ordinals for full-identity collisions follow first-seen order —
    // the same deterministic rule as the parser, so ids match byte-for-byte.
    // The demo seed keeps its `demo-` ids (the first live sync purges by that
    // prefix — re-keyed demo rows would be indistinguishable from real rows).
    if (!demoSeeded) {
      const seen = new Map<string, number>();
      leads = leads.map((l) => {
        const base = sheetLeadKey(l.sheet, l.sourceDate, l.phone, l.email);
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        const id = n === 1 ? base : `${base}#${n}`;
        return id === l.source_id ? l : { ...l, source_id: id };
      });
    }

    // Link leads to HighLevel contacts (phone → email) for assigned-rep
    // reporting — skipped entirely when no fetched lead carries a phone/email
    // (count-mode sheets: the per-day totals this dashboard reports), so a
    // background tick never materializes the full contacts table for nothing.
    const needContacts = leads.some((l) => l.phone || l.email);
    const storedContacts = needContacts ? await store.getContacts() : [];
    const contactByPhone = new Map(storedContacts.map((c) => [c.phone?.replace(/\D/g, "").slice(-10) ?? "", c.id]));
    const contactByEmail = new Map(storedContacts.map((c) => [c.email?.toLowerCase() ?? "", c.id]));

    // UPSERT-ONLY housekeeping (live content only — never the demo seed):
    // 1) purge demo rows by their `demo-` id prefix on the first successful
    //    live sync (targeted; real rows untouched — see docblock);
    // 2) one-time re-key of legacy v1 row-derived ids to v2 content keys
    //    (idempotent; mirrors scratch/sheets-repair-now.ts's rebuild).
    if (!demoSeeded) {
      const storedAll = await store.getLeadsByProvider("google_sheets");
      const demoIds = storedAll.filter((l) => l.source_id.startsWith("demo-")).map((l) => l.source_id);
      if (demoIds.length > 0) {
        const purged = await store.deleteLeadsBySourceIds("google_sheets", demoIds);
        purgeNote = `${purged} demo lead rows purged on first live sync`;
      }
      if (storedAll.some((l) => isLegacySheetsSourceId(l.source_id) && !l.source_id.startsWith("demo-"))) {
        const re = await migrateSheetsLeadKeys(store);
        if (re.rekeyed > 0) {
          rekeyNote = `re-keyed ${re.rekeyed} legacy row-keyed leads to content keys${re.workDateFixed ? ` (${re.workDateFixed} work_date fixed)` : ""}`;
        }
      }
    }

    // Drift guard (recurrence protection): under stable content keys a lead's
    // source_date can never change (it IS the key) and work_date only when
    // the work-date RULE changes. Any such change is loud in the run note.
    const storedForDrift = leads.length ? await store.getLeadsByProvider("google_sheets") : [];
    const storedById = new Map(storedForDrift.map((l) => [l.source_id, l]));
    const drift: string[] = [];

    // Per-sheet upsert — NO delete. Rows the fetch no longer includes stay
    // stored (history); genuinely new rows are added; unchanged rows are
    // byte-identical no-ops.
    const bySheet = new Map<string, NormalizedLead[]>();
    for (const l of leads) {
      const arr = bySheet.get(l.sheet) ?? [];
      arr.push(l);
      bySheet.set(l.sheet, arr);
    }
    for (const [sheetName, sheetLeads] of bySheet) {
      await store.upsertLeads(
        sheetLeads.map((l) => {
          const existing = storedById.get(l.source_id);
          if (existing && (existing.source_date !== l.sourceDate || existing.work_date !== l.workDate)) {
            drift.push(`${sheetName}:${l.source_id.slice(0, 40)} ${existing.source_date}/${existing.work_date}→${l.sourceDate}/${l.workDate}`);
          }
          const contactId = l.phone ? contactByPhone.get(l.phone.replace(/\D/g, "").slice(-10)) ?? null : null;
          const contactId2 = contactId ?? (l.email ? contactByEmail.get(l.email.toLowerCase()) ?? null : null);
          const contact = contactId2 ? storedContacts.find((c) => c.id === contactId2) : null;
          return {
            provider: "google_sheets",
            source_id: l.source_id,
            lead_type: l.leadType,
            source_date: l.sourceDate,
            work_date: l.workDate,
            name: l.name,
            phone: l.phone,
            email: l.email,
            contact_id: contactId2,
            assigned_rep_id: contact?.assigned_rep_id ?? null,
            source_sheet: l.sheet,
          };
        }),
      );
      count += sheetLeads.length;
    }

    if (drift.length > 0) {
      driftNote = `LEAD-DATE-DRIFT: ${drift.length} stored lead(s) changed source/work date under a stable content key — investigate the sheet or work-date logic (e.g. ${drift[0]})`;
    }
  }

  // Collisions (full identity duplicates, kept with #N suffixes) surface in
  // the note so chronic duplicates in a sheet are visible.
  const collisions = (liveReport?.perSheet ?? []).reduce((n, p) => n + (p.collisions ?? 0), 0);
  const collisionNote = collisions > 0 ? `${collisions} duplicate identity rows kept with #N suffixes` : null;

  // Partial failure (one sheet ok, one failed) → the run records the per-sheet
  // error while successfully synced sheets are still stored.
  const failedSheets = liveReport?.perSheet.filter((p) => !p.ok) ?? [];
  const partialError = failedSheets.length
    ? failedSheets.map((f) => `${f.sheet}: ${f.error}`).join(" · ")
    : undefined;
  const live = !!adapter && !liveFailed;
  const partial = live && !!partialError;

  // Housekeeping segments (drift/purge/re-key/collisions) ALWAYS lead the
  // note — the 500-char cap must never eat a drift warning, and stub adapters
  // (no lastRun) still carry them.
  const housekeeping = [driftNote, purgeNote, rekeyNote, collisionNote].filter(Boolean).join(" · ");
  const noteBase = liveFailed && liveError
    ? (demoSeeded
        ? `Live sync failed — showing demo lead data until fixed. ${liveError}`
        : `Live sync failed — stored leads untouched, showing last synced data until fixed. ${liveError}`)
    : liveReport
      ? [
          `window from ${liveReport.windowStart}`,
          ...liveReport.perSheet.map((p) => p.ok ? `${p.sheet}: ${p.leads} leads from ${p.dataRows} rows (${p.mode})` : `${p.sheet}: FAILED`),
          ...liveReport.suggestions,
          ...liveReport.warnings.slice(0, 4),
        ].filter(Boolean).join(" · ").slice(0, 500)
      : demoSeeded
        ? "Demo dataset — GOOGLE_SERVICE_ACCOUNT_JSON not set"
        : storedBefore > 0
          ? `Demo seed skipped — ${storedBefore} stored google_sheets leads kept (demo rows never replace live data)`
          : null;
  const note = [housekeeping || null, noteBase].filter(Boolean).join(" · ").slice(0, 500) || null;

  // Connection row: provider-aware honesty. Live success → connected (partial
  // → connected with last_error); failed live attempt → error with the last
  // successful timestamp PRESERVED (stale-data warnings read it — the old
  // shape nulled it, hiding how stale the pages were); no credentials →
  // demo-flagged. is_demo tracks the stored CONTENT: demo only when demo rows
  // were actually stored (a failed live attempt leaves live rows behind).
  const nowIso = options?.nowIso ?? new Date().toISOString();
  const previous = (await store.getConnections()).find((c) => c.provider === "google_sheets");
  await store.upsertConnection({
    provider: "google_sheets",
    status: live ? "connected" : liveError ? "error" : "demo",
    is_demo: demoSeeded,
    last_sync_at: nowIso,
    // A FAILED live attempt does not claim a successful sync (demo fallback
    // included — the old contract, pinned by tests); a plain demo seed or a
    // live success does. The previous successful timestamp is preserved
    // otherwise so stale-data warnings keep working.
    last_successful_sync_at: live || (demoSeeded && !liveFailed) ? nowIso : previous?.last_successful_sync_at ?? null,
    last_error: partial ? partialError ?? null : liveError ?? null,
    config: {
      source: live
        ? "google-sheets-api"
        : liveError
          ? demoSeeded ? "google-sheets-api (failed — demo fallback)" : "google-sheets-api (failed — stored leads untouched)"
          : demoSeeded ? "demo-seed" : "google-sheets (not configured — stored leads kept)",
      note,
    },
  });

  return {
    count,
    error: liveFailed ? liveError : partialError,
    live,
    liveFailed,
    liveError,
    note,
  };
}

/**
 * Ensure the store has demo data (called before page queries). A seed mutex
 * guards against concurrent cold-start requests: several requests can observe
 * an empty users table at once, and racing seeds caused first-load 500s on a
 * fresh DB — they now share one in-flight promise instead.
 */
let seedInflight: Promise<{ seeded: boolean; mode: "postgres" | "memory" }> | null = null;
/**
 * With a live-connected HighLevel whose API is temporarily failing, an empty
 * users table can no longer be demo-filled — instead the seed retries each
 * page load. Throttle those retries so a failing API never turns the site
 * into a backfill hammer (one full attempt per minute at most).
 */
const SEED_RETRY_MS = 60_000;
let lastSeedAttempt = 0;

export async function ensureDemoData(): Promise<{ seeded: boolean; mode: "postgres" | "memory" }> {
  if (seedInflight) return seedInflight;
  seedInflight = (async () => {
    const store = await getStore();
    const users = await store.getUsers();
    if (users.length === 0) {
      if (Date.now() - lastSeedAttempt < SEED_RETRY_MS) return { seeded: false, mode: store.mode };
      lastSeedAttempt = Date.now();
      await seedSettingsAndGoals(store);
      await runDemoSync({ store });
      return { seeded: true, mode: store.mode };
    }
    return { seeded: false, mode: store.mode };
  })();
  try {
    return await seedInflight;
  } finally {
    seedInflight = null;
  }
}

/** Seed settings + goals defaults (idempotent). */
export async function seedSettingsAndGoals(store: Store): Promise<void> {
  const settings = await store.getSettings();
  await store.upsertAvailabilityRules(settings.studio.hours);
  const todayIso = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < 4; i++) {
    const ws = weekStart(addDays(todayIso, -7 * i));
    const existing = await store.getTeamGoal(ws);
    if (!existing) {
      await store.upsertTeamGoal({ week_start: ws, booking_goal: 79, lead_budget: 700 });
    }
    // rep goals seeded at sync time (needs users to exist)
  }
}
