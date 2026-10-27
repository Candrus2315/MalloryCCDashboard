/**
 * PER-SOURCE BOOKING ATTRIBUTION + CONVERSION (owner directive 2026-10-27,
 * Steps 3–5). READ-ONLY derivation of "which lead source did this booking come
 * from", riding ON TOP of the frozen rep-attribution engine — this module
 * never reads or changes a rep verdict (metrics/attribution.ts s1 + the owner
 * auction rule stay untouched); rep rollups here consume verdict rows exactly
 * like compute.ts bookingsByRep does (manual overrides included, no-rep wins
 * never land in a rep row).
 *
 * THE JOIN (data-flow audit §3, read-only):
 *   appointments.contact_id → contacts.id → leads.contact_id — with a
 *   fallback through the SAME normalized identity the ingest matched on
 *   (appointments.client_phone/client_email ↔ leads.phone/email). No new
 *   matcher is introduced: these are existing stored links.
 *
 * THE SELECTION RULE (stated, deterministic — documented in the UI copy):
 *   a booking's source = the lead of the booking's contact with the NEAREST
 *   source_date to the booking's creation ET date; an exact distance tie is
 *   broken by MOST RECENTLY INGESTED (leads.created_at), then by latest
 *   source_date, then by lead id (total determinism). Candidates come from the
 *   contact's leads first; a win with NO stored contact (or no leads for it)
 *   falls back to phone-then-email identity matching — the ingest's own
 *   hierarchy; still nothing → "unattributed" (never invented).
 *
 * TWO CONVERSION METHODOLOGIES coexist by design (audit §4) — both labeled
 * wherever shown, never mixed:
 *   (a) LEAD-COHORT flavor: of the leads received from a source in the period
 *       (source_date cohort), how many ever produced a booking win created
 *       on/after the lead's own source_date (causality guard), won through
 *       today. Labeled "booked leads".
 *   (b) BOOKING-PERIOD flavor: of the wins WON in the period, which sources
 *       their leads came from — the funnel's per-source breakdown
 *       (Conv% = bookings ÷ the source's period leads).
 *
 * Pure module: no DB, no clock, no React — deterministic under tests.
 */
import type { AppointmentRow, AttributionRow, LeadRow } from "./compute";
import { createdBusinessDateOf, isBookingWin } from "./compute";
import { FORM_SOURCE_SHEETS, GENRE_SOURCE_SHEETS, LEAD_SOURCE_LABELS, type LeadSourceSheet } from "../../components/lead-sources";
import { splitLeadsByType } from "./weekly";
import type { LeadJoinRow } from "../store/types";
export type { LeadJoinRow };

/** Every source a booking can resolve to — the seven canonical sheets plus the honest buckets. */
export type SourceBucket = LeadSourceSheet | "other" | "unattributed";

/** Display order: the seven canonical sources, then the honest buckets. */
export const SOURCE_BUCKETS: readonly SourceBucket[] = [
  ...GENRE_SOURCE_SHEETS,
  ...FORM_SOURCE_SHEETS,
  "other",
  "unattributed",
] as const;

export function sourceBucketLabel(b: SourceBucket): string {
  if (b === "unattributed") return "Unattributed";
  if (b === "other") return "Other sheet";
  return LEAD_SOURCE_LABELS[b];
}

/** Map a leads.source_sheet value to its canonical bucket (unknown sheet → "other", never dropped). */
export function sourceBucketOfSheet(sourceSheet: string): SourceBucket {
  return (SOURCE_BUCKETS as readonly string[]).includes(sourceSheet) ? (sourceSheet as SourceBucket) : "other";
}

/** A win row that also carries the client identity (for the phone/email fallback). */
export type WinWithClients = AppointmentRow & { client_phone?: string | null; client_email?: string | null };

/** How far before the analyzed window candidate leads are fetched (the join's lookback). */
export const SOURCE_JOIN_LOOKBACK_DAYS = 90;

/** Total lead row (TOTAL table row) — "source" is a display marker, never a bucket. */
export interface SourceTotalRow {
  source: "total";
  label: "Total";
  leads: number;
  bookings: number;
  conv: number | null;
}

// ---------- identity helpers (same normalization the ingest matched on) ----------

