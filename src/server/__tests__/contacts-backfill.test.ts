/**
 * Contacts backfill engine + canonical normalizers (attribution program
 * Session 1). Fake fetcher — no live API. Covers: pagination end detection,
 * checkpoint/resume (interrupted run continues from the stored cursor, never
 * page 1), idempotency (same page twice → same row count), stuck-cursor
 * guard, 429 retry, and the owner's normalizer vectors.
 */
import { describe, expect, test } from "bun:test";
import {
  contactRowFromHl,
  CONTACTS_BACKFILL_CHECKPOINT_KEY,
  ContactsBackfillPermanentError,
  runContactsBackfill,
  sameCursor,
  type ContactsBackfillCheckpoint,
  type ContactsPage,
} from "../sync/contacts-backfill";
import { normalizeEmail, normalizeUSPhone } from "../identity/normalize";
import { MemoryStore } from "../store/memory";

const START = "https://api.test/contacts/?locationId=L&limit=100";

// ---------- normalizer vectors (owner spec) ----------
describe("normalizeUSPhone", () => {
  test("canonical vectors: (508) 889-1019 / +1 508-889-1019 / 5088891019 → 5088891019", () => {
    expect(normalizeUSPhone("(508) 889-1019")).toBe("5088891019");
    expect(normalizeUSPhone("+1 508-889-1019")).toBe("5088891019");
    expect(normalizeUSPhone("5088891019")).toBe("5088891019");
  });
  test("11 digits starting with 1 drop the leading 1", () => {
    expect(normalizeUSPhone("15088891019")).toBe("5088891019");
    expect(normalizeUSPhone("+15088891019")).toBe("5088891019");
  });
  test("short/odd inputs pass through unchanged (never nulled out)", () => {
    expect(normalizeUSPhone("508")).toBe("508");
    expect(normalizeUSPhone("12345")).toBe("12345");
    expect(normalizeUSPhone("+44 20 7946 0958")).toBe("442079460958");
    expect(normalizeUSPhone("ext. 9")).toBe("9");
    expect(normalizeUSPhone("")).toBeNull();
    expect(normalizeUSPhone(null)).toBeNull();
    expect(normalizeUSPhone(undefined)).toBeNull();
  });
});

