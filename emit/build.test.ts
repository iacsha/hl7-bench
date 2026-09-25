// bun test
//
// transform "build": the house-style class for a message that changes shape.
// The EXA DFT to MDM spec, emitted this way, was run whole on IRIS for Health
// 2026.1 by engine.ts --check and matched its golden, 49 segments identical.
// These tests hold the SHAPE; the engine run holds the message.

import { expect, test, describe } from "bun:test";

import { emitProcess } from "./process";
import { NOTE_MAX } from "./inline";
import { validate, copy, literal, event, fromFirst, highest, continuation, counter, type Spec } from "../spec";

const spec = (over: Partial<Spec> = {}): Spec => ({
  name: "Build Test",
  gate: { path: "MSH-9.2", permit: { P03: "T02" }, require: [{ path: "MSH-9.1", equals: "DFT" }] },
  iris: {
    className: "Build.Test.Dtl",
    sourceDocType: "2.5:DFT_P03",
    targetDocType: "2.3:MDM_T02",
    process: { className: "Build.Test.Process", sendTo: "ToTarget.MDM.TCP", transform: "build" },
  },
  blocks: [
    {
      id: "MSH",
      rows: [
        { target: "MSH-7", from: fromFirst("OBX", "OBX-14", "OBX-14") },
        { target: "MSH-9.2", from: event() },
        { target: "MSH-10", from: copy("MSH-10"), required: true },
      ],
    },
    { id: "EVN", rows: [{ target: "EVN-2", from: fromFirst("OBX", "OBX-14", "OBX-14") }] },
    {
      id: "PID",
      note: "Short enough to keep.",
      rows: [
        { target: "PID-3", from: copy("PID-3"), required: true, note: "x".repeat(NOTE_MAX + 1) },
      ],
    },
    {
      id: "OBX",
      repeat: { over: "OBX", select: highest("OBX-17"), fold: continuation("OBX-5") },
      rows: [
        { target: "OBX-1", from: counter() },
        { target: "OBX-5", from: copy("OBX-5") },
      ],
    },
    {
      id: "OBX",
      continuesNumbering: true,
      rows: [
        { target: "OBX-1", from: counter() },
        { target: "OBX-5", from: fromFirst("OBX", "OBX-3", "OBX-3") },
        { target: "OBX-11", from: literal("F") },
      ],
    },
  ],
  ...over,
});

const cls = emitProcess(spec());
const mapping = cls.slice(cls.indexOf("Method Mapping"));

describe("the class", () => {
  test("has the same shell as patch: try, Mapping, send", () => {
    expect(cls).toContain("$$$ThrowOnError(..Mapping(pRequest,.tRequest,tEvent))");
    expect(cls).toContain(`$$$ThrowOnError(..SendRequestAsync("ToTarget.MDM.TCP",tRequest,0))`);
    expect(cls).toContain(`Set tEvent = $CASE(pRequest.GetValueAt("MSH:9.2"),"P03":"T02",:"")`);
    expect(cls).toContain(`$$$TRACE("Message Filtered Out: MSH-9.1 is not DFT")`);
  });

  test("builds a fresh message of the target DocType", () => {
    expect(mapping).toContain("Set tRequest = ##class(EnsLib.HL7.Message).%New()");
    expect(mapping).toContain("Set tRequest.Separators = pRequest.Separators");
    expect(mapping).toContain(`$$$ThrowOnError(tRequest.PokeDocType("2.3:MDM_T02"))`);
    expect(mapping).not.toContain("%ConstructClone");
  });

  test("carries none of the inline scaffolding", () => {
    for (const gone of ["ValueAt(tSource", "ClassMethod ValueAt", "tWriteSC", "tTarget", "tSeed", "IsMutable", "Include Ensemble"]) {
      expect(cls).not.toContain(gone);
    }
  });

  test("writes go through $$$ThrowOnError, in tabs, with capitalised commands", () => {
    expect(mapping).toContain(`\t\t$$$ThrowOnError(tRequest.SetValueAt(pRequest.GetValueAt("MSH:10"),"MSH:10"))`);
    expect(mapping).not.toMatch(/^\s*(set|if|for) /m);
    expect(mapping).not.toMatch(/^ {4}/m);
  });
});

describe("leaner than a row-by-row rendering", () => {
  test("every first-non-empty read of one segment shares ONE pass", () => {
    expect(mapping.match(/For iObx=/g)?.length).toBe(1);
    expect(mapping).toContain(`Set (Obxf14,Obxf3) = ""`);
    expect(mapping).toContain(`If (Obxf14 = "") Set Obxf14 = pRequest.GetValueAt("OBX("_iObx_"):14")`);
  });

  test("the rows read the variable, wherever they sit", () => {
    expect(mapping).toContain(`SetValueAt(Obxf14,"MSH:7")`);
    expect(mapping).toContain(`SetValueAt(Obxf14,"EVN:2")`);
    expect(mapping).toContain(`SetValueAt(Obxf3,"OBX("_c1_"):5")`);
  });

  test("the pass comes before any row that reads it", () => {
    expect(mapping.indexOf("For iObx=")).toBeLessThan(mapping.indexOf(`"MSH:7"`));
  });

  test("top-level required fields are checked in one loop at the end", () => {
    expect(mapping).toContain(`For f="MSH:10","PID:3" {`);
    expect(mapping).toContain(`If (tRequest.GetValueAt(f) = "") $$$LOGWARNING("Required field "_f_" came out empty")`);
    expect(mapping.indexOf(`For f=`)).toBeGreaterThan(mapping.indexOf(`"OBX("_c1_"):11"`));
  });

  test("a short note is a comment, a paragraph stays in the mapping document", () => {
    expect(mapping).toContain("//Short enough to keep.");
    expect(mapping).not.toContain("x".repeat(NOTE_MAX + 1));
    const full = emitProcess(spec({ iris: { ...spec().iris, comments: "full" } }));
    expect(full).toContain("x".repeat(NOTE_MAX + 1));
  });
});

describe("the repeat features a DTL has", () => {
  test("select highest runs its own first pass", () => {
    expect(mapping).toMatch(/For k1m=1:1:cnt1 \{/);
  });

  test("fold appends a continuation onto the segment already written", () => {
    expect(mapping).toContain(`If (n1>0)&&($EXTRACT(pRequest.GetValueAt("OBX("_k1_"):5"),1)=" ") {`);
    expect(mapping).toContain(`SetValueAt(tRequest.GetValueAt("OBX("_n1_"):5")_pRequest.GetValueAt("OBX("_k1_"):5"),"OBX("_n1_"):5")`);
  });

  test("continuesNumbering picks up after the loop", () => {
    expect(mapping).toContain("Set c1 = n1 + 1");
  });
});

describe("validate", () => {
  test("accepts a DocType change, which patch cannot say", () => {
    expect(validate(spec())).toEqual([]);
  });

  test("refuses create copy and points at patch", () => {
    const copyIt = spec({ iris: { ...spec().iris, create: "copy" } });
    expect(validate(copyIt).join("\n")).toContain(`use "patch"`);
  });

  test("refuses an undecided todo row, as inline does", () => {
    const hole = spec();
    hole.blocks[0]!.rows.push({ target: "MSH-11", from: { kind: "todo", why: "later" } });
    expect(validate(hole).join("\n")).toContain(`transform is "build" and 1 row(s) are still todo()`);
  });
});
