// bun test
//
// The report exists for one failure: IGNOREMISSINGSOURCE = 1 turns every
// unresolvable assign in a block into a skip, and a block where every assign
// skips produces no segment at all, with nothing written anywhere. So the tests
// that matter are the AT RISK rule and its boundary. One resolvable row in a
// block is the difference between a segment that is missing and a segment that
// is thin, and those are different bugs with different owners.

import { expect, test, describe } from "bun:test";

import { Message } from "./hl7";
import { emptyReads, renderReads } from "./reads";
import {
  copy, literal, firstOf, lookup, counter, event, pickRepeat, fromFirst, todo,
  blank, upper, truncate, type Spec,
} from "./spec";

const MSG = [
  "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260819101500||ADT^A01|MSG0001|P|2.3",
  "PID|1||MRN9^^^MR||DOE^JOHN||19800101|M",
  "PV1|1|I||||||||||||||||||V123",
  "NK1|1|ROE^JANE|SPO",
].join("\r\n");

const msg = (raw = MSG) => new Message(raw);

const base = (over: Partial<Spec> = {}): Spec => ({
  name: "Reads Test",
  gate: { path: "MSH-9.2", permit: { A01: "A01" } },
  iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3:ADT_A01" },
  tables: { Sex: { M: "MALE" } },
  blocks: [{ id: "PID", rows: [{ target: "PID-3", from: copy("PID-3.1") }] }],
  ...over,
});

const on = (spec: Spec, raw = MSG) => emptyReads(spec, msg(raw));

describe("the clean case", () => {
  test("a spec that reads populated fields reports nothing empty", () => {
    const r = on(base());
    expect(r.empty).toEqual([]);
    expect(r.atRisk).toEqual([]);
    expect(r.deliversEmpty).toEqual([]);
    expect(r.rows).toBe(1);
  });

  test("the event is reported as DELIVERED, not as received", () => {
    const spec = base({ gate: { path: "MSH-9.2", permit: { A01: "A08" } } });
    expect(on(spec).event).toBe("A08");
  });

  test("a message the gate refuses throws rather than reporting an empty run", () => {
    const raw = MSG.replace("ADT^A01", "ADT^A03");
    expect(() => on(base(), raw)).toThrow();
  });
});

describe("AT RISK, the shape that deletes a segment", () => {
  // Every row reads IN1, there is no IN1, so IRIS skips every assign and the
  // target segment is never created. No error, no trace, a shorter message.
  test("every row reading an absent segment", () => {
    const spec = base({
      blocks: [{
        id: "IN1",
        rows: [
          { target: "IN1-2", from: copy("IN1-2") },
          { target: "IN1-36", from: copy("IN1-36") },
        ],
      }],
    });
    const r = on(spec);
    expect(r.atRisk).toEqual(["IN1"]);
    expect(r.deliversEmpty).toEqual([]);
    expect(r.empty.every((e) => e.absent)).toBe(true);
  });

  // The boundary. One assign that resolves is enough for IRIS to build the
  // segment, and then the complaint is a thin segment, not a missing one.
  test("one literal in the block is enough to take it off the list", () => {
    const spec = base({
      blocks: [{
        id: "IN1",
        rows: [
          { target: "IN1-1", from: literal("1") },
          { target: "IN1-2", from: copy("IN1-2") },
        ],
      }],
    });
    const r = on(spec);
    expect(r.atRisk).toEqual([]);
    expect(r.deliversEmpty).toEqual([]);
    expect(r.empty).toHaveLength(1);
  });

  test("a block that reads a present segment is never at risk, however empty", () => {
    const spec = base({
      blocks: [{ id: "PID", rows: [{ target: "PID-11", from: copy("PID-11") }] }],
    });
    const r = on(spec);
    expect(r.atRisk).toEqual([]);
    expect(r.deliversEmpty).toEqual(["PID"]);
  });

  test("mixed absent and present segments in one block is not at risk", () => {
    const spec = base({
      blocks: [{
        id: "ZZ1",
        rows: [
          { target: "ZZ1-1", from: copy("IN1-2") },
          { target: "ZZ1-2", from: copy("PID-5.1") },
        ],
      }],
    });
    expect(on(spec).atRisk).toEqual([]);
  });
});

