// bun test
//
// A segment with nothing from the source in it. `IN2|1` shipped to a receiver
// on a live interface: IN2 has no Set ID, so field 1 is Insured's Employee ID,
// and the receiver was told the employee id is 1.

import { expect, test, describe } from "bun:test";

import { Message } from "./hl7";
import { runSpec } from "./run";
import { copy, counter, literal, thinSegmentRisks, type Block, type Spec } from "./spec";

const base = (blocks: Block[]): Spec => ({
  name: "Thin Test",
  gate: { path: "MSH-9.2", permit: { A01: "A28" } },
  iris: { className: "Thin.Test.Dtl", sourceDocType: "2.3:ADT_A01", targetDocType: "2.3:ADT_A01" },
  blocks: [{ id: "MSH", wholeSegment: true, rows: [] }, ...blocks],
});

const IN =
  "MSH|^~\\&|APP|FAC|RCV|RFAC|20261002||ADT^A01|1|P|2.3\r" +
  "PID|1||MRN1||DOE^JANE\r" +
  "IN1|1|PLAN1|||||||||||||DOE^JANE\r";

describe("in the spec", () => {
  test("a counter in IN2-1 is named as the employee id it becomes", () => {
    const risks = thinSegmentRisks(base([{ id: "IN2", rows: [{ target: "IN2-1", from: counter() }, { target: "IN2-2", from: copy("IN1-2") }] }]));
    expect(risks).toEqual([
      "IN2-1 is written by counter(), but IN2 has no Set ID: field 1 is Insured's Employee ID, so the receiver reads the counter as that.",
    ]);
  });

  test("a counter in a segment that has a Set ID is fine", () => {
    expect(thinSegmentRisks(base([{ id: "PID", rows: [{ target: "PID-1", from: counter() }, { target: "PID-3", from: copy("PID-3") }] }]))).toEqual([]);
  });

  test("a block of nothing but counters and literals is named", () => {
    const risks = thinSegmentRisks(base([{ id: "NTE", rows: [{ target: "NTE-1", from: counter() }, { target: "NTE-2", from: literal("L") }] }]));
    expect(risks).toEqual([
      "NTE: every row is a counter, literal or event, so this segment is delivered with nothing from the source in it. Map a source field, or drop the block.",
    ]);
  });

  test("MSH and whole-segment blocks are not judged", () => {
    expect(thinSegmentRisks(base([{ id: "EVN", wholeSegment: true, rows: [{ target: "EVN-1", from: counter() }] }]))).toEqual([]);
  });

  test("a segment not on the short list is not judged on field 1", () => {
    expect(thinSegmentRisks(base([{ id: "ZXX", rows: [{ target: "ZXX-1", from: counter() }, { target: "ZXX-2", from: copy("PID-3") }] }]))).toEqual([]);
  });
});

describe("on the bench, per message", () => {
  test("source fields all empty leaves only the set id, and that is said", () => {
    // One NK1 per coverage, numbered, reading a field this sender leaves empty.
    const spec = base([{ id: "NK1", repeat: { over: "IN1" }, rows: [{ target: "NK1-1", from: counter() }, { target: "NK1-2", from: copy("NK1-2") }] }]);
    const r = runSpec(spec, new Message(IN));
    expect(r.notes.join("\n")).toContain(`NK1: delivered as "NK1|1", nothing from the source in it (only NK1-1)`);
  });

  test("a source field that came through is not thin", () => {
    const spec = base([{ id: "PID", repeat: { over: "PID" }, rows: [{ target: "PID-1", from: counter() }, { target: "PID-5", from: copy("PID-5") }] }]);
    const r = runSpec(spec, new Message(IN));
    expect(r.notes.join("\n")).not.toContain("nothing from the source");
  });
});
