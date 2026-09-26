/**
 * Google Sheets → leads mapping: PURE parsing logic (no network, no store).
 * Shared by the live adapter, the Settings "test mapping" action, and tests.
 *
 * Two sheet shapes are supported (the real sheets were not visible when this
 * was built, so the mapping schema supports both and Settings lets the owner
 * pick per sheet — "Test mapping" shows a REAL sample row live):
 *
 *  - "row_per_day_count" (primary): one row per day with a lead COUNT column.
 *    Each row expands into N lead rows; re-syncs REPLACE the stored count
 *    (delete + insert per sheet), never add to it.
 *  - "row_per_lead": one row per lead with phone/email columns.
 *
 * Every parsed lead gets:
 *  - source_date: the sheet date column parsed as an ET calendar date (robust
 *    to common formats: ISO, M/D/YYYY, M-D-YY, "Sep 24, 2026", "24 Sep 2026",
 *    YYYYMMDD, Google serial dates).
 *  - work_date:   getWorkDate(source_date) — the SPEC operational rule
 *    (Tue–Fri → prev day; Mon cohort ← Fri+Sat+Sun).
 *  - source_id:   deterministic (sheetId + date + row identity) so re-syncs
 *    are duplicate-safe by construction.
 */
import { addDays, getWorkDate } from "../date-logic";

/** Normalized lead produced by every mapping mode. */
export interface NormalizedLead {
  source_id: string;
  leadType: string;
  sourceDate: string;
  workDate: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  sheet: string;
}

// ---------- column letters ----------
/** Column letters ("A".."ZZ") → 0-based index; null for invalid letters. */
export function columnLetterToIndex(letter: string): number | null {
  const m = /^[A-Za-z]{1,2}$/.exec(letter.trim());
  if (!m) return null;
  const s = letter.trim().toUpperCase();
  let idx = 0;
  for (const ch of s) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx - 1;
}

// ---------- mapping modes ----------
export type SheetMappingMode = "row_per_day_count" | "row_per_lead";
export const SHEET_MAPPING_MODES: SheetMappingMode[] = ["row_per_day_count", "row_per_lead"];
export const SHEET_MODE_LABELS: Record<SheetMappingMode, string> = {
  row_per_day_count: "One row per day + lead count",
  row_per_lead: "One row per lead",
};

export function isSheetMappingMode(v: unknown): v is SheetMappingMode {
  return typeof v === "string" && (SHEET_MAPPING_MODES as string[]).includes(v);
}

/** Legacy (Phase 1) mapping fields — kept as the row_per_lead field set. */
export const SHEET_MAPPING_FIELDS = ["source_date", "name", "phone", "email", "lead_type"] as const;
/** Fields interpreted in row-per-day-count mode. */
export const SHEET_MAPPING_FIELDS_DAY_COUNT = ["source_date", "count", "lead_type"] as const;

export interface SheetMapping {
  mode: SheetMappingMode;
  columns: Record<string, string>;
}

function fieldsForMode(mode: SheetMappingMode): readonly string[] {
  return mode === "row_per_day_count" ? SHEET_MAPPING_FIELDS_DAY_COUNT : SHEET_MAPPING_FIELDS;
}

export interface SheetRowParseResult {
  parsed: Record<string, string | null>;
  warnings: string[];
}

/**
 * Parse one raw sheet row using the configured column mapping + mode.
 * Pure and provider-agnostic — the demo adapter feeds it a sample row, the
 * live adapter feeds it rows straight from the Google Sheets API, and the
 * Settings "test mapping" action shows the interpretation to the owner.
 * Mode defaults to "row_per_lead" (the Phase-1 behavior).
 */
/** Fields whose absence is legitimate (they fall back to the sheet name). */
const OPTIONAL_FIELDS = new Set(["lead_type"]);

export function applySheetMapping(row: string[], columns: Record<string, string>, mode: SheetMappingMode = "row_per_lead"): SheetRowParseResult {
  const warnings: string[] = [];
  const parsed: Record<string, string | null> = {};
  for (const field of fieldsForMode(mode)) {
    parsed[field] = null;
    const letter = columns[field];
    if (!letter) {
      if (!OPTIONAL_FIELDS.has(field)) warnings.push(`${field}: no column set`);
      continue;
    }
    const idx = columnLetterToIndex(letter);
    if (idx == null) {
      warnings.push(`${field}: "${letter}" is not a valid column letter`);
      continue;
    }
    const value = (row[idx] ?? "").trim();
    if (!value) {
      if (!OPTIONAL_FIELDS.has(field)) warnings.push(`${field}: column ${letter.toUpperCase()} is empty in the sample row`);
      continue;
    }
    parsed[field] = value;
  }
  return { parsed, warnings };
}

