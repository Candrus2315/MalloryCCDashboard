/**
 * RETENTION CLASSIFICATION ENGINE tests (stage 3a; plan §9 matrix + §10 notes).
 * Covers: the ratified matrix per CLOSED status value (completed±duration,
 * voicemail, no-answer, busy, failed, ringing, unknown → Needs Review, never
 * guessed), the note-evidence overlay (D5 SWC conflict, LVM conflict,
 * corroborations), the aggregation precedence (conflict > answered >
 * voicemail > no-answer > unclear), marker window scoping, and the D8 rule
 * shape (inbound never contributes a class).
 */
import { describe, expect, test } from "bun:test";
import {
  aggregateAppointmentStatus,
  classifyAttempt,
  markerInWindow,
  parseNoteEvidence,
  parseNoteMarkerDate,
  TRANSCRIPT_AVAILABILITY_BASIS,
  ZERO_ATTEMPTS_FINAL_STATUS,
} from "../retention/classify";

const EMPTY_NOTES = parseNoteEvidence(null);
const WINDOW = { dueDate: "2026-10-19", appointmentDate: "2026-10-26" };

describe("§9 matrix — attempt class per call_status value", () => {
  test("completed + duration > 0 → answered (status primary; duration corroborates)", () => {
    const c = classifyAttempt({ callStatus: "completed", durationSeconds: 21, direction: "outbound" });
    expect(c.attemptClass).toBe("answered");
    expect(c.rule).toBe("completed_with_duration");
    expect(c.evidence.duration_role).toBe("corroborating");
    expect(c.evidence.transcript_available).toBe(null);
    expect(c.evidence.transcript_basis).toBe(TRANSCRIPT_AVAILABILITY_BASIS);
  });
  test("completed + duration 0 → answered_uncorroborated (D2: outcome unclear, never verified on 0s)", () => {
    const c = classifyAttempt({ callStatus: "completed", durationSeconds: 0 });
    expect(c.attemptClass).toBe("answered_uncorroborated");
    expect(c.rule).toBe("completed_zero_duration");
    expect(c.evidence.duration_role).toBe("absent");
  });
  test("null duration on completed → answered_uncorroborated (0 and null are the same honest absence)", () => {
    expect(classifyAttempt({ callStatus: "completed", durationSeconds: null }).attemptClass).toBe("answered_uncorroborated");
  });
  test("voicemail → voicemail regardless of duration (status primary — the 47s voicemail stays voicemail)", () => {
    const c = classifyAttempt({ callStatus: "voicemail", durationSeconds: 47 });
    expect(c.attemptClass).toBe("voicemail");
    expect(c.evidence.duration_role).toBe("none");
  });
  test("no-answer → no_answer", () => {
    expect(classifyAttempt({ callStatus: "no-answer", durationSeconds: 0 }).attemptClass).toBe("no_answer");
  });
  test("busy → no_answer class (§9 mapping)", () => {
    expect(classifyAttempt({ callStatus: "busy", durationSeconds: 0 }).attemptClass).toBe("no_answer");
    expect(classifyAttempt({ callStatus: "busy", durationSeconds: 0 }).rule).toBe("busy_status");
  });
  test("failed → non_contact: counts as attempt, contributes NO contact evidence (D11)", () => {
    const c = classifyAttempt({ callStatus: "failed", durationSeconds: 0 });
    expect(c.attemptClass).toBe("non_contact");
    expect(c.rule).toBe("failed_status");
  });
  test("ringing → transient (re-evaluated idempotently on a later pass)", () => {
    expect(classifyAttempt({ callStatus: "ringing", durationSeconds: 0 }).attemptClass).toBe("transient");
  });
  test("UNKNOWN status value → unknown class (never guessed → Needs Review at aggregation)", () => {
    const c = classifyAttempt({ callStatus: "hangup-midway", durationSeconds: 5 });
    expect(c.attemptClass).toBe("unknown");
    expect(c.rule).toBe("unknown_status");
  });
  test("null status → unknown class", () => {
    expect(classifyAttempt({ callStatus: null, durationSeconds: null }).attemptClass).toBe("unknown");
  });
  test("every evidence snapshot preserves the raw observation (audit per owner spec §17)", () => {
    const c = classifyAttempt({ callStatus: "voicemail", durationSeconds: 47, direction: "outbound", externalCallId: "MSG9", employeeBasis: "calls.rep_id" });
    expect(c.evidence.call_status_raw).toBe("voicemail");
    expect(c.evidence.duration_seconds).toBe(47);
    expect(c.evidence.direction).toBe("outbound");
    expect(c.evidence.external_call_id).toBe("MSG9");
    expect(c.evidence.employee_basis).toBe("calls.rep_id");
  });
});

