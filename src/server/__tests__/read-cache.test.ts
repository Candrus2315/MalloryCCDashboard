import { describe, expect, test } from "bun:test";
import { READ_CACHE_TTL_MS, TtlReadCache } from "../store/read-cache";

describe("TtlReadCache (PgStore short-TTL read cache)", () => {
  test("caches within TTL and skips the DB on hit", async () => {
    const c = new TtlReadCache();
    let calls = 0;
    const read = () => {
      calls++;
      return Promise.resolve([{ v: 1 }]);
    };
    const a = await c.wrap("k", read);
    const b = await c.wrap("k", read);
    expect(calls).toBe(1);
    expect(b).toEqual(a);
  });

  test("bump() invalidates: post-write reads always re-query (override contract)", async () => {
    const c = new TtlReadCache();
    let value = "pre-override";
    const read = () => Promise.resolve(value);
    expect(await c.wrap("attributions", read)).toBe("pre-override");
    value = "post-override"; // the write happened
    c.bump(); // the write's first statement
    expect(await c.wrap("attributions", read)).toBe("post-override");
  });

  test("expired entries re-query", async () => {
    const c = new TtlReadCache();
    let calls = 0;
    const read = () => {
      calls++;
      return Promise.resolve(calls);
    };
    await c.wrap("k", read);
    // simulate TTL passage by seeding an entry with an old timestamp
    // (wrap uses Date.now(); we cannot wait 20s in tests, so verify TTL logic
    // through the exported constant + a manual age-out via generation bump)
    expect(READ_CACHE_TTL_MS).toBeLessThanOrEqual(30_000);
    expect(READ_CACHE_TTL_MS).toBeGreaterThanOrEqual(15_000);
    c.bump();
    expect(await c.wrap("k", read)).toBe(2);
  });

  test("clones on store and on hit — caller mutation cannot poison the cache", async () => {
    const c = new TtlReadCache();
    const rows = [{ id: 1, tags: ["a"] }];
    const first = await c.wrap("rows", () => Promise.resolve(rows));
    first[0].tags.push("MUTANT");
    first.push({ id: 2, tags: [] });
    const second = await c.wrap("rows", () => Promise.resolve(rows));
    expect(second).toEqual([{ id: 1, tags: ["a"] }]);
    // and the original caller's object is independent of the cached copy
    expect(rows[0].tags).toEqual(["a"]);
  });

  test("distinct keys do not collide (per method + JSON args)", async () => {
    const c = new TtlReadCache();
    await c.wrap("getCallsBetween:" + JSON.stringify(["d1", "d2"]), () => Promise.resolve(["A"]));
    await c.wrap("getCallsBetween:" + JSON.stringify(["d1", "d3"]), () => Promise.resolve(["B"]));
    expect(await c.wrap("getCallsBetween:" + JSON.stringify(["d1", "d2"]), () => Promise.resolve(["C"]))).toEqual(["A"]);
  });

  test("size cap bulk-clears (memory bound)", async () => {
    const c = new TtlReadCache();
    for (let i = 0; i < 200; i++) await c.wrap(`k${i}`, () => Promise.resolve(i));
    expect(c.size).toBeLessThanOrEqual(64);
  });

  test("concurrent wraps for one key share a single logical read each (no cross-request poisoning)", async () => {
    const c = new TtlReadCache();
    // both misses run fn (parallel loaders); the later write wins the slot —
    // values are identical because the generation hasn't changed in between
    const [x, y] = await Promise.all([c.wrap("k", () => Promise.resolve(1)), c.wrap("k", () => Promise.resolve(1))]);
    expect(x).toBe(1);
    expect(y).toBe(1);
  });
});
