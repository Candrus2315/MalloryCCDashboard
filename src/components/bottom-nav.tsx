/**
 * Bottom tab bar — the mobile primary nav (Mobile Phase 2, owner decision 2026-10-09).
 *
 * The owner picked the five tabs and their order: Today · Reps · Teams ·
 * Availability · Settings. This is deliberately NOT the desktop NAV array:
 * the secondary routes (weekly, daily-report, commissions, performance, audit)
 * leave the primary mobile nav but stay reachable through the MobileNav
 * drawer, which keeps listing every route (their mobile reach path).
 *
 * Style contract: mobile-only chrome (md:hidden — 768+ renders the unchanged
 * desktop layout), z-40 so the z-50 overlays (MobileNav drawer, DetailDrawer)
 * stack above it, safe-area aware padding-bottom, and the same token system
 * as the header (sticky-header-bg + card-border hairline + backdrop blur).
 * Icons are newly-authored inline SVGs in the hamburger's exact stroke style
 * (20px viewBox 0 0 20 20, currentColor, 1.5, round caps, no fills).
 *
 * Desktop is untouched by construction: the whole element is display:none at
 * ≥768px, and print:hidden keeps it off the printed PIP page (the @media
 * print block only targets header/.pip-print-toolbar, not nav elements).
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export interface BottomNavTab {
  to: string;
  label: string;
}

/**
 * The bar's five tabs — the OWNER'S exact order and labels. The third tab
 * reads "Teams" here (owner ruling): mobile-only chrome wording; the desktop
 * nav's "Team" label stays byte-identical.
 */
export const BOTTOM_NAV_TABS: BottomNavTab[] = [
  { to: "/", label: "Today" },
  { to: "/reps", label: "Reps" },
  { to: "/team", label: "Teams" },
  { to: "/availability", label: "Availability" },
  { to: "/settings", label: "Settings" },
];

/**
 * Active rule copied verbatim from the desktop nav / drawer in __root.tsx:
 * "/" matches exactly, every other tab owns its path prefix. On a secondary
 * route (weekly, daily-report, commissions, performance, audit) NO tab is
 * active — the honest state; those routes live in the drawer.
 */
export function isBottomTabActive(to: string, path: string): boolean {
  return to === "/" ? path === "/" : path.startsWith(to);
}

/** Hamburger-style inline SVGs: 20×20 box, stroke currentColor 1.5, round caps, no fills. */
const ICON_ATTRS = {
  width: 20,
  height: 20,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function HomeIcon() {
  return (
    <svg {...ICON_ATTRS}>
      <path d="M3.4 9.4 10 4l6.6 5.4" />
      <path d="M5.4 8.2V16h9.2V8.2" />
      <path d="M8.4 16v-3.2h3.2V16" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg {...ICON_ATTRS}>
      <circle cx="10" cy="6.6" r="2.85" />
      <path d="M4.9 16.4a5.1 5.1 0 0 1 10.2 0" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg {...ICON_ATTRS}>
      <circle cx="8" cy="7" r="2.5" />
      <path d="M3.4 16.3v-1.4a3.1 3.1 0 0 1 3.1-3.1h3a3.1 3.1 0 0 1 3.1 3.1v1.4" />
      <path d="M12.9 4.75a2.5 2.5 0 0 1 0 4.7" />
      <path d="M16.6 16.3v-1.4a3.1 3.1 0 0 0-2.3-3" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg {...ICON_ATTRS}>
      <rect x="3.6" y="4.6" width="12.8" height="11" rx="1.6" />
      <path d="M3.6 8.3h12.8" />
      <path d="M7.2 3.1v3M12.8 3.1v3" />
    </svg>
  );
}

/** Gear — the standard cog glyph (lucide "settings", ISC) scaled ×5/6 from its
    24-box into the shared 20-box; stroke compensated (1.8 × 5/6 ≈ 1.5). */
function GearIcon() {
  return (
    <svg {...ICON_ATTRS}>
      <g transform="scale(0.833333)" strokeWidth="1.8">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </g>
    </svg>
  );
}

const TAB_ICONS: Record<string, ReactNode> = {
  "/": <HomeIcon />,
  "/reps": <UserIcon />,
  "/team": <UsersIcon />,
  "/availability": <CalendarIcon />,
  "/settings": <GearIcon />,
};

/**
 * Fixed bottom bar: 56px tab row + safe-area/8px foot. Tabs are full-height
 * ≥44px flex-1 touch targets (icon over an 11px label) with the drawer's
 * accent-pill active state; inactive tabs use --text-caption per the nav
 * spec. Mount once in AppShell, after <MobileNav/>.
 */
export function BottomNav({ path }: { path: string }) {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-(--card-border) bg-(--sticky-header-bg) pb-[calc(env(safe-area-inset-bottom)+8px)] backdrop-blur-sm md:hidden print:hidden"
    >
      {/* h-14 = the 56px tab row; the safe-area foot pads the nav itself so the
          row keeps its full height on notched phones. */}
      <div className="mx-auto flex h-14 max-w-7xl items-stretch">
        {BOTTOM_NAV_TABS.map((tab) => {
          const active = isBottomTabActive(tab.to, path);
          return (
            <Link
              key={tab.to}
              to={tab.to}
              aria-current={active ? "page" : undefined}
              className={
                "flex min-w-[44px] flex-1 flex-col items-center justify-center gap-1 rounded-md text-[11px] font-medium leading-none transition-colors " +
                (active
                  ? "bg-(--accent-solid) text-(--accent-solid-fg)"
                  : "text-(--text-caption) hover:text-(--text-primary)")
              }
            >
              {TAB_ICONS[tab.to]}
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
