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
import { caseName, combinedGrid, goldenFiles, grid } from "./trace";

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

  // Rows differ between messages where a repeating block walks a different
  // number of occurrences: an A08 carrying two NK1 has a "2 of 2" the A01 lacks.
  // The demo spec's NK1 block repeats.
  const one = a01 + "\rNK1|1|DOE^JANE";
  const two = as("A08") + "\rNK1|1|DOE^JANE\rNK1|2|DOE^JIM";
  const ov = () => combinedGrid(spec, [named("a", one), named("b", two)])[0]!.rows;

  test("an occurrence one message does not have reads (not sent), not empty", () => {
    const second = ov().filter((r) => r[0] === "NK1" && r[1] === "2");
    expect(second.length).toBeGreaterThan(0);
    for (const r of second) {
      expect(r.at(-2)).toBe("(not sent)");
      expect(r.at(-1)).not.toBe("(not sent)");
    }
  });

  test("the same occurrence lines up across messages whose totals differ", () => {
    // "1 of 1" in one and "1 of 2" in the other is the same NK1, one row.
    const first = ov().filter((r) => r[0] === "NK1" && r[1] === "1");
    expect(first.length).toBeGreaterThan(0);
    for (const r of first) expect(r.slice(-2)).not.toContain("(not sent)");
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
