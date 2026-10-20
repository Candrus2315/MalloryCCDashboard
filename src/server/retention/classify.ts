/**
 * RETENTION SUCCESSFUL-CONTACT CLASSIFICATION ENGINE (stage 3a — build
 * sequence step 3; IMPLEMENTATION-PLAN.md §9 + §10; owner rulings D1–D14
 * APPROVED 2026-10-19).
 *
 * PURE functions — no store, no clock, no I/O. The computation job
 * (retention/compute.ts) feeds it stored rows and writes the results; the
 * same invocation is therefore recomputable any time, idempotently.
 *
 * The ratified matrix (§9, real CLOSED status vocabulary measured in probes
 * 1–2: completed/no-answer/voicemail/busy/failed/ringing across `calls` AND
 * `harvest_calls`, stable across time — unknown future values → Needs
 * Review, never guessed):
 *
 *   completed + duration > 0 → answered            → Verified Spoke With
 *     (status primary; duration CORROBORATES — never a sole rule)
 *   completed + duration = 0 → answered_uncorroborated → Attempted —
 *     Outcome Unclear [D2: can't distinguish brief connect from hangup;
 *     owner floor revisit after 2 weeks live]
 *   voicemail               → voicemail            → Voicemail
 *     (status primary — duration never flips it, cf. the 47s voicemail)
 *   no-answer               → no_answer            → No Answer
 *   busy                    → no_answer            → No Answer
 *   failed                  → non_contact          → attempt only, NO
 *     contact evidence [D11: a dial happened; evidence none]
 *   ringing                 → transient            → Attempted — Outcome
 *     Unclear; re-evaluated idempotently on later passes (the row may
 *     update to a terminal status when the call record does)
 *   anything else / null    → unknown              → Needs Review
 *
 * Note-evidence overlay (§10 — read-only; NEVER overrides status; resolves
 * or escalates):
 *   SWC note + answered-class call in window  → consistent (corroboration)
 *   SWC note + NO answered-class call        → Needs Review [D5: notes
 *     corroborate, never replace the call log]
 *   LVM note + voicemail call                → consistent
 *   LVM note + NO voicemail call             → Needs Review (NOT "No
 *     Answer" — that would understate her work; the call log may simply
 *     miss a personal-phone dial)
 *   reschedul / cancel / confirm tokens       → cancellation-workflow
 *     evidence (stage 3b), NOT attempt classes
 *   `SWC + initials` identifies the DOCUMENTER (Settings map, next stage)
 *     and must NOT imply success by itself — only the corroboration/
 *     conflict logic above touches the final status.
 *
 * Aggregation to the appointment's final status (§9, evaluated after the
 * Settings caps — caps live in Settings/scorecard land, not here):
 *   1. Needs Review if ANY signal conflict (overlay above) or unknown status
 *   2. else Verified Spoke With if ANY attempt answered with duration > 0
 *   3. else Voicemail if ANY attempt voicemail-class
 *   4. else No Answer if ALL attempts are no-answer-class
 *   5. else Attempted — Outcome Unclear (uncorroborated/transient only,
 *      or zero attempts — see ZERO_ATTEMPTS_STATUS below)
 *
 * D8: inbound calls are NEVER attempts. They are tracked (the compute job
 * records in-window inbound calls in the outcome evidence) but carry no
 * attempt class and never contribute contact evidence.
 *
 * Transcript tier: the stage-1 probe verdict (§4) is that NO transcripts
 * exist in the GHL payload we receive — so every evidence snapshot records
 * `transcript_available: null` (honest unknown/absent) plus the fixed probe
 * basis string. If the owner ever enables GHL voicemail transcription
 * [D3], only parseHlCall + this module's transcript consumption change.
 */

/** §9 attempt classes (CLOSED — every observed status maps; unknown maps too). */
export type AttemptClass =
  | "answered"
  | "answered_uncorroborated"
  | "voicemail"
  | "no_answer"
  | "non_contact"
  | "transient"
  | "unknown";

