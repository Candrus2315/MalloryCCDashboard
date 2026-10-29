/**
 * SECURITY (2026-10-28, owner directive) — the dev API gate battery.
 *
 * The vite dev middlewares previously served /api/audit and
 * /api/retention-exceptions with NO authentication — production serve.ts
 * protects the same routes with the passphrase gate (resolveGate). They now
 * share ONE decision (src/server/api-gate.requireGate → auth.resolveGate) and
 * the handler bodies moved here so they are testable without vite.
 *
 * Proven below:
 *   - unauthenticated dev GET → 401 (JSON for API callers; lock-screen HTML
 *     for browser navigations) and the handler/DB is NEVER touched;
 *   - authenticated dev GET → allowed, and the mount-prefix reconstruction
 *     feeds the handler the right query params (dev ergonomics kept);
 *   - unauthenticated POST /api/retention-exceptions CANNOT mutate state —
 *     the gate denies before the store is even resolved (proven with a real
 *     MemoryStore seeded with an OPEN exception that must remain open);
 *   - authenticated POST resolves the exception (the allowed path works);
 *   - with DASHBOARD_PASSPHRASE unset the gate is open — dev/demo mode
 *     unchanged, same policy as production;
 *   - requireGate itself: null on allow, a 401 Response on deny.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import {
  devAuditApiHandler,
  devRetentionExceptionsApiHandler,
  gateConnectRequest,
  requireGate,
} from "../api-gate";
import { createSessionToken } from "../auth";

const PASSPHRASE = "dev-gate-battery-passphrase-4d21";
const ORIGIN = "https://dashboard.example.com";

// HERMETIC ENV (PR #117 completion): EVERY call site awaits this helper, so
// the set AND the restore happen inside the test's own lifecycle — no promise
// outlives the test, so passphrase state can never leak into another test or
// file (bun test shares one process across files). `passphrase = null`
// exercises the unset (open-gate) path under the same save/restore guarantee;
// the bare `delete process.env.DASHBOARD_PASSPHRASE` statements this replaces
// never restored, which is what let gate state drift across files.
async function withPassphrase<T>(
  fn: () => T | Promise<T>,
  passphrase: string | null = PASSPHRASE,
): Promise<T> {
  const prev = process.env.DASHBOARD_PASSPHRASE;
  if (passphrase === null) delete process.env.DASHBOARD_PASSPHRASE;
  else process.env.DASHBOARD_PASSPHRASE = passphrase;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DASHBOARD_PASSPHRASE;
    else process.env.DASHBOARD_PASSPHRASE = prev;
  }
}

function tokenCookie(): string {
  return `mallory_session=${createSessionToken(PASSPHRASE)}`;
}

interface FakeReqInit {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}

function fakeReq(opts: FakeReqInit) {
  const chunks = opts.body ? [Buffer.from(opts.body)] : [];
  let sent = 0;
  return {
    method: opts.method ?? "GET",
    url: opts.url ?? "/",
    headers: opts.headers ?? {},
    [Symbol.asyncIterator]() {
      return {
        next: async () =>
          sent < chunks.length ? { value: chunks[sent++], done: false } : { value: undefined, done: true },
      };
    },
  };
}

function fakeRes() {
  // `done` resolves on end() so tests await the DETACHED handler task's actual
  // completion instead of a sleep — deterministic, no cross-test bleed.
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    done,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      resolveDone();
      return this;
    },
  };
}

async function seedOpenException(store: MemoryStore): Promise<{ exceptionId: string; clientId: string }> {
  const client = await store.insertInternalClient({
    seedKey: null,
    displayName: "Gate Battery Client",
    normalizedPhone: null,
    normalizedEmail: null,
    ghlContactExternalId: null,
    matchState: "manual_resolved",
  });
  const { exception } = await store.insertDataMatchExceptionIfAbsent({
    kind: "name_only",
    dedupeKey: "contact-identity:hl:GATE1",
    payload: { subject: { name: "Gate Battery Subject" }, candidates: [client.id] },
    context: null,
  });
  return { exceptionId: exception.id, clientId: client.id };
}

describe("dev /api/audit — gated like production", () => {
  test("unauthenticated GET → 401 JSON; the audit handler never runs", async () => {
    await withPassphrase(async () => {
      let handlerRuns = 0;
      const handler = devAuditApiHandler(async () => {
        handlerRuns++;
        return { status: 200, body: { ok: true } };
      });
      const res = fakeRes();
      handler(fakeReq({ url: "/?rep=all&date=2026-10-20" }), res);
      await res.done;
      expect(handlerRuns).toBe(0);
      expect(res.statusCode).toBe(401);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.body).toContain("unauthorized");
    });
  });

  test("authenticated GET → allowed; handler receives the full query (mount path reconstructed)", async () => {
    await withPassphrase(async () => {
      let handlerRuns = 0;
      let seen: { rep?: string | null; date?: string | null } | null = null;
      const handler = devAuditApiHandler(async (params) => {
        handlerRuns++;
        seen = params;
        return { status: 200, body: { ok: true, rep: params.rep } };
      });
      const res = fakeRes();
      handler(fakeReq({ url: "/?rep=all&date=2026-10-20", headers: { cookie: tokenCookie() } }), res);
      await res.done;
      expect(handlerRuns).toBe(1);
      expect(seen).toEqual({ rep: "all", date: "2026-10-20" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.body).toContain('"ok":true');
    });
  });

  test("unauthenticated browser navigation (Accept: text/html) gets the lock screen, like prod", async () => {
    await withPassphrase(async () => {
      const handler = devAuditApiHandler(async () => ({ status: 200, body: { ok: true } }));
      const res = fakeRes();
      handler(fakeReq({ headers: { accept: "text/html" } }), res);
      await res.done;
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain("passphrase");
      expect(res.body).toContain("<form"); // the standalone lock screen
    });
  });

  test("DASHBOARD_PASSPHRASE unset → gate open, dev ergonomics unchanged", async () => {
    await withPassphrase(async () => {
      let handlerRuns = 0;
      const handler = devAuditApiHandler(async () => {
        handlerRuns++;
        return { status: 200, body: { ok: true } };
      });
      const res = fakeRes();
      handler(fakeReq({ url: "/?rep=all" }), res); // no cookie at all
      await res.done;
      expect(handlerRuns).toBe(1);
      expect(res.statusCode).toBe(200);
    }, null); // null = UNSET passphrase (open-gate path), restored after
  });
});

describe("dev /api/retention-exceptions — gated like production", () => {
  test("unauthenticated POST resolve CANNOT mutate state (gate denies before the store is touched)", async () => {
    await withPassphrase(async () => {
      const store = new MemoryStore();
      const { exceptionId, clientId } = await seedOpenException(store);
      let storeResolved = 0;
      const handler = devRetentionExceptionsApiHandler(async () => {
        // wrap to detect ANY store interaction the action layer performs
        return store;
      });
      // watch the store directly after the request instead
      const origResolve = store.resolveDataMatchException.bind(store);
      store.resolveDataMatchException = async (...args: Parameters<typeof origResolve>) => {
        storeResolved++;
        return origResolve(...args);
      };
      const res = fakeRes();
      handler(
        fakeReq({
          method: "POST",
          url: "/",
          body: JSON.stringify({ action: "resolve", id: exceptionId, internalClientId: clientId, resolvedBy: "attacker" }),
        }),
        res,
      );
      await res.done;
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain("unauthorized");
      expect(storeResolved).toBe(0);
      const rows = await store.getDataMatchExceptions();
      const exc = rows.find((e) => e.id === exceptionId);
      expect(exc?.status).toBe("open"); // STILL open — nothing mutated
      expect(exc?.resolved_internal_client_id ?? null).toBeNull();
    });
  });

  test("authenticated POST resolve mutates state (allowed path works end-to-end)", async () => {
    await withPassphrase(async () => {
      const store = new MemoryStore();
      const { exceptionId, clientId } = await seedOpenException(store);
      const handler = devRetentionExceptionsApiHandler(async () => store);
      const res = fakeRes();
      handler(
        fakeReq({
          method: "POST",
          url: "/",
          headers: { cookie: tokenCookie() },
          body: JSON.stringify({ action: "resolve", id: exceptionId, internalClientId: clientId, resolvedBy: "management-test" }),
        }),
        res,
      );
      await res.done;
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('"ok":true');
      const rows = await store.getDataMatchExceptions();
      const exc = rows.find((e) => e.id === exceptionId);
      expect(exc?.status).toBe("resolved");
      expect(exc?.resolved_internal_client_id).toBe(clientId);
    });
  });

  test("unauthenticated GET list → 401; store never consulted", async () => {
    await withPassphrase(async () => {
      let storeTouched = 0;
      const handler = devRetentionExceptionsApiHandler(async () => {
        storeTouched++;
        return new MemoryStore();
      });
      const res = fakeRes();
      handler(fakeReq({ url: "/?status=open" }), res);
      await res.done;
      expect(res.statusCode).toBe(401);
      expect(storeTouched).toBe(0);
    });
  });

  test("DASHBOARD_PASSPHRASE unset → gate open, the queue API answers", async () => {
    await withPassphrase(async () => {
      const store = new MemoryStore();
      const handler = devRetentionExceptionsApiHandler(async () => store);
      const res = fakeRes();
      handler(fakeReq({ url: "/?status=open" }), res);
      await res.done;
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('"counts"');
    }, null); // null = UNSET passphrase (open-gate path), restored after
  });
});

describe("requireGate — the one shared decision", () => {
  test("allowed request → null (caller proceeds); denied POST → 401 JSON Response", async () => {
    await withPassphrase(async () => {
      const allowed = await requireGate(new Request(`${ORIGIN}/api/audit?rep=all`, { headers: { cookie: tokenCookie() } }));
      expect(allowed).toBeNull();
      const denied = await requireGate(new Request(`${ORIGIN}/api/retention-exceptions`, { method: "POST" }));
      expect(denied).not.toBeNull();
      expect(denied?.status).toBe(401);
      expect(await denied?.text()).toContain("unauthorized");
    });
  });

  test("unset passphrase → always null (open gate, same as production)", async () => {
    await withPassphrase(async () => {
      expect(await requireGate(new Request(`${ORIGIN}/api/audit`))).toBeNull();
      expect(await requireGate(new Request(`${ORIGIN}/api/retention-exceptions`, { method: "POST" }))).toBeNull();
    }, null); // null = UNSET passphrase (open-gate path), restored after
  });

  test("gateConnectRequest reconstructs the FULL mounted path for the gate decision", async () => {
    await withPassphrase(async () => {
      // cookie is invalid → deny. The point is the gate SAW /api/audit (mounted
      // path), not the prefix-stripped "/?rep=…" connect hands the middleware.
      const res = fakeRes();
      const denied = await gateConnectRequest("/api/audit", fakeReq({ url: "/?rep=all", headers: { cookie: "mallory_session=forged.deadbeef" } }), res);
      expect(denied).not.toBeNull();
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain("unauthorized");
    });
  });
});