/** Digits only, leading country code dropped when it leaves a 10-digit number. */
export function phone10(v: string | null | undefined): string {
  const digits = String(v ?? "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

export function emailNorm(v: string | null | undefined): string {
  return String(v ?? "").trim().toLowerCase();
}

/** Day-distance between two YYYY-MM-DD strings (unparsable → null, never guessed). */
function dayDistance(a: string, b: string): number | null {
  const ms = Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z");
  return Number.isFinite(ms) ? Math.abs(ms / 86400000) : null;
}

// ---------- lead classification (byte-identical to splitLeadsByType) ----------

/**
 * ONE lead row's source bucket — the EXACT splitLeadsByType classification:
 * the four form-workbook sheets by SHEET identity (their lead_type text is
 * never a genre vote), the genre sheets by lead_type text
 * (/animalia/i → animalia, /fairyland/i → fairyland, else family), an unknown
 * sheet → "other". Reused everywhere so per-source lead counts are
 * digit-identical to every existing genre number.
 */
export function classifyLeadSource(l: Pick<LeadRow, "lead_type" | "source_sheet">): SourceBucket {
  if (l.source_sheet === "auction_register_certificate") return "auction_register_certificate";
  if (l.source_sheet === "google_ads_leads") return "google_ads_leads";
  if (l.source_sheet === "alliance_activate_certificate") return "alliance_activate_certificate";
  if (l.source_sheet === "website_applications") return "website_applications";
  if (/animalia/i.test(l.lead_type)) return "animalia";
  if (/fairyland/i.test(l.lead_type)) return "fairyland";
  return "family"; // splitLeadsByType's exact catch-all — genre counts stay byte-identical
}

// ---------- indexes + selection rule ----------

export interface LeadSourceIndex {
  byContact: Map<string, LeadJoinRow[]>;
  byPhone: Map<string, LeadJoinRow[]>;
  byEmail: Map<string, LeadJoinRow[]>;
}

/** Index candidate leads by the three stored identities (contact id / phone10 / email). */
export function buildLeadSourceIndex(leads: LeadJoinRow[]): LeadSourceIndex {
  const byContact = new Map<string, LeadJoinRow[]>();
  const byPhone = new Map<string, LeadJoinRow[]>();
  const byEmail = new Map<string, LeadJoinRow[]>();
  for (const l of leads) {
    if (l.contact_id) {
      const arr = byContact.get(l.contact_id);
      if (arr) arr.push(l);
      else byContact.set(l.contact_id, [l]);
    }
    const p = phone10(l.phone);
    if (p) {
      const arr = byPhone.get(p);
      if (arr) arr.push(l);
      else byPhone.set(p, [l]);
    }
    const e = emailNorm(l.email);
    if (e) {
      const arr = byEmail.get(e);
      if (arr) arr.push(l);
      else byEmail.set(e, [l]);
    }
  }
  return { byContact, byPhone, byEmail };
}

/**
 * THE SELECTION RULE over one booking's candidate leads (docblock above).
 * Nearest source_date to the anchor (booking creation ET date) wins; exact
 * ties break by most recently ingested → latest source_date → lead id.
 */
export function nearestLeadForBooking(anchorDate: string | null, candidates: LeadJoinRow[]): LeadJoinRow | null {
  if (!anchorDate || candidates.length === 0) return null;
  let best: LeadJoinRow | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const dist = dayDistance(c.source_date, anchorDate);
    if (dist == null) continue; // unparsable sheet date — never guessed
    const newer =
      best == null ||
      dist < bestDist ||
      (dist === bestDist && (c.created_at ?? "") > (best.created_at ?? "")) ||
      (dist === bestDist && (c.created_at ?? "") === (best.created_at ?? "") && c.source_date > best.source_date) ||
      (dist === bestDist && (c.created_at ?? "") === (best.created_at ?? "") && c.source_date === best.source_date && c.id < best.id);
    if (newer) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Resolve EVERY win's source in one pass. Contact-lead candidates first; when
 * the win has no stored contact (or that contact has no leads) the ingest's
 * phone-then-email identity fallback runs against the lead index. Returns the
 * per-win bucket + matched lead id (null = unattributed).
 */
export function resolveBookingSources(
  wins: WinWithClients[],
  leads: LeadJoinRow[],
): Map<string, { source: SourceBucket; leadId: string | null }> {
  const index = buildLeadSourceIndex(leads);
  const out = new Map<string, { source: SourceBucket; leadId: string | null }>();
  for (const w of wins) {
    const anchor = createdBusinessDateOf(w);
    let lead: LeadJoinRow | null = null;
    if (w.contact_id) lead = nearestLeadForBooking(anchor, index.byContact.get(w.contact_id) ?? []);
    if (!lead) {
      const p = phone10(w.client_phone);
      if (p) lead = nearestLeadForBooking(anchor, index.byPhone.get(p) ?? []);
    }
    if (!lead) {
      const e = emailNorm(w.client_email);
      if (e) lead = nearestLeadForBooking(anchor, index.byEmail.get(e) ?? []);
    }
    out.set(w.id, lead ? { source: classifyLeadSource(lead), leadId: lead.id } : { source: "unattributed", leadId: null });
  }
  return out;
}

// ---------- per-source conversion table (booking-period flavor) ----------

export interface SourcePerformanceRow {
  source: SourceBucket | "total";
  label: string;
  /** Leads of the period from this source (the caller's source_date cohort — splitLeadsByType's exact classification). */
  leads: number;
  /** Wins of the period resolved to this source. */
  bookings: number;
  /** bookings ÷ leads; null when the source had no leads (rendered "—", never a fabricated 0%). */
  conv: number | null;
}

export interface SourcePerformanceTable {
  /** The seven canonical sources in display order; "other" only when non-zero; Unattributed; TOTAL last. */
  rows: SourcePerformanceRow[];
  totalLeads: number;
  totalBookings: number;
  totalConv: number | null;
  /** Wins with no lead link INSIDE the cohort — the honest Unattributed row's bookings count. */
  unattributedBookings: number;
}

/** Conversion rate — null when the denominator is 0 (rendered "—", never 0%). */
export function sourceConversion(bookings: number, leads: number): number | null {
  return leads > 0 ? bookings / leads : null;
}

/**
 * The per-source table for one period. `cohortLeads` is the period's lead
 * cohort (the source_date slice); per-source lead counts go through
 * classifyLeadSource so the genre numbers are BYTE-IDENTICAL to every
 * existing surface. `byWinSource` is resolveBookingSources' output over the
 * period's in-scope wins.
 *
 * COHORT SCOPING (strict): a win is credited to the source of its matched
 * lead ONLY when that lead id is IN `cohortLeads` — the table counts nothing
 * outside what the caller passed. A win whose matched lead falls outside the
 * cohort (or with no match at all) lands honestly in Unattributed.
 */
export function buildSourcePerformanceTable(
  cohortLeads: LeadRow[],
  wins: WinWithClients[],
  byWinSource: Map<string, { source: SourceBucket; leadId: string | null }>,
): SourcePerformanceTable {
  // Per-source lead counts through splitLeadsByType — the ONE classification
  // every existing genre number uses (form rows by sheet identity, genre rows
  // by lead_type text, family catch-all) — so this table's Leads column is
  // BYTE-IDENTICAL to the Lead Composition panel above it. "other" is the
  // residue (rows on a sheet none of the seven — never seen in practice).
  const split = splitLeadsByType(cohortLeads);
  const leadCountByBucket = new Map<SourceBucket, number>();
  leadCountByBucket.set("family", split.family);
  leadCountByBucket.set("animalia", split.animalia);
  leadCountByBucket.set("fairyland", split.fairyland);
  leadCountByBucket.set("auction_register_certificate", split.auction_register_certificate);
  leadCountByBucket.set("google_ads_leads", split.google_ads_leads);
  leadCountByBucket.set("alliance_activate_certificate", split.alliance_activate_certificate);
  leadCountByBucket.set("website_applications", split.website_applications);
  const knownSum = split.family + split.animalia + split.fairyland + split.auction_register_certificate + split.google_ads_leads + split.alliance_activate_certificate + split.website_applications;
  if (cohortLeads.length - knownSum > 0) leadCountByBucket.set("other", cohortLeads.length - knownSum);

  const bookingsByBucket = new Map<SourceBucket, number>();
  let unattributedBookings = 0;
  // STRICT COHORT SCOPING: credit a win to its resolved source only when the
  // resolved lead is inside THIS cohort — the caller's cohort and wins are the
  // only inputs, and a booking can never be attributed to a lead the table
  // does not count (it stays honestly Unattributed here).
  const cohortLeadIds = new Set(cohortLeads.map((l) => l.id));
  for (const w of wins) {
    const resolved = byWinSource.get(w.id);
    const b: SourceBucket =
      resolved && resolved.leadId !== null && cohortLeadIds.has(resolved.leadId) ? resolved.source : "unattributed";
    if (b === "unattributed") unattributedBookings += 1;
    bookingsByBucket.set(b, (bookingsByBucket.get(b) ?? 0) + 1);
  }

  const rows: SourcePerformanceRow[] = [];
  for (const b of SOURCE_BUCKETS) {
    if (b === "other" && !leadCountByBucket.has("other") && !bookingsByBucket.has("other")) continue;
    const leads = b === "unattributed" ? 0 : leadCountByBucket.get(b) ?? 0;
    const bookings = bookingsByBucket.get(b) ?? 0;
    rows.push({
      source: b,
      label: sourceBucketLabel(b),
      leads,
      bookings,
      conv: b === "unattributed" ? null : sourceConversion(bookings, leads),
    });
  }
  const totalLeads = cohortLeads.length;
  const totalBookings = wins.length;
  rows.push({ source: "total", label: "Total", leads: totalLeads, bookings: totalBookings, conv: sourceConversion(totalBookings, totalLeads) });
  return { rows, totalLeads, totalBookings, totalConv: sourceConversion(totalBookings, totalLeads), unattributedBookings };
}

/**
 * Best/worst conversion among the table's real source rows (Total and
 * Unattributed never qualify). BEST = highest conv among sources with ≥1 lead
 * AND ≥1 booking (a 0% source is never "best"). WORST = lowest conv among
 * sources with ≥1 lead — a defined 0.0% IS the worst (honest: leads came in,
 * none booked); sources with NO leads (conv "—", null) never qualify on
 * either end. Ties resolve deterministically to the FIRST row in table order.
 * Accepts the buildSourcePerformanceTable result or a bare rows array.
 * Returns nulls when nothing qualifies.
 */
export function bestWorstSourceLines(
  tableOrRows: SourcePerformanceTable | SourcePerformanceRow[],
): { best: string | null; worst: string | null } {
  const rows = Array.isArray(tableOrRows) ? tableOrRows : tableOrRows.rows;
  const pctLabel = (r: SourcePerformanceRow): string => `${r.label} (${((r.conv ?? 0) * 100).toFixed(1)}%)`;
  const realSource = (r: SourcePerformanceRow) => r.source !== "total" && r.source !== "unattributed";
  const qualifying = rows.filter((r) => realSource(r) && r.leads > 0 && r.bookings > 0);
  const withLeads = rows.filter((r) => realSource(r) && r.leads > 0);
  // reduce keeps the FIRST extreme on ties → deterministic with fixed row order.
  const best = qualifying.length ? qualifying.reduce((a, b) => ((b.conv ?? 0) > (a.conv ?? 0) ? b : a)) : null;
  const worst = withLeads.length ? withLeads.reduce((a, b) => ((b.conv ?? 0) < (a.conv ?? 0) ? b : a)) : null;
  return { best: best ? pctLabel(best) : null, worst: worst ? pctLabel(worst) : null };
}

// ---------- rep rollup (bookingsByRep semantics — verdict rep only) ----------

/**
 * Per-rep per-source BOOKINGS: wins counted for a rep ONLY through their
 * attribution verdict (booking_attributions.rep_id — manual overrides are rep
 * bookings; verdict-less/no-rep wins never land in a rep row, the rev-13
 * rule). The SOURCE of each win is this module's selection rule. NEVER a raw
 * sheet-row count (owner rule: sheet leads' assigned_rep_id comes from
 * contact matching and proves nothing about who booked).
 */
export function rollupRepSourceBookings(
  wins: WinWithClients[],
  attributions: AttributionRow[],
  byWinSource: Map<string, { source: SourceBucket; leadId: string | null }>,
): Map<string, Map<SourceBucket, number>> {
  const byAppt = new Map(attributions.map((a) => [a.appointment_id, a]));
  const out = new Map<string, Map<SourceBucket, number>>();
  for (const w of wins) {
    if (!isBookingWin(w)) continue;
    const repId = byAppt.get(w.id)?.rep_id;
    if (!repId) continue;
    const source = byWinSource.get(w.id)?.source ?? "unattributed";
    let m = out.get(repId);
    if (!m) {
      m = new Map();
      out.set(repId, m);
    }
    m.set(source, (m.get(source) ?? 0) + 1);
  }
  return out;
}

// ---------- lead-cohort flavor (a): booked leads through today ----------

export interface LeadCohortSourceRow {
  source: SourceBucket | "total";
  label: string;
  /** Leads of the cohort from this source (classifyLeadSource — splitLeadsByType-identical). */
  leads: number;
  /** Of those, how many produced ≥1 qualifying win. */
  bookedLeads: number;
  /** bookedLeads ÷ leads; null when the source had no cohort leads. */
  conv: number | null;
}

/**
 * LEAD-COHORT CONVERSION (flavor a). A lead "produced" a win when the win's
 * CREATION ET date is on/after the lead's own source_date (causality: the
 * lead preceded the booking) among `winsThroughToday` — the wins won from the
 * cohort window's start through today. Identity joins contact_id first, then
 * phone10, then email (the ingest hierarchy). A contact holding several
 * cohort leads credits each of them (cross-source duplication is NOT deduped
 * — existing totals stay digit-identical; the overlap note quantifies it).
 */
export function computeLeadCohortOutcomes(
  cohortLeadJoinRows: LeadJoinRow[],
  winsThroughToday: WinWithClients[],
): LeadCohortSourceRow[] {
  // identity → set of win CREATION dates (ET) for wins through today
  const winDatesByIdentity = new Map<string, string[]>();
  const pushWin = (key: string, created: string) => {
    const arr = winDatesByIdentity.get(key);
    if (arr) arr.push(created);
    else winDatesByIdentity.set(key, [created]);
  };
  for (const w of winsThroughToday) {
    if (!isBookingWin(w)) continue;
    const created = createdBusinessDateOf(w);
    if (!created) continue;
    if (w.contact_id) pushWin("c:" + w.contact_id, created);
    const p = phone10(w.client_phone);
    if (p) pushWin("p:" + p, created);
    const e = emailNorm(w.client_email);
    if (e) pushWin("e:" + e, created);
  }
  const producedLead = (l: LeadJoinRow): boolean => {
    const identities: string[] = [];
    if (l.contact_id) identities.push("c:" + l.contact_id);
    const p = phone10(l.phone);
    if (p) identities.push("p:" + p);
    const e = emailNorm(l.email);
    if (e) identities.push("e:" + e);
    for (const key of identities) {
      for (const created of winDatesByIdentity.get(key) ?? []) {
        if (created >= l.source_date) return true; // causality guard
      }
    }
    return false;
  };

  const countsByBucket = new Map<SourceBucket, { leads: number; booked: number }>();
  for (const l of cohortLeadJoinRows) {
    const b = classifyLeadSource(l);
    let cur = countsByBucket.get(b);
    if (!cur) {
      cur = { leads: 0, booked: 0 };
      countsByBucket.set(b, cur);
    }
    cur.leads += 1;
    if (producedLead(l)) cur.booked += 1;
  }
  const rows: LeadCohortSourceRow[] = [];
  for (const b of SOURCE_BUCKETS) {
    if (b === "other" && !countsByBucket.has("other")) continue;
    const cur = countsByBucket.get(b);
    if (!cur) continue;
    rows.push({
      source: b,
      label: sourceBucketLabel(b),
      leads: cur.leads,
      bookedLeads: cur.booked,
      conv: sourceConversion(cur.booked, cur.leads),
    });
  }
  const totalLeads = cohortLeadJoinRows.length;
  const totalBooked = rows.reduce((s, r) => s + r.bookedLeads, 0);
  rows.push({ source: "total", label: "Total", leads: totalLeads, bookedLeads: totalBooked, conv: sourceConversion(totalBooked, totalLeads) });
  return rows;
}

// ---------- cross-source duplicate magnitude (report-only data note) ----------

export interface CrossSourceOverlap {
  /** Distinct people (phone10, else email) appearing as leads from 2+ sources. */
  people: number;
  /** Distinct source pairs observed across those people. */
  pairs: number;
  /** Human note (window-labeled) for the copied report. */
  note: string;
}

/**
 * OVERLAP MAGNITUDE (report-only, never a dedupe): how many people appear as
 * leads from 2+ sources within the fetched join window. People key on
 * normalized phone first, else email (a row with neither is unkeyable and
 * never counted). Sources are counted independently everywhere — this number
 * exists so the owner knows the overlap size without changing any total.
 */
export function crossSourceOverlap(leads: LeadJoinRow[], windowDays: number): CrossSourceOverlap {
  const groups = new Map<string, Set<string>>();
  for (const l of leads) {
    const p = phone10(l.phone);
    const e = emailNorm(l.email);
    const key = p ? "p:" + p : e ? "e:" + e : null;
    if (!key) continue;
    let s = groups.get(key);
    if (!s) {
      s = new Set();
      groups.set(key, s);
    }
    s.add(classifyLeadSource(l));
  }
  let people = 0;
  const pairSet = new Set<string>();
  for (const sources of groups.values()) {
    if (sources.size < 2) continue;
    people += 1;
    const arr = [...sources].sort();
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) pairSet.add(`${arr[i]}+${arr[j]}`);
    }
  }
  return {
    people,
    pairs: pairSet.size,
    note:
      people > 0
        ? `Note: ${people} ${people === 1 ? "person appears as a lead" : "people appear as leads"} from 2+ sources in the last ${windowDays} days — each source counts its own sheet rows independently (no cross-source dedupe).`
        : `Note: no person appears as a lead from 2+ sources in the last ${windowDays} days (no cross-source overlap in the window).`,
  };
}