describe("§10 note parser", () => {
  test("SWC + initials + date parses documenter + date (live corpus shape)", () => {
    const n = parseNoteEvidence("LVM LR 10/19/26\nPaid with invoice 2324");
    expect(n.voicemailMarkers).toHaveLength(1);
    expect(n.voicemailMarkers[0]!.initials).toBe("LR");
    expect(n.voicemailMarkers[0]!.date).toBe("2026-10-19");
    expect(n.spokeMarkers).toHaveLength(0);
    expect(n.notesPresent).toBe(true);
  });
  test("SWC + MM/DD/YYYY variant parses", () => {
    const n = parseNoteEvidence("SWC CW 10/15/2026 — discussed reschedule");
    expect(n.spokeMarkers[0]).toMatchObject({ initials: "CW", date: "2026-10-15" });
    expect(n.rescheduleMention).toBe(true);
  });
  test("SWC/LVM without initials or date still parse (medium tier)", () => {
    const n = parseNoteEvidence("SWC\nlater LVM");
    expect(n.spokeMarkers[0]).toMatchObject({ initials: null, date: null });
    expect(n.voicemailMarkers).toHaveLength(1);
  });
  test("paraphrases recorded as evidence only, never markers (§10 low confidence)", () => {
    const n = parseNoteEvidence("called and spoke with client about pets");
    expect(n.spokeMarkers).toHaveLength(0);
    expect(n.paraphraseSpoke).toEqual(["spoke"]);
  });
  test("cancel/confirm mentions feed the cancellation workflow, not attempt classes", () => {
    const n = parseNoteEvidence("client cancelled; will confirm new date");
    expect(n.cancelMention).toBe(true);
    expect(n.confirmMention).toBe(true);
    expect(n.rescheduleMention).toBe(false);
  });
  test("intake-only notes carry no markers (the dominant 85% is neutral)", () => {
    const n = parseNoteEvidence("Winston / 105 lbs / Better with women / Rabies");
    expect(n.spokeMarkers).toHaveLength(0);
    expect(n.voicemailMarkers).toHaveLength(0);
  });
  test("impossible dates parse to null (downgrade, never fabricate)", () => {
    expect(parseNoteMarkerDate("13/45/26")).toBe(null);
    expect(parseNoteMarkerDate("2/30/26")).toBe(null); // Feb 30
    expect(parseNoteMarkerDate("10/19/26")).toBe("2026-10-19");
  });
});

describe("§9 aggregation — five-outcome scale", () => {
  test("answered with duration → verified_spoke_with", () => {
    const r = aggregateAppointmentStatus(
      [{ attemptClass: "answered", durationSeconds: 21 }],
      EMPTY_NOTES,
      WINDOW,
    );
    expect(r.finalStatus).toBe("verified_spoke_with");
    expect(r.needsReviewReason).toBe(null);
  });
  test("voicemail → voicemail", () => {
    expect(aggregateAppointmentStatus([{ attemptClass: "voicemail", durationSeconds: 47 }], EMPTY_NOTES, WINDOW).finalStatus).toBe("voicemail");
  });
  test("all no-answer → no_answer", () => {
    const r = aggregateAppointmentStatus(
      [
        { attemptClass: "no_answer", durationSeconds: 0 },
        { attemptClass: "no_answer", durationSeconds: 0 },
      ],
      EMPTY_NOTES,
      WINDOW,
    );
    expect(r.finalStatus).toBe("no_answer");
  });
  test("only uncorroborated/transient → attempted_unclear (D2)", () => {
    expect(aggregateAppointmentStatus([{ attemptClass: "answered_uncorroborated", durationSeconds: 0 }], EMPTY_NOTES, WINDOW).finalStatus).toBe("attempted_unclear");
    expect(aggregateAppointmentStatus([{ attemptClass: "transient", durationSeconds: 0 }], EMPTY_NOTES, WINDOW).finalStatus).toBe("attempted_unclear");
  });
  test("only failed attempts → attempted_unclear (D11: dial happened, no evidence)", () => {
    expect(aggregateAppointmentStatus([{ attemptClass: "non_contact", durationSeconds: 0 }], EMPTY_NOTES, WINDOW).finalStatus).toBe("attempted_unclear");
  });
  test("zero attempts → attempted_unclear (ZERO_ATTEMPTS status; evidence basis names it honestly)", () => {
    const r = aggregateAppointmentStatus([], EMPTY_NOTES, WINDOW);
    expect(r.finalStatus).toBe(ZERO_ATTEMPTS_FINAL_STATUS);
    expect(r.basis[0]).toContain("no outbound attempts recorded");
  });
  test("unknown class → needs_review (unknown call status is never guessed)", () => {
    const r = aggregateAppointmentStatus([{ attemptClass: "unknown", durationSeconds: 5, callStatus: "weird-new-status" }], EMPTY_NOTES, WINDOW);
    expect(r.finalStatus).toBe("needs_review");
    expect(r.needsReviewReason).toContain("weird-new-status");
  });
  test("mixed answered + voicemail → verified_spoke_with (rule order: answered wins)", () => {
    const r = aggregateAppointmentStatus(
      [
        { attemptClass: "voicemail", durationSeconds: 47 },
        { attemptClass: "answered", durationSeconds: 33 },
      ],
      EMPTY_NOTES,
      WINDOW,
    );
    expect(r.finalStatus).toBe("verified_spoke_with");
  });
});

