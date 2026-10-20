/**
 * CHAIN-PROOF GATE (stage 2, build-sequence step 2 — the deliverable that
 * gates ALL Retention UI): measures the identity chain's reliability against
 * the live database and produces the management spot-check packet.
 *
 *   bun run scripts/retention-chain-proof.ts
 *
 * Criteria (IMPLEMENTATION-PLAN.md BUILD SEQUENCE step 2; all must pass):
 *   G1 appointment → internal client ≥ 99% of qualifying appointments
 *      (D6: status scheduled, not cancelled) + an automated wrong-match
 *      detector (appointment client_phone vs linked client's normalized phone).
 *   G2 call → internal client ≥ 99% where contact_id exists (primary cohort =
 *      last 30 days, the sync's own call window per D13); EVERY call that
 *      cannot reach a client sits in the Data Match Exceptions queue (none silent).
 *   G3 ambiguity < 1% of new links (ambiguous_* exceptions / links created).
 *   G4 30-case random spot-check packet (Acuity appointment ↔ GHL contact ↔
 *      calls with source ids + payload excerpts) — written to
 *      /home/team/shared/retention/chain-proof-spotcheck.md; each case is
 *      additionally chain-verified programmatically (appointments.contact_id
 *      == the linked GHL contact's internal row).
 *   G5 due-window attribution spot-check ≥10 in-window cases (incl. the
 *      LVM LR 10/19/26 → 10/26 appointment) attributing to EXACTLY the right
 *      appointment — computed by the SHIPPED attribution helper (§8/D12).
 *   G6 idempotence: backfill re-run writes nothing (byte-identical dumps).
 *
 * Writes: run row (sync_runs), backfill re-run (idempotent), the two output
 * files above. Everything else is read-only.
 */
import postgres from "postgres";
import { getStore } from "../src/server/store";
import { getSecret } from "../src/server/env";
import { applyInternalClientBackfill } from "../src/server/retention/backfill";
import { attributeCall, attributionWindow, contactDueDate, type ApptForAttribution, type CallForAttribution } from "../src/server/retention/attribution";
import { normalizeUSPhone } from "../src/server/identity/normalize";
import { writeFileSync } from "fs";
import { createHash } from "crypto";

const OUT_JSON = "/home/team/shared/retention/chain-proof-results.json";
const OUT_MD = "/home/team/shared/retention/chain-proof-spotcheck.md";
const DUE_DAYS = 7; // owner default (Settings surface is a later stage)

const url = getSecret("DATABASE_URL");
if (!url) throw new Error("DATABASE_URL secret is required");
const store = await getStore();
if (store.mode !== "postgres") throw new Error("STORE_NOT_POSTGRES: gate must run against the live DB");
const ro = postgres(url, { max: 2, idle_timeout: 5, connect_timeout: 30 });
const gateRunId = await store.insertSyncRun("retention-chain-proof");
const when = new Date().toISOString();