describe("DELIVERS EMPTY, which is a different defect", () => {
  test("a block whose paths resolve and whose fields are all blank", () => {
    const spec = base({
      blocks: [{
        id: "PID",
        rows: [
          { target: "PID-11", from: copy("PID-11") },
          { target: "PID-13", from: copy("PID-13") },
        ],
      }],
    });
    const r = on(spec);
    expect(r.deliversEmpty).toEqual(["PID"]);
    expect(r.atRisk).toEqual([]);
    // The segment IS created in IRIS, so nothing here is flagged as absent.
    expect(r.empty.some((e) => e.absent)).toBe(false);
  });

  test("one delivered field takes the block off the list", () => {
    const spec = base({
      blocks: [{
        id: "PID",
        rows: [
          { target: "PID-5.1", from: copy("PID-5.1") },
          { target: "PID-11", from: copy("PID-11") },
        ],
      }],
    });
    const r = on(spec);
    expect(r.deliversEmpty).toEqual([]);
    expect(r.empty).toHaveLength(1);
  });
});

describe("why each row came back empty", () => {
  const whyFor = (spec: Spec, raw = MSG) => on(spec, raw).empty[0].why;

  test("an absent segment is named, and it outranks everything else", () => {
    const spec = base({
      blocks: [{ id: "ZZ1", rows: [{ target: "ZZ1-1", from: copy("ZZZ-2") }] }],
    });
    expect(whyFor(spec)).toContain("no ZZZ in this message");
  });

  test("an empty field says which path was empty", () => {
    const spec = base({
      blocks: [{ id: "PID", rows: [{ target: "PID-11", from: copy("PID-11") }] }],
    });
    expect(whyFor(spec)).toContain("PID-11");
    expect(whyFor(spec)).toContain("empty");
  });

  test("firstOf with everything empty lists all the paths tried", () => {
    const spec = base({
      blocks: [{ id: "PID", rows: [{ target: "PID-3", from: firstOf("PID-11", "PID-13") }] }],
    });
    expect(whyFor(spec)).toContain("PID-11");
    expect(whyFor(spec)).toContain("PID-13");
  });

  // The one that looks like a broken table and is not: the key was read fine,
  // the table simply has no row for it, and blank() is the declared answer.
  test("an unmapped lookup key quotes the key and names the branch", () => {
    const spec = base({
      tables: { Sex: { F: "FEMALE" } },
      blocks: [{ id: "PID", rows: [{ target: "PID-8", from: lookup("Sex", "PID-8", blank()) }] }],
    });
    const why = whyFor(spec);
    expect(why).toContain(`Sex has no row for "M"`);
    expect(why).toContain("blank");
  });

  test("a lookup whose KEY field is empty says so instead of blaming the table", () => {
    const spec = base({
      blocks: [{ id: "PID", rows: [{ target: "PID-8", from: lookup("Sex", "PID-11", blank()) }] }],
    });
    expect(whyFor(spec)).toContain("PID-11 is empty");
  });

  test("pickRepeat that matched nothing names the component and the value", () => {
    const spec = base({
      blocks: [{
        id: "PV1",
        rows: [{ target: "PV1-7", from: pickRepeat("PV1-7", 7, "NPI") }],
      }],
    });
    const why = whyFor(spec);
    expect(why).toContain("PV1-7");
    expect(why).toContain("NPI");
  });

  test("fromFirst that found no populated segment says which one it wanted", () => {
    const spec = base({
      blocks: [{
        id: "IN1",
        rows: [{ target: "IN1-2", from: fromFirst("IN1", "IN1-2", "IN1-2") }],
      }],
    });
    expect(whyFor(spec)).toContain("IN1");
  });

  test("an empty literal blames the spec, which is where the fix is", () => {
    const spec = base({
      blocks: [{ id: "PID", rows: [{ target: "PID-3", from: literal("") }] }],
    });
    expect(whyFor(spec)).toContain("literal in the spec");
  });

  // A read that succeeded and then lost its value is a `via` bug, and pointing
  // at the source path instead would send you to the wrong file.
  test("a step that empties a populated field names the steps", () => {
    const spec = base({
      blocks: [{
        id: "PID",
        rows: [{ target: "PID-5.1", from: copy("PID-5.1"), via: [truncate(0)] }],
      }],
    });
    const why = whyFor(spec);
    expect(why).toContain("a step emptied it");
    expect(why).toContain("truncate");
  });
});