describe("§9 note overlay — notes resolve or escalate, never override", () => {
  test("D5: SWC note with NO answered call → Needs Review (notes corroborate, never replace the call log)", () => {
    const notes = parseNoteEvidence("Paid invoice 2324\nSWC LR 10/19/26");
    const r = aggregateAppointmentStatus([{ attemptClass: "voicemail", durationSeconds: 12 }], notes, WINDOW);
    expect(r.finalStatus).toBe("needs_review");
    expect(r.needsReviewReason).toContain("SWC");
    expect(r.noteOverlay.swcConflicts).toBe(true);
  });
  test("SWC note + answered call → consistent, status stands (corroborated)", () => {
    const notes = parseNoteEvidence("SWC LR 10/19/26");
    const r = aggregateAppointmentStatus([{ attemptClass: "answered", durationSeconds: 40 }], notes, WINDOW);
    expect(r.finalStatus).toBe("verified_spoke_with");
    expect(r.needsReviewReason).toBe(null);
    expect(r.noteOverlay.swcCorroborated).toBe(true);
  });
  test("SWC note alone (zero attempts) → Needs Review (the note claims a contact the log lacks)", () => {
    const r = aggregateAppointmentStatus([], parseNoteEvidence("SWC LR 10/19/26"), WINDOW);
    expect(r.finalStatus).toBe("needs_review");
  });
  test("LVM note + voicemail call → consistent voicemail", () => {
    const r = aggregateAppointmentStatus([{ attemptClass: "voicemail", durationSeconds: 47 }], parseNoteEvidence("LVM LR 10/19/26"), WINDOW);
    expect(r.finalStatus).toBe("voicemail");
    expect(r.noteOverlay.lvmConsistent).toBe(true);
  });
  test("LVM note with NO voicemail call → Needs Review (NOT no_answer — never understate her work)", () => {
    const r = aggregateAppointmentStatus([{ attemptClass: "no_answer", durationSeconds: 0 }], parseNoteEvidence("LVM LR 10/19/26"), WINDOW);
    expect(r.finalStatus).toBe("needs_review");
    expect(r.needsReviewReason).toContain("LVM");
  });
  test("marker date BEFORE the due date is out-of-window → no conflict (pre-window intake note)", () => {
    const notes = parseNoteEvidence("SWC LR 10/10/26"); // before due 10/19
    const r = aggregateAppointmentStatus([], notes, WINDOW);
    expect(r.finalStatus).toBe(ZERO_ATTEMPTS_FINAL_STATUS);
    expect(r.noteOverlay.swcConflicts).toBe(false);
  });
  test("marker date AFTER the appointment date is out-of-window → no conflict", () => {
    const notes = parseNoteEvidence("SWC LR 10/30/26"); // after appt 10/26
    expect(aggregateAppointmentStatus([], notes, WINDOW).noteOverlay.swcConflicts).toBe(false);
  });
  test("marker without a date counts as an in-window claim (Laura documents at contact time)", () => {
    expect(markerInWindow({ token: "SWC", initials: "LR", date: null, raw: "SWC LR" }, "2026-10-19", "2026-10-26")).toBe(true);
    expect(markerInWindow({ token: "SWC", initials: "LR", date: "2026-10-21", raw: "SWC LR 10/21/26" }, "2026-10-19", "2026-10-26")).toBe(true);
  });
  test("conflict beats positive evidence: SWC-conflict + answered call from unknown-status row → needs_review wins", () => {
    const notes = parseNoteEvidence("SWC LR 10/19/26");
    const r = aggregateAppointmentStatus([{ attemptClass: "unknown", durationSeconds: 9, callStatus: "odd" }], notes, WINDOW);
    expect(r.finalStatus).toBe("needs_review");
    expect(r.needsReviewReason).toContain("SWC");
    expect(r.needsReviewReason).toContain("odd");
  });
});
