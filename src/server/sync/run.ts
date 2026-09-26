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
import { createHighLevelAdapter, type LiveHighLevelAdapter } from "./highlevel-live";
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
 * of truth for the engine invocation — used by the full sync AND by the
 * background scheduler after each incremental HighLevel tick.
 */
export async function recomputeAttributions(store: Store, settings: AppSettings): Promise<number> {
  const since = etDayStartUtc(addDays(new Date().toISOString().slice(0, 10), -30));
  const [storedCalls, storedContacts, storedAppts] = await Promise.all([
    store.getAllCallsSince(since),
    store.getContacts(),
    store.getAllAppointmentsSince(since),
  ]);
  const { computeAttributions } = await import("../attribution");
  const res = computeAttributions({
    appointments: storedAppts,
    calls: storedCalls,
    contacts: storedContacts.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      assigned_rep_id: c.assigned_rep_id,
    })),
    thresholdSeconds: settings.meaningful_call_threshold_seconds,
    windowHours: settings.attribution_window_hours,
  });
  await store.upsertAttributions(res.attributions);
  return res.attributions.length;
}

export interface SyncResult {
  mode: "postgres" | "memory";
  providers: { provider: string; count: number; error: string | null }[];
  startedAt: string;
  finishedAt: string;
}

/**
 * Full sync: users → contacts → calls → opportunities → appointments + blocked
 * times → leads → attributions. HighLevel + Google Sheets are LIVE when their
 * credentials resolve (demo fallback on failure, real error recorded); Acuity
 * stays demo until its credentials arrive. Upserts keyed by external IDs;
 * safe to re-run any time.
 */
