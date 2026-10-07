/**
 * QA 2026-10-08: shell freshness floor — the "Last synced" label reads the
 * OLDEST last-success across all real (non-demo) providers, not HighLevel
 * alone (which understated staleness when Sheets synced earlier).
 */
import { describe, expect, test } from "bun:test";
import { oldestSyncSuccessAt } from "../queries";

describe("oldestSyncSuccessAt (shell freshness floor)", () => {
  test("picks the OLDEST last-success across non-demo providers", () => {
    const oldest = oldestSyncSuccessAt([
      { provider: "highlevel", is_demo: false, last_successful_sync_at: "2026-10-07 19:29:39.435+00" },
      { provider: "google_sheets", is_demo: false, last_successful_sync_at: "2026-10-07 18:47:26.097+00" },
      { provider: "acuity", is_demo: false, last_successful_sync_at: "2026-10-07 19:58:50.715+00" },
    ]);
    expect(oldest).toBe("2026-10-07 18:47:26.097+00"); // Sheets — not HighLevel's 19:29
  });

  test("demo rows and never-synced providers are excluded", () => {
    const oldest = oldestSyncSuccessAt([
      { provider: "highlevel", is_demo: true, last_successful_sync_at: "2026-10-07 19:29:39.435+00" },
      { provider: "google_sheets", is_demo: false, last_successful_sync_at: null },
      { provider: "acuity", is_demo: false, last_successful_sync_at: "2026-10-07 19:58:50.715+00" },
    ]);
    expect(oldest).toBe("2026-10-07 19:58:50.715+00");
  });

  test("null when no real provider has ever succeeded", () => {
    expect(oldestSyncSuccessAt([])).toBeNull();
    expect(
      oldestSyncSuccessAt([
        { provider: "highlevel", is_demo: false, last_successful_sync_at: null },
        { provider: "acuity", is_demo: true, last_successful_sync_at: "2026-10-07 19:58:50.715+00" },
      ]),
    ).toBeNull();
  });
});
