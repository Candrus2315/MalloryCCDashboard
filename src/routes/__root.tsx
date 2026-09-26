import { HeadContent, Outlet, Scripts, createRootRoute, Link, useLocation, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import appCss from "~/styles/app.css?url";
import { getFreshnessData, refreshNow, type FreshnessData } from "~/server/queries";

const NAV = [
  { to: "/", label: "Today" },
  { to: "/reps", label: "Reps" },
  { to: "/team", label: "Team" },
  { to: "/availability", label: "Availability" },
  { to: "/daily-report", label: "Daily Report" },
  { to: "/settings", label: "Settings" },
  { to: "/audit", label: "Audit" },
];

export const Route = createRootRoute({
  loader: () => getFreshnessData(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Mallory CC Performance" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  notFoundComponent: () => <div className="p-10 text-stone-500">Page not found</div>,
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      {/*
        Auth is enforced SERVER-SIDE (src/start.ts + src/server/auth.ts): with
        DASHBOARD_PASSPHRASE set, the middleware serves the lock screen (or 401
        for RPC) instead of this document, so no client-side gate is needed.
      */}
      <AppShell>
        <Outlet />
      </AppShell>
    </RootDocument>
  );
}

function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const path = location.pathname;
  const freshness = Route.useLoaderData();
  return (
    <div className="min-h-dvh bg-stone-50 text-stone-900">
      <header className="border-b border-stone-200/70 bg-stone-50/95 sticky top-0 z-10">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-6 py-3">
          <div className="flex items-baseline gap-3">
            <span className="text-[15px] font-semibold tracking-tight">Mallory Portraits</span>
            <span className="text-[13px] text-stone-400">CC Performance</span>
          </div>
          <div className="flex items-center gap-4">
            <FreshnessIndicator initial={freshness} />
            <nav className="flex items-center gap-1">
              {NAV.map((item) => {
                const active = item.to === "/" ? path === "/" : path.startsWith(item.to);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={
                      "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors " +
                      (active ? "bg-stone-900 text-white" : "text-stone-500 hover:bg-stone-200/60 hover:text-stone-900")
                    }
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
    </div>
  );
}

/**
 * "Last synced Xm ago" + manual REFRESH — visible on every page (shell).
 * Subtle by design: stone-400 caption next to the nav, quiet ghost button.
 * The label re-renders client-side every 30s; `suppressHydrationWarning`
 * absorbs the SSR-vs-client minute-boundary difference.
 */
function FreshnessIndicator({ initial }: { initial: FreshnessData }) {
  const router = useRouter();
  const [data, setData] = useState<FreshnessData>(initial);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const ts = data.highlevel.lastSuccessAt ?? data.highlevel.lastSyncAt;
  const label = busy || data.running
    ? "Syncing…"
    : ts
      ? formatAge(ts)
      : data.highlevel.isDemo
        ? "demo data"
        : "never synced";
  const dot = data.highlevel.status === "connected" && !data.highlevel.isDemo
    ? "bg-emerald-500"
    : data.highlevel.status === "error"
      ? "bg-red-400"
      : "bg-stone-300";

  const onRefresh = async () => {
    setBusy(true);
    try {
      const res = await refreshNow();
      setData({
        highlevel: {
          status: res.tick.outcome === "error" ? "error" : "connected",
          isDemo: false,
          lastSyncAt: res.lastSyncAt,
          lastSuccessAt: res.lastSuccessAt,
          lastError: res.lastError,
        },
        running: res.running,
        runningStartedAt: null,
        intervalSeconds: data.intervalSeconds,
        serverNow: res.serverNow,
      });
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2" title={data.highlevel.lastError ?? undefined}>
      <span className={"inline-block h-1.5 w-1.5 rounded-full " + dot} aria-hidden />
      <span className="text-[12px] text-stone-400" suppressHydrationWarning>
        {label}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={busy}
        className="rounded-md border border-stone-200 px-2 py-0.5 text-[12px] text-stone-500 transition-colors hover:border-stone-300 hover:text-stone-900 disabled:opacity-50"
      >
        {busy ? "…" : "Refresh"}
      </button>
    </div>
  );
}

function formatAge(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 1) return "synced just now";
  if (mins < 60) return `Last synced ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Last synced ${hours}h ${mins % 60}m ago`;
  return `Last synced ${Math.floor(hours / 24)}d ago`;
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