export async function runDemoSync(options?: {
  settings?: AppSettings;
  store?: Store;
  sheetsAdapter?: GoogleSheetsAdapter | null;
  highlevelAdapter?: LiveHighLevelAdapter | null;
}): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const store = options?.store ?? (await getStore());
  const settings = options?.settings ?? (await store.getSettings());
  const { highlevel: demoHl, acuity, sheets: demoSheets } = createDemoAdapters({
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

  // --- Acuity (appointments + blocked times; cancellations update in place) ---
  const acuityRes = await runProvider(store, "acuity", async () => {
    let count = 0;
    const storedContacts = await store.getContacts();
    const contactByPhone = new Map(storedContacts.map((c) => [c.phone?.replace(/\D/g, "").slice(-10) ?? "", c.id]));
    const contactByEmail = new Map(storedContacts.map((c) => [c.email?.toLowerCase() ?? "", c.id]));
    const contactByExt = new Map(storedContacts.map((c) => [c.external_id, c.id]));

    const appts = await acuity.fetchAppointments();
    await store.upsertAppointments(
      appts.map((a) => {
        // link to HighLevel contact by phone, then email (contact-ID linkage happens in attribution)
        const contactId =
          contactByExt.get(a.clientName) ??
          contactByPhone.get(a.clientPhone.replace(/\D/g, "").slice(-10)) ??
          contactByEmail.get(a.clientEmail.toLowerCase()) ??
          null;
        return {
          acuity_appointment_id: a.acuity_appointment_id,
          contact_id: contactId,
          calendar_id: a.calendarId,
          calendar_name: a.calendarName,
          appointment_type: a.appointmentType,
          appointment_datetime: a.appointmentDatetime,
          duration_minutes: a.durationMinutes,
          created_at: a.createdAt,
          status: a.status,
          cancelled: a.cancelled,
          client_name: a.clientName,
          client_phone: a.clientPhone,
          client_email: a.clientEmail,
        };
      }),
    );
    count += appts.length;

    const blocked = await acuity.fetchBlockedTimes();
    await store.upsertBlockedTimes(
      blocked.map((b) => ({ provider: "acuity", external_id: b.external_id, start_at: b.startAt, end_at: b.endAt, reason: b.reason })),
    );
    count += blocked.length;
    return { count };
  });
  results.push({ provider: "acuity", count: acuityRes.count, error: acuityRes.error ?? null });

  // --- Google Sheets (leads with work_date applied; per-sheet REPLACE) ---
  // Live adapter when the service-account secret resolves, demo seed otherwise.
  // A failed live attempt falls back to the demo lead seed so pages still have
  // honest, demo-flagged data — the real error lands in the connection row.
  const sheetsRes = await runProvider(store, "google_sheets", async () => {
    let leads: NormalizedLead[];
    let liveReport: SheetsLiveRunReport | null = null;
    let liveFailed = false;
    let liveError: string | undefined;
    if (liveSheets) {
      try {
        leads = await liveSheets.fetchLeads();
        liveReport = "lastRun" in liveSheets ? ((liveSheets as { lastRun?: SheetsLiveRunReport | null }).lastRun ?? null) : null;
      } catch (e) {
        // All sheets failed → demo fallback; the actionable error is preserved
        // for the connection row and page warnings.
        leads = await demoSheets.fetchLeads();
        liveFailed = true;
        liveReport = "lastRun" in liveSheets ? ((liveSheets as { lastRun?: SheetsLiveRunReport | null }).lastRun ?? null) : null;
        liveError = e instanceof Error ? e.message : String(e);
      }
    } else {
      leads = await demoSheets.fetchLeads();
    }

    // Link leads to HighLevel contacts (phone → email) for assigned-rep reporting.
    const storedUsers = await store.getUsers();
    const storedContacts = await store.getContacts();
    const contactByPhone = new Map(storedContacts.map((c) => [c.phone?.replace(/\D/g, "").slice(-10) ?? "", c.id]));
    const contactByEmail = new Map(storedContacts.map((c) => [c.email?.toLowerCase() ?? "", c.id]));

    // REPLACE semantics per sheet: delete the sheet's stored leads, then
    // upsert fresh. Row-per-day counts therefore replace (never add), and
    // removed sheet rows disappear. Idempotent across re-syncs (deterministic
    // source_ids), safe under partial failure (only synced sheets replaced).
    const bySheet = new Map<string, NormalizedLead[]>();
    for (const l of leads) {
      const arr = bySheet.get(l.sheet) ?? [];
      arr.push(l);
      bySheet.set(l.sheet, arr);
    }
    for (const [sheetName, sheetLeads] of bySheet) {
      await store.deleteLeadsForSheet(sheetName);
      await store.upsertLeads(
        sheetLeads.map((l) => {
          const contactId = l.phone ? contactByPhone.get(l.phone.replace(/\D/g, "").slice(-10)) ?? null : null;
          const contactId2 = contactId ?? (l.email ? contactByEmail.get(l.email.toLowerCase()) ?? null : null);
          const contact = contactId2 ? storedContacts.find((c) => c.id === contactId2) : null;
          void storedUsers;
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
    }

    const note = liveReport
      ? [
          `window from ${liveReport.windowStart}`,
          ...liveReport.perSheet.map((p) => p.ok ? `${p.sheet}: ${p.leads} leads from ${p.dataRows} rows (${p.mode})` : `${p.sheet}: FAILED`),
          ...liveReport.suggestions,
          ...liveReport.warnings.slice(0, 4),
        ].filter(Boolean).join(" · ").slice(0, 500)
      : "Demo dataset — GOOGLE_SERVICE_ACCOUNT_JSON not set";
    // Partial failure (one sheet ok, one failed) → the run records the
    // per-sheet error while successfully synced sheets are still stored.
    const failedSheets = liveReport?.perSheet.filter((p) => !p.ok) ?? [];
    const partialError = failedSheets.length
      ? failedSheets.map((f) => `${f.sheet}: ${f.error}`).join(" · ")
      : undefined;
    return {
      count: leads.length,
      error: liveFailed ? liveError : partialError,
      live: !!liveSheets && !liveFailed,
      liveFailed,
      liveError,
      note,
    };
  });
  results.push({ provider: "google_sheets", count: sheetsRes.count, error: sheetsRes.error ?? null });

  // --- Attributions (engine over STORED rows; re-runs replace, manual overrides preserved by store) ---
  const attrRes = await runProvider(store, "attribution", async () => {
    const attributions = await recomputeAttributions(store, settings);
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
  // Acuity: demo adapter until its credentials arrive (later phase).
  {
    await store.upsertConnection({
      provider: "acuity",
      status: acuityRes.error ? "error" : "demo",
      is_demo: true,
      last_sync_at: now,
      last_successful_sync_at: acuityRes.error ? null : now,
      last_error: acuityRes.error ?? null,
      config: { source: "demo-seed", note: "Demo dataset — no live provider API calls in this phase" },
    });
  }
  // Google Sheets: provider-aware honesty. Live success → connected; partial
  // success → connected with last_error (page warnings say "incomplete");
  // failed live attempt or missing secret → demo-flagged with the real error.
  {
    const live = sheetsRes.live === true;
    const liveFailed = sheetsRes.liveFailed === true;
    const partial = live && !!sheetsRes.error;
    const note = typeof sheetsRes.note === "string" ? sheetsRes.note : null;
    const liveError = typeof sheetsRes.liveError === "string" ? sheetsRes.liveError : null;
    await store.upsertConnection({
      provider: "google_sheets",
      status: live ? "connected" : liveError ? "error" : "demo",
      is_demo: !live,
      last_sync_at: now,
      last_successful_sync_at: live || !liveError ? now : null,
      last_error: partial ? sheetsRes.error ?? null : liveError ?? sheetsRes.error ?? null,
      config: {
        source: live ? "google-sheets-api" : liveError ? "google-sheets-api (failed — demo fallback)" : "demo-seed",
        note: liveFailed && liveError ? `Live sync failed — showing demo lead data until fixed. ${liveError}` : note,
      },
    });
  }

  return { mode: store.mode, providers: results, startedAt, finishedAt: new Date().toISOString() };
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