/** §9 five-outcome final scale per appointment. */
export type FinalContactStatus =
  | "verified_spoke_with"
  | "voicemail"
  | "no_answer"
  | "attempted_unclear"
  | "needs_review";

/**
 * Zero-attempt appointments: the §9 five-outcome scale has no "no attempt"
 * value, and §16's Still-Unreached formula counts zero-attempt clients via
 * final_status ∈ {no_answer, attempted_unclear}. Honest choice:
 * attempted_unclear (a claim that a dial happened would be false; "no
 * answer" would be worse) with evidence.basis="no_outbound_attempts_in_window"
 * — the drill-down shows attempts=0 verbatim. Flagged to the owner in the
 * stage-3a report as an interpretation (no new status value invented without
 * an owner ruling).
 */
export const ZERO_ATTEMPTS_FINAL_STATUS: FinalContactStatus = "attempted_unclear";

/** Probe §4: the messages payload carries no transcripts (basis string stored verbatim in evidence). */
export const TRANSCRIPT_AVAILABILITY_BASIS =
  "stage-1 probe 2026-10-19: no transcripts/recording URLs in the /conversations/{id}/messages payload; transcript tier inactive until [D3] account-side enablement";

/** Classified single attempt: the matrix row + the evidence snapshot fields. */
export interface AttemptClassification {
  attemptClass: AttemptClass;
  /** §9 matrix row that fired (stable id for audit + tests). */
  rule:
    | "completed_with_duration"
    | "completed_zero_duration"
    | "voicemail_status"
    | "no_answer_status"
    | "busy_status"
    | "failed_status"
    | "ringing_status"
    | "unknown_status";
  /** Fixed transcript availability for THIS attempt (null = probe-verified absent — never a guessed false). */
  transcriptAvailable: null;
  evidence: AttemptEvidenceSnapshot;
}

/** Per-attempt evidence (audit per owner spec §17: why counted that way). */
export interface AttemptEvidenceSnapshot {
  rule: AttemptClassification["rule"];
  call_status_raw: string | null;
  /** GHL duration as RECEIVED (0 when GHL null — the honest raw value). */
  duration_seconds: number | null;
  direction: string | null;
  /** Duration is SUPPORTING evidence only — never a sole rule (owner rule). */
  duration_role: "corroborating" | "absent" | "none";
  transcript_available: null;
  transcript_basis: string;
  /** Employee resolution provenance (roster-INDEPENDENT — see compute.ts). */
  employee_basis: string;
  /** Which source table the call came from + its raw id (audit chain). */
  source: string;
  external_call_id: string | null;
}

/**
 * THE MATRIX (§9). Pure, total, deterministic: every (status, duration)
 * pair maps to exactly one class; unknown statuses map to `unknown`.
 * GHL stores duration 0 when null — both arrive here as 0/null and both
 * mean "no corroborating duration".
 */
export function classifyAttempt(call: {
  callStatus: string | null;
  durationSeconds: number | null;
  direction?: string | null;
  externalCallId?: string | null;
  employeeBasis?: string;
  source?: string;
}): AttemptClassification {
  const status = call.callStatus == null ? null : String(call.callStatus);
  const duration = call.durationSeconds == null || !Number.isFinite(Number(call.durationSeconds)) ? null : Number(call.durationSeconds);
  const base: AttemptEvidenceSnapshot = {
    rule: "unknown_status",
    call_status_raw: status,
    duration_seconds: duration,
    direction: call.direction == null ? null : String(call.direction),
    duration_role: duration != null && duration > 0 ? "corroborating" : "absent",
    transcript_available: null,
    transcript_basis: TRANSCRIPT_AVAILABILITY_BASIS,
    employee_basis: call.employeeBasis ?? "unresolved",
    source: call.source ?? "calls",
    external_call_id: call.externalCallId == null ? null : String(call.externalCallId),
  };
  const mk = (attemptClass: AttemptClass, rule: AttemptClassification["rule"], durationRole: AttemptEvidenceSnapshot["duration_role"]): AttemptClassification => ({
    attemptClass,
    rule,
    transcriptAvailable: null,
    evidence: { ...base, rule, duration_role: durationRole },
  });

  if (status === "completed") {
    if (duration != null && duration > 0) return mk("answered", "completed_with_duration", "corroborating");
    return mk("answered_uncorroborated", "completed_zero_duration", "absent");
  }
  if (status === "voicemail") return mk("voicemail", "voicemail_status", "none");
  if (status === "no-answer") return mk("no_answer", "no_answer_status", "none");
  if (status === "busy") return mk("no_answer", "busy_status", "none");
  if (status === "failed") return mk("non_contact", "failed_status", "none");
  if (status === "ringing") return mk("transient", "ringing_status", "none");
  // CLOSED vocabulary exhausted — anything else (future values, null) is
  // unknown → Needs Review at aggregation. NEVER guessed.
  return mk("unknown", "unknown_status", "none");
}

