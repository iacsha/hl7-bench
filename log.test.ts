// bun test
//
// The log has one job that matters more than the rest: never write note text
// at `summary`. Notes carry source values -- an unmapped lookup interpolates
// the code that missed the table, a gate refusal interpolates whatever the
// `require` rule read -- and a table keyed on PID-3 puts an MRN in there. The
// level split is the only thing standing between that and a file on disk, so
// it is tested rather than trusted.

import { expect, test, describe, afterEach } from "bun:test";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { authoringLevel, logEvent, logLevel } from "./log";

const FILE = join(import.meta.dir, "logs", ".log-test.log");

function withLog(level: string | undefined, fn: () => void): string {
  const oldLevel = process.env.HL7_BENCH_LOG;
  const oldFile = process.env.HL7_BENCH_LOG_FILE;
  if (level === undefined) delete process.env.HL7_BENCH_LOG;
  else process.env.HL7_BENCH_LOG = level;
  process.env.HL7_BENCH_LOG_FILE = FILE;
  try {
    rmSync(FILE, { force: true });
    fn();
    return existsSync(FILE) ? readFileSync(FILE, "utf8") : "";
  } finally {
    if (oldLevel === undefined) delete process.env.HL7_BENCH_LOG;
    else process.env.HL7_BENCH_LOG = oldLevel;
    if (oldFile === undefined) delete process.env.HL7_BENCH_LOG_FILE;
    else process.env.HL7_BENCH_LOG_FILE = oldFile;
  }
}

afterEach(() => rmSync(FILE, { force: true }));

describe("the level switch", () => {
  test("unset is off", () => {
    const oldLevel = process.env.HL7_BENCH_LOG;
    delete process.env.HL7_BENCH_LOG;
    expect(logLevel()).toBe("off");
    if (oldLevel !== undefined) process.env.HL7_BENCH_LOG = oldLevel;
  });

  test("an unrecognised value is off, not a guess in either direction", () => {
    const oldLevel = process.env.HL7_BENCH_LOG;
    process.env.HL7_BENCH_LOG = "true";
    expect(logLevel()).toBe("off");
    if (oldLevel === undefined) delete process.env.HL7_BENCH_LOG;
    else process.env.HL7_BENCH_LOG = oldLevel;
  });

  test("the authoring log is on when nothing is set", () => {
    const oldLevel = process.env.HL7_BENCH_LOG;
    delete process.env.HL7_BENCH_LOG;
    expect(authoringLevel()).toBe("summary");
    if (oldLevel !== undefined) process.env.HL7_BENCH_LOG = oldLevel;
  });

  test("but an explicit off silences it too", () => {
    const oldLevel = process.env.HL7_BENCH_LOG;
    process.env.HL7_BENCH_LOG = "off";
    expect(authoringLevel()).toBe("off");
    if (oldLevel === undefined) delete process.env.HL7_BENCH_LOG;
    else process.env.HL7_BENCH_LOG = oldLevel;
  });
});

describe("what reaches disk", () => {
  test("off writes no file at all", () => {
    expect(withLog(undefined, () => logEvent("t", { a: 1 }, ["secret"]))).toBe("");
  });

  test("summary writes one line", () => {
    const got = withLog("summary", () => logEvent("t", { a: 1 }, ["one", "two"]));
    expect(got.trimEnd().split("\n").length).toBe(1);
  });

  test("summary counts notes without quoting them", () => {
    const got = withLog("summary", () =>
      logEvent("t", { a: 1 }, ['unmapped Sex code "MRN12345" from PID-3']),
    );
    expect(got).toContain("notes=1");
    expect(got).not.toContain("MRN12345");
  });

  test("full writes the note text", () => {
    const got = withLog("full", () => logEvent("t", { a: 1 }, ["fell back to PID-3.1"]));
    expect(got).toContain("note: fell back to PID-3.1");
  });

  test("appends rather than replacing, so a run is a history", () => {
    const got = withLog("summary", () => {
      logEvent("t", { n: 1 });
      logEvent("t", { n: 2 });
    });
    expect(got.trimEnd().split("\n").length).toBe(2);
  });
});

describe("the line format", () => {
  test("carries a timestamp and the tool", () => {
    const got = withLog("summary", () => logEvent("bench", { result: "ok" }));
    expect(got).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z {2}tool=bench/);
  });

  test("quotes a value with spaces so key=value still splits", () => {
    const got = withLog("summary", () => logEvent("t", { spec: "Demo Interface" }));
    expect(got).toContain('spec="Demo Interface"');
  });

  test("leaves an undefined field out rather than writing the word", () => {
    const got = withLog("summary", () => logEvent("t", { a: 1, b: undefined }));
    expect(got).not.toContain("b=");
  });
});