// ---------- date parsing (robust to common sheet formats) ----------
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function validDateStr(y: number, mo: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1970 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Parse a raw sheet date cell into an ET calendar date (YYYY-MM-DD).
 * Returns null when the value is blank or not a recognizable date. Dates are
 * calendar dates — no timezone shifting (a sheet date "9/24/2026" IS
 * 2026-09-24 in ET, per SPEC all operational dates are ET calendar dates).
 */
export function parseSheetDate(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return validDateStr(+m[1], +m[2], +m[3]);
  // compact YYYYMMDD
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return validDateStr(+m[1], +m[2], +m[3]);
  // US M/D/YYYY (also M-D-YYYY; 2-digit year → 20xx). US order per ET business.
  // Tolerates a trailing time ("02/02/2026 0:0") — Google returns formatted
  // date-times as displayed strings; the time part is ignored (ET calendar date).
  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:[T\s].*)?$/.exec(s);
  if (m) {
    const yr = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return validDateStr(yr, +m[1], +m[2]);
  }
  // "Sep 24, 2026" / "September 24 2026"
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo) return validDateStr(+m[3], mo, +m[2]);
  }
  // "24 Sep 2026" / "24 September 2026"
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo) return validDateStr(+m[3], mo, +m[1]);
  }
  // Google Sheets serial date (days since 1899-12-30) — surfaces when values
  // come back numeric instead of formatted. Range ≈ 1954..2089.
  if (/^\d{4,6}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n >= 20000 && n <= 80000) {
      return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86_400_000).toISOString().slice(0, 10);
    }
  }
  return null;
}

// ---------- backfill window ----------
/**
 * Backfill window: current + previous 5 weeks of source_dates. Sheets history
 * older than this is skipped (counted, not silently dropped) to keep syncs
 * bounded; change here if the owner wants full-history imports.
 */
export const LEAD_BACKFILL_DAYS = 35;

export function backfillWindowStart(todayIso: string): string {
  return addDays(todayIso, -LEAD_BACKFILL_DAYS);
}

// ---------- full-sheet parsing ----------
export interface SheetParseStats {
  sheet: string;
  sheetId: string;
  mode: SheetMappingMode;
  totalRows: number;
  /** Rows whose date column parsed to a real date. */
  dataRows: number;
  /** Rows that produced at least one lead (inside the window). */
  usedRows: number;
  /** Lead rows produced (count-expanded). */
  leads: number;
  /** Rows before the backfill window start (skipped, counted). */
  skippedOld: number;
  /** Rows with a date that could not be parsed / unusable content. */
  skippedBad: number;
  /** Fully empty rows. */
  skippedEmpty: number;
  windowStart: string;
}

export interface ParsedSheetResult {
  leads: NormalizedLead[];
  warnings: string[];
  stats: SheetParseStats;
  /** First non-empty row — the header/title row when one exists. */
  header: string[];
}

const MAX_PLAUSIBLE_DAY_COUNT = 10_000;

/** Phone identity key: last 10 digits (US). */
function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Parse a full sheet (rows as returned by Sheets API values.get, header row
 * included) into normalized leads. Applies the mapping mode, the backfill
 * window (source_date >= windowStart; future dates are kept — their
 * work_date is future so they never pollute current reporting), count
 * expansion for row-per-day sheets, and deterministic source_ids.
 */
