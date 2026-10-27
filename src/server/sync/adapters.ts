/**
 * Provider adapters — clean interfaces for the three real integrations plus
 * demo implementations backed by the demo generator. When real credentials
 * arrive, implement HighLevelApiAdapter / AcuityApiAdapter / SheetsApiAdapter
 * (same interfaces, real HTTP) and flip `isDemo` — the sync runner below
 * doesn't change.
 *
 * In THIS phase no live provider API calls are made: adapters are wired to the
 * seeded demo dataset and integration_connections rows are flagged demo.
 */
import { demoAttributions, generateDemoBatch, type DemoBatch } from "../demo/generate";
// Sheet mapping + parsing primitives live in ./sheets-mapping (pure, shared
// with the live adapter and tests); re-exported here so existing import
// sites (Settings test-mapping, tests) keep one import path.
import type { NormalizedLead } from "./sheets-mapping";
import { SHEET_MAPPING_FIELDS } from "./sheets-mapping";
export { SHEET_MAPPING_FIELDS, columnLetterToIndex, applySheetMapping, parseSheetDate, isSheetMappingMode, SHEET_MAPPING_MODES, SHEET_MODE_LABELS, detectSheetMapping } from "./sheets-mapping";
export type { NormalizedLead, SheetMappingMode, SheetMapping, SheetRowParseResult, SheetParseStats, ParsedSheetResult, MappingSuggestion } from "./sheets-mapping";
export type SheetMappingField = (typeof SHEET_MAPPING_FIELDS)[number];

export interface NormalizedUser {
  external_id: string;
  name: string;
  email: string | null;
}
export interface NormalizedContact {
  external_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  assignedRepExternalId: string | null;
}
export interface NormalizedCall {
  external_call_id: string;
  repExternalId: string;
  contactExternalId: string;
  startedAt: string;
  durationSeconds: number;
  direction: string;
  status: string;
  /** HighLevel conversation the call message came from (set by the message visitor). */
  conversation_id?: string | null;
}
export interface NormalizedAppointment {
  acuity_appointment_id: string;
  calendarId: string;
  calendarName: string;
  appointmentType: string;
  appointmentDatetime: string;
  createdAt: string;
  /** S7c: ET business date the booking was made on (authoritative anchor). */
  createdAtBusinessDate?: string | null;
  /** S7c: original source string (datetimeCreated / dateCreated) for forensics. */
  createdTimeSource?: string | null;
  /** S7c: full | date_only | session_fallback. */
  createdTimePrecision?: string;
  /** S7c: FULL provider row as received (stored to appointments.raw). */
  raw?: Record<string, unknown> | null;
  status: string;
  cancelled: boolean;
  clientName: string;
  clientPhone: string;
  clientEmail: string;
  durationMinutes: number;
}
export interface NormalizedBlockedTime {
  external_id: string;
  startAt: string;
  endAt: string;
  reason: string;
}

export interface HighLevelAdapter {
  provider: "highlevel";
  isDemo: boolean;
  fetchUsers(): Promise<NormalizedUser[]>;
  fetchContacts(): Promise<NormalizedContact[]>;
  fetchCalls(): Promise<NormalizedCall[]>;
}
export interface AcuityAdapter {
  provider: "acuity";
  isDemo: boolean;
  fetchAppointments(): Promise<NormalizedAppointment[]>;
  fetchBlockedTimes(): Promise<NormalizedBlockedTime[]>;
}
export interface GoogleSheetsAdapter {
  provider: "google_sheets";
  isDemo: boolean;
  fetchLeads(): Promise<NormalizedLead[]>;
}

/**
 * Demo raw rows as the Google Sheets API would return them (header + one data
 * row per sheet). Used by the Settings "test mapping" action to demonstrate
 * the mapping → parse pipeline on realistic data. The four form-workbook
 * sources (10/27) return rows shaped like their REAL verified headers so the
 * demo fallback teaches the same mapping the live tab needs.
 */
