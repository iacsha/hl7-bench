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
import { literal } from "./spec";
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
  test("a counter is a range", () =>
    expect(occurrences(Array.from({ length: 43 }, (_, i) => String(i + 1)))).toBe("1 to 43"));
  test("numbers that skip are not a range", () => expect(occurrences(["1", "3"])).toBe("1: 1; 2: 3"));

  const many = (v: (i: number) => string, n = 44) => Array.from({ length: n }, (_, i) => v(i));

  test("a long list with few distinct values is counted, most common first", () =>
    expect(occurrences(many((i) => (i === 43 ? "C" : "F")))).toBe("F (43); C (1)"));
  test("long free text is summarised and points at the sheet with all of it", () => {
    const cell = occurrences(many((i) => `report line number ${i}`), "P03 to T02");
    expect(cell).toBe('44 values, first "report line number 0"; every one on sheet "P03 to T02"');
  });
  test("a long first value is clipped", () => {
    const cell = occurrences(many((i) => `${"x".repeat(60)}${i}`));
    expect(cell).toContain(`first "${"x".repeat(40)}..."`);
  });
});

describe("the same segment declared twice", () => {
  // A report-line block and a second block continuing its numbering, as a
  // spec with report OBXs and a trailing CPT OBX has. Before, the second
  // block folded into the first as one odd occurrence.
  const nk1 = spec.blocks.find((b) => b.id === "NK1")!;
  const twice = {
    ...spec,
    blocks: [
      ...spec.blocks,
      { id: "NK1", continuesNumbering: true, rows: [{ target: "NK1-3", label: "Tail", from: literal("TAIL") }] },
    ],
  } as typeof spec;
  const msg = a01 + "\rNK1|1|DOE^JANE|MTH\rNK1|2|DOE^JIM|BRO";
  const ov = combinedGrid(twice, [named("a", msg), named("b", as("A08") + "\rNK1|1|DOE^JANE|MTH")])[0]!.rows;

  test("each spec row keeps its own Overview row", () => {
    const rel = ov.filter((r) => r[0] === "NK1" && r[2] === "NK1-3");
    expect(rel.map((r) => r[4])).toEqual([nk1.rows.find((r) => r.target === "NK1-3")!.label, "Tail"]);
  });

  test("the first block's values are not diluted by the second", () => {
    const rel = ov.find((r) => r[0] === "NK1" && r[2] === "NK1-3" && r[4] === "Relationship")!;
    expect(rel.at(-2)).toBe("1: MTH; 2: BRO");
    expect(rel.at(-1)).toBe("MTH");
  });

  test("a one-off block sharing an ID with a repeating one is not marked as repeating", () => {
    expect(ov.find((r) => r[4] === "Tail")![1]).toBe("");
  });

  test("the second block shows its own literal", () => {
    const tail = ov.find((r) => r[4] === "Tail")!;
    expect(tail[5]).toBe('"TAIL"');
    expect(tail.at(-1)).toBe("TAIL");
  });
});
