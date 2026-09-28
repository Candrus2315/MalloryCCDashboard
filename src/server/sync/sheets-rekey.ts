/**
 * SHEETS LEAD RE-KEY MIGRATION (owner directive 2026-09-28).
 *
 * One-time, idempotent pass that re-keys every stored google_sheets lead from
 * its legacy v1 source_id (spreadsheet-id-prefixed, row/ordinal-derived) to
 * the v2 CONTENT key (sheetLeadKey in sheets-mapping.ts). Old row-keyed rows
 * must not linger (they would double-count against their v2 twins on the next
 * sync), so the migration is:
 *
 *   1. read all stored google_sheets leads;
 *   2. group by computed v2 base key, order each group by stored row id
 *      (first-seen = ingest order, deterministic and stable across runs);
 *   3. each member's expected v2 id = base key (+ `#2`, `#3`, … for group
 *      members beyond the first — full-identity collisions keep both leads);
 *   4. a lead already carrying its expected id is left untouched (the
 *      idempotency exit — running twice is a no-op);
 *   5. otherwise the row is upserted under the expected id (content
 *      preserved; work_date recomputed from source_date — a stale work_date
 *      from older logic is fixed and counted) and the legacy-id row deleted.
 *
 * Demo rows (`demo-*` source_ids, only ever present on a demo-mode database)
 * are left alone — they are transient by design and purged on the first live
 * sync.
 *
 * Called automatically by runSheetsSync before every live upsert (cheap
 * existence check, so the production DB self-heals on the first sync after
 * this ships) and exported for a deliberate manual production run.
 */
import { getWorkDate } from "../date-logic";
import type { Store } from "../store/types";
import { isLegacySheetsSourceId, sheetLeadKey } from "./sheets-mapping";

export interface SheetsRekeyResult {
  /** Stored leads examined. */
  scanned: number;
  /** Rows moved from a legacy id to their v2 content id. */
  rekeyed: number;
  /** Re-keyed rows whose stored work_date disagreed with getWorkDate(source_date). */
  workDateFixed: number;
  /** Full-identity collision groups that got `#N` ordinal suffixes. */
  collisions: number;
}

export async function migrateSheetsLeadKeys(store: Store): Promise<SheetsRekeyResult> {
  const all = await store.getLeadsByProvider("google_sheets");
  const res: SheetsRekeyResult = { scanned: all.length, rekeyed: 0, workDateFixed: 0, collisions: 0 };
  if (all.length === 0) return res;

  // Migration candidates: legacy-keyed, non-demo rows.
  const candidates = all.filter((l) => l.provider === "google_sheets" && isLegacySheetsSourceId(l.source_id) && !l.source_id.startsWith("demo-"));
  if (candidates.length === 0) return res;

  // Group by v2 base key; ordinal assignment follows stored id order
  // (numeric-aware: ids may be "12"-style or prefixed) — stable across runs.
  const byKey = new Map<string, typeof candidates>();
  for (const l of candidates) {
    const base = sheetLeadKey(l.source_sheet, l.source_date, l.phone ?? null, l.email ?? null);
    const arr = byKey.get(base) ?? [];
    arr.push(l);
    byKey.set(base, arr);
  }

  const idNum = (id: string): number => {
    const m = /\d+$/.exec(id);
    return m ? Number(m[0]) : Number.MAX_SAFE_INTEGER;
  };

  for (const [base, group] of byKey) {
    group.sort((a, b) => (idNum(a.id) - idNum(b.id)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let i = 0; i < group.length; i++) {
      const lead = group[i]!;
      const expected = i === 0 ? base : `${base}#${i + 1}`;
      if (i > 0) res.collisions++;
      if (lead.source_id === expected) continue; // already v2 — idempotent no-op

      const workDate = getWorkDate(lead.source_date);
      if (workDate !== lead.work_date) res.workDateFixed++;
      await store.upsertLeads([{
        provider: "google_sheets",
        source_id: expected,
        lead_type: lead.lead_type,
        source_date: lead.source_date,
        work_date: workDate,
        name: lead.name ?? null,
        phone: lead.phone ?? null,
        email: lead.email ?? null,
        contact_id: lead.contact_id,
        assigned_rep_id: lead.assigned_rep_id,
        source_sheet: lead.source_sheet,
      }]);
      await store.deleteLeadsBySourceIds("google_sheets", [lead.source_id]);
      res.rekeyed++;
    }
  }
  return res;
}
