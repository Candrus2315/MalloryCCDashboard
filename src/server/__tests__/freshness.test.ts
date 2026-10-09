/**
 * Owner directive 2026-10-09: the shell "Last synced" chip reads the NEWEST
 * completed sync — SUCCESS runs only, across providers with a live (non-demo)
 * connection row, stamped by finished_at — not the QA 2026-10-08
 * oldest-provider freshness floor the owner flagged. A provider currently
 * running (or an earlier error run) never resets the stamp; when the
 * recent-runs window holds no success at all, the newest connections
 * last_successful_sync_at is the fallback.
 */
import { describe, expect, test } from "bun:test";
import { newestSyncSuccessAt } from "../queries";

const conn = (provider: string, last_successful_sync_at: string | null, is_demo = false) => ({
  provider,
  is_demo,
  last_successful_sync_at,
});

const run = (
  provider: string,
  status: string,
  started_at: string,
  finished_at: string | null = null,
  id = `${provider}:${started_at}`,
) => ({ id, provider, status, started_at, finished_at, records_upserted: 0, error: null });

describe("newestSyncSuccessAt (shell chip — newest completed sync)", () => {
  test("picks the NEWEST success run across live providers (finished_at stamps)", () => {
    const stamp = newestSyncSuccessAt(
      [
        run("highlevel", "success", "2026-10-09 20:30:41.209+00", "2026-10-09 20:32:54.206+00"),
        run("acuity", "success", "2026-10-09 20:32:49.004+00", "2026-10-09 20:33:30.883+00"),
      ],
      [conn("highlevel", "2026-10-09 20:32:54.206+00"), conn("acuity", "2026-10-09 20:33:30.883+00")],
    );
    // Acuity's run finished last — not HighLevel's (the old floor would have
    // shown the OLDEST provider instead).
    expect(stamp).toBe("2026-10-09 20:33:30.883+00");
  });

  test("running and error runs never reset the stamp — success runs only", () => {
    const stamp = newestSyncSuccessAt(
      [
        // google_sheets currently running: must NOT reset the chip.
        run("google_sheets", "running", "2026-10-09 20:33:31.630+00"),
        // highlevel's earlier error is history; the later success stands.
        run("highlevel", "error", "2026-10-09 20:27:30.690+00", "2026-10-09 20:29:12.462+00", "e1"),
        run("highlevel", "success", "2026-10-09 20:30:41.209+00", "2026-10-09 20:32:54.206+00"),
      ],
      [conn("highlevel", "2026-10-09 20:32:54.206+00"), conn("google_sheets", "2026-10-09 20:00:00+00")],
    );
    expect(stamp).toBe("2026-10-09 20:32:54.206+00");
  });

  test("a success run without finished_at stamps by its started_at", () => {
    const stamp = newestSyncSuccessAt(
      [run("highlevel", "success", "2026-10-09 20:30:41.209+00")],
      [conn("highlevel", null)],
    );
    expect(stamp).toBe("2026-10-09 20:30:41.209+00");
  });

  test("demo providers and providers without a connection row are excluded", () => {
    const stamp = newestSyncSuccessAt(
      [
        // attribution runs constantly but has no connection row — it is not a
        // display provider; a demo provider is never a live stamp either.
        run("attribution", "success", "2026-10-09 20:34:02.924+00", "2026-10-09 20:34:28.046+00"),
        run("acuity", "success", "2026-10-09 20:32:49.004+00", "2026-10-09 20:33:30.883+00"),
      ],
      [conn("acuity", "2026-10-09 20:33:30.883+00"), conn("highlevel", "2026-10-09 20:32:54.206+00", true)],
    );
    expect(stamp).toBe("2026-10-09 20:33:30.883+00");
  });

  test("no success in the run window falls back to the newest connections last-success", () => {
    const stamp = newestSyncSuccessAt(
      [
        run("highlevel", "error", "2026-10-09 20:27:30.690+00", "2026-10-09 20:29:12.462+00", "e1"),
        run("google_sheets", "running", "2026-10-09 20:33:31.630+00"),
      ],
      [
        conn("highlevel", "2026-10-09 18:00:00+00"),
        conn("google_sheets", "2026-10-09 20:00:00+00"),
      ],
    );
    expect(stamp).toBe("2026-10-09 20:00:00+00"); // sheets — the newest preserved success
  });

  test("null when no live provider has ever succeeded", () => {
    expect(newestSyncSuccessAt([], [])).toBeNull();
    expect(
      newestSyncSuccessAt(
        [run("highlevel", "error", "2026-10-09 20:27:30.690+00", "2026-10-09 20:29:12.462+00", "e1")],
        [conn("highlevel", null), conn("acuity", "2026-10-09 20:33:30.883+00", true)],
      ),
    ).toBeNull();
  });
});
