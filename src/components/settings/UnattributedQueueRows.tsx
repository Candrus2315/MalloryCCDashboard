import { useState } from "react";
import { StatusChip } from "~/components/StatusChip";
import { NO_REP_REASON_LABELS, QUEUE_STATE_LABELS, queueRowState, unassignable } from "~/components/settings-views";

/** Owner vocabulary for the engine's unattributed reasons (never guessed here). */
const UNATTRIBUTED_REASON_LABELS: Record<string, string> = {
  "no-qualifying-call": "No qualifying call in window",
  "no-contact-identity": "No contact identity",
  ambiguous: "Unclear match — decide who",
  "bad-datetime": "Unreadable booking time",
  "manually-assigned": "Manually assigned",
};

export function UnattributedRow({ row, users, busy, onAssign, onUnassign }: {
  row: { appointment_id: string; client_name: string | null; client_phone: string | null; client_email: string | null; appointment_type: string; calendar_name: string | null; appointment_datetime: string; created_at: string; reason: string | null; reason_code: string | null; suggested_rep_id: string | null; candidate_calls: { call_id: string; rep_id: string | null; started_at: string; duration_seconds: number }[] };
  users: { id: string; name: string }[];
  busy: boolean;
  onAssign: (appointmentId: string, repId: string, callId?: string | null) => void;
  onUnassign: (appointmentId: string) => void;
}) {
  const [repId, setRepId] = useState(row.suggested_rep_id ?? row.candidate_calls[0]?.rep_id ?? "");
  const [callId, setCallId] = useState(row.candidate_calls[0]?.call_id ?? "");
  // S4b: the refined no-rep category (reason_code) is the primary label — the
  // legacy coarse reason is the fallback for rows predating the classification.
  const reasonLabel = row.reason
    ? NO_REP_REASON_LABELS[row.reason_code ?? ""] ?? UNATTRIBUTED_REASON_LABELS[row.reason] ?? row.reason
    : "—";
  return (
    <tr>
      <td className="font-medium text-(--text-primary)">
        {row.client_name ?? "Unknown"}
        <span className="block text-xs font-normal text-(--text-muted)">{row.client_phone ?? ""}</span>
        <span className="block text-xs font-normal text-(--text-muted)">{row.client_email ?? ""}</span>
      </td>
      <td>
        {row.appointment_type}
        <span className="block text-xs text-(--text-muted)">{row.calendar_name ?? ""}</span>
      </td>
      <td>
        {new Date(row.appointment_datetime).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}
        <span className="block text-xs text-(--text-muted)">booked {new Date(row.created_at).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}</span>
      </td>
      <td>
        <StatusChip kind={queueRowState(row.reason) === "ambiguous" ? "risk" : "neutral"} label={QUEUE_STATE_LABELS[queueRowState(row.reason)]} />
        <span className="mt-1 block text-[12px] text-(--chip-neutral-fg)" title={row.reason_code ?? row.reason ?? ""}>
          {reasonLabel}
        </span>
      </td>
      <td>{users.find((u) => u.id === row.suggested_rep_id)?.name ?? "—"}</td>
      <td>
        {row.candidate_calls.length > 0 ? (
          <select className="input-field" value={callId} onChange={(e) => setCallId(e.target.value)}>
            {row.candidate_calls.map((c) => (
              <option key={c.call_id} value={c.call_id}>
                {new Date(c.started_at).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })} · {Math.round(c.duration_seconds / 60)}m · {users.find((u) => u.id === c.rep_id)?.name ?? "non-roster"}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-(--text-muted)">—</span>
        )}
      </td>
      <td>
        <select className="input-field" value={repId} onChange={(e) => setRepId(e.target.value)}>
          <option value="">Choose rep…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </td>
      <td>
        <div className="flex flex-col items-start gap-1.5">
          <button className="btn-secondary text-xs" disabled={busy || !repId} onClick={() => onAssign(row.appointment_id, repId, callId || null)}>
            Assign
          </button>
          {unassignable(row.reason) && (
            <button className="text-xs text-(--neg-text) hover:underline disabled:opacity-50" disabled={busy} onClick={() => onUnassign(row.appointment_id)}>
              Unassign
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/**
 * Mobile stacked decision card for the manual-assignment queue (md:hidden
 * twin of UnattributedRow). Same row data, same reason labels, same assign/
 * unassign handlers and controls — laid out vertically with full-width
 * selects so the decision is readable and tappable at 375px.
 */
export function UnattributedCard({ row, users, busy, onAssign, onUnassign }: {
  row: { appointment_id: string; client_name: string | null; client_phone: string | null; client_email: string | null; appointment_type: string; calendar_name: string | null; appointment_datetime: string; created_at: string; reason: string | null; reason_code: string | null; suggested_rep_id: string | null; candidate_calls: { call_id: string; rep_id: string | null; started_at: string; duration_seconds: number }[] };
  users: { id: string; name: string }[];
  busy: boolean;
  onAssign: (appointmentId: string, repId: string, callId?: string | null) => void;
  onUnassign: (appointmentId: string) => void;
}) {
  const [repId, setRepId] = useState(row.suggested_rep_id ?? row.candidate_calls[0]?.rep_id ?? "");
  const [callId, setCallId] = useState(row.candidate_calls[0]?.call_id ?? "");
  const reasonLabel = row.reason
    ? NO_REP_REASON_LABELS[row.reason_code ?? ""] ?? UNATTRIBUTED_REASON_LABELS[row.reason] ?? row.reason
    : "—";
  return (
    <div className="rounded-lg border border-(--card-border) bg-(--card-bg) p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-(--text-primary)">{row.client_name ?? "Unknown"}</p>
          {(row.client_phone || row.client_email) && (
            <p className="mt-0.5 break-all text-xs text-(--text-muted)">
              {[row.client_phone, row.client_email].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
        <StatusChip kind={queueRowState(row.reason) === "ambiguous" ? "risk" : "neutral"} label={QUEUE_STATE_LABELS[queueRowState(row.reason)]} />
      </div>
      <p className="mt-2 text-[12px] text-(--chip-neutral-fg)">
        {row.appointment_type}
        {row.calendar_name ? ` · ${row.calendar_name}` : ""}
      </p>
      <p className="mt-0.5 text-[12px] tabular-nums text-(--text-caption)">
        {new Date(row.appointment_datetime).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}
        <span className="text-(--text-muted)"> · booked {new Date(row.created_at).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}</span>
      </p>
      <p className="mt-1 text-[12px] text-(--chip-neutral-fg)" title={row.reason_code ?? row.reason ?? ""}>
        {reasonLabel}
      </p>
      <p className="mt-1 text-[12px] text-(--text-caption)">
        Suggested: <span className="font-medium text-(--text-body)">{users.find((u) => u.id === row.suggested_rep_id)?.name ?? "—"}</span>
      </p>
      {row.candidate_calls.length > 0 && (
        <label className="mt-3 block">
          <span className="kpi-label">Call</span>
          <select className="input-field mt-1 w-full" value={callId} onChange={(e) => setCallId(e.target.value)}>
            {row.candidate_calls.map((c) => (
              <option key={c.call_id} value={c.call_id}>
                {new Date(c.started_at).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })} · {Math.round(c.duration_seconds / 60)}m · {users.find((u) => u.id === c.rep_id)?.name ?? "non-roster"}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="mt-2 block">
        <span className="kpi-label">Assign to</span>
        <select className="input-field mt-1 w-full" value={repId} onChange={(e) => setRepId(e.target.value)}>
          <option value="">Choose rep…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-3 flex items-center gap-3">
        <button className="btn-secondary text-xs" disabled={busy || !repId} onClick={() => onAssign(row.appointment_id, repId, callId || null)}>
          Assign
        </button>
        {unassignable(row.reason) && (
          <button className="text-xs text-(--neg-text) hover:underline disabled:opacity-50" disabled={busy} onClick={() => onUnassign(row.appointment_id)}>
            Unassign
          </button>
        )}
      </div>
    </div>
  );
}
