import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { devAuditApiHandler, devRetentionExceptionsApiHandler } from "./src/server/api-gate";

/**
 * DEV API ENDPOINTS (working site) — SECURITY (2026-10-28, owner directive):
 * both middlewares run the SAME passphrase gate as production serve.ts
 * (src/server/api-gate.requireGate → auth.resolveGate — one shared decision,
 * so dev and prod can never drift). The handler bodies themselves live in
 * src/server/api-gate.ts so they stay unit-testable.
 *
 * With DASHBOARD_PASSPHRASE set: unauthenticated GETs get the same 401 as prod
 * (lock-screen HTML for browser navigations, JSON otherwise) and unauthenticated
 * POSTs are denied BEFORE the store is resolved — nothing can mutate. With the
 * passphrase unset the gate is open (same as prod; Settings warns) — dev
 * ergonomics unchanged.
 */
function devApiEndpointsPlugin(): Plugin {
  return {
    name: "mallory-dev-api-endpoints",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/audit", devAuditApiHandler());
      // GET list + POST resolve / resolve_new / dismiss (audited, sticky,
      // never re-matched) — read-only + management actions, gated like prod.
      server.middlewares.use("/api/retention-exceptions", devRetentionExceptionsApiHandler());
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
    devApiEndpointsPlugin(),
    tailwindcss(),
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tanstackStart(),
    viteReact(),
  ],
});
