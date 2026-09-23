// bun test
//
// `engine.ts --script` against an inline class. The emitter writes every read as
// `..ValueAt(...)`, a ClassMethod beside OnRequest. Lifting only the body left
// the scratch class without it, and the engine reported ~15 `No such method`
// errors about a class that compiled fine in Studio. These tests hold the fix
// against what the emitter actually writes, not a hand-made imitation.

import { expect, test, describe } from "bun:test";

import { classMethodsOf, SCRATCH_METHOD } from "./scratch";
import { emitProcess } from "./emit/process";
import { literal, type Spec } from "./spec";

const inlineSpec = (): Spec => ({
  name: "Scratch Test",
  gate: { path: "MSH-9.2", permit: { A01: "A28" } },
  iris: {
    className: "Site.Interface.DTL.Thing",
    sourceDocType: "2.3:ADT_A01",
    targetDocType: "2.3:ADT_A01",
    process: { className: "Site.Interface.Process.Thing", sendTo: "ToTarget.ADT.TCP", transform: "inline" },
  },
  blocks: [{ id: "PID", wholeSegment: true, rows: [{ target: "PID-19", from: literal("") }] }],
});

describe("an emitted inline class", () => {
  const cls = emitProcess(inlineSpec());

  test("really does read through ..ValueAt, or this test proves nothing", () => {
    expect(cls).toContain("..ValueAt(");
  });

  test("carries ValueAt", () => {
    expect(classMethodsOf(cls, "OnRequest").names).toContain("ValueAt");
  });

  test("carries it whole, closing brace and quit included", () => {
    const { text } = classMethodsOf(cls, "OnRequest");
    expect(text).toContain("ClassMethod ValueAt(pDoc As EnsLib.HL7.Message, pPath As %String) As %String");
    expect(text).toContain("quit tValue");
    expect(text.trimEnd().endsWith("}")).toBe(true);
    const opens = text.split("{").length;
    const closes = text.split("}").length;
    expect(opens).toBe(closes);
  });

  test("does not carry OnRequest, which is the body being lifted", () => {
    const { text } = classMethodsOf(cls, "OnRequest");
    expect(text).not.toMatch(/Method OnRequest/);
  });
});

describe("what is left behind", () => {
  test("a bare body has no siblings", () => {
    expect(classMethodsOf(`set tTarget = pRequest.%ConstructClone(1)`, "OnRequest")).toEqual({ names: [], text: "" });
  });

  test("an instance Method is not carried: a ClassMethod cannot reach it anyway", () => {
    const raw = [
      `Class A.B Extends Ens.BusinessProcess`,
      `{`,
      `Method OnRequest(pRequest As EnsLib.HL7.Message) As %Status`,
      `{`,
      `    quit $$$OK`,
      `}`,
      `Method Helper() As %String`,
      `{`,
      `    quit "x"`,
      `}`,
      `}`,
    ].join("\n");
    expect(classMethodsOf(raw, "OnRequest").names).toEqual([]);
  });

  test("the method named by --method is excluded even when it is a ClassMethod", () => {
    const raw = [
      `Class A.B Extends Ens.BusinessProcess`,
      `{`,
      `ClassMethod Go() As %Status`,
      `{`,
      `    quit $$$OK`,
      `}`,
      `ClassMethod Pad(x) As %String`,
      `{`,
      `    if x="" { quit "-" }`,
      `    quit x`,
      `}`,
      `}`,
    ].join("\n");
    const got = classMethodsOf(raw, "Go");
    expect(got.names).toEqual(["Pad"]);
    expect(got.text).toContain(`if x="" { quit "-" }`);
    expect(got.text).toContain("quit x");
  });

  test(`a helper named ${SCRATCH_METHOD} collides with the scratch method and is refused`, () => {
    const raw = [`Class A.B Extends Ens.BusinessProcess`, `{`, `ClassMethod ${SCRATCH_METHOD}() {`, `}`, `}`].join("\n");
    expect(() => classMethodsOf(raw, "OnRequest")).toThrow(/Rename one/);
  });

  test("an unclosed helper is an error, not a silent truncation", () => {
    const raw = [`Class A.B Extends Ens.BusinessProcess`, `{`, `ClassMethod Pad() {`, `    quit 1`].join("\n");
    expect(() => classMethodsOf(raw, "OnRequest")).toThrow(/unclosed/);
  });
});