describe("bookkeeping", () => {
  test("todo rows are listed apart, being unwritten rather than empty", () => {
    const spec = base({
      blocks: [{
        id: "PID",
        rows: [
          { target: "PID-3", from: copy("PID-3.1") },
          { target: "PID-19", from: todo("waiting on the receiver's code set") },
        ],
      }],
    });
    const r = on(spec);
    expect(r.todos).toHaveLength(1);
    expect(r.todos[0]).toContain("waiting on the receiver");
    expect(r.empty).toEqual([]);
  });

  test("a todo row does not keep a block off the at-risk list on its own", () => {
    const spec = base({
      blocks: [{
        id: "IN1",
        rows: [
          { target: "IN1-2", from: copy("IN1-2") },
          { target: "IN1-3", from: todo("later") },
        ],
      }],
    });
    expect(on(spec).atRisk).toEqual(["IN1"]);
  });

  test("the row count covers every target row, delivered or not", () => {
    const spec = base({
      blocks: [
        { id: "PID", rows: [{ target: "PID-3", from: copy("PID-3.1") }] },
        { id: "PV1", rows: [{ target: "PV1-2", from: copy("PV1-2") }, { target: "PV1-3", from: copy("PV1-3") }] },
      ],
    });
    expect(on(spec).rows).toBe(3);
  });

  test("labels come through, so the report and the trace name fields alike", () => {
    const spec = base({
      blocks: [{ id: "PID", rows: [{ target: "PID-11", from: copy("PID-11"), label: "Address" }] }],
    });
    expect(on(spec).empty[0].label).toBe("Address");
  });

  test("with no label the target stands in", () => {
    const spec = base({
      blocks: [{ id: "PID", rows: [{ target: "PID-11", from: copy("PID-11") }] }],
    });
    expect(on(spec).empty[0].label).toBe("PID-11");
  });
});

describe("repeating blocks", () => {
  const REPEATS = [
    "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260819101500||ADT^A01|MSG0001|P|2.3",
    "PID|1||MRN9^^^MR||DOE^JOHN||19800101|M",
    "NK1|1|ROE^JANE|SPO",
    "NK1|2|POE^SAM|",
  ].join("\r\n");

  test("each occurrence is headed with its own number", () => {
    const spec = base({
      blocks: [{
        id: "NK1",
        repeat: { over: "NK1", max: 5 },
        rows: [
          { target: "NK1-1", from: counter() },
          { target: "NK1-3", from: copy("NK1-3") },
        ],
      }],
    });
    const r = on(spec, REPEATS);
    expect(r.empty).toHaveLength(1);
    expect(r.empty[0].block).toBe("NK1  2 of 2");
  });
});

describe("the rendered report", () => {
  test("a clean run says so plainly instead of printing an empty table", () => {
    const out = renderReads(base(), on(base()));
    expect(out).toContain("Every source path this spec reads came back with a value.");
  });

  test("at-risk blocks are headlined with what IGNOREMISSINGSOURCE does", () => {
    const spec = base({
      blocks: [{ id: "IN1", rows: [{ target: "IN1-2", from: copy("IN1-2") }] }],
    });
    const out = renderReads(spec, on(spec));
    expect(out).toContain("AT RISK (1)");
    expect(out).toContain("IGNOREMISSINGSOURCE = 1");
    expect(out).toContain("not");
  });

  test("absent reads are marked in the table and the mark is explained", () => {
    const spec = base({
      blocks: [{ id: "IN1", rows: [{ target: "IN1-2", from: copy("IN1-2") }] }],
    });
    const out = renderReads(spec, on(spec));
    expect(out).toContain(`A "!" marks a read against a segment that is not in this message.`);
  });

  // The report's own blind spot, printed every run including the clean ones,
  // because a clean run is exactly when someone would take it for a full check.
  test("the groups caveat is printed unconditionally", () => {
    expect(renderReads(base(), on(base()))).toContain("Groups are not checked");
  });
});