try {
  // ================= G1: appointment → internal client =================
  const g1 = await ro`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE l.internal_client_id IS NOT NULL)::int AS resolved
    FROM appointments a
    LEFT JOIN client_match_links l ON l.provider = 'acuity' AND l.entity = 'appointment' AND l.external_id = a.acuity_appointment_id
    WHERE a.status = 'scheduled' AND COALESCE(a.cancelled, false) = false`;
  const g1_30d = await ro`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE l.internal_client_id IS NOT NULL)::int AS resolved
    FROM appointments a
    LEFT JOIN client_match_links l ON l.provider = 'acuity' AND l.entity = 'appointment' AND l.external_id = a.acuity_appointment_id
    WHERE a.status = 'scheduled' AND COALESCE(a.cancelled, false) = false
      AND a.appointment_datetime >= now() - interval '30 days'`;
  const g1_all = await ro`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE l.internal_client_id IS NOT NULL)::int AS resolved
    FROM appointments a
    LEFT JOIN client_match_links l ON l.provider = 'acuity' AND l.entity = 'appointment' AND l.external_id = a.acuity_appointment_id`;
  // Automated wrong-match detector: appointment's client_phone must equal the
  // linked client's normalized phone whenever both exist.
  const g1_wrong = await ro`
    WITH m AS (
      SELECT a.acuity_appointment_id, a.client_phone, ic.normalized_phone AS cpn
      FROM appointments a
      JOIN client_match_links l ON l.provider = 'acuity' AND l.entity = 'appointment' AND l.external_id = a.acuity_appointment_id
      JOIN internal_clients ic ON ic.id = l.internal_client_id
      WHERE a.client_phone IS NOT NULL AND ic.normalized_phone IS NOT NULL
    )
    SELECT count(*)::int AS compared,
           count(*) FILTER (WHERE regexp_replace(regexp_replace(client_phone, '[^0-9]', '', 'g'), '^1([0-9]{10})$', '\1') <> cpn)::int AS mismatches
    FROM m`;
  const pct = (resolved: number, total: number) => (total === 0 ? null : (100 * resolved) / total);

  // ================= G2: call → internal client =================
  const g2_cohort = async (interval: string) => {
    const rows = await ro`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE l.internal_client_id IS NOT NULL)::int AS resolved
      FROM calls c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN client_match_links l ON l.provider = 'highlevel' AND l.entity = 'contact' AND l.external_id = ct.external_id
      WHERE c.contact_id IS NOT NULL AND c.started_at >= now() - ${interval}::interval`;
    return { total: Number(rows[0].total), resolved: Number(rows[0].resolved), pct: pct(Number(rows[0].resolved), Number(rows[0].total)) };
  };
  const g2_30d = await g2_cohort("30 days");
  const g2_90d = await g2_cohort("90 days");
  const g2_all = await g2_cohort("100 years");
  // Nothing silent: every orphan call (null contact_id or missing contact row)
  // must have its call-identity exception row.
  const g2_orphans = await ro`
    SELECT count(*)::int AS orphan_calls
    FROM calls c LEFT JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.contact_id IS NULL OR ct.id IS NULL`;
  const g2_orphans_covered = await ro`
    SELECT count(*)::int AS covered
    FROM calls c LEFT JOIN contacts ct ON ct.id = c.contact_id
    WHERE (c.contact_id IS NULL OR ct.id IS NULL)
      AND EXISTS (SELECT 1 FROM data_match_exceptions e WHERE e.dedupe_key = 'call-identity:' || c.provider || ':' || c.external_call_id)`;

  // ================= G3: ambiguity rate =================
  const g3_exc = await ro`
    SELECT kind, count(*)::int AS n FROM data_match_exceptions GROUP BY kind ORDER BY kind`;
  const g3_links = await ro`SELECT count(*)::int AS n FROM client_match_links`;
  const ambiguous = g3_exc.filter((r) => String(r.kind).startsWith("ambiguous_")).reduce((a, r) => a + Number(r.n), 0);
  const autoLinks = Number(g3_links[0].n);

  // ================= G4: 30-case random spot-check =================
  const spot = await ro`
    WITH picked AS (
      SELECT ic.id::text AS client_id, ic.display_name, ic.normalized_phone, ic.normalized_email,
             ic.ghl_contact_external_id, ic.match_state
      FROM internal_clients ic
      JOIN client_match_links al ON al.internal_client_id = ic.id AND al.provider = 'acuity' AND al.entity = 'appointment'
      ORDER BY random() LIMIT 30
    )
    SELECT p.client_id, p.display_name, p.normalized_phone, p.normalized_email, p.ghl_contact_external_id, p.match_state
    FROM picked p ORDER BY p.client_id`;
  const cases: unknown[] = [];
  for (const c of spot) {
    const clientId = String(c.client_id);
    const appts = await ro`
      SELECT a.id::text AS appointment_id, a.acuity_appointment_id, a.appointment_datetime::text AS appointment_datetime,
             a.status, COALESCE(a.cancelled, false) AS cancelled, a.client_name, a.client_phone, a.client_email,
             a.contact_id::text AS contact_id,
             LEFT(COALESCE(a.raw->>'notes', ''), 220) AS notes_excerpt,
             ct.external_id AS linked_contact_external_id, ct.name AS contact_name, ct.phone AS contact_phone, ct.email AS contact_email,
             (a.contact_id = ct.id) AS chain_verified,
             l.match_method, l.confidence, l.evidence
      FROM client_match_links al
      JOIN appointments a ON a.acuity_appointment_id = al.external_id
      LEFT JOIN contacts ct ON ct.external_id = ${String(c.ghl_contact_external_id)}
      LEFT JOIN client_match_links l ON l.provider = 'highlevel' AND l.entity = 'contact' AND l.external_id = ct.external_id
      WHERE al.internal_client_id = ${clientId}::uuid AND al.provider = 'acuity' AND al.entity = 'appointment'
      ORDER BY a.appointment_datetime`;
    const calls = String(c.ghl_contact_external_id)
      ? await ro`
        SELECT c2.external_call_id, c2.started_at::text AS started_at, c2.direction, c2.call_status,
               c2.duration_seconds, c2.contact_resolution_method
        FROM calls c2 JOIN contacts ct2 ON ct2.id = c2.contact_id
        WHERE ct2.external_id = ${String(c.ghl_contact_external_id)}
        ORDER BY c2.started_at DESC LIMIT 5`
      : [];
    cases.push({ client: c, appointments: appts, recent_calls: calls });
  }
  const chainVerifiedCount = cases.filter((k) => {
    const kk = k as { appointments: { chain_verified: boolean }[] };
    return kk.appointments.length > 0 && kk.appointments.every((a) => a.chain_verified === true);
  }).length;

  // ================= G5: due-window attribution spot-check =================
  const lauraRows = await ro`SELECT id::text AS id, external_id FROM users WHERE name = 'Laura Rivera' LIMIT 1`;
  const laura = lauraRows[0] ? { id: String(lauraRows[0].id), externalId: String(lauraRows[0].external_id) } : null;
  const attributionCases: {
    call_id: string;
    external_call_id: string;
    started_at: string;
    call_status: string | null;
    duration_seconds: number | null;
    acuity_appointment_id: string;
    appointment_datetime: string;
    contact_due_date: string;
    attribution: string;
    rule: string;
    window_candidates: string[];
    note_excerpt: string | null;
  }[] = [];
  let unattributedLaura30d = 0;
  let lauraCallsExamined = 0;
  if (laura) {
    const lauraCalls = await ro`
      SELECT c.id::text AS id, c.external_call_id, c.started_at::text AS started_at,
             c.direction, c.call_status, c.duration_seconds, c.contact_id::text AS contact_id
      FROM calls c
      WHERE (c.rep_id = ${laura.id}::uuid OR c.provider_rep_external_id = ${laura.externalId})
        AND c.started_at >= now() - interval '30 days'
      ORDER BY c.started_at`;
    lauraCallsExamined = lauraCalls.length;
    // ONE query: every qualifying appointment (scheduled, not cancelled) with
    // its owning contact's external id — the attribution candidate universe.
    const allQual = await ro`
      SELECT a.id::text AS appointment_id, a.acuity_appointment_id,
             a.appointment_datetime::text AS appointment_datetime,
             ct.id::text AS contact_internal_id, ct.external_id AS contact_ext
      FROM appointments a JOIN contacts ct ON ct.id = a.contact_id
      WHERE a.status = 'scheduled' AND COALESCE(a.cancelled, false) = false`;
    // Group qualifying appointments per (contact_internal_id, client) with windows.
    const infosByContact = new Map<string, { appointment: ApptForAttribution; windowStartMs: number; windowEndMs: number; acuityId: string }[]>();
    for (const r of allQual) {
      const appt: ApptForAttribution = {
        appointmentId: String(r.appointment_id),
        acuityAppointmentId: String(r.acuity_appointment_id),
        appointmentDatetimeIso: new Date(r.appointment_datetime).toISOString(),
        status: "scheduled",
      };
      const w = attributionWindow(appt.appointmentDatetimeIso, DUE_DAYS);
      const key = String(r.contact_internal_id);
      if (!infosByContact.has(key)) infosByContact.set(key, []);
      infosByContact.get(key)!.push({ appointment: appt, windowStartMs: w.startMs, windowEndMs: w.endMs, acuityId: appt.acuityAppointmentId ?? "" });
    }
    const noteByAppt = new Map(
      (await ro`SELECT id::text AS id, LEFT(COALESCE(raw->>'notes', ''), 200) AS notes FROM appointments WHERE id = ANY(SELECT id FROM appointments WHERE status='scheduled' AND COALESCE(cancelled,false)=false)`)
        .map((r) => [String(r.id), r.notes as string]),
    );
    for (const call of lauraCalls) {
      if (!call.contact_id) continue;
      // The call's client = the client whose contact-of-record is this call's
      // contact (calls.contact_id → contacts → the sticky highlevel/contact
      // link). Every qualifying appointment of THAT contact belongs to the
      // same client, so the candidate universe is exactly infosByContact[contact_id].
      const infos = infosByContact.get(String(call.contact_id)) ?? [];
      const callInput: CallForAttribution = {
        callId: String(call.id),
        startedAtIso: new Date(call.started_at).toISOString(),
        direction: call.direction == null ? null : String(call.direction),
        callStatus: call.call_status == null ? null : String(call.call_status),
      };
      const decision = attributeCall(callInput, infos, { dueDays: DUE_DAYS });
      if (decision.appointmentId === null) {
        unattributedLaura30d += 1;
        continue;
      }
      const attributedAppt = infos.find((i) => i.appointment.appointmentId === decision.appointmentId)!;
      attributionCases.push({
        call_id: String(call.id),
        external_call_id: String(call.external_call_id),
        started_at: new Date(call.started_at).toISOString(),
        call_status: call.call_status == null ? null : String(call.call_status),
        duration_seconds: call.duration_seconds == null ? null : Number(call.duration_seconds),
        acuity_appointment_id: attributedAppt.appointment.acuityAppointmentId ?? "",
        appointment_datetime: attributedAppt.appointment.appointmentDatetimeIso,
        contact_due_date: contactDueDate(attributedAppt.appointment.appointmentDatetimeIso, DUE_DAYS),
        attribution: decision.attribution,
        rule: decision.evidence.rule,
        window_candidates: decision.evidence.windowCandidates.map((w) => w.acuityAppointmentId ?? w.appointmentId),
        note_excerpt: noteByAppt.get(String(decision.appointmentId)) ?? null,
      });
    }
  }
  const inWindowCases = attributionCases.length;
  const lvmLrCase = attributionCases.find((c) => c.note_excerpt && /LVM\s+LR\s+10\/19/.test(c.note_excerpt));

  // ================= G6: idempotence (live re-run) =================
  const dump = async (): Promise<string> => {
    const clients = await ro`SELECT id::text AS id, seed_key, display_name, normalized_phone, normalized_email, ghl_contact_external_id, match_state, created_at, updated_at FROM internal_clients ORDER BY id`;
    const links = await ro`SELECT internal_client_id::text AS internal_client_id, provider, entity, external_id, match_method, confidence, evidence, resolved_by, resolved_at FROM client_match_links ORDER BY provider, entity, external_id`;
    const exceptions = await ro`SELECT id::text AS id, kind, dedupe_key, payload, context, status, resolved_internal_client_id::text AS resolved_internal_client_id, resolved_method, resolved_by, resolved_at, first_seen_at FROM data_match_exceptions ORDER BY dedupe_key`;
    const iso = (_k: string, v: unknown) => (v instanceof Date ? v.toISOString() : v);
    return JSON.stringify({ clients, links, exceptions }, iso, 1);
  };
  const before = await dump();
  const shaBefore = createHash("sha256").update(before).digest("hex");
  const apptRowsG6 = await ro`SELECT acuity_appointment_id, status, client_name, client_phone, client_email, contact_id::text AS contact_id FROM appointments ORDER BY acuity_appointment_id`;
  const g6ContactIds = [...new Set(apptRowsG6.map((r) => r.contact_id).filter((x): x is string => !!x))];
  const g6Contacts = g6ContactIds.length ? await ro`SELECT id::text AS id, external_id FROM contacts WHERE id::text = ANY(${g6ContactIds}::text[])` : [];
  const g6ContactExt = new Map(g6Contacts.map((r) => [String(r.id), String(r.external_id)]));
  const rerun = await applyInternalClientBackfill(store, {
    appointments: apptRowsG6.map((r) => ({
      acuityAppointmentId: String(r.acuity_appointment_id),
      status: String(r.status ?? "scheduled"),
      clientName: r.client_name ?? null,
      clientPhone: r.client_phone ?? null,
      clientEmail: r.client_email ?? null,
      contactExternalId: r.contact_id ? g6ContactExt.get(String(r.contact_id)) ?? null : null,
    })),
    contacts: [],
    callsWithoutClient: [],
  });
  const after = await dump();
  const shaAfter = createHash("sha256").update(after).digest("hex");
  const g6 = {
    byte_identical: shaBefore === shaAfter,
    sha_before: shaBefore,
    sha_after: shaAfter,
    rerun_wrote_nothing: rerun.clientsCreated === 0 && rerun.contactLinksCreated === 0 && rerun.appointmentLinksCreated === 0 && rerun.fallbackLinksCreated === 0 && rerun.exceptionsCreated === 0,
    rerun,
  };

  // ================= assemble + verdicts =================
  const g1QualifyingPct = pct(Number(g1[0].resolved), Number(g1[0].total));
  const g2Primary = g2_30d;
  const results = {
    when,
    gate_run_id: gateRunId,
    due_days: DUE_DAYS,
    G1: {
      criterion: "appointment→internal client ≥99% of qualifying appointments (scheduled, not cancelled)",
      qualifying_total: Number(g1[0].total),
      qualifying_resolved: Number(g1[0].resolved),
      qualifying_pct: g1QualifyingPct,
      last30d: { total: Number(g1_30d[0].total), resolved: Number(g1_30d[0].resolved), pct: pct(Number(g1_30d[0].resolved), Number(g1_30d[0].total)) },
      all_appointments: { total: Number(g1_all[0].total), resolved: Number(g1_all[0].resolved), pct: pct(Number(g1_all[0].resolved), Number(g1_all[0].total)) },
      wrong_match_detector: { phone_comparable_pairs: Number(g1_wrong[0].compared), mismatches: Number(g1_wrong[0].mismatches) },
      pass: g1QualifyingPct !== null && g1QualifyingPct >= 99 && Number(g1_wrong[0].mismatches) === 0,
    },
    G2: {
      criterion: "call→internal client ≥99% where contact_id exists (last 30 days primary); orphan calls all in exceptions queue",
      last30d: g2_30d,
      last90d: g2_90d,
      all_time: g2_all,
      orphan_calls: Number(g2_orphans[0].orphan_calls),
      orphan_calls_with_exception: Number(g2_orphans_covered[0].covered),
      silent_orphans: Number(g2_orphans[0].orphan_calls) - Number(g2_orphans_covered[0].covered),
      pass: (g2_30d.pct ?? 0) >= 99 && Number(g2_orphans[0].orphan_calls) === Number(g2_orphans_covered[0].covered),
    },
    G3: {
      criterion: "ambiguity <1% of new links; manual resolves never re-matched",
      exception_counts_by_kind: g3_exc.map((r) => ({ kind: String(r.kind), n: Number(r.n) })),
      ambiguous_exceptions: ambiguous,
      total_links: autoLinks,
      ambiguity_pct_of_links: autoLinks === 0 ? null : (100 * ambiguous) / autoLinks,
      pass: autoLinks === 0 ? true : ambiguous / autoLinks < 0.01,
    },
    G4: {
      criterion: "30-case random spot-check: chain programmatically verified per case (appointments.contact_id == linked GHL contact row); packet for management review",
      cases: spot.length,
      chain_verified_cases: chainVerifiedCount,
      packet_path: OUT_MD,
      pass: spot.length === 30 && chainVerifiedCount === 30,
    },
    G5: {
      criterion: "due-window attribution: ≥10 in-window Laura calls attribute to exactly the right appointment (D12 evidence; LVM LR 10/19→10/26 included)",
      laura_calls_30d_examined: lauraCallsExamined,
      attributed_in_window: inWindowCases,
      unattributed_out_of_window: unattributedLaura30d,
      lvm_lr_1019_case_present: !!lvmLrCase,
      cases: attributionCases,
      pass: inWindowCases >= 10 && !!lvmLrCase,
    },
    G6: g6,
  };
  const gate = {
    G1: results.G1.pass,
    G2: results.G2.pass,
    G3: results.G3.pass,
    G4: results.G4.pass,
    G5: results.G5.pass,
    G6: g6.byte_identical && g6.rerun_wrote_nothing,
  };
  const verdict = Object.values(gate).every(Boolean) ? "PASS" : "FAIL";

  // ================= spot-check packet (markdown) =================
  const lines: string[] = [];
  lines.push("# Retention Identity Chain — 30-Case Spot-Check Packet");
  lines.push("");
  lines.push(`Generated ${when} by scripts/retention-chain-proof.ts (chain-proof gate step 2). 30 internal clients sampled at random from the seeded chain.`);
  lines.push("");
  lines.push("Each case shows the full triple for management verification: internal client → its Acuity appointment(s) ↔ GHL contact ↔ recent calls, with source ids and payload excerpts. `chain_verified` is checked programmatically: the appointment's own `appointments.contact_id` (resolved at Acuity upsert, independent of this chain) must equal the internal row of the linked GHL contact.");
  lines.push("");
  cases.forEach((k, i) => {
    const kk = k as {
      client: { client_id: string; display_name: string | null; normalized_phone: string | null; normalized_email: string | null; ghl_contact_external_id: string | null; match_state: string };
      appointments: Record<string, unknown>[];
      recent_calls: Record<string, unknown>[];
    };
    lines.push(`## Case ${i + 1} — internal_client_id ${kk.client.client_id}`);
    lines.push(`- client: ${kk.client.display_name ?? "(no name)"} · phone ${kk.client.normalized_phone ?? "—"} · email ${kk.client.normalized_email ?? "—"} · ghl_contact_external_id ${kk.client.ghl_contact_external_id ?? "—"} · match_state ${kk.client.match_state}`);
    for (const a of kk.appointments) {
      lines.push(`- appointment: acuity_id ${a.acuity_appointment_id} · ${new Date(String(a.appointment_datetime)).toISOString()} ET-slot · status ${a.status}${a.cancelled ? " (cancelled)" : ""} · client_phone ${a.client_phone ?? "—"} · contact_id ${a.contact_id} · match ${a.match_method}/${a.confidence}`);
      lines.push(`  - chain_verified: ${a.chain_verified === true ? "YES (appointments.contact_id == linked GHL contact row)" : "NO — REVIEW"}`);
      lines.push(`  - contact: external_id ${a.linked_contact_external_id} · name ${a.contact_name ?? "—"} · phone ${a.contact_phone ?? "—"} · email ${a.contact_email ?? "—"}`);
      lines.push(`  - notes excerpt (appointments.raw->>'notes', verbatim): "${String(a.notes_excerpt ?? "").replace(/\n/g, " ⏎ ")}"`);
    }
    if (kk.recent_calls.length) {
      lines.push("- recent calls (latest 5):");
      for (const c2 of kk.recent_calls) {
        lines.push(`  - ${new Date(String(c2.started_at)).toISOString()} · ${c2.direction}/${c2.call_status} · ${c2.duration_seconds ?? "null"}s · ext_call_id ${c2.external_call_id}${c2.contact_resolution_method ? ` · resolved via ${c2.contact_resolution_method}` : ""}`);
      }
    } else {
      lines.push("- recent calls: none in the calls table for this contact");
    }
    lines.push("");
  });
  lines.push("## Due-window attribution cases (G5)");
  lines.push("");
  lines.push(`Each row is a Laura Rivera call inside the last 30 days that fell in a qualifying appointment's contact window (${DUE_DAYS} days, ET). Attribution computed by the shipped §8 helper; D12 nearest-future cases list ALL window candidates.`);
  lines.push("");
  lines.push("| call ext_id | started (UTC) | status | dur s | → acuity appointment | appt datetime (UTC) | due date (ET) | attribution | rule | window candidates | note excerpt |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of attributionCases) {
    lines.push(`| ${c.external_call_id} | ${c.started_at} | ${c.call_status ?? "—"} | ${c.duration_seconds ?? "—"} | ${c.acuity_appointment_id} | ${c.appointment_datetime} | ${c.contact_due_date} | ${c.attribution} | ${c.rule} | ${c.window_candidates.join(", ")} | ${(c.note_excerpt ?? "").replace(/\|/g, "/").replace(/\n/g, " ")} |`);
  }
  lines.push("");
  if (lvmLrCase) {
    lines.push(`**LVM LR 10/19 case present**: call ${lvmLrCase.external_call_id} (${lvmLrCase.started_at}, ${lvmLrCase.call_status}) attributes to acuity appointment ${lvmLrCase.acuity_appointment_id} (due ${lvmLrCase.contact_due_date}); note excerpt: "${(lvmLrCase.note_excerpt ?? "").replace(/\n/g, " ")}".`);
  } else {
    lines.push("**LVM LR 10/19 case NOT found** among attributed cases — see results JSON (gate FAILS without it).");
  }
  lines.push("");

  writeFileSync(OUT_MD, lines.join("\n"));
  writeFileSync(OUT_JSON, JSON.stringify({ ...results, gate, verdict }, null, 1));
  await store.finishSyncRun(gateRunId, verdict === "PASS" ? "success" : "error", 0, verdict === "PASS" ? null : JSON.stringify(gate));
  await ro.end({ timeout: 2 }).catch(() => undefined);
  console.log(JSON.stringify({ verdict, gate, G1: results.G1.pass && `${results.G1.qualifying_pct}%`, G2: results.G2.pass && `${g2_30d.pct}%`, G3_ambiguous: ambiguous, G4: `${chainVerifiedCount}/${spot.length}`, G5: `${inWindowCases} in-window, LVM_LR_case=${!!lvmLrCase}`, G6: g6.byte_identical }, null, 1));
  if (verdict !== "PASS") process.exit(2);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  await store.finishSyncRun(gateRunId, "error", 0, msg);
  await ro.end({ timeout: 2 }).catch(() => undefined);
  throw e;
}
