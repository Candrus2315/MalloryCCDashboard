/**
 * SHEETS ADAPTER FRESHNESS — regression for the 2026-10-22 "fairyland emits 0
 * leads" incident, root cause 1 (the live blocker).
 *
 * serve.ts used to build `createSheetsAdapter(settings)` ONCE at boot and
 * thread it into `startScheduler({ liveAdapters: { sheets } })`; every
 * consumer — the tick AND the freshness watchdog's forced recovery syncs —
 * then reused that frozen object. The serve process booted 18:31; the owner
 * saved the fairyland sheet config 19:54:02; every google_sheets run after
 * that logged "fairyland: no sheet id configured — skipped" because the
 * frozen adapter's settings snapshot predated the save.
 *
 * The fix: serve.ts passes NOTHING to startScheduler — every consumer
 * resolves its adapter from the store's CURRENT settings per tick
 * (sheets-tick.ts per call; run.ts per full-sync run; freshness-watchdog.ts
 * per forced attempt). Pinned here:
 *  1. sheetsTick with NO injected adapter hands createSheetsAdapter the
 *     store's CURRENT settings on EVERY call — a config saved between two
 *     ticks is seen by the second tick (the guarantee the fix relies on);
 *  2. schedulerTick without liveAdapters resolves the sheets adapter the
 *     same way (the wiring the production loop now uses);
 *  3. serve.ts no longer builds a boot adapter nor threads liveAdapters into
 *     startScheduler (source assertion on the exact wiring that froze).
 *
 * The sheets-live module seam is mocked: createSheetsAdapter records its cfg
 * argument and returns a stub. Under `bun test` the real factory returns null
 * by design (tests must never hit live Google Sheets), so the recorder is the
 * only way to observe WHICH settings snapshot a tick resolved.
 */
import { describe, expect, test, mock } from "bun:test";
import { readFileSync } from "node:fs";
import type { AppSettings } from "../store/types";

// --- module seam: record createSheetsAdapter calls, return a stub adapter ---
const realSheetsLive = await import("../sync/sheets-live");
const cfgCalls: AppSettings["sheets"][] = [];
mock.module("../sync/sheets-live", () => ({
  ...realSheetsLive,
  createSheetsAdapter: (cfg: AppSettings["sheets"]) => {
    cfgCalls.push(JSON.parse(JSON.stringify(cfg)) as AppSettings["sheets"]);
    return { provider: "google_sheets", isDemo: false, fetchLeads: async () => [] };
  },
}));

// Consumers of the mocked module — imported AFTER the mock is registered.
const { sheetsTick } = await import("../sync/sheets-tick");
const { schedulerTick } = await import("../sync/scheduler");
const { MemoryStore } = await import("../store/memory");
const { SETTINGS_OWNER_ACTOR } = await import("../store/types");

/** The owner's real fairyland source id (value mirrors the 19:54:02 save;
 * nothing here touches live settings — a MemoryStore-local write only). */
const FAIRYLAND_ID = "1dT_7KABCOuv3L4kEJiyxlMyEsxLl42snaJPxzlXVO3U";

async function saveFairylandConfig(store: MemoryStore): Promise<void> {
  const settings = await store.getSettings();
  await store.saveSettings(
    {
      sheets: {
        ...settings.sheets,
        fairyland: { ...settings.sheets.fairyland, sheet_id: FAIRYLAND_ID, mode: "row_per_lead" },
      },
    },
    SETTINGS_OWNER_ACTOR, // owner-labeled write: mergeSheetsSettings honors the mode
  );
}

describe("sheets adapter resolves fresh per tick (boot-frozen-adapter regression)", () => {
  test("sheetsTick with NO injected adapter sees a config saved BETWEEN two ticks", async () => {
    const store = new MemoryStore();
    // Tick 1: settings WITHOUT fairyland (default sheet_id is "").
    const first = await sheetsTick({ store, trigger: "background" });
    expect(first.outcome).toBe("synced"); // stub adapter; run completes with 0 leads
    expect(cfgCalls.length).toBe(1);
    expect(cfgCalls[0].fairyland.sheet_id).toBe(""); // the pre-save snapshot
    // Mid-flight settings save — the exact incident shape (19:54:02 vs a boot
    // at 18:31): the owner saves the fairyland config while the process runs.
    await saveFairylandConfig(store);
    // Tick 2: STILL no injected adapter — must resolve the NEW config. (The
    // adapter is resolved before the background throttle can skip the tick.)
    const second = await sheetsTick({ store, trigger: "background" });
    expect(second.outcome).toBe("skipped");
    expect(second.reason).toBe("recent-sync");
    expect(cfgCalls.length).toBe(2); // resolved per call, never cached
    expect(cfgCalls[1].fairyland.sheet_id).toBe(FAIRYLAND_ID); // the save IS visible
    expect(cfgCalls[1].fairyland.mode).toBe("row_per_lead");
  });

  test("schedulerTick without liveAdapters resolves the sheets adapter from current settings", async () => {
    const store = new MemoryStore();
    await saveFairylandConfig(store);
    const res = await schedulerTick({ store, creds: null, trigger: "background" });
    expect(res.sheets?.outcome).toBe("synced");
    expect(cfgCalls.filter((c) => c.fairyland.sheet_id === FAIRYLAND_ID).length).toBeGreaterThanOrEqual(1);
  });

  test("serve.ts does not thread a boot-built adapter into startScheduler", () => {
    const src = readFileSync(new URL("../../../serve.ts", import.meta.url), "utf8");
    const at = src.indexOf("startScheduler(");
    expect(at).toBeGreaterThan(-1);
    const stmtEnd = src.indexOf(";", at);
    const call = src.slice(at, stmtEnd === -1 ? src.length : stmtEnd);
    expect(call).not.toContain("liveAdapters");
    expect(call).not.toContain("liveSheets");
    // and the boot-time adapter construction is gone entirely (the frozen
    // object's origin): serve.ts must not reference createSheetsAdapter.
    expect(src).not.toContain("createSheetsAdapter");
  });
});