export function sampleSheetRow(sheet: string): { header: string[]; rows: string[][] } {
  if (sheet === "family") {
    return {
      header: ["Date", "Name", "Phone", "Email", "Lead Type"],
      rows: [["2026-09-24", "Emma Carter", "+19175550142", "emma.carter@example.com", "family"]],
    };
  }
  if (sheet === "fairyland") {
    return {
      header: ["Date", "Name", "Phone", "Email", "Lead Type"],
      rows: [["2026-09-24", "Ava Bell", "+19175550177", "ava.bell@example.com", "fairyland"]],
    };
  }
  if (sheet === "auction_register_certificate" || sheet === "alliance_activate_certificate") {
    return {
      header: ["First Name", "Last Name", "Phone", "Street Address", "City", "Postal Code", "State", "Email", "Certificate Number", "Address", "Timezone", "Submission Date", "URL"],
      rows: [["Sam", "River", "(555) 201-8842", "1 Demo Way", "Springfield", "1105", "MA", "sam.river@example.com", "02-DEMO-0826", "1 Demo Way, Springfield", "EST", "Feb 1st 2026, 4:14 pm", "https://www.malloryportraits.c"]],
    };
  }
  if (sheet === "google_ads_leads") {
    return {
      header: ["First Name", "Last Name", "Email", "Phone", "Date Entered", "Project Name", "Source"],
      rows: [["Alex", "Doe", "alex.doe@example.com", "(555) 313-7788", "10/7/2026", "Family", "Lead Intake Form"]],
    };
  }
  if (sheet === "website_applications") {
    return {
      header: ["Full Name", "Phone", "Email", "Why do you want a portrait session?", "Who would be in the portrait?", "How did you find us?", "I agree…", "Timezone", "Submission Date", "URL"],
      rows: [["Robin Fox", "15552014444", "robin.fox@example.com", "Demo reason", "My dog", "Facebook", "I agree", "America/New_York (GMT-05:00)", "Jan 31st 2026, 10:50 am", "https://www.malloryportraits.c"]],
    };
  }
  return {
    header: ["Date", "Name", "Phone", "Email", "Lead Type"],
    rows: [["2026-09-24", "Liam Nguyen", "+19175550188", "liam.nguyen@example.com", "animalia"]],
  };
}

// ---------- demo adapters (Phase 1) ----------

export class DemoHighLevelAdapter implements HighLevelAdapter {
  provider = "highlevel" as const;
  isDemo = true;
  constructor(private batch: DemoBatch) {}
  async fetchUsers() {
    return this.batch.users.map((u) => ({ external_id: u.external_id, name: u.name, email: null }));
  }
  async fetchContacts() {
    return this.batch.contacts.map((c) => ({
      external_id: c.external_id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      assignedRepExternalId: c.repExternalId,
    }));
  }
  async fetchCalls() {
    return this.batch.calls.map((c) => ({
      external_call_id: c.external_call_id,
      repExternalId: c.repExternalId,
      contactExternalId: c.contactExternalId,
      startedAt: c.startedAt,
      durationSeconds: c.durationSeconds,
      direction: c.direction,
      status: c.status,
    }));
  }
}

export class DemoAcuityAdapter implements AcuityAdapter {
  provider = "acuity" as const;
  isDemo = true;
  constructor(private batch: DemoBatch) {}
  async fetchAppointments() {
    return this.batch.appointments;
  }
  async fetchBlockedTimes() {
    return this.batch.blockedTimes;
  }
}

export class DemoSheetsAdapter implements GoogleSheetsAdapter {
  provider = "google_sheets" as const;
  isDemo = true;
  constructor(private batch: DemoBatch) {}
  async fetchLeads() {
    return this.batch.leads;
  }
}

// ---------- live adapter stubs (Phase 2+, credentials pending) ----------

export class LiveHighLevelAdapter implements HighLevelAdapter {
  provider = "highlevel" as const;
  isDemo = false;
  constructor(private apiKey: string) {
    if (!apiKey) throw new Error("HighLevel API key missing");
  }
  async fetchUsers(): Promise<NormalizedUser[]> {
    throw new Error("HighLevel live adapter not implemented until credentials arrive (Phase 2)");
  }
  async fetchContacts(): Promise<NormalizedContact[]> {
    throw new Error("HighLevel live adapter not implemented until credentials arrive (Phase 2)");
  }
  async fetchCalls(): Promise<NormalizedCall[]> {
    throw new Error("HighLevel live adapter not implemented until credentials arrive (Phase 2)");
  }
}

export function createDemoAdapters(settings: { thresholdSeconds: number; windowHours: number }) {
  const batch = generateDemoBatch();
  return {
    batch,
    highlevel: new DemoHighLevelAdapter(batch),
    acuity: new DemoAcuityAdapter(batch),
    sheets: new DemoSheetsAdapter(batch),
    attributionMap: demoAttributions(batch, settings.thresholdSeconds, settings.windowHours),
  };
}

/**
 * Catalog of selectable Acuity calendars + appointment types (Settings →
 * Acuity scope). Demo-backed until Acuity credentials arrive; the same shape
 * will come from the live adapter's catalog endpoint.
 */
export function acuityCatalog(): { calendars: { id: string; name: string }[]; types: string[]; isDemo: boolean } {
  const batch = generateDemoBatch();
  const calendars = [...new Map(batch.appointments.map((a) => [a.calendarId, a.calendarName])).entries()].map(([id, name]) => ({
    id,
    name,
  }));
  const types = [...new Set(batch.appointments.map((a) => a.appointmentType))];
  return { calendars, types, isDemo: true };
}