/** The per-status outcomes each class contributes to the aggregation (D11: non_contact contributes NO evidence). */
export function classContribution(c: AttemptClass): "verified_spoke_with" | "voicemail" | "no_answer" | "unclear" | "needs_review" | "none" {
  switch (c) {
    case "answered":
      return "verified_spoke_with";
    case "answered_uncorroborated":
    case "transient":
      return "unclear";
    case "voicemail":
      return "voicemail";
    case "no_answer":
      return "no_answer";
    case "non_contact":
      return "none";
    case "unknown":
      return "needs_review";
  }
}

// ---------- note-evidence parser (§10; read-only, never writes notes) ----------

export interface NoteMarker {
  token: "SWC" | "LVM";
  /** Documenter initials as written (owner Settings map resolves them — next stage; unmapped stays flagged). */
  initials: string | null;
  /** Parsed MM/DD/YY|MM/DD/YYYY marker date → YYYY-MM-DD (null when absent/unparseable). */
  date: string | null;
  raw: string;
}

export interface NoteEvidence {
  spokeMarkers: NoteMarker[];
  voicemailMarkers: NoteMarker[];
  /** Paraphrase families — recorded as evidence ONLY, never decisive (§10 confidence: low). */
  paraphraseSpoke: string[];
  paraphraseVoicemail: string[];
  rescheduleMention: boolean;
  cancelMention: boolean;
  confirmMention: boolean;
  /** True when the notes text existed at all (raw coverage begins 2026-09-28, §1 caveat). */
  notesPresent: boolean;
}

/** Parse one MM/DD/YY or MM/DD/YYYY token → YYYY-MM-DD (null when impossible — never fabricate). */
export function parseNoteMarkerDate(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw.trim());
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  let yyyy = Number(m[3]);
  if (yyyy < 100) yyyy += 2000;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  // Real calendar validation: Feb 30 / Apr 31 are not dates — downgrade, never fabricate.
  const probe = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (probe.getUTCMonth() !== mm - 1 || probe.getUTCDate() !== dd) return null;
  return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

const SWC_RE = /\bSWC\b([ \t]*([A-Za-z]{2,3})?)?([ \t]*(\d{1,2}\/\d{1,2}\/\d{2,4}))?/g;
const LVM_RE = /\bLVM\b([ \t]*([A-Za-z]{2,3})?)?([ \t]*(\d{1,2}\/\d{1,2}\/\d{2,4}))?/g;

