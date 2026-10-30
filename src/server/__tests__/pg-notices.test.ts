/**
 * PG NOTICE ROUTING tests (2026-10-30) — the benign parse_utilcmd.c boot-log
 * object, root-caused in docs/root-cause-parse-utilcmd-boot-notice-2026-10-30.md.
 *
 * postgres.js 3.4.9's DEFAULT notice handler console.log()s the raw object
 * (cjs/src/connection.js:916–918), so the runner's marker bootstrap
 * `CREATE TABLE IF NOT EXISTS schema_migrations ...` prints a 9-line 42P07
 * "already exists, skipping" object on every healthy boot. The store now
 * routes the expected idempotent-DDL notice family to one compact line and
 * passes everything else through untouched. These tests pin the classifier:
 * NOTHING outside the NOTICE + known-code + "already exists, skipping" family
 * may ever be classified benign (an unexpected notice must still print).
 */
import { describe, expect, test } from "bun:test";
import { formatPgNoticeLine, isExpectedIdempotentDdlNotice, type PgNotice } from "../store/pg-notices";

/** The EXACT object observed live in /tmp/serve.log on every healthy boot. */
const LIVE_MARKER_BOOTSTRAP_NOTICE: PgNotice = {
  severity_local: "NOTICE",
  severity: "NOTICE",
  code: "42P07",
  message: 'relation "schema_migrations" already exists, skipping',
  file: "parse_utilcmd.c",
  line: "208",
  routine: "transformCreateStmt",
};

/** The marker bootstrap's twin from CREATE INDEX IF NOT EXISTS (index.c, same 42P07). */
const LIVE_INDEX_NOTICE: PgNotice = {
  severity_local: "NOTICE",
  severity: "NOTICE",
  code: "42P07",
  message: 'relation "calls_started_at_idx" already exists, skipping',
  file: "index.c",
  line: "898",
  routine: "index_create",
};

/** A baseline re-ADD COLUMN IF NOT EXISTS notice (pre-runner sweep era, tablecmds.c). */
const BASELINE_COLUMN_NOTICE: PgNotice = {
  severity_local: "NOTICE",
  severity: "NOTICE",
  code: "42701",
  message: 'column "template_id" of relation "pips" already exists, skipping',
  file: "tablecmds.c",
  line: "7349",
  routine: "check_for_column_name_collision",
};

describe("isExpectedIdempotentDdlNotice (the benign parse_utilcmd.c boot-log object)", () => {
  test("the live marker-bootstrap object (parse_utilcmd.c / transformCreateStmt) classifies expected", () => {
    expect(isExpectedIdempotentDdlNotice(LIVE_MARKER_BOOTSTRAP_NOTICE)).toBe(true);
  });

  test("the CREATE INDEX IF NOT EXISTS twin (index.c / index_create, same 42P07) classifies expected", () => {
    expect(isExpectedIdempotentDdlNotice(LIVE_INDEX_NOTICE)).toBe(true);
  });

  test("the baseline's re-ADD COLUMN notices (42701 / tablecmds.c) classify expected", () => {
    expect(isExpectedIdempotentDdlNotice(BASELINE_COLUMN_NOTICE)).toBe(true);
  });

  test("the whole sanctioned duplicate-object code family classifies expected", () => {
    for (const code of ["42P07", "42701", "42P06", "42710"]) {
      expect(isExpectedIdempotentDdlNotice({ severity: "NOTICE", code, message: "x already exists, skipping" })).toBe(
        true,
      );
    }
  });

  test("a different severity is NEVER benign — a WARNING with the identical code/message stays raw", () => {
    expect(isExpectedIdempotentDdlNotice({ ...LIVE_MARKER_BOOTSTRAP_NOTICE, severity: "WARNING" })).toBe(false);
  });

  test("a missing severity field is never benign", () => {
    const { severity: _severity, ...noSeverity } = LIVE_MARKER_BOOTSTRAP_NOTICE;
    expect(isExpectedIdempotentDdlNotice(noSeverity)).toBe(false);
  });

  test("an unknown SQLSTATE with the same message is never benign (no wildcard codes)", () => {
    expect(
      isExpectedIdempotentDdlNotice({ severity: "NOTICE", code: "57P01", message: "x already exists, skipping" }),
    ).toBe(false);
    expect(isExpectedIdempotentDdlNotice({ severity: "NOTICE", message: "x already exists, skipping" })).toBe(false);
  });

  test("a different message is never benign — 'does not exist, skipping' (DROP IF EXISTS) stays raw", () => {
    expect(
      isExpectedIdempotentDdlNotice({ severity: "NOTICE", code: "42P07", message: 'relation "x" does not exist, skipping' }),
    ).toBe(false);
  });

  test("a message that merely CONTAINS the phrase but does not END with it is never benign", () => {
    expect(
      isExpectedIdempotentDdlNotice({
        severity: "NOTICE",
        code: "42P07",
        message: 'relation "x" already exists, skipping (something else went wrong)',
      }),
    ).toBe(false);
  });

  test("empty/undefined notice fields never classify benign", () => {
    expect(isExpectedIdempotentDdlNotice({})).toBe(false);
    expect(isExpectedIdempotentDdlNotice({ severity: "NOTICE", code: "42P07" })).toBe(false);
  });
});

describe("formatPgNoticeLine (the compact replacement line)", () => {
  test("the live marker object renders as ONE line with code + message — no fake-error object", () => {
    expect(formatPgNoticeLine(LIVE_MARKER_BOOTSTRAP_NOTICE)).toBe(
      '[pg notice 42P07] relation "schema_migrations" already exists, skipping',
    );
    expect(formatPgNoticeLine(LIVE_MARKER_BOOTSTRAP_NOTICE).includes("\n")).toBe(false);
  });

  test("the column-notice variant renders code + message", () => {
    expect(formatPgNoticeLine(BASELINE_COLUMN_NOTICE)).toBe(
      '[pg notice 42701] column "template_id" of relation "pips" already exists, skipping',
    );
  });

  test("degrades honestly on missing code/message (never throws, never fabricates)", () => {
    expect(formatPgNoticeLine({})).toBe("[pg notice ?] (no message)");
  });
});