export function parseSheetRows(opts: {
  sheet: "family" | "animalia";
  sheetId: string;
  mapping: SheetMapping;
  rows: string[][];
  windowStart: string;
}): ParsedSheetResult {
  const { sheet, sheetId, mapping, rows, windowStart } = opts;
  const mode = mapping.mode;
  const warnings: string[] = [];
  const leads: NormalizedLead[] = [];
  const stats: SheetParseStats = {
    sheet, sheetId, mode,
    totalRows: rows.length, dataRows: 0, usedRows: 0, leads: 0,
    skippedOld: 0, skippedBad: 0, skippedEmpty: 0, windowStart,
  };
  const header = rows.find((r) => r.some((c) => String(c ?? "").trim() !== "")) ?? [];
  const dateLetter = (mapping.columns.source_date ?? "?").toUpperCase();
  const seenIds = new Map<string, number>();

  const pushLead = (l: NormalizedLead) => {
    const n = (seenIds.get(l.source_id) ?? 0) + 1;
    seenIds.set(l.source_id, n);
    if (n > 1) l.source_id = `${l.source_id}#${n}`;
    leads.push(l);
  };

  rows.forEach((row, i) => {
    const rowNo = i + 1;
    const isEmpty = !row.some((c) => String(c ?? "").trim() !== "");
    if (isEmpty) { stats.skippedEmpty++; return; }
    const dateIdx = columnLetterToIndex(mapping.columns.source_date ?? "");
    const rawDate = dateIdx == null ? "" : (row[dateIdx] ?? "").trim();
    const d = parseSheetDate(rawDate);
    if (!d) {
      stats.skippedBad++;
      if (stats.skippedBad <= 3) {
        warnings.push(`row ${rowNo}: no readable date in column ${dateLetter} (value "${rawDate.slice(0, 40)}")`);
      }
      return;
    }
    stats.dataRows++;
    if (d < windowStart) { stats.skippedOld++; return; }

    if (mode === "row_per_day_count") {
      const countIdx = columnLetterToIndex(mapping.columns.count ?? "");
      const rawCount = countIdx == null ? "" : (row[countIdx] ?? "").trim();
      const n = Number(String(rawCount).replace(/[,\s]/g, ""));
      if (!rawCount || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        stats.skippedBad++;
        if (stats.skippedBad <= 3) warnings.push(`row ${rowNo}: unreadable lead count in column ${(mapping.columns.count ?? "?").toUpperCase()} (value "${rawCount.slice(0, 40)}")`);
        return;
      }
      if (n > MAX_PLAUSIBLE_DAY_COUNT) {
        stats.skippedBad++;
        warnings.push(`row ${rowNo}: implausible lead count ${n} — row skipped (check the count column mapping)`);
        return;
      }
      const ltIdx = columnLetterToIndex(mapping.columns.lead_type ?? "");
      const leadType = (ltIdx == null ? "" : (row[ltIdx] ?? "").trim()) || sheet;
      for (let k = 0; k < n; k++) {
        pushLead({
          source_id: `${sheetId}#${sheet}#d${d}#${k}`,
          leadType,
          sourceDate: d,
          workDate: getWorkDate(d),
          name: null, phone: null, email: null,
          sheet,
        });
      }
      stats.usedRows++;
      stats.leads += n;
      return;
    }

    // row_per_lead
    const idxOf = (f: string) => {
      const idx = columnLetterToIndex(mapping.columns[f] ?? "");
      return idx == null ? "" : (row[idx] ?? "").trim();
    };
    const name = idxOf("name") || null;
    const phone = idxOf("phone") || null;
    const email = idxOf("email") || null;
    const leadType = idxOf("lead_type") || sheet;
    if (!phone && !email) {
      stats.skippedBad++;
      if (stats.skippedBad <= 3) warnings.push(`row ${rowNo}: lead has no phone and no email — row skipped`);
      return;
    }
    const idBase = `${sheetId}#${sheet}#d${d}#${phone ? "p" + phoneKey(phone) : "e" + (email ?? "").toLowerCase()}`;
    pushLead({
      source_id: idBase,
      leadType,
      sourceDate: d,
      workDate: getWorkDate(d),
      name, phone, email,
      sheet,
    });
    stats.usedRows++;
    stats.leads++;
  });

  if (stats.skippedBad > 3) warnings.push(`…and ${stats.skippedBad - 3} more skipped rows`);
  if (stats.dataRows === 0) {
    warnings.push(`No rows with a readable date in column ${dateLetter} — check the mapping in Settings → Sheet column mapping (Test mapping shows the real header) and that the sheet has data rows.`);
  }
  return { leads, warnings, stats, header };
}

// ---------- header-based mapping suggestion ----------
export interface MappingSuggestion {
  mapping: SheetMapping;
  note: string;
}

/**
 * Guess a mapping from a REAL header row. Never applied silently — the sync
 * surfaces it as a suggestion and Test mapping shows it to the owner.
 */
export function detectSheetMapping(header: string[]): MappingSuggestion | null {
  const cells = header.map((c) => String(c ?? "").trim().toLowerCase());
  const COUNT_RE = /count|qty|quantity|#|volume|num(ber)?\b|leads?\s*(count|per|daily)|^leads?$/;
  const find = (re: RegExp): string | null => {
    const i = cells.findIndex((c) => c && re.test(c));
    return i === -1 ? null : String.fromCharCode(65 + i);
  };
  const dateCol = find(/date|day|received|added/);
  if (!dateCol) return null;
  const countCol = find(COUNT_RE);
  const phoneCol = find(/phone|mobile|cell/);
  const emailCol = find(/mail/);
  const nameCol = find(/name/);
  const typeCol = find(/lead.?type|type|studio|source/);
  if (countCol) {
    return {
      mapping: { mode: "row_per_day_count", columns: { source_date: dateCol, count: countCol, ...(typeCol ? { lead_type: typeCol } : {}) } },
      note: `column "${header[cells.findIndex((c) => c && COUNT_RE.test(c))]}" looks like a per-day count`,
    };
  }
  if (phoneCol || emailCol) {
    return {
      mapping: { mode: "row_per_lead", columns: { source_date: dateCol, ...(nameCol ? { name: nameCol } : {}), ...(phoneCol ? { phone: phoneCol } : {}), ...(emailCol ? { email: emailCol } : {}), ...(typeCol ? { lead_type: typeCol } : {}) } },
      note: "no count column found; phone/email columns suggest one row per lead",
    };
  }
  return null;
}
