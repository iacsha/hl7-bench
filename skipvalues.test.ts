// bun test
//
// A sender that writes UNKNOWN instead of leaving a contact name blank defeats
// skipWhenEmpty, and the receiver creates a contact named UNKNOWN for every
// patient whose employer the sender does not know. `skipValues` skips those
// too, with the same exact comparison in the bench and every engine.

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

import { Message } from "./hl7";
import { runSpec } from "./run";
import { emitIris } from "./emit/iris";
import { emitProcess } from "./emit/process";
import { emitBridgelink } from "./emit/bridgelink";
import { specToSource } from "./serialize";
import { copy, validate, type Repeat, type Spec } from "./spec";

const spec = (repeat: Partial<Repeat> = {}, process?: Spec["iris"]["process"]): Spec => ({
  name: "Skip Values Test",
  gate: { path: "MSH-9.2", permit: { A01: "A28" } },
  iris: {
    className: "Skip.Test.Dtl",
    sourceDocType: "2.5:ADT_A01",
    targetDocType: "2.5:ADT_A01",
    ...(process ? { process } : {}),
  },
  bridgelink: { channelName: "Skip Test" },
  blocks: [
    { id: "MSH", wholeSegment: true, rows: [] },
    {
      id: "NK1",
      ...(process?.transform === "patch" ? { wholeSegment: true } : {}),
      repeat: { over: "NK1", skipWhenEmpty: "NK1-2", skipValues: ["UNKNOWN"], ...repeat },
      rows: process?.transform === "patch" ? [] : [{ target: "NK1-2", from: copy("NK1-2") }],
    },
  ],
});

const IN =
  "MSH|^~\\&|APP|FAC|RCV|RFAC|20261002||ADT^A01|1|P|2.5\r" +
  "NK1|1|DOE^JANE\r" +
  "NK1|2|UNKNOWN\r" +
  "NK1|3|\r" +
  "NK1|4|unknown\r" +
  "NK1|5|DOE^AMY\r";

describe("the bench", () => {
  test("skips the placeholder as well as the empty one", () => {
    const msg = new Message(IN);
    const r = runSpec(spec(), msg);
    expect(msg.all("NK1").map((s) => s.get("NK1-2"))).toEqual(["DOE^JANE", "unknown", "DOE^AMY"]);
    expect(r.notes.join("\n")).toContain(`2 NK1 segment(s) skipped: NK1-2 empty or "UNKNOWN"`);
  });

  // Exact on purpose: the engines compare with = and ===, and a case-folding
  // bench would skip what IRIS delivers.
  test("is case-sensitive, so a different spelling must be listed", () => {
    const msg = new Message(IN);
    runSpec(spec({ skipValues: ["UNKNOWN", "unknown"] }), msg);
    expect(msg.all("NK1").map((s) => s.get("NK1-2"))).toEqual(["DOE^JANE", "DOE^AMY"]);
  });
});

describe("validate", () => {
  test("needs skipWhenEmpty, which names the field", () => {
    expect(validate(spec({ skipWhenEmpty: undefined })).join("\n")).toContain("skipValues needs repeat.skipWhenEmpty");
  });

  test("an empty list is refused", () => {
    expect(validate(spec({ skipValues: [] })).join("\n")).toContain("skipValues is empty");
  });

  test("an empty value is refused, since empty is skipWhenEmpty's job", () => {
    expect(validate(spec({ skipValues: [""] })).join("\n")).toContain("holds an empty value");
  });

  test("a well-formed one is valid", () => {
    expect(validate(spec())).toEqual([]);
  });
});

describe("every engine skips the same occurrences", () => {
  test("DTL: one parenthesised guard per value", () => {
    expect(emitIris(spec())).toContain(
      `<if condition='($LENGTH(source.{NK1(k1):2})&gt;0) &amp;&amp; (source.{NK1(k1):2}&apos;="UNKNOWN")' >`,
    );
  });

  test("inline process", () => {
    const cls = emitProcess(spec({}, { className: "Skip.Test.Process", sendTo: "ToT", transform: "inline" }));
    expect(cls).toContain(`(..ValueAt(tSource,"NK1("_k1_"):2")'="UNKNOWN")`);
  });

  test("patch process removes the empty one and the placeholder", () => {
    const cls = emitProcess(spec({}, { className: "Skip.Test.Process", sendTo: "ToT", transform: "patch" }));
    expect(cls).toMatch(/If \(.+ = ""\) \|\| \(.+ = "UNKNOWN"\) /);
  });

  test("BridgeLink step", () => {
    expect(emitBridgelink(spec())).toContain(`['UNKNOWN'].indexOf(benchGet(`);
  });
});

describe("it survives", () => {
  test("a GUI save", () => {
    expect(specToSource(spec())).toContain(`skipValues: ["UNKNOWN"]`);
  });

  test("the GUI has a control for it", () => {
    expect(readFileSync(new URL("./gui.html", import.meta.url), "utf8")).toContain(`text(block.repeat, "skipValues"`);
  });
});
