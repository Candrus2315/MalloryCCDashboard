/**
 * STATUS — the in-app Status/Health view (the last unshipped reliability item).
 *
 * ONE read-only page surfacing the reliability stack's EXISTING signals, all
 * read fresh at page load through the getStatusHealthData server fn
 * (queries.ts) → statusHealthPageData():
 *
 *   • Overall status + version/commit — the SAME /health payload serve.ts
 *     answers with (buildHealthPayload), rendered in-app — never a fork.
 *   • Per-provider sync freshness (HighLevel, Acuity, Google Sheets,
 *     acuity_availability, attribution): last successful sync, age, ok /
 *     degraded / unknown, cadence and the 3× stale threshold.
 *   • Sync heartbeat liveness (the 240s tick that drives every background
 *     sync) — the same freshness object the banner and /health report.
 *   • Reliability stack: supervisor state (serve-restart + heartbeat-start
 *     verdicts from .run/supervisor-state.json), the serving process's boot
 *     lock, the stale-run reaper bound and the per-run ingest deadline.
 *   • Running guard: every in-flight sync_runs row, with the reaper's own
 *     bound flagging hung rows ("beyond reap bound").
 *   • Recent sync runs: where reaps / deadline errors honestly appear.
 *   • The full /health JSON, copyable, for the external-ping comparison.
 *
 * Presentation only: every fact on this page comes from an existing signal —
 * no sync internals, matching engine, or date logic is touched. Honest "—"
 * for missing data, never 0; each section fails on its own into an honest
 * error line without blanking the page. All timestamps render in ET via the
 * shared etSyncStamp (SSR/CSR identical); no clock is read during render.
 */
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { etSyncStamp } from "~/server/date-logic";
import { formatAgeMinutes } from "~/server/status-format";
import { getStatusHealthData } from "~/server/queries";
import type { HealthProviderReport } from "~/server/health";
import { formatInt } from "~/server/metrics/report-text";
import { Eyebrow, Panel } from "~/components/page-panel";
import { CopyButton } from "~/components/CopyButton";

export const Route = createFileRoute("/status")({
  loader: () => getStatusHealthData(),
  component: StatusPage,
});

// ---------------------------------------------------------------------------
// Shared chrome — the same chip/banner vocabulary the other pages use
// ---------------------------------------------------------------------------

type Tone = "good" | "warn" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  good: "bg-(--chip-positive-bg) text-(--chip-positive-fg)",
  warn: "bg-(--banner-bg) text-(--banner-fg)",
  neutral: "bg-(--chip-neutral-bg) text-(--chip-neutral-fg)",
};

function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={"inline-block rounded px-1.5 py-0.5 text-[11px] font-medium " + TONE_CLASS[tone]}>{children}</span>
  );
}

/** The banner line every page uses for warnings (role=alert). */
function WarningBanner({ text }: { text: string }) {
  return (
    <div className="status-banner" role="alert">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--dot-danger)" aria-hidden="true" />
      <span className="min-w-0">{text}</span>
    </div>
  );
}

const PROVIDER_LABELS: Record<string, string> = {
  highlevel: "HighLevel",
  acuity: "Acuity",
  google_sheets: "Google Sheets",
  acuity_availability: "Acuity availability feed",
  attribution: "Attribution engine",
};

function providerTone(status: string): Tone {
  if (status === "ok") return "good";
  if (status === "degraded") return "warn";
  return "neutral";
}

/** One provider freshness row — flex-wrap keeps it usable at 343px. */
function ProviderRow({ name, rep }: { name: string; rep: HealthProviderReport }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-(--table-border-weak) px-4 py-2.5 last:border-0">
      <span className="w-48 shrink-0 text-[13px] font-medium text-(--text-primary)">{name}</span>
      <Chip tone={providerTone(rep.status)}>{rep.status}</Chip>
      <span className="min-w-0 text-[13px] tabular-nums text-(--text-body)">
        {rep.lastSuccessAt ? etSyncStamp(rep.lastSuccessAt) : "never (no successful sync in history)"}
      </span>
      <span className="text-[13px] tabular-nums text-(--text-body)">age {formatAgeMinutes(rep.ageMinutes)}</span>
      <span className="text-xs text-(--text-caption)">
        cadence {rep.cadenceMinutes} min · stale after {rep.staleAfterMinutes} min
      </span>
    </div>
  );
}

