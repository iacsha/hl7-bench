// bun test
//
// The combined mapping workbook: every message type the interface handles, in
// one file, with an Overview a reviewer can read across. Built against the
// synthetic demo spec, so nothing here depends on a site.

import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Message } from "./hl7";
import { spec } from "./transform";
import { caseName, combinedGrid, goldenFiles, grid, occurrences } from "./trace";

const a01 = [
  "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260804120000||ADT^A01^ADT_A01|MSG1|P|2.5",
  "EVN|A01|20260804120000",
  "PID|1||MRN1^^^LABMRN^MR||DOE^JOHN||19800115|M|||1 FAKE ST^^ROCHESTER^NY^14624",
  "PV1|1|I",
].join("\r");
const as = (trigger: string) => a01.replace("ADT^A01^", `ADT^${trigger}^`).replace("EVN|A01", `EVN|${trigger}`);
const named = (name: string, raw: string) => ({ name, msg: new Message(raw) });

describe("combinedGrid", () => {
  const sheets = combinedGrid(spec, [named("case-a01", a01), named("case-a08", as("A08")), named("case-a03", as("A03"))]);
  const names = sheets.map((s) => s.name);
  const overview = sheets[0]!.rows;

  test("Overview first, one sheet per delivered message, About last", () => {
    expect(names).toEqual(["Overview", "A01", "A08", "About"]);
  });

  test("the Overview has one value column per delivered message", () => {
    expect(overview[0]!.slice(-2)).toEqual(["A01", "A08"]);
  });

  test("the Overview row count is the union of fields, not one message's", () => {
    const single = grid(spec, new Message(a01))[0]!.rows;
    expect(overview.length).toBeGreaterThanOrEqual(single.length);
  });

  test("each per-message sheet is exactly what grid() builds for that message", () => {
    expect(sheets[1]!.rows).toEqual(grid(spec, new Message(a01))[0]!.rows);
  });

  test("a refused message gets no sheet and is named on About with the reason", () => {
    const about = sheets.at(-1)!.rows;
    const refused = about.find((r) => r[0] === "Refused");
    expect(refused?.[1]).toContain("case-a03");
    expect(refused?.[1]).toContain('"A03"');
  });

  test("About lists every permitted trigger", () => {
    const gates = sheets.at(-1)!.rows.filter((r) => r[0] === "Gate").map((r) => r[1]);
    expect(gates.length).toBe(Object.keys(spec.gate.permit).length);
  });
});

describe("gaps and collisions", () => {
  test("a permitted trigger with no sample is called out, not silently absent", () => {
    const about = combinedGrid(spec, [named("only-a01", a01)]).at(-1)!.rows;
    expect(about).toContainEqual(["Not shown", "A08: no sample message was given"]);
  });

  test("two messages of one type get distinct tabs, since Excel refuses duplicates", () => {
    const names = combinedGrid(spec, [named("first", a01), named("second", a01)]).map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("A01 first");
    expect(names).toContain("A01 second");
  });

  // The demo spec's NK1 block repeats. An A08 carrying two NK1 against an A01
  // carrying one is the case the Overview has to lay out without repeating rows.
  const one = a01 + "\rNK1|1|DOE^JANE";
  const two = as("A08") + "\rNK1|1|DOE^JANE\rNK1|2|DOE^JIM";
  const ov = () => combinedGrid(spec, [named("a", one), named("b", two)])[0]!.rows;

  test("a repeating block is one row per field, not one per occurrence", () => {
    const nk1 = ov().filter((r) => r[0] === "NK1");
    const targets = nk1.map((r) => r[2]);
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets).toEqual(["NK1-1", "NK1-2", "NK1-3"]);
    for (const r of nk1) expect(r[1]).toBe("yes");
  });

  test("occurrences that differ are listed in order, numbered", () => {
    const name = ov().find((r) => r[0] === "NK1" && r[2] === "NK1-2")!;
    expect(name.at(-2)).toBe("DOE^JANE");
    expect(name.at(-1)).toBe("1: DOE^JANE; 2: DOE^JIM");
  });

  test("a block the message never walked reads (not sent)", () => {
    const ov1 = combinedGrid(spec, [named("a", a01), named("b", two)])[0]!.rows;
    const name = ov1.find((r) => r[0] === "NK1" && r[2] === "NK1-2")!;
    expect(name.at(-2)).toBe("(not sent)");
  });

  test("a non-repeating block says nothing in Repeats", () => {
    const pid = ov().filter((r) => r[0] === "PID");
    expect(pid.length).toBeGreaterThan(0);
    for (const r of pid) expect(r[1]).toBe("");
  });

  test("every message refused is an error, not an empty workbook", () => {
    expect(() => combinedGrid(spec, [named("x", as("A03"))])).toThrow(/refused every message/);
  });
});

describe("goldens", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-"));
  for (const f of ["x-a01.in.hl7", "x-a01.want.hl7", "x-a03.reject.hl7", "y-a08.in.hl7", "notes.txt"]) {
    writeFileSync(join(dir, f), a01);
  }

  test("inputs and rejections, never wants", () => {
    expect(goldenFiles(dir).map(caseName)).toEqual(["x-a01", "x-a03", "y-a08"]);
  });

  test("the filter narrows by name, case-insensitively", () => {
    expect(goldenFiles(dir, "X-").map(caseName)).toEqual(["x-a01", "x-a03"]);
  });
});

describe("occurrences", () => {
  test("none is (not sent)", () => expect(occurrences(undefined)).toBe("(not sent)"));
  test("one is the value as it was", () => expect(occurrences(["X"])).toBe("X"));
  test("one empty stays empty", () => expect(occurrences([""])).toBe(""));
  test("several alike collapse, with the count", () => expect(occurrences(["X", "X", "X"])).toBe("X (all 3)"));
  test("several empty say so", () => expect(occurrences(["", ""])).toBe("(empty, all 2)"));
  test("several different are numbered, and an empty one is named", () =>
    expect(occurrences(["A", "", "C"])).toBe("1: A; 2: (empty); 3: C"));
});
