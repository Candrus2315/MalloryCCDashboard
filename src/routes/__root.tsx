import { HeadContent, Outlet, Scripts, createRootRoute, Link, useLocation, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import appCss from "~/styles/app.css?url";
import { useAppearance } from "~/components/appearance";
import { getFreshnessData, refreshNow, type FreshnessData } from "~/server/queries";

const NAV = [
  { to: "/", label: "Today" },
  { to: "/reps", label: "Reps" },
  { to: "/team", label: "Team" },
  { to: "/availability", label: "Availability" },
  { to: "/daily-report", label: "Daily Report" },
  { to: "/weekly", label: "Weekly" },
  // PERFORMANCE MANAGEMENT (owner directive 9/30): manager-only PIP module.
  // The section's six pages (Active/Drafts/Completed/Cancelled/Templates/
  // History) live in the section's own tab bar on /performance*.
  { to: "/performance", label: "Performance" },
  { to: "/settings", label: "Settings" },
  { to: "/audit", label: "Audit" },
];

export const Route = createRootRoute({
  loader: () => getFreshnessData(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      // viewport-fit=cover lets the sticky header paint into the notch area on
      // notched phones (the header pads itself with env(safe-area-inset-top)).
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Mallory CC Performance" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/favicon.ico", sizes: "32x32" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
  }),
  notFoundComponent: () => <div className="p-10 text-(--text-caption)">Page not found</div>,
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
  // P5 QA fix: mount the appearance hook app-wide (not only in Settings) so
  // pref="system" live-tracks prefers-color-scheme changes on EVERY page —
  // otherwise an OS dark↔light flip only applies after a full reload.
  // Idempotent with the Settings block's own subscription (same class toggle).
  useAppearance();

  const [navOpen, setNavOpen] = useState(false);
  // Route change always closes the drawer (including back/forward navigation).
  useEffect(() => {
    setNavOpen(false);
  }, [path]);

  return (
    <div className="min-h-dvh bg-(--page-bg) text-(--text-primary)">
      {/* Mobile header height is 68px (safe-area pad + py-3 + 44px controls);
          in-page sticky elements compensate with top-[68px] md:top-14. */}
      <header className="border-b border-(--card-border) bg-(--sticky-header-bg) sticky top-0 z-10 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:gap-6 sm:px-6">
          <div className="flex min-w-0 items-baseline gap-3">
            <span className="whitespace-nowrap text-[15px] font-semibold tracking-tight">Mallory Portraits</span>
            <span className="hidden whitespace-nowrap text-[13px] text-(--text-muted) sm:inline">CC Performance</span>
          </div>
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            {/* Full freshness label on md+; compact "12m" form on phones */}
            <div className="hidden md:block">
              <FreshnessIndicator initial={freshness} />
            </div>
            <div className="min-w-0 md:hidden">
              <FreshnessIndicator initial={freshness} compact />
            </div>
            <nav className="hidden items-center gap-1 md:flex">
              {NAV.map((item) => {
                const active = item.to === "/" ? path === "/" : path.startsWith(item.to);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={
                      "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors " +
                      (active
                        ? "bg-(--accent-solid) text-(--accent-solid-fg)"
                        : "text-(--text-caption) hover:bg-(--surface-subtle) hover:text-(--text-primary)")
                    }
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-label="Open navigation"
              aria-expanded={navOpen}
              className="-mr-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-(--text-body) transition-colors hover:bg-(--surface-subtle) hover:text-(--text-primary) md:hidden"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="M3 5.5h14M3 10h14M3 14.5h14" />
              </svg>
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-4 sm:px-6 sm:py-6">{children}</main>
      <MobileNav open={navOpen} onClose={() => setNavOpen(false)} path={path} />
    </div>
  );
}

/**
 * Mobile navigation drawer (right slide-in). 7 routes don't fit a bottom tab
 * bar without truncating labels, so the drawer keeps every label verbatim with
 * 48px tap rows and the same accent-pill active state as the desktop nav.
 * Backdrop click, Escape and any route change close it; body scroll locks
 * while open (same mechanics as DetailDrawer).
 */
function MobileNav({ open, onClose, path }: { open: boolean; onClose: () => void; path: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <div className="absolute inset-0 bg-(--scrim)" aria-hidden="true" onClick={onClose} />
      <nav
        aria-label="Main navigation"
        className="absolute right-0 top-0 flex h-full w-72 max-w-[85vw] flex-col border-l border-(--card-border) shadow-xl"
        style={{ backgroundColor: "var(--card-bg)", paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="flex items-center justify-between border-b border-(--table-border-weak) px-4 py-2 pr-2">
          <span className="text-[15px] font-semibold tracking-tight text-(--text-primary)">Menu</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="inline-flex h-11 w-11 items-center justify-center rounded-md text-(--text-muted) transition-colors hover:bg-(--surface-subtle) hover:text-(--text-primary)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {NAV.map((item) => {
            const active = item.to === "/" ? path === "/" : path.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={onClose}
                aria-current={active ? "page" : undefined}
                className={
                  "mx-2 my-0.5 flex min-h-[48px] items-center justify-between rounded-lg px-3 text-[15px] font-medium transition-colors " +
                  (active
                    ? "bg-(--accent-solid) text-(--accent-solid-fg)"
                    : "text-(--text-body) hover:bg-(--surface-subtle) hover:text-(--text-primary)")
                }
              >
                {item.label}
                {active && (
                  <span aria-hidden="true" className="text-[13px] opacity-70">
                    ●
                  </span>
                )}
              </Link>
            );
          })}
        </div>
        <div
          className="border-t border-(--table-border-weak) px-4 py-3 text-xs text-(--text-muted)"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
        >
          Mallory CC Performance Dashboard
        </div>
      </nav>
    </div>
  );
}

/**
 * "Last synced Xm ago" + manual REFRESH — visible on every page (shell).
 * Subtle by design: stone-400 caption next to the nav, quiet ghost button.
 * The label re-renders client-side every 30s; `suppressHydrationWarning`
 * absorbs the SSR-vs-client minute-boundary difference.
 */
function FreshnessIndicator({ initial, compact = false }: { initial: FreshnessData; compact?: boolean }) {
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
      ? (compact ? formatAgeShort(ts) : formatAge(ts))
      : data.highlevel.isDemo
        ? (compact ? "demo" : "demo data")
        : (compact ? "—" : "never synced");
  const dot = data.highlevel.status === "connected" && !data.highlevel.isDemo
    ? "bg-(--dot-positive)"
    : data.highlevel.status === "error"
      ? "bg-(--dot-danger)"
      : "bg-(--dot-muted)";

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
    <div className="flex min-w-0 items-center gap-2" title={data.highlevel.lastError ?? undefined}>
      <span className={"inline-block h-1.5 w-1.5 shrink-0 rounded-full " + dot} aria-hidden />
      <span
        className={"text-[12px] text-(--text-muted) " + (compact ? "max-w-[76px] truncate" : "")}
        suppressHydrationWarning
      >
        {label}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={busy}
        className="shrink-0 rounded-md border border-(--card-border) px-2 py-0.5 text-[12px] text-(--text-caption) transition-colors hover:border-(--input-border) hover:text-(--text-primary) disabled:opacity-50"
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

/** Compact age for the phone header: "12m" / "3h" / "2d" — full label on hover/title. */
function formatAgeShort(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Appearance pre-paint (P5 no-flash): runs during head parse, BEFORE
            any paint — toggles .dark on <html> from localStorage
            (mallory-appearance) with prefers-color-scheme fallback. SSR emits
            no class; the mismatch is absorbed by suppressHydrationWarning. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var p=localStorage.getItem('mallory-appearance');var d=p==='dark'||(p!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})();",
          }}
        />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