/** Parse the appointment's raw notes into the §10 token families. */
export function parseNoteEvidence(notes: string | null | undefined): NoteEvidence {
  const text = notes == null ? "" : String(notes);
  const out: NoteEvidence = {
    spokeMarkers: [],
    voicemailMarkers: [],
    paraphraseSpoke: [],
    paraphraseVoicemail: [],
    rescheduleMention: false,
    cancelMention: false,
    confirmMention: false,
    notesPresent: text.trim().length > 0,
  };
  for (const m of text.matchAll(SWC_RE)) {
    out.spokeMarkers.push({
      token: "SWC",
      initials: m[2] ? m[2].toUpperCase() : null,
      date: m[4] ? parseNoteMarkerDate(m[4]) : null,
      raw: m[0].trim(),
    });
  }
  for (const m of text.matchAll(LVM_RE)) {
    out.voicemailMarkers.push({
      token: "LVM",
      initials: m[2] ? m[2].toUpperCase() : null,
      date: m[4] ? parseNoteMarkerDate(m[4]) : null,
      raw: m[0].trim(),
    });
  }
  if (/\bspoke\b/i.test(text) && out.spokeMarkers.length === 0) out.paraphraseSpoke.push("spoke");
  if (/\bvoicemail\b|\bvoice mail\b/i.test(text) && out.voicemailMarkers.length === 0) out.paraphraseVoicemail.push("voicemail");
  out.rescheduleMention = /reschedul\w*/i.test(text);
  out.cancelMention = /cancel\w*/i.test(text);
  out.confirmMention = /confirm\w*/i.test(text);
  return out;
}

// ---------- aggregation (§9 overlay + five-outcome scale) ----------

export interface AttemptForAggregation {
  attemptClass: AttemptClass;
  /** GHL duration as received (0 = no corroborating duration). */
  durationSeconds: number | null;
  /** Attempt row id for the evidence list (external call id). */
  externalCallId?: string | null;
  callStatus?: string | null;
}

export interface AggregationResult {
  finalStatus: FinalContactStatus;
  /** Non-null exactly when finalStatus = needs_review — the WHY, for the drill-down. */
  needsReviewReason: string | null;
  /** Ordered reasons the outcome was counted this way (evidence snapshot). */
  basis: string[];
  /** Corroboration/conflict outcomes of the note overlay (audit). */
  noteOverlay: {
    swcCorroborated: boolean;
    swcConflicts: boolean;
    lvmConsistent: boolean;
    lvmConflicts: boolean;
  };
}

/**
 * Is a note marker IN this appointment's contact window (§9: "Note SWC in
 * window")? Markers with no parseable date count as claims about the
 * appointment (Laura documents at contact time — the corpus's SWC/LVM lines
 * match the due-window work). A parseable date must fall in the ET calendar
 * span [dueDate, appointmentDate] inclusive (calendar truth, slightly wider
 * than the instant window by the documented due-date vs window split).
 */
export function markerInWindow(marker: NoteMarker, dueDate: string, appointmentDate: string): boolean {
  if (!marker.date) return true;
  return marker.date >= dueDate && marker.date <= appointmentDate;
}

/**
 * Aggregate ONE appointment's attributed attempts + note evidence into the
 * final status (§9 rules, in the ratified order). Deterministic + pure.
 */