function heartbeatTone(status: string): Tone {
  if (status === "ok") return "good";
  if (status === "stale" || status === "dead") return "warn";
  return "neutral";
}

function runStatusTone(status: string): Tone {
  if (status === "success") return "good";
  if (status === "error") return "warn";
  return "neutral";
}

/** Labeled fact line — the definition-row anatomy for the stack panels. */
function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-(--table-border-weak) px-4 py-2.5 last:border-0">
      <span className="w-48 shrink-0 text-[13px] font-medium text-(--text-primary)">{label}</span>
      <span className="min-w-0 flex-1 text-[13px] text-(--text-body)">{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function StatusPage() {
  const data = Route.useLoaderData();
  const health = data.health;
  const hb = data.heartbeat;
  const healthJson = JSON.stringify(health, null, 2);

  return (
    <div className="space-y-4">
      {/* header — the wave-2 anatomy: title pair on line 1, meta line beneath */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h1 className="text-[22px] font-semibold tracking-tight text-(--text-primary)">Status</h1>
            <span className="text-[15px] font-medium text-(--text-faint)" aria-hidden="true">
              —
            </span>
            <span className="text-[15px] font-medium text-(--text-caption)">Sync &amp; reliability (read-only)</span>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-(--text-caption)">
            <span className="h-1 w-1 shrink-0 rounded-full bg-(--dot-muted)" aria-hidden="true" />
            <span>One place for the same signals /health and the page banners report</span>
          </p>
        </div>
      </header>

      {/* overall status — the /health verdict, verbatim */}
      <div className="status-banner" role="status">
        <span className="min-w-0">
          Overall sync status: <strong>{health.status}</strong>
          {health.status === "ok"
            ? " — every tracked provider is fresh"
            : " — at least one tracked provider is stale beyond 3× its cadence"}
        </span>
      </div>
      <p className="-mt-2 text-xs text-(--text-caption)">
        Version {health.version} · commit {health.commit} · served {etSyncStamp(health.now)} ET. All ages are computed
        fresh at page load — they grow while the site sleeps and reset on the next successful sync.
      </p>
      {health.error && <WarningBanner text={health.error} />}

      {/* the same warning clauses every page's banner shows */}
      {data.warnings.map((w) => (
        <WarningBanner key={w} text={w} />
      ))}
      {data.warningsError && <WarningBanner text={data.warningsError} />}

      {/* provider sync freshness — the /health providers map, unchanged */}
      <Panel className="overflow-hidden">
        <div className="border-b border-(--table-border-weak) px-4 py-3">
          <Eyebrow>Provider sync freshness</Eyebrow>
          <p className="mt-1 text-xs text-(--text-caption)">
            Provider · status · last success (ET) · age · cadence / stale-after. "unknown" = no successful sync in the
            provider's history (fresh install / never connected) — reported, never counted as degraded.
          </p>
        </div>
        {Object.keys(health.providers)
          .sort()
          .map((key) => (
            <ProviderRow key={key} name={PROVIDER_LABELS[key] ?? key} rep={health.providers[key]} />
          ))}
      </Panel>

      {/* sync heartbeat — the 240s tick that drives every background sync */}
      <Panel className="overflow-hidden">
        <div className="border-b border-(--table-border-weak) px-4 py-3">
          <Eyebrow>Sync heartbeat</Eyebrow>
          <p className="mt-1 text-xs text-(--text-caption)">
            The 24/7 tick that drives every background sync — classified from the newest TICK line in its log, the same
            evidence /health and the banner use.
          </p>
        </div>
        <FactRow label="Liveness">
          <Chip tone={heartbeatTone(hb.status)}>{hb.status}</Chip>
          {hb.status === "unknown" && (
            <span className="ml-2 text-xs text-(--text-caption)">log missing or unreadable — no evidence, no alarm</span>
          )}
          {hb.status === "dead" && (
            <span className="ml-2 text-xs text-(--text-caption)">log readable but holds no TICK line</span>
          )}
        </FactRow>
        <FactRow label="Last tick (ET)">{hb.lastTickAt ? etSyncStamp(hb.lastTickAt) : "—"}</FactRow>
        <FactRow label="Age">{formatAgeMinutes(hb.ageMinutes)}</FactRow>
        <FactRow label="Cadence / stale-after">
          every {hb.intervalMinutes} min · stale after {hb.staleAfterMinutes} min (3× interval)
        </FactRow>
      </Panel>

      {/* reliability stack — supervisor, boot lock, reaper + ingest bounds */}
      <Panel className="overflow-hidden">
        <div className="border-b border-(--table-border-weak) px-4 py-3">
          <Eyebrow>Reliability stack</Eyebrow>
          <p className="mt-1 text-xs text-(--text-caption)">
            The shipped self-recovery layers (PR #98 supervisor, boot guard, #99 running guard, #102 ingest wedge) —
            read from their own state, never inferred.
          </p>
        </div>
        <FactRow label="Supervisor">
          {data.supervisor.available ? (
            <>
              <span className="font-medium text-(--text-primary)">{data.supervisor.stateLine ?? "(no state line yet)"}</span>
              <span className="ml-2 text-xs text-(--text-caption)">
                serve restarts in window: {formatInt(data.supervisor.serveRestartsInWindow ?? 0)} · heartbeat starts in
                window: {formatInt(data.supervisor.hbRestartsInWindow ?? 0)} · serve backoff active:{" "}
                {data.supervisor.serveBackoffActive ? "yes" : "no"} · heartbeat backoff active:{" "}
                {data.supervisor.hbBackoffActive ? "yes" : "no"}
              </span>
            </>
          ) : (
            <span className="text-(--text-muted)">— (no state file — the supervisor has not completed a cycle)</span>
          )}
        </FactRow>
        {data.supervisorError && <FactRow label="Supervisor error">{data.supervisorError}</FactRow>}
        <FactRow label="Serving process">
          {data.serverLock.available ? (
            <>
              <span className="tabular-nums">
                pid {formatInt(data.serverLock.pid ?? 0)} on port {formatInt(data.serverLock.port ?? 0)}
              </span>
              <span className="ml-2 text-xs text-(--text-caption)">
                booted {data.serverLock.startedAt ? etSyncStamp(data.serverLock.startedAt) : "—"} ET · up{" "}
                {formatAgeMinutes(data.serverLock.ageMinutes)}
              </span>
            </>
          ) : (
            <span className="text-(--text-muted)">— (no boot lock file)</span>
          )}
        </FactRow>
        <FactRow label="Stale-run reaper">
          reaps any "running" sync_runs row older than {formatInt(data.reapBoundMinutes)} min (the running guard's
          freshness bound)
        </FactRow>
        <FactRow label="Ingest wall-clock deadline">
          {formatInt(data.ingestDeadlineMinutes)} min per run — a detached (reaped) run stops its DB work on its own
        </FactRow>
      </Panel>

      {/* running guard — every in-flight sync row, hung ones flagged */}
      <Panel className="overflow-hidden">
        <div className="border-b border-(--table-border-weak) px-4 py-3">
          <Eyebrow>In-flight sync runs</Eyebrow>
          <p className="mt-1 text-xs text-(--text-caption)">
            Every sync_runs row still "running" (any age). One older than the reap bound is a hung process, not a live
            sync — the reaper marks it failed on its next pass.
          </p>
        </div>
        {data.runningError && <div className="px-4 py-2 text-xs text-(--banner-fg)">{data.runningError}</div>}
        {data.runningRuns == null ? null : data.runningRuns.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-[13px] text-(--text-muted)">No syncs currently in flight.</p>
          </div>
        ) : (
          data.runningRuns.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-(--table-border-weak) px-4 py-2.5 last:border-0"
            >
              <span className="w-48 shrink-0 text-[13px] font-medium text-(--text-primary)">{PROVIDER_LABELS[r.provider] ?? r.provider}</span>
              {r.beyondReapBound ? <Chip tone="warn">beyond reap bound</Chip> : <Chip tone="neutral">running</Chip>}
              <span className="text-[13px] tabular-nums text-(--text-body)">started {etSyncStamp(r.startedAt)} ET</span>
              <span className="text-[13px] tabular-nums text-(--text-body)">age {formatAgeMinutes(r.ageMinutes)}</span>
            </div>
          ))
        )}
      </Panel>

      {/* recent runs — where reaps / deadline errors honestly appear */}
      <Panel className="overflow-hidden">
        <div className="border-b border-(--table-border-weak) px-4 py-3">
          <Eyebrow>Recent sync runs (last {formatInt(data.recentLimit)})</Eyebrow>
          <p className="mt-1 text-xs text-(--text-caption)">
            Newest first, every status and error verbatim — reap and deadline errors appear here exactly as recorded.
          </p>
        </div>
        {data.recentError && <div className="px-4 py-2 text-xs text-(--banner-fg)">{data.recentError}</div>}
        {data.recentRuns == null ? null : data.recentRuns.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-[13px] text-(--text-muted)">No sync runs recorded yet.</p>
          </div>
        ) : (
          data.recentRuns.map((r) => (
            <div key={r.id} className="border-b border-(--table-border-weak) px-4 py-2.5 last:border-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="w-48 shrink-0 text-[13px] font-medium text-(--text-primary)">
                  {PROVIDER_LABELS[r.provider] ?? r.provider}
                </span>
                <Chip tone={runStatusTone(r.status)}>{r.status}</Chip>
                <span className="text-[13px] tabular-nums text-(--text-body)">
                  {etSyncStamp(r.startedAt)} ET → {r.finishedAt ? etSyncStamp(r.finishedAt) + " ET" : "—"}
                </span>
                <span className="text-[13px] tabular-nums text-(--text-body)">duration {formatAgeMinutes(r.durationMinutes)}</span>
                <span className="text-xs text-(--text-caption)">{formatInt(r.recordsUpserted)} records upserted</span>
              </div>
              {r.error && <p className="mt-1 break-words text-xs text-(--banner-fg)">{r.error}</p>}
            </div>
          ))
        )}
      </Panel>

      {/* the machine-readable surface, in-app and copyable */}
      <Panel>
        <div className="p-4 sm:p-5">
          <Eyebrow>/health payload</Eyebrow>
          <p className="mt-1 text-xs text-(--text-caption)">
            The exact JSON the /health endpoint serves (the external ping's payload) — copied byte-for-byte from the
            same builder, nothing re-shaped.
          </p>
          <details className="group mt-3">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-medium text-(--text-caption) transition-colors hover:text-(--text-primary) [&::-webkit-details-marker]:hidden">
              <span aria-hidden="true" className="text-[10px] transition-transform group-open:rotate-90">
                ▶
              </span>
              Show /health JSON
            </summary>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <CopyButton label="Copy /health JSON" text={healthJson} variant="secondary" />
            </div>
            <pre className="mt-3 overflow-x-auto rounded-md bg-(--surface-inset) p-3 text-[11px] leading-snug text-(--text-body)">
              {healthJson}
            </pre>
          </details>
        </div>
      </Panel>
    </div>
  );
}
