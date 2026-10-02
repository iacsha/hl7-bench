// bun test
//
// IN1 and IN2 are one bundle in the schema. Before `bundle`, an IN2 row could
// not sit in the IN1 block, and a separate IN2 block read the first IN2 in the
// message for every coverage, so the second coverage's IN2 was unreachable.
//
// Proven in IRIS for Health 2026.1 on the message below: the DTL and the
// inline process both delivered exactly what the bench does, coverage 2 with
// no IN2, the skipped coverage taking its IN2 with it, and coverage 4's IN2
// riding with its renumbered IN1(3).

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

import { Message } from "./hl7";
import { companionsOf, runSpec } from "./run";
import { emitIris } from "./emit/iris";
import { emitProcess } from "./emit/process";
import { specToSource } from "./serialize";
import { trace } from "./trace";
import { copy, counter, validate, type Block, type Spec } from "./spec";

const IN1: Block = {
  id: "IN1", group: "IN1grp", bundle: ["IN2"],
  repeat: { over: "IN1", skipWhenEmpty: "IN1-2" },
  rows: [
    { target: "IN1-1", from: counter() },
    { target: "IN1-2", from: copy("IN1-2") },
    { target: "IN2-2", from: copy("IN2-2") },
    { target: "IN2-6", from: copy("IN2-6") },
  ],
};

const spec = (block: Partial<Block> = {}, iris: Partial<Spec["iris"]> = {}): Spec => ({
  name: "Bundle Test",
  gate: { path: "MSH-9.2", permit: { A01: "A01" } },
  iris: { className: "Bundle.Test.Dtl", sourceDocType: "2.5:ADT_A01", targetDocType: "2.5:ADT_A01", ...iris },
  bridgelink: { channelName: "Bundle Test" },
  blocks: [{ id: "MSH", wholeSegment: true, rows: [] }, { ...IN1, ...block }],
});

const RAW = [
  "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20261002120000||ADT^A01^ADT_A01|BUN1|P|2.5",
  "PID|1||MRN1",
  "IN1|1|PLANA",
  "IN2|1|111-11-1111||||EMPA",
  "IN1|2|PLANB",
  "IN1|3|",
  "IN2|3|333-33-3333||||EMPC",
  "IN1|4|PLAND",
  "IN2|4|444-44-4444||||EMPD",
].join("\r") + "\r";

const delivered = (s: Spec) => {
  const m = new Message(RAW);
  runSpec(s, m);
  return m.toString().split("\r\n").filter((l) => /^IN[12]/.test(l));
};

describe("the bench", () => {
  test("each coverage carries its own IN2, and only when it has one", () => {
    expect(delivered(spec())).toEqual([
      "IN1|1|PLANA",
      "IN2||111-11-1111||||EMPA",
      "IN1|2|PLANB",
      "IN1|3|PLAND",
      "IN2||444-44-4444||||EMPD",
    ]);
  });

  test("a bundle stops at the first segment that is not in it", () => {
    const m = new Message("MSH|^~\\&|A|B|C|D|1||ADT^A01|1|P|2.5\rIN1|1|X\rIN3|1\rIN2|1|Y\r");
    const found = companionsOf(m, m.all("IN1")[0], ["IN2"]);
    expect(found.has("IN2")).toBe(false);
  });

  test("an IN2 read in a coverage without one is empty, not the previous coverage's", () => {
    const s = spec({ rows: [...IN1.rows, { target: "IN1-3", from: copy("IN2-6") }] });
    const m = new Message(RAW);
    runSpec(s, m);
    expect(m.all("IN1").map((x) => x.get("IN1-3"))).toEqual(["EMPA", "", "EMPD"]);
  });
});

describe("validate", () => {
  const problems = (b: Partial<Block>, iris: Partial<Spec["iris"]> = {}) => validate(spec(b, iris)).join("\n");

  test("an IN2 row without the bundle is refused, and says what to add", () => {
    expect(problems({ bundle: undefined })).toContain("IN2-2 is in the IN1 block but targets IN2. If IN2 travels with each IN1, list it in bundle.");
  });

  test("needs a repeat over its own segment", () => {
    expect(problems({ repeat: undefined })).toContain("bundle needs repeat over IN1");
  });

  test("needs the target group", () => {
    expect(problems({ group: undefined })).toContain("bundle needs the target group");
  });

  test("refuses fold, wholeSegment, its own id and a non-segment", () => {
    expect(problems({ repeat: { over: "IN1", fold: { path: "IN1-2", join: "" } } as Block["repeat"] })).toContain("with repeat.fold");
    expect(problems({ wholeSegment: true })).toContain("with wholeSegment is not built yet");
    expect(problems({ bundle: ["IN1"] })).toContain("lists IN1, the block's own segment");
    expect(problems({ bundle: ["in2"] })).toContain(`entry "in2" is not a segment id`);
  });

  test("patch, build and BridgeLink refuse by name rather than drop IN2", () => {
    for (const transform of ["patch", "build"] as const) {
      expect(problems({}, { process: { className: "P.X", sendTo: "T", transform } })).toContain(`"${transform}" does not emit a bundle yet`);
    }
    expect(validate(spec(), "bridgelink").join("\n")).toContain("BridgeLink does not emit a bundle yet");
  });

  test("a well-formed bundle is valid", () => {
    expect(validate(spec())).toEqual([]);
  });
});

describe("what IRIS is given", () => {
  test("the DTL reads and writes IN2 inside the group occurrence, guarded on its presence", () => {
    const dtl = emitIris(spec());
    expect(dtl).toContain(`<if condition='$LENGTH(source.{IN1grp(k1).IN2})&gt;0' >`);
    expect(dtl).toContain(`<assign value='source.{IN1grp(k1).IN2:6}' property='target.{IN1grp(n1).IN2:6}' action='set' />`);
  });

  test("the inline process does the same", () => {
    const cls = emitProcess(spec({}, { process: { className: "P.X", sendTo: "T", transform: "inline" } }));
    expect(cls).toContain(`if $LENGTH(..ValueAt(tSource,"IN1grp("_k1_").IN2"))>0 {`);
    expect(cls).toContain(`"IN1grp("_n1_").IN2:6"`);
  });
});

describe("it survives", () => {
  test("a GUI save", () => {
    expect(specToSource(spec())).toContain(`bundle: ["IN2"],`);
  });

  test("the GUI has a control", () => {
    expect(readFileSync(new URL("./gui.html", import.meta.url), "utf8")).toContain(`text(block, "bundle"`);
  });

  test("the mapping document lists the IN2 rows with this message's values", () => {
    const doc = trace(spec(), new Message(RAW));
    expect(doc).toContain("IN2-6");
    expect(doc).toContain("EMPD");
  });
});