describe("normalizeEmail", () => {
  test("trim + lowercase; null/empty stay null", () => {
    expect(normalizeEmail("  Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
    expect(normalizeEmail("odd…address")).toBe("odd…address"); // odd-but-real passes through
    expect(normalizeEmail("   ")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

// ---------- fake world ----------
interface FakePage {
  rows: Record<string, unknown>[];
  next: string | null;
  total?: number;
  /** When set, the fetch fails N times with this status before succeeding. */
  failTimes?: number;
  status?: number;
}

function makeWorld(pages: Record<string, FakePage>) {
  const calls: string[] = [];
  const failures = new Map<string, number>();
  const fetchPage = async (url: string): Promise<ContactsPage> => {
    calls.push(url);
    const page = pages[url];
    if (!page) throw new Error(`HTTP 404 (non-retryable) unexpected url ${url}`);
    if (page.failTimes && (failures.get(url) ?? 0) < page.failTimes) {
      failures.set(url, (failures.get(url) ?? 0) + 1);
      throw new Error(`HTTP ${page.status ?? 429} from HighLevel (retryable)`);
    }
    return { rows: page.rows, nextPageUrl: page.next, total: page.total ?? null };
  };
  return { calls, fetchPage };
}

function hlContact(id: string, phone?: string, email?: string): Record<string, unknown> {
  return { id, firstName: "F" + id, lastName: "L" + id, phone, email, dateAdded: "2026-09-01T00:00:00Z", dateUpdated: "2026-09-02T00:00:00Z" };
}

function makeStoreDeps(store: MemoryStore) {
  return {
    upsertContacts: (rows: Parameters<typeof store.upsertContacts>[0]) => store.upsertContacts(rows),
    loadCheckpoint: async (): Promise<ContactsBackfillCheckpoint | null> => {
      const v = await store.getSyncCheckpoint(CONTACTS_BACKFILL_CHECKPOINT_KEY);
      return v ? (JSON.parse(v) as ContactsBackfillCheckpoint) : null;
    },
    saveCheckpoint: async (cp: ContactsBackfillCheckpoint) => {
      await store.setSyncCheckpoint(CONTACTS_BACKFILL_CHECKPOINT_KEY, JSON.stringify(cp));
    },
  };
}

// ---------- engine ----------
describe("runContactsBackfill", () => {
  test("paginates to the end and detects it (no cursor → done)", async () => {
    const p2rows = [hlContact("b1", "+1 508-889-1019"), hlContact("b2")];
    const world = makeWorld({
      [START]: { rows: [hlContact("a1")], next: "https://api.test/contacts/?startAfter=1&startAfterId=a1", total: 116152 },
      "https://api.test/contacts/?startAfter=1&startAfterId=a1": { rows: p2rows, next: null, total: 116152 },
    });
    const store = new MemoryStore();
    const outcome = await runContactsBackfill({ ...makeStoreDeps(store), fetchPage: world.fetchPage, pageDelayMs: 0 }, START);
    expect(outcome.done).toBe(true);
    expect(outcome.pagesDoneThisRun).toBe(2);
    expect(outcome.upsertedTotal).toBe(3);
    expect(outcome.sourceTotal).toBe(116152);
    expect((await store.getContacts()).length).toBe(3);
    // cursor followed verbatim: second request used meta.nextPageUrl, NOT a bare startAfterId
    expect(world.calls[1]).toBe("https://api.test/contacts/?startAfter=1&startAfterId=a1");
  });

  test("checkpoint/resume: interrupted run continues from the stored cursor (never page 1)", async () => {
    const cursor1 = "https://api.test/contacts/?startAfter=1&startAfterId=a1";
    const cursor2 = "https://api.test/contacts/?startAfter=2&startAfterId=b1";
    const pages: Record<string, FakePage> = {
      [START]: { rows: [hlContact("a1")], next: cursor1, total: 400 },
      [cursor1]: { rows: [hlContact("b1")], next: cursor2, total: 400 },
      [cursor2]: { rows: [hlContact("c1")], next: null, total: 400 },
    };
    const store = new MemoryStore();

    // run 1: maxPagesThisRun=2 → interrupted AFTER page 2, checkpoint saved
    const world1 = makeWorld(pages);
    const r1 = await runContactsBackfill({ ...makeStoreDeps(store), fetchPage: world1.fetchPage, pageDelayMs: 0, maxPagesThisRun: 2 }, START);
    expect(r1.done).toBe(false);
    expect(r1.pagesDoneThisRun).toBe(2);
    expect(r1.checkpoint.nextPageUrl).toBe(cursor2); // resume cursor = page 3
    expect(world1.calls[0]).toBe(START);

    // run 2: resumes from cursor2 — START is never re-requested
    const world2 = makeWorld(pages);
    const r2 = await runContactsBackfill({ ...makeStoreDeps(store), fetchPage: world2.fetchPage, pageDelayMs: 0 }, START);
    expect(r2.done).toBe(true);
    expect(world2.calls).toEqual([cursor2]); // NOT [START, ...]
    expect(r2.upsertedTotal).toBe(3);
    expect((await store.getContacts()).length).toBe(3);
  });

  test("idempotency: re-running the same page twice → same row count", async () => {
    const cursor1 = "https://api.test/contacts/?startAfter=1&startAfterId=a1";
    const pages: Record<string, FakePage> = {
      [START]: { rows: [hlContact("a1", "(508) 889-1019"), hlContact("a2", "+1 508-889-1019")], next: cursor1, total: 2 },
      [cursor1]: { rows: [], next: null, total: 2 },
    };
    const store = new MemoryStore();
    for (let i = 0; i < 2; i++) {
      const world = makeWorld(pages);
      await runContactsBackfill({ ...makeStoreDeps(store), fetchPage: world.fetchPage, pageDelayMs: 0 }, START);
    }
    const rows = await store.getContacts();
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => r.external_id === "a1").length).toBe(1);
  });

  test("429s are retried with backoff, then the page succeeds", async () => {
    const world = makeWorld({
      [START]: { rows: [hlContact("a1")], next: null, total: 1, failTimes: 2, status: 429 },
    });
    const store = new MemoryStore();
    const sleeps: number[] = [];
    const outcome = await runContactsBackfill(
      { ...makeStoreDeps(store), fetchPage: world.fetchPage, pageDelayMs: 0, sleep: async (ms) => void sleeps.push(ms) },
      START,
    );
    expect(outcome.done).toBe(true);
    expect(world.calls.length).toBe(3); // 2 failures + 1 success
    expect(sleeps.length).toBe(2); // exponential backoff happened
    expect((await store.getContacts()).length).toBe(1);
  });

  test("a permanently failing page is recorded and the run stops at its checkpoint (resumable)", async () => {
    const cursor1 = "https://api.test/contacts/?startAfter=1&startAfterId=a1";
    const pages: Record<string, FakePage> = {
      [START]: { rows: [hlContact("a1")], next: cursor1, total: 200 },
      [cursor1]: { rows: [hlContact("b1")], next: "https://api.test/contacts/?startAfter=2&startAfterId=b1", total: 200, failTimes: 999, status: 503 },
    };
    const store = new MemoryStore();
    const world = makeWorld(pages);
    let caught: unknown = null;
    try {
      await runContactsBackfill({ ...makeStoreDeps(store), fetchPage: world.fetchPage, pageDelayMs: 0, maxRetries: 2, sleep: async () => {} }, START);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ContactsBackfillPermanentError);
    const cp = JSON.parse(await store.getSyncCheckpoint(CONTACTS_BACKFILL_CHECKPOINT_KEY) as string) as ContactsBackfillCheckpoint;
    expect(cp.pagesDone).toBe(1); // stopped at the last good page
    expect(cp.nextPageUrl).toBe(cursor1); // resumable cursor preserved
    expect(cp.failedPages.length).toBe(1);
    expect(cp.failedPages[0].url).toBe(cursor1);
    expect((await store.getContacts()).length).toBe(1); // only the page that succeeded
  });

  test("stuck-cursor guard: an echoing API (same cursor twice) fails loudly instead of looping", async () => {
    const echo = "https://api.test/contacts/?startAfterId=STUCK&startAfter=1";
    const world = makeWorld({
      [START]: { rows: [hlContact("a1")], next: echo, total: 116152 },
      // the echo page returns the SAME cursor again (verbatim) — stuck on page 2
      [echo]: { rows: [hlContact("a1")], next: echo, total: 116152 },
    });
    const store = new MemoryStore();
    let caught: unknown = null;
    try {
      await runContactsBackfill({ ...makeStoreDeps(store), fetchPage: world.fetchPage, pageDelayMs: 0 }, START);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ContactsBackfillPermanentError);
    expect((caught as Error).message).toContain("stuck cursor");
    expect((await store.getContacts()).length).toBe(1); // the one good page is stored, nothing looped
  });

  test("upsert-only: a later page never deletes rows stored by earlier pages", async () => {
    const cursor1 = "https://api.test/contacts/?startAfter=1&startAfterId=a1";
    const world = makeWorld({
      [START]: { rows: [hlContact("a1"), hlContact("a2")], next: cursor1, total: 3 },
      [cursor1]: { rows: [hlContact("z9")], next: null, total: 3 }, // a1/a2 absent from this page — must survive
    });
    const store = new MemoryStore();
    await runContactsBackfill({ ...makeStoreDeps(store), fetchPage: world.fetchPage, pageDelayMs: 0 }, START);
    const ids = (await store.getContacts()).map((c) => c.external_id).sort();
    expect(ids).toEqual(["a1", "a2", "z9"]);
  });
});

describe("contactRowFromHl", () => {
  test("raw kept verbatim alongside normalized; source timestamps captured; row without id rejected", () => {
    const row = contactRowFromHl(
      { id: "X1", firstName: "Jane", lastName: "Doe", phone: "+1 (508) 889-1019", email: " Jane.Doe@Example.COM ", dateAdded: "2026-09-01T10:00:00Z", dateUpdated: "2026-09-02T11:00:00Z" },
      "2026-09-26T00:00:00.000Z",
    );
    expect(row).not.toBeNull();
    expect(row!.phone).toBe("+1 (508) 889-1019");
    expect(row!.phone_raw).toBe("+1 (508) 889-1019");
    expect(row!.phone_normalized).toBe("5088891019");
    expect(row!.email).toBe("Jane.Doe@Example.COM");
    expect(row!.email_raw).toBe("Jane.Doe@Example.COM");
    expect(row!.email_normalized).toBe("jane.doe@example.com");
    expect(row!.source_created_at).toBe("2026-09-01T10:00:00Z");
    expect(row!.source_updated_at).toBe("2026-09-02T11:00:00Z");
    expect(row!.last_synced_at).toBe("2026-09-26T00:00:00.000Z");
    expect(row!.provider).toBe("highlevel");
    expect(contactRowFromHl({ firstName: "no id" }, "now")).toBeNull();
  });

  test("weird phone shapes survive (never nulled out)", () => {
    expect(contactRowFromHl({ id: "X2", phone: "12345" }, "now")!.phone_normalized).toBe("12345");
    expect(contactRowFromHl({ id: "X3", phone: "" }, "now")!.phone_normalized).toBeNull();
  });
});

describe("both stores agree: normalized identity keys derived at the boundary", () => {
  test("memory store normalizes raw values even when the caller doesn't", async () => {
    const store = new MemoryStore();
    await store.upsertContacts([
      { id: "", provider: "highlevel", external_id: "k1", name: "K One", phone: "+1 508-889-1019", email: " A@B.co ", assigned_rep_id: null, created_at: "2026-01-01T00:00:00Z" },
    ]);
    const [row] = await store.getContacts();
    expect(row.phone_raw).toBe("+1 508-889-1019");
    expect(row.phone_normalized).toBe("5088891019");
    expect(row.email_raw).toBe(" A@B.co ");
    expect(row.email_normalized).toBe("a@b.co");
  });
});

describe("sameCursor", () => {
  test("param order does not matter; different cursors differ", () => {
    expect(sameCursor("https://x/c?a=1&b=2", "https://x/c?b=2&a=1")).toBe(true);
    expect(sameCursor("https://x/c?a=1&b=2", "https://x/c?a=2&b=2")).toBe(false);
    expect(sameCursor(null, null)).toBe(true);
    expect(sameCursor(null, "https://x/c?a=1")).toBe(false);
  });
});
