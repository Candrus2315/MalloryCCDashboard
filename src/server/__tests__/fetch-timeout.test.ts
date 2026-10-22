/**
 * PER-FETCH HARD TIMEOUT tests (reliability Phase 2b, 2026-10-22) — every
 * outbound sync call is bounded per HTTP CALL (never per run) by
 * sync/fetch-timeout.ts, so a single hung provider call:
 *   (a) aborts within the cap with the provider-named message
 *       ("fetch timeout after 90s (provider=google_sheets) — hung request
 *       aborted") and its RUN is marked error honestly;
 *   (b) can never block the OTHER providers in the same tick (the 10/21 GHL
 *       wedges + the 10/22-morning sheets-hung-at-wake incident class);
 *   (c) leaves the stale-run reaper untouched (rows it closes are 'error',
 *       which the reaper never touches; live rows keep being reaped).
 *
 * All tests inject a never-resolving/stub fetchImpl and a tiny per-call cap —
 * no live API, no long waits (the injected cap bypasses the env clamp on
 * purpose; the clamp only guards the env-derived default).
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { MemoryStore } from "../store/memory";
import {
  DEFAULT_SYNC_FETCH_TIMEOUT_MS,
  FetchTimeoutError,
  SYNC_FETCH_TIMEOUT_ENV,
  isFetchTimeoutError,
  syncFetchTimeoutMs,
  timedFetch,
} from "../sync/fetch-timeout";
import { HighLevelError, hlRequest } from "../sync/highlevel-live";
import { harvestIncremental } from "../sync/highlevel-incremental";
import { LiveSheetsAdapter } from "../sync/sheets-live";
import { AcuityLiveAdapter } from "../sync/acuity-live";
import { AcuityAvailabilityClient } from "../sync/acuity-availability";
import { schedulerTick, reapStaleSyncRuns } from "../sync/scheduler";
import { sheetsTick } from "../sync/sheets-tick";

const CREDS = { apiKey: "test-api-key", locationId: "loc_123" };
const ACUITY_CREDS = { userId: "u1", apiKey: "a1" };

/** A fetch impl that NEVER settles (and never honors the abort signal) — the hung-call fixture. */
function hangingFetch(seen?: { url: string }[]) {
  return (url: string): Promise<Response> => {
    seen?.push({ url });
    return new Promise<Response>(() => {});
  };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/**
 * A REAL RSA private key (PEM) so readServiceAccount's parse + JWT signing
 * succeed and the test reaches the (hanging) fetch. Generated once — nothing
 * is ever sent anywhere; the fetch impl is the hanging stub.
 */
const TEST_SA_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const TEST_SA_JSON = JSON.stringify({ client_email: "sync-test@example.iam.gserviceaccount.com", private_key: TEST_SA_PEM });

/** Swap in the hermetic service-account env for the duration of `fn`. */
async function withTestServiceAccount(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = TEST_SA_JSON;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    else process.env.GOOGLE_SERVICE_ACCOUNT_JSON = prev;
  }
}

// ---------- resolver ----------
describe("syncFetchTimeoutMs", () => {
  test("default ~90s when the env var is unset/blank/invalid", () => {
    expect(syncFetchTimeoutMs(undefined)).toBe(DEFAULT_SYNC_FETCH_TIMEOUT_MS);
    expect(DEFAULT_SYNC_FETCH_TIMEOUT_MS).toBe(90_000);
    expect(syncFetchTimeoutMs("")).toBe(DEFAULT_SYNC_FETCH_TIMEOUT_MS);
    expect(syncFetchTimeoutMs("not-a-number")).toBe(DEFAULT_SYNC_FETCH_TIMEOUT_MS);
    expect(syncFetchTimeoutMs("-5")).toBe(DEFAULT_SYNC_FETCH_TIMEOUT_MS);
    expect(syncFetchTimeoutMs("0")).toBe(DEFAULT_SYNC_FETCH_TIMEOUT_MS);
  });

  test("env override wins; clamped to a sane band (5s..10min)", () => {
    expect(syncFetchTimeoutMs("120000")).toBe(120_000);
    expect(syncFetchTimeoutMs("1000")).toBe(5_000); // below the floor → floor
    expect(syncFetchTimeoutMs("60000000")).toBe(600_000); // above the ceiling → ceiling
  });

  test("reads process.env at call time with the documented name", () => {
    const prev = process.env[SYNC_FETCH_TIMEOUT_ENV];
    try {
      process.env[SYNC_FETCH_TIMEOUT_ENV] = "7000";
      expect(syncFetchTimeoutMs()).toBe(7_000);
    } finally {
      if (prev === undefined) delete process.env[SYNC_FETCH_TIMEOUT_ENV];
      else process.env[SYNC_FETCH_TIMEOUT_ENV] = prev;
    }
  });
});

