import { useState } from "react";
import { LEAD_SOURCE_LABELS, type LeadSourceSheet } from "~/components/lead-sources";
import { SHEET_MODE_LABELS, type SheetMappingMode } from "~/server/sync/sheets-mapping";
import { DEFAULT_COLUMN_MAPPING, DEFAULT_COLUMN_MAPPING_DAY_COUNT } from "~/server/store/types";

const COLUMN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const SHEET_FIELDS_LEAD: { key: string; label: string }[] = [
  { key: "source_date", label: "Date" },
  { key: "name", label: "Name" },
  { key: "last_name", label: "Last name (optional)" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "lead_type", label: "Lead Type (optional)" },
];
const SHEET_FIELDS_DAY: { key: string; label: string }[] = [
  { key: "source_date", label: "Date" },
  { key: "count", label: "Lead count" },
  { key: "lead_type", label: "Lead Type (optional)" },
];
const SHEET_MODE_OPTIONS: { value: SheetMappingMode; label: string; hint: string }[] = [
  { value: "row_per_day_count", label: SHEET_MODE_LABELS.row_per_day_count, hint: "one row per day, a count column says how many leads" },
  { value: "row_per_lead", label: SHEET_MODE_LABELS.row_per_lead, hint: "one row per lead, with phone/email" },
];

export function SheetMappingCard({ sheet, columns, mode: initialMode, sheetId, busy, onSave }: {
  sheet: LeadSourceSheet;
  columns: Record<string, string>;
  mode: SheetMappingMode;
  sheetId: string;
  busy: boolean;
  onSave: (columns: Record<string, string>, mode: SheetMappingMode) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({ ...columns });
  const [mode, setMode] = useState<SheetMappingMode>(initialMode);
  const [test, setTest] = useState<{
    sample: { header: string[]; rows: string[][]; tab?: string; notice?: string | null };
    result: { parsed: Record<string, string | null>; warnings: string[] };
    workDate: string | null;
    sourceDate: string | null;
    source: "live" | "demo-fallback";
    liveError: string | null;
    mode: SheetMappingMode;
  } | null>(null);
  const fields = mode === "row_per_day_count" ? SHEET_FIELDS_DAY : SHEET_FIELDS_LEAD;
  // The out-of-the-box mapping for the current shape — shown so the default is
  // discoverable without digging through code (owner-corrected: date = Q).
  const defaultColumns = mode === "row_per_day_count" ? DEFAULT_COLUMN_MAPPING_DAY_COUNT : DEFAULT_COLUMN_MAPPING;
  const defaultNote = fields
    .map((f) => `${f.label.replace(" (optional)", "")} ${defaultColumns[f.key] ?? "—"}`)
    .join(" · ");
  return (
    <div className="card card-nest card-dense space-y-3">
      <div>
        <p className="section-title">{LEAD_SOURCE_LABELS[sheet]} sheet</p>
        <p className="mt-1 truncate text-xs text-(--text-muted)">Sheet ID {sheetId}</p>
        <p className="mt-0.5 text-xs text-(--text-muted)">
          Default mapping: {defaultNote} (editable below)
        </p>
      </div>
      <div className="space-y-1">
        <span className="kpi-label">Sheet shape</span>
        {SHEET_MODE_OPTIONS.map((m) => (
          <label key={m.value} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-(--surface-hover)">
            <input type="radio" name={`${sheet}-mode`} className="mt-0.5" checked={mode === m.value} onChange={() => setMode(m.value)} />
            <span className="text-[13px]">
              <span className="font-medium text-(--text-body)">{m.label}</span>
              <span className="block text-xs text-(--text-muted)">{m.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="kpi-label">{f.label}</span>
            <select className="input-field mt-1 w-full" value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}>
              {COLUMN_LETTERS.map((l) => (
                <option key={l} value={l}>
                  Column {l}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <button className="btn-secondary text-xs" disabled={busy} onClick={() => onSave(draft, mode)}>
          Save mapping
        </button>
        <button
          className="btn-secondary text-xs"
          disabled={busy}
          onClick={async () => {
            const { testSheetMapping } = await import("~/server/queries");
            const res = await testSheetMapping({ data: { sheet, columns: draft, mode } });
            setTest(res as typeof test);
          }}
        >
          Test mapping (live)
        </button>
      </div>
      {test && (
        <div className="rounded-lg bg-(--surface-inset) p-3 text-xs text-(--chip-neutral-fg)">
          <p className="mb-1">
            <span className={"rounded-full px-2 py-0.5 text-xs font-medium " + (test.source === "live" ? "bg-(--chip-good-bg) text-(--chip-good-fg)" : "bg-(--chip-current-bg) text-(--chip-current-fg)")}>
              {test.source === "live" ? "live sample from Google Sheets" : "demo sample — Sheets API not reachable yet"}
            </span>
            {test.source === "live" && test.sample.tab ? <span className="ml-2 text-(--text-muted)">tab “{test.sample.tab}”</span> : null}
          </p>
          {test.liveError && <p className="mt-1 text-(--neg-text)">{test.liveError}</p>}
          {test.sample.notice && <p className="mt-1 text-(--banner-fg)">{test.sample.notice}</p>}
          <p className="kpi-label mt-2 mb-1">Sample row (header: {test.sample.header.join(" | ") || "—"})</p>
          <p className="mb-2 font-mono text-xs">{test.sample.rows[0]?.join("  |  ")}</p>
          <p className="kpi-label mb-1">Parsed ({test.mode === "row_per_day_count" ? "row-per-day + count" : "row-per-lead"})</p>
          <ul className="space-y-0.5">
            {Object.entries(test.result.parsed).map(([k, v]) => (
              <li key={k}>
                <span className="text-(--text-muted)">{k}:</span> <span className={v ? "font-medium text-(--text-body)" : "text-(--neg-text)"}>{v || "missing"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1">
            <span className="text-(--text-muted)">source_date (normalized):</span> <span className="font-medium text-(--text-body)">{test.sourceDate ?? "—"}</span>
            <span className="text-(--text-muted)"> · work_date:</span> <span className="font-medium text-(--text-body)">{test.workDate ?? "—"}</span>
          </p>
          {test.result.warnings.length > 0 && <p className="mt-1 text-(--banner-fg)">{test.result.warnings.join(" · ")}</p>}
        </div>
      )}
    </div>
  );
}
