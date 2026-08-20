// bun test
//
// The fingerprint's whole job is to be the SAME string for the same interface
// and a DIFFERENT string for a different one. Both halves fail quietly: a
// fingerprint that drifts on a cosmetic edit trains you to ignore it, and one
// that holds still through a real change is worse than not having one, because
// it says "you are running the right class" when you are not.

import { expect, test, describe } from "bun:test";

import { fingerprint, stableStringify } from "./fingerprint";
import { copy, literal, type Spec } from "./spec";

const base = (over: Partial<Spec> = {}): Spec => ({
  name: "Fingerprint Test",
  gate: { path: "MSH-9.2", permit: { A01: "A01" } },
  iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3:ADT_A01" },
  blocks: [{ id: "PID", rows: [{ target: "PID-3", from: copy("PID-3") }] }],
  ...over,
});

describe("stableStringify", () => {
  test("key order does not change the output", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  test("key order does not change the output at depth", () => {
    const one = { outer: { z: [{ q: 1, p: 2 }], a: 3 } };
    const two = { outer: { a: 3, z: [{ p: 2, q: 1 }] } };
    expect(stableStringify(one)).toBe(stableStringify(two));
  });

  // Block order is segment order and row order is assign order. A spec that
  // delivers PID before PV1 is not the same interface as one that does not.
  test("array order DOES change the output", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  test("an explicit undefined matches the field being absent", () => {
    expect(stableStringify({ a: 1, note: undefined })).toBe(stableStringify({ a: 1 }));
  });

  test("null survives and is not confused with undefined", () => {
    expect(stableStringify({ a: null })).toBe(`{"a":null}`);
  });

  test("strings that look like structure are quoted, not interpolated", () => {
    expect(stableStringify({ a: `}{,"` })).toBe(`{"a":"}{,\\""}`);
  });
});

describe("fingerprint", () => {
  test("twelve hex characters, short enough to compare by eye", () => {
    expect(fingerprint(base())).toMatch(/^[0-9a-f]{12}$/);
  });

  test("the same spec twice is the same string", () => {
    expect(fingerprint(base())).toBe(fingerprint(base()));
  });

  test("a different mapping is a different string", () => {
    const changed = base({
      blocks: [{ id: "PID", rows: [{ target: "PID-3", from: copy("PID-4") }] }],
    });
    expect(fingerprint(changed)).not.toBe(fingerprint(base()));
  });

  // The deliberate choice: everything is covered, including the parts that do
  // not reach the ObjectScript. A rewritten label changes the trace document
  // you hand the receiver, and that is a change you want to see somewhere.
  test("a label-only edit changes it", () => {
    const relabelled = base({
      blocks: [{ id: "PID", rows: [{ target: "PID-3", from: copy("PID-3"), label: "MRN" }] }],
    });
    expect(fingerprint(relabelled)).not.toBe(fingerprint(base()));
  });

  test("a note-only edit changes it", () => {
    const noted = base({
      blocks: [{ id: "PID", note: "why", rows: [{ target: "PID-3", from: copy("PID-3") }] }],
    });
    expect(fingerprint(noted)).not.toBe(fingerprint(base()));
  });

  test("reordering the keys of a row does not change it", () => {
    const reordered: Spec = {
      blocks: base().blocks,
      iris: base().iris,
      gate: base().gate,
      name: base().name,
    };
    expect(fingerprint(reordered)).toBe(fingerprint(base()));
  });

  test("reordering blocks DOES change it", () => {
    const one = base({
      blocks: [
        { id: "PID", rows: [{ target: "PID-3", from: literal("x") }] },
        { id: "PV1", rows: [{ target: "PV1-2", from: literal("I") }] },
      ],
    });
    const two = base({ blocks: [...one.blocks].reverse() });
    expect(fingerprint(one)).not.toBe(fingerprint(two));
  });
});