// ---------- the shared bound ----------
describe("timedFetch", () => {
  test("(a) a never-resolving fetch rejects with the provider-named timeout WITHIN the cap", async () => {
    const started = Date.now();
    const cap = 150;
    const err = await timedFetch(hangingFetch(), "https://provider.test/x", { method: "GET" }, { provider: "google_sheets", timeoutMs: cap }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(FetchTimeoutError);
    expect(isFetchTimeoutError(err)).toBe(true);
    expect((err as Error).message).toBe(`fetch timeout after ${cap}ms (provider=google_sheets) — hung request aborted`);
    expect(Date.now() - started).toBeLessThan(5_000); // well inside the timeout window
  });

  test("second-scale caps render as seconds in the message (the 90s default shape)", () => {
    const e = new FetchTimeoutError("google_sheets", 90_000);
    expect(e.message).toBe("fetch timeout after 90s (provider=google_sheets) — hung request aborted");
  });

  test("a fast response passes through and the race timer is cleared (no unref'd pendings)", async () => {
    const res = await timedFetch(
      async () => json({ ok: true }),
      "https://provider.test/x",
      { method: "GET" },
      { provider: "acuity", timeoutMs: 5_000 },
    );
    expect(res.status).toBe(200);
  });

  test("the composed signal reaches the impl (caller signal + cap signal)", async () => {
    let captured: AbortSignal | undefined;
    const impl = async (_url: string, init?: { signal?: AbortSignal }) => {
      captured = init?.signal;
      return json({});
    };
    await timedFetch(impl, "https://provider.test/x", { method: "GET" }, { provider: "acuity", timeoutMs: 5_000 });
    expect(captured).toBeDefined();
    expect(captured?.aborted).toBe(false);
  });
});

// ---------- per-provider wiring ----------
describe("per-fetch timeout wiring per provider", () => {
  test("highlevel: hlRequest marks the failure as network class with the named message", async () => {
    const err = await hlRequest({ path: "/users/", query: new URLSearchParams({ locationId: CREDS.locationId }) }, {
      creds: CREDS,
      fetchImpl: hangingFetch(),
      sleep: async () => {},
      timeoutMs: 120,
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(HighLevelError);
    expect((err as HighLevelError).kind).toBe("network");
    expect((err as Error).message).toBe("fetch timeout after 120ms (provider=highlevel) — hung request aborted");
  });

  test("highlevel: harvestIncremental (the RUN's engine) fails honestly on a hung call", async () => {
    const err = await harvestIncremental({
      creds: CREDS,
      fetchImpl: hangingFetch(),
      sleep: async () => {},
      timeoutMs: 120,
      sinceMs: Date.now() - 60_000,
    }).then(
      () => null,
      (e) => e,
    );
    expect((err as Error).message).toContain("fetch timeout after 120ms (provider=highlevel)");
  });

  test("google_sheets: a hung fetch surfaces the provider-named error through the REAL adapter", async () =>
    withTestServiceAccount(async () => {
      const adapter = new LiveSheetsAdapter(
        { family: { sheet_id: "s1", mode: "name", columns: {} }, animalia: { sheet_id: "s2", mode: "name", columns: {} } } as never,
        30,
        { fetchImpl: hangingFetch(), timeoutMs: 150 },
      );
      const err = await adapter.fetchLeads().then(
        () => null,
        (e) => e,
      );
      expect((err as Error).message).toContain("fetch timeout after 150ms (provider=google_sheets)");
    }));

  test("google_sheets: the sheetsTick RUN row is marked error with the timeout message", async () =>
    withTestServiceAccount(async () => {
      const store = new MemoryStore();
      const adapter = new LiveSheetsAdapter(
        { family: { sheet_id: "s1", mode: "name", columns: {} }, animalia: { sheet_id: "s2", mode: "name", columns: {} } } as never,
        30,
        { fetchImpl: hangingFetch(), timeoutMs: 150 },
      );
      const res = await sheetsTick({ store, adapter, trigger: "manual" });
      expect(res.outcome).toBe("error");
      expect(res.error).toContain("fetch timeout after 150ms (provider=google_sheets)");
      const row = (await store.getSyncRuns(5)).find((r) => r.provider === "google_sheets");
      expect(row?.status).toBe("error");
      expect(row?.error).toContain("fetch timeout after 150ms (provider=google_sheets)");
    }));

  test("acuity: a hung call aborts with the provider-named message", async () => {
    const adapter = new AcuityLiveAdapter(ACUITY_CREDS, hangingFetch() as never, async () => {}, 150);
    const err = await adapter.fetchAppointmentTypes().then(
      () => null,
      (e) => e,
    );
    expect((err as Error).message).toContain("fetch timeout after 150ms (provider=acuity)");
  });

  test("acuity_availability feed: a hung call aborts with the provider-named message", async () => {
    const client = new AcuityAvailabilityClient(ACUITY_CREDS, hangingFetch() as never, async () => {}, 150);
    const err = await client.fetchCalendars().then(
      () => null,
      (e) => e,
    );
    expect((err as Error).message).toContain("fetch timeout after 150ms (provider=acuity_availability)");
  });
});

// ---------- the tick-level incident pattern ----------
describe("schedulerTick with a hung provider call (10/22 morning pattern)", () => {
  test("sheets hung at wake: its run errors honestly and every other provider still completes; no zombie rows; reaper unaffected", async () =>
    withTestServiceAccount(async () => {
      const store = new MemoryStore();
      await store.setSyncWatermark("highlevel", new Date(Date.now() - 120_000).toISOString());

      // GHL succeeds (incremental fixtures); sheets hangs at the token call.
      const ghlFetch = async (url: string): Promise<Response> => {
        const path = String(url).split("?")[0];
        if (path.endsWith("/users/")) return json({ users: [{ id: "usr_new", firstName: "Alex", lastName: "Morgan", email: "alex@mallory.test" }] });
        if (path.endsWith("/conversations/search")) return json({ conversations: [] });
        if (path.endsWith("/contacts/cnt_new")) return json({ contact: { id: "cnt_new", contactName: "Emma Carter", assignedTo: "usr_new" } });
        return json({});
      };
      const hangingLiveSheets = new LiveSheetsAdapter(
        { family: { sheet_id: "s1", mode: "name", columns: {} }, animalia: { sheet_id: "s2", mode: "name", columns: {} } } as never,
        30,
        { fetchImpl: hangingFetch(), timeoutMs: 150 },
      );

      const started = Date.now();
      const res = await schedulerTick({
        store,
        creds: CREDS,
        fetchImpl: ghlFetch,
        sleep: async () => {},
        trigger: "manual", // manual bypasses the module-level commission/retention throttles — other test files tick the same process and would otherwise legitimately skip commission here
        liveAdapters: { sheets: hangingLiveSheets },
        acuityAdapter: null, // no credentials → skipped (nothing to hang behind sheets)
      });
      const elapsed = Date.now() - started;

      // (a) the hung provider's run failed HONESTLY within its cap — not aged
      // until the reaper window (the tick would have taken 15+ min before).
      expect(elapsed).toBeLessThan(15_000);
      expect(res.sheets?.outcome).toBe("error");
      expect(res.sheets?.error).toContain("fetch timeout after 150ms (provider=google_sheets)");
      const sheetsRow = (await store.getSyncRuns(30)).find((r) => r.provider === "google_sheets");
      expect(sheetsRow?.status).toBe("error");
      expect(sheetsRow?.error).toContain("fetch timeout after 150ms (provider=google_sheets)");

      // (b) the OTHER providers in the SAME tick still completed.
      expect(res.outcome).toBe("synced"); // highlevel harvested + stored
      expect(res.mode).toBe("incremental");
      expect(typeof res.attributions).toBe("number"); // attribution ran after sheets
      expect(res.commission).toBeDefined();
      expect(res.availabilityFeed).toBeDefined(); // ran after the hung sheets piece
      expect(res.retention).toBeDefined();
      const hlRow = (await store.getSyncRuns(30)).find((r) => r.provider === "highlevel");
      expect(hlRow?.status).toBe("success");

      // No zombie "running" rows — every run the tick started, it closed.
      expect(await store.getRunningSyncRuns()).toHaveLength(0);

      // (c) reaper behavior unaffected: closed rows are never its business…
      const later = new Date(Date.now() + 2 * 3_600_000);
      expect(await reapStaleSyncRuns(store, () => later)).toBe(0);
      // …and a genuinely stale 'running' row still gets reaped exactly as before.
      await store.insertSyncRun("google_sheets");
      expect(await reapStaleSyncRuns(store, () => later)).toBe(1);
    }));
});