export function aggregateAppointmentStatus(
  attempts: AttemptForAggregation[],
  notes: NoteEvidence,
  opts: { dueDate: string; appointmentDate: string },
): AggregationResult {
  const basis: string[] = [];
  const classes = attempts.map((a) => a.attemptClass);
  const hasAnsweredWithDuration = attempts.some((a) => a.attemptClass === "answered" && (a.durationSeconds ?? 0) > 0);
  const hasAnswered = classes.includes("answered");
  const hasVoicemail = classes.includes("voicemail");
  const allNoAnswer = attempts.length > 0 && classes.every((c) => c === "no_answer");
  const hasUnknown = classes.includes("unknown");

  const swcMarkers = notes.spokeMarkers.filter((m) => markerInWindow(m, opts.dueDate, opts.appointmentDate));
  const lvmMarkers = notes.voicemailMarkers.filter((m) => markerInWindow(m, opts.dueDate, opts.appointmentDate));
  const swcConflicts = swcMarkers.length > 0 && !hasAnswered;
  const lvmConflicts = lvmMarkers.length > 0 && !hasVoicemail;

  const noteOverlay = {
    swcCorroborated: swcMarkers.length > 0 && hasAnswered,
    swcConflicts,
    lvmConsistent: lvmMarkers.length > 0 && hasVoicemail,
    lvmConflicts,
  };

  // Rule 1 — ANY signal conflict (note overlay or unknown status) → Needs Review.
  const conflicts: string[] = [];
  if (swcConflicts) {
    conflicts.push(
      `SWC note claims a contact the call log does not show (no answered-class call in the appointment's window) — D5: notes corroborate, never replace the call log`,
    );
  }
  if (lvmConflicts) {
    conflicts.push(
      `LVM note claims a voicemail the call log does not show — the log may miss the attempt (never classified "No Answer" on the note alone)`,
    );
  }
  if (hasUnknown) {
    const unknownRows = attempts.filter((a) => a.attemptClass === "unknown").map((a) => a.callStatus ?? "null");
    conflicts.push(`unrecognized call_status value(s) in the attempt ledger: ${[...new Set(unknownRows)].join(", ")} — unknown values are never guessed`);
  }
  if (conflicts.length > 0) {
    return {
      finalStatus: "needs_review",
      needsReviewReason: conflicts.join("; "),
      basis: [...conflicts, ...statusBasis(attempts, hasAnsweredWithDuration, hasVoicemail, allNoAnswer)],
      noteOverlay,
    };
  }

  if (swcCorroboratedOnly(noteOverlay)) basis.push(`SWC note corroborates an answered-class call in window`);
  if (noteOverlay.lvmConsistent) basis.push(`LVM note consistent with a voicemail call in window`);
  const noteBits = [...basis];

  // Rules 2–5 (§9 ratified order).
  const finalBasis = [...noteBits, ...statusBasis(attempts, hasAnsweredWithDuration, hasVoicemail, allNoAnswer)];
  if (hasAnsweredWithDuration) {
    return {
      finalStatus: "verified_spoke_with",
      needsReviewReason: null,
      basis: [`answered-class call with duration > 0 (status primary; duration corroborates — never a sole rule)`, ...finalBasis],
      noteOverlay,
    };
  }
  if (hasVoicemail) {
    return { finalStatus: "voicemail", needsReviewReason: null, basis: ["voicemail-class call present (status primary)", ...finalBasis], noteOverlay };
  }
  if (allNoAnswer) {
    return { finalStatus: "no_answer", needsReviewReason: null, basis: ["all attempts are no-answer-class (status primary)", ...finalBasis], noteOverlay };
  }
  if (attempts.length > 0) {
    const onlyNonContact = classes.every((c) => c === "non_contact");
    return {
      finalStatus: "attempted_unclear",
      needsReviewReason: null,
      basis: [
        onlyNonContact
          ? "attempts recorded but every one is failed-class (D11: a dial happened; no contact evidence)"
          : "only uncorroborated (completed+0s) or transient (ringing) attempts — outcome not determinable from status",
        ...finalBasis,
      ],
      noteOverlay,
    };
  }
  // Zero attempts, no conflicting notes.
  return {
    finalStatus: ZERO_ATTEMPTS_FINAL_STATUS,
    needsReviewReason: null,
    basis: ["no outbound attempts recorded in the appointment's contact window", ...finalBasis],
    noteOverlay,
  };
}

function swcCorroboratedOnly(o: AggregationResult["noteOverlay"]): boolean {
  return o.swcCorroborated;
}

function statusBasis(attempts: AttemptForAggregation[], hasAnsweredWithDuration: boolean, hasVoicemail: boolean, allNoAnswer: boolean): string[] {
  const bits: string[] = [];
  if (attempts.length === 0) return bits;
  const byClass = new Map<AttemptClass, number>();
  for (const a of attempts) byClass.set(a.attemptClass, (byClass.get(a.attemptClass) ?? 0) + 1);
  bits.push(
    `attempts ${attempts.length}: ${[...byClass.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}×${n}`).join(", ")}`,
  );
  void hasAnsweredWithDuration;
  void hasVoicemail;
  void allNoAnswer;
  return bits;
}
