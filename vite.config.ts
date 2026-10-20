import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

/**
 * DEV-ONLY JSON endpoint: GET /api/audit?rep=<repId|all|unassigned>&date=YYYY-MM-DD
 * Same shared handler the production serve.ts exposes (src/server/audit-api.ts)
 * so the read-only audit API works identically on the working (dev) site and the
 * published server. Read-only DB reads; no live harvesting on page load.
 */
function auditApiDevPlugin(): Plugin {
  return {
    name: "mallory-audit-api-dev",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/audit", (req, res) => {
        void (async () => {
          try {
            const { handleAuditQuery } = await import("./src/server/audit-api");
            // connect strips the mount prefix, so req.url is "/?rep=…&date=…"
            const url = new URL(req.url ?? "/", "http://localhost");
            const out = await handleAuditQuery({
              rep: url.searchParams.get("rep"),
              date: url.searchParams.get("date"),
            });
            res.statusCode = out.status;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify(out.body));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
        })();
      });
      // RETENTION DATA MATCH EXCEPTIONS API (stage 3a) — dev mirror of the
      // serve.ts endpoint (same handler core): GET list + POST resolve /
      // resolve_new / dismiss (audited, sticky, never re-matched).
      server.middlewares.use("/api/retention-exceptions", (req, res) => {
        void (async () => {
          try {
            const { getStore } = await import("./src/server/store");
            const { handleExceptionsQuery, handleExceptionAction } = await import("./src/server/retention/exceptions-api");
            const store = await getStore();
            if (req.method === "POST") {
              const chunks: Buffer[] = [];
              for await (const chunk of req) chunks.push(chunk as Buffer);
              let parsed: Record<string, unknown> = {};
              try {
                parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
              } catch {
                res.statusCode = 400;
                res.setHeader("content-type", "application/json; charset=utf-8");
                res.end(JSON.stringify({ error: "invalid JSON body" }));
                return;
              }
              const str = (k: string) => (typeof parsed[k] === "string" ? (parsed[k] as string) : undefined);
              const out = await handleExceptionAction(store, {
                action: str("action") ?? "",
                id: str("id"),
                internalClientId: str("internalClientId"),
                displayName: str("displayName"),
                phone: str("phone"),
                email: str("email"),
                resolvedBy: str("resolvedBy"),
              });
              res.statusCode = out.status;
              res.setHeader("content-type", "application/json; charset=utf-8");
              res.end(JSON.stringify(out.body));
              return;
            }
            const url = new URL(req.url ?? "/", "http://localhost");
            const out = await handleExceptionsQuery(store, { status: url.searchParams.get("status") });
            res.statusCode = out.status;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify(out.body));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
        })();
      });
    },
  };
}

export default defineConfig({
  server: {
    port: 3000,
    host: true,
    // The site is reverse-proxied behind <label>.<PUBLIC_SITE_DOMAIN>; the proxy
    // masks the Host to localhost:3000, but accept any host so a dev server never
    // rejects a proxied request with "Blocked request".
    allowedHosts: true,
    // The dev server is reachable through the TLS proxy, so the HMR websocket
    // must dial back on 443, not the dev port. If the socket can't connect,
    // pages still serve — hot reload degrades, never breaks.
    hmr: { clientPort: 443 },
    // The dev server can serve source files; never let it serve local secrets,
    // and never let it serve anything outside the site dir. Gotchas this list
    // encodes: a custom `deny` REPLACES Vite's defaults (so .git must be
    // restated), patterns containing "/" match the ABSOLUTE path (so dir
    // patterns need a leading **/), and `allow` left to its default widens to
    // the nearest workspace root — a stray .git or workspaces package.json in
    // /home/team/shared would expose the whole shared dir.
    fs: {
      strict: true,
      allow: [import.meta.dirname],
      deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.run/**", "**/.git/**"],
    },
  },
  plugins: [
    auditApiDevPlugin(),
    tailwindcss(),
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tanstackStart(),
    viteReact(),
  ],
});
