// bun test
//
// sameAs: a target field an earlier row wrote, written again elsewhere. The
// EXA feed writes the signing radiologist into TXA-5, -9, -10 and -22; before
// this the spec said it four times and the class read OBR-32 twelve times.

import { expect, test, describe } from "bun:test";

import { Message } from "./hl7";
import { runSpec } from "./run";
import { emitIris } from "./emit/iris";
import { emitProcess } from "./emit/process";
import { specToSource, constructorsUsed } from "./serialize";
import { validate, copy, literal, sameAs, type Spec, type Block } from "./spec";

const IN =
  "MSH|^~\\&|EXA|SITE|||20260925||DFT^P03|1|P|2.5\r" +
  "PID|1||MRN1||DOE^JANE\r" +
  "OBR|1|ORD1|ACC1|CT^CHEST|||||||||||||||||||||F|||||||NPI0^SMITH^ANN^^^1234567890\r";

const spec = (blocks: Block[]): Spec => ({
  name: "SameAs Test",
  gate: { path: "MSH-9.2", permit: { P03: "T02" } },
  iris: { className: "Same.As.Dtl", sourceDocType: "2.5:DFT_P03", targetDocType: "2.3:MDM_T02" },
  blocks,
});

const txa = (extra: Block["rows"]): Block => ({
  id: "TXA",
  rows: [
    { target: "TXA-5.1", from: copy("OBR-32.6") },
    { target: "TXA-5.2", from: copy("OBR-32.2") },
    { target: "TXA-5.3", from: copy("OBR-32.3") },
    ...extra,
  ],
});

describe("the runner", () => {
  test("reads back a field written as components, as one composite", () => {
    const s = spec([{ id: "MSH", rows: [] }, txa([{ target: "TXA-9", from: sameAs("TXA-5") }])]);
    const msg = new Message(IN);
    runSpec(s, msg);
    expect(msg.get("TXA-9")).toBe("1234567890^SMITH^ANN");
    expect(msg.get("TXA-9")).toBe(msg.get("TXA-5"));
  });

  test("reads a whole field written whole, from an earlier block", () => {
    const s = spec([
      { id: "MSH", rows: [{ target: "MSH-3", from: literal("EXA") }] },
      { id: "TXA", rows: [{ target: "TXA-12.2", from: sameAs("MSH-3") }] },
    ]);
    const msg = new Message(IN);
    runSpec(s, msg);
    expect(msg.get("TXA-12.2")).toBe("EXA");
  });

  test("a later component on top of a sameAs lands after it, as rows run in order", () => {
    const s = spec([{ id: "MSH", rows: [] }, txa([
      { target: "TXA-22", from: sameAs("TXA-5") },
      { target: "TXA-22.19", from: literal("20260925") },
    ])]);
    const msg = new Message(IN);
    runSpec(s, msg);
    expect(msg.get("TXA-22.1")).toBe("1234567890");
    expect(msg.get("TXA-22.19")).toBe("20260925");
  });
});

describe("validate", () => {
  test("refuses a sameAs of a field no earlier row writes", () => {
    const s = spec([{ id: "MSH", rows: [] }, { id: "TXA", rows: [{ target: "TXA-9", from: sameAs("TXA-5") }] }]);
    expect(validate(s).join("\n")).toContain(`no earlier row writes TXA-5`);
  });

  test("refuses a sameAs that comes BEFORE its writer", () => {
    const s = spec([{ id: "MSH", rows: [] }, { id: "TXA", rows: [
      { target: "TXA-9", from: sameAs("TXA-5") },
      { target: "TXA-5", from: copy("OBR-32") },
    ] }]);
    expect(validate(s).join("\n")).toContain(`no earlier row writes TXA-5`);
  });

  test("refuses a sameAs of a field written in a repeat", () => {
    const s = spec([
      { id: "MSH", rows: [] },
      { id: "OBX", repeat: { over: "OBX" }, rows: [{ target: "OBX-5", from: copy("OBX-5") }] },
      { id: "TXA", rows: [{ target: "TXA-9", from: sameAs("OBX-5") }] },
    ]);
    expect(validate(s).join("\n")).toContain(`written in a repeating block`);
  });

  test("accepts the ordinary case", () => {
    expect(validate(spec([{ id: "MSH", rows: [] }, txa([{ target: "TXA-9", from: sameAs("TXA-5") }])]))).toEqual([]);
  });
});

describe("the backends read the TARGET", () => {
  const s = spec([{ id: "MSH", rows: [] }, txa([{ target: "TXA-9", from: sameAs("TXA-5") }])]);

  test("the DTL assigns from target.{TXA:5}", () => {
    expect(emitIris(s)).toContain(`<assign value='target.{TXA:5}' property='target.{TXA:9}' action='set' />`);
  });

  test("a build class reads tRequest", () => {
    const b = { ...s, iris: { ...s.iris, process: { className: "Same.As.Process", sendTo: "X", transform: "build" as const } } };
    expect(emitProcess(b)).toContain(`tRequest.SetValueAt(tRequest.GetValueAt("TXA:5"),"TXA:9")`);
  });

  test("a GUI save keeps it", () => {
    expect(specToSource(s)).toContain(`from: sameAs("TXA-5")`);
    expect(constructorsUsed(s)).toContain("sameAs");
  });
});
